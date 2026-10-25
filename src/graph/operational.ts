import path from "node:path";
import { getDb } from "../db.js";
import { tableExists } from "../db-introspection.js";
import {
  buildLedgerIssueProjection,
  countLedgerGraphIssues,
  getLedgerGraphFilterOptions,
} from "../ledger/graph-adapter.js";
import { getIndexedGraphCount } from "../provider-artifacts.js";
import type {
  GraphEdge,
  GraphMode,
  GraphNode,
  GraphPayload,
  GraphQueryParams,
} from "../types.js";
import { graphSpecForMode, parseSince } from "./spec.js";
import { selectGraphForDisplay } from "./selection.js";
import { parseJsonObject } from "../row-coerce.js";

// Bug: 7a141c3 — graph API implementation
// Bug: 50c4afb — typed graph modes for the React Flow graph workspace
// Bug: 22a54d4 — ledger/session/auth/work-unit projection moved out of the HTTP route module

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


/**
 * The issue nodes whose human id (the third `:` part of the node id) starts
 * with a ref, in the order of the node set, found by binary search over the
 * human ids in sorted order.
 */
class IssueHumanIdIndex {
  private sorted: ReadonlyArray<{ humanId: string; nodeId: string; order: number }> | null = null;

  constructor(private readonly issueNodeIds: Iterable<string>) {}

  private entries(): ReadonlyArray<{ humanId: string; nodeId: string; order: number }> {
    if (this.sorted) return this.sorted;
    const entries: Array<{ humanId: string; nodeId: string; order: number }> = [];
    let order = 0;
    for (const nodeId of this.issueNodeIds) {
      const humanId = nodeId.split(":")[2];
      if (humanId) entries.push({ humanId, nodeId, order });
      order += 1;
    }
    return this.sorted = entries.sort((a, b) => (a.humanId < b.humanId ? -1 : a.humanId > b.humanId ? 1 : a.order - b.order));
  }

  nodesWithPrefix(ref: string): string[] {
    const entries = this.entries();
    let low = 0;
    let high = entries.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (entries[mid].humanId < ref) low = mid + 1;
      else high = mid;
    }
    const matches: Array<{ nodeId: string; order: number }> = [];
    for (let index = low; index < entries.length && entries[index].humanId.startsWith(ref); index += 1) {
      matches.push(entries[index]);
    }
    return matches.sort((a, b) => a.order - b.order).map((match) => match.nodeId);
  }

  firstWithPrefix(ref: string): string | null {
    return this.nodesWithPrefix(ref)[0] ?? null;
  }
}

