import { describe, expect, it } from "vitest";
import { capGraphNodesForDisplay } from "../src/routes/graph.js";
import type { GraphEdge, GraphNode } from "../src/types.js";

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

  it("falls back to recency when there are no visible relationships", () => {
    const nodes = [
      node("older", "2026-05-15T12:01:00.000Z"),
      node("newer", "2026-05-15T12:02:00.000Z"),
    ];

    const capped = capGraphNodesForDisplay(nodes, [], 1);

    expect(capped.nodes.map((item) => item.id)).toEqual(["newer"]);
  });
});
