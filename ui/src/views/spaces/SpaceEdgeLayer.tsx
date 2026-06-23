// SpaceEdgeLayer — the EDGE half of the editable Spaces canvas (umbrella
// de56ffa, child e16520d / C9b).
//
// This component owns the `space_edges` surface of the canvas: create/edit/
// delete authored edges with FREE labels, and an explicit promote-to-ledger
// affordance. It is a SIBLING of C9a's `SpaceCanvas` (which owns nodes/drag/
// shelf and is frozen for this lane). The two compose: SpaceCanvas renders the
// node graph; SpaceEdgeLayer renders the edge panel + editing UI alongside it.
//
// Load-bearing rules (mirrored in `./edgeModel.ts`, which is unit-tested):
//   - `space_edges` are AUTHORED objects, DISTINCT from ledger relationships.
//     Promotion is ALWAYS an explicit user action; it never happens implicitly
//     on create/edit.
//   - Promote-to-ledger REUSES `POST /api/ledger/relationships` (via
//     `./edgePromote.ts`) — no parallel relationship writer. Artifact/URI
//     endpoints are NOT promotable; the verdict gate disables those.
//   - SSE `space:edge:created` (and `:updated` / `:removed`) reconcile the edge
//     list WITHOUT resetting the user's selection or in-flight label edit
//     (project Dataful UX State rule).
//
// Ownership: this component owns its OWN `SpaceEdgeLayer.css`; it must NOT add
// rules to the global `ui/src/style.css` and must NOT modify `SpaceCanvas.tsx`.

import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';

import type {
  SpaceEdge,
  SpaceItem,
  SpaceOccurrence,
  CreateSpaceEdgeRequest,
  UpdateSpaceEdgeRequest,
} from '../../api';
import { createSpaceEdge, updateSpaceEdge, deleteSpaceEdge } from '../../api';
import { createSSEClient, type SSEClient, type SSEPayload } from '../../sse-client';
import {
  LEDGER_LINK_TYPES,
  type LedgerLinkType,
  evaluatePromotion,
  indexOccurrences,
  indexItemsById,
  reconcileEdges,
  applyOptimisticLabel,
  resolveEdge,
  type ResolvedSpaceEdge,
} from './edgeModel';
import { promoteEdgeToLedger, type PromoteEdgeDeps } from './edgePromote';
import './SpaceEdgeLayer.css';

/** Async status for an edge mutation (create/edit/delete) or a promotion. */
export type EdgeOpStatus = 'idle' | 'saving' | 'saved' | 'error';

/** The model the edge layer consumes: edges plus the occurrence/item context. */
export type SpaceEdgeModel = {
  edges: SpaceEdge[];
  occurrences: SpaceOccurrence[];
  items: SpaceItem[];
};

export type SpaceEdgeLayerLoader = (spaceId: string) => Promise<SpaceEdgeModel>;

export type SpaceEdgeLayerProps = {
  /** Canonical ledger Space id; null disables all mutations. */
  spaceId: string | null;
  /** Initial model (edges + occurrence/item context) when the host holds it. */
  initialModel?: SpaceEdgeModel;
  /** Loader for initial fetch (when no `initialModel`) and SSE reconciliation. */
  loadModel?: SpaceEdgeLayerLoader;
  /** Edge create client (injected for tests); defaults to the real C2 client. */
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
  /** SSE client factory (injected for tests); defaults to the shared client. */
  createSse?: () => SSEClient;
};

const EDGE_EVENTS = ['space:edge:created', 'space:edge:updated', 'space:edge:removed'] as const;

/**
 * The editable Spaces edge layer. Renders the edge list with free-label editing
 * and a per-edge promote-to-ledger control.
 */
