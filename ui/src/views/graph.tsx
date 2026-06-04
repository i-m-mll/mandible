import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ViewportPortal,
} from '@xyflow/react';
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';
import '@xyflow/react/dist/style.css';
import type {
  GraphEdge,
  GraphMode,
  GraphModeDescriptor,
  GraphNode,
  GraphNodeType,
  GraphPayload,
} from '../types/graph';
import {
  addLedgerIssueComment,
  getLedgerIssueDetail,
  resolveLedgerConflict,
  type LedgerIssueDetailProjection,
} from '../api';
import { LedgerIssueDetail } from '../components/ledger/IssueDetail';

type GraphFetchParams = {
  mode: GraphMode
  repos?: string[]
  branches?: string[]
  since?: string
  status?: string
  limit?: number
}

type ReactFlowNode = {
  id: string
  type: string
  position: { x: number; y: number }
  initialWidth?: number
  initialHeight?: number
  data: { node: GraphNode; label: JSX.Element }
}

type ReactFlowEdge = {
  id: string
  source: string
  target: string
  label?: string
  animated?: boolean
  style?: Record<string, string | number>
  labelStyle?: Record<string, string | number>
  labelBgStyle?: Record<string, string | number>
}

type ForceLayoutNode = SimulationNodeDatum & {
  id: string
  node: GraphNode
  rank: number
  anchorX: number
  anchorY: number
}

type ForceLayoutLink = SimulationLinkDatum<ForceLayoutNode> & {
  edge: GraphEdge
}

type ComponentLayout = {
  nodes: ReactFlowNode[]
  width: number
  height: number
}

type LayoutPolicy = {
  kind: 'hierarchy' | 'layered-dag' | 'bounded-force'
  directedRanks: boolean
  force: boolean
  xStrength: number
  yStrength: number
  charge: number
}

type DirectedLayoutEdge = {
  source: string
  target: string
  edge: GraphEdge
}

type GraphSide = 'left' | 'right' | 'top' | 'bottom'

type EdgeEndpoint = {
  x: number
  y: number
  side: GraphSide
}

type GraphAnnotation = {
  id: string
  type: string
  label: string
  status?: string
  target?: string
  link_type?: string
}

type GraphSpecState = {
  preset: GraphMode
  since: '1d' | '3d' | '7d' | 'all'
  status: 'open' | 'all'
  limit: number
  repos: string[]
  branches: string[]
}

type GraphLegendKind = 'node' | 'edge'

type GraphLegendItem = {
  id: string
  kind: GraphLegendKind
  label: string
  description: string
  count: number
  enabled: boolean
  visible: boolean
  color: string
  dash?: string
  width?: number
}

async function getGraph(params: GraphFetchParams): Promise<GraphPayload> {
  const q = new URLSearchParams();
  q.set('mode', params.mode);
  if (params.since) q.set('since', params.since);
  if (params.repos && params.repos.length > 0) q.set('repo', params.repos.join(','));
  if (params.branches && params.branches.length > 0) q.set('branch', params.branches.join(','));
  if (params.status) q.set('status', params.status);
  if (params.limit) q.set('limit', String(params.limit));
  const r = await fetch(`/api/graph?${q.toString()}`);
  if (!r.ok) throw new Error(`graph fetch failed: ${r.status}`);
  return r.json() as Promise<GraphPayload>;
}

export type { GraphNodeType };

interface GraphViewProps {
  onNavigate: (type: GraphNodeType, id: string, repoId?: string) => void
  refreshToken?: number
  initialMode?: string
  initialFocus?: string
}

const NODE_COLUMNS: Record<string, number> = {
  repo: 0,
  provider: 0,
  issue: 1,
  provider_manifest: 1,
  provider_spec: 1,
  work_unit: 2,
  run: 2,
  session: 3,
  analysis: 3,
  model: 3,
  dataset: 3,
  auth_request: 4,
  artifact: 4,
  report: 5,
  commit: 5,
};

const FLOW_NODE_WIDTH = 190;
const FLOW_NODE_HEIGHT = 118;
const FLOW_X_START = 24;
const FLOW_Y_START = 32;
const FLOW_COLUMN_GAP = 258;
const FLOW_ROW_GAP = 142;
const FLOW_SINGLETON_GRID_COLUMNS = 4;
const FLOW_PACK_COLUMN_GAP = 136;
const FLOW_PACK_ROW_GAP = 112;
const FLOW_MAX_RANK = 7;
const FLOW_FORCE_TICKS = 180;
const GRAPH_SIZE_OPTIONS = [120, 250, 500, 1000] as const;
const DEFAULT_GRAPH_PRESET: GraphMode = 'issue';

const MODE_LABELS: Record<GraphMode, string> = {
  activity: 'Activity',
  issue: 'Issues',
  work: 'Work',
  provenance: 'Provenance',
  'provider-lineage': 'Provider Lineage',
  'artifact-lineage': 'Artifact Lineage',
};

const MODE_SUMMARIES: Record<GraphMode, string> = {
  issue: 'Open issues with structural relationships first.',
  work: 'Issues with work, auth, session, and branch context.',
  activity: 'Recent operational and ledger activity.',
  provenance: 'Evidence, commits, sessions, and provider context.',
  'provider-lineage': 'Provider, manifest, run, and artifact flow.',
  'artifact-lineage': 'Artifact origins, derivatives, and reports.',
};

const GRAPH_MODES = new Set<GraphMode>(Object.keys(MODE_LABELS) as GraphMode[]);

function coerceGraphMode(value: string | undefined): GraphMode {
  return value && GRAPH_MODES.has(value as GraphMode) ? value as GraphMode : DEFAULT_GRAPH_PRESET;
}

function typeLabel(type: string): string {
  return type.replace(/_/g, ' ').replace(/\b\w/g, (s) => s.toUpperCase());
}

function compactId(id: string): string {
  const parts = id.split(':');
  return parts[parts.length - 1]?.slice(0, 12) || id.slice(0, 12);
}

function reactFlowId(id: string): string {
  return `rf_${Array.from(id).map((char) => (
    /[A-Za-z0-9-]/.test(char) ? char : `_${char.charCodeAt(0).toString(16)}_`
  )).join('')}`;
}

function nodeColor(node: GraphNode): string {
  if (node.visual?.color) return node.visual.color;
  if (node.type === 'issue') {
    if (node.labels?.includes('error')) return 'var(--accent-red)';
    if (node.labels?.includes('feature')) return 'var(--accent-blue)';
    if (node.labels?.includes('umbrella')) return 'var(--accent-purple)';
    return 'rgba(230,237,243,0.86)';
  }
  if (node.type === 'session') {
    return node.active || node.status === 'active' ? 'var(--accent-green)' : 'rgba(154,164,178,0.64)';
  }
  if (node.type === 'auth_request') {
    if (node.status === 'pending' || node.status === 'executing') return 'var(--accent-yellow)';
    if (node.status === 'completed') return 'var(--accent-green)';
    if (node.status === 'failed' || node.status === 'rejected') return 'var(--accent-red)';
    return 'var(--accent-yellow)';
  }
  if (node.type === 'provider') return '#7dd3fc';
  if (node.type === 'provider_manifest') return '#c4b5fd';
  if (node.type === 'artifact') return '#f7c873';
  if (node.type === 'run' || node.type === 'analysis') return '#8be9b5';
  return 'rgba(230,237,243,0.76)';
}

function edgeColor(edge: GraphEdge): string {
  if (isHierarchyEdge(edge)) return 'rgba(125,211,252,0.74)';
  if (isDependencyEdge(edge)) return 'rgba(245,194,92,0.68)';
  if (isWeakReferenceEdge(edge)) return 'rgba(154,164,178,0.28)';
  if (edge.edge_class === 'semantic') return 'rgba(168,85,247,0.62)';
  if (edge.edge_class === 'provider') return 'rgba(125,211,252,0.62)';
  if (edge.edge_class === 'provenance') return 'rgba(50,210,150,0.54)';
  if (edge.type.includes('auth')) return 'rgba(245,194,92,0.58)';
  if (edge.type.includes('session')) return 'rgba(77,163,255,0.5)';
  return 'rgba(154,164,178,0.46)';
}

