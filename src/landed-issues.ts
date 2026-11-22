/**
 * Issue 9395f25 — the issues a merge request lands, and what becomes of each.
 *
 * At submission the request is accounted relative to `head ^base`: every issue
 * whose work the merge brings is either closing, kept open with a stated
 * remainder, or held open by its structure (an open child, or work the head
 * does not contain). An issue that is none of these is undecided, and the
 * request is refused until it is decided. A decision is independent of the
 * holds: a held issue decided closed closes once the merge finds it released
 * (issue 2927dd8), and one kept open records its remainder.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { Db } from "./db.js";
import { authGitEnv } from "./auth-context.js";
import type { AccountedIssue, ClosureReason, IssueAccounting } from "./contracts.js";
import { protectedBranchNames } from "./protected-branches.js";
import { observeRepoIdentities, requestRepoMatcher, type RequestRepoScope } from "./repo-identity.js";
import { isUnbornBase } from "./auth-context.js";

export type { AccountedIssue, IssueAccounting };

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 10_000;

export interface UndecidedIssue extends AccountedIssue {
  worker_status: string;
}

export type IssueAccountingRefusal =
  | { kind: "undecided"; issues: UndecidedIssue[] }
  | { kind: "conflicting_decision"; issue: AccountedIssue }
  | { kind: "unkeepable"; issue: string };

export type IssueDecision = "close" | "keep_open";

export type IssueAccountingResult =
  | { ok: true; accounting: IssueAccounting }
  | { ok: false; refusals: IssueAccountingRefusal[]; accounting: IssueAccounting };

export interface LandedScanInput {
  /** Derived members come only from this project; none when the repository is not a registered project. */
  projectId: string | null;
  /** The request's repository; work units of another repository are never contained in its head. */
  request: RequestRepoScope;
  /** A checkout of the request's repository, where its Git objects live. */
  gitRoot: string;
  baseSha: string;
  headSha: string;
  /** The issue of the request's delivery work unit. */
  ownIssueId: string | null;
  closes: ReadonlySet<string>;
  keepsOpen: ReadonlyMap<string, string>;
  signal?: AbortSignal;
}

interface IssueRow {
  id: string;
  short_id: string;
  title: string;
  status: string;
  worker_status: string;
  kind: string;
  project_id: string;
}

