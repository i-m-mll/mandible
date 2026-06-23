// Board / kanban renderer (umbrella de56ffa, child 4d4d364 / C17).
//
// A real board renderer over `space_occurrences` with renderer='board':
// columns/swimlanes via `section_id`, ordered within a column by `sort_key`.
//
//   - DEFAULT columns derive from issue `worker_status` (boardModel). An
//     occurrence with no explicit `section_id` falls into the default column
//     for its backing issue's resolved worker_status — resolved through the
//     read-only C2 resolver (`resolveResourceRef`), cached per item.
//   - CUSTOM columns are FILTER-defined (via the C7b shared IssuePredicateFilter)
//     or MANUAL, and PERSIST in `spaces.metadata` (no new table) through the C2
//     `updateSpace` PATCH route. Membership persists across refresh.
//   - DRAG between columns writes `section_id` + a fractional `sort_key` via the
//     `updateSpaceOccurrence` route. Keyboard moves do the same, so the board is
//     operable without a pointer (standing AC #5).
//   - SSE `space:*` events RECONCILE the board (refetch the packet) but never
//     reset collapse/selection/filter (Dataful-UX contract, standing AC #2).
//
// Item refs render through the shared C6 unresolved-ref UI; raw ref text is
// never injected as HTML (renderer-security standing AC).

import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';

import {
  getSpaceFactPacket,
  updateSpace,
  updateSpaceOccurrence,
  type SpaceItem,
} from '../../api';
import {
  parseResourceRef,
  resolveResourceRef,
  resourceRefHref,
  displayResourceRef,
  type ResolverResult,
} from '../../resource-refs';
import { createSSEClient } from '../../sse-client';
import {
  IssuePredicateFilter,
} from '../filters/IssuePredicateFilter';
import {
  normalizeFilterChips,
  parseFilterToken,
  predicateForChips,
  filterRowTitle,
  type TimelineFilterChip,
} from '../filters/issue-predicate-filter';
import type { SpaceRendererMountProps } from './SpacesViewShell';
import type { SpaceViewModel } from './types';
import { buildSpaceViewModel } from './collectionModel';
import {
  projectBoard,
  readBoardMetadata,
  writeBoardMetadata,
  sortKeyBetween,
  isValidCustomColumnKey,
  cardLabel,
  cardRefString,
  issueFactsFromEntity,
  type BoardColumn,
  type BoardCard,
  type BoardMetadata,
  type CustomColumnDef,
  type IssueFactsByItemId,
} from './boardModel';
import {
  readBoardViewState,
  writeBoardViewState,
  reconcileBoardViewState,
  EMPTY_BOARD_VIEW_STATE,
  type BoardViewState,
} from './boardViewState';
import './space-board.css';

const SPACE_EVENT_PREFIX = 'space:';

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; model: SpaceViewModel }
  | { status: 'error'; message: string };

/** Case-insensitive card filter. */
function matchesFilter(label: string, ref: string, filter: string): boolean {
  if (!filter.trim()) return true;
  const needle = filter.trim().toLowerCase();
  return label.toLowerCase().includes(needle) || ref.toLowerCase().includes(needle);
}

/**
 * Inline unresolved-ref affordance for one card's item ref (shared C6 UI). The
 * ref starts UNRESOLVED with a resolve button; no raw ref text is injected as
 * HTML.
 */
