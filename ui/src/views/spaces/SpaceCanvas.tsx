import { NativeSelect } from '../../components/shared/NativeSelect';
import { Icon } from '../../components/icons/Icon';
// SpaceCanvas — the NODE half of the editable Spaces canvas renderer (umbrella
// de56ffa, child 1dfa2e1).
//
// This is a NEW renderer; it is NOT a mutation of `ui/src/views/graph.tsx`. The
// load-bearing difference from the existing graph view:
//
//   - graph.tsx recomputes `layoutGraph()` on every render and disables drag
//     (`nodesDraggable={false}`, graph.tsx:1285). Layout is the source of truth
//     there; positions are derived.
//   - SpaceCanvas is the inverse: persisted `space_occurrences` (x/y/size/z) are
//     the source of truth. `layoutGraph()` is reused ONLY to seed positions for
//     initial-arrange / re-layout-selected / seed-from-graph — NEVER per render
//     after the user moves a node. Dragging is enabled and persists.
//
// Persisted positions are canonical (ledger). Zoom / scroll / selection are
// ephemeral browser-local view state (project Dataful UX State rule): SSE
// reconciliation updates node positions WITHOUT resetting the viewport or the
// current selection.
//
// Ownership: this component owns the canvas node surface, authored edge
// selection/actions, and its own `SpaceCanvas.css`. It reads
// `../../graph/layout` (`layoutGraph`) for the seed path only and must NOT
// modify `graph.tsx`.

import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { DetailPaneNotice } from '../../components/shared/DetailPaneNotice';
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  applyNodeChanges,
  type Connection,
  type EdgeChange,
  type Edge as FlowEdge,
  type EdgeMarkerType,
  type Node as FlowNode,
  type NodeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import type {
  SpaceItem,
  SpaceOccurrence,
  SpaceEdge,
  BatchSpaceOccurrenceEntry,
  CreateSpaceEdgeRequest,
  UpdateSpaceEdgeRequest,
} from '../../api';
import {
  batchWriteSpaceOccurrences,
  createSpaceEdge,
  createSpaceOccurrence,
  deleteSpaceEdge,
  updateSpaceEdge,
} from '../../api';
import { layoutGraph } from '../../graph/layout';
import { useAnchoredMenu } from '../../hooks/useAnchoredMenu';
import type { GraphEdge, GraphNode } from '../../types/graph';
import type { SpaceRendererMountProps } from './SpacesViewShell';
import { SpaceItemPicker } from './SpaceItemPicker';
import {
  ArtifactReferenceDetail,
  IssueReferenceDetail,
} from '../reference-detail';
import { SpaceTypeIndicator } from './SpaceTypeIndicator';
import {
  LEDGER_LINK_TYPES,
  evaluatePromotion,
  indexItemsById,
  indexOccurrences,
  reconcileEdges,
  resolveEdge,
  type LedgerLinkType,
  type ResolvedSpaceEdge,
} from './edgeModel';
import { promoteEdgeToLedger, type PromoteEdgeDeps } from './edgePromote';
import './SpaceCanvas.css';
import { spacesRouteFromHash } from '../../routing';

// ---------------------------------------------------------------------------
// Pure model helpers (exported for unit tests). These carry the load-bearing
// rules — shelf partition, seed-only layout, SSE reconciliation that preserves
// viewport/selection — so they are testable without mounting React Flow.
// ---------------------------------------------------------------------------

/** Autosave indicator state for the debounced batch write. */
export type AutosaveStatus = 'idle' | 'saving' | 'saved' | 'error' | 'disabled';

/**
 * A canvas node: a placed occurrence joined to its backing item. `x`/`y` are
 * the persisted (canonical) coordinates.
 */
export type CanvasNode = {
  occurrence: SpaceOccurrence;
  item: SpaceItem | null;
  x: number;
  y: number;
};

export type SpaceFlowNode = FlowNode<SpaceFlowNodeData, 'spaceOccurrence'>;

type SpaceFlowNodeData = {
  label: string;
  kind: string;
  linkedSpace?: {
    id: string;
    primaryType: string;
    primaryLabel: string;
    projectLabel: string;
    href: string;
  };
} & Record<string, unknown>;

/** A legacy unplaced occurrence entry. New Canvas adds place immediately. */
export type ShelfEntry = {
  occurrence: SpaceOccurrence;
  item: SpaceItem | null;
};

export type CanvasPartition = {
  placed: CanvasNode[];
  shelf: ShelfEntry[];
};

export function isCanvasOccurrence(occurrence: Pick<SpaceOccurrence, 'renderer'>): boolean {
  return occurrence.renderer === 'canvas';
}

/**
 * Split occurrences into placed vs legacy unplaced. An occurrence is placed iff
 * BOTH x and y are non-null finite numbers; otherwise it needs immediate
 * placement before it is drawn.
 */
export function partitionOccurrences(
  occurrences: SpaceOccurrence[],
  itemsById: Record<string, SpaceItem>,
): CanvasPartition {
  const placed: CanvasNode[] = [];
  const shelf: ShelfEntry[] = [];
  for (const occurrence of occurrences) {
    if (!isCanvasOccurrence(occurrence)) continue;
    const item = occurrence.item_id ? (itemsById[occurrence.item_id] ?? null) : null;
    if (isPlaced(occurrence)) {
      placed.push({ occurrence, item, x: occurrence.x as number, y: occurrence.y as number });
    } else {
      shelf.push({ occurrence, item });
    }
  }
  return { placed, shelf };
}

/** True when an occurrence has a concrete persisted position (both x and y). */
export function isPlaced(occurrence: Pick<SpaceOccurrence, 'x' | 'y'>): boolean {
  return (
    typeof occurrence.x === 'number' &&
    Number.isFinite(occurrence.x) &&
    typeof occurrence.y === 'number' &&
    Number.isFinite(occurrence.y)
  );
}

/** Index items by id for occurrence joins. */
export function indexItems(items: SpaceItem[]): Record<string, SpaceItem> {
  const byId: Record<string, SpaceItem> = {};
  for (const item of items) byId[item.id] = item;
  return byId;
}

function occurrenceLabel(occurrence: SpaceOccurrence, item: SpaceItem | null): string {
  if (item?.title) return item.title;
  if (occurrence.note) return occurrence.note;
  if (item?.ref_id) return item.ref_id;
  return occurrence.id.slice(0, 8);
}

function occurrenceKind(item: SpaceItem | null): string {
  return item?.ref_type ?? 'occurrence';
}

