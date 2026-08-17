import { createHash, randomUUID } from "node:crypto";

import {
  MANDIBLE_ASK_RESULT_SCHEMA,
  type FeedbackResponseType,
  type FeedbackResponseValue,
  type MandibleAskResult,
} from "../contracts.js";
import type { Db } from "../db.js";
import { readArtifactBytesFull } from "../artifact-content.js";
import { resolveArtifactProject } from "../permissions/resources.js";
import { evaluateGlobalCapability, evaluateProjectAccess } from "../permissions/store.js";
import { getCanonicalArtifactVersion } from "../provider-artifacts.js";

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
  document?: { artifact_version: string; previous_round_id?: string | null };
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
  document?: { artifact_version: string; previous_round_id: string | null };
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
    "retention_expires_at", "items", "document",
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
  let document: NormalizedPacket["document"];
  if (packet.document !== undefined) {
    const rawDocument = plainRecord(packet.document, "document");
    assertOnlyKeys(rawDocument, ["artifact_version", "previous_round_id"], "document");
    const artifactVersion = nonblank(rawDocument.artifact_version, "document.artifact_version");
    if (!/^artifact-version:[0-9a-z-]+$/.test(artifactVersion)) {
      throw new AskStoreError("document.artifact_version must be a canonical full artifact-version id", 400, "invalid_document_version");
    }
    document = {
      artifact_version: artifactVersion,
      previous_round_id: nullableString(rawDocument.previous_round_id, "document.previous_round_id"),
    };
  }
  return {
    request_key: requestKey,
    session_id: sessionId,
    responder_user_ids: [...responders].sort(),
    expires_at: Number(packet.expires_at),
    retention_expires_at: retention === null ? null : Number(retention),
    items,
    ...(document ? { document } : {}),
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

function pinnedDocument(db: Db, ref: string, failureCode: "invalid_document_version" | "document_unavailable") {
  const version = getCanonicalArtifactVersion(db, ref);
  const status = failureCode === "invalid_document_version" ? 400 : 409;
  if (!version || version.id !== ref) {
    throw new AskStoreError("document artifact version is invalid", status, failureCode);
  }
  const content = readArtifactBytesFull(db, version.id);
  if (!content.ok) throw new AskStoreError("document bytes are unavailable", status, failureCode);
  const expected = version.content_hash.replace(/^sha256:/, "").toLowerCase();
  const actual = createHash("sha256").update(content.bytes).digest("hex");
  if (!/^[0-9a-f]{64}$/.test(expected) || actual !== expected) {
    throw new AskStoreError("document bytes failed integrity verification", status, failureCode);
  }
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(content.bytes);
  } catch {
    throw new AskStoreError("document bytes are not valid UTF-8", status, failureCode);
  }
  return { version, source };
}

