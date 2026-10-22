// Tests for the SpaceCanvas EDGE model (umbrella de56ffa, child e16520d / C9b).
//
// The `SpaceEdgeLayer` component these tests once also exercised was retired
// (its bottom edge panel was folded into the integrated canvas inspector) and
// has been deleted. What remains here is the still-live pure edge model and
// promote-to-ledger logic.
//
// Covers the load-bearing acceptance criteria:
//   - `space_edges` are created/edited with FREE labels via the C2 edge client;
//   - promote-to-ledger calls `POST /api/ledger/relationships` with a valid
//     `link_type` and issue/comment endpoints; artifact/URI-endpoint edges are
//     NOT promotable; the label→link_type mapping matches the C4 promote-edge
//     CLI semantics;
//   - SSE `space:edge:created` reconciles the edge list WITHOUT resetting the
//     local selection / in-flight label edit.

import { cleanup } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SpaceEdge, SpaceItem, SpaceOccurrence } from '../../ui/src/api';
import {
  LEDGER_LINK_TYPES,
  DEFAULT_LINK_TYPE,
  isLedgerEndpointRefType,
  isLedgerLinkType,
  mapLabelToLinkType,
  resolveEdge,
  evaluatePromotion,
  indexOccurrences,
  indexItemsById,
  reconcileEdges,
  applyOptimisticLabel,
} from '../../ui/src/views/spaces/edgeModel';
import { promoteEdgeToLedger } from '../../ui/src/views/spaces/edgePromote';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// --- fixtures -----------------------------------------------------------------

function occ(id: string, over: Partial<SpaceOccurrence> = {}): SpaceOccurrence {
  return {
    id,
    space_id: 'sp1',
    item_id: `item-${id}`,
    renderer: 'canvas',
    parent_id: null,
    x: 0,
    y: 0,
    width: null,
    height: null,
    z_index: null,
    sort_key: null,
    section_id: null,
    note: null,
    metadata: {},
    created_at: 0,
    updated_at: 0,
    ...over,
  };
}

function item(occId: string, over: Partial<SpaceItem> = {}): SpaceItem {
  return {
    id: `item-${occId}`,
    space_id: 'sp1',
    ref_type: 'issue',
    ref_id: occId,
    ref_uri: null,
    title: occId.toUpperCase(),
    metadata: {},
    created_at: 0,
    updated_at: 0,
    ...over,
  };
}

function edge(id: string, source: string, target: string, label: string | null = null): SpaceEdge {
  return {
    id,
    space_id: 'sp1',
    source,
    target,
    label,
    style: null,
    metadata: {},
    created_at: 0,
    updated_at: 0,
  };
}


// ============================================================================
// Pure model: link-type mapping + promotability (C4 promote-edge semantics)
// ============================================================================

describe('LEDGER_LINK_TYPES', () => {
  it('is exactly the 9 valid ledger relationship types', () => {
    expect([...LEDGER_LINK_TYPES]).toEqual([
      'parent_child',
      'blocks',
      'duplicate_of',
      'related',
      'references',
      'fixed_by',
      'caused_by',
      'implements',
      'tests',
    ]);
  });
});

describe('mapLabelToLinkType', () => {
  it('matches a valid link type case/whitespace-insensitively', () => {
    expect(mapLabelToLinkType('blocks')).toBe('blocks');
    expect(mapLabelToLinkType('  Blocks ')).toBe('blocks');
    expect(mapLabelToLinkType('parent child')).toBe('parent_child');
    expect(mapLabelToLinkType('parent-child')).toBe('parent_child');
  });

  it('falls back to references for free/unknown labels', () => {
    expect(mapLabelToLinkType('depends on')).toBe(DEFAULT_LINK_TYPE);
    expect(mapLabelToLinkType('depends on')).toBe('references');
    expect(mapLabelToLinkType('')).toBe('references');
    expect(mapLabelToLinkType(null)).toBe('references');
  });
});

describe('isLedgerEndpointRefType / isLedgerLinkType', () => {
  it('accepts only issue and comment endpoints', () => {
    expect(isLedgerEndpointRefType('issue')).toBe(true);
    expect(isLedgerEndpointRefType('comment')).toBe(true);
    expect(isLedgerEndpointRefType('artifact')).toBe(false);
    expect(isLedgerEndpointRefType('external_ref')).toBe(false);
    expect(isLedgerEndpointRefType(null)).toBe(false);
  });

  it('validates the 9 link types', () => {
    expect(isLedgerLinkType('tests')).toBe(true);
    expect(isLedgerLinkType('nope')).toBe(false);
  });
});

