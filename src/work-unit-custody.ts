import { mutateWorkUnit } from "./work-unit-history.js";
import { requestOriginJson } from "./request-origin.js";
import type { SessionExecutionObservation } from "./contracts.js";
import { formatExecutionEvidence } from "./session-execution-format.js";
// Issue 72b00f8 — one custody rule for work units, shared by the custody routes,
// the custody check that commit wrappers call, and the operator-approved
// custody-transfer auth request.
//
// Custody belongs to one durable credential. Another active agent credential
// with project write access may take over a solo or partition unit when the
// unit's recorded holder session is provably stopped. A live holder, or a holder
// whose liveness Mandible cannot establish, blocks: the agent asks the operator,
// who approves a custody-transfer auth request that hands custody to that agent.
//
// Within one credential (every session of one agent app shares it), the unit's
// recorded session holds the unit under the same rule. Session ids are claimed
// attribution, not credentials: session-level holding coordinates cooperating
// agents and is not a security boundary.

import { randomUUID } from "node:crypto";

import type { Db } from "./db.js";
import type { WorkUnit } from "./contracts.js";
import type { AuthRequest } from "./types.js";
import { shortRef } from "./entity-refs.js";
import { LedgerStore } from "./ledger/store.js";
import type { LedgerAttributionInput } from "./ledger/types.js";
import { evaluateProjectAccess } from "./permissions/store.js";
import { resolveProjectRef } from "./ledger/project-registry.js";
import {
  resolveSessionAlias,
  type LivenessState,
  type ProviderTaskLivenessReader,
} from "./session-liveness.js";
import { readCodexTaskLiveness, withFreshCodexTaskLiveness } from "./codex-task-liveness.js";
import type { SessionManager } from "./session-manager.js";
import { PRODUCTION_EFFECTS } from "./security/effect-policy.js";
import {
  computeWorkUnitLiveness,
  mapWorkUnitRow,
  type WorkUnitSessionResolver,
} from "./work-unit-utils.js";

export type HolderLivenessState = LivenessState;

/**
 * Whether the session recorded on a work unit is still working.
 *
 * `stopped` needs positive evidence for the unit's own session identity: a
 * recorded Mandible or console session, none of them live, or, for an indexed
 * Codex thread with no such record, a completed thread-writer lock scan that
 * finds no Codex process holding the thread's lock. A Claude or Gemini
 * transcript alone, an id Mandible never registered, a liveness check that
 * could not complete, or a unit with no session identity is `unknown`, which
 * blocks takeover exactly like `live`.
 */
export interface HolderLiveness {
  state: HolderLivenessState;
  session_id: string | null;
  status: string | null;
  last_activity: number | null;
  execution?: SessionExecutionObservation | null;
}

export function classifyHolderLiveness(
  db: Db,
  unit: WorkUnit,
  sessionManager: SessionManager | undefined,
  readCodexTask: ProviderTaskLivenessReader,
): HolderLiveness {
  const resolver: WorkUnitSessionResolver = (database, id) =>
    resolveSessionAlias(database, id, { readCodexTaskLiveness: readCodexTask });
  const liveness = computeWorkUnitLiveness(db, unit, sessionManager, resolver);
  const execution = liveness.agent_session_id ? resolver(db, liveness.agent_session_id)?.execution ?? null : null;
  const observed = {
    execution,
    session_id: liveness.agent_session_id,
    status: liveness.agent_status,
    last_activity: liveness.last_activity,
  };
  if (liveness.state !== "stopped") return { state: liveness.state, ...observed };
  for (const id of sessionIdentities(unit)) {
    const resolution = resolver(db, id);
    if (!resolution || resolution.liveness !== "stopped") continue;
    if (unit.provider && resolution.provider && resolution.provider !== unit.provider) continue;
    const status = resolution.mandible_status ?? resolution.console_status;
    // The shared rule also calls a bare transcript stopped; only a recorded
    // session or a completed Codex lock scan is evidence of a stop here.
    if (!status && resolution.provider !== "codex") continue;
    return {
      state: "stopped",
      execution: resolution.execution ?? null,
      session_id: resolution.mandible_session_id ?? resolution.console_session_id ?? id,
      status,
      last_activity: parseTime(resolution.last_activity),
    };
  }
  return { state: "unknown", ...observed };
}

