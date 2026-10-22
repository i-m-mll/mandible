// Space edge model: free-text labels never produce an invalid ledger link type,
// only issue/comment endpoints are promotable, and SSE reconciliation keeps a
// label the user is still editing.

import { cleanup } from './helpers/dom.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SpaceEdge, SpaceItem, SpaceOccurrence } from '../ui/src/api';
import {
  DEFAULT_LINK_TYPE,
  mapLabelToLinkType,
  resolveEdge,
  evaluatePromotion,
  indexOccurrences,
  indexItemsById,
  reconcileEdges,
} from '../ui/src/views/spaces/edgeModel';

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

describe('mapLabelToLinkType', () => {
  it('falls back to references for free/unknown labels', () => {
    expect(mapLabelToLinkType('depends on')).toBe(DEFAULT_LINK_TYPE);
    expect(mapLabelToLinkType('depends on')).toBe('references');
    expect(mapLabelToLinkType('')).toBe('references');
    expect(mapLabelToLinkType(null)).toBe('references');
  });
});

describe('evaluatePromotion', () => {
  const occById = (occs: SpaceOccurrence[]) => indexOccurrences(occs);
  const itemById = (items: SpaceItem[]) => indexItemsById(items);

  it('is NOT promotable when an endpoint is an artifact', () => {
    const occs = [occ('a'), occ('x')];
    const items = [item('a'), item('x', { ref_type: 'artifact', ref_id: 'sha256:abc' })];
    const resolved = resolveEdge(edge('e1', 'a', 'x'), occById(occs), itemById(items));
    const verdict = evaluatePromotion(resolved);
    expect(verdict.promotable).toBe(false);
    if (!verdict.promotable) expect(verdict.reason).toMatch(/artifact/);
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

// ============================================================================
// promoteEdgeToLedger client (reuses POST /api/ledger/relationships)
// ============================================================================
