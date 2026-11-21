/**
 * Issue 9395f25 — the issues a merge request lands, and what becomes of each.
 *
 * At submission the request is accounted relative to `head ^base`: every issue
 * whose work the merge brings is either closing, kept open with a stated
 * remainder, or held open by its structure (an open child, or work the head
 * does not contain). An issue that is none of these is undecided, and the
 * request is refused until it is decided.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { Db } from "./db.js";
import { authGitEnv } from "./auth-context.js";
import type { AccountedIssue, IssueAccounting } from "./contracts.js";

export type { AccountedIssue, IssueAccounting };

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 10_000;

export interface UndecidedIssue extends AccountedIssue {
  worker_status: string;
}

export type IssueAccountingRefusal =
  | { kind: "undecided"; issues: UndecidedIssue[] }
  | { kind: "held_closure"; issue: IssueAccounting["held"][number]; flag: "--closes-issue" | "--keeps-open" }
  | { kind: "conflicting_decision"; issue: AccountedIssue };

export type IssueAccountingResult =
  | { ok: true; accounting: IssueAccounting }
  | { ok: false; refusals: IssueAccountingRefusal[]; accounting: IssueAccounting };

export interface LandedScanInput {
  projectId: string;
  /** A checkout of the request's repository, where its Git objects live. */
  gitRoot: string;
  baseSha: string;
  headSha: string;
  /** The issue of the request's delivery work unit. */
  ownIssueId: string | null;
  closes: ReadonlySet<string>;
  keepsOpen: ReadonlyMap<string, string>;
}

interface IssueRow {
  id: string;
  short_id: string;
  title: string;
  status: string;
  worker_status: string;
  kind: string;
}

interface UnitRow {
  id: string;
  ledger_issue_id: string;
  state: "open" | "committed" | "resolved";
  branch: string | null;
  landed_commit: string | null;
  snapshot: string | null;
}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: root, env: authGitEnv(), encoding: "utf8", timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024,
  });
  return String(stdout);
}

