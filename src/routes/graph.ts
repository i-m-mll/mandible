import path from "node:path";
import { getDb } from "../db.js";
import { getIndexedGraph, getIndexedGraphCount } from "../provider-artifacts.js";
import type { IssueScanner } from "../issue-scanner.js";
import type { RouteRegistrar } from "../server.js";
import type {
  GraphEdge,
  GraphLayerDescriptor,
  GraphMode,
  GraphModeDescriptor,
  GraphNode,
  GraphPayload,
  GraphQueryParams,
} from "../types.js";
import { extractBugRefs } from "../utils/bug-refs.js";

// Bug: 7a141c3 — graph API implementation
// Bug: 50c4afb — typed graph modes for the React Flow graph workspace

const GRAPH_MODES: Array<Omit<GraphModeDescriptor, "count" | "available">> = [
  {
    id: "activity",
    label: "Activity",
    description: "Recent issues, sessions, and auth requests.",
  },
  {
    id: "issue",
    label: "Issues",
    description: "Issue-centered relationships and umbrella/child links.",
  },
  {
    id: "work",
    label: "Work",
    description: "Repos, work units, branches, sessions, and auth requests.",
  },
  {
    id: "provider-lineage",
    label: "Provider Lineage",
    description: "Providers, manifests, runs, analyses, and provider artifacts.",
  },
  {
    id: "artifact-lineage",
    label: "Artifact Lineage",
    description: "Artifact ancestors and descendants.",
  },
  {
    id: "provenance",
    label: "Provenance",
    description: "Observed provenance edges across provider and artifact records.",
  },
];

