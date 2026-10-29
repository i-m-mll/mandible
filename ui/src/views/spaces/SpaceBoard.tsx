import { useBoardIssueFacts } from '../../query/boardIssues';
import { Icon } from '../../components/icons/Icon';
// Board / kanban renderer (umbrella de56ffa, child 4d4d364 / C17).
//
// A real board renderer over `space_occurrences` with renderer='board':
// columns/swimlanes via `section_id`, ordered within a column by `sort_key`.
//
//   - DEFAULT columns derive from issue `worker_status` (boardModel). An
//     occurrence with no explicit `section_id` falls into the default column
//     for its backing issue's resolved worker_status — resolved through the
//     read-only C2 resolver (`resolveResourceRef`), owned by one Query per ref/context.
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

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type StateUpdater } from 'preact/hooks';
import { DetailPaneNotice } from '../../components/shared/DetailPaneNotice';

import {
  createSpaceOccurrence,
  updateSpace,
  updateSpaceOccurrence,
  type Space,
  type SpaceItem,
} from '../../api';
import {
  parseResourceRef,
  resourceRefHref,
  displayResourceRef,
} from '../../resource-refs';
import { usePersistedViewState } from '../../hooks/usePersistedViewState';
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
  defaultColumnKey,
  isValidCustomColumnKey,
  cardLabel,
  cardRefString,
  type BoardColumn,
  type BoardCard,
  type BoardMetadata,
  type CustomColumnDef,
} from './boardModel';
import {
  boardStorageKey,
  normalizeBoardViewState,
  reconcileBoardViewState,
  EMPTY_BOARD_VIEW_STATE,
  type BoardViewState,
} from './boardViewState';
import { SpaceItemPicker } from './SpaceItemPicker';
import './space-board.css';

const EMPTY_BOARD_METADATA: BoardMetadata = { version: 1, columns: [] };

/** Case-insensitive card filter. */
function matchesFilter(label: string, ref: string, filter: string): boolean {
  if (!filter.trim()) return true;
  const needle = filter.trim().toLowerCase();
  return label.toLowerCase().includes(needle) || ref.toLowerCase().includes(needle);
}

function createBoardShellModel(projectId: string, spaceId: string): SpaceViewModel {
  const space: Space = {
    id: spaceId,
    project_id: projectId,
    title: 'Board',
    description: null,
    default_renderer: 'board',
    metadata: {},
    created_at: 0,
    updated_at: 0,
  };
  return { space, itemsById: {}, occurrences: [], edges: [] };
}

/**
 * Inline unresolved-ref affordance for one card's item ref (shared C6 UI). The
 * ref starts as a quiet unresolved link/label; no raw ref text is injected as
 * HTML and no always-visible resolve button clutters normal cards.
 */
