// Shared persistence for recurring feedback collections.
//
// The generic feedback schema deliberately does not contain Briefing-specific
// columns.  The few legacy projection fields that are not represented by the
// generic item/revision/publication columns live in this single, versioned
// content_json shape.  Migration v126 and all live writes use the encoder below
// so migrated and newly-ingested rows cannot drift into incompatible formats.

import { randomUUID } from "node:crypto";

import type {
  BriefingCandidateHistoryResponse,
  BriefingCandidateState,
  BriefingComment,
  BriefingDecisionEvent,
  BriefingEvidenceKind,
  BriefingIngestItem,
  BriefingIngestRequest,
  BriefingIngestResult,
  BriefingOccurrenceStats,
  BriefingPublisherAdvisory,
  BriefingQueueEntry,
  BriefingQueueResponse,
  BriefingRevision,
  BriefingReviewAction,
  BriefingSourceHealth,
} from "../contracts.js";
import type { Db } from "../db.js";

export const RECURRING_REVISION_CONTENT_SCHEMA = "mandible.feedback.recurring_revision.v1";
export const RECURRING_REVISION_CONTENT_SCHEMA_V2 = "mandible.feedback.recurring_revision.v2";
const EMPTY_BRIEFING_BATCH_SOURCE = "mandible.internal/briefing-empty-batches";

export interface RecurringRevisionContent {
  schema: typeof RECURRING_REVISION_CONTENT_SCHEMA | typeof RECURRING_REVISION_CONTENT_SCHEMA_V2;
  why_notable: string | null;
  refs: string[];
  source_ref: string | null;
  evidence_kind: BriefingEvidenceKind;
  captured_at: string | null;
  rank: number | null;
  publisher_advisory: BriefingPublisherAdvisory | null;
}

export interface RecurringCandidateRow {
  id: string;
  source: string;
  candidate_key: string;
  current_revision_id: string | null;
  created_at: number;
}

interface KernelRevisionRow {
  id: string;
  item_id: string;
  ordinal: number;
  title: string;
  content_json: string;
  evidence_digest: string | null;
  publication_id: string | null;
  created_at: number;
  publication_key: string | null;
  task_identity: string | null;
  run_id: string | null;
  digest_series_ref: string | null;
  digest_version: number | null;
}

export class FeedbackStoreError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = "FeedbackStoreError";
  }
}

export function encodeRecurringRevisionContent(
  value: Omit<RecurringRevisionContent, "schema" | "publisher_advisory">,
): string {
  return JSON.stringify({ schema: RECURRING_REVISION_CONTENT_SCHEMA, ...value });
}

export function encodeRecurringRevisionContentV2(
  value: Omit<RecurringRevisionContent, "schema">,
): string {
  return JSON.stringify({ schema: RECURRING_REVISION_CONTENT_SCHEMA_V2, ...value });
}

export function decodeRecurringRevisionContent(json: string): RecurringRevisionContent {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error("invalid recurring feedback revision content_json");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid recurring feedback revision content_json");
  }
  const record = value as Record<string, unknown>;
  if (
    (record.schema !== RECURRING_REVISION_CONTENT_SCHEMA
      && record.schema !== RECURRING_REVISION_CONTENT_SCHEMA_V2)
    || (record.why_notable !== null && typeof record.why_notable !== "string")
    || !Array.isArray(record.refs)
    || record.refs.some((entry) => typeof entry !== "string")
    || (record.source_ref !== null && typeof record.source_ref !== "string")
    || (record.evidence_kind !== "snapshot-item" && record.evidence_kind !== "finding-only")
    || (record.captured_at !== null && typeof record.captured_at !== "string")
    || (record.rank !== null && !Number.isInteger(record.rank))
  ) {
    throw new Error("invalid recurring feedback revision content_json");
  }
  if (record.schema === RECURRING_REVISION_CONTENT_SCHEMA) {
    if (Object.hasOwn(record, "publisher_advisory")) {
      throw new Error("invalid recurring feedback revision content_json");
    }
    return { ...record, publisher_advisory: null } as unknown as RecurringRevisionContent;
  }
  const advisory = record.publisher_advisory;
  if (
    advisory !== null
    && (
      !advisory
      || typeof advisory !== "object"
      || Array.isArray(advisory)
      || (advisory as Record<string, unknown>).code !== "admission_gate_rejected"
      || typeof (advisory as Record<string, unknown>).reason !== "string"
      || !(advisory as Record<string, unknown>).reason
    )
  ) {
    throw new Error("invalid recurring feedback revision content_json");
  }
  return record as unknown as RecurringRevisionContent;
}

function projectRevision(row: KernelRevisionRow): BriefingRevision {
  const content = decodeRecurringRevisionContent(row.content_json);
  return {
    id: row.id,
    candidate_id: row.item_id,
    title: row.title,
    why_notable: content.why_notable,
    refs: content.refs,
    source_ref: content.source_ref,
    evidence_hash: row.evidence_digest ?? "",
    evidence_kind: content.evidence_kind,
    captured_at: content.captured_at,
    run_id: row.run_id,
    digest_series_ref: row.digest_series_ref,
    digest_version: row.digest_version,
    rank: content.rank,
    publisher_advisory: content.publisher_advisory,
    batch_key: row.publication_key ?? "",
    ingested_at: row.created_at,
  };
}