function parseSince(since: string): number | null {
  if (/^\d{4}-/.test(since)) {
    const ms = new Date(since).getTime();
    return Number.isNaN(ms) ? null : ms;
  }
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

function parseGraphMode(value: string | undefined): GraphMode {
  return GRAPH_MODES.some((mode) => mode.id === value) ? (value as GraphMode) : "activity";
}

function parseQueryParams(query: Record<string, string>): GraphQueryParams {
  const limit = Math.min(Math.max(Number(query.limit) || 120, 1), 1000);
  const status = query.status === "all" ? "all" : "open";
  return {
    mode: parseGraphMode(query.mode),
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

function upsertNode(nodes: Map<string, GraphNode>, node: GraphNode): void {
  nodes.set(node.id, { ...nodes.get(node.id), ...node });
}

function upsertEdge(edges: Map<string, GraphEdge>, edge: GraphEdge): void {
  if (edge.source === edge.target) return;
  edges.set(edge.id, edge);
}

function nodeCreatedMs(node: GraphNode): number {
  return node.created_at ? new Date(node.created_at).getTime() : 0;
}

export function capGraphNodesForDisplay(
  nodes: GraphNode[],
  edges: GraphEdge[],
  limit: number,
): { nodes: GraphNode[]; truncated: boolean } {
  const sortedByRecency = [...nodes].sort((a, b) => {
    return nodeCreatedMs(b) - nodeCreatedMs(a) || a.label.localeCompare(b.label);
  });
  if (sortedByRecency.length <= limit) {
    return { nodes: sortedByRecency, truncated: false };
  }

  const nodeIds = new Set(nodes.map((node) => node.id));
  const incidentCounts = new Map<string, number>();
  for (const edge of edges) {
    if (nodeIds.has(edge.source)) {
      incidentCounts.set(edge.source, (incidentCounts.get(edge.source) ?? 0) + 1);
    }
    if (nodeIds.has(edge.target)) {
      incidentCounts.set(edge.target, (incidentCounts.get(edge.target) ?? 0) + 1);
    }
  }

  const ranked = [...nodes].sort((a, b) => {
    const aEdges = incidentCounts.get(a.id) ?? 0;
    const bEdges = incidentCounts.get(b.id) ?? 0;
    const connectedDelta = Number(bEdges > 0) - Number(aEdges > 0);
    if (connectedDelta !== 0) return connectedDelta;
    if (bEdges !== aEdges) return bEdges - aEdges;
    return nodeCreatedMs(b) - nodeCreatedMs(a) || a.label.localeCompare(b.label);
  });

  return { nodes: ranked.slice(0, limit), truncated: true };
}

function repoFromCwd(cwd: string | null): string | undefined {
  return cwd ? path.basename(cwd) : undefined;
}

function getIssueNodes(
  issueScanner: IssueScanner,
  params: GraphQueryParams,
): { nodes: Map<string, GraphNode>; issueNodeIds: Set<string> } {
  const nodes = new Map<string, GraphNode>();
  const issueNodeIds = new Set<string>();
  const summaries = issueScanner.getRepoSummaries();

  for (const summary of summaries) {
    if (params.repo && summary.repo_name !== params.repo && summary.repo_id !== params.repo) {
      continue;
    }
    for (const issue of summary.issues) {
      if (params.status === "open" && issue.status !== "open") continue;
      const nodeId = `issue:${issue.repo_id}:${issue.id}`;
      issueNodeIds.add(nodeId);
      upsertNode(nodes, {
        id: nodeId,
        type: "issue",
        label: issue.title,
        status: issue.status,
        labels: issue.labels,
        repo: issue.repo_name,
        repo_id: issue.repo_id,
        created_at: issue.created_at,
        summary: { author: issue.author },
        detail: { parent_id: issue.parent_id },
        actions: [{ id: "open-issue", label: "Open Issue", kind: "navigate", target: nodeId }],
      });
    }
  }

  return { nodes, issueNodeIds };
}

function addIssueEdges(
  issueScanner: IssueScanner,
  nodes: Map<string, GraphNode>,
  edges: Map<string, GraphEdge>,
): void {
  for (const summary of issueScanner.getRepoSummaries()) {
    for (const issue of summary.issues) {
      if (!issue.parent_id) continue;
      const childId = `issue:${issue.repo_id}:${issue.id}`;
      const parentId = `issue:${issue.repo_id}:${issue.parent_id}`;
      if (nodes.has(childId) && nodes.has(parentId)) {
        upsertEdge(edges, {
          id: `umbrella_child:${parentId}:${childId}`,
          source: parentId,
          target: childId,
          type: "umbrella_child",
          edge_class: "semantic",
          provenance: "git-bug",
        });
      }
    }
  }
}

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

function getSessionRows(params: GraphQueryParams, sinceIso: string | null, limit: number): SessionRow[] {
  const db = getDb();
  let query = `
    SELECT id, status, branch, cwd, app, agent_type, created_at, parent_id
      FROM sessions
     WHERE 1=1
  `;
  const bindings: Record<string, unknown> = {};
  if (sinceIso !== null) {
    query += ` AND created_at >= :sinceIso`;
    bindings.sinceIso = sinceIso;
  }
  if (params.branch) {
    query += ` AND branch = :branch`;
    bindings.branch = params.branch;
  }
  query += ` ORDER BY created_at DESC LIMIT :limit`;
  bindings.limit = limit;

  try {
    return db.prepare(query).all(bindings) as SessionRow[];
  } catch {
    return [];
  }
}

function addSessionNodesAndEdges(
  sessionRows: SessionRow[],
  params: GraphQueryParams,
  nodes: Map<string, GraphNode>,
  edges: Map<string, GraphEdge>,
): Set<string> {
  const sessionNodeIds = new Set<string>();
  for (const session of sessionRows) {
    const repo = repoFromCwd(session.cwd);
    if (params.repo && repo !== params.repo) continue;
    const nodeId = `session:${session.id}`;
    sessionNodeIds.add(nodeId);
    upsertNode(nodes, {
      id: nodeId,
      type: "session",
      label: session.agent_type ?? session.app ?? "session",
      status: session.status ?? undefined,
      branch: session.branch ?? undefined,
      repo,
      active: session.status === "active",
      created_at: session.created_at,
      actions: [{ id: "open-session", label: "Open Session", kind: "navigate", target: nodeId }],
    });
  }

  for (const session of sessionRows) {
    if (!session.parent_id) continue;
    const childId = `session:${session.id}`;
    const parentId = `session:${session.parent_id}`;
    if (sessionNodeIds.has(childId) && sessionNodeIds.has(parentId)) {
      upsertEdge(edges, {
        id: `session_parent:${session.id}:${session.parent_id}`,
        source: childId,
        target: parentId,
        type: "session_parent",
        edge_class: "lifecycle",
        provenance: "sessions",
      });
    }
  }

  return sessionNodeIds;
}

interface AuthRow {
  id: string;
  title: string;
  status: string | null;
  repo: string | null;
  head_branch: string | null;
  commit_message: string | null;
  issue_ids: string | null;
  created_at: number;
}

function getAuthRows(params: GraphQueryParams, sinceMs: number | null, limit: number): AuthRow[] {
  const db = getDb();
  let query = `
    SELECT id, title, status, repo, head_branch, commit_message, issue_ids, created_at
      FROM auth_requests
     WHERE 1=1
  `;
  const bindings: Record<string, unknown> = {};
  if (sinceMs !== null) {
    query += ` AND created_at >= :sinceMs`;
    bindings.sinceMs = sinceMs;
  }
  if (params.repo) {
    query += ` AND repo = :repo`;
    bindings.repo = params.repo;
  }
  if (params.branch) {
    query += ` AND head_branch = :branch`;
    bindings.branch = params.branch;
  }
  query += ` ORDER BY created_at DESC LIMIT :limit`;
  bindings.limit = limit;

  try {
    return db.prepare(query).all(bindings) as AuthRow[];
  } catch {
    return [];
  }
}

function addAuthNodesAndEdges(
  authRows: AuthRow[],
  issueNodeIds: Set<string>,
  nodes: Map<string, GraphNode>,
  edges: Map<string, GraphEdge>,
): Set<string> {
  const authNodeIds = new Set<string>();
  for (const auth of authRows) {
    const nodeId = `auth_request:${auth.id}`;
    authNodeIds.add(nodeId);
    upsertNode(nodes, {
      id: nodeId,
      type: "auth_request",
      label: auth.title,
      status: auth.status ?? undefined,
      repo: auth.repo ?? undefined,
      branch: auth.head_branch ?? undefined,
      created_at: new Date(auth.created_at).toISOString(),
      actions: [{ id: "open-auth", label: "Open Auth", kind: "navigate", target: nodeId }],
    });
  }

  for (const auth of authRows) {
    const refs = new Set<string>();
    if (auth.commit_message) {
      extractBugRefs(auth.commit_message).forEach((ref) => refs.add(ref));
    }
    try {
      const parsed = auth.issue_ids ? JSON.parse(auth.issue_ids) : [];
      if (Array.isArray(parsed)) parsed.forEach((ref) => typeof ref === "string" && refs.add(ref));
    } catch {
      // ignore legacy malformed issue_ids values
    }

    for (const ref of refs) {
      for (const issueNodeId of issueNodeIds) {
        const parts = issueNodeId.split(":");
        const issueHumanId = parts[2];
        if (issueHumanId && (issueHumanId === ref || issueHumanId.startsWith(ref))) {
          const authNodeId = `auth_request:${auth.id}`;
          if (authNodeIds.has(authNodeId)) {
            upsertEdge(edges, {
              id: `auth_issue:${auth.id}:${issueNodeId}`,
              source: authNodeId,
              target: issueNodeId,
              type: "auth_issue",
              edge_class: "lifecycle",
              provenance: "auth_requests",
            });
          }
        }
      }
    }
  }

  return authNodeIds;
}

function addSessionIssueEdges(
  issueNodeIds: Set<string>,
  sessionNodeIds: Set<string>,
  edges: Map<string, GraphEdge>,
): void {
  interface SessionIssueRow {
    session_id: string;
    issue_id: string;
    repo_id: string;
  }

  let rows: SessionIssueRow[];
  try {
    rows = getDb().prepare(
      `SELECT session_id, issue_id, repo_id FROM session_issues`
    ).all() as SessionIssueRow[];
  } catch {
    rows = [];
  }

  for (const row of rows) {
    const sessionNodeId = `session:${row.session_id}`;
    const issueNodeId = `issue:${row.repo_id}:${row.issue_id}`;
    if (sessionNodeIds.has(sessionNodeId) && issueNodeIds.has(issueNodeId)) {
      upsertEdge(edges, {
        id: `session_issue:${row.session_id}:${row.repo_id}:${row.issue_id}`,
        source: sessionNodeId,
        target: issueNodeId,
        type: "session_issue",
        edge_class: "lifecycle",
        provenance: "session_issues",
      });
    }
  }
}

function addWorkUnits(
  params: GraphQueryParams,
  nodes: Map<string, GraphNode>,
  edges: Map<string, GraphEdge>,
  limit: number,
): void {
  interface WorkUnitRow {
    id: string;
    issue_id: string;
    repo_id: string;
    branch: string | null;
    kind: string;
    state: string;
    assigned_session_id: string | null;
    auth_request_id: string | null;
    created_at: number;
  }
  const bindings: Record<string, unknown> = { limit };
  let query = `
    SELECT id, issue_id, repo_id, branch, kind, state, assigned_session_id, auth_request_id, created_at
      FROM work_units
     WHERE 1=1
  `;
  if (params.repo) {
    query += ` AND repo_id = :repo`;
    bindings.repo = params.repo;
  }
  if (params.branch) {
    query += ` AND branch = :branch`;
    bindings.branch = params.branch;
  }
  query += ` ORDER BY created_at DESC LIMIT :limit`;

  let rows: WorkUnitRow[];
  try {
    rows = getDb().prepare(query).all(bindings) as WorkUnitRow[];
  } catch {
    rows = [];
  }

  for (const work of rows) {
    const nodeId = `work_unit:${work.id}`;
    upsertNode(nodes, {
      id: nodeId,
      type: "work_unit",
      label: work.branch ?? work.issue_id,
      status: work.state,
      repo: work.repo_id,
      repo_id: work.repo_id,
      branch: work.branch ?? undefined,
      created_at: new Date(work.created_at).toISOString(),
      summary: { kind: work.kind, issue_id: work.issue_id },
      detail: { ...work },
    });
    const issueId = `issue:${work.repo_id}:${work.issue_id}`;
    if (nodes.has(issueId)) {
      upsertEdge(edges, {
        id: `issue_has_work_unit:${issueId}:${nodeId}`,
        source: issueId,
        target: nodeId,
        type: "issue_has_work_unit",
        edge_class: "lifecycle",
        provenance: "work_units",
      });
    }
    if (work.assigned_session_id) {
      const sessionId = `session:${work.assigned_session_id}`;
      if (nodes.has(sessionId)) {
        upsertEdge(edges, {
          id: `session_work_unit:${sessionId}:${nodeId}`,
          source: sessionId,
          target: nodeId,
          type: "session_issue",
          edge_class: "lifecycle",
          provenance: "work_units",
        });
      }
    }
    if (work.auth_request_id) {
      const authId = `auth_request:${work.auth_request_id}`;
      if (nodes.has(authId)) {
        upsertEdge(edges, {
          id: `auth_work_unit:${authId}:${nodeId}`,
          source: authId,
          target: nodeId,
          type: "auth_request_references_issue",
          edge_class: "lifecycle",
          provenance: "work_units",
        });
      }
    }
  }
}

function buildOperationalGraph(
  issueScanner: IssueScanner,
  params: GraphQueryParams,
): { nodes: GraphNode[]; edges: GraphEdge[]; truncated: boolean } {
  const sinceMs = params.since ? parseSince(params.since) : null;
  const sinceIso = sinceMs !== null ? msToIso(sinceMs) : null;
  const limit = params.limit ?? 120;
  const { nodes, issueNodeIds } = getIssueNodes(issueScanner, params);
  const edges = new Map<string, GraphEdge>();
  const sessionRows = params.mode === "issue" ? [] : getSessionRows(params, sinceIso, limit);
  const authRows = params.mode === "issue" ? [] : getAuthRows(params, sinceMs, limit);
  const sessionNodeIds = addSessionNodesAndEdges(sessionRows, params, nodes, edges);
  addAuthNodesAndEdges(authRows, issueNodeIds, nodes, edges);
  addIssueEdges(issueScanner, nodes, edges);
  addSessionIssueEdges(issueNodeIds, sessionNodeIds, edges);
  if (params.mode === "work") {
    addWorkUnits(params, nodes, edges, limit);
  }

  const allEdges = Array.from(edges.values());
  const { nodes: cappedNodes, truncated } = capGraphNodesForDisplay(
    Array.from(nodes.values()),
    allEdges,
    limit,
  );
  const cappedNodeIds = new Set(cappedNodes.map((node) => node.id));
  const cappedEdges = allEdges.filter(
    (edge) => cappedNodeIds.has(edge.source) && cappedNodeIds.has(edge.target),
  );

  return { nodes: cappedNodes, edges: cappedEdges, truncated };
}

function graphLayers(nodes: GraphNode[]): GraphLayerDescriptor[] {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    counts.set(node.type, (counts.get(node.type) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, count]) => ({ id, label: id.replace(/_/g, " "), count, enabled: true }));
}

function modeDescriptors(issueScanner: IssueScanner, activityCount: number): GraphModeDescriptor[] {
  const db = getDb();
  const issueCount = issueScanner.getRepoSummaries().reduce((sum, repo) => sum + repo.issues.length, 0);
  let workCount = 0;
  try {
    workCount = (db.prepare("SELECT COUNT(*) AS count FROM work_units").get() as { count: number }).count;
  } catch {
    workCount = 0;
  }
  const counts: Record<GraphMode, number> = {
    activity: activityCount,
    issue: issueCount,
    work: workCount,
    provenance: getIndexedGraphCount(db, "provenance"),
    "provider-lineage": getIndexedGraphCount(db, "provider-lineage"),
    "artifact-lineage": getIndexedGraphCount(db, "artifact-lineage"),
  };
  return GRAPH_MODES.map((mode) => ({
    ...mode,
    count: counts[mode.id],
    available: mode.id === "activity" || counts[mode.id] > 0,
  }));
}

export function registerGraphRoutes(
  app: RouteRegistrar,
  issueScanner: IssueScanner,
): void {
  app.get("/api/graph", (req, res) => {
    const params = parseQueryParams(req.query);
    const mode = params.mode ?? "activity";
    const providerId = req.query.provider || undefined;
    const root = req.query.root || undefined;
    let nodes: GraphNode[];
    let edges: GraphEdge[];
    let truncated = false;

    if (mode === "provider-lineage" || mode === "artifact-lineage" || mode === "provenance") {
      const indexed = getIndexedGraph(getDb(), {
        mode,
        providerId,
        root,
        limit: params.limit,
      });
      nodes = indexed.nodes;
      edges = indexed.edges;
    } else {
      const operational = buildOperationalGraph(issueScanner, params);
      nodes = operational.nodes;
      edges = operational.edges;
      truncated = operational.truncated;
    }

    const payload: GraphPayload = {
      version: 1,
      mode,
      nodes,
      edges,
      modes: modeDescriptors(issueScanner, nodes.length),
      layers: graphLayers(nodes),
      truncated,
    };

    res.json(payload);
  });
}
