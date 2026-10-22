// Board renderer model + view-state tests (umbrella de56ffa, child 4d4d364 /
// C17). These cover the interesting invariants without a DOM:
//   - DEFAULT columns derive from issue `worker_status` (the load-bearing AC)
//   - explicit section_id placement (manual columns) wins over the default
//   - FILTER-defined columns pull in cards by predicate over resolved facts
//   - custom column definitions read/write to spaces.metadata (no new table)
//   - sort_key generation orders strictly between neighbors
//   - view-state persistence + SSE reconciliation never reset surviving state
import { describe, expect, it } from 'vitest';

import type { Space, SpaceItem, SpaceOccurrence, SpaceEdge } from '../ui/src/api';
import { buildSpaceViewModel } from '../ui/src/views/spaces/collectionModel';
import {
  projectBoard,
  readBoardMetadata,
  writeBoardMetadata,
  sortKeyBetween,
  defaultColumnKey,
  workerStatusFromColumnKey,
  normalizeWorkerStatus,
  issueFactsFromEntity,
  evaluatePredicate,
  isValidCustomColumnKey,
  compareBoardCards,
  WORKER_STATUS_VALUES,
  BOARD_METADATA_KEY,
  EMPTY_BOARD_METADATA,
  type BoardMetadata,
  type IssueFactsByItemId,
} from '../ui/src/views/spaces/boardModel';
import {
  reconcileBoardViewState,
  normalizeBoardViewState,
  boardStorageKey,
  EMPTY_BOARD_VIEW_STATE,
} from '../ui/src/views/spaces/boardViewState';

const NOW = 1_700_000_000_000;

