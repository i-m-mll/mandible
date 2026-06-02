import path from "node:path";
import { getDb } from "../db.js";
import {
  buildLedgerIssueProjection,
  countLedgerGraphIssues,
  getLedgerGraphFilterOptions,
  ledgerGraphHasIssues,
} from "../ledger/graph-adapter.js";
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

const MODE_LAYER_ORDER: Partial<Record<GraphMode, string[]>> = {
  activity: ["auth_request", "issue", "session"],
  issue: ["issue"],
  work: ["repo", "issue", "work_unit", "branch", "session", "auth_request"],
  "provider-lineage": ["provider", "issue", "provider_spec", "provider_manifest", "run", "analysis", "artifact"],
  "artifact-lineage": ["artifact", "dataset", "model", "report"],
  provenance: ["provider", "provider_manifest", "artifact", "analysis", "report"],
};

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

function firstQueryValue(
  query: Record<string, string | string[] | undefined>,
  key: string,
): string | undefined {
  const value = query[key];
  if (Array.isArray(value)) return value.find((item) => item.trim() !== "");
  return value && value.trim() !== "" ? value : undefined;
}

function queryValues(
  query: Record<string, string | string[] | undefined>,
  key: string,
): string[] {
  const value = query[key];
  const raw = Array.isArray(value) ? value : value ? [value] : [];
  const seen = new Set<string>();
  for (const item of raw) {
    for (const part of item.split(",")) {
      const trimmed = part.trim();
      if (trimmed) seen.add(trimmed);
    }
  }
  return Array.from(seen);
}

function parseGraphMode(value: string | undefined): GraphMode {
  return GRAPH_MODES.some((mode) => mode.id === value) ? (value as GraphMode) : "activity";
}

