// Board / kanban renderer model (umbrella de56ffa, child 4d4d364 / C17).
//
// Pure, side-effect-free helpers that turn a Space fact packet plus a per-Space
// column-definition object (persisted in `spaces.metadata`) into the column /
// card projection a board renderer draws. Kept separate from the `.tsx` so the
// column-derivation and ordering invariants are unit-testable without a DOM.
//
// Data model (FIXED by the issue body, resolves review2's [Blocker]):
//   - Card placement (which column, what order) is stored on OCCURRENCES via
//     `section_id` (the column key) + `sort_key` (lexicographic order within a
//     column). It is never stored on items.
//   - Column DEFINITIONS live in `spaces.metadata` under `BOARD_METADATA_KEY`
//     — a per-Space object inside the existing `metadata_json` column. NO new
//     table, NO schema change.
//   - DEFAULT columns derive from issue `worker_status`. An occurrence with no
//     explicit `section_id` falls into the default column matching its backing
//     issue's resolved `worker_status` (and `none` / unresolved otherwise).
//   - CUSTOM columns are either FILTER-defined (a C7b `TimelineIssuePredicate`
//     evaluated against the resolved issue facts) or MANUAL (membership is the
//     set of occurrences whose `section_id` equals the column key).

import type { Space, SpaceItem, SpaceOccurrence } from '../../api';
import type { ResolvedSpaceOccurrence, SpaceViewModel } from './types';
import type {
  TimelineFilterChip,
  TimelineIssuePredicate,
} from '../filters/issue-predicate-filter';

// --- worker_status default columns ------------------------------------------

/**
 * The issue `worker_status` values the resolver reports, in the board's default
 * column order. `in_progress` is derived from an open or committed work unit
 * (src/ledger/issue-work-state.ts). The board's default columns are exactly
 * these, in this order.
 */
export const WORKER_STATUS_VALUES = [
  'none',
  'in_progress',
  'blocked',
  'pivot-needed',
  'done',
] as const;

export type WorkerStatus = (typeof WORKER_STATUS_VALUES)[number];

/** Column key prefix for the worker_status default columns, kept distinct from custom keys. */
export const DEFAULT_COLUMN_PREFIX = 'worker_status:';

/** The `section_id` / column key for a worker_status default column. */
export function defaultColumnKey(status: WorkerStatus): string {
  return `${DEFAULT_COLUMN_PREFIX}${status}`;
}

/** Parse a default column key back to its worker_status, or null if not a default key. */
export function workerStatusFromColumnKey(key: string): WorkerStatus | null {
  if (!key.startsWith(DEFAULT_COLUMN_PREFIX)) return null;
  const status = key.slice(DEFAULT_COLUMN_PREFIX.length);
  return (WORKER_STATUS_VALUES as readonly string[]).includes(status)
    ? (status as WorkerStatus)
    : null;
}

/** Human-friendly title for a worker_status default column. */
export function defaultColumnTitle(status: WorkerStatus): string {
  switch (status) {
    case 'none':
      return 'Unstarted';
    case 'in_progress':
      return 'In progress';
    case 'blocked':
      return 'Blocked';
    case 'pivot-needed':
      return 'Pivot needed';
    case 'done':
      return 'Done';
    default:
      return status;
  }
}

/** Coerce an arbitrary resolved-entity worker_status into a known value (fallback `none`). */
export function normalizeWorkerStatus(raw: unknown): WorkerStatus {
  return typeof raw === 'string' && (WORKER_STATUS_VALUES as readonly string[]).includes(raw)
    ? (raw as WorkerStatus)
    : 'none';
}

// --- resolved issue facts (for worker_status + filter columns) --------------

/**
 * The subset of issue facts the board derives from the C2 unified resolver
 * (`/api/spaces/resolve`). The resolver returns the bare `ledger_issues` row,
 * plus effective worker status and active labels. Relationship predicates are
 * outside this lightweight projection.
 */
export type IssueFacts = {
  id: string;
  worker_status: WorkerStatus;
  kind: string | null;
  labels: string[];
};

/** A by-item-id map of resolved issue facts, keyed by `SpaceItem.id`. */
export type IssueFactsByItemId = Record<string, IssueFacts>;

/** Build an {@link IssueFacts} record from a resolved issue entity (resolver `entity`). */
export function issueFactsFromEntity(id: string, entity: Record<string, unknown> | null): IssueFacts {
  const labelsRaw = entity?.labels;
  const labels = Array.isArray(labelsRaw)
    ? labelsRaw
        .map((value) =>
          typeof value === 'string'
            ? value
            : value && typeof value === 'object' && typeof (value as { name?: unknown }).name === 'string'
              ? (value as { name: string }).name
              : null,
        )
        .filter((value): value is string => Boolean(value))
    : [];
  return {
    id,
    worker_status: normalizeWorkerStatus(entity?.worker_status),
    kind: typeof entity?.kind === 'string' ? (entity.kind as string) : null,
    labels,
  };
}

