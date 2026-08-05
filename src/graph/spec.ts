import type {
  GraphMode,
  GraphModeDescriptor,
  GraphPreset,
  GraphPresetDescriptor,
  GraphQueryParams,
  GraphSpec,
} from "../types.js";

// Bug: 7a141c3 — graph API implementation
// Bug: 50c4afb — typed graph modes for the React Flow graph workspace
// Bug: 22a54d4 — graph spec/preset policy moved out of the HTTP route module

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

export function parseSince(since: string): number | null {
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

export function firstQueryValue(
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

export function modeFromPreset(preset: GraphPreset): GraphMode {
  return preset === "issues" ? "issue" : preset;
}

function parsePreset(value: string | undefined): GraphPreset | undefined {
  if (!value) return undefined;
  if (value === "issue") return "issues";
  return Object.prototype.hasOwnProperty.call(PRESET_SPECS, value) ? (value as GraphPreset) : undefined;
}

export function uniqueList(values: string[]): string[] {
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

export function graphSpecForMode(mode: GraphMode): GraphSpec {
  return PRESET_SPECS[presetFromMode(mode)];
}

export function modeDescriptors(counts: Record<GraphMode, number>): GraphModeDescriptor[] {
  return GRAPH_PERSPECTIVES.map((mode) => ({
    ...mode,
    count: counts[mode.id],
    available: mode.id === "activity" || counts[mode.id] > 0,
  }));
}

export function presetDescriptors(): GraphPresetDescriptor[] {
  return (Object.keys(PRESET_SPECS) as GraphPreset[]).map((id) => ({
    id,
    label: PRESET_LABELS[id].label,
    description: PRESET_LABELS[id].description,
    spec_patch: PRESET_SPECS[id],
  }));
}