/**
 * The Codex reader for holder decisions about `units`: every lock scan those
 * decisions read started after this call and completed, off the event loop,
 * before the reader is returned.
 */
export function freshHolderReader(
  db: Db,
  units: readonly WorkUnit[],
  sessionManager: SessionManager | undefined,
): Promise<ProviderTaskLivenessReader> {
  return withFreshCodexTaskLiveness((read) => {
    for (const unit of units) classifyHolderLiveness(db, unit, sessionManager, read);
    return read;
  });
}

function parseTime(value: string | null): number | null {
  const time = value ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? time : null;
}

function sessionIdentities(unit: WorkUnit): string[] {
  return Array.from(new Set([unit.assigned_session_id, unit.worker_provider_session_id, unit.provider_session_id]
    .filter((value): value is string => Boolean(value))));
}

/**
 * Session-level holding for a caller whose credential already holds the unit.
 * `clear` when the unit records no session, when the caller's session is one of
 * the recorded sessions, or when the caller has no session id to compare
 * (`unverifiable`). Otherwise the recorded session's liveness decides, exactly
 * as for another credential's holder.
 */
export type SessionHolding =
  | { state: "clear"; unverifiable: boolean; liveness: HolderLiveness | null }
  | { state: HolderLivenessState; liveness: HolderLiveness };

export function sameCredentialSessionHolding(
  db: Db,
  unit: WorkUnit,
  callerSessionId: string | null,
  sessionManager: SessionManager | undefined,
  readCodexTask: ProviderTaskLivenessReader,
): SessionHolding {
  const recorded = sessionIdentities(unit);
  if (recorded.length === 0) return { state: "clear", unverifiable: false, liveness: null };
  if (!callerSessionId) {
    return { state: "clear", unverifiable: true, liveness: classifyHolderLiveness(db, unit, sessionManager, readCodexTask) };
  }
  const caller = resolveSessionAlias(db, callerSessionId);
  const matches = recorded.some((id) => {
    if (id === callerSessionId) return true;
    const resolution = resolveSessionAlias(db, id);
    return Boolean(resolution && (resolution.provider_session_id === callerSessionId
      || (resolution.mandible_session_id && resolution.mandible_session_id === caller?.mandible_session_id)));
  });
  if (matches) return { state: "clear", unverifiable: false, liveness: null };
  const liveness = classifyHolderLiveness(db, unit, sessionManager, readCodexTask);
  return { state: liveness.state, liveness };
}

export interface CustodyHolder {
  user_id: string | null;
  user_slug: string | null;
  credential_id: string | null;
  /** Ambiguity-safe short credential id for people. */
  credential_ref: string | null;
}

export function describeCustodyHolder(db: Db, userId: string | null, credentialId: string | null): CustodyHolder {
  const user = userId
    ? db.prepare("SELECT slug FROM users WHERE id = ?").get(userId) as { slug: string } | undefined
    : undefined;
  return {
    user_id: userId,
    user_slug: user?.slug ?? null,
    credential_id: credentialId,
    credential_ref: credentialId ? shortCredentialRef(db, credentialId) : null,
  };
}

function shortCredentialRef(db: Db, credentialId: string): string {
  return shortRef(db, "credential", credentialId);
}

export function holderLabel(holder: CustodyHolder): string {
  if (!holder.credential_id) return holder.user_slug ? `${holder.user_slug} (no credential)` : "nobody";
  return `${holder.user_slug ?? holder.user_id ?? "unknown user"} (credential ${holder.credential_ref})`;
}

