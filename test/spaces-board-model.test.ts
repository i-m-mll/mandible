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
  defaultColumnKey,
  issueFactsFromEntity,
  isValidCustomColumnKey,
  BOARD_METADATA_KEY,
  EMPTY_BOARD_METADATA,
  type BoardMetadata,
  type IssueFactsByItemId,
} from '../ui/src/views/spaces/boardModel';
import {
  reconcileBoardViewState,
  normalizeBoardViewState,
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

describe('manual and filter custom columns', () => {
  it('an unknown section_id falls back to the worker_status default (never dropped)', () => {
    const model = buildSpaceViewModel(
      packet([item('i1')], [occ('o1', { item_id: 'i1', section_id: 'col-gone' })]),
    );
    const facts: IssueFactsByItemId = { i1: issueFactsFromEntity('i1', { worker_status: 'blocked' }) };
    const { columns } = projectBoard(model, EMPTY_BOARD_METADATA, facts);
    expect(findColumn(columns, defaultColumnKey('blocked'))!.cards.map((c) => c.occurrence.occurrence.id)).toEqual(['o1']);
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

describe('board view-state persistence + reconciliation', () => {
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
});
