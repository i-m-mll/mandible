import path from "node:path";
import { getDb } from "../db.js";
import type { IssueScanner } from "../issue-scanner.js";
import type { RouteRegistrar } from "../server.js";
import type { GraphNode, GraphEdge, GraphPayload, GraphQueryParams } from "../types.js";
import { extractBugRefs } from "../utils/bug-refs.js";

// Bug: 7a141c3 — graph API implementation
// Bug: bdcc1f5 — remove branch nodes, add branch filter, fix issue visibility

function parseSince(since: string): number | null {
  // ISO date string
  if (/^\d{4}-/.test(since)) {
    const ms = new Date(since).getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  // Relative: e.g. "3d", "1w", "2h", "30m"
  const relMatch = /^(\d+)(d|h|w|m)$/.exec(since);
  if (relMatch) {
    const n = Number(relMatch[1]);
    const unit = relMatch[2];
    let unitMs: number;
    switch (unit) {
      case "h": unitMs = 60 * 60 * 1_000; break;
      case "d": unitMs = 24 * 60 * 60 * 1_000; break;
      case "w": unitMs = 7 * 24 * 60 * 60 * 1_000; break;
      case "m": unitMs = 30 * 24 * 60 * 60 * 1_000; break;
      default:  unitMs = 0;
    }
    return Date.now() - (n * unitMs);
  }
  return null;
}

function parseQueryParams(query: Record<string, string>): GraphQueryParams {
  const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 500);
  const status = query.status === "all" ? "all" : "open";
  return {
    repo: query.repo || undefined,
    branch: query.branch || undefined,
    since: query.since || undefined,
    limit,
    status,
  };
}

function msToIso(ms: number): string {
  return new Date(ms).toISOString();
}