function space(overrides: Partial<Space> = {}): Space {
  return {
    id: 'sp1',
    project_id: 'prj1',
    title: 'Board Space',
    default_renderer: 'board',
    description: null,
    metadata: {},
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function item(id: string, overrides: Partial<SpaceItem> = {}): SpaceItem {
  return {
    id,
    space_id: 'sp1',
    ref_type: 'issue',
    ref_id: id,
    ref_uri: null,
    title: null,
    metadata: {},
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function occ(id: string, overrides: Partial<SpaceOccurrence> = {}): SpaceOccurrence {
  return {
    id,
    space_id: 'sp1',
    item_id: null,
    renderer: 'board',
    parent_id: null,
    x: null,
    y: null,
    width: null,
    height: null,
    z_index: null,
    sort_key: null,
    section_id: null,
    note: null,
    metadata: {},
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function packet(items: SpaceItem[], occurrences: SpaceOccurrence[], edges: SpaceEdge[] = [], sp = space()) {
  return { space: sp, items, occurrences, edges };
}

function findColumn(columns: { key: string }[], key: string) {
  return columns.find((c) => c.key === key);
}

describe('board default columns from worker_status', () => {
  it('renders exactly the five worker_status columns in order', () => {
    const model = buildSpaceViewModel(packet([], []));
    const { columns } = projectBoard(model, EMPTY_BOARD_METADATA, {});
    expect(columns.map((c) => c.key)).toEqual(WORKER_STATUS_VALUES.map(defaultColumnKey));
    expect(columns.every((c) => c.kind === 'default')).toBe(true);
  });

  it('places an occurrence in the default column matching its issue worker_status', () => {
    const items = [item('i1'), item('i2'), item('i3')];
    const occs = [
      occ('o1', { item_id: 'i1' }),
      occ('o2', { item_id: 'i2' }),
      occ('o3', { item_id: 'i3' }),
    ];
    const model = buildSpaceViewModel(packet(items, occs));
    const facts: IssueFactsByItemId = {
      i1: issueFactsFromEntity('i1', { worker_status: 'in_progress', kind: 'feature' }),
      i2: issueFactsFromEntity('i2', { worker_status: 'done', kind: 'feature' }),
      // i3 unresolved → falls into the `none` column
    };
    const { columns } = projectBoard(model, EMPTY_BOARD_METADATA, facts);
    expect(findColumn(columns, defaultColumnKey('in_progress'))!.cards.map((c) => c.occurrence.occurrence.id)).toEqual(['o1']);
    expect(findColumn(columns, defaultColumnKey('done'))!.cards.map((c) => c.occurrence.occurrence.id)).toEqual(['o2']);
    expect(findColumn(columns, defaultColumnKey('none'))!.cards.map((c) => c.occurrence.occurrence.id)).toEqual(['o3']);
  });

  it('non-board occurrences are ignored', () => {
    const model = buildSpaceViewModel(
      packet([item('i1')], [occ('o1', { item_id: 'i1', renderer: 'collection' })]),
    );
    const { columns } = projectBoard(model, EMPTY_BOARD_METADATA, {});
    expect(columns.every((c) => c.cards.length === 0)).toBe(true);
  });

  it('round-trips worker_status column keys', () => {
    for (const status of WORKER_STATUS_VALUES) {
      expect(workerStatusFromColumnKey(defaultColumnKey(status))).toBe(status);
    }
    expect(workerStatusFromColumnKey('col-custom')).toBeNull();
  });

  it('normalizes unknown worker_status to none', () => {
    expect(normalizeWorkerStatus('in_progress')).toBe('in_progress');
    expect(normalizeWorkerStatus('garbage')).toBe('none');
    expect(normalizeWorkerStatus(undefined)).toBe('none');
  });
});

describe('manual and filter custom columns', () => {
  it('an explicit section_id matching a manual column wins over the worker_status default', () => {
    const meta: BoardMetadata = {
      version: 1,
      columns: [{ key: 'col-triage', title: 'Triage', kind: 'manual', order: 0 }],
    };
    const model = buildSpaceViewModel(
      packet([item('i1')], [occ('o1', { item_id: 'i1', section_id: 'col-triage' })]),
    );
    const facts: IssueFactsByItemId = {
      i1: issueFactsFromEntity('i1', { worker_status: 'in_progress' }),
    };
    const { columns } = projectBoard(model, meta, facts);
    expect(findColumn(columns, 'col-triage')!.cards.map((c) => c.occurrence.occurrence.id)).toEqual(['o1']);
    // Not double-placed in the worker_status column.
    expect(findColumn(columns, defaultColumnKey('in_progress'))!.cards).toHaveLength(0);
  });

  it('an unknown section_id falls back to the worker_status default (never dropped)', () => {
    const model = buildSpaceViewModel(
      packet([item('i1')], [occ('o1', { item_id: 'i1', section_id: 'col-gone' })]),
    );
    const facts: IssueFactsByItemId = { i1: issueFactsFromEntity('i1', { worker_status: 'blocked' }) };
    const { columns } = projectBoard(model, EMPTY_BOARD_METADATA, facts);
    expect(findColumn(columns, defaultColumnKey('blocked'))!.cards.map((c) => c.occurrence.occurrence.id)).toEqual(['o1']);
  });

  it('a filter column pulls in cards whose facts match its predicate', () => {
    const meta: BoardMetadata = {
      version: 1,
      columns: [
        {
          key: 'col-bugs',
          title: 'Bugs',
          kind: 'filter',
          order: 0,
          scope: { type: 'kind', kind: 'error' as never },
        },
      ],
    };
    const model = buildSpaceViewModel(
      packet([item('i1'), item('i2')], [occ('o1', { item_id: 'i1' }), occ('o2', { item_id: 'i2' })]),
    );
    const facts: IssueFactsByItemId = {
      i1: issueFactsFromEntity('i1', { worker_status: 'in_progress', kind: 'error' }),
      i2: issueFactsFromEntity('i2', { worker_status: 'in_progress', kind: 'feature' }),
    };
    const { columns } = projectBoard(model, meta, facts);
    // o1 matches the filter (kind=error) AND keeps its worker_status home.
    expect(findColumn(columns, 'col-bugs')!.cards.map((c) => c.occurrence.occurrence.id)).toEqual(['o1']);
    expect(findColumn(columns, defaultColumnKey('in_progress'))!.cards.map((c) => c.occurrence.occurrence.id)).toEqual(['o1', 'o2']);
  });

  it('a card manually placed in a filter column is not duplicated by the predicate', () => {
    const meta: BoardMetadata = {
      version: 1,
      columns: [
        {
          key: 'col-bugs',
          title: 'Bugs',
          kind: 'filter',
          order: 0,
          scope: { type: 'kind', kind: 'error' as never },
        },
      ],
    };
    const model = buildSpaceViewModel(
      packet([item('i1')], [occ('o1', { item_id: 'i1', section_id: 'col-bugs' })]),
    );
    const facts: IssueFactsByItemId = { i1: issueFactsFromEntity('i1', { worker_status: 'done', kind: 'error' }) };
    const { columns } = projectBoard(model, meta, facts);
    expect(findColumn(columns, 'col-bugs')!.cards).toHaveLength(1);
  });

  it('surfaces dangling occurrences (item_id set, item missing)', () => {
    const model = buildSpaceViewModel(packet([], [occ('o1', { item_id: 'missing' })]));
    const { columns, danglingOccurrences } = projectBoard(model, EMPTY_BOARD_METADATA, {});
    expect(danglingOccurrences.map((o) => o.occurrence.id)).toEqual(['o1']);
    expect(columns.every((c) => c.cards.length === 0)).toBe(true);
  });
});

describe('predicate evaluation over resolved issue facts', () => {
  const facts = issueFactsFromEntity('i1', {
    worker_status: 'in_progress',
    kind: 'feature',
    labels: ['auth', 'ui'],
  });

  it('matches label and kind, and combines with and/or/not', () => {
    expect(evaluatePredicate({ type: 'label', name: 'auth' }, facts)).toBe(true);
    expect(evaluatePredicate({ type: 'label', name: 'absent' }, facts)).toBe(false);
    expect(evaluatePredicate({ type: 'kind', kind: 'feature' as never }, facts)).toBe(true);
    expect(
      evaluatePredicate(
        { type: 'and', predicates: [{ type: 'label', name: 'auth' }, { type: 'kind', kind: 'feature' as never }] },
        facts,
      ),
    ).toBe(true);
    expect(evaluatePredicate({ type: 'not', predicate: { type: 'label', name: 'auth' } }, facts)).toBe(false);
    expect(
      evaluatePredicate({ type: 'or', predicates: [{ type: 'label', name: 'x' }, { type: 'label', name: 'ui' }] }, facts),
    ).toBe(true);
  });

  it('treats relationship predicates the bare entity cannot resolve as non-matching', () => {
    expect(evaluatePredicate({ type: 'referenced_by', issue_id: 'x' }, facts)).toBe(false);
    expect(evaluatePredicate({ type: 'parent_subtree', issue_id: 'x' }, facts)).toBe(false);
  });

  it('extracts labels from object-shaped entries', () => {
    const f = issueFactsFromEntity('i', { labels: [{ name: 'a' }, 'b', { nope: 1 }] });
    expect(f.labels).toEqual(['a', 'b']);
  });
});

describe('board metadata read/write (spaces.metadata, no new table)', () => {
  it('reads custom columns from spaces.metadata and drops invalid ones', () => {
    const sp = space({
      metadata: {
        [BOARD_METADATA_KEY]: {
          version: 1,
          columns: [
            { key: 'col-a', title: 'A', kind: 'manual', order: 1 },
            { key: 'worker_status:done', title: 'bad', kind: 'manual', order: 0 }, // collides with default → dropped
            { key: 'col-a', title: 'dupe', kind: 'manual', order: 2 }, // duplicate key → dropped
            { nope: true }, // malformed → dropped
          ],
        },
      },
    });
    const meta = readBoardMetadata(sp);
    expect(meta.columns.map((c) => c.key)).toEqual(['col-a']);
  });

  it('returns the empty definition for a Space with no board metadata', () => {
    expect(readBoardMetadata(space()).columns).toEqual([]);
  });

  it('writeBoardMetadata preserves sibling metadata keys', () => {
    const existing = { other: { keep: 1 } };
    const next = writeBoardMetadata(existing, {
      version: 1,
      columns: [{ key: 'col-a', title: 'A', kind: 'filter', order: 0, scope: { type: 'kind', kind: 'feature' as never } }],
    });
    expect(next.other).toEqual({ keep: 1 });
    const board = (next[BOARD_METADATA_KEY] as { columns: { key: string; scope?: unknown }[] });
    expect(board.columns[0].key).toBe('col-a');
    expect(board.columns[0].scope).toEqual({ type: 'kind', kind: 'feature' });
  });

  it('rejects custom keys that collide with default columns', () => {
    expect(isValidCustomColumnKey('col-a')).toBe(true);
    expect(isValidCustomColumnKey('worker_status:done')).toBe(false);
    expect(isValidCustomColumnKey('')).toBe(false);
  });
});

describe('sort_key generation', () => {
  it('produces a key strictly between two neighbors', () => {
    const mid = sortKeyBetween('a', 'c');
    expect(mid > 'a').toBe(true);
    expect(mid < 'c').toBe(true);
  });

  it('produces a key after the last when after is null', () => {
    const k = sortKeyBetween('m', null);
    expect(k > 'm').toBe(true);
  });

  it('produces a key before the first when before is null', () => {
    const k = sortKeyBetween(null, 'm');
    expect(k < 'm').toBe(true);
  });

  it('orders multiple sequential appends', () => {
    let prev: string | null = null;
    const keys: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const k = sortKeyBetween(prev, null);
      keys.push(k);
      prev = k;
    }
    const sorted = [...keys].sort();
    expect(keys).toEqual(sorted);
  });

  it('compareBoardCards orders by sort_key with nulls last', () => {
    const cardWith = (id: string, sort_key: string | null) => ({
      occurrence: {
        occurrence: occ(id, { sort_key }),
        item: null,
        renderer: 'board' as const,
      },
      facts: null,
    });
    const arr = [cardWith('a', null), cardWith('b', 'm'), cardWith('c', 'a')];
    arr.sort(compareBoardCards);
    expect(arr.map((c) => c.occurrence.occurrence.id)).toEqual(['c', 'b', 'a']);
  });
});

describe('board view-state persistence + reconciliation', () => {
  it('keeps the established per-space storage key', () => {
    expect(boardStorageKey('prj1', 'sp1')).toBe('mandible.spaces.board:prj1:sp1');
    expect(boardStorageKey('', 'sp1')).toBe('mandible.spaces.board:_:sp1');
  });

  it('normalizes malformed stored JSON to a safe state', () => {
    expect(normalizeBoardViewState(null)).toEqual(EMPTY_BOARD_VIEW_STATE);
    expect(normalizeBoardViewState({ collapsedColumns: { x: 'nope' } }).collapsedColumns).toEqual({});
  });

  it('reconcile keeps surviving selection/collapse and drops vanished ids/columns (no reset)', () => {
    const prior = {
      cardFilter: 'q',
      selection: { kind: 'occurrence' as const, ids: ['o1', 'gone'] },
      collapsedColumns: { 'worker_status:done': true, 'col-removed': true },
    };
    const next = reconcileBoardViewState(
      prior,
      new Set(['o1']),
      new Set(['worker_status:done']),
    );
    expect(next.cardFilter).toBe('q'); // filter preserved
    expect(next.selection.ids).toEqual(['o1']); // vanished id dropped, surviving kept
    expect(next.collapsedColumns).toEqual({ 'worker_status:done': true }); // removed column dropped
  });

  it('reconcile does not clear selection just because data refreshed (identical ids)', () => {
    const prior = {
      cardFilter: '',
      selection: { kind: 'occurrence' as const, ids: ['o1'] },
      collapsedColumns: {},
    };
    const next = reconcileBoardViewState(prior, new Set(['o1', 'o2']), new Set());
    expect(next.selection).toBe(prior.selection);
  });
});