function revisionSelect(alias = "r"): string {
  return `${alias}.id, ${alias}.item_id, ${alias}.ordinal, ${alias}.title,
          ${alias}.content_json, ${alias}.evidence_digest, ${alias}.publication_id,
          ${alias}.created_at,
          COALESCE(ir.batch_key, p.publication_key) AS publication_key,
          p.task_identity, p.run_id,
          p.digest_series_ref, p.digest_version`;
}

export function recurringCandidateStateFromAction(action: string | null): BriefingCandidateState {
  switch (action) {
    case "keep": return "kept";
    case "dismiss": return "dismissed";
    case "expire": return "expired_unreviewed";
    default: return "pending";
  }
}

function lastRecurringEvent(
  db: Db,
  revisionId: string,
): { id: string; action: string; response: number } | null {
  const row = db.prepare(
    `SELECT id, action, response
       FROM (
         SELECT e.id AS id,
                CASE
                  WHEN e.operation = 'retract' THEN 'undo'
                  WHEN json_extract(e.value_json, '$.verdict') = 'keep' THEN 'keep'
                  WHEN json_extract(e.value_json, '$.verdict') = 'dismiss' THEN 'dismiss'
                  ELSE NULL
                END AS action,
                e.created_at AS created_at, e.rowid AS event_rowid, 1 AS response
           FROM feedback_response_events e
          WHERE e.item_revision_id = ?
         UNION ALL
         SELECT e.id, 'expire', e.created_at, e.rowid, 0
           FROM feedback_item_events e
          WHERE e.item_revision_id = ? AND e.operation = 'expired'
       )
      WHERE action IS NOT NULL
      ORDER BY created_at DESC, response DESC, event_rowid DESC
      LIMIT 1`,
  ).get(revisionId, revisionId) as { id: string; action: string; response: number } | undefined;
  return row ?? null;
}

export function lastRecurringActionForRevision(db: Db, revisionId: string): string | null {
  return lastRecurringEvent(db, revisionId)?.action ?? null;
}

const PENDING_PREDICATE = `
  i.item_kind = 'item'
  AND i.current_revision_id IS NOT NULL
  AND COALESCE((
    SELECT event.action
      FROM (
        SELECT CASE
                 WHEN e.operation = 'retract' THEN 'undo'
                 WHEN json_extract(e.value_json, '$.verdict') = 'keep' THEN 'keep'
                 WHEN json_extract(e.value_json, '$.verdict') = 'dismiss' THEN 'dismiss'
                 ELSE NULL
               END AS action,
               e.created_at AS created_at, e.rowid AS event_rowid, 1 AS response
          FROM feedback_response_events e
         WHERE e.item_revision_id = i.current_revision_id
        UNION ALL
        SELECT 'expire', e.created_at, e.rowid, 0
          FROM feedback_item_events e
         WHERE e.item_revision_id = i.current_revision_id AND e.operation = 'expired'
      ) event
     WHERE event.action IS NOT NULL
     ORDER BY event.created_at DESC, event.response DESC, event.event_rowid DESC
     LIMIT 1
  ), 'undo') = 'undo'
`;

