import { hasArchivedResponsibility } from "./work-unit-worker.js";
import { mutateWorkUnit } from "./work-unit-history.js";
import type { SessionExecutionObservation } from "./contracts.js";
import { formatExecutionEvidence } from "./session-execution-format.js";
import { recordResponsibilityTransfer } from "./responsibility.js";

import type { Db } from "./db.js";
import type { WorkUnit } from "./contracts.js";
import { shortRef } from "./entity-refs.js";
import { LedgerStore } from "./ledger/store.js";
import type { LedgerAttributionInput } from "./ledger/types.js";
import {
  resolveSessionAlias,
  type LivenessState,
  type ProviderTaskLivenessReader,
} from "./session-liveness.js";
import { withFreshCodexTaskLiveness } from "./codex-task-liveness.js";
import type { SessionManager } from "./session-manager.js";
import {
  computeWorkUnitLiveness,
  mapWorkUnitRow,
  workUnitSessionIds,
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
 * could not complete, or a unit with no session identity is `unknown`. Liveness
 * is informational for an explicit responsibility transfer.
 */
export interface HolderLiveness {
  state: HolderLivenessState;
  responsibility_retained?: boolean;
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
    responsibility_retained: hasArchivedResponsibility(db, unit),
    execution,
    session_id: liveness.agent_session_id,
    status: liveness.agent_status,
    last_activity: liveness.last_activity,
  };
  if (liveness.state !== "stopped") return { state: liveness.state, ...observed };
  for (const id of sessionIdentities(unit)) {
    const resolution = resolver(db, id);
    if (!resolution || resolution.liveness !== "stopped") continue;
    const targetProvider = unit.assignment_target?.kind === "native" ? unit.assignment_target.provider : null;
    const bindingProvider = targetProvider ?? unit.worker_provider;
    const provider = bindingProvider === "claude_code" ? "claude" : bindingProvider
      ?? (unit.assigned_session_id || unit.assignment_target ? null : unit.provider);
    if (provider && resolution.provider && resolution.provider !== provider) continue;
    const status = resolution.mandible_status ?? resolution.console_status;
    // The shared rule also calls a bare transcript stopped; only a recorded
    // session or a completed Codex lock scan is evidence of a stop here.
    if (!status && resolution.provider !== "codex") continue;
    return {
      state: "stopped",
      responsibility_retained: observed.responsibility_retained,
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
  return workUnitSessionIds(unit);
}

export interface CustodyHolder {
  user_id: string | null;
  user_slug: string | null;
  session_id: string | null;

}

export function describeCustodyHolder(db: Db, userId: string | null, sessionId: string | null): CustodyHolder {
  const user = userId ? db.prepare("SELECT slug FROM users WHERE id = ?").get(userId) as { slug: string } | undefined : undefined;
  return { user_id: userId, user_slug: user?.slug ?? null, session_id: sessionId };
}
export function holderLabel(holder: CustodyHolder): string {
  return holder.user_id ? `${holder.user_slug ?? holder.user_id} (session ${holder.session_id?.slice(0, 8) ?? "local user"})` : "nobody";
}

export function livenessLabel(liveness: HolderLiveness): string {
  const session = liveness.session_id ? `session ${liveness.session_id.slice(0, 8)}` : "no recorded session";
  const status = liveness.status ? `, ${liveness.status}` : "";
  const last = liveness.last_activity ? `, last active ${new Date(liveness.last_activity).toISOString().slice(0, 16).replace("T", " ")} UTC` : "";
  const meaning = liveness.state === "live" ? "is live"
    : liveness.state === "stopped" ? "has stopped"
    : "has unknown liveness";
  return `${meaning}${liveness.responsibility_retained ? "; visibility archive preserves its unresolved responsibility" : ""} (${session}${status}${last})${formatExecutionEvidence(liveness.execution)}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/** The exact custody-assume command for this unit at its current generation. */
export function takeoverCommand(
  db: Db,
  unit: WorkUnit,
): string {
  const reason = `Continue ${unit.branch ?? unit.issue_id}; take over custody.`;
  return [
    "mandible work-unit custody-assume",
    `--id ${shortRef(db, "work_unit", unit.id)}`,
    `--expected-generation ${unit.custody_generation}`,
    `--reason ${shellQuote(reason)}`,
  ].join(" ");
}

export type CustodyAuthorityPath = "explicit_assumption" | "handoff";
export class CustodyGenerationConflict extends Error {
  constructor() { super("Work-unit responsibility changed; refresh and retry."); }
}
export interface CustodyTransferInput {
  unit: WorkUnit;
  expected_generation: number;
  new_user_id: string | null;
  new_session_id: string | null;
  authority_path: CustodyAuthorityPath;
  reason: string;
  comment_attribution: LedgerAttributionInput | null;
}
export function transferWorkUnitCustody(db: Db, input: CustodyTransferInput): WorkUnit {
  const { unit } = input;
  const generation = input.expected_generation + 1;
  db.transaction(() => {
    const changed = mutateWorkUnit(db, unit.id, () => db.prepare(`UPDATE work_units
      SET owner_user_id = ?, responsibility_session_id = ?, custody_generation = ?
      WHERE id = ? AND custody_generation = ?`)
      .run(input.new_user_id, input.new_session_id, generation, unit.id, input.expected_generation), input.comment_attribution);
    if (changed.changes !== 1) throw new CustodyGenerationConflict();
    recordResponsibilityTransfer(db, { kind: "work_unit", id: unit.id,
      prior: unit.owner_user_id ? { user_id: unit.owner_user_id, session_id: unit.responsibility_session_id } : null,
      next: input.new_user_id ? { user_id: input.new_user_id, session_id: input.new_session_id } : null,
      generation, reason: input.reason });
    if (unit.ledger_issue_id) new LedgerStore(db).addComment(unit.ledger_issue_id, {
      body: `Work-unit responsibility ${input.new_user_id ? "transferred to session " + (input.new_session_id?.slice(0, 8) ?? "(local user)") : "relinquished"}. Reason: ${input.reason}\n\nGeneration ${input.expected_generation} → ${generation}. Existing execution and human approval requirements remain in force.`,
      source: "mandible", author_display: "Mandible responsibility", attribution: input.comment_attribution,
    });
  })();
  return mapWorkUnitRow(db.prepare("SELECT * FROM work_units WHERE id = ?").get(unit.id) as Record<string, unknown>);
}