function metadataString(metadata: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function formatSpacePrimaryLabel(value: string): string {
  switch (value) {
    case 'document':
      return 'Document';
    case 'board':
      return 'Board';
    case 'collection':
      return 'Collection';
    case 'canvas':
      return 'Canvas';
    default:
      return value || 'Space';
  }
}

function linkedSpaceData(item: SpaceItem | null): SpaceFlowNodeData['linkedSpace'] | undefined {
  if (!item || (item.ref_type as string) !== 'space') return undefined;
  const metadata = item.metadata ?? {};
  const primaryType =
    metadataString(metadata, ['primary_type', 'default_renderer', 'space_type']) || 'space';
  const primaryLabel =
    metadataString(metadata, ['primary_type_label', 'default_renderer_label']) ||
    formatSpacePrimaryLabel(primaryType);
  const projectLabel = metadataString(metadata, ['project_label', 'project_name', 'project_key']);
  return {
    id: item.ref_id,
    primaryType,
    primaryLabel,
    projectLabel,
    href: spacesRouteFromHash(
      typeof window === 'undefined' ? '#/spaces' : window.location.hash || '#/spaces',
      { spaceId: item.ref_id, renderer: null },
    ),
  };
}

/**
 * Map authored `space_edges` to React Flow edges so a connection the user draws
 * or an SSE-refetched edge renders as a line between the
 * two placed nodes. `space_edge.source`/`.target` are OCCURRENCE ids, which are
 * exactly the React Flow node ids (`flowNodes` uses `occurrence.id`), so the
 * mapping is direct — no ref translation. Edges whose endpoints are not both
 * currently placed on the canvas are skipped until legacy unplaced endpoints
 * have been seeded onto the canvas.
 */
export function edgesToFlowEdges(
  edges: SpaceEdge[],
  placedIds: ReadonlySet<string>,
  selectedEdgeId: string | null = null,
): FlowEdge[] {
  const flow: FlowEdge[] = [];
  for (const edge of edges) {
    if (!placedIds.has(edge.source) || !placedIds.has(edge.target)) continue;
    const selected = edge.id === selectedEdgeId;
    flow.push({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      label: edge.label ?? undefined,
      selected,
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: selected ? 'var(--accent-blue)' : 'var(--text-muted, #8a8f98)',
      },
      // React Flow's default edge styling is theme-agnostic; the concrete stroke
      // colors come from `SpaceCanvas.css` (real theme tokens), not inline hex.
      className: 'space-canvas__edge',
    });
  }
  return flow;
}

function markerFingerprint(marker: EdgeMarkerType | undefined): string {
  if (!marker) return '';
  return typeof marker === 'string' ? marker : `${marker.type}:${marker.color ?? ''}`;
}

function sameFlowEdge(left: FlowEdge, right: FlowEdge): boolean {
  return (
    left.id === right.id &&
    left.source === right.source &&
    left.target === right.target &&
    left.label === right.label &&
    left.selected === right.selected &&
    left.className === right.className &&
    markerFingerprint(left.markerEnd) === markerFingerprint(right.markerEnd)
  );
}

export function reconcileFlowEdges(
  edges: SpaceEdge[],
  placedIds: ReadonlySet<string>,
  selectedEdgeId: string | null,
  previous: FlowEdge[] = [],
): FlowEdge[] {
  const previousById = new Map(previous.map((edge) => [edge.id, edge]));
  let changed = false;
  const next = edgesToFlowEdges(edges, placedIds, selectedEdgeId).map((edge, index) => {
    const previousEdge = previousById.get(edge.id);
    if (previousEdge && sameFlowEdge(previousEdge, edge)) {
      if (previous[index] !== previousEdge) changed = true;
      return previousEdge;
    }
    changed = true;
    return edge;
  });
  if (next.length !== previous.length) changed = true;
  return changed ? next : previous;
}

/**
 * Validate a React Flow connection into a `CreateSpaceEdgeRequest`, or null when
 * the connection is not a valid authored edge (missing endpoints or a self-loop).
 * Drag-created edges default to an EMPTY label; the user edits it afterward in
 * the Canvas selection inspector (no blocking label prompt).
 */
export function connectionToEdgeRequest(
  connection: Connection,
): CreateSpaceEdgeRequest | null {
  const { source, target } = connection;
  if (!source || !target || source === target) return null;
  return { source, target, label: '' };
}

export function canvasNodesToFlowNodes(
  placed: CanvasNode[],
  selection: ReadonlySet<string>,
): SpaceFlowNode[] {
  return placed.map((node) => ({
    id: node.occurrence.id,
    position: { x: node.x, y: node.y },
    data: {
      label: occurrenceLabel(node.occurrence, node.item),
      kind: occurrenceKind(node.item),
      linkedSpace: linkedSpaceData(node.item),
    },
    selected: selection.has(node.occurrence.id),
    type: 'spaceOccurrence',
  }));
}

export function applyLocalNodeChanges(
  nodes: SpaceFlowNode[],
  changes: NodeChange<SpaceFlowNode>[],
): SpaceFlowNode[] {
  return applyNodeChanges<SpaceFlowNode>(changes, nodes);
}

/**
 * Map occurrences to `GraphNode`s so `layoutGraph()` (the existing structured
 * layout) can seed positions. Edges are mapped from `parent_id` links only so
 * the structural hierarchy layout has something to arrange.
 */
export function occurrencesToGraph(
  occurrences: SpaceOccurrence[],
  itemsById: Record<string, SpaceItem>,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const canvasOccurrences = occurrences.filter(isCanvasOccurrence);
  const nodes: GraphNode[] = canvasOccurrences.map((occurrence) => {
    const item = occurrence.item_id ? (itemsById[occurrence.item_id] ?? null) : null;
    return {
      id: occurrence.id,
      type: (item?.ref_type ?? 'issue') as GraphNode['type'],
      label: occurrenceLabel(occurrence, item),
    };
  });
  const present = new Set(canvasOccurrences.map((o) => o.id));
  const edges: GraphEdge[] = [];
  for (const occurrence of canvasOccurrences) {
    if (occurrence.parent_id && present.has(occurrence.parent_id)) {
      edges.push({
        id: `${occurrence.parent_id}->${occurrence.id}`,
        source: occurrence.parent_id,
        target: occurrence.id,
        type: 'parent',
      });
    }
  }
  return { nodes, edges };
}

/**
 * Seed positions for the given occurrences via the existing structured
 * `layoutGraph()`. Returns a map of occurrence id → {x,y}. This is the ONLY
 * place layout runs: initial arrange, re-layout selected, or seed-from-graph.
 * It is never called on a normal render after a user drag — the React component
 * only invokes it from explicit user actions / first load of an unarranged
 * space.
 */
export function seedLayoutPositions(
  occurrences: SpaceOccurrence[],
  itemsById: Record<string, SpaceItem>,
): Record<string, { x: number; y: number }> {
  const { nodes, edges } = occurrencesToGraph(occurrences, itemsById);
  const result = layoutGraph(nodes, edges);
  const positions: Record<string, { x: number; y: number }> = {};
  for (const positioned of result.nodes) {
    positions[positioned.id] = { x: positioned.position.x, y: positioned.position.y };
  }
  return positions;
}

/**
 * Build batch-write entries from an id→position map. Each entry carries the
 * occurrence `id` so the batch route UPDATES (not creates) — see
 * `batchWriteSpaceOccurrences`.
 */
export function buildBatchEntries(
  positions: Record<string, { x: number; y: number }>,
): BatchSpaceOccurrenceEntry[] {
  return Object.entries(positions).map(([id, pos]) => ({ id, x: pos.x, y: pos.y }));
}

/**
 * Reconcile a fresh server occurrence list into the locally-held occurrence
 * list WITHOUT touching ephemeral view state. This is the SSE-driven path: the
 * server position becomes canonical, EXCEPT for ids currently being dragged
 * locally (so an in-flight optimistic drag is not yanked back by an echo of an
 * older value). Crucially, this function only returns the next occurrence list;
 * it has no access to viewport/selection, so reconciliation can never reset
 * zoom or selection (acceptance criterion).
 */