export function registerGraphRoutes(
  app: RouteRegistrar,
  issueScanner: IssueScanner,
): void {
  app.get("/api/graph", (req, res) => {
    const params = parseQueryParams(req.query);
    const sinceMs: number | null = params.since ? parseSince(params.since) : null;
    const sinceIso: string | null = sinceMs !== null ? msToIso(sinceMs) : null;
    const limit = params.limit ?? 50;

    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];

    // ----------------------------------------------------------------
    // 1. Issue nodes (from IssueScanner in-memory cache)
    //    No `since` filter — open issues should always appear regardless of age.
    // ----------------------------------------------------------------
    const summaries = issueScanner.getRepoSummaries();
    const issueNodeIds = new Set<string>();

    for (const summary of summaries) {
      if (params.repo && summary.repo_name !== params.repo && summary.repo_id !== params.repo) {
        continue;
      }
      for (const issue of summary.issues) {
        if (params.status === "open" && issue.status !== "open") {
          continue;
        }
        // No created_at/since filter for issues — old open issues must appear
        const nodeId = `issue:${issue.repo_id}:${issue.id}`;
        issueNodeIds.add(nodeId);
        nodes.push({
          id: nodeId,
          type: "issue",
          label: issue.title,
          status: issue.status,
          labels: issue.labels,
          repo: issue.repo_name,
          created_at: issue.created_at,
        });
      }
    }

    // ----------------------------------------------------------------
    // 2. Session nodes
    // ----------------------------------------------------------------
    const db = getDb();
    interface SessionRow {
      id: string;
      status: string | null;
      branch: string | null;
      cwd: string | null;
      app: string | null;
      agent_type: string | null;
      created_at: string;
      parent_id: string | null;
    }

    let sessionQuery = `
      SELECT id, status, branch, cwd, app, agent_type, created_at, parent_id
      FROM sessions
      WHERE 1=1
    `;
    const sessionBindings: Record<string, unknown> = {};
    if (sinceIso !== null) {
      sessionQuery += ` AND created_at >= :sinceIso`;
      sessionBindings.sinceIso = sinceIso;
    }
    if (params.branch) {
      sessionQuery += ` AND branch = :branch`;
      sessionBindings.branch = params.branch;
    }
    sessionQuery += ` ORDER BY created_at DESC LIMIT :limit`;
    sessionBindings.limit = limit;

    let sessionRows: SessionRow[];
    try {
      sessionRows = db.prepare(sessionQuery).all(sessionBindings) as SessionRow[];
    } catch {
      sessionRows = [];
    }

    const sessionNodeIds = new Set<string>();
    for (const s of sessionRows) {
      if (params.repo && s.cwd) {
        if (path.basename(s.cwd) !== params.repo) {
          continue;
        }
      } else if (params.repo && !s.cwd) {
        continue;
      }
      const nodeId = `session:${s.id}`;
      sessionNodeIds.add(nodeId);
      nodes.push({
        id: nodeId,
        type: "session",
        label: s.agent_type ?? s.app ?? "session",
        status: s.status ?? undefined,
        branch: s.branch ?? undefined,
        repo: s.cwd ? path.basename(s.cwd) : undefined,
        active: s.status === "active",
        created_at: s.created_at,
      });
    }

    // session_parent edges
    for (const s of sessionRows) {
      if (!s.parent_id) continue;
      const childId = `session:${s.id}`;
      const parentId = `session:${s.parent_id}`;
      if (sessionNodeIds.has(childId) && sessionNodeIds.has(parentId)) {
        edges.push({
          id: `session_parent:${s.id}:${s.parent_id}`,
          source: childId,
          target: parentId,
          type: "session_parent",
        });
      }
    }

    // ----------------------------------------------------------------
    // 3. Auth request nodes
    // ----------------------------------------------------------------
    interface AuthRow {
      id: string;
      title: string;
      status: string | null;
      repo: string | null;
      head_branch: string | null;
      commit_message: string | null;
      created_at: number;
    }

    let authQuery = `
      SELECT id, title, status, repo, head_branch, commit_message, created_at
      FROM auth_requests
      WHERE 1=1
    `;
    const authBindings: Record<string, unknown> = {};
    if (sinceMs !== null) {
      authQuery += ` AND created_at >= :sinceMs`;
      authBindings.sinceMs = sinceMs;
    }
    if (params.repo) {
      authQuery += ` AND repo = :repo`;
      authBindings.repo = params.repo;
    }
    if (params.branch) {
      authQuery += ` AND head_branch = :branch`;
      authBindings.branch = params.branch;
    }
    authQuery += ` ORDER BY created_at DESC LIMIT :limit`;
    authBindings.limit = limit;

    let authRows: AuthRow[];
    try {
      authRows = db.prepare(authQuery).all(authBindings) as AuthRow[];
    } catch {
      authRows = [];
    }

    const authNodeIds = new Set<string>();
    for (const ar of authRows) {
      const nodeId = `auth_request:${ar.id}`;
      authNodeIds.add(nodeId);
      nodes.push({
        id: nodeId,
        type: "auth_request",
        label: ar.title,
        status: ar.status ?? undefined,
        repo: ar.repo ?? undefined,
        branch: ar.head_branch ?? undefined,
        created_at: new Date(ar.created_at).toISOString(),
      });
    }

    // ----------------------------------------------------------------
    // 5. Session→issue edges (session_issues table)
    // ----------------------------------------------------------------
    interface SessionIssueRow {
      session_id: string;
      issue_id: string;
      repo_id: string;
    }

    let sessionIssueRows: SessionIssueRow[];
    try {
      sessionIssueRows = db.prepare(`SELECT session_id, issue_id, repo_id FROM session_issues`).all() as SessionIssueRow[];
    } catch {
      sessionIssueRows = [];
    }

    for (const row of sessionIssueRows) {
      const sessionNodeId = `session:${row.session_id}`;
      const issueNodeId = `issue:${row.repo_id}:${row.issue_id}`;
      if (sessionNodeIds.has(sessionNodeId) && issueNodeIds.has(issueNodeId)) {
        edges.push({
          id: `session_issue:${row.session_id}:${row.repo_id}:${row.issue_id}`,
          source: sessionNodeId,
          target: issueNodeId,
          type: "session_issue",
        });
      }
    }

    // ----------------------------------------------------------------
    // 7. auth_issue edges: Bug: trailers in commit_message
    // ----------------------------------------------------------------
    for (const ar of authRows) {
      if (!ar.commit_message) continue;
      const refs = extractBugRefs(ar.commit_message);
      for (const ref of refs) {
        // Prefix match against issue nodes
        for (const issueNodeId of issueNodeIds) {
          // issueNodeId = "issue:<repo_id>:<issue_human_id>"
          const parts = issueNodeId.split(":");
          const issueHumanId = parts[2];
          if (issueHumanId && (issueHumanId === ref || issueHumanId.startsWith(ref))) {
            const authNodeId = `auth_request:${ar.id}`;
            if (authNodeIds.has(authNodeId)) {
              edges.push({
                id: `auth_issue:${ar.id}:${issueNodeId}`,
                source: authNodeId,
                target: issueNodeId,
                type: "auth_issue",
              });
            }
          }
        }
      }
    }

    // ----------------------------------------------------------------
    // 10. Final: sort nodes by created_at desc, cap to limit
    // ----------------------------------------------------------------
    nodes.sort((a, b) => {
      const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
      const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
      return tb - ta;
    });
    const cappedNodes = nodes.slice(0, limit);
    const cappedNodeIds = new Set(cappedNodes.map((n) => n.id));

    // Filter edges to only include those where both source and target are in the capped set
    const cappedEdges = edges.filter(
      (e) => cappedNodeIds.has(e.source) && cappedNodeIds.has(e.target),
    );

    const payload: GraphPayload = {
      nodes: cappedNodes,
      edges: cappedEdges,
    };

    res.json(payload);
  });
}
