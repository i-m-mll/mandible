// Board-renderer browser-local view state (umbrella de56ffa, child 4d4d364).
//
// Per the project Dataful-UX rule, this is the BROWSER-LOCAL side of the state
// split: collapsed columns, the active card selection, and the free-text card
// filter. It is NOT ledger/canonical state — column DEFINITIONS (custom
// columns) and card PLACEMENT (`section_id`/`sort_key`) are the canonical state
// and live in SQLite via the C2 routes. This view state is persisted in browser
// storage (per Space) so it survives tab switches, refreshes, and SSE
// reconciliation, mirroring the C8 collection view-state pattern.

import { normalizeFilterChips, type TimelineFilterChip } from '../filters/issue-predicate-filter';
import type { SpaceSelection } from './types';

export type BoardViewState = {
  /** Free-text card filter applied across all columns. */
  cardFilter: string;
  renameDrafts: Record<string, string>;
  filterDraft: { chips: TimelineFilterChip[]; token: string; open: boolean };
  scroll: { left: number; columns: Record<string, number> };
  /** Currently selected occurrence/item ids (UI selection, not persisted to the ledger). */
  selection: SpaceSelection;
  /** Collapsed column keys, keyed for stable per-column persistence. */
  collapsedColumns: Record<string, boolean>;
};

export const EMPTY_BOARD_VIEW_STATE: BoardViewState = {
  cardFilter: '',
  renameDrafts: {},
  filterDraft: { chips: [], token: '', open: false },
  scroll: { left: 0, columns: {} },
  selection: { kind: null, ids: [] },
  collapsedColumns: {},
};

const STORAGE_PREFIX = 'mandible.spaces.board';

/** Per-space storage key so each Space keeps its own board view state. */
export function boardStorageKey(projectId: string, spaceId: string): string {
  return `${STORAGE_PREFIX}:${projectId || '_'}:${spaceId}`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Coerce arbitrary stored JSON into a safe, fully-populated board view-state. */
export function normalizeBoardViewState(raw: unknown): BoardViewState {
  if (!isPlainRecord(raw)) return { ...EMPTY_BOARD_VIEW_STATE };
  const cardFilter = typeof raw.cardFilter === 'string' ? raw.cardFilter : '';

  let selection: SpaceSelection = { kind: null, ids: [] };
  if (isPlainRecord(raw.selection)) {
    const kind = raw.selection.kind;
    const ids = Array.isArray(raw.selection.ids)
      ? raw.selection.ids.filter((id): id is string => typeof id === 'string')
      : [];
    selection = {
      kind:
        kind === 'occurrence' || kind === 'edge' || kind === 'item' ? kind : ids.length ? 'occurrence' : null,
      ids,
    };
  }

  const collapsedColumns: Record<string, boolean> = {};
  if (isPlainRecord(raw.collapsedColumns)) {
    for (const [key, value] of Object.entries(raw.collapsedColumns)) {
      if (typeof value === 'boolean') collapsedColumns[key] = value;
    }
  }

  const renameDrafts: Record<string, string> = {};
  if (isPlainRecord(raw.renameDrafts)) for (const [key, value] of Object.entries(raw.renameDrafts)) {
    if (typeof value === 'string') renameDrafts[key] = value;
  }
  const draft = isPlainRecord(raw.filterDraft) ? raw.filterDraft : {};
  const chips = Array.isArray(draft.chips) ? draft.chips.filter((chip): chip is TimelineFilterChip =>
    isPlainRecord(chip) && typeof chip.field === 'string' && Array.isArray(chip.values) && chip.values.every((value) => typeof value === 'string')) : [];
  const rawScroll = isPlainRecord(raw.scroll) ? raw.scroll : {};
  const columns: Record<string, number> = {};
  if (isPlainRecord(rawScroll.columns)) for (const [key, value] of Object.entries(rawScroll.columns)) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) columns[key] = value;
  }
  return { cardFilter, selection, collapsedColumns, renameDrafts,
    filterDraft: { chips: normalizeFilterChips(chips), token: typeof draft.token === 'string' ? draft.token : '', open: draft.open === true },
    scroll: { left: typeof rawScroll.left === 'number' && Number.isFinite(rawScroll.left) && rawScroll.left >= 0 ? rawScroll.left : 0, columns },
  };
}

/**
 * Reconcile prior view-state against the current set of live occurrence/item ids
 * AND the live column keys. SSE refetches are reconciliation inputs, NOT resets:
 * selection and per-column collapse flags are kept for entities/columns that
 * still exist; only those that vanished are dropped. Selection is never cleared
 * just because data refreshed.
 */
export function reconcileBoardViewState(
  prior: BoardViewState,
  liveIds: ReadonlySet<string>,
  liveColumnKeys: ReadonlySet<string>,
): BoardViewState {
  const ids = prior.selection.ids.filter((id) => liveIds.has(id));
  const collapsedColumns: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(prior.collapsedColumns)) {
    if (liveColumnKeys.has(key)) collapsedColumns[key] = value;
  }
  return {
    ...prior,
    renameDrafts: Object.fromEntries(Object.entries(prior.renameDrafts).filter(([key]) => liveColumnKeys.has(key))),
    scroll: { ...prior.scroll, columns: Object.fromEntries(Object.entries(prior.scroll.columns).filter(([key]) => liveColumnKeys.has(key))) },
    selection:
      ids.length === prior.selection.ids.length && ids.length > 0
        ? prior.selection
        : { kind: ids.length ? prior.selection.kind : null, ids },
    collapsedColumns,
  };
}
