import { describe, expect, it } from "vitest";
import { classifyGraphEdge, graphEdgeStyle } from "../ui/src/graph/edgeStyles";
import { layoutGraph, routeCrossesNonEndpointNodeBoxes } from "../ui/src/graph/layout";
import type { GraphEdge, GraphNode } from "../ui/src/types/graph";

function issue(id: string, label = id, layout: Record<string, unknown> = {}): GraphNode {
  return {
    id,
    type: "issue",
    label,
    updated_at: "2026-06-01T12:00:00.000Z",
    detail: { layout },
  };
}

function edge(
  id: string,
  source: string,
  target: string,
  type: string,
  metadata: Record<string, unknown> = {},
): GraphEdge {
  return {
    id,
    source,
    target,
    type,
    edge_class: "semantic",
    metadata,
  };
}

function positionById(result: ReturnType<typeof layoutGraph>): Map<string, { x: number; y: number }> {
  return new Map(result.nodes.map((node) => [node.id, node.position]));
}

describe("graph edge classification", () => {
  it("classifies graph edge families for layout and styling", () => {
    expect(classifyGraphEdge(edge("h", "p", "c", "umbrella_child")).family).toBe("hierarchy");
    expect(classifyGraphEdge(edge("b", "a", "b", "blocks")).family).toBe("blocking_dependency");
    expect(classifyGraphEdge(edge("o", "a", "b", "auth_issue")).family).toBe("operational");
    expect(classifyGraphEdge(edge("p", "a", "b", "produced", { layout: "semantic" })).family).toBe(
      "provider_provenance_artifact",
    );
    expect(classifyGraphEdge(edge("w", "a", "b", "references")).family).toBe("weak_cross_reference");
  });

  it("keeps weak cross-reference styling low emphasis", () => {
    const style = graphEdgeStyle(edge("w", "a", "b", "related"));

    expect(style.family).toBe("weak_cross_reference");
    expect(style.route).toBe("loose");
    expect(style.opacity).toBeLessThan(0.6);
    expect(style.dasharray).toBeTruthy();
  });
});

