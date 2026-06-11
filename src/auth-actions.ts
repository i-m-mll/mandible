import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import { getLedgerIssueHead } from "./ledger/issue-heads.js";
import { resolveOperationalIssueRef } from "./ledger/operational-links.js";
import type {
  AuthRequest,
  AuthRequestAction,
  AuthRequestActionInput,
  AuthRequestActionKind,
  AuthRequestActionState,
} from "./types.js";

const VALID_ACTION_KINDS: AuthRequestActionKind[] = [
  "comment_add",
  "issue_close",
  "worker_status_set",
  "label_add",
  "label_rm",
  "checkpoint_add",
  "link_add",
];
const VALID_ACTION_STATES: AuthRequestActionState[] = ["staged", "applied", "failed", "vetoed", "skipped_stale"];
const VALID_WORKER_STATUSES = ["none", "in_progress", "done", "blocked", "pivot-needed"];

export class AuthActionValidationError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export function normalizeAuthActionInput(input: unknown): AuthRequestActionInput {
  if (!input || typeof input !== "object") {
    throw new AuthActionValidationError("action must be an object");
  }
  const record = input as Record<string, unknown>;
  const kind = record.kind;
  if (typeof kind !== "string" || !VALID_ACTION_KINDS.includes(kind as AuthRequestActionKind)) {
    throw new AuthActionValidationError(`action kind must be one of: ${VALID_ACTION_KINDS.join(", ")}`);
  }
  const target = typeof record.target_issue_ref === "string" ? record.target_issue_ref.trim() : "";
  if (!target) {
    throw new AuthActionValidationError("target_issue_ref is required");
  }
  return {
    kind: kind as AuthRequestActionKind,
    target_issue_ref: target,
    payload: normalizePayload(kind as AuthRequestActionKind, record.payload),
  };
}

export function normalizeAuthActionInputs(value: unknown): AuthRequestActionInput[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new AuthActionValidationError("actions must be an array");
  }
  return value.map((item) => normalizeAuthActionInput(item));
}

export function insertAuthRequestActions(
  db: Db,
  request: AuthRequest,
  actions: readonly AuthRequestActionInput[],
  now: number,
): AuthRequestAction[] {
  if (actions.length === 0) return [];
  const insert = db.prepare(
    `INSERT INTO auth_request_actions (
      id, auth_request_id, ordinal, kind, target_issue_ref, payload,
      state, target_digest, staged_at, updated_at, applied_at, outcome_detail
    ) VALUES (?, ?, ?, ?, ?, ?, 'staged', ?, ?, ?, NULL, NULL)`,
  );
  const staged: AuthRequestAction[] = [];
  for (const [index, action] of actions.entries()) {
    const normalized = normalizeAuthActionInput(action);
    const row: AuthRequestAction = {
      id: randomUUID(),
      auth_request_id: request.id,
      ordinal: index + 1,
      kind: normalized.kind,
      target_issue_ref: normalized.target_issue_ref,
      payload: normalized.payload,
      state: "staged",
      target_digest: resolveTargetDigest(db, request, normalized.target_issue_ref),
      staged_at: now,
      updated_at: now,
      applied_at: null,
      outcome_detail: null,
    };
    insert.run(
      row.id,
      row.auth_request_id,
      row.ordinal,
      row.kind,
      row.target_issue_ref,
      JSON.stringify(row.payload),
      row.target_digest,
      row.staged_at,
      row.updated_at,
    );
    staged.push(row);
  }
  return staged;
}

export function listAuthRequestActions(db: Db, requestId: string): AuthRequestAction[] {
  return (db.prepare(
    `SELECT * FROM auth_request_actions
     WHERE auth_request_id = ?
     ORDER BY ordinal ASC, staged_at ASC, id ASC`,
  ).all(requestId) as Record<string, unknown>[]).map(mapAuthActionRow);
}

export function addAuthRequestAction(
  db: Db,
  request: AuthRequest,
  input: unknown,
  now: number,
): AuthRequestAction {
  const action = normalizeAuthActionInput(input);
  const nextOrdinal = Number((db.prepare(
    "SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal FROM auth_request_actions WHERE auth_request_id = ?",
  ).get(request.id) as { ordinal: number } | undefined)?.ordinal ?? 1);
  const row = insertAuthRequestActions(db, request, [{ ...action }], now)[0];
  if (row.ordinal !== nextOrdinal) {
    db.prepare("UPDATE auth_request_actions SET ordinal = ? WHERE id = ?").run(nextOrdinal, row.id);
    return { ...row, ordinal: nextOrdinal };
  }
  return row;
}

export function updateAuthRequestAction(
  db: Db,
  request: AuthRequest,
  actionId: string,
  input: unknown,
  now: number,
): AuthRequestAction {
  const existing = requireAuthAction(db, request.id, actionId);
  const action = normalizeAuthActionInput(input);
  db.prepare(
    `UPDATE auth_request_actions
     SET kind = ?, target_issue_ref = ?, payload = ?, target_digest = ?, updated_at = ?
     WHERE id = ? AND auth_request_id = ?`,
  ).run(
    action.kind,
    action.target_issue_ref,
    JSON.stringify(action.payload),
    resolveTargetDigest(db, request, action.target_issue_ref),
    now,
    existing.id,
    request.id,
  );
  return requireAuthAction(db, request.id, existing.id);
}