interface UnitRow {
  id: string;
  ledger_issue_id: string;
  repo_id: string;
  state: "open" | "committed" | "abandoned";
  branch: string | null;
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
 * A commit this repository does not have is not one the head contains.
 */
export async function accountLandedIssues(db: Db, input: LandedScanInput): Promise<IssueAccountingResult> {
  const [revList, refs] = await Promise.all([
    git(input.gitRoot, ["rev-list", input.headSha, ...(isUnbornBase(input.baseSha) ? [] : [`^${input.baseSha}`])]),
    git(input.gitRoot, ["for-each-ref", "--format=%(objectname) %(refname:short)", "refs/heads"]),
  ]);
  const landed = new Set(revList.split("\n").map((line) => line.trim().toLowerCase()).filter(Boolean));
  const tips = new Map<string, string>();
  for (const line of refs.split("\n")) {
    const space = line.indexOf(" ");
    if (space > 0) tips.set(line.slice(space + 1).trim(), line.slice(0, space).toLowerCase());
  }

  // Unresolved units by their branch tip, as the post-merge finalizer tests
  // them; abandoned units count only when they land, as the finalizer then
  // resolves them, and those it retired from merge scans do not.
  const units = db.prepare(
    `SELECT wu.id, wu.ledger_issue_id, wu.repo_id, wu.state, wu.branch
       FROM work_units wu
      WHERE wu.ledger_issue_id IS NOT NULL
        AND (wu.state IN ('open', 'committed') OR (wu.state = 'abandoned' AND wu.branch IS NOT NULL AND wu.merge_scan_retired_at IS NULL))`,
  ).all() as UnitRow[];
  const snapshots = db.prepare(
    `SELECT b.branch, b.repo_root, b.last_commit_hash FROM branches b
      WHERE b.last_commit_hash IS NOT NULL
        AND b.branch IN (SELECT wu.branch FROM work_units wu WHERE wu.state IN ('open', 'committed', 'abandoned') AND wu.branch IS NOT NULL)
      ORDER BY b.repo_root`,
  ).all() as Array<{ branch: string; repo_root: string; last_commit_hash: string }>;
  const repoValues = [...new Set([...units.map((unit) => unit.repo_id), ...snapshots.map((row) => row.repo_root)])];
  const identity = await observeRepoIdentities(db, [input.request.repo, ...repoValues],
    [input.request.target_repo_root, input.request.cwd, ...repoValues], input.signal);
  identity.assertCurrent();
  const sameRepo = requestRepoMatcher(db, input.request, identity);
  const snapshotOf = new Map<string, string>();
  for (const row of snapshots) {
    if (!snapshotOf.has(row.branch) && sameRepo.matches(row.repo_root)) snapshotOf.set(row.branch, row.last_commit_hash.toLowerCase());
  }
  const inRepo = new Map(repoValues.map((value) => [value, sameRepo.matches(value)]));
  const tipOf = (unit: UnitRow) => inRepo.get(unit.repo_id) && unit.branch
    ? tips.get(unit.branch) ?? snapshotOf.get(unit.branch) ?? null
    : null;
  const unitsByIssue = new Map<string, UnitRow[]>();
  for (const unit of units) {
    if (unit.state === "abandoned") continue;
    const list = unitsByIssue.get(unit.ledger_issue_id) ?? [];
    list.push(unit);
    unitsByIssue.set(unit.ledger_issue_id, list);
  }
  const resolvedUnitStmt = db.prepare("SELECT 1 FROM work_units WHERE ledger_issue_id = ? AND state = 'resolved' LIMIT 1");
  const hasResolvedUnit = (id: string) => resolvedUnitStmt.get(id) !== undefined;

  const issueStmt = db.prepare("SELECT id, short_id, title, status, worker_status, kind, project_id FROM ledger_issues WHERE id = ? AND deleted_at IS NULL");
  const issues = new Map<string, IssueRow | null>();
  const issue = (id: string): IssueRow | null => {
    if (!issues.has(id)) issues.set(id, (issueStmt.get(id) as IssueRow | undefined) ?? null);
    return issues.get(id)!;
  };
  const accountable = (id: string) => {
    const row = issue(id);
    return Boolean(row && row.status === "open" && !NEVER_ACCOUNTED_KINDS.has(row.kind));
  };
  const derivable = (id: string) => input.projectId !== null && accountable(id) && issue(id)!.project_id === input.projectId;
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
      }).then(() => true, async (error: { code?: unknown }) => {
        if (error.code === 1) return false;
        if (!(await commitExists(input.gitRoot, sha))) return false;
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
        // Work in another repository is never in this head. A unit here whose
        // branch is gone without a scanner snapshot names no work to hold the
        // issue by; the finalizer resolves it with the issue.
        if (!inRepo.get(unit.repo_id)) {
          result.push({ id: unit.id, branch: unit.branch });
          continue;
        }
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
    const tip = tipOf(unit);
    if (tip && landed.has(tip)) add(unit.ledger_issue_id);
  }
  const landedList = JSON.stringify([...landed]);
  for (const row of db.prepare(`SELECT DISTINCT ledger_issue_id AS id FROM work_units
      WHERE state = 'resolved' AND ledger_issue_id IS NOT NULL AND lower(landed_commit) IN (SELECT value FROM json_each(?))`)
    .all(landedList) as Array<{ id: string }>) add(row.id);
  if (input.ownIssueId) add(input.ownIssueId);
  for (const id of [...input.closes, ...input.keepsOpen.keys()]) add(id);

  // Issues another closing issue's delivery fulfils, through `fixed_by`.
  const fulfilled = new Set<string>();
  const closureReason = (id: string): ClosureReason | undefined => input.closes.has(id) ? "closes_issue"
    : issue(id)!.worker_status === "done" ? "done"
      : fulfilled.has(id) ? "fixed_by"
        : undefined;
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
      const outcome: Outcome = input.keepsOpen.has(id) ? "kept_open"
        : holds ? "held"
          : closureReason(id) ? "closing"
            : "undecided";
      visiting.delete(id);
      outcomes.set(id, outcome);
      order.push(id);
      return outcome;
    };
    for (const id of set) await outcomeOf(id);
    return { outcomes, order };
  };

  // Least fixed point: each closing issue derives the issues it fulfils and a
  // finished parent whose last open child it is. A closure only releases
  // holds, so the closing set only grows. A conditional closure derives
  // nothing: what it would release is not known until the merge.
  let evaluation = await evaluate();
  for (;;) {
    let grew = false;
    for (const [id, outcome] of evaluation.outcomes) {
      if (outcome !== "closing") continue;
      for (const source of fixedBySourcesOf(id)) {
        if (!derivable(source) || fulfilled.has(source)) continue;
        fulfilled.add(source);
        add(source);
        grew = true;
      }
      for (const parent of parentsOf(id)) {
        if (set.has(parent) || !derivable(parent) || issue(parent)!.worker_status !== "done" || !hasResolvedUnit(parent)) continue;
        if ((await readUnmergedUnits(parent)).length > 0) continue;
        if (openChildren(parent).every((child) => set.has(child) && evaluation.outcomes.get(child) === "closing")) grew = add(parent) || grew;
      }
    }
    if (!grew) break;
    evaluation = await evaluate();
  }

  const { outcomes, order: evaluated } = evaluation;
  const closes = (id: string) => outcomes.get(id) === "closing" || (outcomes.get(id) === "held" && closureReason(id) !== undefined);
  const heights = new Map<string, number>();
  const heightOf = (id: string, seen: Set<string> = new Set()): number => {
    const known = heights.get(id);
    if (known !== undefined) return known;
    if (seen.has(id)) return 0;
    seen.add(id);
    const below = openChildren(id).filter(closes).map((child) => heightOf(child, seen));
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
      accounting.closing.push({ ...described(id), by: closureReason(id)! });
    } else if (outcome === "kept_open") {
      accounting.kept_open.push({ ...described(id), remainder: input.keepsOpen.get(id)! });
    } else if (outcome === "held") {
      const by = closureReason(id);
      accounting.held.push({
        ...described(id),
        open_children: openChildren(id).filter((child) => outcomes.get(child) !== "closing").map((child) => issue(child)!.short_id),
        unmerged_units: await readUnmergedUnits(id),
        ...(by ? { closes_by: by } : {}),
      });
    } else {
      undecided.push({ ...described(id), worker_status: issue(id)!.worker_status });
    }
  }
  for (const id of input.keepsOpen.keys()) {
    if (!set.has(id)) refusals.push({ kind: "unkeepable", issue: issue(id)?.short_id || id });
  }
  if (undecided.length > 0) refusals.unshift({ kind: "undecided", issues: undecided });
  return refusals.length > 0 ? { ok: false, refusals, accounting } : { ok: true, accounting };
}

