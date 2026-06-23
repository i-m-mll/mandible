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
// Ownership: this component owns the canvas node surface and its own
// `SpaceCanvas.css`. It reads `../../graph/layout` (`layoutGraph`) for the seed
// path only and must NOT modify `graph.tsx`. The `space_edges` UI is C9b's; this
// lane renders nodes + shelf + drag only.

import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Background, Controls, ReactFlow, type NodeChange } from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import type { SpaceItem, SpaceOccurrence, BatchSpaceOccurrenceEntry } from '../../api';
import { batchWriteSpaceOccurrences } from '../../api';
import { layoutGraph } from '../../graph/layout';
import type { GraphEdge, GraphNode } from '../../types/graph';
import { createSSEClient, type SSEClient, type SSEPayload } from '../../sse-client';
import type { SpaceRendererMountProps } from './SpacesViewShell';
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
 * the persisted (canonical) coordinates — guaranteed non-null because unplaced
 * occurrences live in the shelf, not on the canvas.
 */
export type CanvasNode = {
  occurrence: SpaceOccurrence;
  item: SpaceItem | null;
  x: number;
  y: number;
};

/** A shelf entry: an occurrence with no persisted position (x or y NULL). */
export type ShelfEntry = {
  occurrence: SpaceOccurrence;
  item: SpaceItem | null;
};

export type CanvasPartition = {
  placed: CanvasNode[];
  shelf: ShelfEntry[];
};

/**
 * Split occurrences into placed (canvas) vs unplaced (shelf). An occurrence is
 * placed iff BOTH x and y are non-null finite numbers; otherwise it belongs in
 * the shelf and must NOT be drawn at the origin (acceptance criterion).
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
 * Map occurrences to `GraphNode`s so `layoutGraph()` (the existing structured
 * layout) can seed positions. Edges are mapped from `parent_id` links only so
 * the structural hierarchy layout has something to arrange; this lane renders
 * no edges UI (C9b owns that).
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
  /** SSE client factory (injected for tests); defaults to the shared client. */
  createSse?: () => SSEClient;
  /** Debounce window (ms) for the batched drag-position write. */
  debounceMs?: number;
};

const DEFAULT_DEBOUNCE_MS = 400;
const OCCURRENCE_MOVED_EVENT = 'space:occurrence:moved';

/**
 * The editable Spaces canvas (node half). Registered into `SpacesViewShell` as
 * the `canvas` renderer mount point.
 */
