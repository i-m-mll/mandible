import type { Db } from "../db.js";
import type { GraphEdge, GraphNode, GraphQueryParams } from "../types.js";
export interface LedgerIssueProjection {
    nodes: GraphNode[];
    edges: GraphEdge[];
    issueNodeIds: Set<string>;
    issueNodeIdByLedgerId: Map<string, string>;
}
export declare function countLedgerGraphIssues(db: Db, status?: "open" | "all"): number | null;
export declare function ledgerGraphHasIssues(db: Db): boolean;
export declare function getLedgerGraphFilterOptions(db: Db): {
    repos: string[];
    branches: string[];
};
export declare function buildLedgerIssueProjection(db: Db, params: GraphQueryParams): LedgerIssueProjection | null;