export function livenessLabel(liveness: HolderLiveness): string {
  const session = liveness.session_id ? `session ${liveness.session_id.slice(0, 8)}` : "no recorded session";
  const status = liveness.status ? `, ${liveness.status}` : "";
  const last = liveness.last_activity ? `, last active ${new Date(liveness.last_activity).toISOString().slice(0, 16).replace("T", " ")} UTC` : "";
  const meaning = liveness.state === "live" ? "is live"
    : liveness.state === "stopped" ? "has stopped"
    : "has unknown liveness";
  return `${meaning} (${session}${status}${last})${formatExecutionEvidence(liveness.execution)}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/** The exact custody-assume command for this unit at its current generation. */
export function takeoverCommand(
  db: Db,
  unit: WorkUnit,
  options: { requestApproval?: boolean; parentRoleCheckpointId?: string | null } = {},
): string {
  const reason = `Continue ${unit.branch ?? unit.issue_id}; take over custody.`;
  const checkpoint = options.parentRoleCheckpointId ? shortRef(db, "checkpoint", options.parentRoleCheckpointId) : "<checkpoint-id>";
  return [
    "mandible work-unit custody-assume",
    `--id ${shortRef(db, "work_unit", unit.id)}`,
    `--expected-generation ${unit.custody_generation}`,
    `--reason ${shellQuote(reason)}`,
    ...(options.parentRoleCheckpointId !== undefined ? [`--parent-role-checkpoint ${checkpoint}`] : []),
    ...(options.requestApproval ? ["--request-approval"] : []),
  ].join(" ");
}

/**
 * Whether a durable credential may act on a project's work units: the
 * credential is active for its user, and that user has project write access.
 */
export function credentialMayHoldCustody(db: Db, repoId: string, userId: string, credentialId: string): string | null {
  const credential = db.prepare("SELECT status, user_id FROM user_credentials WHERE id = ?")
    .get(credentialId) as { status: string; user_id: string } | undefined;
  if (!credential || credential.status !== "active" || credential.user_id !== userId) {
    return "The requesting credential is not active for its user.";
  }
  const project = resolveProjectRef(db, repoId);
  if (!project.ok) return "Work-unit project identity is not unique.";
  const user = db.prepare("SELECT slug FROM users WHERE id = ?").get(userId) as { slug: string } | undefined;
  if (!user) return "The requesting user no longer exists.";
  const decision = evaluateProjectAccess(db, {
    identity: { user_id: userId, slug: user.slug, method: "api_token", source: "in_process", credential_id: credentialId, effect_ceiling: PRODUCTION_EFFECTS },
    project_id: project.project.id,
    required_role: "write",
  });
  return decision.allowed ? null : "The requesting user lacks write access to the work unit's project.";
}

export type CustodyAuthorityPath =
  | "parent_role_handoff"
  | "operator_recovery"
  | "stopped_holder_takeover"
  | "operator_approval";

export class CustodyGenerationConflict extends Error {
  constructor() {
    super("Work-unit custody changed; refresh and retry.");
  }
}

export interface CustodyTransferInput {
  unit: WorkUnit;
  expected_generation: number;
  new_user_id: string;
  new_credential_id: string;
  authority_path: CustodyAuthorityPath;
  reason: string;
  /** The new holder's session, recorded so the unit's liveness follows the new holder. */
  new_session: { provider: string | null; provider_session_id: string | null };
  parent_role_checkpoint_id?: string | null;
  operator_evidence_method?: string | null;
  auth_request_id?: string | null;
  prior_holder_liveness?: HolderLiveness | null;
  comment_attribution: LedgerAttributionInput | null;
  now?: number;
}

/**
 * Move custody to a new credential with the generation compare-and-swap, the
 * immutable receipt, and one comment on the unit's issue, all in one
 * transaction. The previous holder's session bindings are replaced by the new
 * holder's session, so liveness and later takeover checks follow the holder.
 */
export function transferWorkUnitCustody(db: Db, input: CustodyTransferInput): WorkUnit {
  const now = input.now ?? Date.now();
  const { unit } = input;
  const nextGeneration = input.expected_generation + 1;
  const prior = describeCustodyHolder(db, unit.owner_user_id, unit.owner_credential_id);
  const next = describeCustodyHolder(db, input.new_user_id, input.new_credential_id);
  db.transaction(() => {
    const changed = mutateWorkUnit(db, unit.id, () => db.prepare(`UPDATE work_units
      SET owner_user_id = ?, owner_credential_id = ?, custody_generation = ?,
        provider = ?, provider_session_id = ?, assigned_session_id = NULL, worker_provider_session_id = NULL
      WHERE id = ? AND custody_generation = ? AND owner_user_id IS ? AND owner_credential_id IS ?`)
      .run(input.new_user_id, input.new_credential_id, nextGeneration,
        input.new_session.provider, input.new_session.provider_session_id,
        unit.id, input.expected_generation, unit.owner_user_id, unit.owner_credential_id));
    if (changed.changes !== 1) throw new CustodyGenerationConflict();
    db.prepare(`INSERT INTO work_unit_custody_events
      (request_origin_json, id, work_unit_id, prior_user_id, prior_credential_id, new_user_id, new_credential_id,
       prior_generation, new_generation, authority_path, parent_role_checkpoint_id,
       operator_evidence_method, reason, occurred_at, auth_request_id, prior_holder_liveness_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(requestOriginJson(), randomUUID(), unit.id, unit.owner_user_id, unit.owner_credential_id,
        input.new_user_id, input.new_credential_id, input.expected_generation, nextGeneration,
        input.authority_path, input.parent_role_checkpoint_id ?? null, input.operator_evidence_method ?? null,
        input.reason, now, input.auth_request_id ?? null,
        input.prior_holder_liveness ? JSON.stringify(input.prior_holder_liveness) : null);
    if (unit.ledger_issue_id) {
      new LedgerStore(db).addComment(unit.ledger_issue_id, {
        body: custodyTransferComment(db, input, prior, next, nextGeneration),
        source: "mandible",
        created_at: now,
        author_display: "Mandible work-unit custody",
        attribution: input.comment_attribution,
      });
    }
  })();
  return mapWorkUnitRow(db.prepare("SELECT * FROM work_units WHERE id = ?").get(unit.id) as Record<string, unknown>);
}