export function reconcileOccurrences(
  incoming: SpaceOccurrence[],
  draggingIds: ReadonlySet<string>,
  previous: SpaceOccurrence[],
  protectedPositions: Record<string, { x: number; y: number }> = {},
): SpaceOccurrence[] {
  const previousById = new Map(previous.map((o) => [o.id, o]));
  let changed = previous.length !== incoming.length;
  const nextOccurrences = incoming.map((next, index) => {
    const previousOccurrence = previousById.get(next.id);
    if (draggingIds.has(next.id)) {
      // Keep the local in-flight value for nodes the user is actively moving.
      if (!previousOccurrence) changed = true;
      else if (previous[index] !== previousOccurrence) changed = true;
      return previousOccurrence ?? next;
    }
    const protectedPosition = protectedPositions[next.id];
    if (protectedPosition && (next.x !== protectedPosition.x || next.y !== protectedPosition.y)) {
      changed = true;
      return { ...(previousOccurrence ?? next), x: protectedPosition.x, y: protectedPosition.y };
    }
    if (previousOccurrence && sameSpaceOccurrence(previousOccurrence, next)) {
      if (previous[index] !== previousOccurrence) changed = true;
      return previousOccurrence;
    }
    changed = true;
    return next;
  });
  const incomingIds = new Set(incoming.map((occurrence) => occurrence.id));
  for (const previousOccurrence of previous) {
    if (incomingIds.has(previousOccurrence.id) || !draggingIds.has(previousOccurrence.id)) continue;
    nextOccurrences.push(previousOccurrence);
    changed = true;
  }
  return changed ? nextOccurrences : previous;
}

function sameUnknownRecord(
  left: Record<string, unknown> | null | undefined,
  right: Record<string, unknown> | null | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => Object.is(left[key], right[key]));
}

function sameSpaceOccurrence(left: SpaceOccurrence, right: SpaceOccurrence): boolean {
  return (
    left.id === right.id &&
    left.space_id === right.space_id &&
    left.item_id === right.item_id &&
    left.renderer === right.renderer &&
    left.parent_id === right.parent_id &&
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height &&
    left.z_index === right.z_index &&
    left.sort_key === right.sort_key &&
    left.section_id === right.section_id &&
    left.note === right.note &&
    left.created_at === right.created_at &&
    left.updated_at === right.updated_at &&
    sameUnknownRecord(left.metadata, right.metadata)
  );
}

/** Apply an optimistic position to one occurrence in a list (drag preview). */
export function applyOptimisticPosition(
  occurrences: SpaceOccurrence[],
  id: string,
  x: number,
  y: number,
): SpaceOccurrence[] {
  return occurrences.map((o) => (o.id === id ? { ...o, x, y } : o));
}

/** Pick an immediate placement for newly added Canvas items instead of shelving them. */
export function nextAddedItemPosition(placed: CanvasNode[]): { x: number; y: number } {
  if (placed.length === 0) return { x: 0, y: 0 };
  const rightMost = placed.reduce((max, node) => Math.max(max, node.x), placed[0].x);
  const topMost = placed.reduce((min, node) => Math.min(min, node.y), placed[0].y);
  return { x: rightMost + 260, y: topMost };
}

export type SpaceCanvasModel = {
  occurrences: SpaceOccurrence[];
  items: SpaceItem[];
  /**
   * Authored `space_edges` to render as lines on the canvas. Optional so the
   * frozen `{ occurrences, items }` callers stay valid; defaults to no edges.
   */
  edges?: SpaceEdge[];
};

export type SpaceCanvasProps = SpaceRendererMountProps & {
  /** Current Query-owned packet projected to canvas inputs. Local edits reconcile against it. */
  model?: SpaceCanvasModel;
  /** Batch-write client (injected for tests); defaults to the real C2 client. */
  batchWrite?: typeof batchWriteSpaceOccurrences;
  /**
   * Edge-create client (injected for tests); defaults to the real C2 client.
   * Called by `onConnect` when the user drags a connection between two nodes.
   */
  createEdge?: typeof createSpaceEdge;
  /** Edge update client (injected for tests); defaults to the real C2 client. */
  updateEdge?: typeof updateSpaceEdge;
  /** Edge delete client (injected for tests); defaults to the real C2 client. */
  removeEdge?: typeof deleteSpaceEdge;
  /** Promote client (injected for tests); defaults to the real ledger call. */
  promote?: (
    request: Parameters<typeof promoteEdgeToLedger>[0],
    deps?: PromoteEdgeDeps,
  ) => ReturnType<typeof promoteEdgeToLedger>;
  /**
   * Single-occurrence create client (injected for tests); defaults to the real
   * C2 client. Used by the "Add items" picker to materialize a placed
   * `canvas` occurrence so a freshly-added item lands directly on the canvas.
   */
  createOccurrence?: typeof createSpaceOccurrence;
  /** Debounce window (ms) for the batched drag-position write. */
  debounceMs?: number;
};

type PendingAckPosition = {
  x: number;
  y: number;
  savedAt: number | null;
  expiresAt: number;
  previewDisabled?: boolean;
};


const DEFAULT_DEBOUNCE_MS = 400;
const POSITION_ACK_PROTECTION_MS = 10_000;
const MIN_INSPECTOR_HEIGHT = 160;
const MAX_INSPECTOR_BODY_FRACTION = 0.7;

function clampInspectorHeight(height: number, bodyHeight: number): number {
  const maxHeight = Math.max(
    MIN_INSPECTOR_HEIGHT,
    Math.floor(bodyHeight * MAX_INSPECTOR_BODY_FRACTION),
  );
  return Math.min(Math.max(Math.round(height), MIN_INSPECTOR_HEIGHT), maxHeight);
}

/**
 * The editable Spaces canvas (node half). Registered into `SpacesViewShell` as
 * the `canvas` renderer mount point.
 */