function CardRef({ item }: { item: SpaceItem }): JSX.Element {
  const ref = cardRefString(item);
  const parsed = useMemo(() => parseResourceRef(ref), [ref]);
  const [state, setState] = useState<'unresolved' | 'resolving' | 'resolved' | 'error'>('unresolved');
  const [detail, setDetail] = useState<string>('');

  const onResolve = useCallback(async () => {
    setState('resolving');
    try {
      const result: ResolverResult = await resolveResourceRef(ref);
      if (result.resolved) {
        setState('resolved');
        setDetail(`Resolved ${ref} (${result.kind})`);
      } else {
        setState('error');
        setDetail(result.error ? `Unresolved: ${result.error}` : `Unresolved: ${ref}`);
      }
    } catch (error) {
      setState('error');
      setDetail(`Resolve failed: ${String(error)}`);
    }
  }, [ref]);

  const label = cardLabel(item, parsed ? parsed.display : displayResourceRef(ref));
  const href = parsed ? resourceRefHref(parsed.canonical) : undefined;

  return (
    <span
      className={`space-board__ref resource-ref resource-ref--${state === 'unresolved' || state === 'resolving' ? 'unresolved' : state}`}
      data-resource-ref={parsed ? parsed.canonical : ref}
      data-resource-kind={parsed ? parsed.kind : 'unknown'}
      data-ref-state={state}
      title={detail || `Resource reference ${ref} (${state})`}
    >
      {href ? (
        <a className="artifact-xref resource-ref__link" href={href}>
          {label}
        </a>
      ) : (
        <span className="resource-ref__link">{label}</span>
      )}
      {state === 'unresolved' || state === 'error' ? (
        <button
          type="button"
          className="resource-ref__resolve"
          data-resolve-ref={parsed ? parsed.canonical : ref}
          onClick={onResolve}
          title={`Resolve ${ref}`}
        >
          resolve
        </button>
      ) : null}
    </span>
  );
}

type CardProps = {
  card: BoardCard;
  columnKey: string;
  selected: boolean;
  /** Whether this card can be moved to a previous/next column (keyboard affordance). */
  canMovePrev: boolean;
  canMoveNext: boolean;
  onSelect: (occurrenceId: string) => void;
  onDragStart: (occurrenceId: string, fromColumn: string) => void;
  onMove: (occurrenceId: string, direction: -1 | 1) => void;
};

function BoardCardView({
  card,
  columnKey,
  selected,
  canMovePrev,
  canMoveNext,
  onSelect,
  onDragStart,
  onMove,
}: CardProps): JSX.Element {
  const occ = card.occurrence.occurrence;
  const item = card.occurrence.item;
  return (
    <li role="listitem">
      <div
        className="space-board__card"
        data-selected={selected ? 'true' : 'false'}
        data-occurrence-id={occ.id}
        data-column-key={columnKey}
        tabIndex={0}
        role="button"
        aria-pressed={selected}
        aria-label={`Card ${item ? cardLabel(item, occ.id) : occ.note ?? occ.id}`}
        draggable
        onClick={() => onSelect(occ.id)}
        onDragStart={(event) => {
          (event.dataTransfer as DataTransfer).setData('text/plain', occ.id);
          (event.dataTransfer as DataTransfer).effectAllowed = 'move';
          onDragStart(occ.id, columnKey);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onSelect(occ.id);
          } else if (event.key === 'ArrowLeft' && canMovePrev) {
            event.preventDefault();
            onMove(occ.id, -1);
          } else if (event.key === 'ArrowRight' && canMoveNext) {
            event.preventDefault();
            onMove(occ.id, 1);
          }
        }}
      >
        <span className="space-board__card-label">
          {item ? (
            <CardRef item={item} />
          ) : (
            <span>{occ.note ?? '(card)'}</span>
          )}
        </span>
        <div className="space-board__card-move" aria-hidden="false">
          <button
            type="button"
            className="space-board__card-move-btn"
            disabled={!canMovePrev}
            aria-label="Move card to previous column"
            title="Move to previous column"
            onClick={(event) => {
              event.stopPropagation();
              onMove(occ.id, -1);
            }}
          >
            {'‹'}
          </button>
          <button
            type="button"
            className="space-board__card-move-btn"
            disabled={!canMoveNext}
            aria-label="Move card to next column"
            title="Move to next column"
            onClick={(event) => {
              event.stopPropagation();
              onMove(occ.id, 1);
            }}
          >
            {'›'}
          </button>
        </div>
      </div>
    </li>
  );
}

type ColumnProps = {
  column: BoardColumn;
  index: number;
  columnCount: number;
  collapsed: boolean;
  filter: string;
  selectedIds: ReadonlySet<string>;
  isDropTarget: boolean;
  onToggleCollapse: (key: string) => void;
  onSelect: (occurrenceId: string) => void;
  onDragStart: (occurrenceId: string, fromColumn: string) => void;
  onDropOnColumn: (columnKey: string) => void;
  onDragOverColumn: (columnKey: string | null) => void;
  onMove: (occurrenceId: string, direction: -1 | 1) => void;
  onRemoveColumn: (key: string) => void;
};

