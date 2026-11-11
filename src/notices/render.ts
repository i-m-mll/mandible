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

type UnfinishedState = Exclude<OutcomeStep["state"], "done" | "skipped">;

const STATE_LABELS: Record<UnfinishedState, string> = {
  pending: "Pending", failed: "Failed", withheld: "Withheld", kept: "Kept",
};

const MAX_REASON = 120;

function short(id: string): string {
  return id.slice(0, 8);
}

/** A reason as one bounded line; the request itself holds the rest. */
function brief(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > MAX_REASON ? `${line.slice(0, MAX_REASON - 1)}…` : line;
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function status(report: OutcomeReport): string {
  const why = (prefix: string) => report.reason ? `${prefix}: ${brief(report.reason)}` : prefix;
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
  if (step.kind === "preview_teardown" && step.reason === "not_merged") return BRANCH_REASONS.not_merged(base);
  return step.reason ? brief(step.reason.replaceAll("_", " ")) : null;
}

/** A teardown's members are branch names, like branch removal's; its label says which. */
function label(step: OutcomeStep, unfinished: UnfinishedState, base: string): string {
  const state = step.kind === "preview_teardown" ? `${STATE_LABELS[unfinished]} teardown` : STATE_LABELS[unfinished];
  const why = reason(step, base);
  return why ? `${state}, ${why}` : state;
}

/**
 * The notice for one request, in a few lines: its status and what was done on
 * line 1, then one line per group of steps that are not done. `base` is the
 * request's base branch, named by the "commits not in" reason.
 */
export function renderNotice(report: OutcomeReport, responsibleAgent: AmbientProviderIdentity, base: string): string {
  const done = { issues: 0, branches: 0, previews: 0, hooks: 0 };
  const groups = new Map<string, string[]>();
  for (const step of report.steps) {
    if (step.state === "skipped") continue;
    if (step.state === "done") {
      if (step.kind === "action" && step.action === "issue_close") done.issues++;
      else if (step.kind === "branch_removal") done.branches++;
      else if (step.kind === "preview_teardown") done.previews++;
      else if (step.kind === "hook") done.hooks++;
      continue;
    }
    const group = label(step, step.state, base);
    groups.set(group, [...groups.get(group) ?? [], member(step)]);
  }
  const counts = [
    done.issues ? count(done.issues, "issue closed", "issues closed") : null,
    done.branches ? count(done.branches, "branch and worktree removed", "branches and worktrees removed") : null,
    done.previews ? count(done.previews, "preview torn down", "previews torn down") : null,
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
