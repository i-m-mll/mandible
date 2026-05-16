import type { IssueScanner } from "../issue-scanner.js";
import type { RouteRegistrar } from "../server.js";
import type { GraphEdge, GraphNode, GraphQueryParams } from "../types.js";
export declare function parseQueryParams(query: Record<string, string | string[] | undefined>): GraphQueryParams;
export declare function capGraphNodesForDisplay(nodes: GraphNode[], edges: GraphEdge[], limit: number): {
    nodes: GraphNode[];
    truncated: boolean;
};
export declare function repoCandidatesFromCwd(cwd: string | null): string[];
export declare function registerGraphRoutes(app: RouteRegistrar, issueScanner: IssueScanner): void;
