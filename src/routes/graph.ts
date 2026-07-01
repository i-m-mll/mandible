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
  GraphDisplayCounts,
  GraphEdge,
  GraphLegendItem,
  GraphLayerDescriptor,
  GraphMode,
  GraphModeDescriptor,
  GraphNode,
  GraphPayload,
  GraphPreset,
  GraphPresetDescriptor,
  GraphQueryParams,
  GraphSpec,
} from "../types.js";
import { extractMandibleIssueRefs } from "../utils/bug-refs.js";

// Bug: 7a141c3 — graph API implementation
// Bug: 50c4afb — typed graph modes for the React Flow graph workspace

export const GRAPH_PERSPECTIVES: Array<Omit<GraphModeDescriptor, "count" | "available">> = [
  {
    id: "activity",
    label: "Activity",
    kind: "perspective",
    description: "What changed recently or needs attention now.",
    summary: "What changed recently or needs attention now.",
  },
  {
    id: "issue",
    label: "Issues",
    kind: "perspective",
    description: "How issues relate to other issues.",
    summary: "How issues relate to other issues.",
  },
  {
    id: "work",
    label: "Work",
    kind: "perspective",
    description: "How work moves through repos, branches, sessions, issues, and auth.",
    summary: "How work moves through repos, branches, sessions, issues, and auth.",
  },
  {
    id: "provider-lineage",
    label: "Provider Lineage",
    kind: "perspective",
    description: "What a provider or tool produced from the request and spec to outputs.",
    summary: "What a provider or tool produced from the request and spec to outputs.",
  },
  {
    id: "artifact-lineage",
    label: "Artifact Lineage",
    kind: "perspective",
    description: "Where an artifact came from and what reused or derived from it.",
    summary: "Where an artifact came from and what reused or derived from it.",
  },
  {
    id: "provenance",
    label: "Provenance",
    kind: "perspective",
    description: "Evidence for which session, action, commit, or run produced or justified an object.",
    summary: "Evidence for which session, action, commit, or run produced or justified an object.",
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

const STRUCTURAL_ISSUE_EDGES = ["umbrella_child", "parent_child", "parent", "blocks", "implements"];

const PRESET_LABELS: Record<GraphPreset, { label: string; description: string }> = {
  activity: {
    label: "Activity",
    description: "Recent operational state plus issue/work/auth/session edges.",
  },
  issues: {
    label: "Issues",
    description: "Open issue nodes with structural issue relationships.",
  },
  work: {
    label: "Work",
    description: "Issues, work units, sessions, auth requests, and lifecycle edges.",
  },
  "provider-lineage": {
    label: "Provider Lineage",
    description: "Provider and tool request/output lineage.",
  },
  "artifact-lineage": {
    label: "Artifact Lineage",
    description: "Artifact derivation and reuse lineage.",
  },
  provenance: {
    label: "Provenance",
    description: "Evidence for sessions, actions, commits, and artifacts.",
  },
};

const PRESET_SPECS: Record<GraphPreset, GraphSpec> = {
  issues: {
    preset: "issues",
    node_types: ["issue"],
    edge_types: STRUCTURAL_ISSUE_EDGES,
    edge_classes: ["semantic"],
    filters: {
      repos: [],
      branches: [],
      status: { issue: ["open"] },
    },
    limit: 120,
    include_isolates: true,
    endpoint_policy: "strict",
    layout: {
      strategy: "structured",
      primary_edge_types: ["umbrella_child", "parent_child", "parent"],
    },
  },
  work: {
    preset: "work",
    node_types: ["issue", "work_unit", "branch", "session", "auth_request"],
    edge_types: [
      ...STRUCTURAL_ISSUE_EDGES,
      "auth_issue",
      "session_issue",
      "session_parent",
      "issue_has_work_unit",
      "auth_request_references_issue",
    ],
    edge_classes: ["semantic", "lifecycle"],
    filters: {
      repos: [],
      branches: [],
      status: { issue: ["open", "closed"] },
    },
    limit: 120,
    include_isolates: true,
    endpoint_policy: "strict",
    layout: {
      strategy: "structured",
      primary_edge_types: ["umbrella_child", "parent_child", "parent"],
    },
  },
  activity: {
    preset: "activity",
    node_types: ["issue", "session", "auth_request"],
    edge_types: [
      ...STRUCTURAL_ISSUE_EDGES,
      "auth_issue",
      "session_issue",
      "session_parent",
    ],
    edge_classes: ["semantic", "lifecycle"],
    filters: {
      repos: [],
      branches: [],
      status: { issue: ["open", "closed"] },
    },
    limit: 120,
    include_isolates: true,
    endpoint_policy: "strict",
    layout: {
      strategy: "structured",
      primary_edge_types: ["umbrella_child", "parent_child", "parent"],
    },
  },
  "provider-lineage": {
    preset: "provider-lineage",
    node_types: ["provider", "provider_spec", "provider_manifest", "run", "analysis", "artifact", "issue"],
    edge_types: [
      "provider_emitted_manifest",
      "manifest_declares",
      "manifest_references_artifact",
      "produced",
      "derived_from",
      "validated_by",
      "requested_by",
    ],
    edge_classes: ["provider", "provenance", "semantic"],
    filters: {
      repos: [],
      branches: [],
      status: {},
    },
    limit: 120,
    include_isolates: true,
    endpoint_policy: "strict",
    layout: {
      strategy: "explore",
      primary_edge_types: ["provider_emitted_manifest", "manifest_declares", "produced"],
    },
  },
  "artifact-lineage": {
    preset: "artifact-lineage",
    node_types: ["artifact", "dataset", "model", "report", "analysis"],
    edge_types: ["produced", "derived_from", "validated_by", "requested_by"],
    edge_classes: ["provider", "provenance"],
    filters: {
      repos: [],
      branches: [],
      status: {},
    },
    limit: 120,
    include_isolates: true,
    endpoint_policy: "strict",
    layout: {
      strategy: "explore",
      primary_edge_types: ["derived_from", "produced"],
    },
  },
  provenance: {
    preset: "provenance",
    node_types: ["provider", "provider_manifest", "artifact", "analysis", "report", "session", "commit"],
    edge_types: ["requested_by", "approved_by", "produced", "validated_by", "derived_from"],
    edge_classes: ["provenance", "provider"],
    filters: {
      repos: [],
      branches: [],
      status: {},
    },
    limit: 120,
    include_isolates: true,
    endpoint_policy: "strict",
    layout: {
      strategy: "explore",
      primary_edge_types: ["requested_by", "produced", "validated_by"],
    },
  },
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
  return GRAPH_PERSPECTIVES.some((mode) => mode.id === value) ? (value as GraphMode) : "issue";
}

function presetFromMode(mode: GraphMode): GraphPreset {
  return mode === "issue" ? "issues" : mode;
}

function modeFromPreset(preset: GraphPreset): GraphMode {
  return preset === "issues" ? "issue" : preset;
}

function parsePreset(value: string | undefined): GraphPreset | undefined {
  if (!value) return undefined;
  if (value === "issue") return "issues";
  return Object.prototype.hasOwnProperty.call(PRESET_SPECS, value) ? (value as GraphPreset) : undefined;
}

function uniqueList(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.trim() !== "")));
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueList(value.filter((item): item is string => typeof item === "string"));
}