/** The commit `refs/heads/<branch>` names in the first checkout that has it. */
export async function branchTip(roots: readonly string[], branch: string): Promise<string | null> {
  for (const root of roots) {
    if (!path.isAbsolute(root) || !fs.existsSync(root)) continue;
    try {
      const sha = (await git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`])).trim().toLowerCase();
      if (sha) return sha;
    } catch {
      continue;
    }
  }
  return null;
}

const NEVER_ACCOUNTED_KINDS = new Set(["tracker", "maintenance"]);

/**
 * Account for every issue the merge of `headSha` into `baseSha` lands. Git
 * failures throw: a request whose landed set cannot be read is not submitted.
 */
export async function accountLandedIssues(db: Db, input: LandedScanInput): Promise<IssueAccountingResult> {
  const [revList, refs] = await Promise.all([
    git(input.gitRoot, ["rev-list", input.headSha, `^${input.baseSha}`]),
    git(input.gitRoot, ["for-each-ref", "--format=%(objectname) %(refname:short)", "refs/heads"]),
  ]);
  const landed = new Set(revList.split("\n").map((line) => line.trim().toLowerCase()).filter(Boolean));
  const tips = new Map<string, string>();
  for (const line of refs.split("\n")) {
    const space = line.indexOf(" ");
    if (space > 0) tips.set(line.slice(space + 1).trim(), line.slice(0, space).toLowerCase());
  }

  const units = db.prepare(
    `SELECT wu.id, wu.ledger_issue_id, wu.state, wu.branch, wu.landed_commit,
            (SELECT b.last_commit_hash FROM branches b
               JOIN ledger_project_checkouts c ON c.root = b.repo_root AND c.project_id = i.project_id
              WHERE b.branch = wu.branch AND b.last_commit_hash IS NOT NULL
              ORDER BY b.repo_root LIMIT 1) AS snapshot
       FROM work_units wu
       JOIN ledger_issues i ON i.id = wu.ledger_issue_id
      WHERE i.project_id = ? AND wu.state IN ('open', 'committed', 'resolved')`,
  ).all(input.projectId) as UnitRow[];
  const unitsByIssue = new Map<string, UnitRow[]>();
  for (const unit of units) {
    const list = unitsByIssue.get(unit.ledger_issue_id) ?? [];
    list.push(unit);
    unitsByIssue.set(unit.ledger_issue_id, list);
  }
  const tipOf = (unit: UnitRow) => (unit.branch ? tips.get(unit.branch) ?? unit.snapshot?.toLowerCase() ?? null : null);

  const issueStmt = db.prepare("SELECT id, short_id, title, status, worker_status, kind FROM ledger_issues WHERE id = ? AND deleted_at IS NULL");
  const issues = new Map<string, IssueRow | null>();
  const issue = (id: string): IssueRow | null => {
    if (!issues.has(id)) issues.set(id, (issueStmt.get(id) as IssueRow | undefined) ?? null);
    return issues.get(id)!;
  };
  const accountable = (id: string) => {
    const row = issue(id);
    return Boolean(row && row.status === "open" && !NEVER_ACCOUNTED_KINDS.has(row.kind));
  };
  const edges = (sql: string) => {
    const stmt = db.prepare(sql);
    const cache = new Map<string, string[]>();
    return (id: string) => {
      if (!cache.has(id)) cache.set(id, (stmt.all(id) as Array<{ id: string }>).map((row) => row.id));
      return cache.get(id)!;
    };
  };
  const liveEdge = "+e.source_entity_type = 'issue' AND +e.target_entity_type = 'issue' AND e.deleted_at IS NULL";
  const childrenOf = edges(`SELECT e.target_issue_id AS id FROM ledger_relationship_edges e
    WHERE e.source_issue_id = ? AND +e.link_type = 'parent_child' AND ${liveEdge} ORDER BY e.created_at, e.id`);
  const parentsOf = edges(`SELECT e.source_issue_id AS id FROM ledger_relationship_edges e
    WHERE e.target_issue_id = ? AND +e.link_type = 'parent_child' AND ${liveEdge} ORDER BY e.created_at, e.id`);
  const fixedBySourcesOf = edges(`SELECT e.source_issue_id AS id FROM ledger_relationship_edges e
    WHERE e.target_issue_id = ? AND +e.link_type = 'fixed_by' AND ${liveEdge} ORDER BY e.created_at, e.id`);
  const openChildren = (id: string) => childrenOf(id).filter((child) => issue(child)?.status === "open");

  const contained = new Map<string, Promise<boolean>>();
  const headContains = (sha: string): Promise<boolean> => {
    if (landed.has(sha)) return Promise.resolve(true);
    if (!contained.has(sha)) {
      contained.set(sha, execFileAsync("git", ["merge-base", "--is-ancestor", sha, input.headSha], {
        cwd: input.gitRoot, env: authGitEnv(), timeout: GIT_TIMEOUT_MS,
      }).then(() => true, (error: { code?: unknown }) => {
        if (error.code === 1) return false;
        throw error;
      }));
    }
    return contained.get(sha)!;
  };
  const unmergedUnits = new Map<string, Array<{ id: string; branch: string | null }>>();
  const readUnmergedUnits = async (id: string) => {
    if (!unmergedUnits.has(id)) {
      const result: Array<{ id: string; branch: string | null }> = [];
      for (const unit of unitsByIssue.get(id) ?? []) {
        if (unit.state === "resolved") continue;
        // A unit whose branch is gone without a scanner snapshot names no work
        // to hold the issue by; the finalizer resolves it with the issue.
        const tip = tipOf(unit);
        if (tip && !(await headContains(tip))) result.push({ id: unit.id, branch: unit.branch });
      }
      unmergedUnits.set(id, result);
    }
    return unmergedUnits.get(id)!;
  };

  const set = new Set<string>();
  const add = (id: string) => {
    if (set.has(id) || !accountable(id)) return false;
    set.add(id);
    return true;
  };
  for (const unit of units) {
    const commit = unit.state === "resolved" ? unit.landed_commit : tipOf(unit);
    if (commit && landed.has(commit.toLowerCase())) add(unit.ledger_issue_id);
  }
  if (input.ownIssueId) add(input.ownIssueId);
  for (const id of [...input.closes, ...input.keepsOpen.keys()]) add(id);

  type Outcome = "closing" | "kept_open" | "held" | "undecided";
  const evaluate = async () => {
    const outcomes = new Map<string, Outcome>();
    const order: string[] = [];
    const visiting = new Set<string>();
    const outcomeOf = async (id: string): Promise<Outcome> => {
      const known = outcomes.get(id);
      if (known) return known;
      if (visiting.has(id)) return "held";
      visiting.add(id);
      let holds = (await readUnmergedUnits(id)).length > 0;
      for (const child of openChildren(id)) {
        if (!set.has(child) || (await outcomeOf(child)) !== "closing") holds = true;
      }
      const row = issue(id)!;
      const outcome: Outcome = holds ? "held"
        : input.keepsOpen.has(id) ? "kept_open"
          : input.closes.has(id) || row.worker_status === "done" ? "closing"
            : "undecided";
      visiting.delete(id);
      outcomes.set(id, outcome);
      order.push(id);
      return outcome;
    };
    for (const id of set) await outcomeOf(id);
    return { outcomes, order };
  };

  for (;;) {
    let grew = false;
    for (const id of [...set]) {
      const provisional = (await readUnmergedUnits(id)).length === 0 && !input.keepsOpen.has(id)
        && (input.closes.has(id) || issue(id)!.worker_status === "done");
      if (!provisional) continue;
      for (const child of openChildren(id)) grew = add(child) || grew;
      for (const source of fixedBySourcesOf(id)) grew = add(source) || grew;
    }
    if (grew) continue;
    const { outcomes } = await evaluate();
    for (const [id, outcome] of outcomes) {
      if (outcome !== "closing") continue;
      for (const parent of parentsOf(id)) {
        if (set.has(parent) || !accountable(parent) || issue(parent)!.worker_status !== "done") continue;
        if (!(unitsByIssue.get(parent) ?? []).some((unit) => unit.state === "resolved")) continue;
        if ((await readUnmergedUnits(parent)).length > 0) continue;
        if (openChildren(parent).every((child) => set.has(child) && outcomes.get(child) === "closing")) grew = add(parent) || grew;
      }
    }
    if (!grew) break;
  }

  const { outcomes, order: evaluated } = await evaluate();
  const heights = new Map<string, number>();
  const heightOf = (id: string, seen: Set<string> = new Set()): number => {
    const known = heights.get(id);
    if (known !== undefined) return known;
    if (seen.has(id)) return 0;
    seen.add(id);
    const below = openChildren(id).filter((child) => outcomes.get(child) === "closing").map((child) => heightOf(child, seen));
    const height = below.length === 0 ? 0 : 1 + Math.max(...below);
    heights.set(id, height);
    return height;
  };
  const named = new Map([...input.closes].map((id, index) => [id, index]));
  const position = new Map(evaluated.map((id, index) => [id, index]));
  const order = [...evaluated].sort((a, b) => heightOf(a) - heightOf(b)
    || (named.get(a) ?? Infinity) - (named.get(b) ?? Infinity)
    || position.get(a)! - position.get(b)!);
  const described = (id: string): AccountedIssue => {
    const row = issue(id)!;
    return { issue: row.short_id || row.id, issue_id: row.id, title: row.title };
  };
  const accounting: IssueAccounting = { closing: [], kept_open: [], held: [] };
  const undecided: UndecidedIssue[] = [];
  const refusals: IssueAccountingRefusal[] = [];
  for (const id of order) {
    const outcome = outcomes.get(id)!;
    if (input.closes.has(id) && input.keepsOpen.has(id)) refusals.push({ kind: "conflicting_decision", issue: described(id) });
    if (outcome === "closing") {
      accounting.closing.push({ ...described(id), by: input.closes.has(id) ? "closes_issue" : "done" });
    } else if (outcome === "kept_open") {
      accounting.kept_open.push({ ...described(id), remainder: input.keepsOpen.get(id)! });
    } else if (outcome === "held") {
      const held = {
        ...described(id),
        open_children: openChildren(id).filter((child) => outcomes.get(child) !== "closing").map((child) => issue(child)!.short_id),
        unmerged_units: await readUnmergedUnits(id),
      };
      accounting.held.push(held);
      if (input.closes.has(id)) refusals.push({ kind: "held_closure", issue: held, flag: "--closes-issue" });
      if (input.keepsOpen.has(id)) refusals.push({ kind: "held_closure", issue: held, flag: "--keeps-open" });
    } else {
      undecided.push({ ...described(id), worker_status: issue(id)!.worker_status });
    }
  }
  if (undecided.length > 0) refusals.unshift({ kind: "undecided", issues: undecided });
  return refusals.length > 0 ? { ok: false, refusals, accounting } : { ok: true, accounting };
}

function holdsOf(issue: IssueAccounting["held"][number]): string {
  const parts: string[] = [];
  if (issue.open_children.length > 0) parts.push(`open children ${issue.open_children.join(", ")}`);
  if (issue.unmerged_units.length > 0) {
    parts.push(`work the head does not contain (${issue.unmerged_units.map((unit) => `${unit.id.slice(0, 8)} on ${unit.branch ?? "no branch"}`).join(", ")})`);
  }
  return parts.join(" and ");
}

export function describeAccountingRefusals(refusals: readonly IssueAccountingRefusal[]): string {
  const lines: string[] = [];
  for (const refusal of refusals) {
    switch (refusal.kind) {
      case "undecided":
        lines.push(`This merge lands ${refusal.issues.length === 1 ? "an issue" : `${refusal.issues.length} issues`} with no decision. Pass one flag for each:`);
        for (const issue of refusal.issues) {
          lines.push(`  ${issue.issue} ${issue.title} (worker status ${issue.worker_status}):`);
          lines.push(`    --closes-issue ${issue.issue}   or   --keeps-open ${issue.issue}=<what remains>`);
        }
        break;
      case "held_closure":
        lines.push(`${refusal.flag} ${refusal.issue.issue} refused: ${refusal.issue.issue} stays open after this merge, held by ${holdsOf(refusal.issue)}. Drop the flag.`);
        break;
      case "conflicting_decision":
        lines.push(`${refusal.issue.issue} is named by both --closes-issue and --keeps-open; pass one.`);
        break;
    }
  }
  return lines.join("\n");
}
