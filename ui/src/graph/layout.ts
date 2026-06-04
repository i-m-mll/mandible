import type { GraphEdge, GraphNode } from '../types/graph';
import {
  classifyGraphEdge,
  graphEdgeStyle,
  type GraphEdgeFamily,
  type GraphEdgeStyleDescriptor,
} from './edgeStyles';

export type GraphSide = 'left' | 'right' | 'top' | 'bottom';

export interface GraphPoint {
  x: number
  y: number
}

export interface GraphRect {
  x: number
  y: number
  width: number
  height: number
}

export interface GraphLayoutOptions {
  nodeWidth?: number
  nodeHeight?: number
  xStart?: number
  yStart?: number
  columnGap?: number
  rowGap?: number
  componentGapX?: number
  componentGapY?: number
  availableWidth?: number
  maxComponentColumns?: number
  singletonColumns?: number
}

export interface PositionedGraphNode {
  id: string
  type: string
  position: GraphPoint
  width: number
  height: number
  node: GraphNode
  data: { node: GraphNode }
  layout: {
    componentId: string
    rank: number
    row: number
    role?: string
    groupId?: string
  }
}

export interface GraphEdgeRouteDescriptor {
  kind: 'orthogonal' | 'elbow' | 'loose' | 'straight'
  sourceSide: GraphSide
  targetSide: GraphSide
  points: GraphPoint[]
  path: string
  avoidsNonEndpointNodeBoxes: boolean
}

export interface RoutedGraphEdge {
  id: string
  source: string
  target: string
  type: string
  edge: GraphEdge
  family: GraphEdgeFamily
  style: GraphEdgeStyleDescriptor
  route?: GraphEdgeRouteDescriptor
}

export interface GraphLayoutResult {
  nodes: PositionedGraphNode[]
  edges: RoutedGraphEdge[]
}

type ResolvedLayoutOptions = Required<GraphLayoutOptions>;

type ComponentDraft = {
  id: string
  nodeIds: string[]
  positioned: PositionedGraphNode[]
  width: number
  height: number
  sortKey: string
}

const DEFAULT_LAYOUT_OPTIONS: ResolvedLayoutOptions = {
  nodeWidth: 190,
  nodeHeight: 118,
  xStart: 24,
  yStart: 32,
  columnGap: 280,
  rowGap: 148,
  componentGapX: 128,
  componentGapY: 112,
  availableWidth: 1280,
  maxComponentColumns: 6,
  singletonColumns: 4,
};

function resolveOptions(options: GraphLayoutOptions = {}): ResolvedLayoutOptions {
  return {
    ...DEFAULT_LAYOUT_OPTIONS,
    ...Object.fromEntries(
      Object.entries(options).filter(([, value]) => typeof value === 'number' && Number.isFinite(value)),
    ),
  };
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function layoutHint(node: GraphNode): Record<string, unknown> {
  return recordValue(node.detail?.layout) ?? {};
}

function layoutNumber(node: GraphNode, key: string): number | undefined {
  const value = layoutHint(node)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function layoutString(node: GraphNode, key: string): string | undefined {
  const value = layoutHint(node)[key];
  return typeof value === 'string' ? value : undefined;
}

function nodeTime(node: GraphNode): number {
  const value = node.updated_at ?? node.created_at;
  return value ? new Date(value).getTime() || 0 : 0;
}

function sortGraphNodes(a: GraphNode, b: GraphNode): number {
  const rankDelta = (layoutNumber(a, 'rank') ?? 0) - (layoutNumber(b, 'rank') ?? 0);
  if (rankDelta !== 0) return rankDelta;
  const orderDelta = (layoutNumber(a, 'order') ?? 0) - (layoutNumber(b, 'order') ?? 0);
  if (orderDelta !== 0) return orderDelta;
  return a.label.localeCompare(b.label) || a.id.localeCompare(b.id);
}

function componentSortKey(nodes: GraphNode[]): string {
  const rootLike = [...nodes].sort(sortGraphNodes)[0];
  const newest = Math.max(...nodes.map(nodeTime));
  return `${String(9999999999999 - newest).padStart(13, '0')}:${rootLike?.label ?? ''}:${rootLike?.id ?? ''}`;
}

function structuralHierarchyEdges(edges: GraphEdge[], nodeIds: Set<string>): GraphEdge[] {
  return edges.filter((edge) => {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) return false;
    return classifyGraphEdge(edge).family === 'hierarchy';
  });
}

function hierarchyComponents(nodes: GraphNode[], hierarchyEdges: GraphEdge[]): string[][] {
  const adjacency = new Map<string, Set<string>>();
  for (const node of nodes) adjacency.set(node.id, new Set());
  for (const edge of hierarchyEdges) {
    adjacency.get(edge.source)?.add(edge.target);
    adjacency.get(edge.target)?.add(edge.source);
  }

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const visited = new Set<string>();
  const components: string[][] = [];
  for (const node of [...nodes].sort(sortGraphNodes)) {
    if (visited.has(node.id)) continue;
    const stack = [node.id];
    const component: string[] = [];
    visited.add(node.id);
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) continue;
      component.push(current);
      for (const next of adjacency.get(current) ?? []) {
        if (visited.has(next)) continue;
        visited.add(next);
        stack.push(next);
      }
    }
    component.sort((a, b) => sortGraphNodes(nodeById.get(a)!, nodeById.get(b)!));
    components.push(component);
  }
  return components;
}

