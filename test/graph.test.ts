import { describe, expect, it } from "vitest";
import {
  capGraphNodesForDisplay,
  parseQueryParams,
  repoCandidatesFromCwd,
  sessionIdsFromGraphNodeIds,
} from "../src/routes/graph.js";
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

describe("graph filters", () => {
  it("parses comma-separated and repeated multi-select filters", () => {
    const params = parseQueryParams({
      repo: ["HumbleB,mandible", "feedbax"],
      branch: "main,develop",
    });

    expect(params.repos).toEqual(["HumbleB", "mandible", "feedbax"]);
    expect(params.repo).toBe("HumbleB");
    expect(params.branches).toEqual(["main", "develop"]);
    expect(params.branch).toBe("main");
  });

  it("recovers the root repo from worktree session cwd values", () => {
    const candidates = repoCandidatesFromCwd("/tmp/HumbleB/worktrees/feature__graph");

    expect(candidates).toContain("HumbleB");
    expect(candidates).toContain("feature__graph");
  });

  it("extracts fetched session ids for scoped session issue link queries", () => {
    const ids = sessionIdsFromGraphNodeIds(new Set([
      "session:sess-1",
      "issue:mandible:abc123",
      "session:sess-2",
      "session:sess-1",
    ]));

    expect(ids).toEqual(["sess-1", "sess-2"]);
  });
});