/** How the requester states each decision where a refusal is read. */
export interface DecisionSyntax {
  /** The flag or command that makes the decision. */
  decide(decision: IssueDecision, issue: string): string;
  /** The decision as a refusal names it. */
  name(decision: IssueDecision, issue: string): string;
}

export const SUBMISSION_DECISION_SYNTAX: DecisionSyntax = {
  decide: (decision, issue) => decision === "close" ? `--closes-issue ${issue}` : `--keeps-open ${issue}=<what remains>`,
  name: (decision, issue) => decision === "close" ? `--closes-issue ${issue}` : `--keeps-open ${issue}`,
};

export function describeAccountingRefusals(refusals: readonly IssueAccountingRefusal[], syntax: DecisionSyntax): string {
  const lines: string[] = [];
  for (const refusal of refusals) {
    switch (refusal.kind) {
      case "undecided":
        lines.push(`This merge lands ${refusal.issues.length === 1 ? "an issue" : `${refusal.issues.length} issues`} with no decision. Decide each:`);
        for (const issue of refusal.issues) {
          lines.push(`  ${issue.issue} ${issue.title} (worker status ${issue.worker_status}):`);
          lines.push(`    ${syntax.decide("close", issue.issue)}   or   ${syntax.decide("keep_open", issue.issue)}`);
        }
        break;
      case "conflicting_decision":
        lines.push(`${refusal.issue.issue} is both closed and kept open; decide it once.`);
        break;
      case "unkeepable":
        lines.push(`${syntax.name("keep_open", refusal.issue)} refused: only an open issue that is neither a tracker nor a maintenance issue is kept open.`);
        break;
    }
  }
  return lines.join("\n");
}