function ensureRecurringCollection(
  db: Db,
  source: string,
  expiryMs: number,
  now: number,
): string {
  const existing = db.prepare(
    "SELECT id FROM feedback_collections WHERE kind = 'recurring_feed' AND source = ?",
  ).get(source) as { id: string } | undefined;
  if (existing) return existing.id;
  const id = randomUUID();
  db.prepare(
    `INSERT INTO feedback_collections
       (id, kind, interaction_mode, source, expires_at, created_at, tombstoned_at)
     VALUES (?, 'recurring_feed', 'immediate_per_item', ?, NULL, ?, NULL)`,
  ).run(id, source, now);
  db.prepare(
    `INSERT INTO feedback_recurring_profiles
       (collection_id, source_namespace, item_expiry_ms, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, source, expiryMs, now, now);
  db.prepare(
    `INSERT INTO feedback_collection_events
       (id, collection_id, operation, previous_event_id, actor_user_id, metadata_json, created_at)
     VALUES (?, ?, 'opened', NULL, NULL, '{}', ?)`,
  ).run(randomUUID(), id, now);
  return id;
}

export function ingestRecurringBatch(
  db: Db,
  batch: BriefingIngestRequest,
  options: {
    now: number;
    expiryMs: number;
    publisherUserId: string | null;
    requestDigest: string;
  },
): BriefingIngestResult {
  return db.transaction(() => {
    let requestId: string | null = null;
    if (options.publisherUserId) {
      const replay = db.prepare(
        `SELECT id, request_digest, result_json
           FROM feedback_ingest_requests
          WHERE publisher_user_id = ? AND task_identity = ? AND batch_key = ?`,
      ).get(options.publisherUserId, batch.task_identity, batch.batch_key) as
        | { id: string; request_digest: string; result_json: string }
        | undefined;
      if (replay) {
        if (replay.request_digest !== options.requestDigest) {
          throw new FeedbackStoreError(
            "batch replay conflicts with the previously stored request body",
            409,
          );
        }
        return JSON.parse(replay.result_json) as BriefingIngestResult;
      }
      requestId = randomUUID();
    } else {
      const replay = db.prepare(
        `SELECT 1 AS present
           FROM feedback_publications p
           JOIN feedback_collections c ON c.id = p.collection_id
          WHERE c.kind = 'recurring_feed' AND p.publication_key = ? LIMIT 1`,
      ).get(batch.batch_key);
      if (replay) return summarizeRecurringBatch(db, batch.batch_key);
    }

    validateRecurringBatchGraph(db, batch);

    if (requestId && options.publisherUserId) {
      db.prepare(
        `INSERT INTO feedback_ingest_requests (
           id, publisher_user_id, task_identity, batch_key, request_digest,
           schema_id, result_json, received_at
         ) VALUES (?, ?, ?, ?, ?, ?, '{}', ?)`,
      ).run(
        requestId,
        options.publisherUserId,
        batch.task_identity,
        batch.batch_key,
        options.requestDigest,
        batch.schema,
        options.now,
      );
    }

    const priorMax = (db.prepare(
      `SELECT MAX(p.digest_version) AS version
         FROM feedback_publications p
         JOIN feedback_collections c ON c.id = p.collection_id
        WHERE c.kind = 'recurring_feed' AND p.task_identity = ?
          AND (? IS NULL OR p.publisher_user_id = ?)`,
    ).get(batch.task_identity, options.publisherUserId, options.publisherUserId) as
      { version: number | null } | undefined)?.version ?? null;
    const stale = priorMax !== null && batch.digest.version <= priorMax;

    const publications = new Map<string, { collectionId: string; publicationId: string }>();
    if (batch.items.length === 0) {
      const collectionId = ensureRecurringCollection(
        db,
        EMPTY_BRIEFING_BATCH_SOURCE,
        options.expiryMs,
        options.now,
      );
      db.prepare(
         `INSERT INTO feedback_publications (
           id, collection_id, publication_key, publisher_user_id, task_identity,
           run_id, digest_series_ref, digest_version, item_count, received_at,
           ingest_request_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      ).run(
        randomUUID(), collectionId, requestId ?? batch.batch_key, options.publisherUserId,
        batch.task_identity, batch.run_id, batch.digest.series_ref, batch.digest.version,
        options.now, requestId,
      );
      const result = requestId
        ? summarizeRecurringRequest(db, requestId, batch.items.length)
        : summarizeRecurringBatch(db, batch.batch_key);
      if (requestId) {
        db.prepare("UPDATE feedback_ingest_requests SET result_json = ? WHERE id = ?")
          .run(JSON.stringify(result), requestId);
      }
      return result;
    }
    for (const source of new Set(batch.items.map((item) => item.source))) {
      const collectionId = ensureRecurringCollection(db, source, options.expiryMs, options.now);
      const publicationId = randomUUID();
      db.prepare(
         `INSERT INTO feedback_publications (
           id, collection_id, publication_key, publisher_user_id, task_identity,
           run_id, digest_series_ref, digest_version, item_count, received_at,
           ingest_request_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        publicationId, collectionId, requestId ?? batch.batch_key, options.publisherUserId,
        batch.task_identity,
        batch.run_id, batch.digest.series_ref, batch.digest.version,
        batch.items.length, options.now, requestId,
      );
      publications.set(source, { collectionId, publicationId });
    }

    const itemIds = new Map<string, string>();
    const ordered = [...batch.items.entries()].sort(([, left], [, right]) =>
      (left.item_kind === "group" ? 0 : 1) - (right.item_kind === "group" ? 0 : 1));
    ordered.forEach(([position, item]) => {
      const publication = publications.get(item.source);
      if (!publication) throw new Error("missing recurring publication");
      let parentItemId: string | null = null;
      if (item.parent) {
        parentItemId = itemIds.get(`${item.source}\u0000${item.parent}`) ?? null;
        if (!parentItemId) {
          parentItemId = (db.prepare(
            `SELECT i.id
               FROM feedback_items i
               JOIN feedback_collections c ON c.id = i.collection_id
              WHERE c.kind = 'recurring_feed' AND c.source = ?
                AND i.external_key = ? AND i.item_kind = 'group'`,
          ).get(item.source, item.parent) as { id: string } | undefined)?.id ?? null;
        }
        if (!parentItemId) throw new FeedbackStoreError("parent group not found", 400);
      }
      const itemId = ingestRecurringItem(db, batch, item, {
        ...publication,
        now: options.now,
        stale,
        position,
        parentItemId,
      });
      itemIds.set(`${item.source}\u0000${item.candidate_key}`, itemId);
    });
    const result = requestId
      ? summarizeRecurringRequest(db, requestId, batch.items.length)
      : summarizeRecurringBatch(db, batch.batch_key);
    if (requestId) {
      db.prepare("UPDATE feedback_ingest_requests SET result_json = ? WHERE id = ?")
        .run(JSON.stringify(result), requestId);
    }
    return result;
  }).immediate();
}

function validateRecurringBatchGraph(db: Db, batch: BriefingIngestRequest): void {
  const items = new Map<string, BriefingIngestItem>();
  for (const item of batch.items) {
    const key = `${item.source}\u0000${item.candidate_key}`;
    if (items.has(key)) {
      throw new FeedbackStoreError(
        `duplicate candidate_key '${item.candidate_key}' in source '${item.source}'`,
      );
    }
    items.set(key, item);
    const existing = db.prepare(
      `SELECT i.item_kind, i.parent_item_id,
              parent.external_key AS parent_candidate_key
         FROM feedback_items i
         JOIN feedback_collections c ON c.id = i.collection_id
         LEFT JOIN feedback_items parent ON parent.id = i.parent_item_id
        WHERE c.kind = 'recurring_feed' AND c.source = ? AND i.external_key = ?`,
    ).get(item.source, item.candidate_key) as
      {
        item_kind: string;
        parent_item_id: string | null;
        parent_candidate_key: string | null;
      } | undefined;
    const itemKind = item.item_kind ?? "item";
    if (existing && existing.item_kind !== itemKind) {
      throw new FeedbackStoreError(
        `candidate '${item.candidate_key}' cannot change item_kind`,
        409,
      );
    }
    if (itemKind === "group" && existing?.parent_item_id) {
      throw new FeedbackStoreError(`group '${item.candidate_key}' cannot be nested`);
    }
    if (existing && existing.parent_candidate_key !== (item.parent ?? null)) {
      throw new FeedbackStoreError(
        `candidate '${item.candidate_key}' cannot change parent group`,
        409,
      );
    }
  }
  for (const item of batch.items) {
    if (!item.parent) continue;
    const parent = items.get(`${item.source}\u0000${item.parent}`);
    if (parent) {
      if ((parent.item_kind ?? "item") !== "group") {
        throw new FeedbackStoreError(`parent '${item.parent}' must be a group`);
      }
      continue;
    }
    const existing = db.prepare(
      `SELECT i.item_kind, i.parent_item_id
         FROM feedback_items i
         JOIN feedback_collections c ON c.id = i.collection_id
        WHERE c.kind = 'recurring_feed' AND c.source = ? AND i.external_key = ?`,
    ).get(item.source, item.parent) as
      { item_kind: string; parent_item_id: string | null } | undefined;
    if (!existing || existing.item_kind !== "group" || existing.parent_item_id !== null) {
      throw new FeedbackStoreError(
        `parent '${item.parent}' must be a top-level group in source '${item.source}'`,
      );
    }
  }
}

function ingestRecurringItem(
  db: Db,
  batch: BriefingIngestRequest,
  item: BriefingIngestItem,
  context: {
    collectionId: string;
    publicationId: string;
    now: number;
    stale: boolean;
    position: number;
    parentItemId: string | null;
  },
): string {
  let candidate = db.prepare(
    `SELECT id, current_revision_id, created_at
       FROM feedback_items
      WHERE collection_id = ? AND identity_mode = 'publisher_dedup' AND external_key = ?`,
  ).get(context.collectionId, item.candidate_key) as
    | { id: string; current_revision_id: string | null; created_at: number }
    | undefined;
  if (!candidate) {
    const id = randomUUID();
    db.prepare(
      `INSERT INTO feedback_items (
         id, collection_id, parent_item_id, item_kind, identity_mode, external_key,
         client_item_key, current_revision_id, created_at, tombstoned_at
         ) VALUES (?, ?, ?, ?, 'publisher_dedup', ?, NULL, NULL, ?, NULL)`,
    ).run(
      id,
      context.collectionId,
      context.parentItemId,
      item.item_kind ?? "item",
      item.candidate_key,
      context.now,
    );
    candidate = { id, current_revision_id: null, created_at: context.now };
  }

  let revision = db.prepare(
    `SELECT id, ordinal, publication_id
       FROM feedback_item_revisions WHERE item_id = ? AND evidence_digest = ?`,
  ).get(candidate.id, item.evidence_hash) as
    | { id: string; ordinal: number; publication_id: string | null }
    | undefined;
  if (!revision) {
    const ordinal = (db.prepare(
      "SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal FROM feedback_item_revisions WHERE item_id = ?",
    ).get(candidate.id) as { ordinal: number }).ordinal;
    const id = randomUUID();
    db.prepare(
      `INSERT INTO feedback_item_revisions (
         id, item_id, ordinal, title, prompt, description, response_type, required,
         content_json, evidence_digest, publication_id, position, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      candidate.id,
      ordinal,
      item.title,
      item.title,
      item.why_notable ?? null,
      (item.item_kind ?? "item") === "group" ? null : "verdict",
      batch.schema === "briefing-ingest@2"
        ? encodeRecurringRevisionContentV2({
          why_notable: item.why_notable ?? null,
          refs: item.refs ?? [],
          source_ref: item.ref,
          evidence_kind: item.evidence_kind,
          captured_at: item.captured_at ?? null,
          rank: item.rank ?? null,
          publisher_advisory: item.publisher_advisory ?? null,
        })
        : encodeRecurringRevisionContent({
          why_notable: item.why_notable ?? null,
          refs: item.refs ?? [],
          source_ref: item.ref,
          evidence_kind: item.evidence_kind,
          captured_at: item.captured_at ?? null,
          rank: item.rank ?? null,
        }),
      item.evidence_hash,
      context.publicationId,
      Math.max(0, item.rank ?? context.position),
      context.now,
    );
    revision = { id, ordinal, publication_id: context.publicationId };

    const current = candidate.current_revision_id
      ? db.prepare(
        `SELECT p.digest_version
           FROM feedback_item_revisions r
           LEFT JOIN feedback_publications p ON p.id = r.publication_id
          WHERE r.id = ?`,
      ).get(candidate.current_revision_id) as { digest_version: number | null } | undefined
      : undefined;
    const currentVersion = current?.digest_version ?? Number.NEGATIVE_INFINITY;
    if (!candidate.current_revision_id || (!context.stale && batch.digest.version >= currentVersion)) {
      db.prepare("UPDATE feedback_items SET current_revision_id = ? WHERE id = ?")
        .run(id, candidate.id);
    }
  }

  db.prepare(
    `INSERT OR IGNORE INTO feedback_publication_items
       (id, publication_id, item_revision_id, position, seen_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(randomUUID(), context.publicationId, revision.id, context.position, context.now);
  return candidate.id;
}

function summarizeRecurringRequest(
  db: Db,
  requestId: string,
  accepted: number,
): BriefingIngestResult {
  const written = (db.prepare(
    `SELECT COUNT(*) AS n
       FROM feedback_item_revisions r
       JOIN feedback_publications p ON p.id = r.publication_id
      WHERE p.ingest_request_id = ?`,
  ).get(requestId) as { n: number }).n;
  const created = (db.prepare(
    `SELECT COUNT(*) AS n
       FROM feedback_item_revisions r
       JOIN feedback_publications p ON p.id = r.publication_id
      WHERE p.ingest_request_id = ? AND r.ordinal = 1`,
  ).get(requestId) as { n: number }).n;
  return {
    accepted,
    created,
    revised: written - created,
    unchanged: Math.max(0, accepted - written),
  };
}

export function summarizeRecurringBatch(db: Db, batchKey: string): BriefingIngestResult {
  const accepted = (db.prepare(
    `SELECT MAX(p.item_count) AS n
       FROM feedback_publications p
       JOIN feedback_collections c ON c.id = p.collection_id
      WHERE c.kind = 'recurring_feed' AND p.publication_key = ?`,
  ).get(batchKey) as { n: number | null }).n ?? 0;
  const written = (db.prepare(
    `SELECT COUNT(*) AS n
       FROM feedback_item_revisions r
       JOIN feedback_publications p ON p.id = r.publication_id
       JOIN feedback_collections c ON c.id = p.collection_id
      WHERE c.kind = 'recurring_feed' AND p.publication_key = ?`,
  ).get(batchKey) as { n: number }).n;
  const created = (db.prepare(
    `SELECT COUNT(*) AS n
       FROM feedback_item_revisions r
       JOIN feedback_publications p ON p.id = r.publication_id
       JOIN feedback_collections c ON c.id = p.collection_id
      WHERE c.kind = 'recurring_feed' AND p.publication_key = ? AND r.ordinal = 1`,
  ).get(batchKey) as { n: number }).n;
  return {
    accepted,
    created,
    revised: written - created,
    unchanged: Math.max(0, accepted - written),
  };
}

export function getRecurringCandidate(db: Db, candidateId: string): RecurringCandidateRow | null {
  return (db.prepare(
    `SELECT i.id, c.source, i.external_key AS candidate_key,
            i.current_revision_id, i.created_at
      FROM feedback_items i
      JOIN feedback_collections c ON c.id = i.collection_id
      WHERE i.id = ? AND i.item_kind = 'item' AND c.kind = 'recurring_feed'`,
  ).get(candidateId) as RecurringCandidateRow | undefined) ?? null;
}

export function countPendingRecurringItems(db: Db): number {
  return (db.prepare(
    `SELECT COUNT(*) AS n
       FROM feedback_items i
       JOIN feedback_collections c ON c.id = i.collection_id
      WHERE c.kind = 'recurring_feed' AND ${PENDING_PREDICATE}`,
  ).get() as { n: number }).n;
}

export function listRecurringQueue(
  db: Db,
  options: { source?: string; limit?: number; now: number },
): BriefingQueueResponse {
  const params: unknown[] = [];
  let sql = `SELECT i.id, c.source, i.external_key AS candidate_key,
                    i.current_revision_id, i.created_at
               FROM feedback_items i
               JOIN feedback_collections c ON c.id = i.collection_id
              WHERE c.kind = 'recurring_feed' AND ${PENDING_PREDICATE}`;
  if (options.source) {
    sql += " AND c.source = ?";
    params.push(options.source);
  }
  sql += " ORDER BY i.created_at DESC, i.rowid DESC";
  if (options.limit !== undefined) {
    sql += " LIMIT ?";
    params.push(Math.max(0, Math.trunc(options.limit)));
  }
  const rows = db.prepare(sql).all(...params) as RecurringCandidateRow[];
  if (rows.length === 0) {
    return { candidates: [], sources: listRecurringSourceHealth(db, options.now) };
  }

  const itemPlaceholders = rows.map(() => "?").join(", ");
  const revisionIds = rows.map((row) => row.current_revision_id as string);
  const revisionPlaceholders = revisionIds.map(() => "?").join(", ");
  const revisions = db.prepare(
    `SELECT ${revisionSelect("r")}
       FROM feedback_item_revisions r
       LEFT JOIN feedback_publications p ON p.id = r.publication_id
       LEFT JOIN feedback_ingest_requests ir ON ir.id = p.ingest_request_id
      WHERE r.id IN (${revisionPlaceholders})`,
  ).all(...revisionIds) as KernelRevisionRow[];
  const revisionsById = new Map(revisions.map((revision) => [revision.id, revision]));
  const revisionCounts = db.prepare(
    `SELECT item_id, COUNT(*) AS n
       FROM feedback_item_revisions
      WHERE item_id IN (${itemPlaceholders})
      GROUP BY item_id`,
  ).all(...rows.map((row) => row.id)) as Array<{ item_id: string; n: number }>;
  const revisionCountByItem = new Map(revisionCounts.map((row) => [row.item_id, row.n]));
  const occurrenceRows = db.prepare(
    `SELECT item_revision_id, COUNT(*) AS count,
            MIN(seen_at) AS first_seen_at, MAX(seen_at) AS last_seen_at
       FROM feedback_publication_items
      WHERE item_revision_id IN (${revisionPlaceholders})
      GROUP BY item_revision_id`,
  ).all(...revisionIds) as Array<BriefingOccurrenceStats & { item_revision_id: string }>;
  const occurrencesByRevision = new Map(
    occurrenceRows.map((row) => [row.item_revision_id, {
      count: row.count,
      first_seen_at: row.first_seen_at,
      last_seen_at: row.last_seen_at,
    }]),
  );
  const groupRows = db.prepare(
    `SELECT child.id AS child_id, parent.id,
            parent.external_key AS candidate_key, parent_revision.title
       FROM feedback_items child
       JOIN feedback_items parent ON parent.id = child.parent_item_id
       JOIN feedback_item_revisions parent_revision ON parent_revision.id = parent.current_revision_id
      WHERE child.id IN (${itemPlaceholders})`,
  ).all(...rows.map((row) => row.id)) as Array<{
    child_id: string;
    id: string;
    candidate_key: string;
    title: string;
  }>;
  const groupByItem = new Map(groupRows.map((group) => [group.child_id, {
    id: group.id,
    candidate_key: group.candidate_key,
    title: group.title,
  }]));
  const candidates: BriefingQueueEntry[] = rows.map((row) => {
    const revision = revisionsById.get(row.current_revision_id as string);
    if (!revision) throw new Error(`missing current feedback revision for ${row.id}`);
    return {
      id: row.id,
      source: row.source,
      candidate_key: row.candidate_key,
      created_at: row.created_at,
      state: "pending",
      revision: projectRevision(revision),
      revision_count: revisionCountByItem.get(row.id) ?? 0,
      occurrences: occurrencesByRevision.get(revision.id)
        ?? { count: 0, first_seen_at: null, last_seen_at: null },
      task_identity: revision.task_identity,
      group: groupByItem.get(row.id) ?? null,
    };
  });
  return { candidates, sources: listRecurringSourceHealth(db, options.now) };
}

export function listRecurringSourceHealth(db: Db, now: number): BriefingSourceHealth[] {
  const rows = db.prepare(
    `WITH sentinel(source) AS (VALUES (?)),
          item_counts AS (
            SELECT source, COUNT(*) AS candidate_count, SUM(is_pending) AS pending_count
              FROM (
                SELECT c.source AS source,
                       CASE WHEN ${PENDING_PREDICATE} THEN 1 ELSE 0 END AS is_pending
                  FROM feedback_items i
                  JOIN feedback_collections c ON c.id = i.collection_id
                  JOIN sentinel s ON c.source != s.source
                 WHERE c.kind = 'recurring_feed' AND i.item_kind = 'item'
              )
             GROUP BY source
          ),
          normal_task_sources AS (
            SELECT DISTINCT p.task_identity, c.source
              FROM feedback_publications p
              JOIN feedback_collections c ON c.id = p.collection_id
              JOIN sentinel s ON c.source != s.source
             WHERE c.kind = 'recurring_feed' AND p.item_count > 0
          ),
          projected_publications AS (
            SELECT c.source, p.task_identity, p.run_id, p.digest_version,
                   p.item_count, p.received_at, p.rowid AS publication_rowid
              FROM feedback_publications p
              JOIN feedback_collections c ON c.id = p.collection_id
              JOIN sentinel s ON c.source != s.source
             WHERE c.kind = 'recurring_feed'
            UNION ALL
            SELECT nts.source, p.task_identity, p.run_id, p.digest_version,
                   p.item_count, p.received_at, p.rowid AS publication_rowid
              FROM feedback_publications p
              JOIN feedback_collections c ON c.id = p.collection_id
              JOIN sentinel s ON c.source = s.source
              JOIN normal_task_sources nts ON nts.task_identity = p.task_identity
             WHERE c.kind = 'recurring_feed'
            UNION ALL
            SELECT p.task_identity AS source, p.task_identity, p.run_id, p.digest_version,
                   p.item_count, p.received_at, p.rowid AS publication_rowid
              FROM feedback_publications p
              JOIN feedback_collections c ON c.id = p.collection_id
              JOIN sentinel s ON c.source = s.source
             WHERE c.kind = 'recurring_feed'
               AND NOT EXISTS (
                 SELECT 1 FROM normal_task_sources nts
                  WHERE nts.task_identity = p.task_identity
               )
          ),
          latest_publications AS (
            SELECT source, task_identity, run_id, digest_version, item_count, received_at
              FROM (
                SELECT projected_publications.*,
                       ROW_NUMBER() OVER (
                         PARTITION BY source
                         ORDER BY received_at DESC, publication_rowid DESC
                       ) AS recency
                  FROM projected_publications
              )
             WHERE recency = 1
          ),
          reportable_sources AS (
            SELECT source FROM item_counts
            UNION
            SELECT source FROM projected_publications
          )
     SELECT rs.source,
            COALESCE(ic.candidate_count, 0) AS candidate_count,
            COALESCE(ic.pending_count, 0) AS pending_count,
            lp.task_identity, lp.run_id, lp.digest_version, lp.item_count, lp.received_at
       FROM reportable_sources rs
       LEFT JOIN item_counts ic ON ic.source = rs.source
       LEFT JOIN latest_publications lp ON lp.source = rs.source
      ORDER BY rs.source ASC`,
  ).all(EMPTY_BRIEFING_BATCH_SOURCE) as Array<{
    source: string;
    candidate_count: number;
    pending_count: number;
    task_identity: string | null;
    run_id: string | null;
    digest_version: number | null;
    item_count: number | null;
    received_at: number | null;
  }>;
  return rows.map((row) => {
    return {
      source: row.source,
      pending_count: Number(row.pending_count ?? 0),
      candidate_count: Number(row.candidate_count ?? 0),
      last_task_identity: row.task_identity,
      last_run_id: row.run_id,
      last_digest_version: row.digest_version,
      last_ingested_at: row.received_at,
      last_ingest_age_ms: row.received_at === null ? null : Math.max(0, now - row.received_at),
      last_batch_item_count: row.item_count,
    };
  });
}

export function getRecurringCandidateHistory(
  db: Db,
  candidateId: string,
): BriefingCandidateHistoryResponse | null {
  const candidate = getRecurringCandidate(db, candidateId);
  if (!candidate) return null;
  const revisions = (db.prepare(
    `SELECT ${revisionSelect("r")}
       FROM feedback_item_revisions r
       LEFT JOIN feedback_publications p ON p.id = r.publication_id
       LEFT JOIN feedback_ingest_requests ir ON ir.id = p.ingest_request_id
      WHERE r.item_id = ? ORDER BY r.ordinal ASC`,
  ).all(candidateId) as KernelRevisionRow[]).map(projectRevision);
  const decisions = db.prepare(
    `SELECT id, item_id AS candidate_id, item_revision_id AS revision_id,
            action, actor_user_id, NULL AS comment_id, created_at
       FROM (
         SELECT id, item_id, item_revision_id,
                CASE
                  WHEN operation = 'retract' THEN 'undo'
                  WHEN json_extract(value_json, '$.verdict') = 'keep' THEN 'keep'
                  ELSE 'dismiss'
                END AS action,
                actor_user_id, created_at, rowid AS event_rowid, 1 AS response
           FROM feedback_response_events WHERE item_id = ?
         UNION ALL
         SELECT id, item_id, item_revision_id, 'expire', actor_user_id,
                created_at, rowid, 0
           FROM feedback_item_events WHERE item_id = ? AND operation = 'expired'
       )
      ORDER BY created_at ASC, response ASC, event_rowid ASC`,
  ).all(candidateId, candidateId) as BriefingDecisionEvent[];
  const comments = db.prepare(
    `SELECT id, item_id AS candidate_id, item_revision_id AS revision_id,
            body, actor_user_id, created_at
       FROM feedback_comments WHERE item_id = ? ORDER BY created_at ASC, rowid ASC`,
  ).all(candidateId) as BriefingComment[];
  return {
    candidate: {
      ...candidate,
      state: candidate.current_revision_id
        ? recurringCandidateStateFromAction(lastRecurringActionForRevision(db, candidate.current_revision_id))
        : "pending",
    },
    revisions,
    decisions,
    comments,
  };
}

export interface RecurringDecisionInput {
  candidateId: string;
  action: BriefingReviewAction;
  actorUserId: string;
  revisionId?: string;
  expectedEventId?: string;
  now: number;
}

export interface RecurringDecisionOutcome {
  candidate_id: string;
  revision_id: string;
  action: BriefingReviewAction;
  event_id: string;
  state: BriefingCandidateState;
}

export function recordRecurringDecision(
  db: Db,
  input: RecurringDecisionInput,
): RecurringDecisionOutcome {
  return db.transaction(() => {
    const candidate = getRecurringCandidate(db, input.candidateId);
    if (!candidate) throw new FeedbackStoreError("candidate not found", 404);
    if (!candidate.current_revision_id) {
      throw new FeedbackStoreError("candidate has no current revision", 409);
    }
    let revisionId = candidate.current_revision_id;
    if (input.revisionId !== undefined) {
      const owned = db.prepare(
        "SELECT 1 AS ok FROM feedback_item_revisions WHERE id = ? AND item_id = ?",
      ).get(input.revisionId, candidate.id);
      if (!owned) throw new FeedbackStoreError("revision not found for candidate", 404);
      revisionId = input.revisionId;
    }
    const last = lastRecurringEvent(db, revisionId);
    if (input.action === "undo") {
      if (recurringCandidateStateFromAction(last?.action ?? null) === "pending" || !last?.response) {
        throw new FeedbackStoreError("no decision to undo", 409);
      }
      if (input.expectedEventId !== undefined && last.id !== input.expectedEventId) {
        throw new FeedbackStoreError("decision changed since it was read", 409);
      }
    }
    const eventId = randomUUID();
    const collectionId = (db.prepare(
      "SELECT collection_id FROM feedback_items WHERE id = ?",
    ).get(candidate.id) as { collection_id: string }).collection_id;
    if (input.action === "undo") {
      db.prepare(
        `INSERT INTO feedback_response_events (
           id, collection_id, item_id, item_revision_id, operation, value_json,
           retracts_event_id, actor_user_id, created_at
         ) VALUES (?, ?, ?, ?, 'retract', NULL, ?, ?, ?)`,
      ).run(eventId, collectionId, candidate.id, revisionId, last?.id, input.actorUserId, input.now);
    } else {
      db.prepare(
        `INSERT INTO feedback_response_events (
           id, collection_id, item_id, item_revision_id, operation, value_json,
           retracts_event_id, actor_user_id, created_at
         ) VALUES (?, ?, ?, ?, 'set', ?, NULL, ?, ?)`,
      ).run(
        eventId,
        collectionId,
        candidate.id,
        revisionId,
        JSON.stringify({ verdict: input.action }),
        input.actorUserId,
        input.now,
      );
    }
    return {
      candidate_id: candidate.id,
      revision_id: revisionId,
      action: input.action,
      event_id: eventId,
      state: recurringCandidateStateFromAction(
        lastRecurringActionForRevision(db, candidate.current_revision_id),
      ),
    };
  })();
}

export function addRecurringComment(
  db: Db,
  input: { candidateId: string; body: string; actorUserId: string; revisionId?: string; now: number },
): BriefingComment {
  const body = input.body.trim();
  if (!body) throw new FeedbackStoreError("body is required");
  const candidate = getRecurringCandidate(db, input.candidateId);
  if (!candidate) throw new FeedbackStoreError("candidate not found", 404);
  if (!candidate.current_revision_id) {
    throw new FeedbackStoreError("candidate has no current revision", 409);
  }
  let revisionId = candidate.current_revision_id;
  if (input.revisionId !== undefined) {
    const owned = db.prepare(
      "SELECT 1 AS ok FROM feedback_item_revisions WHERE id = ? AND item_id = ?",
    ).get(input.revisionId, candidate.id);
    if (!owned) throw new FeedbackStoreError("revision not found for candidate", 404);
    revisionId = input.revisionId;
  }
  const collectionId = (db.prepare(
    "SELECT collection_id FROM feedback_items WHERE id = ?",
  ).get(candidate.id) as { collection_id: string }).collection_id;
  const id = randomUUID();
  db.prepare(
    `INSERT INTO feedback_comments
       (id, collection_id, item_id, item_revision_id, body, actor_user_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, collectionId, candidate.id, revisionId, body, input.actorUserId, input.now);
  return {
    id,
    candidate_id: candidate.id,
    revision_id: revisionId,
    body,
    actor_user_id: input.actorUserId,
    created_at: input.now,
  };
}

export function sweepExpiredRecurringItems(
  db: Db,
  options: { now: number; expiryMs?: number },
): { expired: number; candidate_ids: string[] } {
  return db.transaction(() => {
    const params: unknown[] = [options.now];
    const explicitExpiry = options.expiryMs !== undefined;
    if (explicitExpiry) params.push(options.expiryMs);
    const rows = db.prepare(
      `SELECT i.id, i.current_revision_id AS revision_id
         FROM feedback_items i
         JOIN feedback_collections c ON c.id = i.collection_id
         JOIN feedback_recurring_profiles profile ON profile.collection_id = c.id
         JOIN feedback_item_revisions r ON r.id = i.current_revision_id
        WHERE c.kind = 'recurring_feed' AND ${PENDING_PREDICATE}
          AND COALESCE(
            (SELECT MAX(pi.seen_at) FROM feedback_publication_items pi
              WHERE pi.item_revision_id = r.id),
            r.created_at
          ) < (? - ${explicitExpiry ? "?" : "profile.item_expiry_ms"})`,
    ).all(...params) as Array<{ id: string; revision_id: string }>;
    const insert = db.prepare(
      `INSERT INTO feedback_item_events
         (id, item_id, item_revision_id, operation, actor_user_id, created_at)
       VALUES (?, ?, ?, 'expired', NULL, ?)`,
    );
    for (const row of rows) insert.run(randomUUID(), row.id, row.revision_id, options.now);
    return { expired: rows.length, candidate_ids: rows.map((row) => row.id) };
  })();
}

export function recurringStoreAvailable(db: Db): boolean {
  const required = ["feedback_collections", "feedback_items", "feedback_item_revisions"];
  return required.every((name) => !!db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(name));
}

export function getRecurringRevision(db: Db, revisionId: string): BriefingRevision | null {
  if (!recurringStoreAvailable(db)) return null;
  const row = db.prepare(
    `SELECT ${revisionSelect("r")}
       FROM feedback_item_revisions r
       LEFT JOIN feedback_publications p ON p.id = r.publication_id
       LEFT JOIN feedback_ingest_requests ir ON ir.id = p.ingest_request_id
       JOIN feedback_items i ON i.id = r.item_id
       JOIN feedback_collections c ON c.id = i.collection_id
      WHERE r.id = ? AND c.kind = 'recurring_feed'`,
  ).get(revisionId) as KernelRevisionRow | undefined;
  return row ? projectRevision(row) : null;
}