function parseSpecJson(value: string | undefined): Partial<GraphSpec> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Partial<GraphSpec>
      : {};
  } catch {
    return {};
  }
}

function mergeSpec(base: GraphSpec, patch: Partial<GraphSpec>): GraphSpec {
  return {
    ...base,
    ...patch,
    node_types: stringList(patch.node_types).length > 0
      ? stringList(patch.node_types)
      : [...base.node_types],
    edge_types: stringList(patch.edge_types).length > 0
      ? stringList(patch.edge_types)
      : [...base.edge_types],
    edge_classes: stringList(patch.edge_classes).length > 0
      ? stringList(patch.edge_classes)
      : base.edge_classes ? [...base.edge_classes] : undefined,
    filters: {
      ...base.filters,
      ...(patch.filters ?? {}),
      repos: stringList(patch.filters?.repos).length > 0
        ? stringList(patch.filters?.repos)
        : [...base.filters.repos],
      branches: stringList(patch.filters?.branches).length > 0
        ? stringList(patch.filters?.branches)
        : [...base.filters.branches],
      status: {
        ...base.filters.status,
        ...(patch.filters?.status ?? {}),
      },
    },
    limit: Math.min(Math.max(Number(patch.limit) || base.limit, 1), 1000),
    include_isolates: typeof patch.include_isolates === "boolean"
      ? patch.include_isolates
      : base.include_isolates,
    endpoint_policy: patch.endpoint_policy === "include-context" ? "include-context" : base.endpoint_policy,
    layout: {
      ...base.layout,
      ...(patch.layout ?? {}),
      primary_edge_types: stringList(patch.layout?.primary_edge_types).length > 0
        ? stringList(patch.layout?.primary_edge_types)
        : [...base.layout.primary_edge_types],
    },
  };
}

