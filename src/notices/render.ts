import type { AmbientProviderIdentity } from "../ambient-provider-identity.js";
import type { BranchKeptReason, OutcomeReport, OutcomeStep } from "./contract.js";

const MAX_MEMBERS = 10;

const BRANCH_REASONS: Record<BranchKeptReason, (base: string) => string> = {
  not_merged: (base) => `commits not in ${base}`,
  preview_running: () => "preview running",
  uncommitted_changes: () => "uncommitted changes",
  protected: () => "protected branch",
  app_managed: () => "app-managed worktree",
  trash_refused: () => "removal refused",
};

const STATE_LABELS: Record<Exclude<OutcomeStep["state"], "done" | "skipped">, string> = {
  pending: "Pending", failed: "Failed", withheld: "Withheld", kept: "Kept",
};

function short(id: string): string {
  return id.slice(0, 8);
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function status(report: OutcomeReport): string {
  const why = (prefix: string) => report.reason ? `${prefix}: ${report.reason}` : prefix;
  switch (report.status) {
    case "completed": return report.merge_commit ? `merged as ${short(report.merge_commit)}` : "completed";
    case "rejected": return why("rejected");
    case "failed": return why("failed");
    case "superseded": return report.reason ? `superseded by ${short(report.reason)}` : "superseded";
    case "needs_rebase": return "needs rebase";
    default: return report.status;
  }
}

function member(step: OutcomeStep): string {
  switch (step.kind) {
    case "action": return step.issue;
    case "finalizer": return step.step;
    case "hook": return step.hook_id;
    case "branch_removal":
    case "preview_teardown": return step.branch;
  }
}

function reason(step: OutcomeStep, base: string): string | null {
  if (step.kind === "branch_removal" && step.reason) return BRANCH_REASONS[step.reason](base);
  return step.reason?.replaceAll("_", " ") ?? null;
}

/**
 * The notice for one request, in a few lines: its status and what was done on
 * line 1, then one line per group of steps that are not done. `base` is the
 * request's base branch, named by the "commits not in" reason.
 */
export function renderNotice(report: OutcomeReport, responsibleAgent: AmbientProviderIdentity, base: string): string {
  const done = { issues: 0, branches: 0, hooks: 0 };
  const groups = new Map<string, string[]>();
  for (const step of report.steps) {
    if (step.state === "skipped") continue;
    if (step.state === "done") {
      if (step.kind === "action" && step.action === "issue_close") done.issues++;
      else if (step.kind === "branch_removal") done.branches++;
      else if (step.kind === "hook") done.hooks++;
      continue;
    }
    const why = reason(step, base);
    const label = why ? `${STATE_LABELS[step.state]}, ${why}` : STATE_LABELS[step.state];
    groups.set(label, [...groups.get(label) ?? [], member(step)]);
  }
  const counts = [
    done.issues ? count(done.issues, "issue closed", "issues closed") : null,
    done.branches ? count(done.branches, "branch and worktree removed", "branches and worktrees removed") : null,
    done.hooks ? count(done.hooks, "hook passed", "hooks passed") : null,
  ].filter((part): part is string => part !== null);
  let first = `Mandible: auth ${short(report.request_id)} ${status(report)}.`;
  if (counts.length) first += ` ${groups.size ? "Done" : "All follow-ups done"}: ${counts.join(", ")}.`;
  if (responsibleAgent.agent_id && responsibleAgent.agent_id !== responsibleAgent.session_id) {
    first += ` (submitted by agent ${responsibleAgent.agent_id})`;
  }
  const lines = [first];
  for (const [label, members] of groups) {
    const shown = members.slice(0, MAX_MEMBERS).join(" ");
    const more = members.length > MAX_MEMBERS ? ` +${members.length - MAX_MEMBERS} more` : "";
    lines.push(`${label} (${members.length}): ${shown}${more}`);
  }
  if (groups.size) lines.push(`More: mandible auth show ${short(report.request_id)}`);
  return lines.join("\n");
}