/**
 * Where an open issue's landed work is: on a protected branch, only on an
 * unprotected branch, or unknowable because its units resolved before
 * `landed_commit` existed and not through a request.
 */
export type LandedReach = "protected" | "unprotected" | "unknown";

export interface LandedOpenRow extends AccountedIssue {
  worker_status: string;
  parent: { issue: string; status: string } | null;
  /** Null for an issue under a closed parent that has no resolved work unit. */
  reach: LandedReach | null;
}

export interface LandedOpenTriage {
  without_remainder: LandedOpenRow[];
  with_remainder: Array<LandedOpenRow & { remainder: string; remainder_set_at: number }>;
  under_closed_parent: LandedOpenRow[];
}

interface TriageIssueRow {
  id: string;
  short_id: string;
  title: string;
  worker_status: string;
  remainder: string | null;
  remainder_set_at: number | null;
}

interface TriageUnitRow {
  ledger_issue_id: string;
  state: string;
  landed_commit: string | null;
  by_completed_request: number;
}

/**
 * Issue 9395f25 — open issues of one project whose work has landed and that
 * nothing holds open, plus open issues under a closed parent. Reads state;
 * stores nothing. Git failures throw: reach that cannot be read is not guessed.
 */
export async function triageLandedOpen(db: Db, projectId: string): Promise<LandedOpenTriage> {
  const issues = db.prepare(
    `SELECT id, short_id, title, worker_status, remainder, remainder_set_at FROM ledger_issues
      WHERE project_id = ? AND status = 'open' AND deleted_at IS NULL AND kind NOT IN ('tracker', 'maintenance')
      ORDER BY created_at, id`,
  ).all(projectId) as TriageIssueRow[];
  const units = db.prepare(
    `SELECT wu.ledger_issue_id, wu.state, wu.landed_commit,
            EXISTS (SELECT 1 FROM auth_requests r WHERE r.id = wu.auth_request_id AND r.type = 'merge' AND r.status = 'completed') AS by_completed_request
       FROM work_units wu JOIN ledger_issues i ON i.id = wu.ledger_issue_id
      WHERE i.project_id = ? AND i.status = 'open' AND wu.state IN ('open', 'committed', 'resolved')`,
  ).all(projectId) as TriageUnitRow[];
  const edges = db.prepare(
    `SELECT e.source_issue_id AS parent_id, e.target_issue_id AS child_id, parent.short_id AS parent_ref,
            parent.status AS parent_status, child.status AS child_status
       FROM ledger_relationship_edges e
       JOIN ledger_issues parent ON parent.id = e.source_issue_id AND parent.deleted_at IS NULL
       JOIN ledger_issues child ON child.id = e.target_issue_id AND child.deleted_at IS NULL
      WHERE +e.link_type = 'parent_child' AND +e.source_entity_type = 'issue' AND +e.target_entity_type = 'issue'
        AND e.deleted_at IS NULL AND (parent.project_id = ? OR child.project_id = ?)
      ORDER BY e.created_at, e.id`,
  ).all(projectId, projectId) as Array<{ parent_id: string; child_id: string; parent_ref: string; parent_status: string; child_status: string }>;

  const unitsByIssue = new Map<string, TriageUnitRow[]>();
  for (const unit of units) unitsByIssue.set(unit.ledger_issue_id, [...unitsByIssue.get(unit.ledger_issue_id) ?? [], unit]);
  const hasOpenChild = new Set(edges.filter((edge) => edge.child_status === "open").map((edge) => edge.parent_id));
  const parentsOf = new Map<string, Array<{ issue: string; status: string }>>();
  for (const edge of edges) {
    parentsOf.set(edge.child_id, [...parentsOf.get(edge.child_id) ?? [], { issue: edge.parent_ref, status: edge.parent_status }]);
  }

  const landed = issues.filter((issue) => {
    const own = unitsByIssue.get(issue.id) ?? [];
    return own.some((unit) => unit.state === "resolved") && !own.some((unit) => unit.state !== "resolved") && !hasOpenChild.has(issue.id);
  });
  const underClosed = issues.filter((issue) => (parentsOf.get(issue.id) ?? []).some((parent) => parent.status === "closed"));
  const needsReach = [...new Set([...landed, ...underClosed])].filter((issue) =>
    (unitsByIssue.get(issue.id) ?? []).some((unit) => unit.state === "resolved" && !unit.by_completed_request && unit.landed_commit));
  const onProtected = needsReach.length > 0 ? await protectedCommits(db, projectId) : new Set<string>();

  const reachOf = (issueId: string): LandedReach | null => {
    const resolved = (unitsByIssue.get(issueId) ?? []).filter((unit) => unit.state === "resolved");
    if (resolved.length === 0) return null;
    if (resolved.some((unit) => unit.by_completed_request || (unit.landed_commit && onProtected.has(unit.landed_commit.toLowerCase())))) return "protected";
    return resolved.some((unit) => unit.landed_commit) ? "unprotected" : "unknown";
  };
  const row = (issue: TriageIssueRow, parent: { issue: string; status: string } | null): LandedOpenRow => ({
    issue: issue.short_id || issue.id,
    issue_id: issue.id,
    title: issue.title,
    worker_status: issue.worker_status,
    parent,
    reach: reachOf(issue.id),
  });

  const underClosedIds = new Set(underClosed.map((issue) => issue.id));
  const triage: LandedOpenTriage = { without_remainder: [], with_remainder: [], under_closed_parent: [] };
  for (const issue of underClosed) {
    triage.under_closed_parent.push(row(issue, (parentsOf.get(issue.id) ?? []).find((parent) => parent.status === "closed")!));
  }
  for (const issue of landed) {
    if (underClosedIds.has(issue.id)) continue;
    const base = row(issue, parentsOf.get(issue.id)?.[0] ?? null);
    if (issue.remainder === null) triage.without_remainder.push(base);
    else triage.with_remainder.push({ ...base, remainder: issue.remainder, remainder_set_at: issue.remainder_set_at! });
  }
  triage.with_remainder.sort((a, b) => a.remainder_set_at - b.remainder_set_at);
  return triage;
}