function normalizeIssueStatus(status: string | undefined): string[] | undefined {
  if (status === undefined) return undefined;
  return status === "all" ? ["open", "closed"] : ["open"];
}

export function normalizeGraphSpec(query: Record<string, string | string[] | undefined>): GraphSpec {
  const explicitMode = firstQueryValue(query, "mode");
  const explicitPreset = parsePreset(firstQueryValue(query, "preset"));
  const mode = explicitMode ? parseGraphMode(explicitMode) : "issue";
  const jsonSpec = parseSpecJson(firstQueryValue(query, "spec"));
  const preset = parsePreset(jsonSpec.preset) ?? explicitPreset ?? presetFromMode(mode);
  const base = mergeSpec(PRESET_SPECS[preset], jsonSpec);
  const repos = queryValues(query, "repo");
  const branches = queryValues(query, "branch");
  const nodeTypes = queryValues(query, "node_type");
  const edgeTypes = queryValues(query, "edge_type");
  const edgeClasses = queryValues(query, "edge_class");
  const issueStatus = normalizeIssueStatus(firstQueryValue(query, "status"));
  const limitValue = firstQueryValue(query, "limit");
  const includeIsolatesValue = firstQueryValue(query, "include_isolates");
  const since = firstQueryValue(query, "since") ?? firstQueryValue(query, "time") ?? base.filters.since;

  return mergeSpec(base, {
    preset,
    node_types: nodeTypes.length > 0 ? nodeTypes : base.node_types,
    edge_types: edgeTypes.length > 0 ? edgeTypes : base.edge_types,
    edge_classes: edgeClasses.length > 0 ? edgeClasses : base.edge_classes,
    filters: {
      ...base.filters,
      repos: repos.length > 0 ? repos : base.filters.repos,
      branches: branches.length > 0 ? branches : base.filters.branches,
      since,
      status: {
        ...base.filters.status,
        ...(issueStatus ? { issue: issueStatus } : {}),
      },
    },
    limit: limitValue ? Number(limitValue) : base.limit,
    include_isolates: includeIsolatesValue === undefined
      ? base.include_isolates
      : includeIsolatesValue !== "false" && includeIsolatesValue !== "0",
  });
}

