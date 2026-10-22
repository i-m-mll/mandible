import { describe, expect, it } from "vitest";
import {
  repoCandidatesFromCwd,
} from "../src/graph/operational.js";
import {
  capGraphNodesForDisplay,
  graphEdgesForMode,
  selectGraphForDisplay,
} from "../src/graph/selection.js";
import {
  normalizeGraphSpec,
  parseQueryParams,
} from "../src/graph/spec.js";
import type { GraphEdge, GraphNode } from "../src/types.js";
import { layoutGraph, routeCrossesNonEndpointNodeBoxes } from "../ui/src/graph/layout";
import type { GraphEdge as UiGraphEdge, GraphNode as UiGraphNode } from "../ui/src/types/graph";

function node(id: string, createdAt: string): GraphNode {
  return {
    id,
    type: "issue",
    label: id,
    created_at: createdAt,
  };
}

function edge(source: string, target: string): GraphEdge {
  return {
    id: `${source}:${target}`,
    source,
    target,
    type: "session_issue",
    edge_class: "lifecycle",
  };
}

describe("graph node capping", () => {
  it("prefers connected nodes over newer isolated nodes", () => {
    const nodes = [
      node("isolated-1", "2026-05-15T12:05:00.000Z"),
      node("isolated-2", "2026-05-15T12:04:00.000Z"),
      node("connected-a", "2026-05-15T12:03:00.000Z"),
      node("connected-b", "2026-05-15T12:02:00.000Z"),
      node("connected-c", "2026-05-15T12:01:00.000Z"),
    ];
    const edges = [
      edge("connected-a", "connected-b"),
      edge("connected-a", "connected-c"),
    ];

    const capped = capGraphNodesForDisplay(nodes, edges, 3);

    expect(capped.truncated).toBe(true);
    expect(capped.nodes.map((item) => item.id)).toEqual([
      "connected-a",
      "connected-b",
      "connected-c",
    ]);
  });

});

describe("graph filters", () => {

  it("maps legacy modes and query filters into a normalized graph spec", () => {
    const params = parseQueryParams({
      mode: "work",
      repo: ["HumbleB,mandible", "feedbax"],
      branch: "main,develop",
      since: "7d",
      status: "all",
      limit: "250",
    });

    expect(params.mode).toBe("work");
    expect(params.status).toBe("all");
    expect(params.spec).toMatchObject({
      preset: "work",
      node_types: expect.arrayContaining(["issue", "work_unit", "session", "auth_request"]),
      filters: {
        repos: ["HumbleB", "mandible", "feedbax"],
        branches: ["main", "develop"],
        since: "7d",
        status: { issue: ["open", "closed"] },
      },
      limit: 250,
    });
  });

  it("recovers the root repo from worktree session cwd values", () => {
    const candidates = repoCandidatesFromCwd("/tmp/HumbleB/worktrees/feature__graph");

    expect(candidates).toContain("HumbleB");
    expect(candidates).toContain("feature__graph");
  });

});

describe("graph edge perspectives", () => {
  it("keeps weak issue relationships out of default operational perspectives", () => {
    const reference: GraphEdge = {
      id: "ref:a:b",
      source: "issue:a",
      target: "issue:b",
      type: "references",
      edge_class: "semantic",
    };
    const related: GraphEdge = {
      id: "related:a:b",
      source: "issue:a",
      target: "issue:b",
      type: "related",
      edge_class: "semantic",
    };
    const auth: GraphEdge = {
      id: "auth:a:b",
      source: "auth_request:a",
      target: "issue:b",
      type: "auth_issue",
      edge_class: "lifecycle",
    };

    for (const mode of ["activity", "work"] as const) {
      expect(graphEdgesForMode(mode, [reference, related, auth])).toEqual([auth]);
    }
    expect(graphEdgesForMode("issue", [reference, related, auth])).toEqual([]);
  });

});

