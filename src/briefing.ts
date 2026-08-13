// Briefing review store (umbrella 99b74d6 / issue ce22a3a).
//
// This module owns the server-side semantics of the briefing pilot:
//
//   - Ingestion is idempotent per `batch_key`. A replayed batch writes nothing
//     and returns the original result, which is RECOMPUTED from stored rows
//     rather than cached, so the replay answer is identical by construction.
//   - Identity is publisher-derived. `candidate_key` and `evidence_hash` arrive
//     already computed; the daemon never re-derives them and never trusts an
//     analyzer to hash. A (candidate, evidence_hash) pair is a revision; the
//     same pair seen again is only an occurrence.
//   - Review state is DERIVED from the append-only `decision_events` stream. A
//     candidate is pending iff its current revision has no effective decision:
//     because `undo` clears whatever preceded it, only the LAST event on the
//     revision matters (absent or `undo` => pending).
//   - `expire` events are system-generated with a NULL actor and present as
//     `expired_unreviewed`; they leave the badge count exactly as a human
//     decision would.
//
// Authorization lives at the route boundary (src/routes/briefing.ts); this
// module takes an already-resolved actor id.

import { randomUUID } from "node:crypto";

import {
  BRIEFING_INGEST_SCHEMA,
  type BriefingCandidateHistoryResponse,
  type BriefingCandidateState,
  type BriefingComment,
  type BriefingDecisionEvent,
  type BriefingEvidenceKind,
  type BriefingIngestItem,
  type BriefingIngestRequest,
  type BriefingIngestResult,
  type BriefingQueueEntry,
  type BriefingQueueResponse,
  type BriefingOccurrenceStats,
  type BriefingRevision,
  type BriefingReviewAction,
  type BriefingSourceHealth,
} from "./contracts.js";
import { getDb, type Db } from "./db.js";
import { getSetting } from "./client-auth/settings-kv.js";

/** Settings key holding the expiry horizon for unreviewed candidates (ms). */
export const BRIEFING_EXPIRY_MS_KEY = "briefing.expiry_ms";
export const DEFAULT_BRIEFING_EXPIRY_MS = 14 * 24 * 60 * 60 * 1_000;

/**
 * Settings key holding the publisher -> permitted source namespace mapping:
 * `{"<user-slug>": ["<task-identity-prefix>", ...]}`. The default seeds the
 * `agent-schedule` publisher; the operator may extend it without a schema
 * change. An identity with no mapping cannot ingest.
 */
export const BRIEFING_PUBLISHERS_KEY = "briefing.ingest.publishers";
export const DEFAULT_BRIEFING_PUBLISHERS: Readonly<Record<string, readonly string[]>> =
  Object.freeze({ "agent-schedule": Object.freeze(["agent-schedule/"]) });

export class BriefingValidationError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = "BriefingValidationError";
  }
}

// --- row shapes -------------------------------------------------------------

interface CandidateRow {
  id: string;
  source: string;
  candidate_key: string;
  current_revision_id: string | null;
  created_at: number;
}

interface RevisionRow {
  id: string;
  candidate_id: string;
  title: string;
  why_notable: string | null;
  refs_json: string;
  source_ref: string | null;
  evidence_hash: string;
  evidence_kind: BriefingEvidenceKind;
  captured_at: string | null;
  run_id: string | null;
  digest_series_ref: string | null;
  digest_version: number | null;
  rank: number | null;
  batch_key: string;
  ingested_at: number;
}

function parseRefs(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function projectRevision(row: RevisionRow): BriefingRevision {
  return {
    id: row.id,
    candidate_id: row.candidate_id,
    title: row.title,
    why_notable: row.why_notable,
    refs: parseRefs(row.refs_json),
    source_ref: row.source_ref,
    evidence_hash: row.evidence_hash,
    evidence_kind: row.evidence_kind,
    captured_at: row.captured_at,
    run_id: row.run_id,
    digest_series_ref: row.digest_series_ref,
    digest_version: row.digest_version,
    rank: row.rank,
    batch_key: row.batch_key,
    ingested_at: row.ingested_at,
  };
}

// --- request validation -----------------------------------------------------

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new BriefingValidationError(`${field} is required`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new BriefingValidationError(`${field} must be a string`);
  return value;
}

function requireInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new BriefingValidationError(`${field} must be an integer`);
  }
  return value;
}