export function SpaceEdgeLayer(props: SpaceEdgeLayerProps): JSX.Element {
  const {
    spaceId,
    initialModel,
    loadModel,
    createEdge = createSpaceEdge,
    updateEdge = updateSpaceEdge,
    removeEdge = deleteSpaceEdge,
    promote = promoteEdgeToLedger,
    createSse = createSSEClient,
  } = props;

  const [edges, setEdges] = useState<SpaceEdge[]>(() => initialModel?.edges ?? []);
  const [occurrences, setOccurrences] = useState<SpaceOccurrence[]>(
    () => initialModel?.occurrences ?? [],
  );
  const [items, setItems] = useState<SpaceItem[]>(() => initialModel?.items ?? []);
  const [status, setStatus] = useState<EdgeOpStatus>('idle');
  const [statusMessage, setStatusMessage] = useState<string>('');

  // Ephemeral browser-local view state — never persisted, never reset by SSE.
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  // Map of edge id → in-flight local label so an SSE echo cannot clobber a
  // label the user is currently typing.
  const editingIds = useRef<Set<string>>(new Set());

  // New-edge form (free label between two occurrences).
  const [newSource, setNewSource] = useState<string>('');
  const [newTarget, setNewTarget] = useState<string>('');
  const [newLabel, setNewLabel] = useState<string>('');

  // Per-edge promote link-type override (seeded from the suggested type).
  const [promoteLinkType, setPromoteLinkType] = useState<Record<string, LedgerLinkType>>({});

  const occurrencesById = useMemo(() => indexOccurrences(occurrences), [occurrences]);
  const itemsById = useMemo(() => indexItemsById(items), [items]);

  const resolvedEdges = useMemo<ResolvedSpaceEdge[]>(
    () => edges.map((edge) => resolveEdge(edge, occurrencesById, itemsById)),
    [edges, occurrencesById, itemsById],
  );

  // Occurrence options for the new-edge selects (labelled for accessibility).
  const occurrenceOptions = useMemo(
    () =>
      occurrences.map((occurrence) => {
        const item = occurrence.item_id ? (itemsById[occurrence.item_id] ?? null) : null;
        const label = item?.title ?? item?.ref_id ?? occurrence.note ?? occurrence.id.slice(0, 8);
        return { id: occurrence.id, label };
      }),
    [occurrences, itemsById],
  );

  // --- initial load (only when no initialModel was provided) ---
  useEffect(() => {
    if (initialModel || !spaceId || !loadModel) return;
    let cancelled = false;
    void loadModel(spaceId).then((model) => {
      if (cancelled) return;
      setEdges(model.edges);
      setOccurrences(model.occurrences);
      setItems(model.items);
    });
    return () => {
      cancelled = true;
    };
  }, [spaceId, initialModel, loadModel]);

  // --- SSE reconciliation: refetch + reconcile WITHOUT touching selection ---
  useEffect(() => {
    if (!spaceId || !loadModel) return;
    const client = createSse();
    const reconcile = (payload: SSEPayload) => {
      const data = (payload.data ?? payload) as { space_id?: string };
      if (data?.space_id && data.space_id !== spaceId) return;
      void loadModel(spaceId).then((model) => {
        setOccurrences(model.occurrences);
        setItems(model.items);
        setEdges((prev) => reconcileEdges(model.edges, editingIds.current, prev));
        // NOTE: selectedEdgeId / promoteLinkType are intentionally untouched.
      });
    };
    const unsubscribers = EDGE_EVENTS.map((event) => client.on(event, reconcile));
    client.connect();
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
      client.close();
    };
  }, [spaceId, loadModel, createSse]);

  const reportError = useCallback((message: string) => {
    setStatus('error');
    setStatusMessage(message);
  }, []);

  // --- create an authored edge with a free label ---
  const handleCreate = useCallback(async () => {
    if (!spaceId || !newSource || !newTarget) return;
    const body: CreateSpaceEdgeRequest = {
      source: newSource,
      target: newTarget,
      label: newLabel.trim() ? newLabel.trim() : null,
    };
    setStatus('saving');
    setStatusMessage('');
    try {
      const edge = await createEdge(spaceId, body);
      setEdges((prev) => [...prev, edge]);
      setNewLabel('');
      setStatus('saved');
      setStatusMessage('Edge created');
    } catch (error) {
      reportError(error instanceof Error ? error.message : 'Failed to create edge');
    }
  }, [spaceId, newSource, newTarget, newLabel, createEdge, reportError]);

  // --- edit an edge's free label (optimistic, then persist) ---
  const handleLabelEdit = useCallback(
    async (edgeId: string, label: string) => {
      if (!spaceId) return;
      const trimmed = label.trim();
      const nextLabel = trimmed ? trimmed : null;
      editingIds.current.add(edgeId);
      setEdges((prev) => applyOptimisticLabel(prev, edgeId, nextLabel));
      const body: UpdateSpaceEdgeRequest = { label: nextLabel };
      setStatus('saving');
      setStatusMessage('');
      try {
        const edge = await updateEdge(spaceId, edgeId, body);
        setEdges((prev) => prev.map((e) => (e.id === edgeId ? edge : e)));
        setStatus('saved');
        setStatusMessage('Label updated');
      } catch (error) {
        reportError(error instanceof Error ? error.message : 'Failed to update label');
      } finally {
        editingIds.current.delete(edgeId);
      }
    },
    [spaceId, updateEdge, reportError],
  );

  // --- delete an edge ---
  const handleDelete = useCallback(
    async (edgeId: string) => {
      if (!spaceId) return;
      setStatus('saving');
      setStatusMessage('');
      try {
        await removeEdge(spaceId, edgeId);
        setEdges((prev) => prev.filter((e) => e.id !== edgeId));
        if (selectedEdgeId === edgeId) setSelectedEdgeId(null);
        setStatus('saved');
        setStatusMessage('Edge deleted');
      } catch (error) {
        reportError(error instanceof Error ? error.message : 'Failed to delete edge');
      }
    },
    [spaceId, removeEdge, selectedEdgeId, reportError],
  );

  // --- promote an authored edge to a ledger relationship (explicit) ---
  const handlePromote = useCallback(
    async (resolved: ResolvedSpaceEdge) => {
      const verdict = evaluatePromotion(resolved);
      if (!verdict.promotable) {
        reportError(verdict.reason);
        return;
      }
      const linkType = promoteLinkType[resolved.edge.id] ?? verdict.suggestedLinkType;
      setStatus('saving');
      setStatusMessage('');
      try {
        await promote({
          sourceRef: verdict.sourceRef,
          targetRef: verdict.targetRef,
          linkType,
          note: resolved.edge.label ?? null,
        });
        setStatus('saved');
        setStatusMessage(`Promoted to ledger as ${linkType}`);
      } catch (error) {
        reportError(error instanceof Error ? error.message : 'Failed to promote edge');
      }
    },
    [promoteLinkType, promote, reportError],
  );

  const canCreate = Boolean(spaceId && newSource && newTarget && newSource !== newTarget);

  return (
    <section
      className="space-edge-layer"
      data-testid="space-edge-layer"
      aria-label="Space edges"
    >
      <header className="space-edge-layer__header">
        <span className="space-edge-layer__title">Edges ({edges.length})</span>
        <span
          className="space-edge-layer__status"
          data-status={status}
          data-testid="space-edge-layer-status"
          role="status"
          aria-live="polite"
        >
          {statusMessage || edgeStatusLabel(status)}
        </span>
      </header>

      {/* --- new-edge form (free label) --- */}
      <form
        className="space-edge-layer__create"
        data-testid="space-edge-create-form"
        onSubmit={(event) => {
          event.preventDefault();
          void handleCreate();
        }}
      >
        <label className="space-edge-layer__field">
          <span className="space-edge-layer__field-label">From</span>
          <select
            className="space-edge-layer__select"
            data-testid="space-edge-create-source"
            value={newSource}
            onChange={(event) => setNewSource((event.target as HTMLSelectElement).value)}
          >
            <option value="">Select source…</option>
            {occurrenceOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="space-edge-layer__field">
          <span className="space-edge-layer__field-label">To</span>
          <select
            className="space-edge-layer__select"
            data-testid="space-edge-create-target"
            value={newTarget}
            onChange={(event) => setNewTarget((event.target as HTMLSelectElement).value)}
          >
            <option value="">Select target…</option>
            {occurrenceOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="space-edge-layer__field">
          <span className="space-edge-layer__field-label">Label</span>
          <input
            className="space-edge-layer__input"
            data-testid="space-edge-create-label"
            type="text"
            placeholder="Free label (optional)"
            value={newLabel}
            onInput={(event) => setNewLabel((event.target as HTMLInputElement).value)}
          />
        </label>
        <button
          type="submit"
          className="space-edge-layer__btn"
          data-testid="space-edge-create-submit"
          disabled={!canCreate}
        >
          Add edge
        </button>
      </form>

      {/* --- edge list --- */}
      {resolvedEdges.length === 0 ? (
        <div className="space-edge-layer__empty" data-testid="space-edge-empty">
          No edges yet.
        </div>
      ) : (
        <ul className="space-edge-layer__list" data-testid="space-edge-list">
          {resolvedEdges.map((resolved) => {
            const verdict = evaluatePromotion(resolved);
            const edge = resolved.edge;
            const selected = selectedEdgeId === edge.id;
            const linkType = promoteLinkType[edge.id]
              ?? (verdict.promotable ? verdict.suggestedLinkType : undefined);
            return (
              <li
                key={edge.id}
                className="space-edge-layer__item"
                data-testid="space-edge-item"
                data-edge-id={edge.id}
                data-selected={selected ? 'true' : 'false'}
              >
                <button
                  type="button"
                  className="space-edge-layer__endpoints"
                  data-testid="space-edge-select"
                  aria-pressed={selected}
                  onClick={() => setSelectedEdgeId(selected ? null : edge.id)}
                >
                  <span className="space-edge-layer__endpoint">{resolved.source.label}</span>
                  <span className="space-edge-layer__arrow" aria-hidden="true">
                    →
                  </span>
                  <span className="space-edge-layer__endpoint">{resolved.target.label}</span>
                </button>

                <label className="space-edge-layer__label-field">
                  <span className="space-edge-layer__sr-only">Edge label</span>
                  <input
                    className="space-edge-layer__input"
                    data-testid="space-edge-label-input"
                    type="text"
                    placeholder="Add a label…"
                    defaultValue={edge.label ?? ''}
                    onBlur={(event) =>
                      void handleLabelEdit(edge.id, (event.target as HTMLInputElement).value)
                    }
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        (event.target as HTMLInputElement).blur();
                      }
                    }}
                  />
                </label>

                <div className="space-edge-layer__actions">
                  {verdict.promotable ? (
                    <div className="space-edge-layer__promote" data-testid="space-edge-promote">
                      <label className="space-edge-layer__sr-only" htmlFor={`lt-${edge.id}`}>
                        Ledger link type
                      </label>
                      <select
                        id={`lt-${edge.id}`}
                        className="space-edge-layer__select space-edge-layer__select--compact"
                        data-testid="space-edge-link-type"
                        value={linkType}
                        onChange={(event) =>
                          setPromoteLinkType((prev) => ({
                            ...prev,
                            [edge.id]: (event.target as HTMLSelectElement).value as LedgerLinkType,
                          }))
                        }
                      >
                        {LEDGER_LINK_TYPES.map((type) => (
                          <option key={type} value={type}>
                            {type}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="space-edge-layer__btn"
                        data-testid="space-edge-promote-btn"
                        onClick={() => void handlePromote(resolved)}
                      >
                        Promote to ledger
                      </button>
                    </div>
                  ) : (
                    <span
                      className="space-edge-layer__not-promotable"
                      data-testid="space-edge-not-promotable"
                      title={verdict.reason}
                    >
                      Not promotable
                    </span>
                  )}
                  <button
                    type="button"
                    className="space-edge-layer__btn space-edge-layer__btn--danger"
                    data-testid="space-edge-delete-btn"
                    aria-label={`Delete edge ${resolved.source.label} to ${resolved.target.label}`}
                    onClick={() => void handleDelete(edge.id)}
                  >
                    Delete
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function edgeStatusLabel(status: EdgeOpStatus): string {
  switch (status) {
    case 'saving':
      return 'Saving…';
    case 'saved':
      return 'Saved';
    case 'error':
      return 'Error';
    default:
      return 'Ready';
  }
}

export default SpaceEdgeLayer;
