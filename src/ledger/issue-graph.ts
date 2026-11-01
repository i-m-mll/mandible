import type { Db } from "../db.js";
import type { LedgerRelationshipEdge } from "./types.js";

/** Operational hierarchy contains only live structured issue-to-issue edges. */
export const ACTIVE_ISSUE_HIERARCHY_SQL = `
  SELECT e.*, parent.short_id AS parent_ref
    FROM ledger_relationship_edges e
    JOIN ledger_issues parent ON parent.id = e.source_issue_id AND parent.deleted_at IS NULL
    JOIN ledger_issues child ON child.id = e.target_issue_id AND child.deleted_at IS NULL
   WHERE e.source_entity_type = 'issue' AND e.target_entity_type = 'issue'
     AND +e.link_type = 'parent_child' AND e.deleted_at IS NULL`;

export type IssueHierarchyEdge = LedgerRelationshipEdge & { parent_ref: string | null };

export function listIssueHierarchyEdges(db: Db, scope: {
  sourceIds?: readonly string[];
  targetIds?: readonly string[];
  projectId?: string;
} = {}): IssueHierarchyEdge[] {
  const filters: string[] = [];
  const bindings: string[] = [];
  for (const [column, ids] of [["source_issue_id", scope.sourceIds], ["target_issue_id", scope.targetIds]] as const) {
    if (!ids) continue;
    if (ids.length === 0) return [];
    filters.push(`e.${column} IN (SELECT value FROM json_each(?))`);
    bindings.push(JSON.stringify(ids));
  }
  if (scope.projectId) {
    filters.push("e.target_project_id = ? AND child.project_id = ?");
    bindings.push(scope.projectId, scope.projectId);
  }
  return db.prepare(`${ACTIVE_ISSUE_HIERARCHY_SQL}
    ${filters.length ? `AND ${filters.join(" AND ")}` : ""}
    ORDER BY e.created_at, e.id`).all(...bindings) as IssueHierarchyEdge[];
}

export function displayIssueId(issue: { id: string; short_id: string | null }): string {
  return issue.short_id || issue.id.slice(0, 7);
}