function shortSession(id: string | null | undefined): string {
  return id ? id.slice(0, 8) : "(none)";
}

function custodyTransferComment(
  db: Db,
  input: CustodyTransferInput,
  prior: CustodyHolder,
  next: CustodyHolder,
  nextGeneration: number,
): string {
  const branch = input.unit.branch ? `\`${input.unit.branch}\`` : `work unit \`${shortRef(db, "work_unit", input.unit.id)}\``;
  const how = (() => {
    switch (input.authority_path) {
      case "stopped_holder_takeover":
        return `The previous holder's session ${livenessLabel(input.prior_holder_liveness!)}.`;
      case "operator_approval": {
        const ref = shortRef(db, "auth_request", input.auth_request_id!);
        const holder = input.prior_holder_liveness ? ` The previous holder's session ${livenessLabel(input.prior_holder_liveness)}.` : "";
        return `The operator approved this transfer in [auth:${ref}].${holder}`;
      }
      case "operator_recovery":
        return "The operator recovered custody.";
      case "parent_role_handoff":
        return `The umbrella parent role handed custody over (checkpoint \`${input.parent_role_checkpoint_id}\`).`;
    }
  })();
  const moved = prior.credential_id && prior.credential_id === next.credential_id
    ? `moved from session ${shortSession(input.prior_holder_liveness?.session_id)} to session ` +
      `${shortSession(input.new_session.provider_session_id)} of ${holderLabel(next)}`
    : `moved from ${holderLabel(prior)} to ${holderLabel(next)}`;
  return [
    `Work-unit custody of ${branch} ${moved}. ${how}`,
    "",
    `Reason: ${input.reason}`,
    "",
    `Custody generation ${input.expected_generation} → ${nextGeneration}; the previous holder's custody-guarded calls now fail on generation.`,
  ].join("\n");
}