export function SpaceCanvas(props: SpaceCanvasProps): JSX.Element {
  const {
    spaceId,
    projectId,
    instance,
    model,
    batchWrite = batchWriteSpaceOccurrences,
    createEdge = createSpaceEdge,
    updateEdge = updateSpaceEdge,
    removeEdge = deleteSpaceEdge,
    promote = promoteEdgeToLedger,
    createOccurrence = createSpaceOccurrence,
    debounceMs = DEFAULT_DEBOUNCE_MS,
  } = props;

  const [occurrences, setOccurrences] = useState<SpaceOccurrence[]>(
    () => model?.occurrences ?? [],
  );
  const [items, setItems] = useState<SpaceItem[]>(() => model?.items ?? []);
  // Authored `space_edges` rendered as lines on the canvas and edited through the
  // Canvas selection inspector.
  const [edges, setEdges] = useState<SpaceEdge[]>(() => model?.edges ?? []);
  const [autosave, setAutosave] = useState<AutosaveStatus>('idle');
  const [edgeStatus, setEdgeStatus] = useState<AutosaveStatus>('idle');
  const [edgeStatusMessage, setEdgeStatusMessage] = useState('');
  // UI selection is ephemeral browser-local view state — never persisted, never
  // reset by SSE reconciliation.
  const [selection, setSelection] = useState<Set<string>>(() => new Set());
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [promoteLinkType, setPromoteLinkType] = useState<Record<string, LedgerLinkType>>({});
  const [actionsMenuOpen, setActionsMenuOpen] = useState(false);
  // Which picker popover is open (transient browser-local).
  const [pickerMode, setPickerMode] = useState<'items' | 'spaces' | null>(null);
  const [inspectorHeight, setInspectorHeight] = useState<number | null>(null);

  // Refs that must not trigger re-render or re-subscribe.
  const draggingIds = useRef<Set<string>>(new Set());
  const pendingPositions = useRef<Record<string, { x: number; y: number }>>({});
  const pendingAckPositions = useRef<Record<string, PendingAckPosition>>({});
  const debounceTimer = useRef<number | null>(null);
  const occurrencesRef = useRef<SpaceOccurrence[]>(occurrences);
  const flowEdgesRef = useRef<FlowEdge[]>([]);
  const editingEdgeIds = useRef<Set<string>>(new Set());
  const bodyRef = useRef<HTMLDivElement>(null);
  const actionsTriggerRef = useRef<HTMLButtonElement>(null);
  const actionsMenuRef = useRef<HTMLDivElement>(null);
  const inspectorResizeRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const actionsMenuStyle = useAnchoredMenu({
    open: actionsMenuOpen,
    anchorRef: actionsTriggerRef,
    menuRef: actionsMenuRef,
    onDismiss: () => setActionsMenuOpen(false),
  });
  occurrencesRef.current = occurrences;

  const itemsById = useMemo(() => indexItems(items), [items]);
  const { placed, shelf } = useMemo(
    () => partitionOccurrences(occurrences, itemsById),
    [occurrences, itemsById],
  );

  const protectPositionsUntilAck = useCallback((positions: Record<string, { x: number; y: number }>) => {
    const expiresAt = Date.now() + POSITION_ACK_PROTECTION_MS;
    for (const [id, position] of Object.entries(positions)) {
      pendingAckPositions.current[id] = { ...position, savedAt: null, expiresAt };
      draggingIds.current.add(id);
    }
  }, []);

  const markPositionsSaved = useCallback((
    entries: BatchSpaceOccurrenceEntry[],
    savedOccurrences: SpaceOccurrence[],
  ) => {
    const savedById = new Map(savedOccurrences.map((occurrence) => [occurrence.id, occurrence]));
    const fallbackSavedAt = Date.now();
    for (const entry of entries) {
      if (!entry.id) continue;
      const pending = pendingAckPositions.current[entry.id];
      if (!pending) continue;
      const saved = savedById.get(entry.id);
      pendingAckPositions.current[entry.id] = {
        ...pending,
        savedAt: saved?.updated_at ?? fallbackSavedAt,
      };
    }
  }, []);

  const protectedPositionsForIncoming = useCallback((incoming: SpaceOccurrence[]): Record<string, { x: number; y: number }> => {
    const now = Date.now();
    const incomingById = new Map(incoming.map((occurrence) => [occurrence.id, occurrence]));
    const protectedPositions: Record<string, { x: number; y: number }> = {};
    for (const [id, position] of Object.entries(pendingAckPositions.current)) {
      if (position.previewDisabled) {
        protectedPositions[id] = { x: position.x, y: position.y };
        continue;
      }
      if (position.expiresAt <= now) {
        delete pendingAckPositions.current[id];
        draggingIds.current.delete(id);
        continue;
      }
      if (
        !incomingById.has(id) ||
        position.savedAt === null ||
        incomingById.get(id)!.updated_at < position.savedAt
      ) {
        protectedPositions[id] = { x: position.x, y: position.y };
        continue;
      }
      delete pendingAckPositions.current[id];
      draggingIds.current.delete(id);
    }
    return protectedPositions;
  }, []);

  const previewMutationsDisabled = Boolean(instance && instance.allowed_effects?.includes('ledger:write') !== true);

  const markPositionsPreviewDisabled = useCallback((
    positions: Record<string, { x: number; y: number }>,
  ) => {
    for (const [id, position] of Object.entries(positions)) {
      pendingAckPositions.current[id] = {
        ...position,
        savedAt: null,
        expiresAt: Number.POSITIVE_INFINITY,
        previewDisabled: true,
      };
      draggingIds.current.delete(id);
    }
  }, []);

  const reconcileModel = useCallback(
    (model: SpaceCanvasModel) => {
      const protectedPositions = protectedPositionsForIncoming(model.occurrences);
      setItems(model.items);
      setOccurrences((prev) =>
        reconcileOccurrences(model.occurrences, draggingIds.current, prev, protectedPositions),
      );
      setEdges((prev) => reconcileEdges(model.edges ?? [], editingEdgeIds.current, prev));
    },
    [protectedPositionsForIncoming],
  );

  useEffect(() => {
    if (model) reconcileModel(model);
  }, [model, reconcileModel]);

  // --- flush the debounced batch write ---
  const flushPending = useCallback(async () => {
    const positions = pendingPositions.current;
    const entries = buildBatchEntries(positions);
    if (entries.length === 0 || !spaceId) return;
    pendingPositions.current = {};
    if (previewMutationsDisabled) {
      markPositionsPreviewDisabled(positions);
      setAutosave('disabled');
      return;
    }
    setAutosave('saving');
    try {
      const response = await batchWrite(spaceId, entries);
      markPositionsSaved(entries, response.occurrences);
      setOccurrences((prev) =>
        prev.map((occurrence) => {
          const entry = entries.find((candidate) => candidate.id === occurrence.id);
          return entry && typeof entry.x === 'number' && typeof entry.y === 'number'
            ? { ...occurrence, x: entry.x, y: entry.y }
            : occurrence;
        }),
      );
      // The short pending-ack guard still protects against stale refetches that
      // were already in flight; active drag marks can clear once writes land.
      for (const entry of entries) {
        if (entry.id) draggingIds.current.delete(entry.id);
      }
      setAutosave('saved');
    } catch (error) {
      if (isPreviewMutationRejected(error)) {
        markPositionsPreviewDisabled(positions);
        setAutosave('disabled');
        return;
      }
      // Graceful failure: surface the error state, re-queue the positions so a
      // later flush retries, and keep the optimistic positions on screen.
      pendingPositions.current = { ...positions, ...pendingPositions.current };
      setAutosave('error');
    }
  }, [spaceId, batchWrite, previewMutationsDisabled, markPositionsPreviewDisabled]);

  const scheduleFlush = useCallback(() => {
    if (debounceTimer.current !== null) {
      window.clearTimeout(debounceTimer.current);
    }
    debounceTimer.current = window.setTimeout(() => {
      debounceTimer.current = null;
      void flushPending();
    }, debounceMs);
  }, [flushPending, debounceMs]);

  // Legacy/unplaced occurrences are no longer exposed as a shelf. Seed them
  // onto the canvas and persist those positions through the normal batch path.
  useEffect(() => {
    if (shelf.length === 0) return;
    const positions = seedLayoutPositions(occurrencesRef.current, itemsById);
    const nextPositions: Record<string, { x: number; y: number }> = {};
    const fallbackBase = nextAddedItemPosition(placed);
    shelf.forEach((entry, index) => {
      nextPositions[entry.occurrence.id] = positions[entry.occurrence.id] ?? {
        x: fallbackBase.x + index * 260,
        y: fallbackBase.y,
      };
    });
    if (Object.keys(nextPositions).length === 0) {
      return;
    }
    setOccurrences((prev) =>
      prev.map((occurrence) => {
        const pos = nextPositions[occurrence.id];
        return pos ? { ...occurrence, x: pos.x, y: pos.y } : occurrence;
      }),
    );
    protectPositionsUntilAck(nextPositions);
    pendingPositions.current = { ...pendingPositions.current, ...nextPositions };
    scheduleFlush();
  }, [shelf, itemsById, placed, protectPositionsUntilAck, scheduleFlush]);

  // --- React Flow nodes (positions come from persisted occurrence x/y) ---
  const flowNodes = useMemo(
    () => canvasNodesToFlowNodes(placed, selection),
    [placed, selection],
  );

  const nodeTypes = useMemo(() => ({ spaceOccurrence: OccurrenceNode }), []);

  // React Flow edges from the authored `space_edges`, drawn only between nodes
  // that are both currently placed on the canvas.
  const placedIds = useMemo(() => new Set(placed.map((n) => n.occurrence.id)), [placed]);
  const flowEdges = useMemo(() => {
    const next = reconcileFlowEdges(edges, placedIds, selectedEdgeId, flowEdgesRef.current);
    flowEdgesRef.current = next;
    return next;
  }, [edges, placedIds, selectedEdgeId]);
  const occurrencesById = useMemo(() => indexOccurrences(occurrences), [occurrences]);
  const edgeItemsById = useMemo(() => indexItemsById(items), [items]);
  const resolvedSelectedEdge = useMemo<ResolvedSpaceEdge | null>(() => {
    const edge = selectedEdgeId ? edges.find((candidate) => candidate.id === selectedEdgeId) : null;
    return edge ? resolveEdge(edge, occurrencesById, edgeItemsById) : null;
  }, [selectedEdgeId, edges, occurrencesById, edgeItemsById]);

  const onNodeDragStart = useCallback((id: string) => {
    draggingIds.current.add(id);
  }, []);

  const onNodeDragStop = useCallback(
    (id: string, position: { x: number; y: number }) => {
      const nextPosition = { [id]: position };
      protectPositionsUntilAck(nextPosition);
      setOccurrences((prev) => applyOptimisticPosition(prev, id, position.x, position.y));
      pendingPositions.current = { ...pendingPositions.current, ...nextPosition };
      scheduleFlush();
    },
    [protectPositionsUntilAck, scheduleFlush],
  );

  const onNodeSelectionChange = useCallback((id: string, selected: boolean) => {
    setSelection((prev) => {
      const next = new Set(prev);
      if (selected) next.add(id);
      else next.delete(id);
      return next;
    });
    if (selected) setSelectedEdgeId(null);
  }, []);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    for (const change of changes) {
      if (change.type !== 'select') continue;
      if (change.selected) {
        setSelectedEdgeId(change.id);
        setSelection(new Set());
      } else {
        setSelectedEdgeId((current) => (current === change.id ? null : current));
      }
    }
  }, []);

  // --- onConnect: dragging from one node to another creates an authored edge ---
  // React Flow node ids ARE occurrence ids, and `space_edge.source`/`.target`
  // are occurrence ids too, so the connection maps directly. The edge is created
  // with an empty label (editable later in the Canvas inspector); we add it
  // optimistically so the line appears immediately, then let SSE/reload reconcile
  // the canonical edge (which carries the server id) without duplicating it.
  const onConnect = useCallback(
    (connection: Connection) => {
      if (!spaceId) return;
      const request = connectionToEdgeRequest(connection);
      if (!request) return;
      void createEdge(spaceId, request)
        .then((created) => {
          // Replace any optimistic placeholder for this source/target with the
          // canonical edge, and de-dupe in case an SSE echo already added it.
          setEdges((prev) => {
            if (prev.some((e) => e.id === created.id)) return prev;
            return [...prev, created];
          });
        })
        .catch(() => {
          // Swallow: a failed drag simply leaves the canvas unchanged.
        });
    },
    [spaceId, createEdge],
  );

  const reportEdgeError = useCallback((message: string) => {
    setEdgeStatus('error');
    setEdgeStatusMessage(message);
  }, []);

  const handleEdgeLabelEdit = useCallback(
    async (edgeId: string, label: string) => {
      if (!spaceId) return;
      const trimmed = label.trim();
      const nextLabel = trimmed ? trimmed : null;
      const previous = edges;
      editingEdgeIds.current.add(edgeId);
      setEdges((prev) => prev.map((edge) => (edge.id === edgeId ? { ...edge, label: nextLabel } : edge)));
      setEdgeStatus('saving');
      setEdgeStatusMessage('');
      const body: UpdateSpaceEdgeRequest = { label: nextLabel };
      try {
        const edge = await updateEdge(spaceId, edgeId, body);
        setEdges((prev) => prev.map((candidate) => (candidate.id === edgeId ? edge : candidate)));
        setEdgeStatus('saved');
        setEdgeStatusMessage('');
      } catch (error) {
        setEdges(previous);
        reportEdgeError(error instanceof Error ? error.message : 'Failed to update edge label');
      } finally {
        editingEdgeIds.current.delete(edgeId);
      }
    },
    [spaceId, edges, updateEdge, reportEdgeError],
  );

  const handleEdgeDelete = useCallback(
    async (edgeId: string) => {
      if (!spaceId) return;
      const previous = edges;
      setEdges((prev) => prev.filter((edge) => edge.id !== edgeId));
      setSelectedEdgeId((current) => (current === edgeId ? null : current));
      setEdgeStatus('saving');
      setEdgeStatusMessage('');
      try {
        await removeEdge(spaceId, edgeId);
        setEdgeStatus('saved');
        setEdgeStatusMessage('Edge deleted');
      } catch (error) {
        setEdges(previous);
        setSelectedEdgeId(edgeId);
        reportEdgeError(error instanceof Error ? error.message : 'Failed to delete edge');
      }
    },
    [spaceId, edges, removeEdge, reportEdgeError],
  );

  const handlePromoteEdge = useCallback(
    async (resolved: ResolvedSpaceEdge) => {
      const verdict = evaluatePromotion(resolved);
      if (!verdict.promotable) {
        reportEdgeError(verdict.reason);
        return;
      }
      const linkType = promoteLinkType[resolved.edge.id] ?? verdict.suggestedLinkType;
      setEdgeStatus('saving');
      setEdgeStatusMessage('');
      try {
        await promote({
          sourceRef: verdict.sourceRef,
          targetRef: verdict.targetRef,
          linkType,
          note: resolved.edge.label ?? null,
        });
        setEdgeStatus('saved');
        setEdgeStatusMessage(`Promoted as ${linkType}`);
      } catch (error) {
        reportEdgeError(error instanceof Error ? error.message : 'Failed to promote edge');
      }
    },
    [promoteLinkType, promote, reportEdgeError],
  );

  // --- explicit user re-layout (seed/initial-arrange/re-layout-selected) ---
  const handleArrange = useCallback(
    (scope: 'all' | 'selected') => {
      const targets =
        scope === 'selected' && selection.size > 0
          ? occurrencesRef.current.filter((o) => selection.has(o.id) && isCanvasOccurrence(o))
          : occurrencesRef.current.filter(isCanvasOccurrence);
      if (targets.length === 0) return;
      const positions = seedLayoutPositions(targets, indexItems(items));
      // Optimistic local move for all seeded nodes...
      setOccurrences((prev) =>
        prev.map((o) => (positions[o.id] ? { ...o, x: positions[o.id].x, y: positions[o.id].y } : o)),
      );
      protectPositionsUntilAck(positions);
      // ...and persist them through the same debounced batch path.
      for (const [id, pos] of Object.entries(positions)) {
        pendingPositions.current[id] = pos;
      }
      scheduleFlush();
    },
    [selection, items, protectPositionsUntilAck, scheduleFlush],
  );

  // --- "Add items" picker: immediately place a canvas occurrence per new item ---
  const afterAddItem = useCallback(
    async (item: SpaceItem) => {
      if (!spaceId) return;
      if (occurrencesRef.current.some((o) => o.renderer === 'canvas' && o.item_id === item.id)) {
        return;
      }
      const position = nextAddedItemPosition(partitionOccurrences(occurrencesRef.current, indexItems(items)).placed);
      const created = await createOccurrence(spaceId, {
        item_id: item.id,
        renderer: 'canvas',
        x: position.x,
        y: position.y,
      });
      setItems((prev) => (prev.some((candidate) => candidate.id === item.id) ? prev : [...prev, item]));
      setOccurrences((prev) => [...prev, created]);
    },
    [spaceId, createOccurrence, items],
  );

  const isItemOnCanvas = useCallback(
    (item: SpaceItem) =>
      occurrencesRef.current.some((occurrence) => occurrence.renderer === 'canvas' && occurrence.item_id === item.id),
    [],
  );

  const beginInspectorResize = useCallback((
    event: JSX.TargetedMouseEvent<HTMLDivElement> | JSX.TargetedPointerEvent<HTMLDivElement>,
  ) => {
    event.preventDefault();
    if (inspectorResizeRef.current) return;
    const inspector = event.currentTarget.parentElement as HTMLElement | null;
    if (!inspector) return;
    inspectorResizeRef.current = {
      startY: event.clientY,
      startHeight: inspector.getBoundingClientRect().height,
    };
    const previousCursor = document.documentElement.style.cursor;
    const previousUserSelect = document.documentElement.style.userSelect;
    document.documentElement.style.cursor = 'row-resize';
    document.documentElement.style.userSelect = 'none';
    const handlePointerMove = (moveEvent: PointerEvent) => {
      const origin = inspectorResizeRef.current;
      if (!origin) return;
      const bodyHeight = bodyRef.current?.getBoundingClientRect().height ?? window.innerHeight;
      const nextHeight = clampInspectorHeight(
        origin.startHeight + origin.startY - moveEvent.clientY,
        bodyHeight,
      );
      setInspectorHeight(nextHeight);
    };
    const stopResize = () => {
      inspectorResizeRef.current = null;
      document.documentElement.style.cursor = previousCursor;
      document.documentElement.style.userSelect = previousUserSelect;
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', stopResize);
      window.removeEventListener('pointercancel', stopResize);
    };
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', stopResize);
    window.addEventListener('pointercancel', stopResize);
  }, []);

  return (
    <div className="space-canvas" data-testid="space-canvas">
      <div className="space-canvas__toolbar" role="toolbar" aria-label="Canvas actions">
        <div className="space-canvas__add-items">
          <button
            type="button"
            className="space-canvas__btn space-canvas__btn--primary"
            onClick={() => setPickerMode((mode) => (mode === 'items' ? null : 'items'))}
            aria-haspopup="dialog"
            aria-expanded={pickerMode === 'items'}
            data-testid="space-canvas-add-items"
          >
            <Icon name="add" /> Add items
          </button>
          <button
            type="button"
            className="space-canvas__btn"
            onClick={() => setPickerMode((mode) => (mode === 'spaces' ? null : 'spaces'))}
            aria-haspopup="dialog"
            aria-expanded={pickerMode === 'spaces'}
            data-testid="space-canvas-link-space"
          >
            Link Space
          </button>
          {pickerMode && spaceId ? (
            <div className="space-canvas__picker-anchor">
              <SpaceItemPicker
                spaceId={spaceId}
                projectId={projectId}
                existingItems={items}
                existingItemRefTypes={
                  pickerMode === 'spaces'
                    ? ['space']
                    : ['issue', 'comment', 'artifact', 'external_ref']
                }
                includeIssues={pickerMode === 'items'}
                includeArtifacts={pickerMode === 'items'}
                includeSpaces={pickerMode === 'spaces'}
                title={pickerMode === 'spaces' ? 'Link Space' : 'Add items'}
                searchPlaceholder={
                  pickerMode === 'spaces'
                    ? 'Search Spaces by title or project...'
                    : 'Search issues and artifacts by title...'
                }
                emptyLabel={pickerMode === 'spaces' ? 'No Spaces available.' : 'No items available.'}
                addButtonLabel={pickerMode === 'spaces' ? 'Link' : 'Add'}
                isItemInView={isItemOnCanvas}
                alreadyInViewLabel="Already on canvas"
                afterAdd={afterAddItem}
                onClose={() => setPickerMode(null)}
              />
            </div>
          ) : null}
        </div>
        <div className="space-canvas__overflow">
          <button
            ref={actionsTriggerRef}
            type="button"
            className="space-canvas__icon-btn"
            aria-label="Canvas actions"
            aria-haspopup="menu"
            aria-expanded={actionsMenuOpen}
            title="Canvas actions"
            onClick={() => setActionsMenuOpen((open) => !open)}
            data-testid="space-canvas-actions-menu"
          >
            ...
          </button>
          {actionsMenuOpen && (
            <div
              ref={actionsMenuRef}
              className="space-canvas__overflow-menu app-anchored-menu"
              role="menu"
              popover="manual"
              style={actionsMenuStyle}
            >
              <button
                type="button"
                role="menuitem"
                className="space-canvas__overflow-item"
                onClick={() => {
                  handleArrange('all');
                  setActionsMenuOpen(false);
                }}
                data-testid="space-canvas-arrange-all"
              >
                Arrange all
              </button>
              <button
                type="button"
                role="menuitem"
                className="space-canvas__overflow-item"
                onClick={() => {
                  handleArrange('selected');
                  setActionsMenuOpen(false);
                }}
                disabled={selection.size === 0}
                data-testid="space-canvas-arrange-selected"
              >
                Re-layout selected
              </button>
            </div>
          )}
        </div>
        <span className="space-canvas__toolbar-spacer" />
      </div>
      {autosave === 'error' && (
        <DetailPaneNotice severity="error" density="compact" title="Canvas positions were not saved">
          Your last change remains on screen; retry by moving the item again.
        </DetailPaneNotice>
      )}
      {edgeStatus === 'error' && (
        <DetailPaneNotice severity="error" density="compact" title="Edge update failed">{edgeStatusMessage}</DetailPaneNotice>
      )}
      <div className="space-canvas__body" ref={bodyRef}>
        <div className="space-canvas__flow" data-testid="space-canvas-flow">
          {placed.length === 0 ? (
            <div className="space-canvas__empty" data-testid="space-canvas-empty">
              No canvas items yet.
            </div>
          ) : (
            <SpaceCanvasFlowSurface
              nodes={flowNodes}
              edges={flowEdges}
              nodeTypes={nodeTypes}
              onNodeDragStart={onNodeDragStart}
              onNodeDragStop={onNodeDragStop}
              onNodeSelectionChange={onNodeSelectionChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
            />
          )}
          {autosave !== 'idle' && autosave !== 'saved' ? (
            <span
              className="space-canvas__autosave"
              data-status={autosave}
              data-testid="space-canvas-autosave"
              role="status"
              aria-live="polite"
            >
              <span className="space-canvas__autosave-dot" aria-hidden="true" />
              {autosaveLabel(autosave)}
            </span>
          ) : null}
        </div>
        <CanvasSelectionInspector
          selectedNodeIds={selection}
          selectedEdge={resolvedSelectedEdge}
          placed={placed}
          height={inspectorHeight}
          edgeStatus={edgeStatus}
          edgeStatusMessage={edgeStatusMessage}
          promoteLinkType={promoteLinkType}
          onPromoteLinkTypeChange={setPromoteLinkType}
          onResizeStart={beginInspectorResize}
          onEdgeLabelEdit={handleEdgeLabelEdit}
          onEdgeDelete={handleEdgeDelete}
          onPromoteEdge={handlePromoteEdge}
        />
      </div>
    </div>
  );
}

