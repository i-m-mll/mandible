import path from "node:path";
import { getDb } from "../db.js";
import type { IssueScanner } from "../issue-scanner.js";
import type { RouteRegistrar } from "../server.js";
import type { GraphNode, GraphEdge, GraphPayload, GraphQueryParams } from "../types.js";
import { extractBugRefs } from "../utils/bug-refs.js";

// Bug: 7a141c3 — graph API implementation

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
        if (sinceMs !== null && issue.created_at) {
          const issueMs = new Date(issue.created_at).getTime();
          if (!Number.isNaN(issueMs) && issueMs < sinceMs) {
            continue;
          }
        }
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
    // 4. Branch nodes
    // ----------------------------------------------------------------
    interface BranchRow {
      repo_root: string;
      branch: string;
      last_commit_message: string | null;
      last_commit_date: string | null;
      is_dirty: number | null;
      ahead: number | null;
      updated_at: string;
    }

    let branchQuery = `
      SELECT repo_root, branch, last_commit_message, last_commit_date, is_dirty, ahead, updated_at
      FROM branches
      WHERE 1=1
    `;
    const branchBindings: Record<string, unknown> = {};
    if (sinceIso !== null) {
      branchQuery += ` AND updated_at >= :sinceIso`;
      branchBindings.sinceIso = sinceIso;
    }
    branchQuery += ` ORDER BY updated_at DESC LIMIT :limit`;
    branchBindings.limit = limit;

    let branchRows: BranchRow[];
    try {
      branchRows = db.prepare(branchQuery).all(branchBindings) as BranchRow[];
    } catch {
      branchRows = [];
    }

    const branchNodeIds = new Set<string>();
    for (const b of branchRows) {
      if (params.repo && path.basename(b.repo_root) !== params.repo) {
        continue;
      }
      const nodeId = `branch:${b.repo_root}:${b.branch}`;
      branchNodeIds.add(nodeId);
      nodes.push({
        id: nodeId,
        type: "branch",
        label: b.branch,
        repo: path.basename(b.repo_root),
        branch: b.branch,
        created_at: b.updated_at,
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
    // 6. auth_branch edges: match auth_request.head_branch → branch node
    // ----------------------------------------------------------------
    for (const ar of authRows) {
      if (!ar.head_branch) continue;
      const authNodeId = `auth_request:${ar.id}`;
      // Find a branch node with matching branch name (and matching repo if available)
      for (const b of branchRows) {
        if (b.branch !== ar.head_branch) continue;
        if (ar.repo && path.basename(b.repo_root) !== ar.repo) continue;
        const branchNodeId = `branch:${b.repo_root}:${b.branch}`;
        if (authNodeIds.has(authNodeId) && branchNodeIds.has(branchNodeId)) {
          edges.push({
            id: `auth_branch:${ar.id}:${b.repo_root}:${b.branch}`,
            source: authNodeId,
            target: branchNodeId,
            type: "auth_branch",
          });
        }
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
    // 8. branch_issue edges: Bug: trailers in last_commit_message
    // ----------------------------------------------------------------
    for (const b of branchRows) {
      if (!b.last_commit_message) continue;
      const branchNodeId = `branch:${b.repo_root}:${b.branch}`;
      if (!branchNodeIds.has(branchNodeId)) continue;
      const refs = extractBugRefs(b.last_commit_message);
      for (const ref of refs) {
        for (const issueNodeId of issueNodeIds) {
          const parts = issueNodeId.split(":");
          const issueHumanId = parts[2];
          if (issueHumanId && (issueHumanId === ref || issueHumanId.startsWith(ref))) {
            edges.push({
              id: `branch_issue:${b.repo_root}:${b.branch}:${issueNodeId}`,
              source: branchNodeId,
              target: issueNodeId,
              type: "branch_issue",
            });
          }
        }
      }
    }

    // ----------------------------------------------------------------
    // 9. umbrella_child edges
    // ----------------------------------------------------------------
    const CHILD_REF_REGEX = /\b([0-9a-f]{7,40})\b/g;

    // Build a flat map of issue human_id → nodeId for quick lookup
    const issueIdToNodeId = new Map<string, string>();
    for (const nodeId of issueNodeIds) {
      const parts = nodeId.split(":");
      const humanId = parts[2];
      if (humanId) {
        issueIdToNodeId.set(humanId, nodeId);
      }
    }

    for (const summary of summaries) {
      for (const issue of summary.issues) {
        if (!issue.labels.includes("umbrella")) continue;
        const umbrellaNodeId = `issue:${issue.repo_id}:${issue.id}`;
        if (!issueNodeIds.has(umbrellaNodeId)) continue;

        // Fetch detail to get description (not available in list scan)
        const detail = issueScanner.getIssueDetail(issue.repo_id, issue.id);
        if (!detail?.description) continue;

        const description = detail.description;
        let match: RegExpExecArray | null;
        CHILD_REF_REGEX.lastIndex = 0;
        while ((match = CHILD_REF_REGEX.exec(description)) !== null) {
          const candidate = match[1];
          // Exact match first
          if (issueIdToNodeId.has(candidate)) {
            const childNodeId = issueIdToNodeId.get(candidate)!;
            if (childNodeId !== umbrellaNodeId) {
              edges.push({
                id: `umbrella_child:${umbrellaNodeId}:${childNodeId}`,
                source: umbrellaNodeId,
                target: childNodeId,
                type: "umbrella_child",
              });
            }
          } else {
            // Prefix match
            for (const [humanId, nodeId] of issueIdToNodeId) {
              if (humanId.startsWith(candidate) && nodeId !== umbrellaNodeId) {
                edges.push({
                  id: `umbrella_child:${umbrellaNodeId}:${nodeId}`,
                  source: umbrellaNodeId,
                  target: nodeId,
                  type: "umbrella_child",
                });
                break;
              }
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
