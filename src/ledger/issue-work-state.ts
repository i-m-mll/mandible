import type { Db } from "../db.js";
import type { LedgerIssueDetailBranch } from "../issue-detail-contract.js";
import type { LedgerIssueBranchRole, LedgerWorkerStatus } from "./types.js";

// Issue d9e59e8 — the work unit is the single source of an issue's branches and
// of whether it is in progress. Readers derive both here; stored worker status
// keeps only explicit statements, and `issue_branches` keeps only manual links
// (branches with no work unit, and the `superseded` role).

/**
 * The SQL expression for an issue's effective worker status. An explicit
 * `done`, `blocked`, or `pivot-needed` wins; otherwise the issue is
 * `in_progress` exactly when it has an open or committed work unit.
 */
export function effectiveWorkerStatusSql(issueAlias: string): string {
  return `CASE
    WHEN ${issueAlias}.worker_status IN ('done', 'blocked', 'pivot-needed') THEN ${issueAlias}.worker_status
    WHEN EXISTS (
      SELECT 1 FROM work_units live_wu
       WHERE live_wu.ledger_issue_id = ${issueAlias}.id
         AND live_wu.state IN ('open', 'committed')
    ) THEN 'in_progress'
    ELSE 'none'
  END`;
}

export function effectiveWorkerStatus(db: Db, issueId: string): LedgerWorkerStatus {
  const row = db.prepare(
    `SELECT ${effectiveWorkerStatusSql("i")} AS worker_status FROM ledger_issues i WHERE i.id = ?`,
  ).get(issueId) as { worker_status: LedgerWorkerStatus } | undefined;
  if (!row) throw new Error(`Ledger issue not found: ${issueId}`);
  return row.worker_status;
}

const ROLE_ORDER: Record<LedgerIssueBranchRole, number> = { primary: 0, superseded: 1 };

/**
 * Each issue's branches: the branches of its open, committed, and resolved work
 * units merged with its manual issue-branch links, one entry per branch.
 * Resolved units stay listed because they name the branch that delivered the
 * issue; abandoned units are released work and are omitted. A manual link sets
 * the role of a branch a work unit also supplies (for example `superseded`).
 */
export function batchIssueBranches(db: Db, issueIds: string[]): Map<string, LedgerIssueDetailBranch[]> {
  const result = new Map<string, LedgerIssueDetailBranch[]>();
  if (issueIds.length === 0) return result;
  const marks = issueIds.map(() => "?").join(", ");
  const workUnitRows = db.prepare(
    `SELECT id, ledger_issue_id AS issue_id, branch, state, created_at,
            COALESCE(resolved_at, activated_at, created_at) AS updated_at
       FROM work_units
      WHERE ledger_issue_id IN (${marks})
        AND state IN ('open', 'committed', 'resolved')
        AND branch IS NOT NULL AND trim(branch) <> ''
      ORDER BY created_at, id`,
  ).all(...issueIds) as Array<{
    id: string;
    issue_id: string;
    branch: string;
    state: string;
    created_at: number;
    updated_at: number;
  }>;
  const linkRows = db.prepare(
    `SELECT issue_id, branch, role, created_at, updated_at
       FROM issue_branches
      WHERE issue_id IN (${marks})`,
  ).all(...issueIds) as Array<{
    issue_id: string;
    branch: string;
    role: LedgerIssueBranchRole;
    created_at: number;
    updated_at: number;
  }>;

  const byIssue = new Map<string, Map<string, LedgerIssueDetailBranch>>();
  const entriesFor = (issueId: string): Map<string, LedgerIssueDetailBranch> => {
    let entries = byIssue.get(issueId);
    if (!entries) {
      entries = new Map();
      byIssue.set(issueId, entries);
    }
    return entries;
  };
  // Later work units on the same branch replace earlier ones (rows are ordered by creation).
  for (const row of workUnitRows) {
    entriesFor(row.issue_id).set(row.branch, {
      branch: row.branch,
      role: "primary",
      created_at: row.created_at,
      updated_at: row.updated_at,
      work_unit_id: row.id,
      work_unit_state: row.state,
    });
  }
  for (const row of linkRows) {
    const entries = entriesFor(row.issue_id);
    const existing = entries.get(row.branch);
    entries.set(row.branch, existing
      ? { ...existing, role: row.role, created_at: Math.min(existing.created_at, row.created_at) }
      : {
          branch: row.branch,
          role: row.role,
          created_at: row.created_at,
          updated_at: row.updated_at,
          work_unit_id: null,
          work_unit_state: null,
        });
  }
  for (const [issueId, entries] of byIssue) {
    result.set(issueId, Array.from(entries.values()).sort((a, b) =>
      ROLE_ORDER[a.role] - ROLE_ORDER[b.role]
      || a.created_at - b.created_at
      || (a.branch < b.branch ? -1 : a.branch > b.branch ? 1 : 0)));
  }
  return result;
}

export function listIssueBranches(db: Db, issueId: string): LedgerIssueDetailBranch[] {
  return batchIssueBranches(db, [issueId]).get(issueId) ?? [];
}