function BoardColumnView({
  column,
  index,
  columnCount,
  collapsed,
  filter,
  selectedIds,
  isDropTarget,
  onToggleCollapse,
  onSelect,
  onDragStart,
  onDropOnColumn,
  onDragOverColumn,
  onMove,
  onRemoveColumn,
}: ColumnProps): JSX.Element {
  const visibleCards = column.cards.filter((card) => {
    const item = card.occurrence.item;
    const label = item ? cardLabel(item, '') : card.occurrence.occurrence.note ?? '';
    const ref = item ? cardRefString(item) : '';
    return matchesFilter(label, ref, filter);
  });

  return (
    <section
      className="space-board__column"
      data-column-key={column.key}
      data-column-kind={column.kind}
      data-drop-target={isDropTarget ? 'true' : 'false'}
      aria-label={`Column ${column.title}`}
      onDragOver={(event) => {
        event.preventDefault();
        (event.dataTransfer as DataTransfer).dropEffect = 'move';
        onDragOverColumn(column.key);
      }}
      onDragLeave={() => onDragOverColumn(null)}
      onDrop={(event) => {
        event.preventDefault();
        onDropOnColumn(column.key);
        onDragOverColumn(null);
      }}
    >
      <header className="space-board__column-header">
        <button
          type="button"
          className="space-board__column-twisty"
          aria-label={collapsed ? `Expand ${column.title}` : `Collapse ${column.title}`}
          aria-expanded={!collapsed}
          onClick={() => onToggleCollapse(column.key)}
        >
          {collapsed ? '▶' : '▼'}
        </button>
        <span className="space-board__column-title">{column.title}</span>
        <span className="space-board__column-count" aria-label={`${visibleCards.length} cards`}>
          {visibleCards.length}
        </span>
        {column.kind !== 'default' ? (
          <button
            type="button"
            className="space-board__column-remove"
            aria-label={`Remove column ${column.title}`}
            title="Remove custom column"
            onClick={() => onRemoveColumn(column.key)}
          >
            {'×'}
          </button>
        ) : null}
      </header>
      {!collapsed ? (
        <ul className="space-board__cards" role="list" data-testid={`board-column-${column.key}`}>
          {visibleCards.length === 0 ? (
            <li className="space-board__column-empty" aria-hidden="true">
              {filter.trim() ? 'No matching cards' : 'Empty'}
            </li>
          ) : (
            visibleCards.map((card) => (
              <BoardCardView
                key={card.occurrence.occurrence.id}
                card={card}
                columnKey={column.key}
                selected={selectedIds.has(card.occurrence.occurrence.id)}
                canMovePrev={index > 0}
                canMoveNext={index < columnCount - 1}
                onSelect={onSelect}
                onDragStart={onDragStart}
                onMove={onMove}
              />
            ))
          )}
        </ul>
      ) : null}
    </section>
  );
}

/** Form to add a custom column: manual (membership by drag) or filter (C7b predicate). */
function AddColumnForm({
  busy,
  onAddManual,
  onAddFilter,
}: {
  busy: boolean;
  onAddManual: (title: string) => void;
  onAddFilter: (chips: TimelineFilterChip[]) => void;
}): JSX.Element {
  const [mode, setMode] = useState<'manual' | 'filter'>('manual');
  const [title, setTitle] = useState('');
  const [chips, setChips] = useState<TimelineFilterChip[]>([]);

  const normalizedChips = useMemo(() => normalizeFilterChips(chips), [chips]);
  const previewTitle = useMemo(() => filterRowTitle(normalizedChips), [normalizedChips]);
  const projecting = useMemo(() => predicateForChips(normalizedChips) !== null, [normalizedChips]);

  const onAddToken = useCallback((token: string): boolean => {
    const chip = parseFilterToken(token);
    if (!chip) return false;
    setChips((prior) => [...prior, chip]);
    return true;
  }, []);

  const onRemoveChip = useCallback((index: number) => {
    setChips((prior) => prior.filter((_, i) => i !== index));
  }, []);

  return (
    <div className="space-board__add-column" data-testid="board-add-column">
      <div className="space-board__add-column-modes" role="tablist" aria-label="Column kind">
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'manual'}
          className="space-board__add-column-mode"
          onClick={() => setMode('manual')}
        >
          Manual
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'filter'}
          className="space-board__add-column-mode"
          onClick={() => setMode('filter')}
        >
          Filter
        </button>
      </div>
      {mode === 'manual' ? (
        <div className="space-board__add-column-manual">
          <input
            className="space-board__add-column-title"
            type="text"
            placeholder="Column title"
            aria-label="Custom column title"
            value={title}
            onInput={(event) => setTitle((event.target as HTMLInputElement).value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && title.trim()) {
                onAddManual(title.trim());
                setTitle('');
              }
            }}
          />
          <button
            type="button"
            className="space-board__add-column-btn"
            disabled={busy || !title.trim()}
            onClick={() => {
              onAddManual(title.trim());
              setTitle('');
            }}
          >
            Add column
          </button>
        </div>
      ) : (
        <IssuePredicateFilter
          chips={normalizedChips}
          projecting={projecting}
          previewTitle={previewTitle}
          onAddToken={onAddToken}
          onRemoveChip={onRemoveChip}
          onCancel={() => setChips([])}
          onSave={() => {
            if (projecting) {
              onAddFilter(normalizedChips);
              setChips([]);
            }
          }}
          canSave={projecting && !busy}
          saveLabel="Add filter column"
          ariaLabel="Add filter column"
          classPrefix="space-board-filter"
        />
      )}
    </div>
  );
}