export function parseQueryParams(query: Record<string, string | string[] | undefined>): GraphQueryParams {
  const spec = normalizeGraphSpec(query);
  const repos = spec.filters.repos;
  const branches = spec.filters.branches;
  const issueStatuses = spec.filters.status.issue ?? [];
  const status = issueStatuses.includes("closed") ? "all" : "open";
  const mode = modeFromPreset(spec.preset ?? "issues");
  return {
    mode,
    spec,
    repo: repos[0],
    repos,
    branch: branches[0],
    branches,
    since: spec.filters.since,
    limit: spec.limit,
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
  const graphActivityAt = node.detail?.graph_activity_at ?? node.summary?.graph_activity_at;
  if (typeof graphActivityAt === "string") {
    const ms = new Date(graphActivityAt).getTime();
    if (!Number.isNaN(ms)) return ms;
  }
  const updatedMs = node.updated_at ? new Date(node.updated_at).getTime() : NaN;
  if (!Number.isNaN(updatedMs)) return updatedMs;
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

function isWeakIssueReferenceEdge(edge: GraphEdge): boolean {
  if (edge.edge_class !== "semantic") return false;
  return edge.type === "references"
    || edge.type === "curated_related"
    || edge.type === "related";
}

function edgeFamilyIds(edge: GraphEdge): string[] {
  const ids = new Set<string>([edge.type]);
  const relationshipType = edge.metadata?.relationship_type;
  if (typeof relationshipType === "string") ids.add(relationshipType);
  if (edge.type === "umbrella_child") ids.add("parent_child");
  return Array.from(ids);
}

function graphSpecForMode(mode: GraphMode): GraphSpec {
  return PRESET_SPECS[presetFromMode(mode)];
}

function edgeMatchesSpec(edge: GraphEdge, spec: GraphSpec): boolean {
  if (spec.edge_classes && spec.edge_classes.length > 0) {
    if (!edge.edge_class || !spec.edge_classes.includes(edge.edge_class)) return false;
  }
  if (spec.edge_types.length === 0) return true;
  return edgeFamilyIds(edge).some((family) => spec.edge_types.includes(family));
}

export function graphEdgesForMode(mode: GraphMode, edges: GraphEdge[]): GraphEdge[] {
  return edges.filter((edge) => edgeMatchesSpec(edge, graphSpecForMode(mode)));
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
      extractMandibleIssueRefs(auth.commit_message).forEach((ref) => refs.add(ref));
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

function nodeTypeAllowed(node: GraphNode, spec: GraphSpec): boolean {
  return spec.node_types.length === 0 || spec.node_types.includes(node.type);
}

const LEGEND_LABELS: Record<string, string> = {
  issue: "Issues",
  auth_request: "Auth requests",
  work_unit: "Work units",
  provider_spec: "Provider specs",
  provider_manifest: "Provider manifests",
  umbrella_child: "Parent/child hierarchy",
  parent_child: "Parent/child hierarchy",
  parent: "Parent/child hierarchy",
  session_parent: "Session lineage",
  session_issue: "Session evidence",
  auth_issue: "Auth evidence",
  auth_request_references_issue: "Auth references",
  issue_has_work_unit: "Issue work units",
  references: "Text references",
  related: "Related issues",
  curated_related: "Curated related issues",
  blocks: "Blocking dependencies",
  implements: "Implementation links",
};

const LEGEND_DESCRIPTIONS: Record<string, string> = {
  issue: "Canonical ledger issue nodes. The Issues lens intentionally shows only this node family.",
  auth_request: "Protected-branch auth request nodes, shown in operational lenses.",
  work_unit: "Work-unit nodes linked to issues or sessions.",
  session: "Agent or terminal session nodes, shown in operational lenses.",
  parent_child: "Structural parent-to-child issue relationships, including umbrella and parent labels.",
  umbrella_child: "Structural parent-to-child issue relationships, including umbrella and parent labels.",
  parent: "Legacy parent issue relationships grouped with the parent/child hierarchy.",
  references: "Derived or explicit text references between issues; weak overlay, hidden by default in issue structure.",
  related: "Related issue links; weak overlay, hidden by default in issue structure.",
  curated_related: "Curated related issue links; weak overlay, hidden by default in issue structure.",
  blocks: "Planning or dependency edges where one issue blocks another.",
  implements: "Edges showing implementation or work satisfying an issue.",
  auth_issue: "Auth requests attached to issue evidence.",
  auth_request_references_issue: "Auth requests that reference an issue without necessarily resolving it.",
  session_issue: "Sessions linked to issue work or discussion.",
  session_parent: "Parent-child session lineage.",
  issue_has_work_unit: "Issue-to-work-unit operational links.",
};

function labelForLegendId(id: string): string {
  return LEGEND_LABELS[id] ?? id.replace(/_/g, " ");
}

function descriptionForLegendId(id: string, kind: "node" | "edge"): string {
  return LEGEND_DESCRIPTIONS[id] ?? `${labelForLegendId(id)} ${kind === "node" ? "nodes" : "edges"}`;
}

const NODE_COLORS: Record<string, string> = {
  issue: "#2f6fed",
  session: "#0f9f6e",
  auth_request: "#d97706",
  work_unit: "#7c3aed",
  branch: "#64748b",
  provider: "#0f766e",
  provider_spec: "#0891b2",
  provider_manifest: "#0284c7",
  artifact: "#b45309",
  report: "#9333ea",
  dataset: "#16a34a",
  model: "#dc2626",
  analysis: "#4f46e5",
  commit: "#475569",
};

const EDGE_VISUALS: Record<string, GraphLegendItem["visual"]> = {
  umbrella_child: { color: "#2563eb", stroke_width: 2, route: "orthogonal" },
  parent_child: { color: "#2563eb", stroke_width: 2, route: "orthogonal" },
  parent: { color: "#2563eb", stroke_width: 2, route: "orthogonal" },
  blocks: { color: "#dc2626", stroke_width: 2, route: "orthogonal" },
  implements: { color: "#7c3aed", stroke_width: 2, route: "orthogonal" },
  references: { color: "#94a3b8", stroke_width: 1, dash: "4 4", opacity: 0.65, route: "smooth" },
  related: { color: "#94a3b8", stroke_width: 1, dash: "4 4", opacity: 0.65, route: "smooth" },
  auth_issue: { color: "#d97706", stroke_width: 1.5, route: "smooth" },
  session_issue: { color: "#0f9f6e", stroke_width: 1.5, route: "smooth" },
  session_parent: { color: "#0f9f6e", stroke_width: 1.5, dash: "5 3", route: "smooth" },
  issue_has_work_unit: { color: "#7c3aed", stroke_width: 1.5, route: "smooth" },
  auth_request_references_issue: { color: "#d97706", stroke_width: 1.5, dash: "5 3", route: "smooth" },
};

function graphNodeLegend(candidateNodes: GraphNode[], spec: GraphSpec): GraphLegendItem[] {
  const counts = new Map<string, number>();
  for (const node of candidateNodes) {
    counts.set(node.type, (counts.get(node.type) ?? 0) + 1);
  }
  const ids = uniqueList([...spec.node_types, ...counts.keys()]);
  return ids.map((id) => {
    const count = counts.get(id) ?? 0;
    return {
      id,
      label: labelForLegendId(id),
      description: descriptionForLegendId(id, "node"),
      count,
      enabled: count > 0,
      visible: spec.node_types.includes(id),
      visual: { color: NODE_COLORS[id] ?? "#64748b" },
    };
  });
}

function graphEdgeLegend(endpointEligibleEdges: GraphEdge[], spec: GraphSpec): GraphLegendItem[] {
  const counts = new Map<string, number>();
  for (const edge of endpointEligibleEdges) {
    const primary = edge.type === "umbrella_child"
      && edge.metadata?.relationship_type === "parent_child"
      ? "parent_child"
      : edge.type;
    counts.set(primary, (counts.get(primary) ?? 0) + 1);
  }
  const ids = uniqueList([...spec.edge_types, ...counts.keys()]);
  return ids.map((id) => {
    const count = counts.get(id) ?? 0;
    return {
      id,
      label: labelForLegendId(id),
      description: descriptionForLegendId(id, "edge"),
      count,
      enabled: count > 0,
      visible: spec.edge_types.includes(id),
      visual: EDGE_VISUALS[id] ?? { color: "#64748b", stroke_width: 1.5, route: "smooth" },
    };
  });
}

function countIsolatedVisible(nodes: GraphNode[], edges: GraphEdge[]): number {
  const connected = new Set<string>();
  for (const edge of edges) {
    connected.add(edge.source);
    connected.add(edge.target);
  }
  return nodes.filter((node) => !connected.has(node.id)).length;
}

export function selectGraphForDisplay(
  candidateNodes: GraphNode[],
  candidateEdges: GraphEdge[],
  spec: GraphSpec,
): {
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
  counts: GraphDisplayCounts;
  nodeLegend: GraphLegendItem[];
  edgeLegend: GraphLegendItem[];
} {
  const filteredNodes = candidateNodes.filter((node) => nodeTypeAllowed(node, spec));
  const filteredNodeIds = new Set(filteredNodes.map((node) => node.id));
  const endpointEligibleEdges = candidateEdges.filter((edge) =>
    filteredNodeIds.has(edge.source) && filteredNodeIds.has(edge.target)
  );
  const eligibleEdges = endpointEligibleEdges.filter((edge) => edgeMatchesSpec(edge, spec));
  const nodesForCap = spec.include_isolates
    ? filteredNodes
    : filteredNodes.filter((node) => eligibleEdges.some((edge) =>
        edge.source === node.id || edge.target === node.id
      ));
  const { nodes: cappedNodes, truncated } = capGraphNodesForDisplay(
    nodesForCap,
    eligibleEdges,
    spec.limit,
  );
  const cappedNodeIds = new Set(cappedNodes.map((node) => node.id));
  const visibleEdges = eligibleEdges.filter(
    (edge) => cappedNodeIds.has(edge.source) && cappedNodeIds.has(edge.target),
  );
  const counts: GraphDisplayCounts = {
    total_nodes: candidateNodes.length,
    total_edges: candidateEdges.length,
    available_nodes: nodesForCap.length,
    available_edges: eligibleEdges.length,
    visible_nodes: cappedNodes.length,
    visible_edges: visibleEdges.length,
    hidden_edges: endpointEligibleEdges.length - eligibleEdges.length,
    dropped_by_filter: candidateNodes.length - filteredNodes.length,
    dropped_by_limit: Math.max(0, nodesForCap.length - cappedNodes.length),
    isolated_visible: countIsolatedVisible(cappedNodes, visibleEdges),
  };

  return {
    nodes: cappedNodes,
    edges: visibleEdges,
    truncated,
    counts,
    nodeLegend: graphNodeLegend(candidateNodes, spec),
    edgeLegend: graphEdgeLegend(endpointEligibleEdges, spec),
  };
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
): ReturnType<typeof selectGraphForDisplay> {
  const spec = params.spec ?? graphSpecForMode(params.mode ?? "issue");
  const sinceMs = params.since ? parseSince(params.since) : null;
  const sinceIso = sinceMs !== null ? msToIso(sinceMs) : null;
  const limit = spec.limit;
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
  const includeSessions = spec.node_types.includes("session");
  const includeAuthRequests = spec.node_types.includes("auth_request");
  const includeWorkUnits = spec.node_types.includes("work_unit");
  const sessionRows = includeSessions ? getSessionRows(params, sinceIso, limit) : [];
  const authRows = includeAuthRequests ? getAuthRows(params, sinceMs, limit) : [];
  const sessionNodeIds = addSessionNodesAndEdges(sessionRows, params, nodes, edges);
  addAuthNodesAndEdges(authRows, issueNodeIds, issueNodeIdByLedgerId, nodes, edges);
  if (!ledgerProjection) {
    addIssueEdges(issueScanner, nodes, edges);
  }
  addSessionIssueEdges(issueNodeIds, issueNodeIdByLedgerId, sessionNodeIds, edges);
  if (includeWorkUnits) {
    addWorkUnits(params, nodes, edges, issueNodeIdByLedgerId, limit);
  }

  return selectGraphForDisplay(Array.from(nodes.values()), Array.from(edges.values()), spec);
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

const COUNT_TABLE_ALLOWLIST = new Set(["sessions", "auth_requests", "work_units"]);

function modeDescriptors(counts: Record<GraphMode, number>): GraphModeDescriptor[] {
  return GRAPH_PERSPECTIVES.map((mode) => ({
    ...mode,
    count: counts[mode.id],
    available: mode.id === "activity" || counts[mode.id] > 0,
  }));
}

function presetDescriptors(): GraphPresetDescriptor[] {
  return (Object.keys(PRESET_SPECS) as GraphPreset[]).map((id) => ({
    id,
    label: PRESET_LABELS[id].label,
    description: PRESET_LABELS[id].description,
    spec_patch: PRESET_SPECS[id],
  }));
}

function countTableRows(table: string): number {
  if (!COUNT_TABLE_ALLOWLIST.has(table)) return 0;
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
    const spec = params.spec ?? graphSpecForMode(params.mode ?? "issue");
    const mode = params.mode ?? modeFromPreset(spec.preset ?? "issues");
    const providerId = firstQueryValue(query, "provider");
    const root = firstQueryValue(query, "root");
    let selected: ReturnType<typeof selectGraphForDisplay>;

    if (mode === "provider-lineage" || mode === "artifact-lineage" || mode === "provenance") {
      const indexed = getIndexedGraph(getDb(), {
        mode,
        providerId,
        root,
        limit: spec.limit,
      });
      selected = selectGraphForDisplay(indexed.nodes, indexed.edges, spec);
    } else {
      selected = buildOperationalGraph(issueScanner, params);
    }

    const counts = graphModeCounts(issueScanner);
    const payload: GraphPayload = {
      version: 1,
      mode,
      spec,
      nodes: selected.nodes,
      edges: selected.edges,
      modes: modeDescriptors(counts),
      presets: presetDescriptors(),
      node_legend: selected.nodeLegend,
      edge_legend: selected.edgeLegend,
      counts: selected.counts,
      metadata: {
        endpoint_policy: spec.endpoint_policy,
        date_filter: spec.filters.since
          ? {
              since: spec.filters.since,
              issue_time_field: "graph_activity_at",
              issue_time_components: [
                "issue.updated_at",
                "issue.created_at",
                "comments.created_at/updated_at",
                "auth_links.created_at/auth.updated_at/resolved_at",
                "session_links.created_at/last_seen_at",
              ],
              relationship_time_semantics: "endpoint_eligibility",
            }
          : undefined,
      },
      layers: graphLayers(selected.nodes, mode),
      filters: graphFilterOptions(issueScanner),
      truncated: selected.truncated,
      limit: spec.limit,
      displayed_count: selected.counts.visible_nodes,
      available_count: selected.counts.available_nodes,
    };

    res.json(payload);
  }, { fileRpc: "deny" });
}
