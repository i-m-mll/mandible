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
  maskUnverifiedCandidates,
  replaceAllCounted,
} from "./credential-leak-scan.js";
import { API_TOKEN_PREFIX, fingerprintForToken } from "./client-auth/tokens.js";
import { compressContent, decompressContent } from "./compression.js";
import { conversationBlockId } from "./conversation-block-id.js";
import { getDaemonLogger } from "./daemon-log.js";
import type { Db } from "./db.js";
import { UserRegistryError } from "./users/store.js";

const redactionLog = getDaemonLogger();

const DEFAULT_BATCH_SIZE = 500;

/**
 * How many times a source rewrite may restart because the file changed under
 * it. Transcripts are appended to by a live agent, so one lost race is normal
 * and a second is worth retrying; a file that keeps moving is refused rather
 * than rewritten from a stale snapshot.
 */
const MAX_PATCH_ATTEMPTS = 3;

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
  /**
   * Files deliberately left alone: the file kept changing under the rewrite, or
   * its scan hit the verification budget so a rewrite could not be complete.
   * Refusing is the safe outcome — a source rewrite is destructive.
   */
  refused_files: number;
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
  /**
   * Spans masked without verification because a text exhausted the candidate
   * budget. Fail-closed cleanup, not a match for this credential.
   */
  unverified_spans: number;
  redacted_conversations: number;
  /** Blocks whose id was recomputed from the masked content (see below). */
  renumbered_blocks: number;
  /** Blocks whose recomputed id was already taken, so the old id was kept. */
  id_conflicts: number;
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

interface MaskedCredentialText {
  text: string;
  replacements: number;
  /** Spans masked without verification after the candidate budget ran out. */
  unverified: number;
  truncated: boolean;
}

/**
 * Mask every verified occurrence of one credential inside a text.
 *
 * Verification is by fingerprint equality, so this matches the same bytes the
 * client-auth path would accept as that credential and nothing else — a
 * lookalike `mandible_pat_…` string is left alone.
 *
 * `conservative` decides what happens when a text carries more distinct
 * token-shaped spans than the candidate budget allows checking. In the index
 * that is fail-closed masking: the remaining spans were never verified, so they
 * are replaced rather than left in a row this command has just promised to
 * clean. For a source file it is the opposite — an incomplete scan must not
 * license a destructive partial rewrite — so the caller passes `false` and
 * refuses the file instead.
 */
function maskCredentialInText(
  text: string,
  pepper: string,
  fingerprint: string,
  mask: string,
  options: { conservative?: boolean } = {},
): MaskedCredentialText {
  const extracted = extractTokenCandidatesWithStatus(text);
  const checked = new Set<string>();
  let next = text;
  let replacements = 0;
  for (const candidate of extracted.candidates) {
    checked.add(candidate);
    if (fingerprintForToken(pepper, candidate) !== fingerprint) continue;
    const replaced = replaceAllCounted(next, candidate, mask);
    next = replaced.text;
    replacements += replaced.replacements;
  }
  if (!extracted.truncated || options.conservative !== true) {
    return { text: next, replacements, unverified: 0, truncated: extracted.truncated };
  }
  const masked = maskUnverifiedCandidates(next, (candidate) => checked.has(candidate));
  return {
    text: masked.text,
    replacements,
    unverified: masked.replacements,
    truncated: true,
  };
}

type PatchStatus = "patched" | "unchanged" | "missing" | "failed" | "refused";

/**
 * Is the file still byte-identical to the snapshot the replacement was built
 * from?
 *
 * Opened once and inspected through that descriptor, so the inode being
 * checked is the inode being compared: a file replaced by a different one at
 * the same path fails the `ino`/`dev` test, and an appended-to file fails the
 * size or content test. Content equality is the authority; mtime is not
 * consulted, because a same-bytes touch is not a reason to refuse.
 */