/**
 * Validate an untrusted ingest body into a typed batch. Structural only — the
 * publisher owns identity derivation, so hashes are treated as opaque strings.
 */
export function parseBriefingIngestRequest(body: unknown): BriefingIngestRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new BriefingValidationError("request body must be a JSON object");
  }
  const record = body as Record<string, unknown>;
  const schema = requireString(record.schema, "schema");
  if (schema !== BRIEFING_INGEST_SCHEMA) {
    throw new BriefingValidationError(
      `unsupported schema '${schema}'; expected '${BRIEFING_INGEST_SCHEMA}'`,
    );
  }
  const digest = record.digest;
  if (!digest || typeof digest !== "object" || Array.isArray(digest)) {
    throw new BriefingValidationError("digest must be an object");
  }
  const digestRecord = digest as Record<string, unknown>;
  const items = record.items;
  if (!Array.isArray(items)) {
    throw new BriefingValidationError("items must be an array");
  }

  return {
    schema: BRIEFING_INGEST_SCHEMA,
    task_identity: requireString(record.task_identity, "task_identity"),
    run_id: requireString(record.run_id, "run_id"),
    digest: {
      series_ref: requireString(digestRecord.series_ref, "digest.series_ref"),
      version: requireInteger(digestRecord.version, "digest.version"),
    },
    batch_key: requireString(record.batch_key, "batch_key"),
    items: items.map((item, index) => parseIngestItem(item, index)),
  };
}

function parseIngestItem(value: unknown, index: number): BriefingIngestItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BriefingValidationError(`items[${index}] must be an object`);
  }
  const item = value as Record<string, unknown>;
  const evidenceKind = requireString(item.evidence_kind, `items[${index}].evidence_kind`);
  if (evidenceKind !== "snapshot-item" && evidenceKind !== "finding-only") {
    throw new BriefingValidationError(
      `items[${index}].evidence_kind must be 'snapshot-item' or 'finding-only'`,
    );
  }
  const refsValue = item.refs;
  let refs: string[] = [];
  if (refsValue !== undefined && refsValue !== null) {
    if (!Array.isArray(refsValue) || refsValue.some((ref) => typeof ref !== "string")) {
      throw new BriefingValidationError(`items[${index}].refs must be an array of strings`);
    }
    refs = refsValue as string[];
  }
  const rankValue = item.rank;
  let rank: number | null = null;
  if (rankValue !== undefined && rankValue !== null) {
    rank = requireInteger(rankValue, `items[${index}].rank`);
  }
  return {
    candidate_key: requireString(item.candidate_key, `items[${index}].candidate_key`),
    source: requireString(item.source, `items[${index}].source`),
    ref: requireString(item.ref, `items[${index}].ref`),
    title: requireString(item.title, `items[${index}].title`),
    why_notable: optionalString(item.why_notable, `items[${index}].why_notable`),
    refs,
    evidence_hash: requireString(item.evidence_hash, `items[${index}].evidence_hash`),
    evidence_kind: evidenceKind,
    captured_at: optionalString(item.captured_at, `items[${index}].captured_at`),
    rank,
  };
}

// --- publisher namespace mapping -------------------------------------------

