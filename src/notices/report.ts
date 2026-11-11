import { convergenceStateFromRuns } from "../auth-hooks.js";
import { FINALIZER_STEP_NAMES } from "../auth-queue.js";
import { extractSuccessfulMergeCommitSha } from "../auth-signature-verification.js";
import { TEARDOWN_NOT_MERGED } from "../declared-preview-teardown.js";
import type { Db } from "../db.js";
import { shortRef } from "../entity-refs.js";
import {
  BRANCH_REMOVAL_OUTPUT,
  NOTICE_STATUSES,
  REMOVE_MERGED_BRANCHES_STEP,
  type OutcomeReport,
  type OutcomeReporter,
  type OutcomeStep,
  type OutcomeStepState,
} from "./contract.js";

type NoticeStatus = OutcomeReport["status"];

interface RequestRow {
  id: string;
  type: string;
  status: string;
  output: string;
  error: string | null;
  superseded_by_request_id: string | null;
  merge_finalizer_state: string | null;
  merge_finalized_at: number | null;
}

interface ActionRow {
  kind: string;
  issue: string;
  state: "staged" | "applied" | "failed" | "vetoed" | "skipped_stale";
  branch: string | null;
  outcome_detail: string | null;
}

interface HookRow {
  hook_id: string;
  required: number;
  state: "pending" | "running" | "complete" | "failed" | "retired";
  exit_code: number | null;
}

interface StoredFinalizerStep {
  state: "pending" | "done" | "failed";
  output?: unknown;
}

const STEP_KIND_ORDER: readonly OutcomeStep["kind"][] = ["action", "finalizer", "hook", "branch_removal", "preview_teardown"];

function isNoticeStatus(status: string): status is NoticeStatus {
  return (NOTICE_STATUSES as readonly string[]).includes(status);
}

function stepSubject(step: OutcomeStep): string {
  switch (step.kind) {
    case "action": return `${step.issue}\u0000${step.action}`;
    case "finalizer": return step.step;
    case "hook": return step.hook_id;
    case "branch_removal": return step.branch;
    case "preview_teardown": return step.branch;
  }
}

function compareSteps(a: OutcomeStep, b: OutcomeStep): number {
  const kind = STEP_KIND_ORDER.indexOf(a.kind) - STEP_KIND_ORDER.indexOf(b.kind);
  if (kind !== 0) return kind;
  const [left, right] = [stepSubject(a), stepSubject(b)];
  return left < right ? -1 : left > right ? 1 : 0;
}

function firstLine(text: string | null): string | null {
  const line = text?.split(/\r?\n/, 1)[0]?.trim();
  return line ? line : null;
}

function actionStep(row: ActionRow, status: NoticeStatus): OutcomeStep {
  const step = (state: OutcomeStepState, reason: string | null): OutcomeStep =>
    ({ kind: "action", action: row.kind, issue: row.issue, state, reason });
  switch (row.state) {
    case "applied": return step("done", null);
    case "failed": return step("failed", null);
    case "vetoed":
    case "skipped_stale": return step("skipped", row.state);
    case "staged":
      if (status === "completed") return step("withheld", "awaiting_convergence");
      if (status === "needs_rebase") return step("withheld", "needs_rebase");
      return step("skipped", status);
  }
}

/**
 * A declared preview teardown. Staged on a completed merge it waits on
 * convergence like a withheld closure, and is pending once convergence no
 * longer holds it.
 */
function previewTeardownStep(row: ActionRow, status: NoticeStatus, convergenceHolds: boolean): OutcomeStep {
  const step = (state: OutcomeStepState, reason: string | null): OutcomeStep =>
    ({ kind: "preview_teardown", branch: row.branch ?? "", state, reason });
  switch (row.state) {
    case "applied": return step("done", null);
    case "failed": return row.outcome_detail === TEARDOWN_NOT_MERGED ? step("kept", TEARDOWN_NOT_MERGED) : step("failed", firstLine(row.outcome_detail));
    case "vetoed":
    case "skipped_stale": return step("skipped", row.state);
    case "staged":
      if (status === "completed") return convergenceHolds ? step("withheld", "awaiting_convergence") : step("pending", null);
      if (status === "needs_rebase") return step("withheld", "needs_rebase");
      return step("skipped", status);
  }
}

