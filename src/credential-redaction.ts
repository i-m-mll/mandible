// Retroactive credential redaction (issue b3e4a09).
//
// Ingest-time masking (see credential-leak-scan.ts) keeps new transcripts clean,
// but a credential that leaked before that existed is already sitting in the
// normalized index and in the provider's source JSONL. This module is the
// response tool: given a credential id, it re-verifies stored text against that
// credential's fingerprint and masks every occurrence.
//
// Two invariants govern everything here:
//
//   1. The plaintext is never printed, logged, returned, or written anywhere.
//      A candidate is verified by peppered HMAC against the stored fingerprint
//      and then immediately replaced; only counts and ids leave this module.
//   2. Blocks are reproducible from their source files, so a DB-only redaction
//      is undone by the next full re-ingest of an unpatched file. `--patch-
//      sources` is the durable half: it rewrites the same verified spans in the
//      local transcript, leaving every other byte untouched.
//
// Unlike detection, redaction deliberately matches revoked credentials too: the
// recommended operator sequence is rotate (which revokes) and then redact, so
// refusing to redact a revoked credential would make the tool useless exactly
// when it is needed.

import fs from "node:fs";
import path from "node:path";

import {
  credentialMaskFor,
  credentialScanPepper,
  extractTokenCandidatesWithStatus,
  replaceAllCounted,
} from "./credential-leak-scan.js";
import { API_TOKEN_PREFIX, fingerprintForToken } from "./client-auth/tokens.js";
import { compressContent, decompressContent } from "./compression.js";
import { getDaemonLogger } from "./daemon-log.js";
import type { Db } from "./db.js";
import { UserRegistryError } from "./users/store.js";

const redactionLog = getDaemonLogger();

const DEFAULT_BATCH_SIZE = 500;

/**
 * LIKE pattern for the minted-token prefix. `_` is a single-character wildcard
 * in LIKE, which only widens the match here — every real candidate is still
 * hash-verified afterwards, so a wildcard match is never mistaken for a hit.
 */
const TOKEN_PREFIX_PATTERN = API_TOKEN_PREFIX;

export interface CredentialRedactionOptions {
  /** Also rewrite the verified spans in the local source transcripts. */
  patchSources?: boolean;
  /** Rows fetched per batch. */
  batchSize?: number;
  pepper?: string;
}

export interface CredentialRedactionSourceReport {
  /** Distinct source files reachable from the affected conversations. */
  candidate_files: number;
  patched_files: number;
  /** Files that held no verified occurrence (already clean). */
  unchanged_files: number;
  /** Files the conversation still points at but that are no longer on disk. */
  missing_files: number;
  /** Files that could not be rewritten (permissions, IO). */
  failed_files: number;
  patched_spans: number;
}

export interface CredentialRedactionReport {
  credential_id: string;
  credential_status: string;
  scanned_blocks: number;
  redacted_blocks: number;
  /** Derived conversation fields (title, summary) rewritten. */
  redacted_metadata_fields: number;
  /** Total occurrences replaced in the index, across blocks and metadata. */
  redacted_spans: number;
  redacted_conversations: number;
  truncated: boolean;
  sources: CredentialRedactionSourceReport | null;
}

interface CredentialRow {
  id: string;
  type: string;
  status: string;
  fingerprint: string;
}

/**
 * Resolve a credential by exact id or by an unambiguous id prefix.
 *
 * Ids are 26-character ULIDs; operators copy them out of alert text, so a
 * prefix is the ergonomic form. Ambiguity is an error rather than a guess —
 * redaction is a bulk rewrite and must never run against the wrong credential.
 */
export function resolveCredentialForRedaction(db: Db, ref: string): CredentialRow {
  const trimmed = ref.trim();
  if (!trimmed) {
    throw new UserRegistryError("invalid", "A credential id is required.");
  }
  const exact = db
    .prepare("SELECT id, type, status, fingerprint FROM user_credentials WHERE id = ?")
    .get(trimmed) as CredentialRow | undefined;
  const matches = exact
    ? [exact]
    // substr rather than LIKE: no pattern metacharacters to escape, so an
    // operator-supplied ref is always a literal prefix.
    : (db
      .prepare(
        `SELECT id, type, status, fingerprint FROM user_credentials
         WHERE substr(id, 1, length(?)) = ? ORDER BY id LIMIT 5`,
      )
      .all(trimmed, trimmed) as CredentialRow[]);
  if (matches.length === 0) {
    throw new UserRegistryError("not_found", `No credential '${trimmed}'.`);
  }
  if (matches.length > 1) {
    throw new UserRegistryError(
      "invalid",
      `Credential id '${trimmed}' is ambiguous (${matches.length} matches). Use the full id.`,
    );
  }
  const credential = matches[0];
  if (credential.type !== "api_token") {
    throw new UserRegistryError(
      "invalid",
      `Credential '${credential.id}' is a ${credential.type}, not an api_token. `
        + "Only bearer-token plaintext is detectable in transcript text.",
    );
  }
  return credential;
}