export function readBriefingPublisherNamespaces(
  db: Db = getDb(),
): Record<string, string[]> {
  const raw = getSetting(db, BRIEFING_PUBLISHERS_KEY);
  if (!raw) {
    return Object.fromEntries(
      Object.entries(DEFAULT_BRIEFING_PUBLISHERS).map(([slug, prefixes]) => [slug, [...prefixes]]),
    );
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const mapping: Record<string, string[]> = {};
    for (const [slug, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue;
      mapping[slug] = value.filter((entry): entry is string => typeof entry === "string");
    }
    return mapping;
  } catch {
    // A malformed override is fail-closed: no publisher is mapped.
    return {};
  }
}

/** True when `slug` may publish batches for `taskIdentity`. */
export function publisherMayIngest(
  db: Db,
  slug: string,
  taskIdentity: string,
): boolean {
  const prefixes = readBriefingPublisherNamespaces(db)[slug];
  if (!prefixes || prefixes.length === 0) return false;
  return prefixes.some((prefix) => taskIdentity === prefix || taskIdentity.startsWith(prefix));
}

// --- ingestion --------------------------------------------------------------

/**
 * Ingest one batch atomically. Replay of a known `batch_key` writes nothing and
 * returns the original result.
 */
export function ingestBriefingBatch(
  db: Db,
  batch: BriefingIngestRequest,
  now: number = Date.now(),
): BriefingIngestResult {
  const run = db.transaction((): BriefingIngestResult => {
    const replay = db
      .prepare("SELECT batch_key FROM briefing_batches WHERE batch_key = ?")
      .get(batch.batch_key) as { batch_key: string } | undefined;
    if (replay) return summarizeBatch(db, batch.batch_key);

    // "Never move current_revision_id backwards": a batch at or below a digest
    // version already ingested for this task identity is still recorded (its
    // revisions and occurrences are facts) but does not re-point a candidate.
    const priorMax = (db
      .prepare("SELECT MAX(digest_version) AS version FROM briefing_batches WHERE task_identity = ?")
      .get(batch.task_identity) as { version: number | null } | undefined)?.version ?? null;
    const stale = priorMax !== null && batch.digest.version <= priorMax;

    db.prepare(
      `INSERT INTO briefing_batches (
         batch_key, task_identity, run_id, digest_series_ref, digest_version,
         item_count, received_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      batch.batch_key,
      batch.task_identity,
      batch.run_id,
      batch.digest.series_ref,
      batch.digest.version,
      batch.items.length,
      now,
    );

    for (const item of batch.items) {
      ingestItem(db, batch, item, { now, stale });
    }
    return summarizeBatch(db, batch.batch_key);
  });
  return run();
}

function ingestItem(
  db: Db,
  batch: BriefingIngestRequest,
  item: BriefingIngestItem,
  context: { now: number; stale: boolean },
): void {
  let candidate = db
    .prepare("SELECT * FROM review_candidates WHERE source = ? AND candidate_key = ?")
    .get(item.source, item.candidate_key) as CandidateRow | undefined;
  if (!candidate) {
    const id = randomUUID();
    db.prepare(
      `INSERT INTO review_candidates (id, source, candidate_key, current_revision_id, created_at)
       VALUES (?, ?, ?, NULL, ?)`,
    ).run(id, item.source, item.candidate_key, context.now);
    candidate = {
      id,
      source: item.source,
      candidate_key: item.candidate_key,
      current_revision_id: null,
      created_at: context.now,
    };
  }

  let revision = db
    .prepare("SELECT * FROM candidate_revisions WHERE candidate_id = ? AND evidence_hash = ?")
    .get(candidate.id, item.evidence_hash) as RevisionRow | undefined;

  if (!revision) {
    const revisionId = randomUUID();
    db.prepare(
      `INSERT INTO candidate_revisions (
         id, candidate_id, title, why_notable, refs_json, source_ref, evidence_hash,
         evidence_kind, captured_at, run_id, digest_series_ref, digest_version, rank,
         batch_key, ingested_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      revisionId,
      candidate.id,
      item.title,
      item.why_notable ?? null,
      JSON.stringify(item.refs ?? []),
      item.ref,
      item.evidence_hash,
      item.evidence_kind,
      item.captured_at ?? null,
      batch.run_id,
      batch.digest.series_ref,
      batch.digest.version,
      item.rank ?? null,
      batch.batch_key,
      context.now,
    );
    revision = db
      .prepare("SELECT * FROM candidate_revisions WHERE id = ?")
      .get(revisionId) as RevisionRow;

    const current = candidate.current_revision_id
      ? (db
        .prepare("SELECT * FROM candidate_revisions WHERE id = ?")
        .get(candidate.current_revision_id) as RevisionRow | undefined)
      : undefined;
    const currentVersion = current?.digest_version ?? Number.NEGATIVE_INFINITY;
    const shouldMove = !current
      || (!context.stale && batch.digest.version >= currentVersion);
    if (shouldMove) {
      db.prepare("UPDATE review_candidates SET current_revision_id = ? WHERE id = ?")
        .run(revisionId, candidate.id);
    }
  }

  db.prepare(
    `INSERT OR IGNORE INTO candidate_occurrences (id, revision_id, digest_version, batch_key, seen_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(randomUUID(), revision.id, batch.digest.version, batch.batch_key, context.now);
}

/**
 * Recompute a batch's result from stored rows. `created` is a revision this
 * batch wrote that is the earliest revision of its candidate; `revised` is a
 * revision it wrote for a candidate that already had one. Everything else the
 * batch accepted changed nothing.
 */
export function summarizeBatch(db: Db, batchKey: string): BriefingIngestResult {
  const accepted = (db
    .prepare("SELECT item_count FROM briefing_batches WHERE batch_key = ?")
    .get(batchKey) as { item_count: number } | undefined)?.item_count ?? 0;
  const written = (db
    .prepare("SELECT COUNT(*) AS n FROM candidate_revisions WHERE batch_key = ?")
    .get(batchKey) as { n: number }).n;
  const created = (db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM candidate_revisions AS r
        WHERE r.batch_key = ?
          AND NOT EXISTS (
            SELECT 1 FROM candidate_revisions AS p
             WHERE p.candidate_id = r.candidate_id
               AND (p.ingested_at < r.ingested_at
                 OR (p.ingested_at = r.ingested_at AND p.rowid < r.rowid))
          )`,
    )
    .get(batchKey) as { n: number }).n;
  const revised = written - created;
  return {
    accepted,
    created,
    revised,
    unchanged: Math.max(0, accepted - created - revised),
  };
}

// --- derived review state ---------------------------------------------------

/**
 * The last decision action on a revision. `undo` clears whatever preceded it,
 * so the trailing event alone determines the effective state.
 */
function lastActionForRevision(db: Db, revisionId: string): string | null {
  const row = db
    .prepare(
      `SELECT action FROM decision_events
        WHERE revision_id = ?
        ORDER BY created_at DESC, rowid DESC
        LIMIT 1`,
    )
    .get(revisionId) as { action: string } | undefined;
  return row?.action ?? null;
}

export function candidateStateFromAction(action: string | null): BriefingCandidateState {
  switch (action) {
    case "keep":
      return "kept";
    case "dismiss":
      return "dismissed";
    case "expire":
      return "expired_unreviewed";
    default:
      return "pending";
  }
}

/** SQL predicate selecting candidates whose current revision is undecided. */
const PENDING_PREDICATE = `
  c.current_revision_id IS NOT NULL
  AND COALESCE((
    SELECT d.action FROM decision_events AS d
     WHERE d.revision_id = c.current_revision_id
     ORDER BY d.created_at DESC, d.rowid DESC
     LIMIT 1
  ), 'undo') = 'undo'
`;

export function countPendingBriefingCandidates(db: Db = getDb()): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM review_candidates AS c WHERE ${PENDING_PREDICATE}`)
    .get() as { n: number };
  return row.n;
}

function occurrenceStats(db: Db, revisionId: string): BriefingOccurrenceStats {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count, MIN(seen_at) AS first_seen_at, MAX(seen_at) AS last_seen_at
         FROM candidate_occurrences WHERE revision_id = ?`,
    )
    .get(revisionId) as { count: number; first_seen_at: number | null; last_seen_at: number | null };
  return {
    count: row.count,
    first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
  };
}