export function SpaceBoardRenderer({ projectId, spaceId }: SpaceRendererMountProps): JSX.Element {
  const [load, setLoad] = useState<LoadState>({ status: 'idle' });
  const [viewState, setViewState] = useState<BoardViewState>(EMPTY_BOARD_VIEW_STATE);
  const [boardMeta, setBoardMeta] = useState<BoardMetadata>({ version: 1, columns: [] });
  const [factsByItemId, setFactsByItemId] = useState<IssueFactsByItemId>({});
  const [busy, setBusy] = useState(false);
  const [dragOverColumn, setDragOverColumn] = useState<string | null>(null);

  const dragRef = useRef<{ occurrenceId: string; fromColumn: string } | null>(null);
  const liveIdsRef = useRef<Set<string>>(new Set());
  // Items whose worker_status we've already resolved (or attempted), so we don't
  // re-resolve the same issue on every reconciliation pass.
  const resolvedItemsRef = useRef<Set<string>>(new Set());

  // Hydrate persisted view-state on Space change (explicit navigation only).
  useEffect(() => {
    if (!spaceId) {
      setViewState(EMPTY_BOARD_VIEW_STATE);
      return;
    }
    setViewState(readBoardViewState(projectId, spaceId));
    resolvedItemsRef.current = new Set();
    setFactsByItemId({});
  }, [projectId, spaceId]);

  // Persist view-state on change so it survives tab switches / refreshes.
  useEffect(() => {
    if (!spaceId) return;
    writeBoardViewState(projectId, spaceId, viewState);
  }, [projectId, spaceId, viewState]);

  const loadPacket = useCallback(
    async (reconcile: boolean) => {
      if (!spaceId) {
        setLoad({ status: 'idle' });
        return;
      }
      if (!reconcile) setLoad({ status: 'loading' });
      try {
        const packet = await getSpaceFactPacket(spaceId);
        const model = buildSpaceViewModel(packet);
        const meta = readBoardMetadata(model.space);
        setBoardMeta(meta);
        const liveIds = new Set<string>();
        for (const o of model.occurrences) liveIds.add(o.occurrence.id);
        for (const id of Object.keys(model.itemsById)) liveIds.add(id);
        liveIdsRef.current = liveIds;
        setLoad({ status: 'ready', model });
      } catch (error) {
        if (!reconcile) setLoad({ status: 'error', message: String(error) });
      }
    },
    [spaceId],
  );

  useEffect(() => {
    void loadPacket(false);
  }, [loadPacket]);

  // SSE reconciliation: any `space:*` event refetches the packet. Collapse /
  // selection / filter are preserved across the refetch.
  useEffect(() => {
    if (!spaceId) return;
    const client = createSSEClient();
    const unsubscribe = client.on('*', (payload) => {
      if (typeof payload.type === 'string' && payload.type.startsWith(SPACE_EVENT_PREFIX)) {
        void loadPacket(true);
      }
    });
    client.connect();
    return () => {
      unsubscribe();
      client.close();
    };
  }, [spaceId, loadPacket]);

  // Resolve issue worker_status for board items (drives default columns). Each
  // issue item is resolved once; results feed the by-item facts map. Non-issue
  // items are skipped (they fall into the `none` default column).
  const model = load.status === 'ready' ? load.model : null;
  useEffect(() => {
    if (!model) return;
    const pending: SpaceItem[] = [];
    for (const occ of model.occurrences) {
      if (occ.renderer !== 'board') continue;
      const item = occ.item;
      if (!item || item.ref_type !== 'issue') continue;
      if (resolvedItemsRef.current.has(item.id)) continue;
      pending.push(item);
    }
    if (pending.length === 0) return;
    let cancelled = false;
    (async () => {
      const updates: IssueFactsByItemId = {};
      for (const item of pending) {
        resolvedItemsRef.current.add(item.id);
        try {
          const result = await resolveResourceRef(cardRefString(item));
          if (result.resolved) {
            updates[item.id] = issueFactsFromEntity(item.id, result.entity);
          }
        } catch {
          /* leave unresolved → falls into the `none` default column */
        }
      }
      if (!cancelled && Object.keys(updates).length > 0) {
        setFactsByItemId((prior) => ({ ...prior, ...updates }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [model]);

  const projection = useMemo(
    () => (model ? projectBoard(model, boardMeta, factsByItemId) : null),
    [model, boardMeta, factsByItemId],
  );

  // Reconcile view-state against live ids + column keys (never a reset).
  useEffect(() => {
    if (!projection) return;
    const liveColumnKeys = new Set(projection.columns.map((c) => c.key));
    setViewState((prior) => reconcileBoardViewState(prior, liveIdsRef.current, liveColumnKeys));
  }, [projection]);

  const selectedIds = useMemo(() => new Set(viewState.selection.ids), [viewState.selection.ids]);

  const onSelect = useCallback((occurrenceId: string) => {
    setViewState((prior) => ({ ...prior, selection: { kind: 'occurrence', ids: [occurrenceId] } }));
  }, []);

  const onToggleCollapse = useCallback((key: string) => {
    setViewState((prior) => ({
      ...prior,
      collapsedColumns: { ...prior.collapsedColumns, [key]: !prior.collapsedColumns[key] },
    }));
  }, []);

  // Persist a card's move to a target column: write section_id + a sort_key that
  // places it at the end of the destination column, via the C2 occurrence route.
  const persistMove = useCallback(
    async (occurrenceId: string, toColumnKey: string) => {
      if (!spaceId || !projection) return;
      const target = projection.columns.find((c) => c.key === toColumnKey);
      const lastCard = target && target.cards.length > 0 ? target.cards[target.cards.length - 1] : null;
      const lastKey = lastCard ? lastCard.occurrence.occurrence.sort_key : null;
      const sortKey = sortKeyBetween(lastKey, null);
      setBusy(true);
      try {
        await updateSpaceOccurrence(spaceId, occurrenceId, {
          section_id: toColumnKey,
          sort_key: sortKey,
        });
        await loadPacket(true);
      } catch (error) {
        setLoad({ status: 'error', message: String(error) });
      } finally {
        setBusy(false);
      }
    },
    [spaceId, projection, loadPacket],
  );

  const onDragStart = useCallback((occurrenceId: string, fromColumn: string) => {
    dragRef.current = { occurrenceId, fromColumn };
  }, []);

  const onDropOnColumn = useCallback(
    (columnKey: string) => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (!drag || drag.fromColumn === columnKey) return;
      void persistMove(drag.occurrenceId, columnKey);
    },
    [persistMove],
  );

  // Keyboard move: shift a card one column left/right.
  const onMove = useCallback(
    (occurrenceId: string, direction: -1 | 1) => {
      if (!projection) return;
      const currentIdx = projection.columns.findIndex((c) =>
        c.cards.some((card) => card.occurrence.occurrence.id === occurrenceId),
      );
      if (currentIdx < 0) return;
      const targetIdx = currentIdx + direction;
      if (targetIdx < 0 || targetIdx >= projection.columns.length) return;
      void persistMove(occurrenceId, projection.columns[targetIdx].key);
    },
    [projection, persistMove],
  );

  // Custom-column metadata writes go through the C2 updateSpace PATCH route,
  // preserving any sibling metadata keys.
  const persistBoardMeta = useCallback(
    async (next: BoardMetadata) => {
      if (!spaceId || !model) return;
      setBusy(true);
      try {
        const metadata = writeBoardMetadata(model.space.metadata, next);
        const updated = await updateSpace(spaceId, { metadata });
        setBoardMeta(readBoardMetadata(updated));
        await loadPacket(true);
      } catch (error) {
        setLoad({ status: 'error', message: String(error) });
      } finally {
        setBusy(false);
      }
    },
    [spaceId, model, loadPacket],
  );

  const nextColumnKey = useCallback(
    (base: string): string => {
      const used = new Set(boardMeta.columns.map((c) => c.key));
      let candidate = base;
      let suffix = 2;
      while (used.has(candidate) || !isValidCustomColumnKey(candidate)) {
        candidate = `${base}-${suffix}`;
        suffix += 1;
      }
      return candidate;
    },
    [boardMeta.columns],
  );

  const slugify = (value: string): string =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'column';

  const onAddManual = useCallback(
    (title: string) => {
      const key = nextColumnKey(`col-${slugify(title)}`);
      const order = boardMeta.columns.length;
      const def: CustomColumnDef = { key, title, kind: 'manual', order };
      void persistBoardMeta({ ...boardMeta, columns: [...boardMeta.columns, def] });
    },
    [boardMeta, nextColumnKey, persistBoardMeta],
  );

  const onAddFilter = useCallback(
    (chips: TimelineFilterChip[]) => {
      const scope = predicateForChips(chips);
      if (!scope) return;
      const title = filterRowTitle(chips);
      const key = nextColumnKey(`col-${slugify(title)}`);
      const order = boardMeta.columns.length;
      const def: CustomColumnDef = { key, title, kind: 'filter', order, chips, scope };
      void persistBoardMeta({ ...boardMeta, columns: [...boardMeta.columns, def] });
    },
    [boardMeta, nextColumnKey, persistBoardMeta],
  );

  const onRemoveColumn = useCallback(
    (key: string) => {
      void persistBoardMeta({
        ...boardMeta,
        columns: boardMeta.columns.filter((c) => c.key !== key),
      });
    },
    [boardMeta, persistBoardMeta],
  );

  if (!spaceId) {
    return (
      <div className="space-board" data-testid="space-board">
        <div className="space-board__empty" data-testid="space-board-empty">
          Select a Space to view its board.
        </div>
      </div>
    );
  }

  return (
    <div className="space-board" data-testid="space-board">
      <div className="space-board__toolbar">
        <input
          className="space-board__filter"
          type="search"
          placeholder="Filter cards…"
          aria-label="Filter board cards"
          value={viewState.cardFilter}
          onInput={(event) =>
            setViewState((prior) => ({ ...prior, cardFilter: (event.target as HTMLInputElement).value }))
          }
        />
        <AddColumnForm busy={busy} onAddManual={onAddManual} onAddFilter={onAddFilter} />
      </div>

      <div className="space-board__body" data-testid="space-board-body">
        {load.status === 'loading' ? (
          <div className="space-board__loading">Loading board…</div>
        ) : load.status === 'error' ? (
          <div className="space-board__error" role="alert">
            Failed to load board: {load.message}
          </div>
        ) : projection ? (
          <div className="space-board__columns" role="list" aria-label="Board columns">
            {projection.columns.map((column, index) => (
              <BoardColumnView
                key={column.key}
                column={column}
                index={index}
                columnCount={projection.columns.length}
                collapsed={!!viewState.collapsedColumns[column.key]}
                filter={viewState.cardFilter}
                selectedIds={selectedIds}
                isDropTarget={dragOverColumn === column.key}
                onToggleCollapse={onToggleCollapse}
                onSelect={onSelect}
                onDragStart={onDragStart}
                onDropOnColumn={onDropOnColumn}
                onDragOverColumn={setDragOverColumn}
                onMove={onMove}
                onRemoveColumn={onRemoveColumn}
              />
            ))}
          </div>
        ) : null}

        {projection && projection.danglingOccurrences.length > 0 ? (
          <div className="space-board__dangling" data-testid="space-board-dangling" role="note">
            {projection.danglingOccurrences.length} card(s) reference a missing item.
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default SpaceBoardRenderer;
