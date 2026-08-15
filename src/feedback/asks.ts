import { createHash, randomUUID } from "node:crypto";

import {
  MANDIBLE_ASK_RESULT_SCHEMA,
  type FeedbackResponseType,
  type FeedbackResponseValue,
  type MandibleAskResult,
} from "../contracts.js";
import type { Db } from "../db.js";
import { evaluateGlobalCapability } from "../permissions/store.js";

export interface AskCreateItem {
  client_item_key: string;
  item_kind: "item" | "group";
  parent_client_item_key?: string | null;
  title: string;
  prompt: string;
  description?: string | null;
  response_type?: FeedbackResponseType | null;
  required?: boolean;
  options?: Array<{ option_key: string; label: string; description?: string | null }>;
}

export interface AskCreatePacket {
  request_key: string;
  session_id: string;
  responder_user_ids: string[];
  expires_at: number;
  retention_expires_at?: number | null;
  items: AskCreateItem[];
}

export interface AskCreationResult {
  ask_id: string;
  request_digest: string;
  replay: boolean;
  dashboard_url: string;
  created_at: number;
  requester_user_id: string;
  requester_session_id: string;
}

export interface AskLifecycleTransition {
  ask_id: string;
  state: "expired" | "cancelled";
  requester_user_id: string;
  requester_session_id: string;
  lifecycle_event_id: string;
  created_at: number;
}

export class AskStoreError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
    public readonly code = "invalid_ask",
  ) {
    super(message);
    this.name = "AskStoreError";
  }
}

type NormalizedItem = {
  client_item_key: string;
  item_kind: "item" | "group";
  parent_client_item_key: string | null;
  title: string;
  prompt: string;
  description: string | null;
  response_type: FeedbackResponseType | null;
  required: boolean;
  options: Array<{ option_key: string; label: string; description: string | null }>;
};

type NormalizedPacket = {
  request_key: string;
  session_id: string;
  responder_user_ids: string[];
  expires_at: number;
  retention_expires_at: number | null;
  items: NormalizedItem[];
};

type AskRow = {
  collection_id: string;
  requester_user_id: string;
  requester_session_id: string;
  request_key: string;
  request_digest: string;
  responder_user_ids_json: string;
  expires_at: number | null;
  retention_expires_at: number | null;
  created_at: number;
};

type LifecycleRow = {
  id: string;
  operation: "opened" | "submitted" | "expired" | "cancelled" | "closed";
  actor_user_id: string | null;
  created_at: number;
};

const RESPONSE_TYPES = new Set<FeedbackResponseType>([
  "verdict", "free_text", "single_choice", "multi_choice",
]);

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AskStoreError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonblank(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new AskStoreError(`${label} must be a nonblank string`);
  }
  return value;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") throw new AskStoreError(`${label} must be a string`);
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new AskStoreError(`${label} must be a string or null`);
  return value;
}

function assertOnlyKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unexpected = Object.keys(record).find((key) => !allowed.includes(key));
  if (unexpected) throw new AskStoreError(`${label} contains unsupported field '${unexpected}'`);
}

