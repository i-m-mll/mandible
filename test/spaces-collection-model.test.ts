// Collection renderer model/tree + view-state tests (umbrella de56ffa, C8 /
// issue fa83ec7). These cover the interesting invariants without a DOM:
//   - occurrence→item join + effective renderer
//   - tree projection by parent_id/sort_key/section_id
//   - the UNPLACED SHELF (item-only membership is never lost; review2 C7)
//   - dangling occurrences (item_id set, item missing) are surfaced
//   - view-state persistence + SSE reconciliation never resets surviving state
import { describe, expect, it } from 'vitest';

import type { Space, SpaceItem, SpaceOccurrence, SpaceEdge } from '../ui/src/api';
import {
  buildSpaceViewModel,
  projectCollection,
} from '../ui/src/views/spaces/collectionModel';
import {
  reconcileCollectionViewState,
  normalizeCollectionViewState,
} from '../ui/src/views/spaces/collectionViewState';

const NOW = 1_700_000_000_000;

function space(overrides: Partial<Space> = {}): Space {
  return {
    id: 'sp1',
    project_id: 'prj1',
    title: 'Test Space',
    default_renderer: 'collection',
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
    renderer: 'collection',
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

function packet(items: SpaceItem[], occurrences: SpaceOccurrence[], edges: SpaceEdge[] = []) {
  return { space: space(), items, occurrences, edges };
}

describe('projectCollection — tree + ordering', () => {
  it('promotes an occurrence with a missing parent to a root rather than dropping it', () => {
    const model = buildSpaceViewModel(
      packet([item('a')], [occ('orphan', { item_id: 'a', parent_id: 'ghost' })]),
    );
    const { roots } = projectCollection(model);
    expect(roots.map((r) => r.occurrence.occurrence.id)).toEqual(['orphan']);
  });

  it('breaks a parent cycle by promoting to root (never infinite-loops)', () => {
    const model = buildSpaceViewModel(
      packet(
        [item('a'), item('b')],
        [occ('x', { item_id: 'a', parent_id: 'y' }), occ('y', { item_id: 'b', parent_id: 'x' })],
      ),
    );
    const { roots } = projectCollection(model);
    // Both are reachable-as-root because the cycle is detected.
    expect(roots.length).toBeGreaterThanOrEqual(1);
  });
});

describe('projectCollection — unplaced shelf (review2 C7)', () => {
  it('does not lose any item: placed + unplaced together cover every item', () => {
    const items = [item('a'), item('b'), item('c'), item('d')];
    const model = buildSpaceViewModel(
      packet(items, [occ('o1', { item_id: 'a' }), occ('o2', { item_id: 'b' })]),
    );
    const { roots, unplaced } = projectCollection(model);
    const placed = roots.map((r) => r.occurrence.item?.id);
    const covered = new Set([...placed, ...unplaced.map((i) => i.id)]);
    for (const it of items) expect(covered.has(it.id)).toBe(true);
  });
});

describe('projectCollection — dangling occurrences', () => {
  it('collects occurrences whose backing item is missing from the packet', () => {
    const model = buildSpaceViewModel(packet([], [occ('o', { item_id: 'gone' })]));
    const { danglingOccurrences } = projectCollection(model);
    expect(danglingOccurrences.map((o) => o.occurrence.id)).toEqual(['o']);
  });
});

describe('collection view-state persistence', () => {
  it('normalizes partial/garbage shapes into a safe view state', () => {
    const norm = normalizeCollectionViewState({ itemFilter: 5, selection: { ids: ['a', 2] }, collapsed: { x: 'no', y: true } });
    expect(norm.itemFilter).toBe('');
    expect(norm.selection.ids).toEqual(['a']);
    expect(norm.collapsed).toEqual({ y: true });
  });
});

describe('reconcileCollectionViewState — SSE never resets surviving state', () => {
  it('keeps selection/collapse for still-live ids and drops only vanished ones', () => {
    const prior = {
      itemFilter: 'keep',
      selection: { kind: 'occurrence' as const, ids: ['o1', 'gone'] },
      collapsed: { o1: true, gone: true },
    };
    const next = reconcileCollectionViewState(prior, new Set(['o1']));
    expect(next.itemFilter).toBe('keep');
    expect(next.selection.ids).toEqual(['o1']);
    expect(next.collapsed).toEqual({ o1: true });
  });
});