// --- custom column definitions (persisted in spaces.metadata) ---------------

/** The key in `spaces.metadata` under which the board column-definition object lives. */
export const BOARD_METADATA_KEY = 'spacesBoard';

/** Schema version for the persisted board metadata, so future migrations are detectable. */
export const BOARD_METADATA_VERSION = 1;

export type CustomColumnKind = 'manual' | 'filter';

/**
 * A persisted custom column definition. Lives in
 * `spaces.metadata.spacesBoard.columns`. `key` doubles as the `section_id`
 * occurrences carry to be members of a MANUAL column. A FILTER column also
 * carries the C7b chips + derived predicate (`scope`).
 */
export type CustomColumnDef = {
  key: string;
  title: string;
  kind: CustomColumnKind;
  /** Display order among custom columns (lower first); ties broken by key. */
  order: number;
  /** Filter columns only: the C7b chips that produced `scope`. */
  chips?: TimelineFilterChip[];
  /** Filter columns only: the derived predicate AST evaluated against issue facts. */
  scope?: TimelineIssuePredicate;
};

/** The persisted per-Space board metadata object. */
export type BoardMetadata = {
  version: number;
  columns: CustomColumnDef[];
};

export const EMPTY_BOARD_METADATA: BoardMetadata = { version: BOARD_METADATA_VERSION, columns: [] };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const CUSTOM_KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

/** Reject keys that collide with default columns or are malformed, so the two namespaces stay disjoint. */
export function isValidCustomColumnKey(key: string): boolean {
  if (typeof key !== 'string') return false;
  if (key.startsWith(DEFAULT_COLUMN_PREFIX)) return false;
  return CUSTOM_KEY_PATTERN.test(key);
}

/** Coerce one stored value into a {@link CustomColumnDef}, or null when invalid. */
function normalizeCustomColumn(raw: unknown, index: number): CustomColumnDef | null {
  if (!isPlainRecord(raw)) return null;
  const key = typeof raw.key === 'string' ? raw.key : null;
  if (!key || !isValidCustomColumnKey(key)) return null;
  const kind: CustomColumnKind = raw.kind === 'filter' ? 'filter' : 'manual';
  const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title : key;
  const order = typeof raw.order === 'number' && Number.isFinite(raw.order) ? raw.order : index;
  const def: CustomColumnDef = { key, title, kind, order };
  if (kind === 'filter') {
    if (Array.isArray(raw.chips)) def.chips = raw.chips as TimelineFilterChip[];
    if (isPlainRecord(raw.scope)) def.scope = raw.scope as TimelineIssuePredicate;
  }
  return def;
}

/**
 * Read + normalize the persisted board metadata from a Space. Tolerant of
 * missing/malformed values: unknown shapes degrade to the empty definition
 * rather than throwing, and invalid columns are dropped (never crashing the
 * board on a hand-edited `metadata_json`).
 */
export function readBoardMetadata(space: Pick<Space, 'metadata'>): BoardMetadata {
  const raw = space.metadata?.[BOARD_METADATA_KEY];
  if (!isPlainRecord(raw)) return { ...EMPTY_BOARD_METADATA, columns: [] };
  const columnsRaw = Array.isArray(raw.columns) ? raw.columns : [];
  const seen = new Set<string>();
  const columns: CustomColumnDef[] = [];
  columnsRaw.forEach((value, index) => {
    const def = normalizeCustomColumn(value, index);
    if (def && !seen.has(def.key)) {
      seen.add(def.key);
      columns.push(def);
    }
  });
  const version =
    typeof raw.version === 'number' && Number.isFinite(raw.version) ? raw.version : BOARD_METADATA_VERSION;
  return { version, columns };
}

/**
 * Merge a new board-metadata object into a Space's full metadata, preserving any
 * sibling metadata keys other features may own. This is what the renderer sends
 * to `updateSpace({ metadata })` — never a bare `{ spacesBoard }` that would
 * clobber unrelated metadata.
 */