type SpaceCanvasFlowSurfaceProps = {
  nodes: SpaceFlowNode[];
  edges: FlowEdge[];
  nodeTypes: Record<string, typeof OccurrenceNode>;
  onNodeDragStart: (id: string) => void;
  onNodeDragStop: (id: string, position: { x: number; y: number }) => void;
  onNodeSelectionChange: (id: string, selected: boolean) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;
};

type FlowInitInstance = {
  fitView: (options?: { padding?: number; duration?: number }) => Promise<boolean> | boolean;
};

function sameFlowNode(left: SpaceFlowNode, right: SpaceFlowNode): boolean {
  return (
    left.id === right.id &&
    left.type === right.type &&
    left.selected === right.selected &&
    left.dragging === right.dragging &&
    left.resizing === right.resizing &&
    left.width === right.width &&
    left.height === right.height &&
    left.initialWidth === right.initialWidth &&
    left.initialHeight === right.initialHeight &&
    left.measured?.width === right.measured?.width &&
    left.measured?.height === right.measured?.height &&
    left.position.x === right.position.x &&
    left.position.y === right.position.y &&
    left.data.label === right.data.label &&
    left.data.kind === right.data.kind &&
    left.data.linkedSpace?.id === right.data.linkedSpace?.id &&
    left.data.linkedSpace?.primaryType === right.data.linkedSpace?.primaryType &&
    left.data.linkedSpace?.primaryLabel === right.data.linkedSpace?.primaryLabel &&
    left.data.linkedSpace?.projectLabel === right.data.linkedSpace?.projectLabel &&
    left.data.linkedSpace?.href === right.data.linkedSpace?.href
  );
}