export function parseQueryParams(query: Record<string, string | string[] | undefined>): GraphQueryParams {
  const limit = Math.min(Math.max(Number(firstQueryValue(query, "limit")) || 120, 1), 1000);
  const status = firstQueryValue(query, "status") === "all" ? "all" : "open";
  const repos = queryValues(query, "repo");
  const branches = queryValues(query, "branch");
  return {
    mode: parseGraphMode(firstQueryValue(query, "mode")),
    repo: repos[0],
    repos,
    branch: branches[0],
    branches,
    since: firstQueryValue(query, "since"),
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

function tableExists(table: string): boolean {
  try {
    const row = getDb()
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table);
    return Boolean(row);
  } catch {
    return false;
  }
}

function parseMetadataJson(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function issueNodeIdFromOperationalMetadata(
  issueNodeIds: Set<string>,
  metadataJson: string | null | undefined,
): string | null {
  const metadata = parseMetadataJson(metadataJson);
  const repoId = typeof metadata.repo_id === "string" ? metadata.repo_id : "";
  const issueRef = typeof metadata.legacy_issue_id === "string" ? metadata.legacy_issue_id : "";
  if (!issueRef) return null;

  if (repoId) {
    const exact = `issue:${repoId}:${issueRef}`;
    if (issueNodeIds.has(exact)) return exact;
  }

  for (const issueNodeId of issueNodeIds) {
    const parts = issueNodeId.split(":");
    const issueHumanId = parts[2];
    if (issueHumanId && (issueHumanId === issueRef || issueHumanId.startsWith(issueRef))) {
      return issueNodeId;
    }
  }
  return null;
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

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}

function activeRepoFilters(params: GraphQueryParams): string[] {
  return params.repos && params.repos.length > 0 ? params.repos : params.repo ? [params.repo] : [];
}

function activeBranchFilters(params: GraphQueryParams): string[] {
  return params.branches && params.branches.length > 0
    ? params.branches
    : params.branch ? [params.branch] : [];
}

function candidateMatchesFilter(candidate: string | null | undefined, filter: string): boolean {
  if (!candidate) return false;
  return candidate === filter || path.basename(filter) === candidate || filter.endsWith(`/${candidate}`);
}

function matchesRepoFilter(candidates: Array<string | null | undefined>, params: GraphQueryParams): boolean {
  const filters = activeRepoFilters(params);
  if (filters.length === 0) return true;
  return filters.some((filter) => candidates.some((candidate) => candidateMatchesFilter(candidate, filter)));
}

function addInClause(
  query: string,
  column: string,
  key: string,
  values: string[],
  bindings: Record<string, unknown>,
): string {
  if (values.length === 0) return query;
  const placeholders = values.map((value, index) => {
    const bindingKey = `${key}${index}`;
    bindings[bindingKey] = value;
    return `:${bindingKey}`;
  });
  return `${query} AND ${column} IN (${placeholders.join(", ")})`;
}

export function repoCandidatesFromCwd(cwd: string | null): string[] {
  if (!cwd) return [];
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  const worktreesIndex = parts.lastIndexOf("worktrees");
  const candidates = [path.basename(cwd)];
  if (worktreesIndex > 0) {
    candidates.push(parts[worktreesIndex - 1]);
  }
  return uniqueStrings(candidates);
}

function getIssueNodes(
  issueScanner: IssueScanner,
  params: GraphQueryParams,
): { nodes: Map<string, GraphNode>; issueNodeIds: Set<string>; issueNodeIdByLedgerId: Map<string, string> } {
  const nodes = new Map<string, GraphNode>();
  const issueNodeIds = new Set<string>();
  const summaries = issueScanner.getRepoSummaries();

  for (const summary of summaries) {
    if (!matchesRepoFilter([summary.repo_name, summary.repo_id], params)) {
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

  return { nodes, issueNodeIds, issueNodeIdByLedgerId: new Map() };
}

function getLedgerIssueNodes(
  params: GraphQueryParams,
): {
  nodes: Map<string, GraphNode>;
  issueNodeIds: Set<string>;
  issueNodeIdByLedgerId: Map<string, string>;
  edges: GraphEdge[];
} | null {
  const projection = buildLedgerIssueProjection(getDb(), params);
  if (!projection) return null;
  return {
    nodes: new Map(projection.nodes.map((node) => [node.id, node])),
    issueNodeIds: projection.issueNodeIds,
    issueNodeIdByLedgerId: projection.issueNodeIdByLedgerId,
    edges: projection.edges,
  };
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
  query = addInClause(query, "branch", "branch", activeBranchFilters(params), bindings);
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
    const repoCandidates = repoCandidatesFromCwd(session.cwd);
    const repo = repoCandidates[0];
    if (!matchesRepoFilter(repoCandidates, params)) continue;
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
  issue_references: string | null;
  issue_closures: string | null;
  issue_ids: string | null;
  issues: string | null;
  created_at: number;
}

function getAuthRows(params: GraphQueryParams, sinceMs: number | null, limit: number): AuthRow[] {
  const db = getDb();
  let query = `
    SELECT id, title, status, repo, head_branch, commit_message,
           issue_references, issue_closures, issue_ids, issues, created_at
      FROM auth_requests
     WHERE 1=1
  `;
  const bindings: Record<string, unknown> = {};
  if (sinceMs !== null) {
    query += ` AND created_at >= :sinceMs`;
    bindings.sinceMs = sinceMs;
  }
  query = addInClause(query, "repo", "repo", activeRepoFilters(params), bindings);
  query = addInClause(query, "head_branch", "branch", activeBranchFilters(params), bindings);
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
  issueNodeIdByLedgerId: Map<string, string>,
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
      for (const field of [auth.issue_references, auth.issue_closures, auth.issue_ids, auth.issues]) {
        const parsed = field ? JSON.parse(field) : [];
        if (Array.isArray(parsed)) parsed.forEach((ref) => typeof ref === "string" && refs.add(ref));
      }
    } catch {
      // ignore legacy malformed issue values
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

  if (tableExists("ledger_auth_issue_links")) {
    const authIds = Array.from(authNodeIds);
    if (authIds.length > 0) {
      const placeholders = authIds.map((_, index) => `:auth${index}`);
      const bindings = Object.fromEntries(authIds.map((id, index) => [`auth${index}`, id]));
      const rows = getDb().prepare(
        `SELECT auth_request_id, issue_id AS ledger_issue_id, metadata_json
         FROM ledger_auth_issue_links
         WHERE auth_request_id IN (${placeholders.join(", ")})`
      ).all(bindings) as Array<{
        auth_request_id: string;
        ledger_issue_id: string;
        metadata_json: string;
      }>;
      for (const row of rows) {
        const issueNodeId = issueNodeIdByLedgerId.get(row.ledger_issue_id)
          ?? issueNodeIdFromOperationalMetadata(issueNodeIds, row.metadata_json);
        if (!issueNodeId) continue;
        upsertEdge(edges, {
          id: `ledger_auth_issue:${row.auth_request_id}:${row.ledger_issue_id}`,
          source: `auth_request:${row.auth_request_id}`,
          target: issueNodeId,
          type: "auth_issue",
          edge_class: "lifecycle",
          provenance: "ledger_auth_issue_links",
        });
      }
    }
  }

  return authNodeIds;
}

function addSessionIssueEdges(
  issueNodeIds: Set<string>,
  issueNodeIdByLedgerId: Map<string, string>,
  sessionNodeIds: Set<string>,
  edges: Map<string, GraphEdge>,
): void {
  interface SessionIssueRow {
    session_id: string;
    issue_id: string;
    repo_id: string;
  }

  const sessionIds = sessionIdsFromGraphNodeIds(sessionNodeIds);
  if (sessionIds.length === 0) return;
  const placeholders = sessionIds.map((_, index) => `:session${index}`);
  const bindings = Object.fromEntries(
    sessionIds.map((id, index) => [`session${index}`, id]),
  );

  let rows: SessionIssueRow[];
  try {
    rows = getDb().prepare(
      `SELECT session_id, issue_id, repo_id
         FROM session_issues
        WHERE session_id IN (${placeholders.join(", ")})`
    ).all(bindings) as SessionIssueRow[];
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

  if (tableExists("ledger_session_issue_links")) {
    const ledgerRows = getDb().prepare(
      `SELECT session_id, issue_id AS ledger_issue_id, metadata_json
         FROM ledger_session_issue_links
        WHERE session_id IN (${placeholders.join(", ")})`
    ).all(bindings) as Array<{ session_id: string; ledger_issue_id: string; metadata_json: string }>;
    for (const row of ledgerRows) {
      const sessionNodeId = `session:${row.session_id}`;
      const issueNodeId = issueNodeIdByLedgerId.get(row.ledger_issue_id)
        ?? issueNodeIdFromOperationalMetadata(issueNodeIds, row.metadata_json);
      if (issueNodeId && sessionNodeIds.has(sessionNodeId) && issueNodeIds.has(issueNodeId)) {
        upsertEdge(edges, {
          id: `ledger_session_issue:${row.session_id}:${row.ledger_issue_id}`,
          source: sessionNodeId,
          target: issueNodeId,
          type: "session_issue",
          edge_class: "lifecycle",
          provenance: "ledger_session_issue_links",
        });
      }
    }
  }
}

export function sessionIdsFromGraphNodeIds(sessionNodeIds: Set<string>): string[] {
  const ids = new Set<string>();
  for (const nodeId of sessionNodeIds) {
    if (nodeId.startsWith("session:")) {
      const sessionId = nodeId.slice("session:".length);
      if (sessionId) ids.add(sessionId);
    }
  }
  return Array.from(ids);
}

function addWorkUnits(
  params: GraphQueryParams,
  nodes: Map<string, GraphNode>,
  edges: Map<string, GraphEdge>,
  issueNodeIdByLedgerId: Map<string, string>,
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
    ledger_issue_id: string | null;
    created_at: number;
  }
  const bindings: Record<string, unknown> = { limit };
  let query = `
    SELECT id, issue_id, repo_id, branch, kind, state, assigned_session_id,
           auth_request_id, ledger_issue_id, created_at
      FROM work_units
     WHERE 1=1
  `;
  query = addInClause(query, "repo_id", "repo", activeRepoFilters(params), bindings);
  query = addInClause(query, "branch", "branch", activeBranchFilters(params), bindings);
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
    const issueId = work.ledger_issue_id
      ? issueNodeIdByLedgerId.get(work.ledger_issue_id) ?? `issue:${work.repo_id}:${work.issue_id}`
      : `issue:${work.repo_id}:${work.issue_id}`;
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
  const edges = new Map<string, GraphEdge>();
  const ledgerProjection = ledgerGraphHasIssues(getDb()) ? getLedgerIssueNodes(params) : null;
  const {
    nodes,
    issueNodeIds,
    issueNodeIdByLedgerId,
    edges: ledgerEdges,
  } = ledgerProjection ?? { ...getIssueNodes(issueScanner, params), edges: [] as GraphEdge[] };
  for (const edge of ledgerEdges) {
    upsertEdge(edges, edge);
  }
  const sessionRows = params.mode === "issue" ? [] : getSessionRows(params, sinceIso, limit);
  const authRows = params.mode === "issue" ? [] : getAuthRows(params, sinceMs, limit);
  const sessionNodeIds = addSessionNodesAndEdges(sessionRows, params, nodes, edges);
  addAuthNodesAndEdges(authRows, issueNodeIds, issueNodeIdByLedgerId, nodes, edges);
  if (!ledgerProjection) {
    addIssueEdges(issueScanner, nodes, edges);
  }
  addSessionIssueEdges(issueNodeIds, issueNodeIdByLedgerId, sessionNodeIds, edges);
  if (params.mode === "work") {
    addWorkUnits(params, nodes, edges, issueNodeIdByLedgerId, limit);
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

function graphLayers(nodes: GraphNode[], mode: GraphMode): GraphLayerDescriptor[] {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    counts.set(node.type, (counts.get(node.type) ?? 0) + 1);
  }
  const orderedIds = MODE_LAYER_ORDER[mode] ?? [];
  const ids = new Set([...orderedIds, ...counts.keys()]);
  return Array.from(ids)
    .sort((a, b) => {
      const rankA = orderedIds.indexOf(a);
      const rankB = orderedIds.indexOf(b);
      if (rankA !== -1 || rankB !== -1) {
        return (rankA === -1 ? Number.MAX_SAFE_INTEGER : rankA)
          - (rankB === -1 ? Number.MAX_SAFE_INTEGER : rankB);
      }
      return a.localeCompare(b);
    })
    .map((id) => {
      const count = counts.get(id) ?? 0;
      return { id, label: id.replace(/_/g, " "), count, enabled: count > 0 };
    });
}

function normalizeRepoOption(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const basename = trimmed.includes("/") ? path.basename(trimmed) : trimmed;
  if (/^(feature|codex|bugfix|fix|chore|topic)(\/|__)/.test(basename)) return undefined;
  if (["develop", "dev", "main", "master", "test", "worktrees"].includes(basename.toLowerCase())) {
    return undefined;
  }
  return basename;
}

function graphFilterOptions(issueScanner: IssueScanner): GraphPayload["filters"] {
  const repos = new Set<string>();
  const branches = new Set<string>();
  const db = getDb();
  const addRepo = (value: string | null | undefined): void => {
    const normalized = normalizeRepoOption(value);
    if (normalized) repos.add(normalized);
  };

  for (const summary of issueScanner.getRepoSummaries()) {
    if (summary.repo_name) addRepo(summary.repo_name);
    else addRepo(summary.repo_id);
  }

  const ledgerFilters = getLedgerGraphFilterOptions(db);
  for (const repo of ledgerFilters.repos) addRepo(repo);
  for (const branch of ledgerFilters.branches) branches.add(branch);

  try {
    const rows = db.prepare("SELECT repo, head_branch FROM auth_requests").all() as Array<{
      repo: string | null;
      head_branch: string | null;
    }>;
    for (const row of rows) {
      addRepo(row.repo);
      if (row.head_branch) branches.add(row.head_branch);
    }
  } catch {
    // auth_requests can be absent in older local databases.
  }

  try {
    const rows = db.prepare("SELECT repo_id, branch FROM work_units").all() as Array<{
      repo_id: string | null;
      branch: string | null;
    }>;
    for (const row of rows) {
      addRepo(row.repo_id);
      if (row.branch) branches.add(row.branch);
    }
  } catch {
    // work_units can be absent before the work queue schema is initialized.
  }

  try {
    const knownRepoValues = Array.from(repos);
    const rows = db.prepare("SELECT cwd, branch FROM sessions").all() as Array<{
      cwd: string | null;
      branch: string | null;
    }>;
    for (const row of rows) {
      for (const candidate of repoCandidatesFromCwd(row.cwd)) {
        const normalized = normalizeRepoOption(candidate);
        if (!normalized) continue;
        const knownRepo = knownRepoValues.some((repo) => {
          return candidateMatchesFilter(normalized, repo) || candidateMatchesFilter(repo, normalized);
        });
        if (knownRepo) repos.add(normalized);
      }
      if (row.branch) branches.add(row.branch);
    }
  } catch {
    // sessions can be absent in older local databases.
  }

  return {
    repos: Array.from(repos).sort((a, b) => a.localeCompare(b)),
    branches: Array.from(branches).sort((a, b) => a.localeCompare(b)),
  };
}

function graphModeCounts(
  issueScanner: IssueScanner,
): Record<GraphMode, number> {
  const db = getDb();
  const issueCount = countLedgerGraphIssues(db, "all")
    ?? issueScanner.getRepoSummaries().reduce((sum, repo) => sum + repo.issues.length, 0);
  const sessionCount = countTableRows("sessions");
  const authCount = countTableRows("auth_requests");
  const workCount = countTableRows("work_units");
  return {
    activity: issueCount + sessionCount + authCount,
    issue: issueCount,
    work: workCount,
    provenance: getIndexedGraphCount(db, "provenance"),
    "provider-lineage": getIndexedGraphCount(db, "provider-lineage"),
    "artifact-lineage": getIndexedGraphCount(db, "artifact-lineage"),
  };
}

function modeDescriptors(counts: Record<GraphMode, number>): GraphModeDescriptor[] {
  return GRAPH_MODES.map((mode) => ({
    ...mode,
    count: counts[mode.id],
    available: mode.id === "activity" || counts[mode.id] > 0,
  }));
}

function countTableRows(table: string): number {
  if (!tableExists(table)) return 0;
  try {
    return (getDb().prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
  } catch {
    return 0;
  }
}

export function registerGraphRoutes(
  app: RouteRegistrar,
  issueScanner: IssueScanner,
): void {
  app.get("/api/graph", (req, res) => {
    const query = req.query as Record<string, string | string[] | undefined>;
    const params = parseQueryParams(query);
    const mode = params.mode ?? "activity";
    const providerId = firstQueryValue(query, "provider");
    const root = firstQueryValue(query, "root");
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

    const counts = graphModeCounts(issueScanner);
    const payload: GraphPayload = {
      version: 1,
      mode,
      nodes,
      edges,
      modes: modeDescriptors(counts),
      layers: graphLayers(nodes, mode),
      filters: graphFilterOptions(issueScanner),
      truncated,
      limit: params.limit,
      displayed_count: nodes.length,
      available_count: counts[mode],
    };

    res.json(payload);
  });
}