describe("deterministic graph layout", () => {
  it("places issue hierarchy parents left/top and children in regular rows", () => {
    const nodes = [
      issue("parent", "Parent", { role: "umbrella_parent", rank: 0 }),
      issue("child-b", "Child B", { role: "umbrella_child", rank: 1, order: 2 }),
      issue("child-a", "Child A", { role: "umbrella_child", rank: 1, order: 1 }),
    ];
    const edges = [
      edge("parent:a", "parent", "child-a", "umbrella_child", { layout: "hierarchical" }),
      edge("parent:b", "parent", "child-b", "umbrella_child", { layout: "hierarchical" }),
    ];

    const result = layoutGraph(nodes, edges, { xStart: 0, yStart: 0 });
    const positions = positionById(result);

    expect(positions.get("parent")).toEqual({ x: 0, y: 0 });
    expect(positions.get("child-a")?.x).toBeGreaterThan(positions.get("parent")?.x ?? 0);
    expect(positions.get("child-a")?.y).toBeGreaterThan(positions.get("parent")?.y ?? 0);
    expect(positions.get("child-b")?.y).toBeGreaterThan(positions.get("child-a")?.y ?? 0);
  });

  it("does not let weak references affect hierarchy coordinates", () => {
    const nodes = [
      issue("parent", "Parent", { rank: 0 }),
      issue("child", "Child", { rank: 1 }),
      issue("weak-target", "Weak Target", { rank: 0 }),
    ];
    const hierarchyEdges = [
      edge("parent:child", "parent", "child", "umbrella_child", { layout: "hierarchical" }),
    ];
    const withWeak = [
      ...hierarchyEdges,
      edge("child:weak", "child", "weak-target", "references"),
    ];

    const basePositions = positionById(layoutGraph(nodes, hierarchyEdges, { xStart: 0, yStart: 0 }));
    const weakPositions = positionById(layoutGraph(nodes, withWeak, { xStart: 0, yStart: 0 }));

    expect(weakPositions.get("parent")).toEqual(basePositions.get("parent"));
    expect(weakPositions.get("child")).toEqual(basePositions.get("child"));
  });

  it("packs disconnected components across available width", () => {
    const nodes = [
      issue("p1", "Parent 1"),
      issue("c1", "Child 1"),
      issue("p2", "Parent 2"),
      issue("c2", "Child 2"),
      issue("p3", "Parent 3"),
      issue("c3", "Child 3"),
    ];
    const edges = [
      edge("p1:c1", "p1", "c1", "umbrella_child", { layout: "hierarchical" }),
      edge("p2:c2", "p2", "c2", "umbrella_child", { layout: "hierarchical" }),
      edge("p3:c3", "p3", "c3", "umbrella_child", { layout: "hierarchical" }),
    ];

    const result = layoutGraph(nodes, edges, {
      xStart: 0,
      yStart: 0,
      availableWidth: 1600,
      maxComponentColumns: 3,
    });
    const parentXs = ["p1", "p2", "p3"].map((id) => positionById(result).get(id)?.x ?? 0);

    expect(new Set(parentXs).size).toBeGreaterThan(1);
  });

  it("wraps broad issue child sets into bounded hierarchy lanes", () => {
    const nodes = [
      issue("parent", "Parent", { role: "umbrella_parent", rank: 0 }),
      ...Array.from({ length: 18 }, (_, index) => (
        issue(`child-${index}`, `Child ${index}`, { role: "umbrella_child", rank: 1, order: index })
      )),
    ];
    const edges = nodes
      .filter((node) => node.id !== "parent")
      .map((node) => edge(`parent:${node.id}`, "parent", node.id, "parent_child", { layout: "hierarchical" }));

    const result = layoutGraph(nodes, edges, {
      xStart: 0,
      yStart: 0,
      nodeWidth: 190,
      nodeHeight: 118,
      columnGap: 280,
      rowGap: 148,
    });
    const positions = positionById(result);
    const childXs = new Set(nodes.slice(1).map((node) => positions.get(node.id)?.x));
    const childYs = nodes.slice(1).map((node) => positions.get(node.id)?.y ?? 0);
    const graphHeight = Math.max(...childYs) - Math.min(...childYs);

    expect(childXs.size).toBeGreaterThan(1);
    expect(graphHeight).toBeLessThan(18 * 148);
  });

  it("limits broad child ranks to two columns", () => {
    const children = Array.from({ length: 18 }, (_, index) => (
      issue(`child-${index}`, `Child ${index}`, { role: "umbrella_child", rank: 1, order: index })
    ));
    const nodes = [
      issue("parent", "Parent", { role: "umbrella_parent", rank: 0 }),
      ...children,
    ];
    const edges = children.map((node) => (
      edge(`parent:${node.id}`, "parent", node.id, "parent_child", { layout: "hierarchical" })
    ));

    const result = layoutGraph(nodes, edges, {
      xStart: 0,
      yStart: 0,
      nodeWidth: 190,
      nodeHeight: 118,
    });
    const positions = positionById(result);
    const childXs = new Set(children.map((node) => positions.get(node.id)?.x));

    expect(childXs.size).toBeLessThanOrEqual(2);
  });

  it("does not let one broad component collapse unrelated issues into a single column", () => {
    const broadChildren = Array.from({ length: 18 }, (_, index) => (
      issue(`child-${index}`, `Child ${index}`, { role: "umbrella_child", rank: 1, order: index })
    ));
    const singletons = Array.from({ length: 12 }, (_, index) => issue(`single-${index}`, `Single ${index}`));
    const nodes = [
      issue("parent", "Parent", { role: "umbrella_parent", rank: 0 }),
      ...broadChildren,
      ...singletons,
    ];
    const edges = broadChildren.map((node) => (
      edge(`parent:${node.id}`, "parent", node.id, "parent_child", { layout: "hierarchical" })
    ));

    const result = layoutGraph(nodes, edges, {
      xStart: 0,
      yStart: 0,
      availableWidth: 1500,
      nodeWidth: 190,
      nodeHeight: 118,
    });
    const positions = positionById(result);
    const singletonXs = new Set(singletons.map((node) => positions.get(node.id)?.x));

    expect(singletonXs.size).toBeGreaterThan(1);
  });

  it("routes hierarchy edges orthogonally without crossing non-endpoint node boxes", () => {
    const nodes = [
      issue("parent", "Parent", { rank: 0 }),
      issue("child-a", "Child A", { rank: 1, order: 1 }),
      issue("child-b", "Child B", { rank: 1, order: 2 }),
      issue("grandchild", "Grandchild", { rank: 2, order: 1 }),
    ];
    const edges = [
      edge("parent:a", "parent", "child-a", "umbrella_child", { layout: "hierarchical" }),
      edge("parent:b", "parent", "child-b", "umbrella_child", { layout: "hierarchical" }),
      edge("a:grandchild", "child-a", "grandchild", "umbrella_child", { layout: "hierarchical" }),
    ];

    const result = layoutGraph(nodes, edges, { xStart: 0, yStart: 0 });

    for (const routed of result.edges.filter((item) => !item.synthetic)) {
      expect(routed.route?.kind).toBe("orthogonal");
      expect(routed.route?.sourceSide).toBe("right");
      expect(routed.route?.targetSide).toBe("left");
      expect(routed.route?.markerEnd).toBe(true);
      expect(routed.route?.avoidsNonEndpointNodeBoxes).toBe(true);
      expect(routeCrossesNonEndpointNodeBoxes(routed.route?.points ?? [], result.nodes, routed.edge)).toBe(false);
    }
  });

  it("renders shared hierarchy trunks once and child branches separately", () => {
    const children = Array.from({ length: 6 }, (_, index) => (
      issue(`child-${index}`, `Child ${index}`, { rank: 1, order: index })
    ));
    const nodes = [
      issue("parent", "Parent", { rank: 0 }),
      ...children,
    ];
    const edges = children.map((node) => (
      edge(`parent:${node.id}`, "parent", node.id, "parent_child", { layout: "hierarchical" })
    ));

    const result = layoutGraph(nodes, edges, { xStart: 0, yStart: 0 });
    const buses = result.edges.filter((item) => item.synthetic);
    const branches = result.edges.filter((item) => !item.synthetic);

    expect(buses.length).toBeGreaterThan(0);
    expect(branches).toHaveLength(children.length);
    expect(buses.every((item) => item.route?.markerEnd === false)).toBe(true);
    expect(branches.every((item) => item.route?.points.length === 2)).toBe(true);
    expect(branches.every((item) => item.route?.markerEnd === true)).toBe(true);
  });
});