// --- Operator-approved custody transfer (auth request type `custody-transfer`).
//
// The reviewed command is a canonical description, never executed by a shell:
// the daemon applies it in process when the operator approves. Every field the
// transfer needs is in these exact bytes, so the operator approves exactly
// what will happen.

export interface CustodyTransferCommand {
  work_unit_id: string;
  expected_generation: number;
  credential_id: string;
  provider: string | null;
  provider_session_id: string | null;
}

const CUSTODY_TRANSFER_COMMAND_RE =
  /^work-unit custody transfer (\S+) at generation (\d+) to credential (\S+) session (\S+)\/(\S+)$/;

export function formatCustodyTransferCommand(command: CustodyTransferCommand): string {
  return `work-unit custody transfer ${command.work_unit_id} at generation ${command.expected_generation} ` +
    `to credential ${command.credential_id} session ${command.provider ?? "-"}/${command.provider_session_id ?? "-"}`;
}

export function parseCustodyTransferCommand(command: string): CustodyTransferCommand | null {
  const match = CUSTODY_TRANSFER_COMMAND_RE.exec(command);
  if (!match) return null;
  return {
    work_unit_id: match[1]!,
    expected_generation: Number(match[2]),
    credential_id: match[3]!,
    provider: match[4] === "-" ? null : match[4]!,
    provider_session_id: match[5] === "-" ? null : match[5]!,
  };
}

/**
 * Apply an approved custody-transfer request. Every condition is checked again
 * at approval: the unit still sits at the requested generation, it is not an
 * integration unit held by another credential, and the requesting credential is
 * still active with project write access. A refusal changes nothing.
 */
export function applyApprovedCustodyTransfer(
  db: Db,
  request: Pick<AuthRequest, "id" | "command" | "requested_by_user_id" | "requester_credential_id" | "approved_by_user_id" | "execution_evidence_id">,
  sessionManager?: SessionManager,
): { ok: true; work_unit: WorkUnit } | { ok: false; error: string } {
  const command = parseCustodyTransferCommand(request.command);
  if (!command || !request.requested_by_user_id || command.credential_id !== request.requester_credential_id) {
    return { ok: false, error: "The custody-transfer command does not match its requesting credential." };
  }
  const row = db.prepare("SELECT * FROM work_units WHERE id = ?").get(command.work_unit_id) as Record<string, unknown> | undefined;
  if (!row) return { ok: false, error: "The work unit no longer exists." };
  const unit = mapWorkUnitRow(row);
  if (unit.kind === "integration" && unit.owner_credential_id !== command.credential_id) {
    return { ok: false, error: "Integration custody transfers use the parent-role checkpoint or operator recovery." };
  }
  if (unit.custody_generation !== command.expected_generation) {
    return { ok: false, error: `Work-unit custody moved to generation ${unit.custody_generation} after the request; nothing changed.` };
  }
  const refusal = credentialMayHoldCustody(db, unit.repo_id, request.requested_by_user_id, command.credential_id);
  if (refusal) return { ok: false, error: refusal };
  try {
    const transferred = transferWorkUnitCustody(db, {
      unit,
      expected_generation: command.expected_generation,
      new_user_id: request.requested_by_user_id,
      new_credential_id: command.credential_id,
      authority_path: "operator_approval",
      reason: `Operator approved custody-transfer request ${request.id}.`,
      new_session: { provider: command.provider, provider_session_id: command.provider_session_id },
      operator_evidence_method: "credential_signature",
      auth_request_id: request.id,
      // Evidence for the record only: the operator's approval, not this
      // reading, authorizes the transfer.
      prior_holder_liveness: classifyHolderLiveness(db, unit, sessionManager, readCodexTaskLiveness),
      comment_attribution: request.approved_by_user_id
        ? { user_id: request.approved_by_user_id, evidence_method: "credential_signature", evidence_id: request.execution_evidence_id }
        : null,
    });
    return { ok: true, work_unit: transferred };
  } catch (error) {
    if (error instanceof CustodyGenerationConflict) return { ok: false, error: error.message };
    throw error;
  }
}