export function SpaceCanvas(props: SpaceCanvasProps): JSX.Element {
  const {
    spaceId,
    initialModel,
    loadModel,
    batchWrite = batchWriteSpaceOccurrences,
    createSse = createSSEClient,
    debounceMs = DEFAULT_DEBOUNCE_MS,
  } = props;

  const [occurrences, setOccurrences] = useState<SpaceOccurrence[]>(
    () => initialModel?.occurrences ?? [],
  );
  const [items, setItems] = useState<SpaceItem[]>(() => initialModel?.items ?? []);
  const [autosave, setAutosave] = useState<AutosaveStatus>('idle');
  // UI selection is ephemeral browser-local view state — never persisted, never
  // reset by SSE reconciliation.
  const [selection, setSelection] = useState<Set<string>>(() => new Set());

  // Refs that must not trigger re-render or re-subscribe.
  const draggingIds = useRef<Set<string>>(new Set());
  const pendingPositions = useRef<Record<string, { x: number; y: number }>>({});
  const debounceTimer = useRef<number | null>(null);
  const occurrencesRef = useRef<SpaceOccurrence[]>(occurrences);
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

  // --- SSE reconciliation: refetch + reconcile WITHOUT touching viewport/sel ---
  useEffect(() => {
    if (!spaceId || !loadModel) return;
    const client = createSse();
    const unsubscribe = client.on(OCCURRENCE_MOVED_EVENT, (payload: SSEPayload) => {
      const data = (payload.data ?? payload) as { space_id?: string };
      if (data?.space_id && data.space_id !== spaceId) return;
      void loadModel(spaceId).then((model) => {
        setItems(model.items);
        setOccurrences((prev) =>
          reconcileOccurrences(model.occurrences, draggingIds.current, prev),
        );
        // NOTE: selection and viewport state are intentionally untouched here.
      });
    });
    client.connect();
    return () => {
      unsubscribe();
      client.close();
    };
  }, [spaceId, loadModel, createSse]);

  // --- React Flow nodes (positions come from persisted occurrence x/y) ---
  const flowNodes = useMemo(
    () =>
      placed.map((node) => ({
        id: node.occurrence.id,
        position: { x: node.x, y: node.y },
        data: {
          label: occurrenceLabel(node.occurrence, node.item),
          kind: occurrenceKind(node.occurrence, node.item),
        },
        selected: selection.has(node.occurrence.id),
        type: 'spaceOccurrence',
      })),
    [placed, selection],
  );

  const nodeTypes = useMemo(() => ({ spaceOccurrence: OccurrenceNode }), []);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      let positionChanged = false;
      for (const change of changes) {
        if (change.type === 'position' && change.position) {
          const id = change.id;
          draggingIds.current.add(id);
          // Optimistic local update — persisted x/y becomes the live preview.
          setOccurrences((prev) =>
            applyOptimisticPosition(prev, id, change.position!.x, change.position!.y),
          );
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
        }
      }
      if (positionChanged) scheduleFlush();
    },
    [scheduleFlush],
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
      // ...and persist them through the same debounced batch path.
      for (const [id, pos] of Object.entries(positions)) {
        pendingPositions.current[id] = pos;
      }
      scheduleFlush();
    },
    [selection, items, scheduleFlush],
  );

  // --- shelf placement: clicking a shelf entry places it via layout seed ---
  const handlePlaceFromShelf = useCallback(
    (occurrenceId: string) => {
      const occurrence = occurrencesRef.current.find((o) => o.id === occurrenceId);
      if (!occurrence) return;
      // Seed a single position from the placed set's layout so it lands in the
      // arranged region rather than the origin.
      const positions = seedLayoutPositions(occurrencesRef.current, indexItems(items));
      const pos = positions[occurrenceId] ?? { x: 0, y: 0 };
      setOccurrences((prev) =>
        applyOptimisticPosition(prev, occurrenceId, pos.x, pos.y),
      );
      pendingPositions.current[occurrenceId] = pos;
      scheduleFlush();
    },
    [items, scheduleFlush],
  );

  return (
    <div className="space-canvas" data-testid="space-canvas">
      <div className="space-canvas__toolbar" role="toolbar" aria-label="Canvas actions">
        <button
          type="button"
          className="space-canvas__btn"
          onClick={() => handleArrange('all')}
          data-testid="space-canvas-arrange-all"
        >
          Arrange all
        </button>
        <button
          type="button"
          className="space-canvas__btn"
          onClick={() => handleArrange('selected')}
          disabled={selection.size === 0}
          data-testid="space-canvas-arrange-selected"
        >
          Re-layout selected
        </button>
        <span className="space-canvas__toolbar-spacer" />
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
      <div className="space-canvas__body">
        <aside
          className="space-canvas__shelf"
          aria-label="Unplaced occurrences"
          data-testid="space-canvas-shelf"
        >
          <div className="space-canvas__shelf-header">Shelf ({shelf.length})</div>
          {shelf.length === 0 ? (
            <div className="space-canvas__shelf-empty" data-testid="space-canvas-shelf-empty">
              All occurrences are placed.
            </div>
          ) : (
            <ul className="space-canvas__shelf-list" data-testid="space-canvas-shelf-list">
              {shelf.map((entry) => (
                <li key={entry.occurrence.id}>
                  <button
                    type="button"
                    className="space-canvas__shelf-item"
                    data-testid="space-canvas-shelf-item"
                    data-occurrence-id={entry.occurrence.id}
                    onClick={() => handlePlaceFromShelf(entry.occurrence.id)}
                  >
                    {occurrenceLabel(entry.occurrence, entry.item)}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>
        <div className="space-canvas__flow" data-testid="space-canvas-flow">
          {placed.length === 0 ? (
            <div className="space-canvas__empty" data-testid="space-canvas-empty">
              No placed occurrences yet.
            </div>
          ) : (
            <ReactFlow
              nodes={flowNodes}
              nodeTypes={nodeTypes}
              defaultEdges={[]}
              proOptions={{ hideAttribution: true }}
              fitView
              minZoom={0.2}
              maxZoom={1.8}
              nodesDraggable
              nodesConnectable={false}
              elementsSelectable
              onNodesChange={onNodesChange}
            >
              <Background gap={18} />
              <Controls showInteractive={false} />
            </ReactFlow>
          )}
        </div>
      </div>
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
      return 'Save failed — will retry';
    default:
      return 'All changes saved';
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
      <div className="space-canvas__node-kind">{props.data.kind}</div>
      <div className="space-canvas__node-title">{props.data.label}</div>
    </div>
  );
}

export default SpaceCanvas;