function normalizePacket(value: unknown, createdAt: number | null): NormalizedPacket {
  const packet = plainRecord(value, "ask packet");
  assertOnlyKeys(packet, [
    "request_key", "session_id", "responder_user_ids", "expires_at",
    "retention_expires_at", "items",
  ], "ask packet");
  const requestKey = nonblank(packet.request_key, "request_key");
  const sessionId = nonblank(packet.session_id, "session_id");
  if (!Array.isArray(packet.responder_user_ids) || packet.responder_user_ids.length === 0) {
    throw new AskStoreError("responder_user_ids must be a nonempty array");
  }
  const responders = packet.responder_user_ids.map((id, i) => nonblank(id, `responder_user_ids[${i}]`));
  if (new Set(responders).size !== responders.length) {
    throw new AskStoreError("responder_user_ids must be unique");
  }
  if (!Number.isSafeInteger(packet.expires_at)
      || (createdAt !== null && Number(packet.expires_at) <= createdAt)) {
    throw new AskStoreError("expires_at must be an integer greater than created_at");
  }
  const retention = packet.retention_expires_at ?? null;
  if (retention !== null && (!Number.isSafeInteger(retention) || Number(retention) < Number(packet.expires_at))) {
    throw new AskStoreError("retention_expires_at must be null or at least expires_at");
  }
  if (!Array.isArray(packet.items)) throw new AskStoreError("items must be an array");
  const keys = new Set<string>();
  const items = packet.items.map((raw, index): NormalizedItem => {
    const item = plainRecord(raw, `items[${index}]`);
    assertOnlyKeys(item, [
      "client_item_key", "item_kind", "parent_client_item_key", "title", "prompt",
      "description", "response_type", "required", "options",
    ], `items[${index}]`);
    const clientKey = nonblank(item.client_item_key, `items[${index}].client_item_key`);
    if (keys.has(clientKey)) throw new AskStoreError("item client keys must be unique");
    keys.add(clientKey);
    if (item.item_kind !== "item" && item.item_kind !== "group") {
      throw new AskStoreError(`items[${index}].item_kind must be item or group`);
    }
    const parentKey = item.parent_client_item_key === undefined || item.parent_client_item_key === null
      ? null : nonblank(item.parent_client_item_key, `items[${index}].parent_client_item_key`);
    const title = stringValue(item.title, `items[${index}].title`);
    const prompt = stringValue(item.prompt, `items[${index}].prompt`);
    const description = nullableString(item.description, `items[${index}].description`);
    const required = item.required === undefined ? false : item.required;
    if (typeof required !== "boolean") throw new AskStoreError(`items[${index}].required must be boolean`);
    const responseType = item.response_type === undefined ? null : item.response_type;
    const rawOptions = item.options === undefined ? [] : item.options;
    if (!Array.isArray(rawOptions)) throw new AskStoreError(`items[${index}].options must be an array`);
    const optionKeys = new Set<string>();
    const options = rawOptions.map((rawOption, optionIndex) => {
      const option = plainRecord(rawOption, `items[${index}].options[${optionIndex}]`);
      assertOnlyKeys(option, ["option_key", "label", "description"], `items[${index}].options[${optionIndex}]`);
      const optionKey = nonblank(option.option_key, `items[${index}].options[${optionIndex}].option_key`);
      if (optionKeys.has(optionKey)) throw new AskStoreError("choice option keys must be unique per item");
      optionKeys.add(optionKey);
      return {
        option_key: optionKey,
        label: stringValue(option.label, `items[${index}].options[${optionIndex}].label`),
        description: nullableString(option.description, `items[${index}].options[${optionIndex}].description`),
      };
    });
    if (item.item_kind === "group") {
      if (responseType !== null || required || options.length > 0) {
        throw new AskStoreError("groups must have null response_type, required false, and no options");
      }
    } else {
      if (typeof responseType !== "string" || !RESPONSE_TYPES.has(responseType as FeedbackResponseType)) {
        throw new AskStoreError("leaf items require a supported response_type");
      }
      const choice = responseType === "single_choice" || responseType === "multi_choice";
      if (choice && options.length === 0) throw new AskStoreError("choice items require options");
      if (!choice && options.length > 0) throw new AskStoreError("non-choice items reject options");
    }
    return {
      client_item_key: clientKey,
      item_kind: item.item_kind,
      parent_client_item_key: parentKey,
      title,
      prompt,
      description,
      response_type: responseType as FeedbackResponseType | null,
      required,
      options,
    };
  });
  const byKey = new Map(items.map((item) => [item.client_item_key, item]));
  for (const item of items) {
    if (item.parent_client_item_key && !byKey.has(item.parent_client_item_key)) {
      throw new AskStoreError(`parent key '${item.parent_client_item_key}' is not in this ask`);
    }
    if (item.parent_client_item_key === item.client_item_key) throw new AskStoreError("items cannot parent themselves");
    const seen = new Set<string>([item.client_item_key]);
    let parent = item.parent_client_item_key;
    while (parent) {
      if (seen.has(parent)) throw new AskStoreError("item parent relationships must be acyclic");
      seen.add(parent);
      parent = byKey.get(parent)?.parent_client_item_key ?? null;
    }
  }
  return {
    request_key: requestKey,
    session_id: sessionId,
    responder_user_ids: [...responders].sort(),
    expires_at: Number(packet.expires_at),
    retention_expires_at: retention === null ? null : Number(retention),
    items,
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

export function askRequestDigest(packet: AskCreatePacket, createdAt: number | null = null): string {
  const normalized = normalizePacket(packet, createdAt);
  return createHash("sha256").update(canonicalJson(normalized)).digest("hex");
}

function requireAskCreator(db: Db, requesterUserId: string): void {
  const user = db.prepare("SELECT id, slug, kind, status FROM users WHERE id = ?").get(requesterUserId) as
    | { id: string; slug: string; kind: string; status: string }
    | undefined;
  if (!user || user.status !== "active" || user.kind !== "agent") {
    throw new AskStoreError("Ask creation requires an active agent credential.", 403, "active_agent_required");
  }
  const decision = evaluateGlobalCapability(db, {
    identity: { user_id: user.id, slug: user.slug, method: "api_token", credential_id: null, source: "in_process" },
    capability: "ask.create",
  });
  if (!decision.allowed || decision.reason === "operator_implicit_admin") {
    throw new AskStoreError("Global capability 'ask.create' is required.", 403, "global_capability_required");
  }
}

function requireRequesterSession(db: Db, sessionId: string, requesterUserId: string): void {
  const row = db.prepare(
    "SELECT status, owner_user_id, identity_mismatch_at FROM sessions WHERE id = ?",
  ).get(sessionId) as { status: string; owner_user_id: string | null; identity_mismatch_at: number | null } | undefined;
  if (!row || row.status !== "active" || row.owner_user_id !== requesterUserId || row.identity_mismatch_at !== null) {
    throw new AskStoreError(
      "session_id must be an active, identity-consistent session owned by the requester",
      403,
      "requester_session_invalid",
    );
  }
}

function requireResponders(db: Db, responderIds: readonly string[]): void {
  const statement = db.prepare("SELECT kind, status FROM users WHERE id = ?");
  for (const id of responderIds) {
    const user = statement.get(id) as { kind: string; status: string } | undefined;
    if (!user || user.kind !== "human" || user.status !== "active") {
      throw new AskStoreError("responders must identify active human users", 400, "invalid_responder");
    }
  }
}

export function createAsk(
  db: Db,
  packetValue: unknown,
  options: { requesterUserId: string; now?: number },
): AskCreationResult {
  const now = options.now ?? Date.now();
  const packet = normalizePacket(packetValue, null);
  requireAskCreator(db, options.requesterUserId);
  const requestDigest = createHash("sha256").update(canonicalJson(packet)).digest("hex");
  const transaction = db.transaction(() => {
    const existing = db.prepare(
      `SELECT * FROM feedback_ask_sessions
        WHERE requester_user_id = ? AND requester_session_id = ? AND request_key = ?`,
    ).get(options.requesterUserId, packet.session_id, packet.request_key) as AskRow | undefined;
    if (existing) {
      if (existing.request_digest !== requestDigest) {
        throw new AskStoreError("request_key was already used with a different packet", 409, "ask_request_conflict");
      }
      return creationProjection(existing, true);
    }
    if (packet.expires_at <= now) {
      throw new AskStoreError("expires_at must be an integer greater than created_at");
    }
    requireRequesterSession(db, packet.session_id, options.requesterUserId);
    requireResponders(db, packet.responder_user_ids);
    const askId = randomUUID();
    db.prepare(
      `INSERT INTO feedback_collections
         (id, kind, interaction_mode, source, expires_at, created_at, tombstoned_at)
       VALUES (?, 'bounded_ask', 'explicit_submit', NULL, NULL, ?, NULL)`,
    ).run(askId, now);
    db.prepare(
      `INSERT INTO feedback_ask_sessions
         (collection_id, requester_user_id, requester_session_id, request_key, request_digest,
          responder_user_ids_json, expires_at, retention_expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      askId, options.requesterUserId, packet.session_id, packet.request_key, requestDigest,
      JSON.stringify(packet.responder_user_ids), packet.expires_at, packet.retention_expires_at, now,
    );
    const itemIds = new Map<string, string>();
    const revisionIds = new Map<string, string>();
    packet.items.forEach((item) => {
      const itemId = randomUUID();
      itemIds.set(item.client_item_key, itemId);
      db.prepare(
        `INSERT INTO feedback_items
           (id, collection_id, parent_item_id, item_kind, identity_mode, external_key,
            client_item_key, current_revision_id, created_at, tombstoned_at)
         VALUES (?, ?, NULL, ?, 'opaque', NULL, ?, NULL, ?, NULL)`,
      ).run(itemId, askId, item.item_kind, item.client_item_key, now);
    });
    packet.items.forEach((item, position) => {
      const itemId = itemIds.get(item.client_item_key)!;
      const revisionId = randomUUID();
      revisionIds.set(item.client_item_key, revisionId);
      db.prepare(
        `INSERT INTO feedback_item_revisions
           (id, item_id, ordinal, title, prompt, description, response_type, required,
            content_json, evidence_digest, publication_id, position, created_at)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?, '{}', NULL, NULL, ?, ?)`,
      ).run(
        revisionId, itemId, item.title, item.prompt, item.description, item.response_type,
        item.required ? 1 : 0, position, now,
      );
      item.options.forEach((option, optionPosition) => {
        db.prepare(
          `INSERT INTO feedback_item_options
             (revision_id, option_key, label, description, position) VALUES (?, ?, ?, ?, ?)`,
        ).run(revisionId, option.option_key, option.label, option.description, optionPosition);
      });
    });
    packet.items.forEach((item) => {
      db.prepare("UPDATE feedback_items SET parent_item_id = ?, current_revision_id = ? WHERE id = ?")
        .run(
          item.parent_client_item_key ? itemIds.get(item.parent_client_item_key)! : null,
          revisionIds.get(item.client_item_key)!,
          itemIds.get(item.client_item_key)!,
        );
    });
    db.prepare(
      `INSERT INTO feedback_collection_events
         (id, collection_id, operation, previous_event_id, actor_user_id, metadata_json, created_at)
       VALUES (?, ?, 'opened', NULL, ?, '{}', ?)`,
    ).run(randomUUID(), askId, options.requesterUserId, now);
    return creationProjection({
      collection_id: askId,
      requester_user_id: options.requesterUserId,
      requester_session_id: packet.session_id,
      request_key: packet.request_key,
      request_digest: requestDigest,
      responder_user_ids_json: JSON.stringify(packet.responder_user_ids),
      expires_at: packet.expires_at,
      retention_expires_at: packet.retention_expires_at,
      created_at: now,
    }, false);
  });
  return transaction.immediate();
}

function creationProjection(row: AskRow, replay: boolean): AskCreationResult {
  return {
    ask_id: row.collection_id,
    request_digest: row.request_digest,
    replay,
    dashboard_url: `/#/briefing?collection=${encodeURIComponent(row.collection_id)}&sidebar=hidden&agent_session=${encodeURIComponent(row.requester_session_id)}`,
    created_at: row.created_at,
    requester_user_id: row.requester_user_id,
    requester_session_id: row.requester_session_id,
  };
}

function getAskRow(db: Db, askId: string): AskRow | null {
  return (db.prepare(
    `SELECT a.collection_id, a.requester_user_id, a.requester_session_id,
            a.request_key, a.request_digest, a.responder_user_ids_json,
            a.expires_at, a.retention_expires_at, a.created_at
       FROM feedback_ask_sessions a
      JOIN feedback_collections c ON c.id = a.collection_id
     WHERE a.collection_id = ? AND c.kind = 'bounded_ask'`,
  ).get(askId) as AskRow | undefined) ?? null;
}

function lifecycleHead(db: Db, askId: string): LifecycleRow {
  const row = db.prepare(
    `SELECT e.id, e.operation, e.actor_user_id, e.created_at
       FROM feedback_collection_events e
      WHERE e.collection_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM feedback_collection_events successor
           WHERE successor.collection_id = e.collection_id AND successor.previous_event_id = e.id
        )
      LIMIT 1`,
  ).get(askId) as LifecycleRow | undefined;
  if (!row) throw new AskStoreError("ask lifecycle is invalid", 409, "ask_lifecycle_invalid");
  return row;
}

function lifecycleState(operation: LifecycleRow["operation"]): MandibleAskResult["state"] {
  if (operation === "opened") return "open";
  if (operation === "submitted") return "submitted";
  if (operation === "expired") return "expired";
  if (operation === "cancelled") return "cancelled";
  throw new AskStoreError("ask lifecycle is invalid", 409, "ask_lifecycle_invalid");
}

function materializeExpiryInTransaction(db: Db, ask: AskRow, now: number): AskLifecycleTransition | null {
  const head = lifecycleHead(db, ask.collection_id);
  if (head.operation !== "opened" || ask.expires_at === null || now < ask.expires_at) return null;
  const eventId = randomUUID();
  db.prepare(
    `INSERT INTO feedback_collection_events
       (id, collection_id, operation, previous_event_id, actor_user_id, metadata_json, created_at)
     VALUES (?, ?, 'expired', ?, NULL, '{}', ?)`,
  ).run(eventId, ask.collection_id, head.id, now);
  return {
    ask_id: ask.collection_id,
    state: "expired",
    requester_user_id: ask.requester_user_id,
    requester_session_id: ask.requester_session_id,
    lifecycle_event_id: eventId,
    created_at: now,
  };
}

export function observeAsk(
  db: Db,
  askId: string,
  now = Date.now(),
): { result: MandibleAskResult; transition: AskLifecycleTransition | null } | null {
  const transaction = db.transaction(() => {
    const ask = getAskRow(db, askId);
    if (!ask) return null;
    const transition = materializeExpiryInTransaction(db, ask, now);
    return { result: buildResult(db, ask, lifecycleHead(db, askId)), transition };
  });
  return transaction.immediate();
}

function parseResponseValue(json: string): FeedbackResponseValue {
  return JSON.parse(json) as FeedbackResponseValue;
}

function buildResult(db: Db, ask: AskRow, head: LifecycleRow): MandibleAskResult {
  const submission = db.prepare(
    `SELECT id, ordinal, supersedes_submission_id, lifecycle_event_id, actor_user_id, created_at
       FROM feedback_submissions WHERE collection_id = ? ORDER BY ordinal DESC LIMIT 1`,
  ).get(ask.collection_id) as {
    id: string; ordinal: number; supersedes_submission_id: string | null;
    lifecycle_event_id: string; actor_user_id: string; created_at: number;
  } | undefined;
  return {
    schema: MANDIBLE_ASK_RESULT_SCHEMA,
    ask_id: ask.collection_id,
    state: lifecycleState(head.operation),
    request_digest: ask.request_digest,
    expires_at: ask.expires_at,
    submission: submission ? {
      ...submission,
      answers: (db.prepare(
        `SELECT sa.item_id, i.client_item_key, sa.item_revision_id, sa.response_event_id,
                r.response_type, e.value_json, e.actor_user_id
           FROM feedback_submission_answers sa
           JOIN feedback_items i ON i.id = sa.item_id
           JOIN feedback_item_revisions r ON r.id = sa.item_revision_id
           JOIN feedback_response_events e ON e.id = sa.response_event_id
          WHERE sa.submission_id = ? ORDER BY sa.position, sa.rowid`,
      ).all(submission.id) as Array<{
        item_id: string; client_item_key: string | null; item_revision_id: string;
        response_event_id: string; response_type: FeedbackResponseType;
        value_json: string; actor_user_id: string;
      }>).map(({ value_json, ...answer }) => ({ ...answer, value: parseResponseValue(value_json) })),
    } : null,
  };
}

export type AskReadProjection = {
  ask_id: string;
  state: MandibleAskResult["state"];
  request_key: string;
  request_digest: string;
  requester_user_id: string;
  requester_session_id: string;
  responder_user_ids: string[];
  expires_at: number | null;
  retention_expires_at: number | null;
  created_at: number;
  lifecycle_event_id: string;
  latest_submission: null | {
    id: string;
    ordinal: number;
  };
  lifecycle: {
    id: string;
    operation: "opened" | "submitted" | "expired" | "cancelled" | "closed";
    actor_user_id: string | null;
    created_at: number;
  };
  items: Array<{
    id: string;
    client_item_key: string | null;
    parent_item_id: string | null;
    item_kind: "item" | "group";
    revision: {
      id: string; ordinal: number; title: string; prompt: string; description: string | null;
      response_type: FeedbackResponseType | null; required: boolean; position: number;
      options: Array<{ option_key: string; label: string; description: string | null; position: number }>;
    };
    effective_response?: null | { response_event_id: string; value: FeedbackResponseValue };
  }>;
};

export function readAsk(
  db: Db,
  askId: string,
  options: { answerActorUserId?: string; now?: number } = {},
): { ask: AskReadProjection; transition: AskLifecycleTransition | null } | null {
  const now = options.now ?? Date.now();
  const transaction = db.transaction(() => {
    const ask = getAskRow(db, askId);
    if (!ask) return null;
    const transition = materializeExpiryInTransaction(db, ask, now);
    const head = lifecycleHead(db, askId);
    const latestSubmission = db.prepare(
      `SELECT id, ordinal
         FROM feedback_submissions
        WHERE collection_id = ?
        ORDER BY ordinal DESC
        LIMIT 1`,
    ).get(askId) as { id: string; ordinal: number } | undefined;
    const rows = db.prepare(
      `SELECT i.id, i.client_item_key, i.parent_item_id, i.item_kind,
              r.id AS revision_id, r.ordinal, r.title, r.prompt, r.description,
              r.response_type, r.required, r.position
         FROM feedback_items i JOIN feedback_item_revisions r ON r.id = i.current_revision_id
        WHERE i.collection_id = ? ORDER BY r.position, r.rowid`,
    ).all(askId) as Array<{
      id: string; client_item_key: string | null; parent_item_id: string | null; item_kind: "item" | "group";
      revision_id: string; ordinal: number; title: string; prompt: string; description: string | null;
      response_type: FeedbackResponseType | null; required: 0 | 1; position: number;
    }>;
    const optionStatement = db.prepare(
      "SELECT option_key, label, description, position FROM feedback_item_options WHERE revision_id = ? ORDER BY position",
    );
    const responseStatement = db.prepare(
      `SELECT e.id, e.value_json FROM feedback_response_events e
        WHERE e.item_revision_id = ? AND e.actor_user_id = ? AND e.operation = 'set'
          AND NOT EXISTS (SELECT 1 FROM feedback_response_events r WHERE r.retracts_event_id = e.id)
        ORDER BY e.created_at DESC, e.rowid DESC LIMIT 1`,
    );
    return {
      transition,
      ask: {
        ask_id: askId,
        state: lifecycleState(head.operation),
        request_key: ask.request_key,
        request_digest: ask.request_digest,
        requester_user_id: ask.requester_user_id,
        requester_session_id: ask.requester_session_id,
        responder_user_ids: JSON.parse(ask.responder_user_ids_json) as string[],
        expires_at: ask.expires_at,
        retention_expires_at: ask.retention_expires_at,
        created_at: ask.created_at,
        lifecycle_event_id: head.id,
        latest_submission: latestSubmission ?? null,
        lifecycle: {
          id: head.id,
          operation: head.operation,
          actor_user_id: head.actor_user_id,
          created_at: head.created_at,
        },
        items: rows.map((row) => {
          const effective = options.answerActorUserId
            ? responseStatement.get(row.revision_id, options.answerActorUserId) as { id: string; value_json: string } | undefined
            : undefined;
          return {
            id: row.id,
            client_item_key: row.client_item_key,
            parent_item_id: row.parent_item_id,
            item_kind: row.item_kind,
            revision: {
              id: row.revision_id,
              ordinal: row.ordinal,
              title: row.title,
              prompt: row.prompt,
              description: row.description,
              response_type: row.response_type,
              required: row.required === 1,
              position: row.position,
              options: optionStatement.all(row.revision_id) as Array<{
                option_key: string; label: string; description: string | null; position: number;
              }>,
            },
            ...(options.answerActorUserId ? {
              effective_response: effective
                ? { response_event_id: effective.id, value: parseResponseValue(effective.value_json) }
                : null,
            } : {}),
          };
        }),
      },
    };
  });
  return transaction.immediate();
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === [...expected].sort()[index]);
}

export function validateResponseValue(
  responseType: FeedbackResponseType,
  value: unknown,
  optionKeys: readonly string[],
): FeedbackResponseValue {
  const record = plainRecord(value, "answer value");
  if (responseType === "verdict") {
    if (!exactKeys(record, ["verdict"]) || (record.verdict !== "keep" && record.verdict !== "dismiss")) {
      throw new AskStoreError("verdict value must contain exactly a keep or dismiss verdict");
    }
    return { verdict: record.verdict };
  }
  if (responseType === "free_text") {
    if (!exactKeys(record, ["text"]) || typeof record.text !== "string") {
      throw new AskStoreError("free_text value must contain exactly a text string");
    }
    return { text: record.text };
  }
  if (responseType === "single_choice") {
    if (!exactKeys(record, ["option_key"]) || typeof record.option_key !== "string" || !optionKeys.includes(record.option_key)) {
      throw new AskStoreError("single_choice value must name one option on the pinned revision");
    }
    return { option_key: record.option_key };
  }
  if (!exactKeys(record, ["option_keys"]) || !Array.isArray(record.option_keys)
      || record.option_keys.some((key) => typeof key !== "string" || !optionKeys.includes(key))
      || new Set(record.option_keys).size !== record.option_keys.length) {
    throw new AskStoreError("multi_choice value must name unique options on the pinned revision");
  }
  return { option_keys: record.option_keys as string[] };
}

type AnswerInput = {
  item_id: string;
  item_revision_id: string;
  operation: "set" | "retract";
  value?: unknown;
  expected_response_event_id: string | null;
};

function requireAudience(ask: AskRow, actorUserId: string): void {
  if (!(JSON.parse(ask.responder_user_ids_json) as string[]).includes(actorUserId)) {
    throw new AskStoreError("ask not found", 404, "not_found");
  }
}

function currentResponse(db: Db, revisionId: string, actorUserId: string): { id: string } | null {
  return (db.prepare(
    `SELECT e.id FROM feedback_response_events e
      WHERE e.item_revision_id = ? AND e.actor_user_id = ? AND e.operation = 'set'
        AND NOT EXISTS (SELECT 1 FROM feedback_response_events r WHERE r.retracts_event_id = e.id)
      ORDER BY e.created_at DESC, e.rowid DESC LIMIT 1`,
  ).get(revisionId, actorUserId) as { id: string } | undefined) ?? null;
}

export function applyAskAnswers(
  db: Db,
  askId: string,
  actorUserId: string,
  answers: AnswerInput[],
  now = Date.now(),
): { answer_event_ids: string[] } {
  if (!Array.isArray(answers)) throw new AskStoreError("answers must be an array");
  observeAsk(db, askId, now);
  const transaction = db.transaction(() => {
    const ask = getAskRow(db, askId);
    if (!ask) throw new AskStoreError("ask not found", 404, "not_found");
    requireAudience(ask, actorUserId);
    materializeExpiryInTransaction(db, ask, now);
    const state = lifecycleState(lifecycleHead(db, askId).operation);
    if (state === "expired" || state === "cancelled") {
      throw new AskStoreError(`cannot answer a ${state} ask`, 409, "ask_not_answerable");
    }
    const seen = new Set<string>();
    const output: string[] = [];
    for (const answer of answers) {
      const record = plainRecord(answer, "answer") as unknown as AnswerInput;
      const itemId = nonblank(record.item_id, "item_id");
      const revisionId = nonblank(record.item_revision_id, "item_revision_id");
      if (seen.has(itemId)) throw new AskStoreError("answer batch contains duplicate items");
      seen.add(itemId);
      if (record.operation !== "set" && record.operation !== "retract") throw new AskStoreError("invalid answer operation");
      if (record.expected_response_event_id !== null && (typeof record.expected_response_event_id !== "string" || !record.expected_response_event_id)) {
        throw new AskStoreError("expected_response_event_id must be a string or null");
      }
      const item = db.prepare(
        `SELECT i.current_revision_id, r.response_type
           FROM feedback_items i JOIN feedback_item_revisions r ON r.id = ?
          WHERE i.id = ? AND i.collection_id = ? AND r.item_id = i.id`,
      ).get(revisionId, itemId, askId) as { current_revision_id: string; response_type: FeedbackResponseType | null } | undefined;
      if (!item || item.current_revision_id !== revisionId || item.response_type === null) {
        throw new AskStoreError("answer item or revision is stale", 409, "stale_answer_revision");
      }
      const current = currentResponse(db, revisionId, actorUserId);
      if ((current?.id ?? null) !== record.expected_response_event_id) {
        throw new AskStoreError("answer expectation is stale", 409, "stale_response_event");
      }
      if (record.operation === "retract") {
        if (!current || (record.value !== undefined && record.value !== null)) {
          throw new AskStoreError("retract requires an effective response and no value");
        }
        const eventId = randomUUID();
        db.prepare(
          `INSERT INTO feedback_response_events
             (id, collection_id, item_id, item_revision_id, operation, value_json,
              retracts_event_id, actor_user_id, created_at)
           VALUES (?, ?, ?, ?, 'retract', NULL, ?, ?, ?)`,
        ).run(eventId, askId, itemId, revisionId, current.id, actorUserId, now);
        output.push(eventId);
        continue;
      }
      if (record.value === undefined || record.value === null) throw new AskStoreError("set requires a value");
      if (current) {
        db.prepare(
          `INSERT INTO feedback_response_events
             (id, collection_id, item_id, item_revision_id, operation, value_json,
              retracts_event_id, actor_user_id, created_at)
           VALUES (?, ?, ?, ?, 'retract', NULL, ?, ?, ?)`,
        ).run(randomUUID(), askId, itemId, revisionId, current.id, actorUserId, now);
      }
      const optionKeys = (db.prepare(
        "SELECT option_key FROM feedback_item_options WHERE revision_id = ? ORDER BY position",
      ).all(revisionId) as Array<{ option_key: string }>).map((row) => row.option_key);
      const value = validateResponseValue(item.response_type, record.value, optionKeys);
      const eventId = randomUUID();
      db.prepare(
        `INSERT INTO feedback_response_events
           (id, collection_id, item_id, item_revision_id, operation, value_json,
            retracts_event_id, actor_user_id, created_at)
         VALUES (?, ?, ?, ?, 'set', ?, NULL, ?, ?)`,
      ).run(eventId, askId, itemId, revisionId, JSON.stringify(value), actorUserId, now);
      output.push(eventId);
    }
    return { answer_event_ids: output };
  });
  return transaction.immediate();
}

type SubmitAnswer = { item_id: string; item_revision_id: string; response_event_id: string };

export function submitAsk(
  db: Db,
  askId: string,
  actorUserId: string,
  input: { expected_lifecycle_event_id: string; supersedes_submission_id?: string | null; answers: SubmitAnswer[] },
  now = Date.now(),
): { result: MandibleAskResult; submission_id: string; ordinal: number; lifecycle_event_id: string } {
  observeAsk(db, askId, now);
  const transaction = db.transaction(() => {
    const ask = getAskRow(db, askId);
    if (!ask) throw new AskStoreError("ask not found", 404, "not_found");
    requireAudience(ask, actorUserId);
    materializeExpiryInTransaction(db, ask, now);
    const head = lifecycleHead(db, askId);
    if (head.id !== input.expected_lifecycle_event_id) {
      throw new AskStoreError("lifecycle expectation is stale", 409, "stale_lifecycle_event");
    }
    if (!Array.isArray(input.answers)) throw new AskStoreError("answers must be an array");
    const latest = db.prepare(
      "SELECT id, ordinal FROM feedback_submissions WHERE collection_id = ? ORDER BY ordinal DESC LIMIT 1",
    ).get(askId) as { id: string; ordinal: number } | undefined;
    const supersedes = input.supersedes_submission_id ?? null;
    if (head.operation === "opened") {
      if (latest || supersedes !== null) throw new AskStoreError("first submission cannot supersede", 409, "invalid_supersession");
    } else if (head.operation === "submitted") {
      if (!latest || supersedes !== latest.id) throw new AskStoreError("correction must supersede the latest submission", 409, "invalid_supersession");
    } else {
      throw new AskStoreError(`cannot submit a ${lifecycleState(head.operation)} ask`, 409, "ask_not_submittable");
    }
    const effective = db.prepare(
      `SELECT e.id AS response_event_id, e.item_id, e.item_revision_id, r.position
         FROM feedback_response_events e
         JOIN feedback_items i ON i.id = e.item_id AND i.current_revision_id = e.item_revision_id
         JOIN feedback_item_revisions r ON r.id = e.item_revision_id
        WHERE e.collection_id = ? AND e.actor_user_id = ? AND e.operation = 'set'
          AND NOT EXISTS (SELECT 1 FROM feedback_response_events x WHERE x.retracts_event_id = e.id)
        ORDER BY r.position, e.rowid`,
    ).all(askId, actorUserId) as Array<SubmitAnswer & { position: number }>;
    const supplied = input.answers;
    if (new Set(supplied.map((answer) => answer.item_id)).size !== supplied.length) {
      throw new AskStoreError("submission contains duplicate items", 409, "invalid_submission_answers");
    }
    const currentByItem = new Map(effective.map((answer) => [answer.item_id, answer]));
    if (supplied.length !== effective.length || supplied.some((answer) => {
      const current = currentByItem.get(answer.item_id);
      return !current || current.item_revision_id !== answer.item_revision_id
        || current.response_event_id !== answer.response_event_id;
    })) {
      throw new AskStoreError("submitted answers must exactly match current effective answers", 409, "stale_submission_answers");
    }
    const required = db.prepare(
      `SELECT i.id FROM feedback_items i JOIN feedback_item_revisions r ON r.id = i.current_revision_id
        WHERE i.collection_id = ? AND i.item_kind = 'item' AND r.required = 1`,
    ).all(askId) as Array<{ id: string }>;
    if (required.some((item) => !currentByItem.has(item.id))) {
      throw new AskStoreError("all required items must be answered", 409, "required_answer_missing");
    }
    const lifecycleEventId = randomUUID();
    db.prepare(
      `INSERT INTO feedback_collection_events
         (id, collection_id, operation, previous_event_id, actor_user_id, metadata_json, created_at)
       VALUES (?, ?, 'submitted', ?, ?, '{}', ?)`,
    ).run(lifecycleEventId, askId, head.id, actorUserId, now);
    const submissionId = randomUUID();
    const ordinal = (latest?.ordinal ?? 0) + 1;
    db.prepare(
      `INSERT INTO feedback_submissions
         (id, collection_id, ordinal, supersedes_submission_id, lifecycle_event_id, actor_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(submissionId, askId, ordinal, supersedes, lifecycleEventId, actorUserId, now);
    for (const answer of effective) {
      db.prepare(
        `INSERT INTO feedback_submission_answers
           (submission_id, item_id, item_revision_id, response_event_id, position)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(submissionId, answer.item_id, answer.item_revision_id, answer.response_event_id, answer.position);
    }
    return {
      result: buildResult(db, ask, lifecycleHead(db, askId)),
      submission_id: submissionId,
      ordinal,
      lifecycle_event_id: lifecycleEventId,
    };
  });
  return transaction.immediate();
}

export function cancelAsk(db: Db, askId: string, actorUserId: string, now = Date.now()): AskLifecycleTransition {
  observeAsk(db, askId, now);
  const transaction = db.transaction(() => {
    const ask = getAskRow(db, askId);
    if (!ask) throw new AskStoreError("ask not found", 404, "not_found");
    materializeExpiryInTransaction(db, ask, now);
    const head = lifecycleHead(db, askId);
    if (head.operation !== "opened") {
      throw new AskStoreError("only an open ask may be cancelled", 409, "ask_not_cancellable");
    }
    const eventId = randomUUID();
    db.prepare(
      `INSERT INTO feedback_collection_events
         (id, collection_id, operation, previous_event_id, actor_user_id, metadata_json, created_at)
       VALUES (?, ?, 'cancelled', ?, ?, '{}', ?)`,
    ).run(eventId, askId, head.id, actorUserId, now);
    return {
      ask_id: askId,
      state: "cancelled" as const,
      requester_user_id: ask.requester_user_id,
      requester_session_id: ask.requester_session_id,
      lifecycle_event_id: eventId,
      created_at: now,
    };
  });
  return transaction.immediate();
}

export function askAudience(db: Db, askId: string): AskRow | null {
  return getAskRow(db, askId);
}