/**
 * Mask every verified occurrence of one credential inside a text.
 *
 * Verification is by fingerprint equality, so this matches the same bytes the
 * client-auth path would accept as that credential and nothing else — a
 * lookalike `mandible_pat_…` string is left alone.
 */
function maskCredentialInText(
  text: string,
  pepper: string,
  fingerprint: string,
  mask: string,
): { text: string; replacements: number; truncated: boolean } {
  const extracted = extractTokenCandidatesWithStatus(text);
  let next = text;
  let replacements = 0;
  for (const candidate of extracted.candidates) {
    if (fingerprintForToken(pepper, candidate) !== fingerprint) continue;
    const replaced = replaceAllCounted(next, candidate, mask);
    next = replaced.text;
    replacements += replaced.replacements;
  }
  return { text: next, replacements, truncated: extracted.truncated };
}

/**
 * Rewrite one source transcript in place.
 *
 * The file is handled as latin1 so the round trip is byte-exact for any input,
 * including invalid UTF-8 that a lossy utf8 decode would silently rewrite —
 * everything outside the replaced spans must survive untouched. The token
 * charset is ASCII, so matching in latin1 is exact.
 *
 * The write is temp-plus-rename within the same directory, so a reader either
 * sees the whole old file or the whole new one, and the original mode is
 * carried over. mtime is deliberately NOT preserved: the next ingest should see
 * the file as changed and re-index the redacted content.
 */