function mergeCanonicalFlowNode(
  previous: SpaceFlowNode,
  canonical: SpaceFlowNode,
  preservePosition: boolean,
): SpaceFlowNode {
  return {
    ...previous,
    ...canonical,
    position: preservePosition ? previous.position : canonical.position,
    dragging: previous.dragging,
    resizing: previous.resizing,
    measured: previous.measured,
    width: previous.width,
    height: previous.height,
    initialWidth: previous.initialWidth,
    initialHeight: previous.initialHeight,
  };
}

function reconcileFlowNodeState(
  previous: SpaceFlowNode[],
  canonical: SpaceFlowNode[],
  activeDragIds: ReadonlySet<string>,
): SpaceFlowNode[] {
  const previousById = new Map(previous.map((node) => [node.id, node]));
  let changed = previous.length !== canonical.length;
  const next = canonical.map((canonicalNode) => {
    const previousNode = previousById.get(canonicalNode.id);
    if (!previousNode) {
      changed = true;
      return canonicalNode;
    }
    const reconciledNode = mergeCanonicalFlowNode(
      previousNode,
      canonicalNode,
      activeDragIds.has(canonicalNode.id),
    );
    if (sameFlowNode(previousNode, reconciledNode)) {
      return previousNode;
    }
    changed = true;
    return reconciledNode;
  });
  const canonicalIds = new Set(canonical.map((node) => node.id));
  for (const previousNode of previous) {
    if (canonicalIds.has(previousNode.id) || !activeDragIds.has(previousNode.id)) continue;
    next.push(previousNode);
    changed = true;
  }
  return changed ? next : previous;
}