export interface BriefingQueueOptions {
  source?: string;
  limit?: number;
  now?: number;
}

export function listBriefingQueue(
  db: Db = getDb(),
  options: BriefingQueueOptions = {},
): BriefingQueueResponse {
  const now = options.now ?? Date.now();
  const params: unknown[] = [];
  let sql = `SELECT c.* FROM review_candidates AS c WHERE ${PENDING_PREDICATE}`;
  if (options.source) {
    sql += " AND c.source = ?";
    params.push(options.source);
  }
  sql += " ORDER BY c.created_at DESC, c.rowid DESC";
  if (options.limit !== undefined) {
    sql += " LIMIT ?";
    params.push(Math.max(0, Math.trunc(options.limit)));
  }
  const rows = db.prepare(sql).all(...params) as CandidateRow[];

  // The queue is unbounded and the UI reloads it on a timer, so the per-entry
  // lookups are prepared once and the batch ledger is JOINED into the revision
  // read rather than queried again per entry. The join is on the CURRENT
  // revision's own `batch_key`, so `task_identity` stays the producer of this
  // revision — not the source's latest batch, which is a different fact.
  const revisionStatement = db.prepare(
    `SELECT r.*, b.task_identity AS batch_task_identity
       FROM candidate_revisions AS r
       LEFT JOIN briefing_batches AS b ON b.batch_key = r.batch_key
      WHERE r.id = ?`,
  );
  const revisionCountStatement = db.prepare(
    "SELECT COUNT(*) AS n FROM candidate_revisions WHERE candidate_id = ?",
  );

  const candidates: BriefingQueueEntry[] = rows.map((row) => {
    const revision = revisionStatement.get(row.current_revision_id) as
      RevisionRow & { batch_task_identity: string | null };
    const revisionCount = (revisionCountStatement.get(row.id) as { n: number }).n;
    return {
      id: row.id,
      source: row.source,
      candidate_key: row.candidate_key,
      created_at: row.created_at,
      state: "pending",
      revision: projectRevision(revision),
      revision_count: revisionCount,
      occurrences: occurrenceStats(db, revision.id),
      // The revision carries `batch_key` but not the identity behind it, and a
      // client cannot resolve one from the other. Resolving it here is what
      // makes "who produced this finding" answerable per entry instead of only
      // per source; see `BriefingQueueEntry.task_identity`.
      task_identity: revision.batch_task_identity ?? null,
    };
  });

  return { candidates, sources: listBriefingSourceHealth(db, now) };
}

