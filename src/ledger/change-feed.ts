import { createHash } from "node:crypto";
import { CURRENT_SCHEMA_VERSION, type Db } from "../db.js";
import { parseJsonObject } from "../row-coerce.js";
import { requestOriginFromMetadata } from "../request-origin.js";

export const LEDGER_CHANGE_FEED_SCHEMA = "mandible-ledger-change-feed@1";
export const DEFAULT_LEDGER_CHANGE_LIMIT = 100;
export const MAX_LEDGER_CHANGE_LIMIT = 200;

interface CursorPayload {
  v: 1;
  p: string;
  a: number;
  h: number | null;
}

interface ChangeRow {
  sequence: number;
  event_id: string;
  recorded_at: number;
  entity_type: string;
  entity_id: string;
  event_type: string;
  actor_id: string | null;
  actor_type: string;
  actor_user_id: string | null;
  evidence_method: string | null;
  evidence_id: string | null;
  source: string;
  payload_json: string;
  occurred_at: number;
  observed_at: number;
}

export class LedgerChangeFeedError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
    readonly resyncRequired = true,
  ) {
    super(message);
    this.name = "LedgerChangeFeedError";
  }
}

function checksum(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function encodeCursor(payload: CursorPayload): string {
  const json = JSON.stringify(payload);
  return `${Buffer.from(json).toString("base64url")}.${checksum(json)}`;
}

function decodeCursor(cursor: string, projectId: string): CursorPayload {
  const [encoded, claimedChecksum, extra] = cursor.split(".");
  if (!encoded || !claimedChecksum || extra !== undefined) {
    throw new LedgerChangeFeedError("invalid_cursor", "The change-feed cursor is malformed.", 400);
  }
  let json: string;
  let value: unknown;
  try {
    json = Buffer.from(encoded, "base64url").toString("utf8");
    value = JSON.parse(json);
  } catch {
    throw new LedgerChangeFeedError("invalid_cursor", "The change-feed cursor is not valid JSON.", 400);
  }
  if (checksum(json) !== claimedChecksum) {
    throw new LedgerChangeFeedError("invalid_cursor", "The change-feed cursor checksum does not match.", 400);
  }
  const row = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  if (row.v !== 1) {
    throw new LedgerChangeFeedError("unsupported_cursor_version", "The change-feed cursor version is unsupported.", 400);
  }
  if (row.p !== projectId) {
    throw new LedgerChangeFeedError("cursor_project_mismatch", "The cursor belongs to a different project.", 409);
  }
  if (!Number.isSafeInteger(row.a) || (row.a as number) < 0) {
    throw new LedgerChangeFeedError("invalid_cursor", "The cursor position is invalid.", 400);
  }
  if (row.h !== null && (!Number.isSafeInteger(row.h) || (row.h as number) < 0)) {
    throw new LedgerChangeFeedError("invalid_cursor", "The cursor high-water mark is invalid.", 400);
  }
  if (row.h !== null && (row.a as number) > (row.h as number)) {
    throw new LedgerChangeFeedError("inconsistent_cursor", "The cursor position exceeds its high-water mark.");
  }
  return row as unknown as CursorPayload;
}

const REFERENCE_KEYS = new Set([
  "action_id", "active", "branch", "changed_fields", "commit_sha", "deleted_at",
  "label", "link_type", "previous_role", "relationship_type", "resolution", "role", "status",
]);

function referenceProjection(payloadJson: string): Record<string, unknown> {
  const payload = parseJsonObject(payloadJson);
  const references: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === "event_nonce") continue;
    if (!REFERENCE_KEYS.has(key) && !key.endsWith("_id") && !key.endsWith("_ids")
      && !key.endsWith("_ref") && !key.endsWith("_refs")) continue;
    if (typeof value === "string") {
      if (value.length > 512) {
        throw new LedgerChangeFeedError(
          "reference_projection_too_large",
          `Event reference '${key}' exceeds the bounded feed contract.`,
        );
      }
      references[key] = value;
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean" || value === null) {
      references[key] = value;
      continue;
    }
    if (Array.isArray(value) && value.length <= 100
      && value.every((entry) => typeof entry === "string" && entry.length <= 512)) {
      references[key] = value;
    }
  }
  return references;
}

function schemaVersion(db: Db): number {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;
  const version = Number(row?.value);
  if (!Number.isSafeInteger(version) || version !== CURRENT_SCHEMA_VERSION) {
    throw new LedgerChangeFeedError(
      "database_schema_mismatch",
      `The ledger schema is v${row?.value ?? "unknown"}; this feed requires v${CURRENT_SCHEMA_VERSION}.`,
      409,
    );
  }
  return version;
}

