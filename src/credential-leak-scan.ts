// Transcript credential scanning (issue 71a287e).
//
// A Mandible PAT is a bearer secret that must never appear in a transcript. The
// `mandible_pat_` prefix exists precisely so a leak is machine-detectable, so
// the normalized conversation index scans ingested text for candidates and
// verifies each one against the live credential table.
//
// Verification reuses the client-auth hashing path: a candidate is peppered-
// HMAC'd exactly like a presented bearer token and the resulting fingerprint is
// looked up among active `api_token` credentials. A candidate that matches the
// pattern but no credential is not a leak and produces nothing.
//
// The matched plaintext NEVER leaves this module: it is not stored in the leak
// event, not logged, and not returned by any API. Only the credential id, its
// owner, its label, and the location it was found in are persisted.
//
// Detection is deliberately in the normalized-index path rather than in the
// provider parsers: parsers stay format-only, and one hook covers every
// provider plus the on-demand backfill over already-indexed content.

import { createHash } from "node:crypto";

import { loadOrCreatePepper } from "./client-auth/secret-store.js";
import { API_TOKEN_PREFIX, fingerprintForToken } from "./client-auth/tokens.js";
import { decompressContent } from "./compression.js";
import { getDaemonLogger } from "./daemon-log.js";
import type { Db } from "./db.js";
import { revokeCredential } from "./users/store.js";

/** Webhook-event vocabulary used for the dashboard alert (reuses webhook_events). */
export const CREDENTIAL_LEAK_EVENT_SOURCE = "mandible";
export const CREDENTIAL_LEAK_EVENT_TYPE = "credential_leak";
const credentialLeakLog = getDaemonLogger();

/**
 * Candidate matcher. Derived from API_TOKEN_PREFIX so the detector cannot drift
 * from the minting format. The body charset is base64url (what generateRawToken
 * emits). Match exactly the minted 43-character body without a trailing
 * boundary: when a token is followed by more base64url text, its exact prefix
 * must still be hash-verified.
 */
export function credentialCandidatePattern(): RegExp {
  return new RegExp(`${API_TOKEN_PREFIX}[A-Za-z0-9_-]{43}`, "g");
}

/**
 * Bound the verification work a single hostile block can force.
 *
 * This is a budget for peppered-HMAC verifications, not a place to stop
 * scanning. When a text exceeds it the masking paths fail closed: every
 * token-shaped span that was never verified is replaced with
 * `UNVERIFIED_CREDENTIAL_MASK` rather than persisted in the clear (issue
 * b3e4a09, review finding 2). Without that, 4,096 lookalikes followed by a real
 * PAT would be a deterministic bypass.
 */
export const MAX_CANDIDATES_PER_TEXT = 4096;

export interface ExtractedTokenCandidates {
  candidates: string[];
  truncated: boolean;
}

/**
 * Extract distinct `mandible_pat_…` candidates from one text. Returns raw
 * candidate strings for immediate hash-verification by the caller; callers must
 * never persist or log them.
 */
export function extractTokenCandidatesWithStatus(
  text: string | null | undefined,
): ExtractedTokenCandidates {
  if (typeof text !== "string" || !text.includes(API_TOKEN_PREFIX)) {
    return { candidates: [], truncated: false };
  }
  const seen = new Set<string>();
  let truncated = false;
  for (const match of text.matchAll(credentialCandidatePattern())) {
    if (seen.has(match[0])) continue;
    if (seen.size >= MAX_CANDIDATES_PER_TEXT) {
      truncated = true;
      break;
    }
    seen.add(match[0]);
  }
  return { candidates: [...seen], truncated };
}

export function extractTokenCandidates(text: string | null | undefined): string[] {
  return extractTokenCandidatesWithStatus(text).candidates;
}

interface CredentialRow {
  id: string;
  user_id: string;
  type: string;
  label: string | null;
  metadata_json: string | null;
}

export interface LeakedCredential {
  credential_id: string;
  user_id: string;
  user_slug: string | null;
  label: string | null;
  session_scoped: boolean;
}

export interface CredentialLeakLocation {
  conversation_id: string | null;
  conversation_title?: string | null;
  session_id?: string | null;
  source?: string | null;
  branch?: string | null;
  block_id?: string | null;
  block_position?: number | null;
}

export interface CredentialLeakDetection {
  event_id: string;
  detected_at: number;
  credential: LeakedCredential;
  location: CredentialLeakLocation;
  /** True when the credential was auto-revoked by policy (session-scoped only). */
  revoked: boolean;
  /** False when an identical (credential, conversation) alert already existed. */
  new_event: boolean;
}

/**
 * Auto-revocation policy (issue 71a287e).
 *
 * Current wrap-session tokens are deliberately in-memory only and therefore
 * invisible to this persisted-credential scanner. They self-expire on session
 * end, daemon restart, or TTL. This predicate is a guarded seam for a future
 * persisted session-scoped credential shape; long-lived or unrecognized rows
 * remain alert-only so scanning cannot cascade-revoke a shared PAT.
 */