export function SpaceCanvasFlowSurface({
  nodes: canonicalNodes,
  edges,
  nodeTypes,
  onNodeDragStart,
  onNodeDragStop,
  onNodeSelectionChange,
  onEdgesChange,
  onConnect,
}: SpaceCanvasFlowSurfaceProps): JSX.Element {
  const [nodes, setNodes] = useState<SpaceFlowNode[]>(() => canonicalNodes);
  const activeDragIds = useRef<Set<string>>(new Set());
  const didInitialFitView = useRef(false);

  useEffect(() => {
    setNodes((previous) => {
      const next = reconcileFlowNodeState(previous, canonicalNodes, activeDragIds.current);
      const nextById = new Map(next.map((node) => [node.id, node]));
      for (const canonicalNode of canonicalNodes) {
        const localNode = nextById.get(canonicalNode.id);
        if (
          localNode &&
          localNode.position.x === canonicalNode.position.x &&
          localNode.position.y === canonicalNode.position.y
        ) {
          activeDragIds.current.delete(canonicalNode.id);
        }
      }
      return next;
    });
  }, [canonicalNodes]);

  const onNodesChange = useCallback(
    (changes: NodeChange<SpaceFlowNode>[]) => {
      setNodes((previous) => applyLocalNodeChanges(previous, changes));
      for (const change of changes) {
        if (change.type === 'position' && change.position) {
          if (change.dragging === false) {
            onNodeDragStop(change.id, { x: change.position.x, y: change.position.y });
          } else if (!activeDragIds.current.has(change.id)) {
            activeDragIds.current.add(change.id);
            onNodeDragStart(change.id);
          }
        }
        if (change.type === 'select') {
          onNodeSelectionChange(change.id, Boolean(change.selected));
        }
      }
    },
    [onNodeDragStart, onNodeDragStop, onNodeSelectionChange],
  );

  const onInit = useCallback((instance: FlowInitInstance) => {
    if (didInitialFitView.current) return;
    didInitialFitView.current = true;
    void instance.fitView({ padding: 0.16, duration: 0 });
  }, []);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      proOptions={{ hideAttribution: true }}
      onInit={onInit}
      minZoom={0.2}
      maxZoom={1.8}
      nodesDraggable
      nodesConnectable
      elementsSelectable
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
    >
      <Background gap={18} />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}

type CanvasSelectionInspectorProps = {
  selectedNodeIds: ReadonlySet<string>;
  selectedEdge: ResolvedSpaceEdge | null;
  placed: CanvasNode[];
  height: number | null;
  edgeStatus: AutosaveStatus;
  edgeStatusMessage: string;
  promoteLinkType: Record<string, LedgerLinkType>;
  onPromoteLinkTypeChange: (next: Record<string, LedgerLinkType>) => void;
  onResizeStart: (
    event: JSX.TargetedMouseEvent<HTMLDivElement> | JSX.TargetedPointerEvent<HTMLDivElement>,
  ) => void;
  onEdgeLabelEdit: (edgeId: string, label: string) => Promise<void>;
  onEdgeDelete: (edgeId: string) => Promise<void>;
  onPromoteEdge: (edge: ResolvedSpaceEdge) => Promise<void>;
};

function CanvasSelectionInspector({
  selectedNodeIds,
  selectedEdge,
  placed,
  height,
  edgeStatus,
  edgeStatusMessage,
  promoteLinkType,
  onPromoteLinkTypeChange,
  onResizeStart,
  onEdgeLabelEdit,
  onEdgeDelete,
  onPromoteEdge,
}: CanvasSelectionInspectorProps): JSX.Element {
  const selectedNodes = placed.filter((node) => selectedNodeIds.has(node.occurrence.id));
  const style = height !== null ? ({ flexBasis: `${height}px` } as JSX.CSSProperties) : undefined;
  return (
    <aside
      className="space-canvas__inspector"
      data-testid="space-canvas-inspector"
      data-placement="bottom"
      aria-label="Selection inspector"
      style={style}
    >
      <div
        className="space-canvas__inspector-resize"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize selection inspector"
        onMouseDown={onResizeStart}
        onPointerDown={onResizeStart}
        data-testid="space-canvas-inspector-resize"
      />
      {selectedEdge ? (
        <CanvasEdgeInspector
          resolved={selectedEdge}
          status={edgeStatus}
          statusMessage={edgeStatusMessage}
          promoteLinkType={promoteLinkType}
          onPromoteLinkTypeChange={onPromoteLinkTypeChange}
          onLabelEdit={onEdgeLabelEdit}
          onDelete={onEdgeDelete}
          onPromote={onPromoteEdge}
        />
      ) : selectedNodes.length === 1 ? (
        <CanvasNodeInspector node={selectedNodes[0]} />
      ) : selectedNodes.length > 1 ? (
        <div className="space-canvas__inspector-empty">
          <strong>{selectedNodes.length} selected</strong>
          <span>Use the actions menu to re-layout this selection.</span>
        </div>
      ) : (
        <div className="space-canvas__inspector-empty">
          <strong>Selection</strong>
          <span>Select a node or edge to inspect it.</span>
        </div>
      )}
    </aside>
  );
}