function patchSourceFile(
  filePath: string,
  pepper: string,
  fingerprint: string,
  mask: string,
): { status: "patched" | "unchanged" | "missing" | "failed"; replacements: number } {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return { status: "missing", replacements: 0 };
  }
  if (!stat.isFile()) return { status: "missing", replacements: 0 };

  let original: Buffer;
  try {
    original = fs.readFileSync(filePath);
  } catch {
    return { status: "failed", replacements: 0 };
  }

  const masked = maskCredentialInText(
    original.toString("latin1"),
    pepper,
    fingerprint,
    mask,
  );
  if (masked.replacements === 0) return { status: "unchanged", replacements: 0 };

  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.mandible-redact.${process.pid}.tmp`,
  );
  try {
    const handle = fs.openSync(tempPath, "wx", stat.mode & 0o777);
    try {
      fs.writeFileSync(handle, Buffer.from(masked.text, "latin1"));
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    // openSync's mode argument is masked by umask; chmod is not.
    fs.chmodSync(tempPath, stat.mode & 0o777);
    fs.renameSync(tempPath, filePath);
  } catch {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // Best effort: a leftover temp file is not worth failing the report over.
    }
    return { status: "failed", replacements: 0 };
  }
  return { status: "patched", replacements: masked.replacements };
}

interface BlockRow {
  id: string;
  conversation_id: string;
  content: Buffer | string;
  compressed: number;
}

/**
 * Sweep the normalized index for one credential's plaintext and mask it.
 *
 * Search covers every stored block: the credential id says nothing about where
 * the token was pasted, and a hash-verified sweep is the only way to find every
 * copy. Rows are updated in place (same block id, same rowid), so conversation
 * structure, positions, and stable-offset pagination are unaffected — and
 * conversation search, which reads block content directly rather than a
 * separate index, immediately reflects the masked text.
 */
export function redactCredential(
  db: Db,
  ref: string,
  options: CredentialRedactionOptions = {},
): CredentialRedactionReport {
  const credential = resolveCredentialForRedaction(db, ref);
  const pepper = options.pepper ?? credentialScanPepper(db);
  const mask = credentialMaskFor(credential.id);
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);

  const select = db.prepare(
    `SELECT id, conversation_id, content, compressed
     FROM conversation_blocks
     ORDER BY rowid
     LIMIT ? OFFSET ?`,
  );
  const update = db.prepare(
    "UPDATE conversation_blocks SET content = ?, compressed = 1 WHERE id = ?",
  );

  const conversations = new Set<string>();
  // Conversations whose source transcript is worth patching. Wider than the set
  // above on purpose: a conversation ingested after ingest-time masking shipped
  // already carries the mask, so its blocks need no edit — but its source file
  // still holds the working token and is exactly what --patch-sources is for.
  const sourceCandidates = new Set<string>();
  let scanned = 0;
  let redactedBlocks = 0;
  let redactedSpans = 0;
  let offset = 0;
  let truncated = false;

  for (;;) {
    const rows = select.all(batchSize, offset) as BlockRow[];
    if (rows.length === 0) break;
    offset += rows.length;

    const pending: Array<{ id: string; content: Buffer }> = [];
    for (const row of rows) {
      scanned += 1;
      let text: string;
      try {
        text = decompressContent(row.content, row.compressed === 1);
      } catch {
        continue;
      }
      const masked = maskCredentialInText(text, pepper, credential.fingerprint, mask);
      truncated ||= masked.truncated;
      if (masked.replacements === 0) {
        if (text.includes(mask)) sourceCandidates.add(row.conversation_id);
        continue;
      }
      pending.push({ id: row.id, content: compressContent(masked.text) });
      redactedBlocks += 1;
      redactedSpans += masked.replacements;
      conversations.add(row.conversation_id);
      sourceCandidates.add(row.conversation_id);
    }

    if (pending.length > 0) {
      db.transaction(() => {
        for (const entry of pending) update.run(entry.content, entry.id);
      })();
    }
    if (rows.length < batchSize) break;
  }

  const metadata = redactConversationMetadata(
    db,
    pepper,
    credential.fingerprint,
    mask,
    conversations,
    sourceCandidates,
  );
  redactedSpans += metadata.spans;

  const sources = options.patchSources
    ? patchSourcesForConversations(db, [...sourceCandidates], pepper, credential.fingerprint, mask)
    : null;

  redactionLog("warn", "credential_redaction_completed", {
    credential_id: credential.id,
    credential_status: credential.status,
    scanned_blocks: scanned,
    redacted_blocks: redactedBlocks,
    redacted_metadata_fields: metadata.fields,
    redacted_spans: redactedSpans,
    redacted_conversations: conversations.size,
    patched_files: sources?.patched_files ?? null,
    missing_files: sources?.missing_files ?? null,
    failed_files: sources?.failed_files ?? null,
  });

  return {
    credential_id: credential.id,
    credential_status: credential.status,
    scanned_blocks: scanned,
    redacted_blocks: redactedBlocks,
    redacted_metadata_fields: metadata.fields,
    redacted_spans: redactedSpans,
    redacted_conversations: conversations.size,
    truncated,
    sources,
  };
}

/**
 * Mask the credential in conversation titles and summaries.
 *
 * These are derived from block text, so a token pasted into a first user
 * message lands here too. They are plain TEXT columns rather than compressed
 * blobs, so the scan can be pushed into SQL.
 */
function redactConversationMetadata(
  db: Db,
  pepper: string,
  fingerprint: string,
  mask: string,
  changed: Set<string>,
  sourceCandidates: Set<string>,
): { fields: number; spans: number } {
  const rows = db
    .prepare(
      `SELECT id, title, summary FROM conversations
       WHERE (title IS NOT NULL AND (title LIKE ? OR title LIKE ?))
          OR (summary IS NOT NULL AND (summary LIKE ? OR summary LIKE ?))`,
    )
    .all(
      `%${TOKEN_PREFIX_PATTERN}%`,
      `%${mask}%`,
      `%${TOKEN_PREFIX_PATTERN}%`,
      `%${mask}%`,
    ) as Array<{ id: string; title: string | null; summary: string | null }>;

  const update = db.prepare("UPDATE conversations SET title = ?, summary = ? WHERE id = ?");
  let fields = 0;
  let spans = 0;
  for (const row of rows) {
    const title = maskCredentialInText(row.title ?? "", pepper, fingerprint, mask);
    const summary = maskCredentialInText(row.summary ?? "", pepper, fingerprint, mask);
    const carriesMask = (row.title ?? "").includes(mask) || (row.summary ?? "").includes(mask);
    if (title.replacements === 0 && summary.replacements === 0) {
      if (carriesMask) sourceCandidates.add(row.id);
      continue;
    }
    update.run(
      row.title === null ? null : title.text,
      row.summary === null ? null : summary.text,
      row.id,
    );
    fields += (title.replacements > 0 ? 1 : 0) + (summary.replacements > 0 ? 1 : 0);
    spans += title.replacements + summary.replacements;
    changed.add(row.id);
    sourceCandidates.add(row.id);
  }
  return { fields, spans };
}

function patchSourcesForConversations(
  db: Db,
  conversationIds: readonly string[],
  pepper: string,
  fingerprint: string,
  mask: string,
): CredentialRedactionSourceReport {
  const report: CredentialRedactionSourceReport = {
    candidate_files: 0,
    patched_files: 0,
    unchanged_files: 0,
    missing_files: 0,
    failed_files: 0,
    patched_spans: 0,
  };
  if (conversationIds.length === 0) return report;

  const lookup = db.prepare("SELECT source_path FROM conversations WHERE id = ?");
  const files = new Set<string>();
  for (const id of conversationIds) {
    const row = lookup.get(id) as { source_path: string | null } | undefined;
    if (row?.source_path) files.add(row.source_path);
  }
  report.candidate_files = files.size;

  for (const file of files) {
    const outcome = patchSourceFile(file, pepper, fingerprint, mask);
    switch (outcome.status) {
      case "patched":
        report.patched_files += 1;
        report.patched_spans += outcome.replacements;
        break;
      case "unchanged":
        report.unchanged_files += 1;
        break;
      case "missing":
        report.missing_files += 1;
        break;
      default:
        report.failed_files += 1;
        break;
    }
  }
  return report;
}