function CardRef({ item }: { item: SpaceItem }): JSX.Element {
  const ref = cardRefString(item);
  const parsed = useMemo(() => parseResourceRef(ref), [ref]);

  const label = cardLabel(item, parsed ? parsed.display : displayResourceRef(ref));
  const href = parsed ? resourceRefHref(parsed.canonical) : undefined;

  return (
    <span
      className="space-board__ref resource-ref resource-ref--unresolved"
      data-resource-ref={parsed ? parsed.canonical : ref}
      data-resource-kind={parsed ? parsed.kind : 'unknown'}
      data-ref-state="unresolved"
      title={`Resource reference ${ref}`}
    >
      {href ? (
        <a className="artifact-xref resource-ref__link" href={href}>
          {label}
        </a>
      ) : (
        <span className="resource-ref__link">{label}</span>
      )}
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
  renameDraft: string | undefined;
  onRenameDraft: (key: string, draft: string | undefined) => void;
  scrollTop: number;
  scrollIdentity: string;
  onScrollTop: (key: string, top: number) => void;
  busy: boolean;
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
  onRenameColumn: (key: string, title: string) => void;
  onAddItemsToColumn: (key: string) => void;
};

function BoardColumnView({
  column,
  renameDraft, onRenameDraft, scrollTop, scrollIdentity, onScrollTop,
  busy,
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
  onRenameColumn,
  onAddItemsToColumn,
}: ColumnProps): JSX.Element {
  const renaming = renameDraft !== undefined;
  const draftTitle = renameDraft ?? column.title;
  const setDraftTitle = (draft: string) => onRenameDraft(column.key, draft);
  const setRenaming = (next: boolean) => onRenameDraft(column.key, next ? draftTitle : undefined);
  const cardsRef = useRef<HTMLUListElement>(null);
  const visibleCards = column.cards.filter((card) => {
    const item = card.occurrence.item;
    const label = item ? cardLabel(item, '') : card.occurrence.occurrence.note ?? '';
    const ref = item ? cardRefString(item) : '';
    return matchesFilter(label, ref, filter);
  });

  const restoringScroll = useRef(true);
  useLayoutEffect(() => { restoringScroll.current = true; }, [collapsed, scrollIdentity]);
  useLayoutEffect(() => {
    if (!cardsRef.current || !restoringScroll.current) return;
    cardsRef.current.scrollTop = scrollTop;
    if (cardsRef.current.scrollTop === scrollTop) restoringScroll.current = false;
  }, [collapsed, scrollIdentity, scrollTop, visibleCards.length]);

  const custom = column.kind !== 'default';
  const saveRename = useCallback(() => {
    if (!custom || busy) return;
    const next = draftTitle.trim() || 'Untitled';
    setDraftTitle(next);
    setRenaming(false);
    if (next !== column.title) onRenameColumn(column.key, next);
  }, [busy, column.key, column.title, custom, draftTitle, onRenameColumn]);

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
          <Icon name={collapsed ? 'sectionCollapsed' : 'sectionExpanded'} />
        </button>
        {custom && renaming ? (
          <input
            className="space-board__column-title-input"
            aria-label={`Rename column ${column.title}`}
            value={draftTitle}
            disabled={busy}
            autoFocus
            onInput={(event) => setDraftTitle((event.target as HTMLInputElement).value)}
            onBlur={saveRename}
            onKeyDown={(event) => {
              if (event.key === 'Enter') saveRename();
              if (event.key === 'Escape') {
                setDraftTitle(column.title);
                setRenaming(false);
              }
            }}
          />
        ) : (
          <button
            type="button"
            className="space-board__column-title"
            disabled={!custom || busy}
            onDblClick={() => custom && !busy && setRenaming(true)}
            onKeyDown={(event) => {
              if (custom && !busy && event.key === 'Enter') setRenaming(true);
            }}
            title={custom ? 'Rename column' : column.title}
          >
            {column.title}
          </button>
        )}
        <span className="space-board__column-count" aria-label={`${visibleCards.length} cards`}>
          {visibleCards.length}
        </span>
        <button
          type="button"
          className="space-board__column-add"
          aria-label={`Add items to ${column.title}`}
          title="Add items"
          onClick={() => onAddItemsToColumn(column.key)}
        >
          <Icon name="add" />
          </button>
        {custom ? (
          <button
            type="button"
            className="space-board__column-remove"
            aria-label={`Delete column ${column.title}`}
            disabled={busy}
            title="Delete custom column"
            onClick={() => onRemoveColumn(column.key)}
          >
            <Icon name="dismiss" />
          </button>
        ) : null}
      </header>
      {!collapsed ? (
        <ul ref={cardsRef}
          onWheel={() => { restoringScroll.current = false; }}
          onPointerDown={() => { restoringScroll.current = false; }}
          onTouchStart={() => { restoringScroll.current = false; }}
          onKeyDown={() => { restoringScroll.current = false; }}
          onScroll={(event) => { if (!restoringScroll.current) onScrollTop(column.key, event.currentTarget.scrollTop); }} className="space-board__cards" role="list" data-testid={`board-column-${column.key}`}>
          {visibleCards.length === 0 ? (
            <li className="space-board__column-empty">
              {filter.trim() ? (
                'No matching cards'
              ) : (
                <button
                  type="button"
                  className="space-board__column-empty-add"
                  onClick={() => onAddItemsToColumn(column.key)}
                >
                  Add items
                </button>
              )}
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

/** Compact menu to add custom columns: manual (membership by drag) or filter (C7b predicate). */
function AddColumnMenu({
  busy,
  draft, onDraft,
  onAddManual,
  onAddFilter,
}: {
  busy: boolean;
  draft: BoardViewState['filterDraft'];
  onDraft: (draft: StateUpdater<BoardViewState['filterDraft']>) => void;
  onAddManual: () => void;
  onAddFilter: (chips: TimelineFilterChip[]) => void;
}): JSX.Element {
  const chips = draft.chips;
  const setChips = (next: TimelineFilterChip[] | ((prior: TimelineFilterChip[]) => TimelineFilterChip[])) => onDraft((prior) => ({ ...prior, chips: typeof next === 'function' ? next(prior.chips) : next }));

  const normalizedChips = useMemo(() => normalizeFilterChips(chips), [chips]);
  const previewTitle = useMemo(() => filterRowTitle(normalizedChips), [normalizedChips]);
  const projecting = useMemo(() => predicateForChips(normalizedChips) !== null, [normalizedChips]);

  const onAddToken = (token: string): boolean => {
    const chip = parseFilterToken(token);
    if (!chip) return false;
    setChips((prior) => [...prior, chip]);
    return true;
  };

  const onRemoveChip = (index: number) => {
    setChips((prior) => prior.filter((_, i) => i !== index));
  };

  return (
    <details open={draft.open} onToggle={(event) => {
      const open = event.currentTarget.open;
      if (open !== draft.open) onDraft((prior) => ({ ...prior, open }));
    }} className="space-board__add-column" data-testid="board-add-column">
      <summary className="space-board__toolbar-btn" aria-label="Board column actions">
        Columns
      </summary>
      <div className="space-board__add-column-menu">
        <button
          type="button"
          className="space-board__add-column-btn"
          disabled={busy}
          onClick={() => onAddManual()}
        >
          Add manual column
        </button>
        <div className="space-board__add-filter-column">
          <div className="space-board__add-filter-title">Add filter column</div>
        <IssuePredicateFilter
          chips={normalizedChips}
          draftToken={draft.token}
          onDraftTokenChange={(token) => onDraft((prior) => ({ ...prior, token }))}
          projecting={projecting}
          previewTitle={previewTitle}
          onAddToken={onAddToken}
          onRemoveChip={onRemoveChip}
          onCancel={() => onDraft({ chips: [], token: '', open: draft.open })}
          onSave={() => {
            if (projecting) {
              onAddFilter(normalizedChips);
              onDraft({ chips: [], token: '', open: draft.open });
            }
          }}
          canSave={projecting && !busy}
          saveLabel="Add filter column"
          ariaLabel="Add filter column"
          classPrefix="space-board-filter"
        />
        </div>
      </div>
    </details>
  );
}

export function SpaceBoardRenderer({ projectId, spaceId, factPacket }: SpaceRendererMountProps): JSX.Element {
  const model = useMemo(() => factPacket ? buildSpaceViewModel(factPacket) : null, [factPacket]);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const error = mutationError;
  const [viewState, setViewState] = usePersistedViewState(
    spaceId ? boardStorageKey(projectId, spaceId) : '',
    normalizeBoardViewState,
    EMPTY_BOARD_VIEW_STATE,
  );
  const boardMeta = useMemo(() => model ? readBoardMetadata(model.space) : EMPTY_BOARD_METADATA, [model]);
  const issueReads = useBoardIssueFacts(model);
  const factsByItemId = issueReads.facts;
  const [mutationBusy, setBusy] = useState(false);
  const [metadataAck, setMetadataAck] = useState<{ source: object; hash: string } | null>(null);
  const busy = mutationBusy || metadataAck !== null;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerColumnKey, setPickerColumnKey] = useState<string | null>(null);
  const [dragOverColumn, setDragOverColumn] = useState<string | null>(null);

  const columnsRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (columnsRef.current) columnsRef.current.scrollLeft = viewState.scroll.left;
  }, [spaceId, projectId, Boolean(model)]);
  const onRenameDraft = useCallback((key: string, draft: string | undefined) => {
    setViewState((prior) => {
      const renameDrafts = { ...prior.renameDrafts };
      if (draft === undefined) delete renameDrafts[key]; else renameDrafts[key] = draft;
      return { ...prior, renameDrafts };
    });
  }, [setViewState]);
  const onColumnScroll = useCallback((key: string, top: number) => {
    setViewState((prior) => ({ ...prior, scroll: { ...prior.scroll, columns: { ...prior.scroll.columns, [key]: top } } }));
  }, [setViewState]);
  const dragRef = useRef<{ occurrenceId: string; fromColumn: string } | null>(null);
  const addSortKeysRef = useRef<Record<string, string | null>>({});
  useEffect(() => {
    if (metadataAck && model && (model.space !== metadataAck.source || JSON.stringify(boardMeta) === metadataAck.hash)) setMetadataAck(null);
  }, [boardMeta, model, metadataAck]);

  const shellModel = useMemo(
    () => (spaceId ? createBoardShellModel(projectId, spaceId) : null),
    [projectId, spaceId],
  );
  const projectionModel = model ?? shellModel;

  const projection = useMemo(
    () => (projectionModel ? projectBoard(projectionModel, boardMeta, factsByItemId) : null),
    [projectionModel, boardMeta, factsByItemId],
  );

  // Reconcile view-state against live ids + column keys (never a reset).
  useEffect(() => {
    if (!projection || !model) return;
    const liveColumnKeys = new Set(projection.columns.map((c) => c.key));
    setViewState((prior) => reconcileBoardViewState(prior, new Set([...model.occurrences.map((entry) => entry.occurrence.id), ...Object.keys(model.itemsById)]), liveColumnKeys));
  }, [model, projection]);

  const selectedIds = useMemo(() => new Set(viewState.selection.ids), [viewState.selection.ids]);

  const items = model ? Object.values(model.itemsById) : [];

  const isItemOnBoard = useCallback(
    (item: SpaceItem) =>
      Boolean(model?.occurrences.some((occurrence) => occurrence.renderer === 'board' && occurrence.item?.id === item.id)),
    [model],
  );

  const openItemPicker = useCallback(
    (columnKey: string | null) => {
      setPickerColumnKey(columnKey);
      const keys: Record<string, string | null> = {};
      if (projection) {
        for (const column of projection.columns) {
          const last = column.cards[column.cards.length - 1]?.occurrence.occurrence.sort_key ?? null;
          keys[column.key] = last;
        }
      }
      addSortKeysRef.current = keys;
      setPickerOpen((open) => (open && pickerColumnKey === columnKey ? false : true));
    },
    [pickerColumnKey, projection],
  );

  const addBoardItem = useCallback(
    async (item: SpaceItem) => {
      if (!spaceId || isItemOnBoard(item)) return;
      const columnKey = pickerColumnKey ?? defaultColumnKey('none');
      const lastKey = addSortKeysRef.current[columnKey] ?? null;
      const sortKey = sortKeyBetween(lastKey, null);
      addSortKeysRef.current[columnKey] = sortKey;
      await createSpaceOccurrence(spaceId, {
        item_id: item.id,
        renderer: 'board',
        section_id: columnKey,
        sort_key: sortKey,
      });
    },
    [spaceId, pickerColumnKey, isItemOnBoard],
  );

  const onSelect = useCallback((occurrenceId: string) => {
    setViewState((prior) => ({ ...prior, selection: { kind: 'occurrence', ids: [occurrenceId] } }));
  }, [setViewState]);

  const onToggleCollapse = useCallback((key: string) => {
    setViewState((prior) => ({
      ...prior,
      collapsedColumns: { ...prior.collapsedColumns, [key]: !prior.collapsedColumns[key] },
    }));
  }, [setViewState]);

  // Persist a card's move to a target column: write section_id + a sort_key that
  // places it at the end of the destination column, via the C2 occurrence route.
  const persistMove = useCallback(
    async (occurrenceId: string, toColumnKey: string) => {
      if (!spaceId || !projection) return;
      const target = projection.columns.find((c) => c.key === toColumnKey);
      const lastCard = target && target.cards.length > 0 ? target.cards[target.cards.length - 1] : null;
      const lastKey = lastCard ? lastCard.occurrence.occurrence.sort_key : null;
      const sortKey = sortKeyBetween(lastKey, null);
      setMutationError(null);
      setBusy(true);
      try {
        await updateSpaceOccurrence(spaceId, occurrenceId, {
          section_id: toColumnKey,
          sort_key: sortKey,
        });
      } catch (error) {
        setMutationError(String(error));
      } finally {
        setBusy(false);
      }
    },
    [spaceId, projection],
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
      if (!spaceId || !model || busy) return;
      setMutationError(null);
      setBusy(true);
      try {
        const metadata = writeBoardMetadata(model.space.metadata, next);
        const updated = await updateSpace(spaceId, { metadata });
        setMetadataAck({ source: model.space, hash: JSON.stringify(readBoardMetadata(updated)) });
      } catch (error) {
        setMutationError(String(error));
      } finally {
        setBusy(false);
      }
    },
    [spaceId, model, busy],
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
    () => {
      const key = nextColumnKey(`manual:${Date.now().toString(36)}`);
      const order = boardMeta.columns.length;
      const def: CustomColumnDef = { key, title: 'Untitled', kind: 'manual', order };
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
      const column = boardMeta.columns.find((c) => c.key === key);
      if (!column) return;
      const message = `Delete column "${column.title}"? Cards in this column will stay in the Space and move back to their default board grouping.`;
      if (typeof window !== 'undefined' && !window.confirm(message)) return;
      void persistBoardMeta({
        ...boardMeta,
        columns: boardMeta.columns.filter((c) => c.key !== key),
      });
    },
    [boardMeta, persistBoardMeta],
  );

  const onRenameColumn = useCallback(
    (key: string, title: string) => {
      const normalized = title.trim() || 'Untitled';
      void persistBoardMeta({
        ...boardMeta,
        columns: boardMeta.columns.map((column) =>
          column.key === key ? { ...column, title: normalized } : column,
        ),
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
        <div className="space-board__toolbar-actions">
          <button
            type="button"
            className="space-board__toolbar-btn space-board__toolbar-btn--primary"
            aria-haspopup="dialog"
            aria-expanded={pickerOpen}
            disabled={busy}
            data-testid="space-board-add-items"
            onClick={() => openItemPicker(null)}
          >
            <Icon name="add" /> Add items
          </button>
          <AddColumnMenu draft={viewState.filterDraft} onDraft={(next) => setViewState((prior) => ({ ...prior, filterDraft: typeof next === 'function' ? next(prior.filterDraft) : next }))} busy={busy} onAddManual={onAddManual} onAddFilter={onAddFilter} />
          {pickerOpen ? (
            <div className="space-board__picker-anchor">
              <SpaceItemPicker
                spaceId={spaceId}
                projectId={projectId}
                existingItems={items}
                isItemInView={isItemOnBoard}
                alreadyInViewLabel="Already on board"
                afterAdd={addBoardItem}
                onClose={() => setPickerOpen(false)}
              />
            </div>
          ) : null}
        </div>
      </div>

      {error && (
        <DetailPaneNotice severity="error" density="compact" title="Could not load board">{error}</DetailPaneNotice>
      )}
      {issueReads.failed.length > 0 ? (
        <DetailPaneNotice severity="error" density="compact" title="Could not refresh issue facts">
          Some cards have unavailable or older issue facts. <button type="button" onClick={() => issueReads.failed.forEach((read) => { void read.refetch(); })}>Retry issue facts</button>
        </DetailPaneNotice>
      ) : issueReads.pending ? <div role="status">Resolving issue facts…</div> : null}
      <div className="space-board__body" data-testid="space-board-body">
        {!model && !error ? (
          <div className="space-board__loading" role="status">
            Loading cards…
          </div>
        ) : null}
        {!model && error ? <div className="space-board__empty">Board unavailable.</div> : null}
        {projection ? (
          <div ref={columnsRef} onScroll={(event) => { const left = event.currentTarget.scrollLeft; setViewState((prior) => ({ ...prior, scroll: { ...prior.scroll, left } })); }} className="space-board__columns" role="list" aria-label="Board columns">
            {projection.columns.map((column, index) => (
              <BoardColumnView
                key={column.key}
                column={column}
                renameDraft={viewState.renameDrafts[column.key]}
                onRenameDraft={onRenameDraft}
                scrollTop={viewState.scroll.columns[column.key] ?? 0}
                scrollIdentity={boardStorageKey(projectId, spaceId)}
                onScrollTop={onColumnScroll}
                busy={busy}
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
                onRenameColumn={onRenameColumn}
                onAddItemsToColumn={openItemPicker}
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