function firstEntries(value: Record<string, unknown> | undefined, limit = 4): Array<[string, unknown]> {
  if (!value) return [];
  return Object.entries(value)
    .filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object')
    .slice(0, limit);
}

function nodeTime(node: GraphNode): number {
  return node.created_at ? new Date(node.created_at).getTime() || 0 : 0;
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

function sortRankNodes(a: GraphNode, b: GraphNode): number {
  const aGroup = layoutString(a, 'group_id') ?? '';
  const bGroup = layoutString(b, 'group_id') ?? '';
  if (aGroup !== bGroup) return aGroup.localeCompare(bGroup);
  const aOrder = layoutNumber(a, 'order');
  const bOrder = layoutNumber(b, 'order');
  if (aOrder !== undefined || bOrder !== undefined) return (aOrder ?? 0) - (bOrder ?? 0);
  return sortGraphNodes(a, b);
}

function sortGraphNodes(a: GraphNode, b: GraphNode): number {
  return nodeTime(b) - nodeTime(a) || a.type.localeCompare(b.type) || a.label.localeCompare(b.label);
}

function baseRank(node: GraphNode, mode: GraphMode): number {
  const rank = layoutNumber(node, 'rank');
  if (rank !== undefined) return Math.max(0, Math.min(FLOW_MAX_RANK, rank));
  if (mode === 'issue' && node.type === 'issue') return 0;
  return Math.min(FLOW_MAX_RANK, NODE_COLUMNS[node.type] ?? (mode === 'issue' ? 0 : 2));
}

function isHierarchyEdge(edge: GraphEdge): boolean {
  return edge.type === 'umbrella_child'
    || edge.type === 'parent'
    || edge.type === 'parent_child'
    || edge.metadata?.layout === 'hierarchical';
}

function isProvenanceLikeEdge(edge: GraphEdge): boolean {
  return edge.edge_class === 'provenance'
    || edge.edge_class === 'lifecycle'
    || edge.type === 'produced'
    || edge.type === 'derived_from'
    || edge.type === 'validated_by'
    || edge.type.includes('lifecycle');
}

function isWeakReferenceEdge(edge: GraphEdge): boolean {
  if (isHierarchyEdge(edge) || isProvenanceLikeEdge(edge)) return false;
  return edge.type.includes('reference')
    || edge.type.includes('related')
    || edge.type === 'curated_related'
    || edge.type === 'references'
    || edge.confidence === 'weak';
}

function isDependencyEdge(edge: GraphEdge): boolean {
  return edge.type === 'blocks'
    || edge.type === 'blocked_by'
    || edge.type === 'implements'
    || edge.type === 'implemented_by'
    || edge.type.includes('block')
    || edge.type.includes('depend');
}

function isOperationalEdge(edge: GraphEdge): boolean {
  return edge.type.includes('auth')
    || edge.type.includes('session')
    || edge.type.includes('work_unit')
    || edge.type.includes('branch')
    || edge.type.includes('commit');
}

function edgeFamilyId(edge: GraphEdge): string {
  if (isHierarchyEdge(edge)) return 'hierarchy';
  if (isDependencyEdge(edge)) return 'dependency';
  if (isWeakReferenceEdge(edge)) return 'weak_refs';
  if (isOperationalEdge(edge)) return 'operational';
  if (
    edge.edge_class === 'provider'
    || edge.edge_class === 'provenance'
    || isProvenanceLikeEdge(edge)
    || edge.type.includes('artifact')
    || edge.type.includes('provider')
    || edge.type.includes('manifest')
    || edge.type === 'produced'
    || edge.type === 'derived_from'
  ) {
    return 'provenance';
  }
  if (edge.edge_class === 'semantic') return 'semantic';
  return 'other';
}

function edgeFamilyMeta(id: string): Omit<GraphLegendItem, 'count' | 'enabled' | 'visible'> {
  if (id === 'hierarchy') {
    return {
      id,
      kind: 'edge',
      label: 'Parent-child',
      description: 'Umbrella, parent, and child issue structure.',
      color: 'rgba(125,211,252,0.74)',
      width: 2,
    };
  }
  if (id === 'dependency') {
    return {
      id,
      kind: 'edge',
      label: 'Blockers',
      description: 'Blocking, dependency, and implementation relationships.',
      color: 'rgba(245,194,92,0.68)',
      width: 1.8,
    };
  }
  if (id === 'weak_refs') {
    return {
      id,
      kind: 'edge',
      label: 'Weak refs',
      description: 'Cross references and related links; optional overlay.',
      color: 'rgba(154,164,178,0.34)',
      dash: '4 7',
      width: 1.1,
    };
  }
  if (id === 'operational') {
    return {
      id,
      kind: 'edge',
      label: 'Work/auth/session',
      description: 'Operational links for auth requests, sessions, work, branches, and commits.',
      color: 'rgba(77,163,255,0.56)',
      width: 1.5,
    };
  }
  if (id === 'provenance') {
    return {
      id,
      kind: 'edge',
      label: 'Provider/provenance',
      description: 'Provider, artifact, lineage, commit, and evidence links.',
      color: 'rgba(50,210,150,0.56)',
      width: 1.5,
    };
  }
  if (id === 'semantic') {
    return {
      id,
      kind: 'edge',
      label: 'Semantic',
      description: 'Other typed ledger relationships.',
      color: 'rgba(168,85,247,0.56)',
      width: 1.4,
    };
  }
  return {
    id,
    kind: 'edge',
    label: typeLabel(id),
    description: 'Other graph relationships.',
    color: 'rgba(154,164,178,0.46)',
    width: 1.4,
  };
}

function defaultEdgeFamilyVisible(id: string, preset: GraphMode): boolean {
  if (preset === 'issue') return id === 'hierarchy' || id === 'dependency' || id === 'semantic';
  if (id === 'weak_refs') return false;
  return true;
}

function buildDefaultNodeFamilySet(payload: GraphPayload): Set<string> {
  const layerIds = (payload.layers ?? [])
    .filter((layer) => layer.enabled)
    .map((layer) => layer.id);
  if (layerIds.length > 0) return new Set(layerIds);
  return new Set(payload.nodes.map((node) => node.type));
}

function buildDefaultEdgeFamilySet(payload: GraphPayload, preset: GraphMode): Set<string> {
  return new Set(
    Array.from(new Set(payload.edges.map(edgeFamilyId)))
      .filter((id) => defaultEdgeFamilyVisible(id, preset)),
  );
}

function buildNodeLegend(payload: GraphPayload, visibleFamilies: Set<string> | null): GraphLegendItem[] {
  const layerById = new Map((payload.layers ?? []).map((layer) => [layer.id, layer]));
  const counts = new Map<string, { count: number; sample?: GraphNode }>();
  for (const node of payload.nodes) {
    const current = counts.get(node.type) ?? { count: 0, sample: node };
    current.count += 1;
    if (!current.sample) current.sample = node;
    counts.set(node.type, current);
  }

  return Array.from(counts.entries())
    .map(([id, entry]): GraphLegendItem => {
      const layer = layerById.get(id);
      const enabled = layer?.enabled ?? entry.count > 0;
      return {
        id,
        kind: 'node',
        label: layer?.label ?? typeLabel(id),
        description: `${typeLabel(id)} nodes in the current graph spec.`,
        count: layer?.count ?? entry.count,
        enabled,
        visible: enabled && (visibleFamilies?.has(id) ?? true),
        color: entry.sample ? nodeColor(entry.sample) : 'rgba(154,164,178,0.64)',
      };
    })
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function buildEdgeLegend(payload: GraphPayload, visibleFamilies: Set<string> | null, preset: GraphMode): GraphLegendItem[] {
  const counts = new Map<string, number>();
  for (const edge of payload.edges) {
    const familyId = edgeFamilyId(edge);
    counts.set(familyId, (counts.get(familyId) ?? 0) + 1);
  }
  const order = ['hierarchy', 'dependency', 'weak_refs', 'operational', 'provenance', 'semantic', 'other'];
  return Array.from(counts.entries())
    .map(([id, count]): GraphLegendItem => {
      const meta = edgeFamilyMeta(id);
      const enabled = count > 0;
      return {
        ...meta,
        count,
        enabled,
        visible: enabled && (visibleFamilies?.has(id) ?? defaultEdgeFamilyVisible(id, preset)),
      };
    })
    .sort((a, b) => {
      const aOrder = order.indexOf(a.id);
      const bOrder = order.indexOf(b.id);
      return (aOrder === -1 ? order.length : aOrder) - (bOrder === -1 ? order.length : bOrder)
        || a.label.localeCompare(b.label);
    });
}

function linkDistance(edge: GraphEdge): number {
  if (isHierarchyEdge(edge)) return FLOW_COLUMN_GAP * 0.62;
  if (isProvenanceLikeEdge(edge)) return FLOW_COLUMN_GAP * 0.72;
  if (isWeakReferenceEdge(edge)) return FLOW_COLUMN_GAP * 1.28;
  if (edge.edge_class === 'provider') return FLOW_COLUMN_GAP * 0.84;
  return FLOW_COLUMN_GAP * 0.98;
}

function linkStrength(edge: GraphEdge): number {
  if (isHierarchyEdge(edge)) return 0.82;
  if (isProvenanceLikeEdge(edge)) return 0.68;
  if (isWeakReferenceEdge(edge)) return 0.08;
  if (edge.edge_class === 'provider') return 0.46;
  return 0.28;
}

function edgeStrokeWidth(edge: GraphEdge): number {
  if (isWeakReferenceEdge(edge)) return 1.1;
  if (isHierarchyEdge(edge) || isProvenanceLikeEdge(edge)) return 1.8;
  return edge.edge_class === 'semantic' ? 1.4 : 1.6;
}

function layoutPolicy(mode: GraphMode, componentEdges: GraphEdge[]): LayoutPolicy {
  if (mode === 'issue' && componentEdges.some(isHierarchyEdge)) {
    return {
      kind: 'hierarchy',
      directedRanks: true,
      force: false,
      xStrength: 0.76,
      yStrength: 0.12,
      charge: -420,
    };
  }
  if (mode === 'work' || mode === 'provider-lineage' || mode === 'artifact-lineage' || mode === 'provenance') {
    return {
      kind: 'layered-dag',
      directedRanks: true,
      force: true,
      xStrength: 0.82,
      yStrength: 0.12,
      charge: -560,
    };
  }
  return {
    kind: 'bounded-force',
    directedRanks: mode !== 'activity',
    force: true,
    xStrength: 0.46,
    yStrength: 0.08,
    charge: -520,
  };
}

function edgeLayoutDirection(edge: GraphEdge, nodeById: Map<string, GraphNode>): DirectedLayoutEdge {
  const source = nodeById.get(edge.source);
  const target = nodeById.get(edge.target);
  if (!source || !target) return { source: edge.source, target: edge.target, edge };

  if (edge.type === 'auth_issue' || edge.type === 'auth_request_references_issue') {
    return { source: edge.target, target: edge.source, edge };
  }
  if (edge.type === 'session_parent') {
    return { source: edge.target, target: edge.source, edge };
  }
  if (edge.type === 'session_issue') {
    if (source.type === 'session' && (target.type === 'issue' || target.type === 'work_unit')) {
      return { source: edge.target, target: edge.source, edge };
    }
  }
  return { source: edge.source, target: edge.target, edge };
}

function graphComponents(nodes: GraphNode[], edges: GraphEdge[]): string[][] {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const adjacency = new Map<string, Set<string>>();
  for (const node of nodes) adjacency.set(node.id, new Set());
  for (const edge of edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue;
    adjacency.get(edge.source)?.add(edge.target);
    adjacency.get(edge.target)?.add(edge.source);
  }

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
    components.push(component);
  }
  return components;
}

function makeFlowNode(node: GraphNode, x: number, y: number): ReactFlowNode {
  return {
    id: reactFlowId(node.id),
    type: 'default',
    position: { x, y },
    initialWidth: FLOW_NODE_WIDTH,
    initialHeight: FLOW_NODE_HEIGHT,
    data: { node, label: <MandibleFlowNodeLabel node={node} /> },
  };
}

function layoutComponent(
  component: string[],
  edges: GraphEdge[],
  nodeById: Map<string, GraphNode>,
  ranks: Map<string, number>,
  directedEdges: DirectedLayoutEdge[],
  mode: GraphMode,
): ComponentLayout {
  const componentIds = new Set(component);
  const componentEdges = edges.filter((edge) => componentIds.has(edge.source) && componentIds.has(edge.target));
  const policy = layoutPolicy(mode, componentEdges);
  const byRank = new Map<number, GraphNode[]>();
  for (const id of component) {
    const node = nodeById.get(id);
    if (!node) continue;
    const rank = ranks.get(id) ?? baseRank(node, mode);
    const group = byRank.get(rank) ?? [];
    group.push(node);
    byRank.set(rank, group);
  }

  const minRank = Math.min(...byRank.keys());
  const forceNodes: ForceLayoutNode[] = [];
  for (const [rank, rankNodes] of byRank.entries()) {
    const sorted = [...rankNodes].sort(sortRankNodes);
    sorted.forEach((node, row) => {
      const anchorX = Math.max(0, rank - minRank) * FLOW_COLUMN_GAP;
      const anchorY = row * FLOW_ROW_GAP;
      forceNodes.push({
        id: node.id,
        node,
        rank,
        anchorX,
        anchorY,
        x: anchorX,
        y: anchorY,
      });
    });
  }

  const forceLinks: ForceLayoutLink[] = directedEdges
    .filter((edge) => componentIds.has(edge.source) && componentIds.has(edge.target))
    .map((edge) => ({ source: edge.source, target: edge.target, edge: edge.edge }));

  if (forceNodes.length > 1 && policy.force) {
    const simulation = forceSimulation<ForceLayoutNode>(forceNodes)
      .force('link', forceLink<ForceLayoutNode, ForceLayoutLink>(forceLinks)
        .id((node) => node.id)
        .distance((link) => linkDistance(link.edge))
        .strength((link) => linkStrength(link.edge)))
      .force('charge', forceManyBody<ForceLayoutNode>().strength(policy.charge))
      .force('collide', forceCollide<ForceLayoutNode>(FLOW_NODE_WIDTH * 0.68).strength(0.98))
      .force('x', forceX<ForceLayoutNode>((node) => node.anchorX).strength(policy.xStrength))
      .force('y', forceY<ForceLayoutNode>((node) => node.anchorY).strength(policy.yStrength))
      .stop();
    for (let tick = 0; tick < FLOW_FORCE_TICKS; tick += 1) simulation.tick();
  }

  const minX = Math.min(...forceNodes.map((node) => node.x ?? node.anchorX));
  const minY = Math.min(...forceNodes.map((node) => node.y ?? node.anchorY));
  const maxX = Math.max(...forceNodes.map((node) => node.x ?? node.anchorX));
  const maxY = Math.max(...forceNodes.map((node) => node.y ?? node.anchorY));

  return {
    nodes: forceNodes.map((item) => makeFlowNode(
      item.node,
      (item.x ?? item.anchorX) - minX,
      (item.y ?? item.anchorY) - minY,
    )),
    width: Math.max(FLOW_NODE_WIDTH, maxX - minX + FLOW_NODE_WIDTH),
    height: Math.max(FLOW_NODE_HEIGHT, maxY - minY + FLOW_NODE_HEIGHT),
  };
}

function componentColumnCount(componentCount: number, nodeCount: number, mode: GraphMode): number {
  if (componentCount <= 1) return 1;
  if (componentCount <= 3) return componentCount;
  const modeMultiplier = mode === 'activity' || mode === 'work' ? 1.35 : 1.12;
  const nodeMultiplier = nodeCount >= 240 ? 1.35 : nodeCount >= 120 ? 1.2 : 1;
  return Math.min(8, Math.max(2, Math.ceil(Math.sqrt(componentCount * modeMultiplier * nodeMultiplier))));
}

function packComponents(components: ComponentLayout[], mode: GraphMode, nodeCount: number): ReactFlowNode[] {
  if (components.length === 0) return [];
  const columns = componentColumnCount(components.length, nodeCount, mode);
  const laneWidth = Math.max(
    FLOW_COLUMN_GAP,
    Math.max(...components.map((component) => component.width)) + FLOW_PACK_COLUMN_GAP,
  );
  const laneHeights = Array.from({ length: columns }, () => FLOW_Y_START);
  const output: ReactFlowNode[] = [];

  for (const component of components) {
    const column = laneHeights.reduce(
      (best, height, index) => (height < laneHeights[best] ? index : best),
      0,
    );
    const xOffset = FLOW_X_START + column * laneWidth;
    const yOffset = laneHeights[column];
    for (const node of component.nodes) {
      output.push({
        ...node,
        position: {
          x: node.position.x + xOffset,
          y: node.position.y + yOffset,
        },
      });
    }
    laneHeights[column] += component.height + FLOW_PACK_ROW_GAP;
  }

  return output;
}

function layoutNodes(nodes: GraphNode[], edges: GraphEdge[], mode: GraphMode): ReactFlowNode[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const ranks = new Map(nodes.map((node) => [node.id, baseRank(node, mode)]));
  const rankPolicy = layoutPolicy(mode, edges);
  const directedEdges = edges
    .filter((edge) => nodeById.has(edge.source) && nodeById.has(edge.target))
    .map((edge) => edgeLayoutDirection(edge, nodeById));

  if (rankPolicy.directedRanks) {
    for (let pass = 0; pass < Math.min(nodes.length, FLOW_MAX_RANK * 3); pass += 1) {
      let changed = false;
      for (const edge of directedEdges) {
        const sourceRank = ranks.get(edge.source) ?? 0;
        const targetRank = ranks.get(edge.target) ?? 0;
        const nextRank = Math.min(FLOW_MAX_RANK, Math.max(targetRank, sourceRank + 1));
        if (nextRank > targetRank) {
          ranks.set(edge.target, nextRank);
          changed = true;
        }
      }
      if (!changed) break;
    }
  }

  const incidentCounts = new Map<string, number>();
  for (const edge of edges) {
    incidentCounts.set(edge.source, (incidentCounts.get(edge.source) ?? 0) + 1);
    incidentCounts.set(edge.target, (incidentCounts.get(edge.target) ?? 0) + 1);
  }

  const components = graphComponents(nodes, edges);
  const relationshipComponents = components
    .filter((component) => component.some((id) => (incidentCounts.get(id) ?? 0) > 0))
    .sort((a, b) => {
      const aMaxDegree = Math.max(...a.map((id) => incidentCounts.get(id) ?? 0));
      const bMaxDegree = Math.max(...b.map((id) => incidentCounts.get(id) ?? 0));
      const newestA = Math.max(...a.map((id) => nodeTime(nodeById.get(id)!)));
      const newestB = Math.max(...b.map((id) => nodeTime(nodeById.get(id)!)));
      return b.length - a.length || bMaxDegree - aMaxDegree || newestB - newestA;
    });
  const singletons = components
    .filter((component) => component.every((id) => (incidentCounts.get(id) ?? 0) === 0))
    .flat()
    .map((id) => nodeById.get(id)!)
    .sort(sortGraphNodes);

  const packedComponents = relationshipComponents.map((component) => (
    layoutComponent(component, edges, nodeById, ranks, directedEdges, mode)
  ));

  if (singletons.length > 0) {
    const singletonColumns = Math.min(
      FLOW_SINGLETON_GRID_COLUMNS,
      Math.max(1, Math.ceil(Math.sqrt(singletons.length))),
    );
    for (let index = 0; index < singletons.length; index += singletonColumns) {
      const rowNodes = singletons.slice(index, index + singletonColumns);
      packedComponents.push({
        nodes: rowNodes.map((node, column) => makeFlowNode(node, column * FLOW_COLUMN_GAP, 0)),
        width: FLOW_NODE_WIDTH + (rowNodes.length - 1) * FLOW_COLUMN_GAP,
        height: FLOW_NODE_HEIGHT,
      });
    }
  }

  return packComponents(packedComponents, mode, nodes.length);
}

function edgeLabel(edge: GraphEdge): string | undefined {
  if (edge.metadata?.label_default_visible !== true) return undefined;
  const label = edge.metadata.relationship_label;
  return typeof label === 'string' ? label : edge.type.replace(/_/g, ' ');
}

function flowEdges(edges: GraphEdge[]): ReactFlowEdge[] {
  return edges.map((edge) => ({
    id: reactFlowId(edge.id),
    source: reactFlowId(edge.source),
    target: reactFlowId(edge.target),
    label: edgeLabel(edge),
    style: { stroke: edgeColor(edge), strokeWidth: edgeStrokeWidth(edge), opacity: isWeakReferenceEdge(edge) ? 0.56 : 0.78 },
  }));
}

function ManualGraphEdges({ nodes, edges }: { nodes: ReactFlowNode[]; edges: GraphEdge[] }): JSX.Element | null {
  const nodeByOriginalId = new Map(nodes.map((node) => [node.data.node.id, node]));
  const incidentCounts = new Map<string, number>();
  for (const edge of edges) {
    incidentCounts.set(edge.source, (incidentCounts.get(edge.source) ?? 0) + 1);
    incidentCounts.set(edge.target, (incidentCounts.get(edge.target) ?? 0) + 1);
  }
  const edgeGroups = new Map<string, GraphEdge[]>();
  for (const edge of edges) {
    const groupKey = `${edge.source}->${edge.target}`;
    const group = edgeGroups.get(groupKey) ?? [];
    group.push(edge);
    edgeGroups.set(groupKey, group);
  }

  const visibleEdges = edges
    .map((edge) => {
      const source = nodeByOriginalId.get(edge.source);
      const target = nodeByOriginalId.get(edge.target);
      if (!source || !target) return null;
      const group = edgeGroups.get(`${edge.source}->${edge.target}`) ?? [edge];
      const repeatIndex = group.findIndex((item) => item.id === edge.id);
      const repeatOffset = (repeatIndex - (group.length - 1) / 2) * 18;
      const degreeOffset = Math.min(24, Math.max(0, ((incidentCounts.get(edge.source) ?? 1) - 2) * 3));
      return {
        edge,
        d: isHierarchyEdge(edge)
          ? orthogonalEdgePath(source, target, repeatOffset + degreeOffset)
          : curvedEdgePath(source, target, repeatOffset + degreeOffset, repeatOffset - degreeOffset),
      };
    })
    .filter((item): item is { edge: GraphEdge; d: string } => item !== null);

  if (visibleEdges.length === 0) return null;
  return (
    <svg className="graph-manual-edges" aria-hidden="true">
      <defs>
        <marker id="graph-manual-arrow" markerWidth="10" markerHeight="10" viewBox="-10 -10 20 20" orient="auto" refX="-2" refY="0">
          <path d="M -6 -4 L 0 0 L -6 4" />
        </marker>
      </defs>
      {visibleEdges.map(({ edge, d }) => (
        <path
          key={edge.id}
          className={[
            'graph-manual-edge',
            isWeakReferenceEdge(edge) ? 'graph-manual-edge--weak' : '',
            isHierarchyEdge(edge) ? 'graph-manual-edge--structural' : '',
            isProvenanceLikeEdge(edge) ? 'graph-manual-edge--provenance' : '',
          ].filter(Boolean).join(' ')}
          d={d}
          markerEnd="url(#graph-manual-arrow)"
          style={{ stroke: edgeColor(edge), strokeWidth: edgeStrokeWidth(edge) }}
        />
      ))}
    </svg>
  );
}

function curvedEdgePath(
  source: ReactFlowNode,
  target: ReactFlowNode,
  sourceOffset: number,
  targetOffset: number,
): string {
  const sourceEndpoint = edgeEndpoint(source, target, sourceOffset);
  const targetEndpoint = edgeEndpoint(target, source, targetOffset);
  const sourceNormal = sideNormal(sourceEndpoint.side);
  const targetNormal = sideNormal(targetEndpoint.side);
  const dx = targetEndpoint.x - sourceEndpoint.x;
  const dy = targetEndpoint.y - sourceEndpoint.y;
  const spread = Math.max(38, Math.min(180, Math.hypot(dx, dy) * 0.36));
  const sourceControlX = sourceEndpoint.x + sourceNormal.x * spread;
  const sourceControlY = sourceEndpoint.y + sourceNormal.y * spread;
  const targetControlX = targetEndpoint.x + targetNormal.x * spread;
  const targetControlY = targetEndpoint.y + targetNormal.y * spread;
  return `M ${sourceEndpoint.x} ${sourceEndpoint.y} C ${sourceControlX} ${sourceControlY}, ${targetControlX} ${targetControlY}, ${targetEndpoint.x} ${targetEndpoint.y}`;
}

function orthogonalEdgePath(source: ReactFlowNode, target: ReactFlowNode, offset: number): string {
  const sourceCenterX = source.position.x + FLOW_NODE_WIDTH / 2;
  const sourceCenterY = source.position.y + FLOW_NODE_HEIGHT / 2;
  const targetCenterX = target.position.x + FLOW_NODE_WIDTH / 2;
  const targetCenterY = target.position.y + FLOW_NODE_HEIGHT / 2;
  const horizontal = Math.abs(targetCenterX - sourceCenterX) >= Math.abs(targetCenterY - sourceCenterY);
  if (horizontal) {
    const sourceRight = targetCenterX >= sourceCenterX;
    const startX = source.position.x + (sourceRight ? FLOW_NODE_WIDTH : 0);
    const endX = target.position.x + (sourceRight ? 0 : FLOW_NODE_WIDTH);
    const startY = sourceCenterY + offset;
    const endY = targetCenterY - offset;
    const trunkX = startX + (endX - startX) / 2;
    return `M ${startX} ${startY} L ${trunkX} ${startY} L ${trunkX} ${endY} L ${endX} ${endY}`;
  }
  const sourceBelow = targetCenterY >= sourceCenterY;
  const startX = sourceCenterX + offset;
  const endX = targetCenterX - offset;
  const startY = source.position.y + (sourceBelow ? FLOW_NODE_HEIGHT : 0);
  const endY = target.position.y + (sourceBelow ? 0 : FLOW_NODE_HEIGHT);
  const trunkY = startY + (endY - startY) / 2;
  return `M ${startX} ${startY} L ${startX} ${trunkY} L ${endX} ${trunkY} L ${endX} ${endY}`;
}

function edgeEndpoint(source: ReactFlowNode, target: ReactFlowNode, offset: number): EdgeEndpoint {
  const sourceCenterX = source.position.x + FLOW_NODE_WIDTH / 2;
  const sourceCenterY = source.position.y + FLOW_NODE_HEIGHT / 2;
  const targetCenterX = target.position.x + FLOW_NODE_WIDTH / 2;
  const targetCenterY = target.position.y + FLOW_NODE_HEIGHT / 2;
  const dx = targetCenterX - sourceCenterX;
  const dy = targetCenterY - sourceCenterY;
  if (Math.abs(dx) >= Math.abs(dy)) {
    const side: GraphSide = dx >= 0 ? 'right' : 'left';
    return {
      x: source.position.x + (side === 'right' ? FLOW_NODE_WIDTH : 0),
      y: sourceCenterY + offset,
      side,
    };
  }
  const side: GraphSide = dy >= 0 ? 'bottom' : 'top';
  return {
    x: sourceCenterX + offset,
    y: source.position.y + (side === 'bottom' ? FLOW_NODE_HEIGHT : 0),
    side,
  };
}

function sideNormal(side: GraphSide): { x: number; y: number } {
  if (side === 'left') return { x: -1, y: 0 };
  if (side === 'right') return { x: 1, y: 0 };
  if (side === 'top') return { x: 0, y: -1 };
  return { x: 0, y: 1 };
}

function nodeAnnotations(node: GraphNode): GraphAnnotation[] {
  const annotations = node.detail?.annotations;
  if (!Array.isArray(annotations)) return [];
  return annotations.flatMap((item): GraphAnnotation[] => {
    const record = recordValue(item);
    if (!record || typeof record.id !== 'string' || typeof record.type !== 'string' || typeof record.label !== 'string') {
      return [];
    }
    return [{
      id: record.id,
      type: record.type,
      label: record.label,
      status: typeof record.status === 'string' ? record.status : undefined,
      target: typeof record.target === 'string' ? record.target : undefined,
      link_type: typeof record.link_type === 'string' ? record.link_type : undefined,
    }];
  });
}

function MandibleFlowNodeLabel({ node }: { node: GraphNode }): JSX.Element {
  const entries = firstEntries(node.metrics && Object.keys(node.metrics).length > 0 ? node.metrics : node.summary, 3);
  return (
    <div className="graph-flow-node" style={{ borderColor: nodeColor(node) }}>
      <div className="graph-flow-node__top">
        <span className="graph-flow-node__dot" style={{ background: nodeColor(node) }} />
        <span className="graph-flow-node__type">{typeLabel(node.type)}</span>
        {node.status && <span className="graph-flow-node__status">{node.status}</span>}
      </div>
      <div className="graph-flow-node__title">{node.label}</div>
      <div className="graph-flow-node__meta">
        {node.repo && <span>{node.repo}</span>}
        {node.branch && <span>{node.branch}</span>}
        {node.provider_id && <span>{node.provider_id}</span>}
        {!node.repo && !node.branch && !node.provider_id && <span>{compactId(node.id)}</span>}
      </div>
      {entries.length > 0 && (
        <div className="graph-flow-node__metrics">
          {entries.map(([key, value]) => (
            <span key={key}>{key}: {String(value)}</span>
          ))}
        </div>
      )}
    </div>
  );
}

function TokenMultiSelect({
  placeholder,
  options,
  selected,
  onChange,
  disabled = false,
}: {
  placeholder: string
  options: string[]
  selected: string[]
  onChange: (values: string[]) => void
  disabled?: boolean
}): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const [input, setInput] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const filteredOptions = useMemo(() => {
    const normalized = input.trim().toLowerCase();
    return options
      .filter((option) => !selectedSet.has(option))
      .filter((option) => normalized.length === 0 || option.toLowerCase().includes(normalized))
      .slice(0, 40);
  }, [input, options, selectedSet]);
  const activeOption = filteredOptions[Math.min(activeIndex, Math.max(0, filteredOptions.length - 1))];

  const addValue = (value: string) => {
    if (!value || selectedSet.has(value)) return;
    onChange([...selected, value]);
    setInput('');
    setActiveIndex(0);
    setOpen(true);
    inputRef.current?.focus();
  };

  const removeValue = (value: string) => {
    onChange(selected.filter((item) => item !== value));
    inputRef.current?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((index) => Math.min(index + 1, Math.max(0, filteredOptions.length - 1)));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => Math.max(0, index - 1));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const exact = filteredOptions.find((option) => option.toLowerCase() === input.trim().toLowerCase());
      if (exact || activeOption) addValue(exact ?? activeOption);
      return;
    }
    if (event.key === 'Backspace' && input.length === 0 && selected.length > 0) {
      event.preventDefault();
      onChange(selected.slice(0, -1));
      return;
    }
    if (event.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div className={`graph-token-select${open ? ' graph-token-select--open' : ''}${disabled ? ' graph-token-select--disabled' : ''}`}>
      <div
        className="graph-token-select__control"
        onClick={() => {
          if (disabled) return;
          inputRef.current?.focus();
          setOpen(true);
        }}
      >
        {selected.map((value) => (
          <span key={value} className="graph-token-select__pill">
            <span>{value}</span>
            <button
              type="button"
              aria-label={`Remove ${value}`}
              className="graph-token-select__remove"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => removeValue(value)}
            />
          </span>
        ))}
        <input
          ref={inputRef}
          type="text"
          className="graph-token-select__input"
          disabled={disabled}
          placeholder={selected.length === 0 ? placeholder : ''}
          value={input}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            setTimeout(() => setOpen(false), 110);
          }}
          onInput={(event) => {
            setInput((event.target as HTMLInputElement).value);
            setOpen(true);
            setActiveIndex(0);
          }}
          onKeyDown={handleKeyDown}
        />
        {selected.length > 0 && (
          <button
            type="button"
            className="graph-token-select__clear"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              onChange([]);
              inputRef.current?.focus();
            }}
          >
            Clear
          </button>
        )}
      </div>
      {open && !disabled && filteredOptions.length > 0 && (
        <div className="graph-token-select__menu">
          {filteredOptions.map((option, index) => (
            <button
              key={option}
              type="button"
              className={`graph-token-select__option${index === activeIndex ? ' graph-token-select__option--active' : ''}`}
              onMouseDown={(event) => {
                event.preventDefault();
                addValue(option);
              }}
            >
              {option}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function LensButton({
  lens,
  current,
  onSelect,
}: {
  lens: GraphModeDescriptor
  current: GraphMode
  onSelect: (mode: GraphMode) => void
}): JSX.Element {
  const disabled = !lens.available && lens.id !== current;
  return (
    <button
      type="button"
      className={`graph-lens-btn${lens.id === current ? ' graph-lens-btn--active' : ''}`}
      disabled={disabled}
      title={lens.summary ?? lens.description}
      onClick={() => onSelect(lens.id)}
    >
      <span>{lens.label}</span>
      <span className="graph-lens-btn__count">{lens.count}</span>
    </button>
  );
}

function LegendButton({
  item,
  onToggle,
}: {
  item: GraphLegendItem
  onToggle: (item: GraphLegendItem) => void
}): JSX.Element {
  return (
    <button
      type="button"
      className={[
        'graph-legend-btn',
        item.visible ? 'graph-legend-btn--active' : '',
        !item.enabled ? 'graph-legend-btn--disabled' : '',
      ].filter(Boolean).join(' ')}
      disabled={!item.enabled}
      title={item.description}
      onClick={() => onToggle(item)}
    >
      <span
        className={`graph-legend-btn__swatch graph-legend-btn__swatch--${item.kind}`}
        style={{ borderColor: item.color, background: item.kind === 'node' ? item.color : 'transparent' }}
      >
        {item.kind === 'edge' && (
          <span
            style={{
              borderTopColor: item.color,
              height: `${item.width ?? 1.5}px`,
              borderTopStyle: item.dash ? 'dashed' : 'solid',
            }}
          />
        )}
      </span>
      <span className="graph-legend-btn__label">{item.label}</span>
      <span className="graph-legend-btn__count">{item.count.toLocaleString()}</span>
    </button>
  );
}

function DetailPane({
  node,
  edges,
  onNavigate,
}: {
  node: GraphNode | null
  edges: GraphEdge[]
  onNavigate: (type: GraphNodeType, id: string, repoId?: string) => void
}): JSX.Element {
  const ledgerIssueId = node?.type === 'issue' && typeof node.detail?.ledger_issue_id === 'string'
    ? node.detail.ledger_issue_id
    : null;
  const [ledgerDetail, setLedgerDetail] = useState<LedgerIssueDetailProjection | null>(null);
  const [ledgerLoading, setLedgerLoading] = useState(false);
  const [ledgerError, setLedgerError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    if (!ledgerIssueId) {
      setLedgerDetail(null);
      setLedgerError(null);
      setLedgerLoading(false);
      return () => {
        active = false;
      };
    }
    setLedgerLoading(true);
    setLedgerError(null);
    getLedgerIssueDetail(ledgerIssueId)
      .then((detail) => {
        if (active) setLedgerDetail(detail);
      })
      .catch((error: unknown) => {
        if (active) setLedgerError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (active) setLedgerLoading(false);
      });
    return () => {
      active = false;
    };
  }, [ledgerIssueId]);

  if (!node) {
    return (
      <aside className="graph-detail-pane">
        <div className="graph-detail-pane__empty">Select a node</div>
      </aside>
    );
  }
  if (ledgerIssueId) {
    const openLedgerEntity = (type: 'issue' | 'session' | 'auth_request' | 'conversation', id: string, repoId?: string) => {
      if (type === 'issue') {
        const repo = repoId ?? ledgerDetail?.project.repo_id ?? node.repo_id ?? node.repo;
        onNavigate('issue', `issue:${repo ?? ''}:${id}`, repo ?? undefined);
        return;
      }
      if (type === 'auth_request') {
        onNavigate('auth_request', id);
        return;
      }
      if (type === 'session' || type === 'conversation') {
        onNavigate('session', id);
      }
    };
    return (
      <aside className="graph-detail-pane graph-detail-pane--ledger">
        {ledgerLoading && !ledgerDetail ? (
          <div className="graph-detail-pane__empty">Loading issue...</div>
        ) : ledgerError && !ledgerDetail ? (
          <div className="graph-detail-pane__empty">{ledgerError}</div>
        ) : ledgerDetail ? (
          <LedgerIssueDetail
            compact
            detail={ledgerDetail}
            onOpenEntity={openLedgerEntity}
            onAddComment={async (body) => {
              const next = await addLedgerIssueComment(ledgerIssueId, body);
              setLedgerDetail(next);
            }}
            onResolveConflict={async (conflictId, resolution, status) => {
              await resolveLedgerConflict(conflictId, resolution, status);
              setLedgerDetail(await getLedgerIssueDetail(ledgerIssueId));
            }}
          />
        ) : (
          <div className="graph-detail-pane__empty">No ledger detail</div>
        )}
      </aside>
    );
  }
  const connected = edges.filter((edge) => edge.source === node.id || edge.target === node.id).slice(0, 8);
  const detailEntries = firstEntries(node.detail, 8);
  const summaryEntries = firstEntries(node.summary, 8);
  const annotations = nodeAnnotations(node).slice(0, 12);
  const canNavigate = node.type === 'issue' || node.type === 'session' || node.type === 'auth_request' || node.type === 'artifact' || node.type === 'report';
  const navigateAnnotation = (annotation: GraphAnnotation) => {
    if (!annotation.target) return;
    if (annotation.target.startsWith('auth_request:')) onNavigate('auth_request', annotation.target);
    if (annotation.target.startsWith('session:')) onNavigate('session', annotation.target);
    if (annotation.target.startsWith('artifact:')) onNavigate('artifact', annotation.target);
  };
  return (
    <aside className="graph-detail-pane">
      <div className="graph-detail-pane__header">
        <div>
          <div className="graph-detail-pane__type">{typeLabel(node.type)}</div>
          <h3>{node.label}</h3>
        </div>
        {node.status && <span className="graph-detail-pane__status">{node.status}</span>}
      </div>

      <div className="graph-detail-pane__section">
        <div className="graph-detail-pane__section-title">Context</div>
        <div className="graph-detail-pane__kv">
          <span>ID</span><code>{node.id}</code>
          {node.repo && <><span>Repo</span><code>{node.repo}</code></>}
          {node.branch && <><span>Branch</span><code>{node.branch}</code></>}
          {node.provider_id && <><span>Provider</span><code>{node.provider_id}</code></>}
          {node.created_at && <><span>Created</span><code>{new Date(node.created_at).toLocaleString()}</code></>}
        </div>
      </div>

      {(summaryEntries.length > 0 || detailEntries.length > 0) && (
        <div className="graph-detail-pane__section">
          <div className="graph-detail-pane__section-title">Fields</div>
          <div className="graph-detail-pane__kv">
            {summaryEntries.map(([key, value]) => (
              <><span key={`${key}-k`}>{key}</span><code key={`${key}-v`}>{String(value)}</code></>
            ))}
            {detailEntries.map(([key, value]) => (
              <><span key={`${key}-k`}>{key}</span><code key={`${key}-v`}>{String(value)}</code></>
            ))}
          </div>
        </div>
      )}

      {annotations.length > 0 && (
        <div className="graph-detail-pane__section">
          <div className="graph-detail-pane__section-title">Evidence</div>
          <div className="graph-detail-pane__edges">
            {annotations.map((annotation) => (
              <button
                key={annotation.id}
                type="button"
                className="graph-detail-pane__edge"
                disabled={!annotation.target}
                onClick={() => navigateAnnotation(annotation)}
              >
                <span>{annotation.link_type ?? typeLabel(annotation.type)}</span>
                <code>{annotation.status ? `${annotation.label} (${annotation.status})` : annotation.label}</code>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="graph-detail-pane__section">
        <div className="graph-detail-pane__section-title">Actions</div>
        <div className="graph-detail-pane__actions">
          {canNavigate && (
            <button type="button" className="btn" onClick={() => onNavigate(node.type, node.id, node.repo_id ?? node.repo)}>
              Open
            </button>
          )}
          {(node.actions ?? []).map((action) => {
            const opensNode = action.kind === 'navigate' || (action.kind === 'preview' && (node.type === 'artifact' || node.type === 'report'));
            return (
            <button
              key={action.id}
              type="button"
              className="btn"
              disabled={action.disabled || !opensNode}
              onClick={() => opensNode && onNavigate(node.type, action.target ?? node.id, node.repo_id ?? node.repo)}
              title={action.description}
            >
              {action.label}{action.requires_auth ? ' *' : ''}
            </button>
            );
          })}
        </div>
      </div>

      <div className="graph-detail-pane__section">
        <div className="graph-detail-pane__section-title">Connected</div>
        <div className="graph-detail-pane__edges">
          {connected.length === 0 && <span className="text-muted">No visible edges</span>}
          {connected.map((edge) => (
            <div key={edge.id} className="graph-detail-pane__edge">
              <span>{edge.type.replace(/_/g, ' ')}</span>
              <code>{edge.source === node.id ? edge.target : edge.source}</code>
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}

export function GraphView({ onNavigate, refreshToken, initialMode, initialFocus }: GraphViewProps): JSX.Element {
  const routeMode = coerceGraphMode(initialMode);
  const [payload, setPayload] = useState<GraphPayload>({ nodes: [], edges: [], mode: DEFAULT_GRAPH_PRESET });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [spec, setSpec] = useState<GraphSpecState>({
    preset: routeMode,
    since: 'all',
    status: 'open',
    limit: 120,
    repos: [],
    branches: [],
  });
  const [visibleNodeFamilies, setVisibleNodeFamilies] = useState<Set<string> | null>(null);
  const [visibleEdgeFamilies, setVisibleEdgeFamilies] = useState<Set<string> | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  useEffect(() => {
    setSpec((current) => ({ ...current, preset: routeMode }));
    setVisibleNodeFamilies(null);
    setVisibleEdgeFamilies(null);
  }, [routeMode]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    getGraph({
      mode: spec.preset,
      since: spec.since === 'all' ? undefined : spec.since,
      status: spec.status === 'all' ? 'all' : undefined,
      repos: spec.repos,
      branches: spec.branches,
      limit: spec.limit,
    })
      .then((data) => {
        if (!active) return;
        setPayload(data);
        setVisibleNodeFamilies(buildDefaultNodeFamilySet(data));
        setVisibleEdgeFamilies(buildDefaultEdgeFamilySet(data, spec.preset));
        if (initialFocus && data.nodes.some((node) => node.id === initialFocus)) {
          setSelectedNodeId(initialFocus);
        } else if (data.nodes.length > 0 && !data.nodes.some((node) => node.id === selectedNodeId)) {
          setSelectedNodeId(data.nodes[0].id);
        }
      })
      .catch((err: unknown) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [spec, refreshToken, initialFocus]);

  const lenses = (payload.modes ?? Object.entries(MODE_LABELS).map(([id, label]) => ({
    id: id as GraphMode,
    label,
    kind: 'perspective' as const,
    description: MODE_SUMMARIES[id as GraphMode],
    summary: MODE_SUMMARIES[id as GraphMode],
    count: id === spec.preset ? payload.nodes.length : 0,
    available: id === spec.preset,
  }))).map((mode) => ({
    ...mode,
    label: MODE_LABELS[mode.id] ?? mode.label,
    summary: MODE_SUMMARIES[mode.id] ?? mode.summary,
    description: MODE_SUMMARIES[mode.id] ?? mode.description,
  }));
  const activeLensDescriptor = lenses.find((item) => item.id === spec.preset);
  const activeLensSummary = activeLensDescriptor?.summary
    ?? activeLensDescriptor?.description
    ?? MODE_SUMMARIES[spec.preset];
  const activeLensTotal = payload.mode === spec.preset && payload.available_count != null
    ? payload.available_count
    : lenses.find((item) => item.id === spec.preset)?.count ?? payload.nodes.length;
  const displayedCount = payload.displayed_count ?? payload.nodes.length;

  const repos = useMemo(() => {
    const seen = new Set<string>(payload.filters?.repos ?? []);
    spec.repos.forEach((repo) => seen.add(repo));
    if (seen.size === 0) {
      payload.nodes.forEach((node) => (node.repo || node.repo_id) && seen.add(node.repo || node.repo_id || ''));
    }
    return Array.from(seen).filter(Boolean).sort();
  }, [payload.filters?.repos, payload.nodes, spec.repos]);

  const branches = useMemo(() => {
    const seen = new Set<string>(payload.filters?.branches ?? []);
    spec.branches.forEach((branch) => seen.add(branch));
    if (seen.size === 0) {
      payload.nodes.forEach((node) => {
        if (node.branch) seen.add(node.branch);
      });
    }
    return Array.from(seen).sort();
  }, [payload.filters?.branches, payload.nodes, spec.branches]);

  const nodeLegend = useMemo(
    () => buildNodeLegend(payload, visibleNodeFamilies),
    [payload, visibleNodeFamilies],
  );
  const edgeLegend = useMemo(
    () => buildEdgeLegend(payload, visibleEdgeFamilies, spec.preset),
    [payload, visibleEdgeFamilies, spec.preset],
  );
  const visibleNodeFamilyIds = useMemo(
    () => new Set(nodeLegend.filter((item) => item.visible).map((item) => item.id)),
    [nodeLegend],
  );
  const visibleEdgeFamilyIds = useMemo(
    () => new Set(edgeLegend.filter((item) => item.visible).map((item) => item.id)),
    [edgeLegend],
  );
  const visibleNodes = useMemo(() => {
    if (nodeLegend.length === 0) return payload.nodes;
    return payload.nodes.filter((node) => visibleNodeFamilyIds.has(node.type));
  }, [payload.nodes, nodeLegend.length, visibleNodeFamilyIds]);
  const visibleNodeIds = useMemo(() => new Set(visibleNodes.map((node) => node.id)), [visibleNodes]);
  const visibleEdges = useMemo(
    () => payload.edges.filter((edge) => (
      visibleNodeIds.has(edge.source)
      && visibleNodeIds.has(edge.target)
      && visibleEdgeFamilyIds.has(edgeFamilyId(edge))
    )),
    [payload.edges, visibleNodeIds, visibleEdgeFamilyIds],
  );
  const flowNodes = useMemo(
    () => layoutNodes(visibleNodes, visibleEdges, spec.preset).map((node) => ({
      ...node,
      selected: (node.data as { node: GraphNode }).node.id === selectedNodeId,
    })),
    [visibleNodes, visibleEdges, spec.preset, selectedNodeId],
  );
  const flowEdgeList = useMemo(() => flowEdges(visibleEdges), [visibleEdges]);
  const flowSignature = useMemo(
    () => [
      spec.preset,
      selectedNodeId ?? '',
      flowNodes.map((node) => node.id).join(','),
      flowEdgeList.map((edge) => edge.id).join(','),
    ].join(':'),
    [flowEdgeList, flowNodes, spec.preset, selectedNodeId],
  );
  const selectedNode = useMemo(
    () => visibleNodes.find((node) => node.id === selectedNodeId) ?? visibleNodes[0] ?? null,
    [visibleNodes, selectedNodeId],
  );

  const updateSpec = (patch: Partial<GraphSpecState>) => {
    setSpec((current) => ({ ...current, ...patch }));
  };

  const selectPreset = (preset: GraphMode) => {
    setSpec((current) => ({
      ...current,
      preset,
      status: preset === 'issue' ? 'open' : current.status,
    }));
    setVisibleNodeFamilies(null);
    setVisibleEdgeFamilies(null);
  };

  const toggleLegendItem = (item: GraphLegendItem) => {
    if (!item.enabled) return;
    if (item.kind === 'node') {
      const fallback = new Set(nodeLegend.filter((legendItem) => legendItem.visible).map((legendItem) => legendItem.id));
      setVisibleNodeFamilies((prev) => {
        const next = new Set(prev ?? fallback);
        if (next.has(item.id)) next.delete(item.id);
        else next.add(item.id);
        return next;
      });
      return;
    }
    const fallback = new Set(edgeLegend.filter((legendItem) => legendItem.visible).map((legendItem) => legendItem.id));
    setVisibleEdgeFamilies((prev) => {
      const next = new Set(prev ?? fallback);
      if (next.has(item.id)) next.delete(item.id);
      else next.add(item.id);
      return next;
    });
  };

  const graphDisplaySummary = `Displayed ${visibleNodes.length.toLocaleString()} nodes and ${visibleEdges.length.toLocaleString()} edges`;
  const graphAvailableSummary = `Available from query: ${displayedCount.toLocaleString()}${payload.truncated || displayedCount < activeLensTotal ? ` of ${activeLensTotal.toLocaleString()}` : ''} nodes, ${payload.edges.length.toLocaleString()} edges`;

  return (
    <div className="graph-view">
      <div className="graph-topbar">
        <div className="graph-primary-controls">
          <div className="graph-spec-row">
            <span className="graph-spec-row__label">Lens</span>
            <div className="graph-lens-strip" aria-label="Graph lens presets">
              {lenses.map((item) => (
                <LensButton key={item.id} lens={item} current={spec.preset} onSelect={selectPreset} />
              ))}
            </div>
          </div>
          <div className="graph-legend-grid">
            <div className="graph-spec-row graph-spec-row--legend">
              <span className="graph-spec-row__label">Nodes</span>
              <div className="graph-legend-strip" aria-label="Visible node families">
                {nodeLegend.length === 0 && <div className="graph-legend-strip__empty">No node families</div>}
                {nodeLegend.map((item) => (
                  <LegendButton key={item.id} item={item} onToggle={toggleLegendItem} />
                ))}
              </div>
            </div>
            <div className="graph-spec-row graph-spec-row--legend">
              <span className="graph-spec-row__label">Edges</span>
              <div className="graph-legend-strip" aria-label="Visible edge families">
                {edgeLegend.length === 0 && <div className="graph-legend-strip__empty">No edge families</div>}
                {edgeLegend.map((item) => (
                  <LegendButton key={item.id} item={item} onToggle={toggleLegendItem} />
                ))}
              </div>
            </div>
          </div>
          <div className="graph-display-summary" aria-live="polite">
            <strong>{activeLensSummary}</strong>
            <span>{graphDisplaySummary}</span>
            <span>{graphAvailableSummary}</span>
          </div>
        </div>
        <div className="graph-toolbar" aria-label="Graph spec controls">
          <div className="graph-control-group graph-control-group--scope">
            <span className="graph-control-group__label">Scope</span>
            <div className="graph-toolbar__combobox-group">
              <TokenMultiSelect
                placeholder="All repos"
                options={repos}
                selected={spec.repos}
                onChange={(repos) => updateSpec({ repos })}
              />
              <TokenMultiSelect
                placeholder="All branches"
                options={branches}
                selected={spec.branches}
                onChange={(branches) => updateSpec({ branches })}
                disabled={branches.length === 0}
              />
            </div>
          </div>
          <div className="graph-control-group">
            <span className="graph-control-group__label">Time</span>
            <div className="graph-toolbar__toggle-group">
              {(['1d', '3d', '7d', 'all'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  className={`graph-toolbar__toggle${spec.since === value ? ' graph-toolbar__toggle--active' : ''}`}
                  onClick={() => updateSpec({ since: value })}
                >
                  {value}
                </button>
              ))}
            </div>
          </div>
          <div className="graph-control-group">
            <span className="graph-control-group__label">Status</span>
            <div className="graph-toolbar__toggle-group">
              {(['open', 'all'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  className={`graph-toolbar__toggle${spec.status === value ? ' graph-toolbar__toggle--active' : ''}`}
                  onClick={() => updateSpec({ status: value })}
                >
                  {value}
                </button>
              ))}
            </div>
          </div>
          <div className="graph-control-group" aria-label="Graph size">
            <span className="graph-control-group__label">Size</span>
            <div className="graph-toolbar__toggle-group">
              {GRAPH_SIZE_OPTIONS.map((value) => (
                <button
                  key={value}
                  type="button"
                  className={`graph-toolbar__toggle${spec.limit === value ? ' graph-toolbar__toggle--active' : ''}`}
                  onClick={() => updateSpec({ limit: value })}
                >
                  {value.toLocaleString()}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="graph-workspace">
        <div className="graph-canvas-wrap">
          {loading && <div className="graph-loading">Loading graph...</div>}
          {error && <div className="graph-error">{error}</div>}
          {!loading && !error && flowNodes.length === 0 && (
            <div className="graph-empty">
              <h3>No graph data</h3>
              <p>{MODE_LABELS[spec.preset]} has no visible nodes for the current spec.</p>
            </div>
          )}
          {!loading && !error && flowNodes.length > 0 && (
            <ReactFlow
              key={flowSignature}
              defaultNodes={flowNodes}
              defaultEdges={[]}
              fitView
              fitViewOptions={{ padding: 0.16 }}
              minZoom={0.2}
              maxZoom={1.8}
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable
              onNodeClick={(_event, node) => setSelectedNodeId((node.data as { node: GraphNode }).node.id)}
              onNodeDoubleClick={(_event, node) => {
                const graphNode = (node.data as { node: GraphNode }).node;
                if (graphNode && (graphNode.type === 'issue' || graphNode.type === 'session' || graphNode.type === 'auth_request' || graphNode.type === 'artifact' || graphNode.type === 'report')) {
                  onNavigate(graphNode.type, graphNode.id, graphNode.repo_id ?? graphNode.repo);
                }
              }}
            >
              <ViewportPortal>
                <ManualGraphEdges nodes={flowNodes} edges={visibleEdges} />
              </ViewportPortal>
              <Background color="rgba(154,164,178,0.12)" gap={18} />
              <MiniMap
                pannable
                zoomable
                nodeColor={(node) => nodeColor((node.data as { node: GraphNode }).node)}
                maskColor="rgba(11,15,20,0.64)"
              />
              <Controls showInteractive={false} />
            </ReactFlow>
          )}
        </div>

        <DetailPane node={selectedNode} edges={visibleEdges} onNavigate={onNavigate} />
      </div>
    </div>
  );
}

export default GraphView;