describe('evaluatePromotion', () => {
  const occById = (occs: SpaceOccurrence[]) => indexOccurrences(occs);
  const itemById = (items: SpaceItem[]) => indexItemsById(items);

  it('promotes an issue→issue edge with the suggested link type from the label', () => {
    const occs = [occ('a'), occ('b')];
    const items = [item('a'), item('b')];
    const resolved = resolveEdge(edge('e1', 'a', 'b', 'blocks'), occById(occs), itemById(items));
    const verdict = evaluatePromotion(resolved);
    expect(verdict).toMatchObject({
      promotable: true,
      sourceRef: 'a',
      targetRef: 'b',
      suggestedLinkType: 'blocks',
    });
  });

  it('promotes comment endpoints (issue/comment only rule)', () => {
    const occs = [occ('a', { item_id: 'item-a' }), occ('c', { item_id: 'item-c' })];
    const items = [item('a'), item('c', { ref_type: 'comment', ref_id: 'cmt-1' })];
    const resolved = resolveEdge(edge('e1', 'a', 'c'), occById(occs), itemById(items));
    const verdict = evaluatePromotion(resolved);
    expect(verdict.promotable).toBe(true);
    if (verdict.promotable) expect(verdict.targetRef).toBe('cmt-1');
  });

  it('is NOT promotable when an endpoint is an artifact', () => {
    const occs = [occ('a'), occ('x')];
    const items = [item('a'), item('x', { ref_type: 'artifact', ref_id: 'sha256:abc' })];
    const resolved = resolveEdge(edge('e1', 'a', 'x'), occById(occs), itemById(items));
    const verdict = evaluatePromotion(resolved);
    expect(verdict.promotable).toBe(false);
    if (!verdict.promotable) expect(verdict.reason).toMatch(/artifact/);
  });

  it('is NOT promotable when an endpoint is a URI/external_ref', () => {
    const occs = [occ('a'), occ('u')];
    const items = [item('a'), item('u', { ref_type: 'external_ref', ref_id: 'https://x' })];
    const resolved = resolveEdge(edge('e1', 'a', 'u'), occById(occs), itemById(items));
    const verdict = evaluatePromotion(resolved);
    expect(verdict.promotable).toBe(false);
  });

  it('is NOT promotable for an unbound or self-referential edge', () => {
    const occs = [occ('a', { item_id: null }), occ('b')];
    const items = [item('b')];
    const unbound = evaluatePromotion(
      resolveEdge(edge('e1', 'a', 'b'), occById(occs), itemById(items)),
    );
    expect(unbound.promotable).toBe(false);

    const selfOccs = [occ('a'), occ('a2', { item_id: 'item-a' })];
    const selfItems = [item('a')];
    const selfLoop = evaluatePromotion(
      resolveEdge(edge('e2', 'a', 'a2'), occById(selfOccs), itemById(selfItems)),
    );
    expect(selfLoop.promotable).toBe(false);
  });
});

describe('reconcileEdges (SSE path)', () => {
  it('adopts server edges but preserves locally-edited labels', () => {
    const previous = [edge('e1', 'a', 'b', 'local-typing'), edge('e2', 'a', 'c', 'old')];
    const incoming = [edge('e1', 'a', 'b', 'server'), edge('e2', 'a', 'c', 'new')];
    const next = reconcileEdges(incoming, new Set(['e1']), previous);
    expect(next.find((e) => e.id === 'e1')!.label).toBe('local-typing');
    expect(next.find((e) => e.id === 'e2')!.label).toBe('new');
  });
});

describe('applyOptimisticLabel', () => {
  it('updates only the targeted edge label', () => {
    const next = applyOptimisticLabel([edge('e1', 'a', 'b', 'x'), edge('e2', 'a', 'c')], 'e2', 'y');
    expect(next.find((e) => e.id === 'e1')!.label).toBe('x');
    expect(next.find((e) => e.id === 'e2')!.label).toBe('y');
  });
});

// ============================================================================
// promoteEdgeToLedger client (reuses POST /api/ledger/relationships)
// ============================================================================

describe('promoteEdgeToLedger', () => {
  it('POSTs source_ref/target_refs/link_type to the ledger relationships route', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ action_id: 'act-1', edges: [{}] }),
    } as Response);
    const result = await promoteEdgeToLedger(
      { sourceRef: 'a', targetRef: 'b', linkType: 'blocks', note: 'why' },
      { fetchImpl },
    );
    expect(result.action_id).toBe('act-1');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [path, init] = fetchImpl.mock.calls[0];
    expect(path).toBe('/api/ledger/relationships');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      source_ref: 'a',
      target_refs: ['b'],
      link_type: 'blocks',
      note: 'why',
    });
  });

  it('throws the server error message on a non-2xx response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: 'invalid relationship type' }),
    } as Response);
    await expect(
      promoteEdgeToLedger({ sourceRef: 'a', targetRef: 'b', linkType: 'references' }, { fetchImpl }),
    ).rejects.toThrow('invalid relationship type');
  });
});