function rankComponent(
  componentIds: string[],
  componentEdges: GraphEdge[],
  nodeById: Map<string, GraphNode>,
): Map<string, number> {
  const ranks = new Map<string, number>();
  for (const id of componentIds) {
    ranks.set(id, Math.max(0, layoutNumber(nodeById.get(id)!, 'rank') ?? 0));
  }

  for (let pass = 0; pass < componentIds.length; pass += 1) {
    let changed = false;
    for (const edge of componentEdges) {
      const sourceRank = ranks.get(edge.source) ?? 0;
      const targetRank = ranks.get(edge.target) ?? 0;
      const nextRank = Math.max(targetRank, sourceRank + 1);
      if (nextRank !== targetRank) {
        ranks.set(edge.target, nextRank);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const minRank = Math.min(...ranks.values());
  for (const [id, rank] of ranks.entries()) ranks.set(id, rank - minRank);
  return ranks;
}

function childOrderKey(node: GraphNode, parentOrder: number): string {
  const order = layoutNumber(node, 'order') ?? parentOrder;
  return `${String(order).padStart(8, '0')}:${node.label}:${node.id}`;
}

function assignRows(
  componentIds: string[],
  componentEdges: GraphEdge[],
  ranks: Map<string, number>,
  nodeById: Map<string, GraphNode>,
): Map<string, number> {
  const incoming = new Map<string, number>();
  const childrenByParent = new Map<string, string[]>();
  for (const id of componentIds) {
    incoming.set(id, 0);
    childrenByParent.set(id, []);
  }
  for (const edge of componentEdges) {
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
    childrenByParent.get(edge.source)?.push(edge.target);
  }

  for (const [parent, children] of childrenByParent.entries()) {
    const parentNode = nodeById.get(parent);
    const parentOrder = parentNode ? layoutNumber(parentNode, 'order') ?? 0 : 0;
    children.sort((a, b) => childOrderKey(nodeById.get(a)!, parentOrder).localeCompare(
      childOrderKey(nodeById.get(b)!, parentOrder),
    ));
  }

  const roots = componentIds
    .filter((id) => (incoming.get(id) ?? 0) === 0)
    .sort((a, b) => sortGraphNodes(nodeById.get(a)!, nodeById.get(b)!));
  const traversalRoots = roots.length > 0
    ? roots
    : [...componentIds].sort((a, b) => sortGraphNodes(nodeById.get(a)!, nodeById.get(b)!));
  const rows = new Map<string, number>();
  const nextRowByRank = new Map<number, number>();

  const place = (id: string) => {
    if (rows.has(id)) return;
    const rank = ranks.get(id) ?? 0;
    const row = nextRowByRank.get(rank) ?? 0;
    rows.set(id, row);
    nextRowByRank.set(rank, row + 1);
    for (const child of childrenByParent.get(id) ?? []) place(child);
  };

  for (const root of traversalRoots) place(root);
  for (const id of componentIds) place(id);
  return rows;
}

function layoutComponent(
  componentIds: string[],
  hierarchyEdges: GraphEdge[],
  nodeById: Map<string, GraphNode>,
  options: ResolvedLayoutOptions,
): ComponentDraft {
  const componentSet = new Set(componentIds);
  const componentEdges = hierarchyEdges.filter((edge) => (
    componentSet.has(edge.source) && componentSet.has(edge.target)
  ));
  const ranks = rankComponent(componentIds, componentEdges, nodeById);
  const rows = assignRows(componentIds, componentEdges, ranks, nodeById);
  const componentNodes = componentIds.map((id) => nodeById.get(id)!).sort((a, b) => {
    const rankDelta = (ranks.get(a.id) ?? 0) - (ranks.get(b.id) ?? 0);
    if (rankDelta !== 0) return rankDelta;
    const rowDelta = (rows.get(a.id) ?? 0) - (rows.get(b.id) ?? 0);
    if (rowDelta !== 0) return rowDelta;
    return sortGraphNodes(a, b);
  });
  const rankGroups = new Map<number, GraphNode[]>();
  for (const node of componentNodes) {
    const rank = ranks.get(node.id) ?? 0;
    const group = rankGroups.get(rank) ?? [];
    group.push(node);
    rankGroups.set(rank, group);
  }
  const rankMetrics = new Map<number, { baseX: number; width: number; maxRows: number }>();
  const laneGap = Math.max(64, options.columnGap - options.nodeWidth);
  let nextRankX = 0;
  for (const rank of [...rankGroups.keys()].sort((a, b) => a - b)) {
    const group = rankGroups.get(rank) ?? [];
    const count = Math.max(1, group.length);
    const maxRows = count <= 4 ? count : Math.ceil(Math.sqrt(count * 1.45));
    const laneCount = Math.ceil(count / maxRows);
    const width = options.nodeWidth + Math.max(0, laneCount - 1) * (options.nodeWidth + laneGap);
    rankMetrics.set(rank, { baseX: nextRankX, width, maxRows });
    nextRankX += width + options.columnGap;
  }

  const positioned = componentNodes.map((node) => {
    const rank = ranks.get(node.id) ?? 0;
    const rankGroup = rankGroups.get(rank) ?? [node];
    const orderInRank = rankGroup.findIndex((item) => item.id === node.id);
    const metrics = rankMetrics.get(rank) ?? { baseX: rank * options.columnGap, width: options.nodeWidth, maxRows: 1 };
    const lane = Math.floor(Math.max(0, orderInRank) / metrics.maxRows);
    const row = Math.max(0, orderInRank) % metrics.maxRows;
    return {
      id: node.id,
      type: 'default',
      position: {
        x: metrics.baseX + lane * (options.nodeWidth + laneGap),
        y: row * options.rowGap,
      },
      width: options.nodeWidth,
      height: options.nodeHeight,
      node,
      data: { node },
      layout: {
        componentId: componentIds[0],
        rank,
        row,
        role: layoutString(node, 'role'),
        groupId: layoutString(node, 'group_id'),
      },
    };
  });

  const maxRight = Math.max(...positioned.map((node) => node.position.x + node.width), options.nodeWidth);
  const maxBottom = Math.max(...positioned.map((node) => node.position.y + node.height), options.nodeHeight);
  return {
    id: componentIds[0],
    nodeIds: componentIds,
    positioned,
    width: maxRight,
    height: maxBottom,
    sortKey: componentSortKey(componentNodes),
  };
}

function packComponents(components: ComponentDraft[], options: ResolvedLayoutOptions): PositionedGraphNode[] {
  const sorted = [...components].sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  const output: PositionedGraphNode[] = [];
  const maxRowWidth = Math.max(options.nodeWidth, options.availableWidth);
  let cursorX = options.xStart;
  let cursorY = options.yStart;
  let rowHeight = 0;

  for (const component of sorted) {
    const componentWidth = Math.min(component.width, maxRowWidth);
    if (cursorX > options.xStart && cursorX + componentWidth > options.xStart + maxRowWidth) {
      cursorX = options.xStart;
      cursorY += rowHeight + options.componentGapY;
      rowHeight = 0;
    }

    const xOffset = cursorX;
    const yOffset = cursorY;
    for (const node of component.positioned) {
      output.push({
        ...node,
        position: {
          x: node.position.x + xOffset,
          y: node.position.y + yOffset,
        },
      });
    }
    cursorX += componentWidth + options.componentGapX;
    rowHeight = Math.max(rowHeight, component.height);
  }

  return output;
}

function endpoint(rect: GraphRect, side: GraphSide): GraphPoint {
  if (side === 'left') return { x: rect.x, y: rect.y + rect.height / 2 };
  if (side === 'right') return { x: rect.x + rect.width, y: rect.y + rect.height / 2 };
  if (side === 'top') return { x: rect.x + rect.width / 2, y: rect.y };
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height };
}

function nodeRect(node: PositionedGraphNode): GraphRect {
  return {
    x: node.position.x,
    y: node.position.y,
    width: node.width,
    height: node.height,
  };
}

function pathFromPoints(points: GraphPoint[]): string {
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');
}

function routeHierarchyEdge(
  edge: GraphEdge,
  source: PositionedGraphNode,
  target: PositionedGraphNode,
  positionedNodes: PositionedGraphNode[],
): GraphEdgeRouteDescriptor {
  const sourceRect = nodeRect(source);
  const targetRect = nodeRect(target);
  const targetIsRight = targetRect.x >= sourceRect.x;
  const sourceSide: GraphSide = targetIsRight ? 'right' : 'left';
  const targetSide: GraphSide = targetIsRight ? 'left' : 'right';
  const start = endpoint(sourceRect, sourceSide);
  const end = endpoint(targetRect, targetSide);
  const trunkX = targetIsRight
    ? Math.min(end.x - 36, Math.max(start.x + 36, start.x + (end.x - start.x) / 2))
    : Math.max(end.x + 36, Math.min(start.x - 36, start.x + (end.x - start.x) / 2));
  const points = [
    start,
    { x: trunkX, y: start.y },
    { x: trunkX, y: end.y },
    end,
  ];
  return {
    kind: 'orthogonal',
    sourceSide,
    targetSide,
    points,
    path: pathFromPoints(points),
    avoidsNonEndpointNodeBoxes: !routeCrossesNonEndpointNodeBoxes(points, positionedNodes, edge),
  };
}

function routeLooseEdge(
  edge: GraphEdge,
  source: PositionedGraphNode,
  target: PositionedGraphNode,
  positionedNodes: PositionedGraphNode[],
): GraphEdgeRouteDescriptor {
  const sourceRect = nodeRect(source);
  const targetRect = nodeRect(target);
  const sourceSide: GraphSide = sourceRect.x <= targetRect.x ? 'right' : 'left';
  const targetSide: GraphSide = sourceSide === 'right' ? 'left' : 'right';
  const points = [endpoint(sourceRect, sourceSide), endpoint(targetRect, targetSide)];
  return {
    kind: classifyGraphEdge(edge).route,
    sourceSide,
    targetSide,
    points,
    path: pathFromPoints(points),
    avoidsNonEndpointNodeBoxes: !routeCrossesNonEndpointNodeBoxes(points, positionedNodes, edge),
  };
}

export function routeCrossesNonEndpointNodeBoxes(
  points: GraphPoint[],
  nodes: PositionedGraphNode[],
  edge: Pick<GraphEdge, 'source' | 'target'>,
): boolean {
  for (let index = 0; index < points.length - 1; index += 1) {
    const a = points[index];
    const b = points[index + 1];
    for (const node of nodes) {
      if (node.id === edge.source || node.id === edge.target) continue;
      if (segmentIntersectsRectInterior(a, b, nodeRect(node))) return true;
    }
  }
  return false;
}

export function segmentIntersectsRectInterior(a: GraphPoint, b: GraphPoint, rect: GraphRect): boolean {
  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxY = Math.max(a.y, b.y);
  const rectMinX = rect.x;
  const rectMaxX = rect.x + rect.width;
  const rectMinY = rect.y;
  const rectMaxY = rect.y + rect.height;

  if (a.x === b.x) {
    return a.x > rectMinX && a.x < rectMaxX && maxY > rectMinY && minY < rectMaxY;
  }
  if (a.y === b.y) {
    return a.y > rectMinY && a.y < rectMaxY && maxX > rectMinX && minX < rectMaxX;
  }

  // Non-orthogonal overlays are conservative: bounding-box overlap means the
  // caller should not claim box avoidance.
  return maxX > rectMinX && minX < rectMaxX && maxY > rectMinY && minY < rectMaxY;
}

export function layoutGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  options: GraphLayoutOptions = {},
): GraphLayoutResult {
  const resolved = resolveOptions(options);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const nodeIds = new Set(nodeById.keys());
  const hierarchyEdges = structuralHierarchyEdges(edges, nodeIds);
  const components = hierarchyComponents(nodes, hierarchyEdges).map((component) => (
    layoutComponent(component, hierarchyEdges, nodeById, resolved)
  ));
  const positionedNodes = packComponents(components, resolved);
  const positionedById = new Map(positionedNodes.map((node) => [node.id, node]));
  const routedEdges = edges
    .filter((edge) => positionedById.has(edge.source) && positionedById.has(edge.target))
    .map((edge): RoutedGraphEdge => {
      const classification = classifyGraphEdge(edge);
      const source = positionedById.get(edge.source)!;
      const target = positionedById.get(edge.target)!;
      const route = classification.family === 'hierarchy'
        ? routeHierarchyEdge(edge, source, target, positionedNodes)
        : routeLooseEdge(edge, source, target, positionedNodes);
      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: edge.type,
        edge,
        family: classification.family,
        style: graphEdgeStyle(edge),
        route,
      };
    });

  return {
    nodes: positionedNodes,
    edges: routedEdges,
  };
}