describe("graph spec selection", () => {
  it("filters node types and edge families before capping display nodes", () => {
    const spec = normalizeGraphSpec({
      mode: "issue",
      edge_type: "parent_child",
      limit: "2",
    });
    const nodes = [
      node("recent-isolate", "2026-05-15T12:05:00.000Z"),
      node("parent", "2026-05-15T12:01:00.000Z"),
      node("child", "2026-05-15T12:00:00.000Z"),
    ];
    const edges: GraphEdge[] = [
      {
        id: "parent-child",
        source: "parent",
        target: "child",
        type: "umbrella_child",
        edge_class: "semantic",
        metadata: { relationship_type: "parent_child" },
      },
      {
        id: "hidden-reference",
        source: "recent-isolate",
        target: "parent",
        type: "references",
        edge_class: "semantic",
      },
    ];

    const selected = selectGraphForDisplay(nodes, edges, spec);

    expect(selected.nodes.map((item) => item.id)).toEqual(["parent", "child"]);
    expect(selected.edges.map((item) => item.id)).toEqual(["parent-child"]);
    expect(selected.counts).toMatchObject({
      total_nodes: 3,
      total_edges: 2,
      available_nodes: 3,
      available_edges: 1,
      visible_nodes: 2,
      visible_edges: 1,
      hidden_edges: 1,
      dropped_by_limit: 1,
      isolated_visible: 0,
    });
    expect(selected.nodeLegend.find((item) => item.id === "issue")).toMatchObject({
      label: "Issues",
      description: expect.stringContaining("Issues lens intentionally shows only this node family"),
    });
    expect(selected.edgeLegend.find((item) => item.id === "parent_child")).toMatchObject({
      label: "Parent/child hierarchy",
      description: expect.stringContaining("Structural parent-to-child issue relationships"),
    });
  });

  it("never returns edges whose endpoints are absent from returned nodes", () => {
    const spec = normalizeGraphSpec({ mode: "work", limit: "2" });
    const nodes = [
      node("issue-a", "2026-05-15T12:00:00.000Z"),
      node("issue-b", "2026-05-15T11:59:00.000Z"),
      node("issue-c", "2026-05-15T11:58:00.000Z"),
    ];
    const edges = [
      edge("issue-a", "issue-b"),
      edge("issue-a", "issue-c"),
      edge("issue-b", "issue-c"),
    ];

    const selected = selectGraphForDisplay(nodes, edges, spec);
    const visibleNodeIds = new Set(selected.nodes.map((item) => item.id));

    expect(selected.nodes).toHaveLength(2);
    for (const selectedEdge of selected.edges) {
      expect(visibleNodeIds.has(selectedEdge.source)).toBe(true);
      expect(visibleNodeIds.has(selectedEdge.target)).toBe(true);
    }
  });
});

describe("graph layout", () => {
  function layoutIssue(id: string, layout: Record<string, unknown>): UiGraphNode {
    return { id, type: "issue", label: id, updated_at: "2026-06-01T12:00:00.000Z", detail: { layout } };
  }

  function hierarchyEdge(source: string, target: string): UiGraphEdge {
    return {
      id: `${source}:${target}`,
      source,
      target,
      type: "umbrella_child",
      edge_class: "semantic",
      metadata: { layout: "hierarchical" },
    };
  }

  it("routes hierarchy edges without crossing non-endpoint node boxes", () => {
    const nodes = [
      layoutIssue("parent", { rank: 0 }),
      layoutIssue("child-a", { rank: 1, order: 1 }),
      layoutIssue("child-b", { rank: 1, order: 2 }),
      layoutIssue("grandchild", { rank: 2, order: 1 }),
    ];
    const edges = [
      hierarchyEdge("parent", "child-a"),
      hierarchyEdge("parent", "child-b"),
      hierarchyEdge("child-a", "grandchild"),
    ];

    const result = layoutGraph(nodes, edges, { xStart: 0, yStart: 0 });

    const routed = result.edges.filter((item) => !item.synthetic);
    expect(routed).toHaveLength(3);
    for (const item of routed) {
      expect(routeCrossesNonEndpointNodeBoxes(item.route?.points ?? [], result.nodes, item.edge)).toBe(false);
    }
  });
});