function sourceUnchanged(filePath: string, baseline: fs.Stats, snapshot: Buffer): boolean {
  let handle: number;
  try {
    handle = fs.openSync(filePath, "r");
  } catch {
    return false;
  }
  try {
    const current = fs.fstatSync(handle);
    if (current.ino !== baseline.ino || current.dev !== baseline.dev) return false;
    if (current.size !== snapshot.length) return false;
    const buffer = Buffer.alloc(snapshot.length);
    let read = 0;
    while (read < snapshot.length) {
      const chunk = fs.readSync(handle, buffer, read, snapshot.length - read, read);
      if (chunk <= 0) break;
      read += chunk;
    }
    return read === snapshot.length && buffer.equals(snapshot);
  } catch {
    return false;
  } finally {
    try {
      fs.closeSync(handle);
    } catch {
      // Nothing useful to do with a close failure on a read-only descriptor.
    }
  }
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
 *
 * Transcripts are appended to while an agent is running, so the snapshot the
 * replacement was built from can be stale by the time it would be renamed into
 * place — which would silently drop every event written in between (issue
 * b3e4a09, review finding 4). The file is therefore re-verified against that
 * snapshot immediately before the rename, and a mismatch restarts the whole
 * read-mask-write cycle on the newer bytes rather than publishing the stale
 * one. After MAX_PATCH_ATTEMPTS the file is refused and reported.
 *
 * Two residual limits are deliberate. The check-to-rename window is not zero,
 * only sub-millisecond: closing it entirely needs a lock the transcript writers
 * do not take. And a writer holding an open descriptor keeps writing to the old
 * inode after the rename, so bytes appended after the last verification land in
 * the unlinked file; the next full ingest of the patched path is what
 * reconciles the index. Both are properties of rewriting a file someone else
 * owns, and the alternative — rewriting in place to keep the inode — trades
 * them for a non-atomic write that can corrupt the transcript outright.
 */
function patchSourceFile(
  filePath: string,
  pepper: string,
  fingerprint: string,
  mask: string,
): { status: PatchStatus; replacements: number } {
  for (let attempt = 1; attempt <= MAX_PATCH_ATTEMPTS; attempt += 1) {
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
    // An incomplete scan cannot justify overwriting the operator's transcript.
    if (masked.truncated) return { status: "refused", replacements: 0 };
    if (masked.replacements === 0) return { status: "unchanged", replacements: 0 };

    const tempPath = path.join(
      path.dirname(filePath),
      `.${path.basename(filePath)}.mandible-redact.${process.pid}.${attempt}.tmp`,
    );
    const discardTemp = (): void => {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // Best effort: a leftover temp file is not worth failing the report over.
      }
    };
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
    } catch {
      discardTemp();
      return { status: "failed", replacements: 0 };
    }

    if (!sourceUnchanged(filePath, stat, original)) {
      discardTemp();
      redactionLog("warn", "credential_redaction_source_changed", {
        file: filePath,
        attempt,
      });
      continue;
    }

    try {
      fs.renameSync(tempPath, filePath);
    } catch {
      discardTemp();
      return { status: "failed", replacements: 0 };
    }
    return { status: "patched", replacements: masked.replacements };
  }
  return { status: "refused", replacements: 0 };
}

interface BlockRow {
  id: string;
  conversation_id: string;
  content: Buffer | string;
  metadata_json: string | null;
  compressed: number;
  type: string;
  timestamp: string | null;
  position: number;
}