/**
 * Per-source ingest health. The last-ingest facts are pulled from the batch
 * ledger through the revision that carried the batch, so a source that stopped
 * reporting shows its age even with nothing pending.
 */
export function listBriefingSourceHealth(
  db: Db = getDb(),
  now: number = Date.now(),
): BriefingSourceHealth[] {
  const rows = db
    .prepare(
      // The pending predicate is correlated per candidate, so it is evaluated
      // in a subquery and only then aggregated.
      `SELECT source, COUNT(*) AS candidate_count, SUM(is_pending) AS pending_count
         FROM (
           SELECT c.source AS source,
                  CASE WHEN ${PENDING_PREDICATE} THEN 1 ELSE 0 END AS is_pending
             FROM review_candidates AS c
         )
        GROUP BY source
        ORDER BY source ASC`,
    )
    .all() as Array<{ source: string; candidate_count: number; pending_count: number }>;

  return rows.map((row) => {
    const batch = db
      .prepare(
        `SELECT b.task_identity, b.run_id, b.digest_version, b.item_count, b.received_at
           FROM candidate_occurrences AS o
           JOIN candidate_revisions AS r ON r.id = o.revision_id
           JOIN review_candidates AS c ON c.id = r.candidate_id
           JOIN briefing_batches AS b ON b.batch_key = o.batch_key
          WHERE c.source = ?
          ORDER BY b.received_at DESC, b.rowid DESC
          LIMIT 1`,
      )
      .get(row.source) as
      | {
        task_identity: string;
        run_id: string | null;
        digest_version: number | null;
        item_count: number;
        received_at: number;
      }
      | undefined;
    return {
      source: row.source,
      pending_count: Number(row.pending_count ?? 0),
      candidate_count: Number(row.candidate_count ?? 0),
      last_task_identity: batch?.task_identity ?? null,
      last_run_id: batch?.run_id ?? null,
      last_digest_version: batch?.digest_version ?? null,
      last_ingested_at: batch?.received_at ?? null,
      last_ingest_age_ms: batch ? Math.max(0, now - batch.received_at) : null,
      last_batch_item_count: batch?.item_count ?? null,
    };
  });
}