export function writeBoardMetadata(
  existing: Record<string, unknown>,
  board: BoardMetadata,
): Record<string, unknown> {
  return {
    ...existing,
    [BOARD_METADATA_KEY]: {
      version: BOARD_METADATA_VERSION,
      columns: board.columns.map((column) => ({
        key: column.key,
        title: column.title,
        kind: column.kind,
        order: column.order,
        ...(column.kind === 'filter' && column.chips ? { chips: column.chips } : {}),
        ...(column.kind === 'filter' && column.scope ? { scope: column.scope } : {}),
      })),
    },
  };
}

// --- predicate evaluation (filter-defined columns) --------------------------

/**
 * Evaluate a C7b `TimelineIssuePredicate` against the locally-resolved issue
 * facts. Fields the bare resolver entity does not expose (`referenced_by`,
 * `parent_subtree`) cannot be evaluated client-side and therefore do NOT match
 * — membership is conservative rather than guessed. `kind` and `label` match
 * when present on the resolved facts.
 */
export function evaluatePredicate(predicate: TimelineIssuePredicate, facts: IssueFacts): boolean {
  switch (predicate.type) {
    case 'and':
      return predicate.predicates.every((child) => evaluatePredicate(child, facts));
    case 'or':
      return predicate.predicates.some((child) => evaluatePredicate(child, facts));
    case 'not':
      return !evaluatePredicate(predicate.predicate, facts);
    case 'label':
      return facts.labels.includes(predicate.name);
    case 'kind':
      return facts.kind === predicate.kind;
    case 'referenced_by':
    case 'parent_subtree':
      // Not resolvable from the bare issue entity; treated as non-matching.
      return false;
    default:
      return false;
  }
}

// --- board projection -------------------------------------------------------

/** A card on the board: a resolved board occurrence joined to its issue facts. */
export type BoardCard = {
  occurrence: ResolvedSpaceOccurrence;
  /** Resolved issue facts for the backing item (worker_status drives default placement). */
  facts: IssueFacts | null;
};

export type BoardColumnKind = 'default' | CustomColumnKind;

/** A rendered board column with its ordered cards. */
export type BoardColumn = {
  key: string;
  title: string;
  kind: BoardColumnKind;
  /** worker_status for default columns; undefined otherwise. */
  workerStatus?: WorkerStatus;
  cards: BoardCard[];
};

export type BoardProjection = {
  columns: BoardColumn[];
  /** Board occurrences whose backing item_id is set but the item is missing from the packet. */
  danglingOccurrences: ResolvedSpaceOccurrence[];
};

/**
 * Stable card ordering within a column: `sort_key` (lexicographic, nulls last) →
 * `created_at` → `id`. Deterministic so SSE reconciliation never reorders
 * identical data.
 */
export function compareBoardCards(a: BoardCard, b: BoardCard): number {
  const ak = a.occurrence.occurrence.sort_key;
  const bk = b.occurrence.occurrence.sort_key;
  if (ak !== bk) {
    if (ak === null) return 1;
    if (bk === null) return -1;
    if (ak < bk) return -1;
    if (ak > bk) return 1;
  }
  if (a.occurrence.occurrence.created_at !== b.occurrence.occurrence.created_at) {
    return a.occurrence.occurrence.created_at - b.occurrence.occurrence.created_at;
  }
  return a.occurrence.occurrence.id < b.occurrence.occurrence.id
    ? -1
    : a.occurrence.occurrence.id > b.occurrence.occurrence.id
      ? 1
      : 0;
}

/**
 * Resolve which column an occurrence belongs to. An explicit `section_id` that
 * names a known column (default or custom) wins. Otherwise the occurrence falls
 * into the default column for its backing issue's `worker_status` (`none` when
 * unresolved/non-issue), so a card is NEVER dropped.
 */
function resolveColumnKey(
  occurrence: SpaceOccurrence,
  facts: IssueFacts | null,
  knownKeys: ReadonlySet<string>,
): string {
  const sectionId = occurrence.section_id;
  if (sectionId && knownKeys.has(sectionId)) return sectionId;
  // No (or unknown) section_id: derive the default worker_status column.
  return defaultColumnKey(facts ? facts.worker_status : 'none');
}

/**
 * Project a view-model + board metadata into ordered columns of cards.
 *
 * Column set = the five worker_status default columns followed by the custom
 * columns (ordered by `order`, then `key`). FILTER columns additionally pull in
 * any card whose issue facts match the predicate, even if its `section_id`
 * points elsewhere — but an explicit manual placement (section_id === column
 * key) always wins, so a user drag is never overridden by a predicate.
 */