function hookStep(row: HookRow): OutcomeStep {
  const step = (state: OutcomeStepState, reason: string | null): OutcomeStep =>
    ({ kind: "hook", hook_id: row.hook_id, required: row.required === 1, state, reason });
  switch (row.state) {
    case "complete": return step("done", null);
    case "pending":
    case "running": return step("pending", null);
    case "failed": return step("failed", row.exit_code == null ? "timed out" : `exit ${row.exit_code}`);
    case "retired": return step("skipped", "retired");
  }
}

/**
 * Finalizer and branch-removal steps of a completed merge. A merge finalized
 * before per-step state was recorded has neither.
 */
function finalizerSteps(request: RequestRow): OutcomeStep[] {
  if (request.merge_finalizer_state == null && request.merge_finalized_at != null) return [];
  const stored = (request.merge_finalizer_state == null
    ? {}
    : JSON.parse(request.merge_finalizer_state)) as Record<string, StoredFinalizerStep | undefined>;
  const steps: OutcomeStep[] = FINALIZER_STEP_NAMES
    .filter((name: string) => name !== REMOVE_MERGED_BRANCHES_STEP)
    .map((name) => {
      const state = stored[name]?.state;
      return { kind: "finalizer", step: name, state: state === "done" || state === "failed" ? state : "pending", reason: null };
    });
  const removal = stored[REMOVE_MERGED_BRANCHES_STEP]?.output;
  if (removal === undefined) return steps;
  for (const entry of BRANCH_REMOVAL_OUTPUT.parse(removal).branches) {
    const state: OutcomeStepState = entry.result === "removed" || entry.result === "trashed" ? "done" : entry.result;
    steps.push({ kind: "branch_removal", branch: entry.branch, state, reason: state === "done" ? null : entry.reason });
  }
  return steps;
}

/** The outcome reporter over `db`: what a settled request did, step by step. */
export function createOutcomeReporter(db: Db): OutcomeReporter {
  const requestQuery = db.prepare(
    `SELECT id, type, status, output, error, superseded_by_request_id, merge_finalizer_state, merge_finalized_at
     FROM auth_requests WHERE id = ?`,
  );
  const rejectionQuery = db.prepare(
    `SELECT reason FROM auth_request_lifecycle_events
     WHERE auth_request_id = ? AND event_type = 'rejected' ORDER BY revision DESC LIMIT 1`,
  );
  const actionsQuery = db.prepare(
    `SELECT a.kind, COALESCE(i.short_id, a.target_issue_ref) AS issue, a.state,
            json_extract(a.payload, '$.branch') AS branch, a.outcome_detail
     FROM auth_request_actions a LEFT JOIN ledger_issues i ON i.id = a.target_issue_ref
     WHERE a.auth_request_id = ? ORDER BY a.ordinal, a.staged_at, a.id`,
  );
  const hooksQuery = db.prepare(
    "SELECT hook_id, required, state, exit_code FROM auth_hook_executions WHERE auth_request_id = ?",
  );

  return (requestId) => {
    const request = requestQuery.get(requestId) as RequestRow | undefined;
    if (!request || !isNoticeStatus(request.status)) return null;
    const status = request.status;
    const completedMerge = status === "completed" && request.type === "merge";

    let reason: string | null = null;
    if (status === "rejected") reason = (rejectionQuery.get(request.id) as { reason: string | null } | undefined)?.reason ?? null;
    else if (status === "failed") reason = firstLine(request.error);
    else if (status === "superseded" && request.superseded_by_request_id) {
      reason = shortRef(db, "auth_request", request.superseded_by_request_id);
    }

    const hooks = hooksQuery.all(request.id) as HookRow[];
    const convergence = convergenceStateFromRuns(hooks.map((hook) => ({ state: hook.state, required: hook.required === 1 })));
    const convergenceHolds = convergence === "pending" || convergence === "failed";
    const steps: OutcomeStep[] = [
      ...(actionsQuery.all(request.id) as ActionRow[]).map((row) => row.kind === "preview_teardown"
        ? previewTeardownStep(row, status, convergenceHolds)
        : actionStep(row, status)),
      ...(completedMerge ? finalizerSteps(request) : []),
      ...hooks.map(hookStep),
    ].sort(compareSteps);

    return {
      request_id: request.id,
      type: request.type,
      status,
      merge_commit: completedMerge ? extractSuccessfulMergeCommitSha(request.output) : null,
      reason,
      steps,
    };
  };
}