export function getBriefingCandidate(db: Db, candidateId: string): CandidateRow | null {
  return (db
    .prepare("SELECT * FROM review_candidates WHERE id = ?")
    .get(candidateId) as CandidateRow | undefined) ?? null;
}

export function getBriefingCandidateHistory(
  db: Db,
  candidateId: string,
): BriefingCandidateHistoryResponse | null {
  const candidate = getBriefingCandidate(db, candidateId);
  if (!candidate) return null;
  const revisions = (db
    .prepare(
      "SELECT * FROM candidate_revisions WHERE candidate_id = ? ORDER BY ingested_at ASC, rowid ASC",
    )
    .all(candidateId) as RevisionRow[]).map(projectRevision);
  const decisions = db
    .prepare(
      "SELECT * FROM decision_events WHERE candidate_id = ? ORDER BY created_at ASC, rowid ASC",
    )
    .all(candidateId) as BriefingDecisionEvent[];
  const comments = db
    .prepare(
      "SELECT * FROM candidate_comments WHERE candidate_id = ? ORDER BY created_at ASC, rowid ASC",
    )
    .all(candidateId) as BriefingComment[];
  return {
    candidate: {
      id: candidate.id,
      source: candidate.source,
      candidate_key: candidate.candidate_key,
      current_revision_id: candidate.current_revision_id,
      created_at: candidate.created_at,
      state: candidate.current_revision_id
        ? candidateStateFromAction(lastActionForRevision(db, candidate.current_revision_id))
        : "pending",
    },
    revisions,
    decisions,
    comments,
  };
}

// --- decisions and comments -------------------------------------------------

export interface BriefingDecisionInput {
  candidateId: string;
  action: BriefingReviewAction;
  actorUserId: string;
  /**
   * The revision the judgment is about. Omitted means the candidate's current
   * revision, which is only correct for a caller that never showed a specific
   * revision to the human it is acting for.
   */
  revisionId?: string;
  now?: number;
}

export interface BriefingDecisionOutcome {
  candidate_id: string;
  revision_id: string;
  action: BriefingReviewAction;
  event_id: string;
  state: BriefingCandidateState;
}

/**
 * Append a human decision to ONE revision.
 *
 * The event is addressed by revision, not by candidate: `input.revisionId`
 * pins it to the revision the reviewer actually judged, so a re-ingest racing
 * the click can neither move a keep onto text nobody read nor make an Undo of
 * an older row clear the decision on a newer one. A caller with no revision in
 * hand omits it and gets the current revision, which is the pre-existing
 * behavior.
 *
 * `undo` is only meaningful when the TARGET revision carries an effective
 * decision; undoing an undecided revision is a conflict rather than a silent
 * no-op, and that check is what turns a double-undo into a visible 409.
 */