export function projectBoard(
  model: SpaceViewModel,
  metadata: BoardMetadata,
  factsByItemId: IssueFactsByItemId,
): BoardProjection {
  const boardOccurrences = model.occurrences.filter((o) => o.renderer === 'board');

  const customColumns = [...metadata.columns].sort((a, b) =>
    a.order !== b.order ? a.order - b.order : a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
  );

  const knownKeys = new Set<string>();
  for (const status of WORKER_STATUS_VALUES) knownKeys.add(defaultColumnKey(status));
  for (const column of customColumns) knownKeys.add(column.key);

  const columns: BoardColumn[] = [
    ...WORKER_STATUS_VALUES.map<BoardColumn>((status) => ({
      key: defaultColumnKey(status),
      title: defaultColumnTitle(status),
      kind: 'default',
      workerStatus: status,
      cards: [],
    })),
    ...customColumns.map<BoardColumn>((column) => ({
      key: column.key,
      title: column.title,
      kind: column.kind,
      cards: [],
    })),
  ];
  const columnByKey = new Map(columns.map((column) => [column.key, column]));

  const danglingOccurrences: ResolvedSpaceOccurrence[] = [];

  for (const resolved of boardOccurrences) {
    const occ = resolved.occurrence;
    if (occ.item_id !== null && resolved.item === null) {
      danglingOccurrences.push(resolved);
      continue;
    }
    const facts = occ.item_id ? factsByItemId[occ.item_id] ?? null : null;
    const card: BoardCard = { occurrence: resolved, facts };

    // 1. Explicit/derived home column (manual placement or worker_status default).
    const homeKey = resolveColumnKey(occ, facts, knownKeys);
    const homeColumn = columnByKey.get(homeKey);
    if (homeColumn) homeColumn.cards.push(card);

    // 2. Filter columns ADDITIONALLY claim a card whose facts match the
    //    predicate, UNLESS the card is already manually placed in this exact
    //    filter column (homeKey === column.key) — which is already handled
    //    above — to avoid duplicating it.
    if (facts) {
      for (const column of customColumns) {
        if (column.kind !== 'filter' || !column.scope) continue;
        if (column.key === homeKey) continue;
        if (evaluatePredicate(column.scope, facts)) {
          columnByKey.get(column.key)?.cards.push(card);
        }
      }
    }
  }

  for (const column of columns) column.cards.sort(compareBoardCards);

  return { columns, danglingOccurrences };
}

// --- sort-key generation (drag persistence) ---------------------------------

const SORT_KEY_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const SORT_MIN = SORT_KEY_ALPHABET[0];
const SORT_MAX = SORT_KEY_ALPHABET[SORT_KEY_ALPHABET.length - 1];

function charIndex(ch: string): number {
  const idx = SORT_KEY_ALPHABET.indexOf(ch);
  return idx < 0 ? 0 : idx;
}

/**
 * Generate a lexicographic `sort_key` strictly between `before` and `after`
 * (either may be null for an open end). The result orders between the two under
 * plain string comparison — the same comparison {@link compareBoardCards} uses —
 * so dropping a card between two neighbors persists a stable order without
 * renumbering siblings. Mirrors the fractional-indexing approach used for
 * canvas/collection ordering.
 */
export function sortKeyBetween(before: string | null, after: string | null): string {
  const lower = before ?? '';
  const upper = after;

  let result = '';
  let i = 0;
  for (;;) {
    const lowerCh = i < lower.length ? lower[i] : SORT_MIN;
    const upperCh = upper && i < upper.length ? upper[i] : SORT_MAX;
    if (lowerCh === upperCh) {
      result += lowerCh;
      i += 1;
      continue;
    }
    const lo = charIndex(lowerCh);
    const hi = upper === null ? SORT_KEY_ALPHABET.length : charIndex(upperCh);
    const mid = Math.floor((lo + hi) / 2);
    if (mid > lo) {
      result += SORT_KEY_ALPHABET[mid];
      return result;
    }
    // No gap at this position: keep the lower char and descend a level.
    result += lowerCh;
    i += 1;
    // Guard against pathological inputs (e.g. before === after): append a mid
    // char one level deeper so the key is still strictly greater than `before`.
    if (i > lower.length + 64) {
      return `${result}${SORT_KEY_ALPHABET[Math.floor(SORT_KEY_ALPHABET.length / 2)]}`;
    }
  }
}

/** A human-friendly display label for an item card (title → ref). */
export function cardLabel(item: SpaceItem | null, fallback: string): string {
  if (!item) return fallback;
  if (item.title && item.title.trim()) return item.title.trim();
  if (item.ref_uri && item.ref_uri.trim()) return item.ref_uri.trim();
  return `${item.ref_type}:${item.ref_id}`;
}

/** The canonical resource-ref string for an item card, for the C6 unresolved-ref UI. */
export { spaceItemRef as cardRefString } from './itemRef';
