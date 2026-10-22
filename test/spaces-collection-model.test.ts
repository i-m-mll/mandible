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
  compareCollectionOccurrences,
  itemDisplayLabel,
  itemRefString,
} from '../ui/src/views/spaces/collectionModel';
import {
  reconcileCollectionViewState,
  normalizeCollectionViewState,
  collectionStorageKey,
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

describe('buildSpaceViewModel', () => {
  it('joins occurrences to their backing items and indexes items by id', () => {
    const model = buildSpaceViewModel(
      packet([item('i1', { title: 'One' })], [occ('o1', { item_id: 'i1' })]),
    );
    expect(model.itemsById.i1.title).toBe('One');
    expect(model.occurrences[0].item?.id).toBe('i1');
    expect(model.occurrences[0].renderer).toBe('collection');
  });

  it('falls back the effective renderer to a collection-safe default for document spaces', () => {
    const model = buildSpaceViewModel({
      ...packet([], [occ('o1', { renderer: undefined as never })]),
      space: space({ default_renderer: 'document' }),
    });
    expect(model.occurrences[0].renderer).toBe('collection');
  });
});

describe('projectCollection — tree + ordering', () => {
  it('builds a parent/child tree ordered by sort_key', () => {
    const model = buildSpaceViewModel(
      packet(
        [item('a'), item('b'), item('c')],
        [
          occ('root', { item_id: 'a', sort_key: 'a' }),
          occ('child2', { item_id: 'c', parent_id: 'root', sort_key: 'b' }),
          occ('child1', { item_id: 'b', parent_id: 'root', sort_key: 'a' }),
        ],
      ),
    );
    const { roots } = projectCollection(model);
    expect(roots).toHaveLength(1);
    expect(roots[0].occurrence.occurrence.id).toBe('root');
    expect(roots[0].depth).toBe(0);
    expect(roots[0].children.map((c) => c.occurrence.occurrence.id)).toEqual(['child1', 'child2']);
    expect(roots[0].children[0].depth).toBe(1);
  });

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

  it('only includes collection-renderer occurrences in the tree', () => {
    const model = buildSpaceViewModel(
      packet(
        [item('a'), item('b')],
        [occ('coll', { item_id: 'a', renderer: 'collection' }), occ('canv', { item_id: 'b', renderer: 'canvas' })],
      ),
    );
    const { roots, unplaced } = projectCollection(model);
    expect(roots.map((r) => r.occurrence.occurrence.id)).toEqual(['coll']);
    // 'b' is placed only by a canvas occurrence, so for the collection view it
    // is unplaced (no collection occurrence references it).
    expect(unplaced.map((i) => i.id)).toEqual(['b']);
  });
});

describe('projectCollection — unplaced shelf (review2 C7)', () => {
  it('surfaces an item with no collection occurrence on the unplaced shelf', () => {
    const model = buildSpaceViewModel(
      packet([item('placed'), item('lonely')], [occ('o', { item_id: 'placed' })]),
    );
    const { unplaced } = projectCollection(model);
    expect(unplaced.map((i) => i.id)).toEqual(['lonely']);
  });

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

describe('compareCollectionOccurrences', () => {
  it('orders null sort_keys last and is deterministic', () => {
    const a = buildSpaceViewModel(packet([], [occ('a', { sort_key: 'm' })])).occurrences[0];
    const b = buildSpaceViewModel(packet([], [occ('b', { sort_key: null })])).occurrences[0];
    expect(compareCollectionOccurrences(a, b)).toBeLessThan(0);
    expect(compareCollectionOccurrences(b, a)).toBeGreaterThan(0);
  });
});

describe('label / ref helpers', () => {
  it('prefers title, then ref_uri, then ref_type:ref_id', () => {
    expect(itemDisplayLabel(item('x', { title: 'T' }))).toBe('T');
    expect(itemDisplayLabel(item('x', { title: null, ref_uri: 'mandible://issue/x' }))).toBe('mandible://issue/x');
    expect(itemDisplayLabel(item('abc', { title: null, ref_uri: null }))).toBe('issue:abc');
  });

  it('derives a resolvable ref string (artifact passthrough, else mandible:// route)', () => {
    expect(itemRefString(item('x', { ref_type: 'artifact', ref_id: 'artifact:sha256:deadbeef' }))).toBe(
      'artifact:sha256:deadbeef',
    );
    expect(itemRefString(item('x', { ref_type: 'issue', ref_id: 'i1' }))).toBe('mandible://issue/i1');
    expect(itemRefString(item('x', { ref_uri: 'repo://r@main/p' }))).toBe('repo://r@main/p');
  });
});

describe('collection view-state persistence', () => {
  it('keeps the established per-space storage key', () => {
    expect(collectionStorageKey('prj1', 'sp1')).toBe('mandible.spaces.collection:prj1:sp1');
    expect(collectionStorageKey('', 'sp1')).toBe('mandible.spaces.collection:_:sp1');
  });

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

  it('preserves the exact selection object when nothing changed (no needless re-render churn)', () => {
    const prior = {
      itemFilter: '',
      selection: { kind: 'item' as const, ids: ['i1', 'i2'] },
      collapsed: {},
    };
    const next = reconcileCollectionViewState(prior, new Set(['i1', 'i2']));
    expect(next.selection).toBe(prior.selection);
  });

  it('clears selection kind only when every selected id vanished', () => {
    const prior = {
      itemFilter: '',
      selection: { kind: 'occurrence' as const, ids: ['gone'] },
      collapsed: {},
    };
    const next = reconcileCollectionViewState(prior, new Set(['other']));
    expect(next.selection).toEqual({ kind: null, ids: [] });
  });
});