/**
 * Sweep the normalized index for one credential's plaintext and mask it.
 *
 * Search covers every stored block, in `content` and in `metadata_json`: the
 * credential id says nothing about where the token was pasted, the parsers copy
 * tool arguments and short tool results into metadata, and a hash-verified
 * sweep is the only way to find every copy. Rows keep their rowid, so
 * conversation structure, positions, and stable-offset pagination are
 * unaffected — and conversation search, which reads block content directly
 * rather than a separate index, immediately reflects the masked text.
 *
 * Block ids are recomputed (issue b3e4a09, review finding 7). A block id is a
 * hash of the first 100 characters of its content, so a redaction inside that
 * window changes what the next ingest of the patched source will derive.
 * Keeping the plaintext-derived id would leave a link that works now and breaks
 * silently at the next full re-ingest; recomputing moves that change to the
 * moment the operator ran the redaction and makes every link captured
 * afterwards survive re-ingest. If the recomputed id is already taken, the old
 * id is kept and the conflict is reported rather than colliding the primary
 * key. Redacting a source that cannot be patched (`--patch-sources` refused or
 * omitted) still diverges at the next re-ingest, because that ingest sees the
 * unredacted bytes again — patching the source is what makes redaction durable.
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
    `SELECT id, conversation_id, content, metadata_json, compressed,
            type, timestamp, position
     FROM conversation_blocks
     ORDER BY rowid
     LIMIT ? OFFSET ?`,
  );
  const update = db.prepare(
    `UPDATE conversation_blocks
     SET content = ?, compressed = 1, metadata_json = COALESCE(?, metadata_json), id = ?
     WHERE id = ?`,
  );
  const idTaken = db.prepare("SELECT 1 AS present FROM conversation_blocks WHERE id = ?");

  const conversations = new Set<string>();
  // Conversations whose source transcript is worth patching. Wider than the set
  // above on purpose: a conversation ingested after ingest-time masking shipped
  // already carries the mask, so its blocks need no edit — but its source file
  // still holds the working token and is exactly what --patch-sources is for.
  const sourceCandidates = new Set<string>();
  let scanned = 0;
  let redactedBlocks = 0;
  let redactedSpans = 0;
  let unverifiedSpans = 0;
  let renumberedBlocks = 0;
  let idConflicts = 0;
  let offset = 0;
  let truncated = false;

  for (;;) {
    const rows = select.all(batchSize, offset) as BlockRow[];
    if (rows.length === 0) break;
    offset += rows.length;

    const pending: Array<{
      id: string;
      newId: string;
      content: Buffer;
      metadataJson: string | null;
    }> = [];
    for (const row of rows) {
      scanned += 1;
      let text: string;
      try {
        text = decompressContent(row.content, row.compressed === 1);
      } catch {
        continue;
      }
      const maskedContent = maskCredentialInText(
        text,
        pepper,
        credential.fingerprint,
        mask,
        { conservative: true },
      );
      const maskedMetadata = row.metadata_json === null
        ? null
        : maskCredentialInText(
          row.metadata_json,
          pepper,
          credential.fingerprint,
          mask,
          { conservative: true },
        );
      truncated ||= maskedContent.truncated || (maskedMetadata?.truncated ?? false);
      const spans = maskedContent.replacements + (maskedMetadata?.replacements ?? 0);
      const unverified = maskedContent.unverified + (maskedMetadata?.unverified ?? 0);
      if (spans + unverified === 0) {
        if (text.includes(mask) || (row.metadata_json ?? "").includes(mask)) {
          sourceCandidates.add(row.conversation_id);
        }
        continue;
      }
      // The id is derived from the first 100 characters of content only, so
      // metadata-only edits and edits past that window cannot change what the
      // next ingest derives and must not churn the id.
      const newId = maskedContent.text.slice(0, 100) === text.slice(0, 100)
        ? row.id
        : conversationBlockId({
          conversation_id: row.conversation_id,
          type: row.type,
          timestamp: row.timestamp,
          content: maskedContent.text,
          position: row.position,
        });
      pending.push({
        id: row.id,
        newId,
        content: compressContent(maskedContent.text),
        metadataJson: maskedMetadata && maskedMetadata.text !== row.metadata_json
          ? maskedMetadata.text
          : null,
      });
      redactedBlocks += 1;
      redactedSpans += spans;
      unverifiedSpans += unverified;
      conversations.add(row.conversation_id);
      sourceCandidates.add(row.conversation_id);
    }

    if (pending.length > 0) {
      db.transaction(() => {
        for (const entry of pending) {
          let targetId = entry.id;
          if (entry.newId !== entry.id) {
            if (idTaken.get(entry.newId)) {
              idConflicts += 1;
            } else {
              targetId = entry.newId;
              renumberedBlocks += 1;
            }
          }
          update.run(entry.content, entry.metadataJson, targetId, entry.id);
        }
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
  unverifiedSpans += metadata.unverified;
  truncated ||= metadata.truncated;

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
    unverified_spans: unverifiedSpans,
    redacted_conversations: conversations.size,
    renumbered_blocks: renumberedBlocks,
    id_conflicts: idConflicts,
    truncated,
    patched_files: sources?.patched_files ?? null,
    missing_files: sources?.missing_files ?? null,
    failed_files: sources?.failed_files ?? null,
    refused_files: sources?.refused_files ?? null,
  });

  return {
    credential_id: credential.id,
    credential_status: credential.status,
    scanned_blocks: scanned,
    redacted_blocks: redactedBlocks,
    redacted_metadata_fields: metadata.fields,
    redacted_spans: redactedSpans,
    unverified_spans: unverifiedSpans,
    redacted_conversations: conversations.size,
    renumbered_blocks: renumberedBlocks,
    id_conflicts: idConflicts,
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
): { fields: number; spans: number; unverified: number; truncated: boolean } {
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
  const conservative = { conservative: true } as const;
  let fields = 0;
  let spans = 0;
  let unverified = 0;
  let truncated = false;
  for (const row of rows) {
    const title = maskCredentialInText(row.title ?? "", pepper, fingerprint, mask, conservative);
    const summary = maskCredentialInText(
      row.summary ?? "",
      pepper,
      fingerprint,
      mask,
      conservative,
    );
    truncated ||= title.truncated || summary.truncated;
    const titleSpans = title.replacements + title.unverified;
    const summarySpans = summary.replacements + summary.unverified;
    const carriesMask = (row.title ?? "").includes(mask) || (row.summary ?? "").includes(mask);
    if (titleSpans === 0 && summarySpans === 0) {
      if (carriesMask) sourceCandidates.add(row.id);
      continue;
    }
    update.run(
      row.title === null ? null : title.text,
      row.summary === null ? null : summary.text,
      row.id,
    );
    fields += (titleSpans > 0 ? 1 : 0) + (summarySpans > 0 ? 1 : 0);
    spans += title.replacements + summary.replacements;
    unverified += title.unverified + summary.unverified;
    changed.add(row.id);
    sourceCandidates.add(row.id);
  }
  return { fields, spans, unverified, truncated };
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
    refused_files: 0,
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
      case "refused":
        report.refused_files += 1;
        break;
      default:
        report.failed_files += 1;
        break;
    }
  }
  return report;
}