export function deleteAuthRequestAction(db: Db, requestId: string, actionId: string): AuthRequestAction {
  const existing = requireAuthAction(db, requestId, actionId);
  db.prepare("DELETE FROM auth_request_actions WHERE id = ? AND auth_request_id = ?").run(existing.id, requestId);
  return existing;
}

function normalizePayload(kind: AuthRequestActionKind, payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new AuthActionValidationError(`${kind} payload must be an object`);
  }
  const record = payload as Record<string, unknown>;
  switch (kind) {
    case "comment_add":
      return { body: requireMarkdownBody(record.body, "body") };
    case "issue_close": {
      const reason = optionalMarkdownBody(record.reason_comment, "reason_comment");
      const onStale = record.on_stale === undefined ? undefined : requireOnStale(record.on_stale);
      return {
        ...(reason == null ? {} : { reason_comment: reason }),
        ...(onStale == null ? {} : { on_stale: onStale }),
      };
    }
    case "worker_status_set": {
      const value = typeof record.value === "string" ? record.value.trim() : "";
      if (!VALID_WORKER_STATUSES.includes(value)) {
        throw new AuthActionValidationError(`worker_status_set value must be one of: ${VALID_WORKER_STATUSES.join(", ")}`);
      }
      return { value };
    }
    case "label_add":
    case "label_rm":
      return { label: requireNonEmptyString(record.label, "label") };
    case "checkpoint_add":
      if (!Object.prototype.hasOwnProperty.call(record, "payload")) {
        throw new AuthActionValidationError("checkpoint_add payload.payload is required");
      }
      return { kind: requireNonEmptyString(record.kind, "kind"), payload: record.payload };
    case "link_add": {
      const normalized: Record<string, unknown> = { target: requireNonEmptyString(record.target, "target") };
      if (record.type !== undefined) normalized.type = requireNonEmptyString(record.type, "type");
      if (record.note !== undefined) normalized.note = optionalMarkdownBody(record.note, "note");
      return normalized;
    }
  }
}

function requireNonEmptyString(value: unknown, field: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new AuthActionValidationError(`${field} is required`);
  return text;
}

function requireMarkdownBody(value: unknown, field: string): string {
  const body = requireNonEmptyString(value, field);
  rejectEscapedNewlines(body, field);
  return body;
}

function optionalMarkdownBody(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new AuthActionValidationError(`${field} must be a string`);
  const body = value.trim();
  if (!body) return null;
  rejectEscapedNewlines(body, field);
  return body;
}

function rejectEscapedNewlines(value: string, field: string): void {
  if (value.includes("\\n")) {
    throw new AuthActionValidationError(`${field} must contain real newlines, not literal \\n escapes`);
  }
}

function requireOnStale(value: unknown): "apply" | "skip" {
  if (value === "apply" || value === "skip") return value;
  throw new AuthActionValidationError("issue_close on_stale must be 'apply' or 'skip'");
}

function resolveTargetDigest(db: Db, request: AuthRequest, issueRef: string): string | null {
  const repoRef = request.repo ?? request.cwd ?? request.target_repo_root ?? null;
  const resolved = resolveOperationalIssueRef(db, issueRef, repoRef);
  if (!resolved.ok) return null;
  try {
    return getLedgerIssueHead(db, resolved.issue_id).digest;
  } catch {
    return null;
  }
}

function requireAuthAction(db: Db, requestId: string, actionId: string): AuthRequestAction {
  const rows = db.prepare(
    `SELECT * FROM auth_request_actions
     WHERE auth_request_id = ? AND (id = ? OR id LIKE ?)
     ORDER BY id ASC`,
  ).all(requestId, actionId, `${actionId}%`) as Record<string, unknown>[];
  if (rows.length === 0) {
    throw new AuthActionValidationError("Auth request action not found.", 404);
  }
  if (rows.length > 1) {
    throw new AuthActionValidationError(`Ambiguous action prefix '${actionId}'. Use a longer prefix.`, 409);
  }
  return mapAuthActionRow(rows[0]);
}

function mapAuthActionRow(row: Record<string, unknown>): AuthRequestAction {
  const state = String(row.state ?? "staged") as AuthRequestActionState;
  return {
    id: String(row.id),
    auth_request_id: String(row.auth_request_id),
    ordinal: Number(row.ordinal ?? 0),
    kind: String(row.kind) as AuthRequestActionKind,
    target_issue_ref: String(row.target_issue_ref ?? ""),
    payload: parsePayload(row.payload),
    state: VALID_ACTION_STATES.includes(state) ? state : "failed",
    target_digest: typeof row.target_digest === "string" ? row.target_digest : null,
    staged_at: Number(row.staged_at ?? 0),
    updated_at: Number(row.updated_at ?? row.staged_at ?? 0),
    applied_at: row.applied_at == null ? null : Number(row.applied_at),
    outcome_detail: typeof row.outcome_detail === "string" ? row.outcome_detail : null,
  };
}

function parsePayload(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}