async function commitExists(root: string, sha: string): Promise<boolean> {
  return execFileAsync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd: root, env: authGitEnv(), timeout: GIT_TIMEOUT_MS })
    .then(() => true, (error: { code?: unknown }) => {
      if (error.code === 1 || error.code === 128) return false;
      throw error;
    });
}

/** Every commit reachable from a protected branch of the project's checkouts. */
async function protectedCommits(db: Db, projectId: string): Promise<Set<string>> {
  const checkouts = db.prepare("SELECT root, default_branch FROM ledger_project_checkouts WHERE project_id = ? ORDER BY root")
    .all(projectId) as Array<{ root: string; default_branch: string | null }>;
  const root = checkouts.map((checkout) => checkout.root).find((candidate) => path.isAbsolute(candidate) && fs.existsSync(candidate));
  if (!root) throw new Error("No checkout of this project exists on disk to read which commits are on a protected branch.");
  const names = new Set(checkouts.flatMap((checkout) => [...protectedBranchNames(db, checkout.default_branch)]));
  const existing = (await git(root, ["for-each-ref", "--format=%(refname)", ...[...names].map((name) => `refs/heads/${name}`)]))
    .split("\n").map((line) => line.trim()).filter(Boolean);
  if (existing.length === 0) return new Set();
  const commits = await git(root, ["rev-list", ...existing]);
  return new Set(commits.split("\n").map((line) => line.trim().toLowerCase()).filter(Boolean));
}
