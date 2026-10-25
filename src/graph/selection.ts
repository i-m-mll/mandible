import type {
  GraphDisplayCounts,
  GraphEdge,
  GraphLayerDescriptor,
  GraphLegendItem,
  GraphMode,
  GraphNode,
  GraphSpec,
} from "../types.js";
import { graphSpecForMode, uniqueList } from "./spec.js";

// Bug: 7a141c3 — graph API implementation
// Bug: 50c4afb — typed graph modes for the React Flow graph workspace
// Bug: 22a54d4 — endpoint closure, capping, legends, and counts moved out of the HTTP route module

const MODE_LAYER_ORDER: Partial<Record<GraphMode, string[]>> = {
  activity: ["auth_request", "issue", "session"],
  issue: ["issue"],
  work: ["repo", "issue", "work_unit", "branch", "session", "auth_request"],
  "provider-lineage": ["provider", "issue", "provider_spec", "provider_manifest", "run", "analysis", "artifact"],
  "artifact-lineage": ["artifact", "dataset", "model", "report"],
  provenance: ["provider", "provider_manifest", "artifact", "analysis", "report"],
};

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
  const createdMs = new Map(nodes.map((node) => [node, nodeCreatedMs(node)]));
  const byRecency = (a: GraphNode, b: GraphNode) =>
    createdMs.get(b)! - createdMs.get(a)! || a.label.localeCompare(b.label);
  const sortedByRecency = [...nodes].sort(byRecency);
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
    return byRecency(a, b);
  });

  return { nodes: ranked.slice(0, limit), truncated: true };
}

function edgeFamilyIds(edge: GraphEdge): string[] {
  const ids = new Set<string>([edge.type]);
  const relationshipType = edge.metadata?.relationship_type;
  if (typeof relationshipType === "string") ids.add(relationshipType);
  if (edge.type === "umbrella_child") ids.add("parent_child");
  return Array.from(ids);
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
  const incidentNodeIds = new Set(eligibleEdges.flatMap((edge) => [edge.source, edge.target]));
  const nodesForCap = spec.include_isolates
    ? filteredNodes
    : filteredNodes.filter((node) => incidentNodeIds.has(node.id));
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

export function graphLayers(nodes: GraphNode[], mode: GraphMode): GraphLayerDescriptor[] {
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
