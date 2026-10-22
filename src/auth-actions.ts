import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import { getLedgerIssueContentDigest } from "./ledger/issue-heads.js";
import { resolveOperationalIssueRef } from "./ledger/operational-links.js";
import { LEDGER_STORED_WORKER_STATUSES } from "./ledger/types.js";
import { validateBriefingGroupPromotionCandidate } from "./feedback/briefing-groups.js";
import { BriefingStoreError } from "./feedback/briefings.js";
import { AUTH_REQUEST_ACTION_KINDS } from "./types.js";
import type {
  AuthRequest,
  AuthRequestAction,
  AuthRequestActionInput,
  AuthRequestActionKind,
  AuthRequestActionState,
} from "./types.js";
import { parseJsonObject } from "./row-coerce.js";
import { resolveId } from "./entity-refs.js";

/**
 * Whether a staged action must be withheld when convergence has not completed.
 *
 * A `Record` keyed by the kind union rather than a list of the withheld kinds:
 * adding a kind without classifying it is then a compile error, instead of the
 * new kind silently defaulting to "apply anyway". Withhold anything that
 * mutates canonical state a human would want to have converged first.
 */
export const WITHHOLD_UNTIL_CONVERGED: Record<AuthRequestActionKind, boolean> = {
  comment_add: false,
  issue_close: true,
  worker_status_set: false,
  label_add: false,
  label_rm: false,
  checkpoint_add: false,
  link_add: false,
  briefing_group_promote: true,
};

const VALID_ACTION_KINDS: readonly AuthRequestActionKind[] = AUTH_REQUEST_ACTION_KINDS;
const VALID_ACTION_STATES: AuthRequestActionState[] = ["staged", "applied", "failed", "skipped_stale", "vetoed"];
const VALID_WORKER_STATUSES: readonly string[] = LEDGER_STORED_WORKER_STATUSES;

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
    const normalized = validateAuthActionForRequest(db, request, normalizeAuthActionInput(action));
    const row: AuthRequestAction = {
      id: randomUUID(),
      auth_request_id: request.id,
      ordinal: index + 1,
      kind: normalized.kind,
      target_issue_ref: normalized.target_issue_ref,
      payload: normalized.payload,
      state: "staged",
      target_digest: stagedTargetDigest(db, request, normalized),
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

export function countAuthRequestActions(db: Db, requestId: string): number {
  const row = db.prepare(
    "SELECT COUNT(*) AS count FROM auth_request_actions WHERE auth_request_id = ?",
  ).get(requestId) as { count?: number } | undefined;
  return Number(row?.count ?? 0);
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
  const action = validateAuthActionForRequest(db, request, normalizeAuthActionInput(input));
  db.prepare(
    `UPDATE auth_request_actions
     SET kind = ?, target_issue_ref = ?, payload = ?, target_digest = ?, updated_at = ?
     WHERE id = ? AND auth_request_id = ?`,
  ).run(
    action.kind,
    action.target_issue_ref,
    JSON.stringify(action.payload),
    stagedTargetDigest(db, request, action),
    now,
    existing.id,
    request.id,
  );
  return requireAuthAction(db, request.id, existing.id);
}

function validateAuthActionForRequest(
  db: Db,
  request: AuthRequest,
  action: AuthRequestActionInput,
): AuthRequestActionInput {
  if (action.kind !== "briefing_group_promote") return action;
  if (request.type !== "merge") {
    throw new AuthActionValidationError("briefing_group_promote requires a merge auth request");
  }
  try {
    const resolved = validateBriefingGroupPromotionCandidate(db, {
      groupRef: String(action.payload.group_ref),
      expectedBaseBundleRef: String(action.payload.expected_base_bundle_ref),
      proposalBundleRef: String(action.payload.proposal_bundle_ref),
    });
    return {
      ...action,
      payload: {
        group_ref: resolved.groupId,
        expected_base_bundle_ref: resolved.expectedBaseBundleId,
        proposal_bundle_ref: resolved.proposalBundleId,
      },
    };
  } catch (error) {
    if (error instanceof BriefingStoreError) {
      throw new AuthActionValidationError(error.message, error.status);
    }
    throw error;
  }
}

export function deleteAuthRequestAction(db: Db, requestId: string, actionId: string): AuthRequestAction {
  const existing = requireAuthAction(db, requestId, actionId);
  db.prepare("DELETE FROM auth_request_actions WHERE id = ? AND auth_request_id = ?").run(existing.id, requestId);
  return existing;
}

export function setAuthRequestActionVeto(
  db: Db,
  requestId: string,
  actionId: string,
  vetoed: boolean,
  now: number,
): AuthRequestAction {
  const existing = requireAuthAction(db, requestId, actionId);
  if (existing.state !== "staged" && existing.state !== "vetoed") {
    throw new AuthActionValidationError(
      `Action is ${existing.state}, cannot change veto state.`,
      409,
    );
  }
  const nextState: AuthRequestActionState = vetoed ? "vetoed" : "staged";
  db.prepare(
    `UPDATE auth_request_actions
     SET state = ?, updated_at = ?
     WHERE id = ? AND auth_request_id = ?`,
  ).run(nextState, now, existing.id, requestId);
  return requireAuthAction(db, requestId, existing.id);
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
    case "briefing_group_promote":
      rejectUnexpectedKeys(record, ["group_ref", "expected_base_bundle_ref", "proposal_bundle_ref"], kind);
      return {
        group_ref: requireNonEmptyString(record.group_ref, "group_ref"),
        expected_base_bundle_ref: requireNonEmptyString(
          record.expected_base_bundle_ref,
          "expected_base_bundle_ref",
        ),
        proposal_bundle_ref: requireNonEmptyString(record.proposal_bundle_ref, "proposal_bundle_ref"),
      };
  }
}

function rejectUnexpectedKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unexpected = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new AuthActionValidationError(`${label} payload contains unsupported field '${unexpected[0]}'`);
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

/**
 * Baseline issue digest recorded when an action is staged, used at merge time
 * to decide whether the target drifted.
 *
 * A null baseline makes `digestMoved` permanently false, which silently
 * DISABLES the `on_stale: "skip"` guard — the close then applies regardless of
 * drift, which is the opposite of what the staging caller asked for. So the
 * failure is reported instead of collapsed: `resolveOperationalIssueRef`
 * already returns a typed reason, and the head read is no longer swallowed.
 */
function resolveTargetDigest(
  db: Db,
  request: AuthRequest,
  issueRef: string,
): { ok: true; digest: string } | { ok: false; error: string } {
  const repoRef = request.repo ?? request.cwd ?? request.target_repo_root ?? null;
  const resolved = resolveOperationalIssueRef(db, issueRef, repoRef);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  try {
    return { ok: true, digest: getLedgerIssueContentDigest(db, resolved.issue_id) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The digest to store, refusing to stage a guard that cannot be honoured.
 *
 * Only `issue_close` with `on_stale: "skip"` depends on the baseline. For
 * every other action a missing baseline changes nothing, so it stays null
 * rather than blocking the request.
 */
function stagedTargetDigest(
  db: Db,
  request: AuthRequest,
  action: { kind: AuthRequestActionKind; target_issue_ref: string; payload: Record<string, unknown> },
): string | null {
  const resolved = resolveTargetDigest(db, request, action.target_issue_ref);
  if (resolved.ok) return resolved.digest;
  if (action.kind === "issue_close" && action.payload.on_stale === "skip") {
    throw new AuthActionValidationError(
      `Cannot stage issue_close with on_stale: "skip" for ${action.target_issue_ref}: ` +
        `its current digest could not be read (${resolved.error}), so drift could not be ` +
        "detected at merge time and the close would apply unconditionally.",
    );
  }
  return null;
}

function requireAuthAction(db: Db, requestId: string, actionId: string): AuthRequestAction {
  const resolved = resolveId(db, "auth_action", actionId);
  if (!resolved.ok && resolved.error === "ambiguous") {
    throw new AuthActionValidationError(`Ambiguous action prefix '${actionId}'. Use a longer prefix.`, 409);
  }
  const row = resolved.ok
    ? db.prepare("SELECT * FROM auth_request_actions WHERE id = ? AND auth_request_id = ?").get(resolved.id, requestId) as Record<string, unknown> | undefined
    : undefined;
  if (!row) throw new AuthActionValidationError("Auth request action not found.", 404);
  return mapAuthActionRow(row);
}

function mapAuthActionRow(row: Record<string, unknown>): AuthRequestAction {
  const state = String(row.state ?? "staged") as AuthRequestActionState;
  const kind = String(row.kind);
  // `state` on the line below was already validated on read; `kind` was cast
  // unchecked, so a row outside the vocabulary entered the type system as a
  // valid kind. Refuse it here instead: the applier switches on this value to
  // decide what to write to the ledger, and the DB CHECK that makes such a row
  // unreachable today is not a reason for the reader to assume it.
  if (!VALID_ACTION_KINDS.includes(kind as AuthRequestActionKind)) {
    throw new AuthActionValidationError(
      `auth_request_actions row ${String(row.id)} has unknown kind '${kind}'`,
      500,
    );
  }
  return {
    id: String(row.id),
    auth_request_id: String(row.auth_request_id),
    ordinal: Number(row.ordinal ?? 0),
    kind: kind as AuthRequestActionKind,
    target_issue_ref: String(row.target_issue_ref ?? ""),
    payload: parseJsonObject(row.payload),
    state: VALID_ACTION_STATES.includes(state) ? state : "failed",
    target_digest: typeof row.target_digest === "string" ? row.target_digest : null,
    staged_at: Number(row.staged_at ?? 0),
    updated_at: Number(row.updated_at ?? row.staged_at ?? 0),
    applied_at: row.applied_at == null ? null : Number(row.applied_at),
    outcome_detail: typeof row.outcome_detail === "string" ? row.outcome_detail : null,
  };
}