export function isSessionScopedCredential(credential: {
  type?: string | null;
  metadata?: Record<string, unknown> | null;
}): boolean {
  const metadata = credential.metadata ?? {};
  if (metadata.ephemeral === true) return true;
  const scope = metadata.scope ?? metadata.token_scope;
  if (scope === "session") return true;
  if (typeof metadata.session_id === "string" && metadata.session_id.length > 0) return true;
  return false;
}

function parseMetadata(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** True when the install has any active api_token credential worth scanning for. */
export function hasActiveApiTokenCredentials(db: Db): boolean {
  const row = db
    .prepare(
      "SELECT 1 AS present FROM user_credentials WHERE type = 'api_token' AND status = 'active' LIMIT 1",
    )
    .get() as { present: number } | undefined;
  return row !== undefined;
}

/**
 * Resolve a candidate to a live credential, or null. Mirrors verifyApiToken's
 * lookup but returns the credential record rather than an identity, and never
 * echoes the candidate back.
 */
export function matchActiveCredential(
  db: Db,
  pepper: string,
  candidate: string,
): LeakedCredential | null {
  if (!candidate.startsWith(API_TOKEN_PREFIX)) return null;
  const fingerprint = fingerprintForToken(pepper, candidate);
  const row = db
    .prepare(
      `SELECT id, user_id, type, label, metadata_json FROM user_credentials
       WHERE type = 'api_token' AND status = 'active' AND fingerprint = ?`,
    )
    .get(fingerprint) as CredentialRow | undefined;
  if (!row) return null;
  const slugRow = db
    .prepare("SELECT slug FROM users WHERE id = ?")
    .get(row.user_id) as { slug: string } | undefined;
  return {
    credential_id: row.id,
    user_id: row.user_id,
    user_slug: slugRow?.slug ?? null,
    label: row.label,
    session_scoped: isSessionScopedCredential({
      type: row.type,
      metadata: parseMetadata(row.metadata_json),
    }),
  };
}

export interface CredentialLeakRemediation {
  mint: string;
  revoke: string;
}

/** Operator remediation commands surfaced on the alert. */
export function remediationFor(leak: LeakedCredential): CredentialLeakRemediation {
  const userRef = leak.user_slug ?? leak.user_id;
  return {
    mint: `mandible user token mint ${userRef} --store`,
    revoke: `mandible user token revoke ${leak.credential_id}`,
  };
}

// --- Masking (issue b3e4a09) -------------------------------------------------

/**
 * How much of the credential id the mask carries. A ULID prefix this long is
 * unambiguous in practice and keeps the mask readable in a transcript; the full
 * id stays in the leak alert, which is the record meant to be acted on.
 */
export const CREDENTIAL_MASK_ID_LENGTH = 12;

/**
 * The replacement written in place of live credential plaintext.
 *
 * The mask is a pure function of the credential id, so re-ingesting the same
 * transcript against the same credential table reproduces byte-identical block
 * content — masking must never make ingestion non-deterministic. The mask body
 * is base32/ASCII and contains no JSON metacharacters, so substituting it into
 * a JSONL source line leaves the surrounding JSON valid.
 */
export function credentialMaskFor(credentialId: string): string {
  return `[mandible-credential:${credentialId.slice(0, CREDENTIAL_MASK_ID_LENGTH)}]`;
}

/**
 * The replacement for a token-shaped span the scan could not verify.
 *
 * Two situations produce one: the per-text verification budget was exhausted
 * (so the span was never hashed), or verification itself failed — a locked
 * database, an unreadable pepper. Both are fail-closed: the span is masked
 * without knowing whether it is a live credential, because the alternative is
 * persisting and broadcasting what might be a working token.
 *
 * The mask carries a discriminator (issue b3e4a09, re-review finding 3). A
 * single constant collapsed every unverified span in a text onto one string,
 * which is fail-closed for secrecy but lossy for structure: attacker-controlled
 * metadata using several token-shaped strings as distinct object keys reparsed
 * into a single JSON property, silently dropping the other values. `occurrence`
 * is the span's 1-based index in scan order within the one text being masked,
 * so distinct spans stay distinct.
 *
 * The discriminator is deliberately positional and carries nothing derived from
 * the plaintext. Even a short hash of the masked bytes would turn every stored
 * transcript into an offline confirmation oracle — an attacker holding a
 * guessed token could check it against the mask without touching Mandible.
 * Position is a pure function of the surrounding text, so re-ingesting the same
 * source reproduces byte-identical output and block ids stay stable.
 */
export function unverifiedCredentialMask(occurrence: number | bigint): string {
  return `[mandible-credential:unverified#${occurrence}]`;
}

/** Literal prefix of an unverified mask, used to skip the scan on most texts. */
const UNVERIFIED_MASK_MARKER = "[mandible-credential:unverified#";

/** Matches an unverified mask already sitting in the text as literal bytes. */
function unverifiedMaskPattern(): RegExp {
  return /\[mandible-credential:unverified#(\d+)\]/g;
}

interface UnverifiedMaskNamespace {
  /** Highest occurrence already present as literal text. */
  floor: bigint;
  /** Every occurrence string already present, exactly as it is spelled. */
  taken: ReadonlySet<string>;
}

const EMPTY_UNVERIFIED_NAMESPACE: UnverifiedMaskNamespace = { floor: 0n, taken: new Set() };

/**
 * Digit runs longer than this do not raise the floor.
 *
 * A literal is attacker-supplied text, and parsing a million-digit run as a
 * BigInt is superlinear — a transcript could otherwise stall ingestion by
 * spelling one out. Ignoring it for ordering is safe: fresh numbering then
 * starts low, and `taken` still holds the literal verbatim, so nothing this
 * function emits can collide with it. 32 digits is far above any occurrence
 * count a real text can reach (the per-text candidate budget is in the
 * hundreds).
 */
const MAX_UNVERIFIED_OCCURRENCE_DIGITS = 32;

/**
 * What unverified-mask occurrence numbers this text already spells out.
 *
 * The mask is plain text, so a transcript can contain the literal bytes of one
 * — including one an attacker typed. Numbering that always restarted at 1
 * collided with those literals (issue b3e4a09, third-pass finding 4): metadata
 * carrying both a literal `[mandible-credential:unverified#1]` key and one
 * token-shaped key masked the latter to the same string, and `JSON.parse` keeps
 * only the last of two identical keys, so one property was silently dropped —
 * the exact structural loss the discriminator was added to prevent.
 *
 * Both halves of the namespace are recorded. `floor` is where fresh numbering
 * starts, and `taken` catches every literal verbatim, including forms this
 * function never emits (leading zeros, digit runs too long to order). Both are
 * pure functions of the text, so re-ingesting the same source still reproduces
 * byte-identical output and block ids stay stable.
 *
 * Ordering is in BigInt, not in `number` (issue b3e4a09, fourth-pass finding
 * 4). Counting in doubles gave an attacker two wins by planting one literal:
 * `#9007199254740991` pushed the counter to where `+ 1` stops advancing, so
 * every subsequent span masked to the *same* string — the duplicate-key loss
 * the discriminator exists to prevent — and adding `#9007199254740992` on top
 * of it made the skip loop increment forever, hanging the ingest. BigInt has
 * neither ceiling, so `+ 1n` always advances and the skip loop always
 * terminates.
 */
function unverifiedMaskNamespace(text: string): UnverifiedMaskNamespace {
  if (!text.includes(UNVERIFIED_MASK_MARKER)) return EMPTY_UNVERIFIED_NAMESPACE;
  const taken = new Set<string>();
  let floor = 0n;
  for (const match of text.matchAll(unverifiedMaskPattern())) {
    taken.add(match[1]);
    if (match[1].length > MAX_UNVERIFIED_OCCURRENCE_DIGITS) continue;
    const value = BigInt(match[1]);
    if (value > floor) floor = value;
  }
  return { floor, taken };
}

/**
 * Replace every token-shaped span that is not known clean.
 *
 * `isKnownClean` is how a caller keeps spans it *did* verify as non-credentials:
 * those were hashed and positively cleared, so over-masking them would destroy
 * legitimate transcript text for no security gain.
 *
 * Numbering restarts for each call, so a block's `content` and its serialized
 * `metadata` are numbered independently. That is still deterministic — each is a
 * fixed function of its own text — and it keeps the two fields from depending on
 * each other's scan order. Within one text, numbering starts above any literal
 * unverified mask the text already contains and skips occurrence strings it
 * already spells out, so a freshly masked span can never land on a key that was
 * already there.
 */
export function maskUnverifiedCandidates(
  text: string,
  isKnownClean: (candidate: string) => boolean = () => false,
): { text: string; replacements: number } {
  if (!text.includes(API_TOKEN_PREFIX)) return { text, replacements: 0 };
  const namespace = unverifiedMaskNamespace(text);
  let occurrence = namespace.floor;
  let replacements = 0;
  const next = text.replace(credentialCandidatePattern(), (match) => {
    if (isKnownClean(match)) return match;
    replacements += 1;
    do {
      occurrence += 1n;
    } while (namespace.taken.has(String(occurrence)));
    return unverifiedCredentialMask(occurrence);
  });
  return { text: next, replacements };
}

/** Global literal replacement plus a count, without regex-escaping games. */
export function replaceAllCounted(
  text: string,
  needle: string,
  replacement: string,
): { text: string; replacements: number } {
  if (needle.length === 0) return { text, replacements: 0 };
  const parts = text.split(needle);
  if (parts.length === 1) return { text, replacements: 0 };
  return { text: parts.join(replacement), replacements: parts.length - 1 };
}

/**
 * One alert per (credential, conversation): re-ingesting or re-scanning the
 * same transcript must not fan out duplicate alerts.
 */
function leakEventId(credentialId: string, conversationId: string | null): string {
  const digest = createHash("sha256")
    .update(`${CREDENTIAL_LEAK_EVENT_TYPE} ${credentialId} ${conversationId ?? ""}`)
    .digest("hex")
    .slice(0, 24);
  return `leak_${digest}`;
}

function leakTitle(leak: LeakedCredential): string {
  const label = leak.label ?? leak.user_slug ?? leak.credential_id;
  return leak.session_scoped
    ? `Session token leaked in a transcript (revoked): ${label}`
    : `Mandible PAT leaked in a transcript: ${label}`;
}

/**
 * Persist the leak alert and apply the revocation policy.
 *
 * The webhook_events row carries only structured identifiers plus remediation
 * text — never the matched token. Revocation runs before the insert so a
 * session-scoped credential is dead even if the alert insert is a duplicate.
 */
export function recordCredentialLeak(
  db: Db,
  leak: LeakedCredential,
  location: CredentialLeakLocation,
  now: number = Date.now(),
): CredentialLeakDetection {
  let revoked = false;
  if (leak.session_scoped) {
    try {
      revokeCredential(db, leak.credential_id, now);
      revoked = true;
    } catch {
      // A credential that vanished between match and revoke is already gone.
      revoked = false;
    }
  }

  const eventId = leakEventId(leak.credential_id, location.conversation_id);
  const remediation = remediationFor(leak);
  const payload = {
    credential_id: leak.credential_id,
    user_id: leak.user_id,
    user_slug: leak.user_slug,
    credential_label: leak.label,
    session_scoped: leak.session_scoped,
    auto_revoked: revoked,
    policy: leak.session_scoped
      ? "session_scoped_auto_revoked"
      : "long_lived_pat_alert_only",
    detected_at: now,
    conversation_id: location.conversation_id,
    conversation_title: location.conversation_title ?? null,
    session_id: location.session_id ?? null,
    provider: location.source ?? null,
    block_id: location.block_id ?? null,
    block_position: location.block_position ?? null,
    remediation,
  };

  const result = db
    .prepare(
      `INSERT OR IGNORE INTO webhook_events
         (id, source, event_type, title, data_json, target_session, target_issue,
          target_branch, priority, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'high', 'pending', ?)`,
    )
    .run(
      eventId,
      CREDENTIAL_LEAK_EVENT_SOURCE,
      CREDENTIAL_LEAK_EVENT_TYPE,
      leakTitle(leak),
      JSON.stringify(payload),
      location.session_id ?? null,
      location.branch ?? null,
      now,
    );

  return {
    event_id: eventId,
    detected_at: now,
    credential: leak,
    location,
    revoked,
    new_event: result.changes > 0,
  };
}

/**
 * Follow renumbered blocks in the leak alerts that point at them.
 *
 * The alert payload carries `block_id` so the dashboard can deep-link the
 * exact block a credential leaked in. Retroactive redaction recomputes that id
 * (the id is a content hash, so masking inside the hashed prefix changes it),
 * which left every existing alert pointing at a row that no longer exists —
 * the link 404s, and it does so on the one record an operator opens *because*
 * a credential leaked (issue b3e4a09, re-review finding 2).
 *
 * Only `credential_leak` events are touched, and only their `block_id`: the
 * rest of the payload, including the credential id and the detection time, is
 * historical fact and stays as recorded. Payloads that fail to parse are left
 * alone rather than rewritten from a guess.
 */
export function remapCredentialLeakAlertBlockIds(
  db: Db,
  renames: ReadonlyMap<string, string>,
): number {
  if (renames.size === 0) return 0;
  const rows = db
    .prepare(
      `SELECT id, data_json FROM webhook_events
       WHERE source = ? AND event_type = ?`,
    )
    .all(CREDENTIAL_LEAK_EVENT_SOURCE, CREDENTIAL_LEAK_EVENT_TYPE) as Array<{
      id: string;
      data_json: string | null;
    }>;
  if (rows.length === 0) return 0;

  const update = db.prepare("UPDATE webhook_events SET data_json = ? WHERE id = ?");
  let updated = 0;
  for (const row of rows) {
    if (!row.data_json) continue;
    let payload: unknown;
    try {
      payload = JSON.parse(row.data_json);
    } catch {
      continue;
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
    const record = payload as Record<string, unknown>;
    const blockId = record.block_id;
    if (typeof blockId !== "string") continue;
    const next = renames.get(blockId);
    if (next === undefined || next === blockId) continue;
    record.block_id = next;
    update.run(JSON.stringify(record), row.id);
    updated += 1;
  }
  return updated;
}

// --- Pepper access -----------------------------------------------------------

let cachedPepper: string | null = null;

function scanPepper(db: Db): string {
  if (cachedPepper === null) cachedPepper = loadOrCreatePepper(db);
  return cachedPepper;
}

/** Test hook: drop the cached pepper between temp installs. */
export function resetCredentialLeakScanCache(): void {
  cachedPepper = null;
}

/**
 * The token pepper, shared with the retroactive redaction command so both paths
 * verify candidates through exactly one hashing seam.
 */
export function credentialScanPepper(db: Db): string {
  return scanPepper(db);
}

// --- Scanning entry points ---------------------------------------------------

export interface ScanTextOptions {
  pepper?: string;
  now?: number;
  /** When false, detections are returned without persisting or revoking. */
  record?: boolean;
}

export interface CredentialLeakScanResult {
  detections: CredentialLeakDetection[];
  truncated: boolean;
  /** Alerts that could not be persisted after masking already completed. */
  alert_failures: number;
}

export interface ScannableBlock {
  content: string | null | undefined;
  metadata?: unknown;
  id?: string | null;
  position?: number | null;
}

/**
 * A block whose `content` and `metadata` the redacting walker may rewrite.
 *
 * Metadata is in scope because the parsers duplicate tool arguments and short
 * tool results into it (`tool_input`, `tool_output`), and ingestion serializes
 * that object into `conversation_blocks.metadata_json` and into the append SSE
 * payload. Masking only `content` left a working token in both (issue b3e4a09,
 * review finding 1).
 */
export interface RedactableBlock extends ScannableBlock {
  content: string | null | undefined;
  metadata?: unknown;
}

export interface CredentialLeakRedactionResult extends CredentialLeakScanResult {
  /** Blocks whose content or metadata was rewritten. */
  redacted_blocks: number;
  /** Verified credential occurrences replaced across those blocks. */
  redacted_spans: number;
  /** Spans masked without verification (budget exhausted or verification failed). */
  unverified_spans: number;
  /** True when verification itself threw and blocks were conservatively masked. */
  verification_failed: boolean;
}

/** JSON text for a block's metadata, or null when there is nothing to scan. */
function metadataText(metadata: unknown): string | null {
  if (metadata === null || metadata === undefined) return null;
  try {
    const json = JSON.stringify(metadata);
    return typeof json === "string" ? json : null;
  } catch {
    // A metadata object ingestion could not serialize would not reach the DB
    // either — JSON.stringify is the same call the insert makes.
    return null;
  }
}

/**
 * Re-hydrate masked metadata JSON.
 *
 * The mask is plain ASCII with no JSON metacharacters, so substituting it for a
 * token inside a serialized object always leaves valid JSON. The guard exists
 * so that an impossible parse failure still fails closed rather than restoring
 * the original object.
 */
function parseMaskedMetadata(json: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(json) as unknown };
  } catch {
    return { ok: false };
  }
}

/**
 * Last-resort masking: replace every token-shaped span in these blocks without
 * verifying any of them.
 *
 * Used when verification is impossible (see UNVERIFIED_CREDENTIAL_MASK) and
 * exported so ingestion's outer error path can guarantee the same property —
 * a scan that failed must never let the original text reach storage or SSE.
 */
export function maskAllCandidatesInBlocks(
  blocks: readonly RedactableBlock[],
): { blocks: number; spans: number } {
  let changedBlocks = 0;
  let spans = 0;
  for (const block of blocks) {
    let blockSpans = 0;
    if (typeof block.content === "string") {
      const masked = maskUnverifiedCandidates(block.content);
      if (masked.replacements > 0) {
        block.content = masked.text;
        blockSpans += masked.replacements;
      }
    }
    const json = metadataText(block.metadata);
    if (json !== null) {
      const masked = maskUnverifiedCandidates(json);
      if (masked.replacements > 0) {
        const parsed = parseMaskedMetadata(masked.text);
        block.metadata = parsed.ok ? parsed.value : { redaction_error: "metadata_masking_failed" };
        blockSpans += masked.replacements;
      }
    }
    if (blockSpans > 0) {
      changedBlocks += 1;
      spans += blockSpans;
    }
  }
  return { blocks: changedBlocks, spans };
}

/**
 * Shared walk over one conversation's blocks.
 *
 * Detection semantics are identical in both modes: one alert per distinct
 * leaked credential, first location wins, so a token repeated across many
 * blocks still produces a single alert. In `mask` mode every verified
 * occurrence — not just the first — is replaced in both `content` and the
 * serialized `metadata`, because the goal there is that no live plaintext
 * survives into storage.
 *
 * Ordering is a security property (issue b3e4a09, review finding 3): masking is
 * computed and assigned to every block *before* any alert side effect runs.
 * Recording an alert writes to the database and can fail — SQLITE_BUSY, a
 * revocation race — and a failure there must never leave the caller holding the
 * original plaintext. For the same reason a verification failure conservatively
 * masks the block instead of propagating: the caller is about to persist these
 * blocks, so "could not check" has to mean "masked", not "stored as-is". The
 * lost alert is recoverable — the backfill sweep re-detects it — while a
 * persisted token is not.
 */
function walkBlocksForCredentials(
  db: Db,
  blocks: readonly RedactableBlock[],
  location: CredentialLeakLocation,
  options: ScanTextOptions,
  mask: boolean,
): CredentialLeakRedactionResult {
  const empty: CredentialLeakRedactionResult = {
    detections: [],
    truncated: false,
    alert_failures: 0,
    redacted_blocks: 0,
    redacted_spans: 0,
    unverified_spans: 0,
    verification_failed: false,
  };
  if (blocks.length === 0) return empty;

  let pepper: string;
  try {
    if (!hasActiveApiTokenCredentials(db)) return empty;
    pepper = options.pepper ?? scanPepper(db);
  } catch (error) {
    // Scan-only callers (backfill, dry runs) own their own error handling and
    // have nothing to persist; the masking path cannot afford to give up.
    if (!mask) throw error;
    const masked = maskAllCandidatesInBlocks(blocks);
    credentialLeakLog("error", "credential_leak_scan_verification_unavailable", {
      conversation_id: location.conversation_id,
      masked_blocks: masked.blocks,
      masked_spans: masked.spans,
      error: String(error),
    });
    return {
      ...empty,
      redacted_blocks: masked.blocks,
      unverified_spans: masked.spans,
      verification_failed: true,
    };
  }

  const now = options.now ?? Date.now();
  const record = options.record !== false;
  const seenCredentials = new Set<string>();
  // Verification is a peppered HMAC per candidate; a token repeated across a
  // long conversation should be hashed once. The cache also keeps masking
  // consistent within one pass when an alert auto-revokes a session-scoped
  // credential partway through.
  const verified = new Map<string, LeakedCredential | null>();
  const isKnownClean = (candidate: string): boolean => verified.get(candidate) === null;
  const pending: Array<{ leak: LeakedCredential; location: CredentialLeakLocation }> = [];
  let truncated = false;
  let redactedBlocks = 0;
  let redactedSpans = 0;
  let unverifiedSpans = 0;
  let verificationFailed = false;

  for (const block of blocks) {
    const originalContent = typeof block.content === "string" ? block.content : null;
    const originalMetadata = metadataText(block.metadata);
    let text = originalContent;
    let metadataJson = originalMetadata;
    let blockSpans = 0;
    let blockUnverified = 0;

    const extractedContent = extractTokenCandidatesWithStatus(originalContent);
    const extractedMetadata = extractTokenCandidatesWithStatus(originalMetadata);
    const blockTruncated = extractedContent.truncated || extractedMetadata.truncated;
    truncated ||= blockTruncated;
    const candidates = extractedMetadata.candidates.length === 0
      ? extractedContent.candidates
      : [...new Set([...extractedContent.candidates, ...extractedMetadata.candidates])];

    const conservative = (): void => {
      if (!mask) return;
      if (text !== null) {
        const masked = maskUnverifiedCandidates(text, isKnownClean);
        text = masked.text;
        blockUnverified += masked.replacements;
      }
      if (metadataJson !== null) {
        const masked = maskUnverifiedCandidates(metadataJson, isKnownClean);
        metadataJson = masked.text;
        blockUnverified += masked.replacements;
      }
    };

    try {
      for (const candidate of candidates) {
        let leak = verified.get(candidate);
        if (leak === undefined) {
          leak = matchActiveCredential(db, pepper, candidate);
          verified.set(candidate, leak);
        }
        if (!leak) continue;
        if (mask) {
          const replacement = credentialMaskFor(leak.credential_id);
          if (text !== null) {
            const replaced = replaceAllCounted(text, candidate, replacement);
            text = replaced.text;
            blockSpans += replaced.replacements;
          }
          if (metadataJson !== null) {
            const replaced = replaceAllCounted(metadataJson, candidate, replacement);
            metadataJson = replaced.text;
            blockSpans += replaced.replacements;
          }
        }
        if (seenCredentials.has(leak.credential_id)) continue;
        seenCredentials.add(leak.credential_id);
        pending.push({
          leak,
          location: {
            ...location,
            block_id: block.id ?? null,
            block_position: block.position ?? null,
          },
        });
      }
      // The verification budget ran out: everything past it is unchecked, so it
      // is masked rather than trusted.
      if (blockTruncated) conservative();
    } catch (error) {
      if (!mask) throw error;
      verificationFailed = true;
      conservative();
      credentialLeakLog("error", "credential_leak_scan_verification_failed", {
        conversation_id: location.conversation_id,
        block_id: block.id ?? null,
        error: String(error),
      });
    }

    if (mask) {
      if (text !== null && text !== originalContent) block.content = text;
      if (metadataJson !== null && metadataJson !== originalMetadata) {
        const parsed = parseMaskedMetadata(metadataJson);
        if (parsed.ok) {
          block.metadata = parsed.value;
        } else {
          block.metadata = { redaction_error: "metadata_masking_failed" };
          credentialLeakLog("error", "credential_leak_metadata_reparse_failed", {
            conversation_id: location.conversation_id,
            block_id: block.id ?? null,
          });
        }
      }
      if (blockSpans + blockUnverified > 0) {
        redactedBlocks += 1;
        redactedSpans += blockSpans;
        unverifiedSpans += blockUnverified;
      }
    }
  }

  // Side effects only after every block carries its masked text.
  const detections: CredentialLeakDetection[] = [];
  let alertFailures = 0;
  for (const entry of pending) {
    if (!record) {
      detections.push({
        event_id: leakEventId(entry.leak.credential_id, entry.location.conversation_id),
        detected_at: now,
        credential: entry.leak,
        location: entry.location,
        revoked: false,
        new_event: false,
      });
      continue;
    }
    try {
      detections.push(recordCredentialLeak(db, entry.leak, entry.location, now));
    } catch (error) {
      alertFailures += 1;
      credentialLeakLog("error", "credential_leak_alert_failed", {
        conversation_id: entry.location.conversation_id,
        credential_id: entry.leak.credential_id,
        error: String(error),
      });
    }
  }

  if (truncated) {
    credentialLeakLog("warn", "credential_leak_scan_candidates_truncated", {
      conversation_id: location.conversation_id,
      max_candidates_per_text: MAX_CANDIDATES_PER_TEXT,
      unverified_spans: unverifiedSpans,
    });
  }
  return {
    detections,
    truncated,
    alert_failures: alertFailures,
    redacted_blocks: redactedBlocks,
    redacted_spans: redactedSpans,
    unverified_spans: unverifiedSpans,
    verification_failed: verificationFailed,
  };
}

/**
 * Scan a set of blocks belonging to one conversation. Returns one detection per
 * distinct leaked credential (first location wins), so a token repeated across
 * many blocks still produces a single alert. Block content is left untouched.
 */
export function scanBlocksForCredentialLeaks(
  db: Db,
  blocks: readonly ScannableBlock[],
  location: CredentialLeakLocation,
  options: ScanTextOptions = {},
): CredentialLeakScanResult {
  const { detections, truncated, alert_failures } = walkBlocksForCredentials(
    db,
    blocks,
    location,
    options,
    false,
  );
  return { detections, truncated, alert_failures };
}

export interface MaskedText {
  text: string;
  /** Occurrences replaced. */
  replacements: number;
  /** Distinct credentials matched, in first-seen order. */
  credentials: LeakedCredential[];
  truncated: boolean;
  /** Spans masked without verification (budget exhausted or verification failed). */
  unverified_replacements: number;
  /** True when verification threw and the text was conservatively masked. */
  verification_failed: boolean;
}

/**
 * Mask live credential plaintext in a standalone string (issue b3e4a09).
 *
 * Blocks are not the only place transcript text lands: a conversation title is
 * derived from the first user message, so a token pasted into that message would
 * otherwise sit in the conversations table — and in the leak alert payload that
 * quotes the title — in the clear. Callers use this for those derived fields.
 *
 * No alert is raised here: the block that produced the derived text is scanned
 * separately and owns the detection.
 */
export function maskActiveCredentialsInText(
  db: Db,
  text: string | null | undefined,
  options: Pick<ScanTextOptions, "pepper"> = {},
): MaskedText {
  const original = typeof text === "string" ? text : "";
  const extracted = extractTokenCandidatesWithStatus(original);
  const clean: MaskedText = {
    text: original,
    replacements: 0,
    credentials: [],
    truncated: extracted.truncated,
    unverified_replacements: 0,
    verification_failed: false,
  };
  if (extracted.candidates.length === 0 && !extracted.truncated) return clean;

  const credentials: LeakedCredential[] = [];
  const verified = new Map<string, LeakedCredential | null>();
  const isKnownClean = (candidate: string): boolean => verified.get(candidate) === null;
  let next = original;
  let replacements = 0;
  try {
    if (!hasActiveApiTokenCredentials(db)) return clean;
    const pepper = options.pepper ?? scanPepper(db);
    for (const candidate of extracted.candidates) {
      const leak = matchActiveCredential(db, pepper, candidate);
      verified.set(candidate, leak);
      if (!leak) continue;
      const replaced = replaceAllCounted(next, candidate, credentialMaskFor(leak.credential_id));
      next = replaced.text;
      replacements += replaced.replacements;
      credentials.push(leak);
    }
  } catch (error) {
    // Same fail-closed rule as the block walk: this text is about to be stored
    // on the conversations row, so an unverifiable span is masked, not kept.
    const masked = maskUnverifiedCandidates(next, isKnownClean);
    credentialLeakLog("error", "credential_leak_text_verification_failed", {
      masked_spans: masked.replacements,
      error: String(error),
    });
    return {
      text: masked.text,
      replacements,
      credentials,
      truncated: extracted.truncated,
      unverified_replacements: masked.replacements,
      verification_failed: true,
    };
  }
  if (!extracted.truncated) {
    return {
      text: next,
      replacements,
      credentials,
      truncated: false,
      unverified_replacements: 0,
      verification_failed: false,
    };
  }
  const masked = maskUnverifiedCandidates(next, isKnownClean);
  return {
    text: masked.text,
    replacements,
    credentials,
    truncated: true,
    unverified_replacements: masked.replacements,
    verification_failed: false,
  };
}

/**
 * Detect and mask in one pass (issue b3e4a09).
 *
 * Same detection contract as `scanBlocksForCredentialLeaks`, but every verified
 * occurrence of live credential plaintext is replaced in the caller's block
 * objects before they are persisted. Ingestion calls this instead of the
 * scan-only variant so the index never holds a working token; the source
 * transcript is untouched and remains the only place the original exists.
 */
export function redactCredentialLeaksInBlocks(
  db: Db,
  blocks: readonly RedactableBlock[],
  location: CredentialLeakLocation,
  options: ScanTextOptions = {},
): CredentialLeakRedactionResult {
  return walkBlocksForCredentials(db, blocks, location, options, true);
}

// --- On-demand backfill over the existing index ------------------------------

export interface CredentialLeakBackfillOptions {
  /** Restrict the sweep to one conversation id. */
  conversationId?: string | null;
  /** Cap on blocks scanned (0 or undefined = the whole index). */
  limit?: number;
  /** Rows fetched per batch. */
  batchSize?: number;
  /** When false, report detections without persisting alerts or revoking. */
  record?: boolean;
  pepper?: string;
  now?: number;
}

export interface CredentialLeakBackfillResult {
  scanned_blocks: number;
  scanned_conversations: number;
  detections: CredentialLeakDetection[];
  truncated: boolean;
  skipped?: "no_active_api_tokens";
}

interface BackfillRow {
  id: string;
  conversation_id: string;
  content: Buffer | string;
  metadata_json: string | null;
  compressed: number;
  position: number;
  session_id: string | null;
  source: string | null;
  branch: string | null;
  title: string | null;
}

const DEFAULT_BACKFILL_BATCH = 500;

/**
 * Sweep the already-indexed conversation blocks. This is the acceptance path
 * for credentials that leaked before detection existed: an active PAT sitting
 * in an old transcript is found, alerted on, and (for session-scoped tokens
 * only) revoked.
 */
export function backfillCredentialLeakScan(
  db: Db,
  options: CredentialLeakBackfillOptions = {},
): CredentialLeakBackfillResult {
  if (!hasActiveApiTokenCredentials(db)) {
    return {
      scanned_blocks: 0,
      scanned_conversations: 0,
      detections: [],
      truncated: false,
      skipped: "no_active_api_tokens",
    };
  }

  const pepper = options.pepper ?? scanPepper(db);
  const now = options.now ?? Date.now();
  const record = options.record !== false;
  const conversationId = options.conversationId ?? null;
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BACKFILL_BATCH);
  const limit = options.limit && options.limit > 0 ? options.limit : Number.POSITIVE_INFINITY;

  const select = db.prepare(
    `SELECT b.id AS id, b.conversation_id AS conversation_id, b.content AS content,
            b.metadata_json AS metadata_json,
            b.compressed AS compressed, b.position AS position,
            c.session_id AS session_id, c.source AS source, c.branch AS branch,
            c.title AS title
     FROM conversation_blocks b
     JOIN conversations c ON c.id = b.conversation_id
     WHERE b.payload_state = 'legacy'
       AND (? IS NULL OR b.conversation_id = ?)
     ORDER BY b.rowid
     LIMIT ? OFFSET ?`,
  );

  const detections: CredentialLeakDetection[] = [];
  // One alert per (credential, conversation) across the whole sweep.
  const seen = new Set<string>();
  const conversations = new Set<string>();
  let scanned = 0;
  let offset = 0;
  let truncated = false;

  for (;;) {
    const take = Math.min(batchSize, limit - scanned);
    if (take <= 0) break;
    const rows = select.all(conversationId, conversationId, take, offset) as BackfillRow[];
    if (rows.length === 0) break;
    offset += rows.length;

    for (const row of rows) {
      scanned += 1;
      conversations.add(row.conversation_id);
      let text: string;
      try {
        text = decompressContent(row.content, row.compressed === 1);
      } catch {
        continue;
      }
      // Tool arguments and short tool results are duplicated into metadata_json
      // by the parsers, so a sweep that only reads `content` under-reports.
      const extractedContent = extractTokenCandidatesWithStatus(text);
      const extractedMetadata = extractTokenCandidatesWithStatus(row.metadata_json);
      truncated ||= extractedContent.truncated || extractedMetadata.truncated;
      const candidates = extractedMetadata.candidates.length === 0
        ? extractedContent.candidates
        : [...new Set([...extractedContent.candidates, ...extractedMetadata.candidates])];
      for (const candidate of candidates) {
        const leak = matchActiveCredential(db, pepper, candidate);
        if (!leak) continue;
        const key = `${leak.credential_id} ${row.conversation_id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const location: CredentialLeakLocation = {
          conversation_id: row.conversation_id,
          conversation_title: row.title,
          session_id: row.session_id,
          source: row.source,
          branch: row.branch,
          block_id: row.id,
          block_position: row.position,
        };
        detections.push(
          record
            ? recordCredentialLeak(db, leak, location, now)
            : {
              event_id: leakEventId(leak.credential_id, row.conversation_id),
              detected_at: now,
              credential: leak,
              location,
              revoked: false,
              new_event: false,
            },
        );
      }
    }

    if (rows.length < take) break;
  }

  if (truncated) {
    credentialLeakLog("warn", "credential_leak_backfill_candidates_truncated", {
      scanned_blocks: scanned,
      max_candidates_per_text: MAX_CANDIDATES_PER_TEXT,
    });
  }
  return {
    scanned_blocks: scanned,
    scanned_conversations: conversations.size,
    detections,
    truncated,
  };
}
