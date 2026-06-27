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
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Connection,
  type EdgeChange,
  type Edge as FlowEdge,
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
import type { GraphEdge, GraphNode } from '../../types/graph';
import { createSSEClient, type SSEClient, type SSEPayload } from '../../sse-client';
import type { SpaceRendererMountProps } from './SpacesViewShell';
import { SpaceItemPicker } from './SpaceItemPicker';
import { ArtifactReferenceDetail, IssueReferenceDetail } from './SpaceReferenceDetailPanel';
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

// ---------------------------------------------------------------------------
// Pure model helpers (exported for unit tests). These carry the load-bearing
// rules — shelf partition, seed-only layout, SSE reconciliation that preserves
// viewport/selection — so they are testable without mounting React Flow.
// ---------------------------------------------------------------------------

/** Autosave indicator state for the debounced batch write. */
export type AutosaveStatus = 'idle' | 'saving' | 'saved' | 'error';

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

/** A legacy unplaced occurrence entry. New Canvas adds place immediately. */
export type ShelfEntry = {
  occurrence: SpaceOccurrence;
  item: SpaceItem | null;
};

export type CanvasPartition = {
  placed: CanvasNode[];
  shelf: ShelfEntry[];
};

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

function occurrenceKind(occurrence: SpaceOccurrence, item: SpaceItem | null): string {
  return item?.ref_type ?? 'occurrence';
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

/**
 * Map occurrences to `GraphNode`s so `layoutGraph()` (the existing structured
 * layout) can seed positions. Edges are mapped from `parent_id` links only so
 * the structural hierarchy layout has something to arrange.
 */
export function occurrencesToGraph(
  occurrences: SpaceOccurrence[],
  itemsById: Record<string, SpaceItem>,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = occurrences.map((occurrence) => {
    const item = occurrence.item_id ? (itemsById[occurrence.item_id] ?? null) : null;
    return {
      id: occurrence.id,
      type: (item?.ref_type ?? 'issue') as GraphNode['type'],
      label: occurrenceLabel(occurrence, item),
    };
  });
  const present = new Set(occurrences.map((o) => o.id));
  const edges: GraphEdge[] = [];
  for (const occurrence of occurrences) {
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
): SpaceOccurrence[] {
  const previousById = new Map(previous.map((o) => [o.id, o]));
  return incoming.map((next) => {
    if (draggingIds.has(next.id)) {
      // Keep the local in-flight value for nodes the user is actively moving.
      return previousById.get(next.id) ?? next;
    }
    return next;
  });
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

// ---------------------------------------------------------------------------
// Data source: this lane consumes the FROZEN C2/C3 surfaces. The C2 routes do
// not (yet) expose a GET fact-packet route — `loadSpaceFactPacket` is exported
// from `src/routes/spaces.ts` but unwired — so the canvas takes its initial
// view-model and its SSE-refetch through an injected loader. The default loader
// is a no-op placeholder that returns the seeded model the host passes in; a
// host that has a read endpoint can inject a real fetcher. Drag persistence and
// re-layout go through the frozen `batchWriteSpaceOccurrences` client helper.
// ---------------------------------------------------------------------------

export type SpaceCanvasModel = {
  occurrences: SpaceOccurrence[];
  items: SpaceItem[];
  /**
   * Authored `space_edges` to render as lines on the canvas. Optional so the
   * frozen `{ occurrences, items }` callers stay valid; defaults to no edges.
   */
  edges?: SpaceEdge[];
};

export type SpaceCanvasLoader = (spaceId: string) => Promise<SpaceCanvasModel>;

export type SpaceCanvasProps = SpaceRendererMountProps & {
  /**
   * Optional initial model (occurrences + items). When the host already holds a
   * seeded fact packet (e.g. from `seedSpace`) it passes it here so the canvas
   * renders without a read round-trip.
   */
  initialModel?: SpaceCanvasModel;
  /**
   * Loader used for the initial fetch (when no `initialModel`) and for SSE
   * reconciliation refetches. Injected so the canvas stays decoupled from the
   * read surface and is unit-testable.
   */
  loadModel?: SpaceCanvasLoader;
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
  /** SSE client factory (injected for tests); defaults to the shared client. */
  createSse?: () => SSEClient;
  /** Debounce window (ms) for the batched drag-position write. */
  debounceMs?: number;
};

const DEFAULT_DEBOUNCE_MS = 400;
const OCCURRENCE_MOVED_EVENT = 'space:occurrence:moved';
const EDGE_EVENTS = ['space:edge:created', 'space:edge:updated', 'space:edge:removed'] as const;
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
    initialModel,
    loadModel,
    batchWrite = batchWriteSpaceOccurrences,
    createEdge = createSpaceEdge,
    updateEdge = updateSpaceEdge,
    removeEdge = deleteSpaceEdge,
    promote = promoteEdgeToLedger,
    createOccurrence = createSpaceOccurrence,
    createSse = createSSEClient,
    debounceMs = DEFAULT_DEBOUNCE_MS,
  } = props;

  const [occurrences, setOccurrences] = useState<SpaceOccurrence[]>(
    () => initialModel?.occurrences ?? [],
  );
  const [items, setItems] = useState<SpaceItem[]>(() => initialModel?.items ?? []);
  // Authored `space_edges` rendered as lines on the canvas and edited through the
  // Canvas selection inspector.
  const [edges, setEdges] = useState<SpaceEdge[]>(() => initialModel?.edges ?? []);
  const [autosave, setAutosave] = useState<AutosaveStatus>('idle');
  const [edgeStatus, setEdgeStatus] = useState<AutosaveStatus>('idle');
  const [edgeStatusMessage, setEdgeStatusMessage] = useState('');
  // UI selection is ephemeral browser-local view state — never persisted, never
  // reset by SSE reconciliation.
  const [selection, setSelection] = useState<Set<string>>(() => new Set());
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [localPositions, setLocalPositions] = useState<Record<string, { x: number; y: number }>>({});
  const [promoteLinkType, setPromoteLinkType] = useState<Record<string, LedgerLinkType>>({});
  const [actionsMenuOpen, setActionsMenuOpen] = useState(false);
  // Whether the "Add items" picker popover is open (transient browser-local).
  const [pickerOpen, setPickerOpen] = useState(false);
  const [inspectorHeight, setInspectorHeight] = useState<number | null>(null);

  // Refs that must not trigger re-render or re-subscribe.
  const draggingIds = useRef<Set<string>>(new Set());
  const pendingPositions = useRef<Record<string, { x: number; y: number }>>({});
  const debounceTimer = useRef<number | null>(null);
  const occurrencesRef = useRef<SpaceOccurrence[]>(occurrences);
  const editingEdgeIds = useRef<Set<string>>(new Set());
  const bodyRef = useRef<HTMLDivElement>(null);
  const inspectorResizeRef = useRef<{ startY: number; startHeight: number } | null>(null);
  occurrencesRef.current = occurrences;

  const itemsById = useMemo(() => indexItems(items), [items]);
  const { placed, shelf } = useMemo(
    () => partitionOccurrences(occurrences, itemsById),
    [occurrences, itemsById],
  );

  // --- initial load (only when no initialModel was provided) ---
  useEffect(() => {
    if (initialModel || !spaceId || !loadModel) return;
    let cancelled = false;
    void loadModel(spaceId).then((model) => {
      if (cancelled) return;
      setOccurrences(model.occurrences);
      setItems(model.items);
      setEdges(model.edges ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [spaceId, initialModel, loadModel]);

  // --- flush the debounced batch write ---
  const flushPending = useCallback(async () => {
    const positions = pendingPositions.current;
    const entries = buildBatchEntries(positions);
    if (entries.length === 0 || !spaceId) return;
    pendingPositions.current = {};
    setAutosave('saving');
    try {
      await batchWrite(spaceId, entries);
      setOccurrences((prev) =>
        prev.map((occurrence) => {
          const entry = entries.find((candidate) => candidate.id === occurrence.id);
          return entry && typeof entry.x === 'number' && typeof entry.y === 'number'
            ? { ...occurrence, x: entry.x, y: entry.y }
            : occurrence;
        }),
      );
      setLocalPositions((prev) => {
        const next = { ...prev };
        for (const entry of entries) {
          if (entry.id) delete next[entry.id];
        }
        return next;
      });
      // Clear the dragging marks once their writes have landed.
      for (const entry of entries) {
        if (entry.id) draggingIds.current.delete(entry.id);
      }
      setAutosave('saved');
    } catch {
      // Graceful failure: surface the error state, re-queue the positions so a
      // later flush retries, and keep the optimistic local positions on screen.
      pendingPositions.current = { ...positions, ...pendingPositions.current };
      setAutosave('error');
    }
  }, [spaceId, batchWrite]);

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
    setLocalPositions((prev) => {
      const next = { ...prev };
      for (const id of Object.keys(nextPositions)) delete next[id];
      return next;
    });
    pendingPositions.current = { ...pendingPositions.current, ...nextPositions };
    scheduleFlush();
  }, [shelf, itemsById, placed, scheduleFlush]);

  // --- SSE reconciliation: refetch + reconcile WITHOUT touching viewport/sel ---
  // Subscribes to both occurrence moves AND edge events so drag-created or
  // external edge mutations reconcile onto the canvas. Reconciliation only
  // updates occurrence/edge data; it never resets selection or viewport
  // (Dataful-UX contract).
  useEffect(() => {
    if (!spaceId || !loadModel) return;
    const client = createSse();
    const reconcile = (payload: SSEPayload) => {
      const data = (payload.data ?? payload) as { space_id?: string };
      if (data?.space_id && data.space_id !== spaceId) return;
      void loadModel(spaceId).then((model) => {
        setItems(model.items);
        setOccurrences((prev) =>
          reconcileOccurrences(model.occurrences, draggingIds.current, prev),
        );
        setEdges((prev) => reconcileEdges(model.edges ?? [], editingEdgeIds.current, prev));
        // NOTE: selection and viewport state are intentionally untouched here.
      });
    };
    const unsubscribers = [OCCURRENCE_MOVED_EVENT, ...EDGE_EVENTS].map((event) =>
      client.on(event, reconcile),
    );
    client.connect();
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
      client.close();
    };
  }, [spaceId, loadModel, createSse]);

  // --- React Flow nodes (positions come from persisted occurrence x/y) ---
  const flowNodes = useMemo(
    () =>
      placed.map((node) => ({
        id: node.occurrence.id,
        position: localPositions[node.occurrence.id] ?? { x: node.x, y: node.y },
        data: {
          label: occurrenceLabel(node.occurrence, node.item),
          kind: occurrenceKind(node.occurrence, node.item),
        },
        selected: selection.has(node.occurrence.id),
        type: 'spaceOccurrence',
      })),
    [placed, localPositions, selection],
  );

  const nodeTypes = useMemo(() => ({ spaceOccurrence: OccurrenceNode }), []);

  // React Flow edges from the authored `space_edges`, drawn only between nodes
  // that are both currently placed on the canvas.
  const placedIds = useMemo(() => new Set(placed.map((n) => n.occurrence.id)), [placed]);
  const flowEdges = useMemo(
    () => edgesToFlowEdges(edges, placedIds, selectedEdgeId),
    [edges, placedIds, selectedEdgeId],
  );
  const occurrencesById = useMemo(() => indexOccurrences(occurrences), [occurrences]);
  const edgeItemsById = useMemo(() => indexItemsById(items), [items]);
  const resolvedSelectedEdge = useMemo<ResolvedSpaceEdge | null>(() => {
    const edge = selectedEdgeId ? edges.find((candidate) => candidate.id === selectedEdgeId) : null;
    return edge ? resolveEdge(edge, occurrencesById, edgeItemsById) : null;
  }, [selectedEdgeId, edges, occurrencesById, edgeItemsById]);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      let positionChanged = false;
      for (const change of changes) {
        if (change.type === 'position' && change.position) {
          const id = change.id;
          draggingIds.current.add(id);
          // Pointer movement stays in a local overlay so the canonical
          // occurrence list, shelf partition, and edge projection do not churn
          // on every drag frame.
          setLocalPositions((prev) => ({
            ...prev,
            [id]: { x: change.position!.x, y: change.position!.y },
          }));
          if (change.dragging === false) {
            // Drag ended: queue the final position and debounce the write.
            pendingPositions.current[id] = {
              x: change.position.x,
              y: change.position.y,
            };
            positionChanged = true;
          }
        }
        if (change.type === 'select') {
          setSelection((prev) => {
            const next = new Set(prev);
            if (change.selected) next.add(change.id);
            else next.delete(change.id);
            return next;
          });
          if (change.selected) setSelectedEdgeId(null);
        }
      }
      if (positionChanged) scheduleFlush();
    },
    [scheduleFlush],
  );

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
        setEdgeStatusMessage('Edge label saved');
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
          ? occurrencesRef.current.filter((o) => selection.has(o.id))
          : occurrencesRef.current;
      if (targets.length === 0) return;
      const positions = seedLayoutPositions(targets, indexItems(items));
      // Optimistic local move for all seeded nodes...
      setOccurrences((prev) =>
        prev.map((o) => (positions[o.id] ? { ...o, x: positions[o.id].x, y: positions[o.id].y } : o)),
      );
      setLocalPositions((prev) => {
        const next = { ...prev };
        for (const id of Object.keys(positions)) delete next[id];
        return next;
      });
      // ...and persist them through the same debounced batch path.
      for (const [id, pos] of Object.entries(positions)) {
        pendingPositions.current[id] = pos;
      }
      scheduleFlush();
    },
    [selection, items, scheduleFlush],
  );

  // --- refetch (after an add) WITHOUT touching viewport/selection ---
  // This mirrors the SSE reconciliation path: it reconciles occurrences
  // (preserving in-flight drags) and never resets the
  // ephemeral selection/viewport (Dataful-UX contract).
  const reload = useCallback(async () => {
    if (!spaceId || !loadModel) return;
    const model = await loadModel(spaceId);
    setItems(model.items);
    setOccurrences((prev) => reconcileOccurrences(model.occurrences, draggingIds.current, prev));
    setEdges((prev) => reconcileEdges(model.edges ?? [], editingEdgeIds.current, prev));
  }, [spaceId, loadModel]);

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
            onClick={() => setPickerOpen((open) => !open)}
            aria-haspopup="dialog"
            aria-expanded={pickerOpen}
            data-testid="space-canvas-add-items"
          >
            + Add items
          </button>
          {pickerOpen && spaceId ? (
            <div className="space-canvas__picker-anchor">
              <SpaceItemPicker
                spaceId={spaceId}
                projectId={projectId}
                existingItems={items}
                isItemInView={isItemOnCanvas}
                alreadyInViewLabel="Already on canvas"
                afterAdd={afterAddItem}
                onAdded={() => {
                  void reload();
                }}
                onClose={() => setPickerOpen(false)}
              />
            </div>
          ) : null}
        </div>
        <div className="space-canvas__overflow">
          <button
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
            <div className="space-canvas__overflow-menu" role="menu">
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
      <div className="space-canvas__body" ref={bodyRef}>
        <div className="space-canvas__flow" data-testid="space-canvas-flow">
          {placed.length === 0 ? (
            <div className="space-canvas__empty" data-testid="space-canvas-empty">
              No canvas items yet.
            </div>
          ) : (
            <ReactFlow
              nodes={flowNodes}
              edges={flowEdges}
              nodeTypes={nodeTypes}
              proOptions={{ hideAttribution: true }}
              fitView
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
          )}
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
        <span className="space-canvas__inspector-status" data-status={status}>
          {statusMessage || edgeStatusLabel(status)}
        </span>
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
              <select
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
              </select>
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
  return (
    <div className="space-canvas__inspector-section" data-testid="space-canvas-node-inspector">
      <header className="space-canvas__inspector-header">
        <span>{item?.ref_type ?? 'occurrence'}</span>
      </header>
      {!item ? (
        <OccurrenceSummary node={node} />
      ) : item.ref_type === 'issue' ? (
        <IssueReferenceDetail issueRef={item.ref_id} />
      ) : item.ref_type === 'artifact' ? (
        <ArtifactReferenceDetail artifactRef={item.ref_uri ?? item.ref_id} />
      ) : (
        <OccurrenceSummary node={node} />
      )}
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

function autosaveLabel(status: AutosaveStatus): string {
  switch (status) {
    case 'saving':
      return 'Saving…';
    case 'saved':
      return 'Saved';
    case 'error':
      return 'Save failed - will retry';
    default:
      return 'Saved';
  }
}

function edgeStatusLabel(status: AutosaveStatus): string {
  switch (status) {
    case 'saving':
      return 'Saving...';
    case 'saved':
      return 'Saved';
    case 'error':
      return 'Error';
    default:
      return 'Ready';
  }
}

/** React Flow custom node for a Space occurrence. */
function OccurrenceNode(props: {
  data: { label: string; kind: string };
  selected?: boolean;
}): JSX.Element {
  return (
    <div
      className="space-canvas__node"
      data-selected={props.selected ? 'true' : 'false'}
      data-testid="space-canvas-node"
    >
      {/* Target handle (left): the drop side of a drag-to-connect gesture. */}
      <Handle
        type="target"
        position={Position.Left}
        className="space-canvas__handle space-canvas__handle--target"
        data-testid="space-canvas-handle-target"
      />
      <div className="space-canvas__node-kind">{props.data.kind}</div>
      <div className="space-canvas__node-title">{props.data.label}</div>
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