export function readLedgerChangeFeed(db: Db, input: {
  project_id: string;
  project_key: string;
  cursor?: string;
  limit?: number;
  schema?: string;
}): Record<string, unknown> {
  const requestedSchema = input.schema ?? LEDGER_CHANGE_FEED_SCHEMA;
  if (requestedSchema !== LEDGER_CHANGE_FEED_SCHEMA) {
    throw new LedgerChangeFeedError(
      "unsupported_feed_schema",
      `Unsupported feed schema '${requestedSchema}'.`,
      400,
    );
  }
  const limit = input.limit ?? DEFAULT_LEDGER_CHANGE_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LEDGER_CHANGE_LIMIT) {
    throw new LedgerChangeFeedError(
      "invalid_limit",
      `limit must be an integer from 1 through ${MAX_LEDGER_CHANGE_LIMIT}.`,
      400,
      false,
    );
  }
  const databaseSchemaVersion = schemaVersion(db);
  const state = db.prepare(
    `SELECT next_sequence, retained_from_sequence
       FROM ledger_change_feed_state WHERE project_id = ?`,
  ).get(input.project_id) as { next_sequence: number; retained_from_sequence: number } | undefined;
  const currentHighWater = (state?.next_sequence ?? 1) - 1;
  const retainedFrom = state?.retained_from_sequence ?? 1;

  if (!input.cursor) {
    const nextCursor = encodeCursor({ v: 1, p: input.project_id, a: currentHighWater, h: null });
    return {
      schema: LEDGER_CHANGE_FEED_SCHEMA,
      database_schema_version: databaseSchemaVersion,
      project: { id: input.project_id, key: input.project_key },
      changes: [],
      page: { limit, count: 0, has_more: false },
      high_water_mark: currentHighWater,
      next_cursor: nextCursor,
      resync: { established: true, retained_from_sequence: retainedFrom },
    };
  }

  const cursor = decodeCursor(input.cursor, input.project_id);
  if (cursor.a < retainedFrom - 1) {
    throw new LedgerChangeFeedError(
      "retention_gap",
      `Cursor ${cursor.a} precedes retained sequence ${retainedFrom}.`,
    );
  }
  if (cursor.a > currentHighWater || (cursor.h !== null && cursor.h > currentHighWater)) {
    throw new LedgerChangeFeedError(
      "inconsistent_cursor",
      "The cursor refers to a sequence beyond this ledger's high-water mark.",
    );
  }
  const highWater = cursor.h ?? currentHighWater;
  const expectedCount = Math.min(limit, highWater - cursor.a);
  const rows = db.prepare(
    `SELECT l.sequence, l.event_id, l.recorded_at,
            e.entity_type, e.entity_id, e.event_type,
            e.actor_id, e.actor_type, e.actor_user_id, e.evidence_method, e.evidence_id,
            e.source, e.payload_json, e.occurred_at, e.observed_at
       FROM ledger_change_log l
       JOIN ledger_events e ON e.id = l.event_id
      WHERE l.project_id = ? AND l.sequence > ? AND l.sequence <= ?
      ORDER BY l.sequence
      LIMIT ?`,
  ).all(input.project_id, cursor.a, highWater, limit) as ChangeRow[];
  if (rows.length !== expectedCount
    || (rows.length > 0 && rows[0].sequence !== cursor.a + 1)
    || rows.some((row, index) => row.sequence !== cursor.a + index + 1)) {
    throw new LedgerChangeFeedError(
      "truncated_change_log",
      "The retained change log is not contiguous at this cursor.",
    );
  }
  const lastSequence = rows.at(-1)?.sequence ?? cursor.a;
  const hasMore = lastSequence < highWater;
  const nextCursor = encodeCursor({
    v: 1,
    p: input.project_id,
    a: hasMore ? lastSequence : highWater,
    h: hasMore ? highWater : null,
  });
  return {
    schema: LEDGER_CHANGE_FEED_SCHEMA,
    database_schema_version: databaseSchemaVersion,
    project: { id: input.project_id, key: input.project_key },
    changes: rows.map((row) => ({
      sequence: row.sequence,
      event_id: row.event_id,
      event_type: row.event_type,
      entity: { type: row.entity_type, id: row.entity_id },
      source: row.source,
      occurred_at: row.occurred_at,
      observed_at: row.observed_at,
      recorded_at: row.recorded_at,
      request_origin: requestOriginFromMetadata(parseJsonObject(row.payload_json)),
      evidence: {
        actor_id: row.actor_id,
        actor_type: row.actor_type,
        actor_user_id: row.actor_user_id,
        method: row.evidence_method,
        evidence_id: row.evidence_id,
      },
      references: referenceProjection(row.payload_json),
    })),
    page: { limit, count: rows.length, has_more: hasMore },
    high_water_mark: highWater,
    next_cursor: nextCursor,
    resync: { established: false, retained_from_sequence: retainedFrom },
  };
}