function issueNodeIdFromOperationalMetadata(
  issueNodeIds: Set<string>,
  humanIds: IssueHumanIdIndex,
  metadataJson: string | null | undefined,
): string | null {
  const metadata = parseJsonObject(metadataJson);
  const repoId = typeof metadata.repo_id === "string" ? metadata.repo_id : "";
  const issueRef = typeof metadata.legacy_issue_id === "string" ? metadata.legacy_issue_id : "";
  if (!issueRef) return null;

  if (repoId) {
    const exact = `issue:${repoId}:${issueRef}`;
    if (issueNodeIds.has(exact)) return exact;
  }

  return humanIds.firstWithPrefix(issueRef);
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

function getLedgerIssueNodes(
  params: GraphQueryParams,
): {
  nodes: Map<string, GraphNode>;
  issueNodeIds: Set<string>;
  issueNodeIdByLedgerId: Map<string, string>;
  edges: GraphEdge[];
  detail: (nodes: readonly GraphNode[]) => GraphNode[];
} | null {
  const projection = buildLedgerIssueProjection(getDb(), params);
  if (!projection) return null;
  return {
    nodes: new Map(projection.nodes.map((node) => [node.id, node])),
    issueNodeIds: projection.issueNodeIds,
    issueNodeIdByLedgerId: projection.issueNodeIdByLedgerId,
    edges: projection.edges,
    detail: projection.detail,
  };
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
  issue_references: string | null;
  issue_closures: string | null;
  issue_ids: string | null;
  issues: string | null;
  created_at: number;
}

function getAuthRows(params: GraphQueryParams, sinceMs: number | null, limit: number): AuthRow[] {
  const db = getDb();
  let query = `
    SELECT id, title, status, repo, head_branch,
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
  humanIds: IssueHumanIdIndex,
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
    try {
      for (const field of [auth.issue_references, auth.issue_closures, auth.issues]) {
        const parsed = field ? JSON.parse(field) : [];
        if (Array.isArray(parsed)) parsed.forEach((ref) => typeof ref === "string" && refs.add(ref));
      }
    } catch {
      // ignore legacy malformed issue values
    }

    for (const ref of refs) {
      for (const issueNodeId of humanIds.nodesWithPrefix(ref)) {
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

  if (tableExists(getDb(), "ledger_auth_issue_links")) {
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
          ?? issueNodeIdFromOperationalMetadata(issueNodeIds, humanIds, row.metadata_json);
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
  humanIds: IssueHumanIdIndex,
  issueNodeIdByLedgerId: Map<string, string>,
  sessionNodeIds: Set<string>,
  edges: Map<string, GraphEdge>,
): void {
  const sessionIds = sessionIdsFromGraphNodeIds(sessionNodeIds);
  if (sessionIds.length === 0 || !tableExists(getDb(), "ledger_session_issue_links")) return;
  const placeholders = sessionIds.map((_, index) => `:session${index}`);
  const bindings = Object.fromEntries(
    sessionIds.map((id, index) => [`session${index}`, id]),
  );

  // A link is keyed on the provider session id when one is known, so a
  // session row reaches its links through its own id or its conversation id.
  const ledgerRows = getDb().prepare(
    `SELECT s.id AS session_id, l.issue_id AS ledger_issue_id, l.metadata_json
       FROM sessions s
       JOIN ledger_session_issue_links l
         ON l.session_id = s.id OR l.session_id = s.conversation_id
      WHERE s.id IN (${placeholders.join(", ")})`
  ).all(bindings) as Array<{ session_id: string; ledger_issue_id: string; metadata_json: string }>;
  for (const row of ledgerRows) {
    const sessionNodeId = `session:${row.session_id}`;
    const issueNodeId = issueNodeIdByLedgerId.get(row.ledger_issue_id)
      ?? issueNodeIdFromOperationalMetadata(issueNodeIds, humanIds, row.metadata_json);
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

function emptyLedgerIssueProjection(): {
  nodes: Map<string, GraphNode>;
  issueNodeIds: Set<string>;
  issueNodeIdByLedgerId: Map<string, string>;
  edges: GraphEdge[];
  detail: (nodes: readonly GraphNode[]) => GraphNode[];
} {
  return {
    nodes: new Map(),
    issueNodeIds: new Set(),
    issueNodeIdByLedgerId: new Map(),
    edges: [],
    detail: (nodes) => [...nodes],
  };
}

export function buildOperationalGraph(
  params: GraphQueryParams,
): ReturnType<typeof selectGraphForDisplay> {
  const spec = params.spec ?? graphSpecForMode(params.mode ?? "issue");
  const sinceMs = params.since ? parseSince(params.since) : null;
  const sinceIso = sinceMs !== null ? msToIso(sinceMs) : null;
  const limit = spec.limit;
  const edges = new Map<string, GraphEdge>();
  const ledgerProjection = getLedgerIssueNodes(params) ?? emptyLedgerIssueProjection();
  const {
    nodes,
    issueNodeIds,
    issueNodeIdByLedgerId,
    edges: ledgerEdges,
    detail,
  } = ledgerProjection;
  for (const edge of ledgerEdges) {
    upsertEdge(edges, edge);
  }
  const includeSessions = spec.node_types.includes("session");
  const includeAuthRequests = spec.node_types.includes("auth_request");
  const includeWorkUnits = spec.node_types.includes("work_unit");
  const sessionRows = includeSessions ? getSessionRows(params, sinceIso, limit) : [];
  const authRows = includeAuthRequests ? getAuthRows(params, sinceMs, limit) : [];
  const sessionNodeIds = addSessionNodesAndEdges(sessionRows, params, nodes, edges);
  const humanIds = new IssueHumanIdIndex(issueNodeIds);
  addAuthNodesAndEdges(authRows, issueNodeIds, humanIds, issueNodeIdByLedgerId, nodes, edges);
  addSessionIssueEdges(issueNodeIds, humanIds, issueNodeIdByLedgerId, sessionNodeIds, edges);
  if (includeWorkUnits) {
    addWorkUnits(params, nodes, edges, issueNodeIdByLedgerId, limit);
  }

  const selected = selectGraphForDisplay(Array.from(nodes.values()), Array.from(edges.values()), spec);
  return { ...selected, nodes: detail(selected.nodes) };
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

export function graphFilterOptions(): GraphPayload["filters"] {
  const repos = new Set<string>();
  const branches = new Set<string>();
  const db = getDb();
  const addRepo = (value: string | null | undefined): void => {
    const normalized = normalizeRepoOption(value);
    if (normalized) repos.add(normalized);
  };

  const ledgerFilters = getLedgerGraphFilterOptions(db);
  for (const repo of ledgerFilters.repos) addRepo(repo);
  for (const branch of ledgerFilters.branches) branches.add(branch);

  try {
    const rows = db.prepare("SELECT DISTINCT repo, head_branch FROM auth_requests").all() as Array<{
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
    const rows = db.prepare("SELECT DISTINCT repo_id, branch FROM work_units").all() as Array<{
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
    const rows = db.prepare("SELECT DISTINCT cwd, branch FROM sessions").all() as Array<{
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

export function graphModeCounts(): Record<GraphMode, number> {
  const db = getDb();
  const issueCount = countLedgerGraphIssues(db, "all") ?? 0;
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

const COUNT_TABLE_ALLOWLIST = new Set(["sessions", "auth_requests", "work_units"]);

function countTableRows(table: string): number {
  if (!COUNT_TABLE_ALLOWLIST.has(table)) return 0;
  if (!tableExists(getDb(), table)) return 0;
  try {
    return (getDb().prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
  } catch {
    return 0;
  }
}