export function recordBriefingDecision(
  db: Db,
  input: BriefingDecisionInput,
): BriefingDecisionOutcome {
  const now = input.now ?? Date.now();
  const run = db.transaction((): BriefingDecisionOutcome => {
    const candidate = getBriefingCandidate(db, input.candidateId);
    if (!candidate) {
      throw new BriefingValidationError("candidate not found", 404);
    }
    if (!candidate.current_revision_id) {
      throw new BriefingValidationError("candidate has no current revision", 409);
    }
    let revisionId = candidate.current_revision_id;
    if (input.revisionId !== undefined) {
      // A revision id from a client is a claim about identity, so it is checked
      // against THIS candidate: a decision may never be written across the
      // candidate boundary the id was presented under.
      const owned = db
        .prepare("SELECT 1 AS ok FROM candidate_revisions WHERE id = ? AND candidate_id = ?")
        .get(input.revisionId, candidate.id) as { ok: number } | undefined;
      if (!owned) {
        throw new BriefingValidationError("revision not found for candidate", 404);
      }
      revisionId = input.revisionId;
    }
    const last = lastActionForRevision(db, revisionId);
    if (input.action === "undo" && candidateStateFromAction(last) === "pending") {
      throw new BriefingValidationError("no decision to undo", 409);
    }
    const eventId = randomUUID();
    db.prepare(
      `INSERT INTO decision_events (
         id, candidate_id, revision_id, action, actor_user_id, comment_id, created_at
       ) VALUES (?, ?, ?, ?, ?, NULL, ?)`,
    ).run(eventId, candidate.id, revisionId, input.action, input.actorUserId, now);
    return {
      candidate_id: candidate.id,
      revision_id: revisionId,
      action: input.action,
      event_id: eventId,
      // The candidate's state follows its CURRENT revision even when the event
      // landed on a superseded one, so the response never reports a candidate
      // as decided on the strength of a judgment about older content.
      state: candidateStateFromAction(
        lastActionForRevision(db, candidate.current_revision_id),
      ),
    };
  });
  return run();
}

export interface BriefingCommentInput {
  candidateId: string;
  body: string;
  actorUserId: string;
  now?: number;
}

export function addBriefingComment(db: Db, input: BriefingCommentInput): BriefingComment {
  const now = input.now ?? Date.now();
  const body = input.body.trim();
  if (!body) throw new BriefingValidationError("body is required");
  const candidate = getBriefingCandidate(db, input.candidateId);
  if (!candidate) throw new BriefingValidationError("candidate not found", 404);
  if (!candidate.current_revision_id) {
    throw new BriefingValidationError("candidate has no current revision", 409);
  }
  const id = randomUUID();
  db.prepare(
    `INSERT INTO candidate_comments (id, candidate_id, revision_id, body, actor_user_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, candidate.id, candidate.current_revision_id, body, input.actorUserId, now);
  return db
    .prepare("SELECT * FROM candidate_comments WHERE id = ?")
    .get(id) as BriefingComment;
}

// --- expiry sweep -----------------------------------------------------------

export function briefingExpiryMs(db: Db): number {
  const raw = getSetting(db, BRIEFING_EXPIRY_MS_KEY);
  const parsed = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_BRIEFING_EXPIRY_MS;
}

export interface BriefingSweepResult {
  expired: number;
  candidate_ids: string[];
}

/**
 * Mark pending candidates whose current revision was last seen before the
 * expiry horizon. The event carries a NULL actor: nothing about it is a human
 * review, and the queue presents it as `expired_unreviewed`.
 */
export function sweepExpiredBriefingCandidates(
  db: Db = getDb(),
  options: { now?: number; expiryMs?: number } = {},
): BriefingSweepResult {
  const now = options.now ?? Date.now();
  const expiryMs = options.expiryMs ?? briefingExpiryMs(db);
  const cutoff = now - expiryMs;
  const run = db.transaction((): BriefingSweepResult => {
    const rows = db
      .prepare(
        `SELECT c.id AS id, c.current_revision_id AS revision_id
           FROM review_candidates AS c
           JOIN candidate_revisions AS r ON r.id = c.current_revision_id
          WHERE ${PENDING_PREDICATE}
            AND COALESCE(
              (SELECT MAX(o.seen_at) FROM candidate_occurrences AS o WHERE o.revision_id = r.id),
              r.ingested_at
            ) < ?`,
      )
      .all(cutoff) as Array<{ id: string; revision_id: string }>;
    const insert = db.prepare(
      `INSERT INTO decision_events (
         id, candidate_id, revision_id, action, actor_user_id, comment_id, created_at
       ) VALUES (?, ?, ?, 'expire', NULL, NULL, ?)`,
    );
    for (const row of rows) {
      insert.run(randomUUID(), row.id, row.revision_id, now);
    }
    return { expired: rows.length, candidate_ids: rows.map((row) => row.id) };
  });
  return run();
}