function requireDocumentReaders(db: Db, versionId: string, userIds: readonly string[]): void {
  const project = resolveArtifactProject(db, versionId);
  if (!project.ok) throw new AskStoreError("document is not readable by every participant", 403, "document_forbidden");
  for (const userId of userIds) {
    const user = db.prepare("SELECT slug FROM users WHERE id = ? AND status = 'active'").get(userId) as
      { slug: string } | undefined;
    const decision = user && evaluateProjectAccess(db, {
      identity: { user_id: userId, slug: user.slug, method: "api_token", credential_id: null, source: "in_process" },
      project_id: project.project_id,
      required_role: "read",
    });
    if (!decision || !decision.allowed) {
      throw new AskStoreError("document is not readable by every participant", 403, "document_forbidden");
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
    let documentVersion: ReturnType<typeof pinnedDocument>["version"] | null = null;
    if (packet.document) {
      documentVersion = pinnedDocument(db, packet.document.artifact_version, "invalid_document_version").version;
      requireDocumentReaders(db, documentVersion.id, [options.requesterUserId, ...packet.responder_user_ids]);
      if (packet.document.previous_round_id) {
        const previous = db.prepare(
          `SELECT d.artifact_version_id, v.artifact_id
             FROM feedback_collection_documents d
             JOIN feedback_collections c ON c.id = d.collection_id AND c.kind = 'bounded_ask'
             JOIN artifact_version v ON v.id = d.artifact_version_id
            WHERE d.collection_id = ?`,
        ).get(packet.document.previous_round_id) as { artifact_version_id: string; artifact_id: string } | undefined;
        if (!previous) throw new AskStoreError("previous round is invalid", 400, "invalid_previous_round");
        if (previous.artifact_id !== documentVersion.artifact_id) {
          throw new AskStoreError("previous round belongs to another document", 400, "round_series_mismatch");
        }
      }
    }
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
    if (packet.document && documentVersion) {
      db.prepare(
        `INSERT INTO feedback_collection_documents
           (collection_id, artifact_version_id, previous_round_id, created_at)
         VALUES (?, ?, ?, ?)`,
      ).run(askId, documentVersion.id, packet.document.previous_round_id, now);
    }
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
  if ((head.operation !== "opened" && head.operation !== "submitted")
      || ask.expires_at === null || now < ask.expires_at) return null;
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
  const submissions = db.prepare(
    `SELECT s.id, s.ordinal, s.supersedes_submission_id, s.lifecycle_event_id, s.actor_user_id, s.created_at
       FROM feedback_submissions s
      WHERE s.collection_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM feedback_submissions newer
           WHERE newer.collection_id = s.collection_id
             AND newer.actor_user_id = s.actor_user_id
             AND newer.ordinal > s.ordinal
        )
      ORDER BY s.ordinal`,
  ).all(ask.collection_id) as Array<{
    id: string; ordinal: number; supersedes_submission_id: string | null;
    lifecycle_event_id: string; actor_user_id: string; created_at: number;
  }>;
  return {
    schema: MANDIBLE_ASK_RESULT_SCHEMA,
    ask_id: ask.collection_id,
    state: lifecycleState(head.operation),
    request_digest: ask.request_digest,
    expires_at: ask.expires_at,
    submissions: submissions.map((submission) => ({
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
      annotations: db.prepare(
        `SELECT sa.annotation_event_id, e.annotation_kind, e.start_offset, e.end_offset,
                e.quote, e.body, e.replacement_text, e.actor_user_id, e.created_at, sa.position
           FROM feedback_submission_annotations sa
           JOIN feedback_annotation_events e ON e.id = sa.annotation_event_id
          WHERE sa.submission_id = ? ORDER BY sa.position, e.id`,
      ).all(submission.id) as MandibleAskResult["submissions"][number]["annotations"],
    })),
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
  latest_submission_for_actor?: null | { id: string; ordinal: number };
  document: null | { artifact_version_id: string; previous_round_id: string | null };
  annotations?: Array<{
    annotation_event_id: string; annotation_kind: "comment" | "suggest_replacement";
    start_offset: number; end_offset: number; quote: string; body: string | null;
    replacement_text: string | null; created_at: number;
  }>;
  previous_round: null | {
    ask_id: string;
    artifact_version_id: string;
    annotations: Array<{
      annotation_event_id: string; annotation_kind: "comment" | "suggest_replacement";
      start_offset: number; end_offset: number; quote: string; body: string | null;
      replacement_text: string | null; actor_user_id: string; created_at: number;
      submission_ordinal: number;
    }>;
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
  options: { answerActorUserId?: string; viewerUserId?: string; viewerIsOperator?: boolean; now?: number } = {},
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
    const latestSubmissionForActor = options.answerActorUserId ? db.prepare(
      `SELECT id, ordinal FROM feedback_submissions
        WHERE collection_id = ? AND actor_user_id = ? ORDER BY ordinal DESC LIMIT 1`,
    ).get(askId, options.answerActorUserId) as { id: string; ordinal: number } | undefined : undefined;
    const document = db.prepare(
      `SELECT artifact_version_id, previous_round_id
         FROM feedback_collection_documents WHERE collection_id = ?`,
    ).get(askId) as { artifact_version_id: string; previous_round_id: string | null } | undefined;
    const annotations = options.answerActorUserId ? db.prepare(
      `SELECT e.id AS annotation_event_id, e.annotation_kind, e.start_offset, e.end_offset,
              e.quote, e.body, e.replacement_text, e.created_at
         FROM feedback_annotation_events e
        WHERE e.collection_id = ? AND e.actor_user_id = ? AND e.operation = 'set'
          AND NOT EXISTS (SELECT 1 FROM feedback_annotation_events r WHERE r.retracts_event_id = e.id)
        ORDER BY e.start_offset, e.created_at, e.id`,
    ).all(askId, options.answerActorUserId) as NonNullable<AskReadProjection["annotations"]> : undefined;
    let previousRound: AskReadProjection["previous_round"] = null;
    if (document?.previous_round_id && options.viewerUserId) {
      const previousAsk = getAskRow(db, document.previous_round_id);
      const priorDocument = db.prepare(
        "SELECT artifact_version_id FROM feedback_collection_documents WHERE collection_id = ?",
      ).get(document.previous_round_id) as { artifact_version_id: string } | undefined;
      const currentAudience = JSON.parse(ask.responder_user_ids_json) as string[];
      const priorAudience = previousAsk ? JSON.parse(previousAsk.responder_user_ids_json) as string[] : [];
      const allowed = options.viewerIsOperator === true
        || previousAsk?.requester_user_id === options.viewerUserId
        || (currentAudience.includes(options.viewerUserId) && priorAudience.includes(options.viewerUserId));
      if (allowed && previousAsk && priorDocument) {
        previousRound = {
          ask_id: previousAsk.collection_id,
          artifact_version_id: priorDocument.artifact_version_id,
          annotations: db.prepare(
            `SELECT a.id AS annotation_event_id, a.annotation_kind, a.start_offset, a.end_offset,
                    a.quote, a.body, a.replacement_text, a.actor_user_id, a.created_at,
                    s.ordinal AS submission_ordinal
               FROM feedback_submissions s
               JOIN feedback_submission_annotations sa ON sa.submission_id = s.id
               JOIN feedback_annotation_events a ON a.id = sa.annotation_event_id
              WHERE s.collection_id = ?
                AND NOT EXISTS (SELECT 1 FROM feedback_submissions newer
                  WHERE newer.collection_id = s.collection_id
                    AND newer.actor_user_id = s.actor_user_id AND newer.ordinal > s.ordinal)
              ORDER BY s.ordinal, sa.position, a.id`,
          ).all(previousAsk.collection_id) as NonNullable<AskReadProjection["previous_round"]>["annotations"],
        };
      }
    }
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
        ...(options.answerActorUserId ? { latest_submission_for_actor: latestSubmissionForActor ?? null } : {}),
        document: document ?? null,
        ...(options.answerActorUserId ? { annotations } : {}),
        previous_round: previousRound,
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

type AnnotationInput = {
  operation: "set" | "retract";
  annotation_kind?: "comment" | "suggest_replacement";
  start_offset?: number;
  end_offset?: number;
  quote?: string;
  body?: string | null;
  replacement_text?: string;
  annotation_event_id?: string;
};

export function applyAskAnnotations(
  db: Db,
  askId: string,
  actorUserId: string,
  annotations: AnnotationInput[],
  now = Date.now(),
): { annotation_event_ids: string[] } {
  if (!Array.isArray(annotations)) throw new AskStoreError("annotations must be an array");
  observeAsk(db, askId, now);
  const transaction = db.transaction(() => {
    const ask = getAskRow(db, askId);
    if (!ask) throw new AskStoreError("ask not found", 404, "not_found");
    requireAudience(ask, actorUserId);
    materializeExpiryInTransaction(db, ask, now);
    const state = lifecycleState(lifecycleHead(db, askId).operation);
    if (state === "expired" || state === "cancelled") {
      throw new AskStoreError(`cannot annotate a ${state} ask`, 409, "ask_not_answerable");
    }
    const document = db.prepare(
      "SELECT artifact_version_id FROM feedback_collection_documents WHERE collection_id = ?",
    ).get(askId) as { artifact_version_id: string } | undefined;
    if (!document) throw new AskStoreError("ask has no document", 409, "ask_has_no_document");
    const source = pinnedDocument(db, document.artifact_version_id, "document_unavailable").source;
    const output: string[] = [];
    for (const raw of annotations) {
      const annotation = plainRecord(raw, "annotation") as AnnotationInput;
      if (annotation.operation === "retract") {
        if (!exactKeys(annotation as Record<string, unknown>, ["operation", "annotation_event_id"])
            || typeof annotation.annotation_event_id !== "string" || !annotation.annotation_event_id) {
          throw new AskStoreError("invalid annotation retraction", 400, "invalid_annotation");
        }
        const target = db.prepare(
          `SELECT id FROM feedback_annotation_events e
            WHERE e.id = ? AND e.collection_id = ? AND e.actor_user_id = ? AND e.operation = 'set'
              AND NOT EXISTS (SELECT 1 FROM feedback_annotation_events r WHERE r.retracts_event_id = e.id)`,
        ).get(annotation.annotation_event_id, askId, actorUserId) as { id: string } | undefined;
        if (!target) throw new AskStoreError("annotation event is stale", 409, "stale_annotation_event");
        const id = randomUUID();
        db.prepare(
          `INSERT INTO feedback_annotation_events
             (id, collection_id, operation, annotation_kind, start_offset, end_offset, quote,
              body, replacement_text, retracts_event_id, actor_user_id, created_at)
           VALUES (?, ?, 'retract', NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?)`,
        ).run(id, askId, target.id, actorUserId, now);
        output.push(id);
        continue;
      }
      if (annotation.operation !== "set"
          || (annotation.annotation_kind !== "comment" && annotation.annotation_kind !== "suggest_replacement")) {
        throw new AskStoreError("invalid annotation", 400, "invalid_annotation");
      }
      const allowed = annotation.annotation_kind === "comment"
        ? ["operation", "annotation_kind", "start_offset", "end_offset", "quote", "body"]
        : ["operation", "annotation_kind", "start_offset", "end_offset", "quote", "replacement_text", "body"];
      if (Object.keys(annotation).some((key) => !allowed.includes(key))
          || typeof annotation.quote !== "string" || !annotation.quote
          || (annotation.annotation_kind === "comment"
            ? typeof annotation.body !== "string" || !annotation.body.trim()
              || annotation.replacement_text !== undefined
            : typeof annotation.replacement_text !== "string"
              || (annotation.body !== undefined && annotation.body !== null
                && (typeof annotation.body !== "string" || !annotation.body.trim())))) {
        throw new AskStoreError("invalid annotation", 400, "invalid_annotation");
      }
      if (!Number.isSafeInteger(annotation.start_offset) || !Number.isSafeInteger(annotation.end_offset)
          || annotation.start_offset! < 0 || annotation.end_offset! <= annotation.start_offset!
          || annotation.end_offset! > source.length) {
        throw new AskStoreError("invalid annotation range", 400, "invalid_annotation_range");
      }
      if (source.slice(annotation.start_offset, annotation.end_offset) !== annotation.quote) {
        throw new AskStoreError("annotation quote does not match document", 400, "quote_mismatch");
      }
      const id = randomUUID();
      db.prepare(
        `INSERT INTO feedback_annotation_events
           (id, collection_id, operation, annotation_kind, start_offset, end_offset, quote,
            body, replacement_text, retracts_event_id, actor_user_id, created_at)
         VALUES (?, ?, 'set', ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      ).run(id, askId, annotation.annotation_kind, annotation.start_offset, annotation.end_offset,
        annotation.quote, annotation.body ?? null, annotation.replacement_text ?? null, actorUserId, now);
      output.push(id);
    }
    return { annotation_event_ids: output };
  });
  return transaction.immediate();
}

type SubmitAnswer = { item_id: string; item_revision_id: string; response_event_id: string };
type SubmitAnnotation = { annotation_event_id: string };

export function submitAsk(
  db: Db,
  askId: string,
  actorUserId: string,
  input: {
    expected_lifecycle_event_id: string;
    supersedes_submission_id?: string | null;
    answers: SubmitAnswer[];
    annotations?: SubmitAnnotation[];
  },
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
    const suppliedAnnotations = input.annotations ?? [];
    if (!Array.isArray(suppliedAnnotations)) throw new AskStoreError("annotations must be an array");
    const latest = db.prepare(
      `SELECT id, ordinal FROM feedback_submissions
        WHERE collection_id = ? AND actor_user_id = ? ORDER BY ordinal DESC LIMIT 1`,
    ).get(askId, actorUserId) as { id: string; ordinal: number } | undefined;
    const globalLatest = db.prepare(
      "SELECT ordinal FROM feedback_submissions WHERE collection_id = ? ORDER BY ordinal DESC LIMIT 1",
    ).get(askId) as { ordinal: number } | undefined;
    const supersedes = input.supersedes_submission_id ?? null;
    if (head.operation !== "opened" && head.operation !== "submitted") {
      throw new AskStoreError(`cannot submit a ${lifecycleState(head.operation)} ask`, 409, "ask_not_submittable");
    }
    if ((!latest && supersedes !== null) || (latest && supersedes !== latest.id)) {
      throw new AskStoreError("submission must supersede this responder's latest submission", 409, "invalid_supersession");
    }
    if (supersedes) {
      const owned = db.prepare(
        "SELECT 1 FROM feedback_submissions WHERE id = ? AND collection_id = ? AND actor_user_id = ?",
      ).get(supersedes, askId, actorUserId);
      if (!owned) throw new AskStoreError("superseded submission belongs to another responder", 409, "invalid_supersession");
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
    const effectiveAnnotations = db.prepare(
      `SELECT e.id AS annotation_event_id, e.start_offset, e.created_at
         FROM feedback_annotation_events e
        WHERE e.collection_id = ? AND e.actor_user_id = ? AND e.operation = 'set'
          AND NOT EXISTS (SELECT 1 FROM feedback_annotation_events r WHERE r.retracts_event_id = e.id)
        ORDER BY e.start_offset, e.created_at, e.id`,
    ).all(askId, actorUserId) as Array<SubmitAnnotation & { start_offset: number; created_at: number }>;
    if (new Set(suppliedAnnotations.map((entry) => entry.annotation_event_id)).size !== suppliedAnnotations.length
        || suppliedAnnotations.some((entry) => !entry || typeof entry.annotation_event_id !== "string")
        || suppliedAnnotations.length !== effectiveAnnotations.length
        || suppliedAnnotations.some((entry) => !effectiveAnnotations.some(
          (effectiveAnnotation) => effectiveAnnotation.annotation_event_id === entry.annotation_event_id,
        ))) {
      throw new AskStoreError(
        "submitted annotations must exactly match current effective annotations",
        409,
        "stale_submission_annotations",
      );
    }
    const lifecycleEventId = randomUUID();
    db.prepare(
      `INSERT INTO feedback_collection_events
         (id, collection_id, operation, previous_event_id, actor_user_id, metadata_json, created_at)
       VALUES (?, ?, 'submitted', ?, ?, '{}', ?)`,
    ).run(lifecycleEventId, askId, head.id, actorUserId, now);
    const submissionId = randomUUID();
    const ordinal = (globalLatest?.ordinal ?? 0) + 1;
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
    effectiveAnnotations.forEach((annotation, position) => {
      db.prepare(
        `INSERT INTO feedback_submission_annotations
           (submission_id, annotation_event_id, position) VALUES (?, ?, ?)`,
      ).run(submissionId, annotation.annotation_event_id, position);
    });
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