function CanvasEdgeInspector({
  resolved,
  status,
  statusMessage,
  promoteLinkType,
  onPromoteLinkTypeChange,
  onLabelEdit,
  onDelete,
  onPromote,
}: {
  resolved: ResolvedSpaceEdge;
  status: AutosaveStatus;
  statusMessage: string;
  promoteLinkType: Record<string, LedgerLinkType>;
  onPromoteLinkTypeChange: (next: Record<string, LedgerLinkType>) => void;
  onLabelEdit: (edgeId: string, label: string) => Promise<void>;
  onDelete: (edgeId: string) => Promise<void>;
  onPromote: (edge: ResolvedSpaceEdge) => Promise<void>;
}): JSX.Element {
  const verdict = evaluatePromotion(resolved);
  const linkType = promoteLinkType[resolved.edge.id] ?? (verdict.promotable ? verdict.suggestedLinkType : DEFAULT_PROMOTE_LINK_TYPE);
  return (
    <div className="space-canvas__inspector-section" data-testid="space-canvas-edge-inspector">
      <header className="space-canvas__inspector-header">
        <span>Edge</span>
        {status !== 'idle' && status !== 'saved' ? (
          <span className="space-canvas__inspector-status" data-status={status}>
            {statusMessage || edgeStatusLabel(status)}
          </span>
        ) : null}
      </header>
      <div className="space-canvas__edge-endpoints">
        <strong>{resolved.source.label}</strong>
        <span aria-hidden="true">-&gt;</span>
        <strong>{resolved.target.label}</strong>
      </div>
      <label className="space-canvas__field">
        <span>Label</span>
        <input
          className="space-canvas__input"
          data-testid="space-canvas-edge-label-input"
          type="text"
          defaultValue={resolved.edge.label ?? ''}
          placeholder="Add a label..."
          onBlur={(event) => void onLabelEdit(resolved.edge.id, (event.target as HTMLInputElement).value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              (event.target as HTMLInputElement).blur();
            }
          }}
        />
      </label>
      <div className="space-canvas__edge-actions">
        {verdict.promotable ? (
          <>
            <label className="space-canvas__field">
              <span>Ledger link</span>
              <NativeSelect
                className="space-canvas__input"
                data-testid="space-canvas-edge-link-type"
                value={linkType}
                onChange={(event) =>
                  onPromoteLinkTypeChange({
                    ...promoteLinkType,
                    [resolved.edge.id]: (event.target as HTMLSelectElement).value as LedgerLinkType,
                  })
                }
              >
                {LEDGER_LINK_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <button
              type="button"
              className="space-canvas__btn"
              data-testid="space-canvas-edge-promote-btn"
              onClick={() => void onPromote(resolved)}
            >
              Promote to ledger
            </button>
          </>
        ) : (
          <span className="space-canvas__not-promotable" data-testid="space-canvas-edge-not-promotable">
            {verdict.reason}
          </span>
        )}
        <button
          type="button"
          className="space-canvas__btn space-canvas__btn--danger"
          data-testid="space-canvas-edge-delete-btn"
          onClick={() => void onDelete(resolved.edge.id)}
        >
          Delete edge
        </button>
      </div>
    </div>
  );
}

const DEFAULT_PROMOTE_LINK_TYPE: LedgerLinkType = 'references';

function CanvasNodeInspector({ node }: { node: CanvasNode }): JSX.Element {
  const item = node.item;
  const [referenceError, setReferenceError] = useState<string | null>(null);
  useEffect(() => setReferenceError(null), [item?.ref_id, item?.ref_uri, item?.ref_type]);
  return (
    <div className="space-canvas__inspector-section" data-testid="space-canvas-node-inspector">
      <header className="space-canvas__inspector-header">
        <span>{item?.ref_type ?? 'occurrence'}</span>
      </header>
      {referenceError && <DetailPaneNotice severity="error" density="compact" title="Reference unavailable">{referenceError}</DetailPaneNotice>}
      <div className="space-canvas__inspector-content">
      {!item ? (
        <OccurrenceSummary node={node} />
      ) : item.ref_type === 'issue' ? (
        <IssueReferenceDetail issueRef={item.ref_id} onErrorChange={setReferenceError} />
      ) : item.ref_type === 'artifact' ? (
        <ArtifactReferenceDetail artifactRef={item.ref_uri ?? item.ref_id} onErrorChange={setReferenceError} />
      ) : (
        <OccurrenceSummary node={node} />
      )}
      </div>
    </div>
  );
}

function OccurrenceSummary({ node }: { node: CanvasNode }): JSX.Element {
  return (
    <div className="space-canvas__occurrence-summary">
      <strong>{occurrenceLabel(node.occurrence, node.item)}</strong>
      <dl>
        <div>
          <dt>Ref</dt>
          <dd>{node.item?.ref_id ?? node.occurrence.item_id ?? 'Unbound'}</dd>
        </div>
        <div>
          <dt>Position</dt>
          <dd>{Math.round(node.x)}, {Math.round(node.y)}</dd>
        </div>
      </dl>
    </div>
  );
}

function autosaveLabel(status: Exclude<AutosaveStatus, 'idle' | 'saved'>): string {
  switch (status) {
    case 'saving':
      return 'Saving…';
    case 'error':
      return 'Save failed - will retry';
    case 'disabled':
      return 'Saving disabled';
  }
}

function edgeStatusLabel(status: Exclude<AutosaveStatus, 'idle' | 'saved'>): string {
  switch (status) {
    case 'saving':
      return 'Saving...';
    case 'error':
      return 'Error';
    case 'disabled':
      return 'Disabled';
  }
}

function isPreviewMutationRejected(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('instance_mutation_forbidden');
}

/** React Flow custom node for a Space occurrence. */
function OccurrenceNode(props: {
  data: SpaceFlowNodeData;
  selected?: boolean;
}): JSX.Element {
  const linkedSpace = props.data.linkedSpace;
  return (
    <div
      className={`space-canvas__node${linkedSpace ? ' space-canvas__node--linked-space' : ''}`}
      data-selected={props.selected ? 'true' : 'false'}
      data-ref-type={linkedSpace ? 'space' : props.data.kind}
      data-testid="space-canvas-node"
    >
      {/* Target handle (left): the drop side of a drag-to-connect gesture. */}
      <Handle
        type="target"
        position={Position.Left}
        className="space-canvas__handle space-canvas__handle--target"
        data-testid="space-canvas-handle-target"
      />
      <div className="space-canvas__node-kind">
        {linkedSpace ? (
          <>
            <span className="space-canvas__node-space-type" data-kind={linkedSpace.primaryType}>
              <SpaceTypeIndicator renderer={linkedSpace.primaryType} showLabel />
            </span>
            {linkedSpace.projectLabel ? (
              <span className="space-canvas__node-project">{linkedSpace.projectLabel}</span>
            ) : null}
          </>
        ) : (
          props.data.kind
        )}
      </div>
      <div className="space-canvas__node-title">{props.data.label}</div>
      {linkedSpace ? (
        <a
          className="space-canvas__node-open"
          href={linkedSpace.href}
          data-testid="space-canvas-linked-space-open"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          Open
        </a>
      ) : null}
      {/* Source handle (right): drag from here to another node to author an edge. */}
      <Handle
        type="source"
        position={Position.Right}
        className="space-canvas__handle space-canvas__handle--source"
        data-testid="space-canvas-handle-source"
      />
    </div>
  );
}

export default SpaceCanvas;
