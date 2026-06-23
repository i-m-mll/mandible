// Tests for the SpaceCanvas node renderer (umbrella de56ffa, child 1dfa2e1).
//
// Covers the load-bearing acceptance criteria:
//   - occurrences render from the model; drag persists via the batch client
//     (optimistic + autosave indicator);
//   - unplaced occurrences (x/y NULL) render in the shelf, NOT at the origin;
//   - layoutGraph() runs only on explicit arrange/seed, never per render after a
//     user move (asserted via a layout-call spy);
//   - SSE `space:occurrence:moved` reconciles WITHOUT resetting selection.
//
// React Flow is mocked with a deterministic harness so node rendering, the
// `onNodesChange` drag/select contract, and reconciliation are observable in
// jsdom without real DOM measurement.

import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';

import type { SpaceItem, SpaceOccurrence } from '../ui/src/api';

// --- React Flow harness mock --------------------------------------------------
// Renders one element per node and exposes the live `onNodesChange` callback on
// a module-level hook so tests can fire position/select changes deterministically.

let lastOnNodesChange: ((changes: unknown[]) => void) | null = null;

vi.mock('@xyflow/react', () => {
  const ReactFlow = (props: {
    nodes: Array<{ id: string; position: { x: number; y: number }; selected?: boolean }>;
    onNodesChange?: (changes: unknown[]) => void;
    children?: unknown;
  }) => {
    lastOnNodesChange = props.onNodesChange ?? null;
    return h(
      'div',
      { 'data-testid': 'rf-mock' },
      props.nodes.map((node) =>
        h(
          'div',
          {
            key: node.id,
            'data-testid': 'rf-node',
            'data-node-id': node.id,
            'data-x': String(node.position.x),
            'data-y': String(node.position.y),
            'data-selected': node.selected ? 'true' : 'false',
          },
          node.id,
        ),
      ),
    );
  };
  const Background = () => h('div', { 'data-testid': 'rf-bg' });
  const Controls = () => h('div', { 'data-testid': 'rf-controls' });
  return { ReactFlow, Background, Controls };
});

// --- layoutGraph spy ----------------------------------------------------------
// Wrap the real layout so we can assert it runs ONLY on explicit arrange/seed.

const layoutCalls = { count: 0 };
vi.mock('../ui/src/graph/layout', async () => {
  const actual = await vi.importActual<typeof import('../ui/src/graph/layout')>(
    '../ui/src/graph/layout',
  );
  return {
    ...actual,
    layoutGraph: (...args: Parameters<typeof actual.layoutGraph>) => {
      layoutCalls.count += 1;
      return actual.layoutGraph(...args);
    },
  };
});

import {
  SpaceCanvas,
  partitionOccurrences,
  isPlaced,
  indexItems,
  seedLayoutPositions,
  buildBatchEntries,
  reconcileOccurrences,
  applyOptimisticPosition,
  occurrencesToGraph,
  type SpaceCanvasModel,
} from '../ui/src/views/spaces/SpaceCanvas';
import type { SSEClient, SSEHandler } from '../ui/src/sse-client';

afterEach(() => {
  cleanup();
  lastOnNodesChange = null;
  layoutCalls.count = 0;
  vi.useRealTimers();
});

// --- fixtures -----------------------------------------------------------------

function occ(id: string, over: Partial<SpaceOccurrence> = {}): SpaceOccurrence {
  return {
    id,
    space_id: 'sp1',
    item_id: `item-${id}`,
    renderer: 'canvas',
    parent_id: null,
    x: 100,
    y: 200,
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

function item(id: string, title: string): SpaceItem {
  return {
    id: `item-${id}`,
    space_id: 'sp1',
    ref_type: 'issue',
    ref_id: id,
    ref_uri: null,
    title,
    metadata: {},
    created_at: 0,
    updated_at: 0,
  };
}

function makeFakeSse(): { client: SSEClient; emit: (type: string, data: unknown) => void } {
  const handlers = new Map<string, Set<SSEHandler>>();
  const client = {
    connect: () => {},
    close: () => {},
    on: (type: string, handler: SSEHandler) => {
      const bucket = handlers.get(type) ?? new Set<SSEHandler>();
      bucket.add(handler);
      handlers.set(type, bucket);
      return () => bucket.delete(handler);
    },
    off: () => {},
  } as unknown as SSEClient;
  const emit = (type: string, data: unknown) => {
    handlers.get(type)?.forEach((handler) => handler({ type, data } as never));
  };
  return { client, emit };
}

// ============================================================================
// Pure helpers
// ============================================================================

describe('partitionOccurrences / shelf vs canvas', () => {
  it('places occurrences with both x and y, shelves the rest (NOT at origin)', () => {
    const items = [item('a', 'A'), item('b', 'B'), item('c', 'C')];
    const occurrences = [
      occ('a', { x: 10, y: 20 }),
      occ('b', { x: null, y: null }), // unplaced
      occ('c', { x: 5, y: null }), // half-placed → shelf
    ];
    const { placed, shelf } = partitionOccurrences(occurrences, indexItems(items));
    expect(placed.map((p) => p.occurrence.id)).toEqual(['a']);
    expect(shelf.map((s) => s.occurrence.id)).toEqual(['b', 'c']);
    // Shelf entries are NOT assigned origin coordinates.
    expect(shelf.every((s) => !isPlaced(s.occurrence))).toBe(true);
  });

  it('treats an occurrence at the literal origin as placed (0,0 is a real position)', () => {
    const { placed } = partitionOccurrences([occ('z', { x: 0, y: 0 })], {});
    expect(placed).toHaveLength(1);
    expect(placed[0].x).toBe(0);
    expect(placed[0].y).toBe(0);
  });
});

describe('occurrencesToGraph + seedLayoutPositions', () => {
  it('maps parent_id links to hierarchy edges and yields a position per node', () => {
    const occurrences = [occ('p', { x: null, y: null }), occ('c', { x: null, y: null, parent_id: 'p' })];
    const { nodes, edges } = occurrencesToGraph(occurrences, {});
    expect(nodes.map((n) => n.id).sort()).toEqual(['c', 'p']);
    expect(edges).toEqual([{ id: 'p->c', source: 'p', target: 'c', type: 'parent' }]);
    const positions = seedLayoutPositions(occurrences, {});
    expect(Object.keys(positions).sort()).toEqual(['c', 'p']);
    for (const id of ['c', 'p']) {
      expect(typeof positions[id].x).toBe('number');
      expect(typeof positions[id].y).toBe('number');
    }
  });
});

describe('buildBatchEntries', () => {
  it('emits id-carrying entries so the batch route updates rather than creates', () => {
    const entries = buildBatchEntries({ a: { x: 1, y: 2 }, b: { x: 3, y: 4 } });
    expect(entries).toEqual([
      { id: 'a', x: 1, y: 2 },
      { id: 'b', x: 3, y: 4 },
    ]);
  });
});

describe('reconcileOccurrences (SSE path)', () => {
  it('adopts server positions but preserves locally-dragged ones', () => {
    const previous = [occ('a', { x: 999, y: 999 }), occ('b', { x: 1, y: 1 })];
    const incoming = [occ('a', { x: 10, y: 10 }), occ('b', { x: 2, y: 2 })];
    const next = reconcileOccurrences(incoming, new Set(['a']), previous);
    const a = next.find((o) => o.id === 'a')!;
    const b = next.find((o) => o.id === 'b')!;
    // 'a' is being dragged → keep local; 'b' adopts the server value.
    expect([a.x, a.y]).toEqual([999, 999]);
    expect([b.x, b.y]).toEqual([2, 2]);
  });
});

describe('applyOptimisticPosition', () => {
  it('updates only the targeted occurrence', () => {
    const next = applyOptimisticPosition([occ('a'), occ('b')], 'b', 7, 8);
    expect(next.find((o) => o.id === 'a')).toMatchObject({ x: 100, y: 200 });
    expect(next.find((o) => o.id === 'b')).toMatchObject({ x: 7, y: 8 });
  });
});

// ============================================================================
// Component behavior
// ============================================================================

const baseProps = { projectId: 'p1', renderer: 'canvas' as const };

describe('SpaceCanvas rendering', () => {
  it('renders placed occurrences as canvas nodes and unplaced in the shelf', () => {
    const model: SpaceCanvasModel = {
      items: [item('a', 'Alpha'), item('b', 'Beta')],
      occurrences: [occ('a', { x: 10, y: 20 }), occ('b', { x: null, y: null })],
    };
    render(h(SpaceCanvas, { ...baseProps, spaceId: 'sp1', initialModel: model }));
    const nodes = screen.getAllByTestId('rf-node');
    expect(nodes.map((n) => n.getAttribute('data-node-id'))).toEqual(['a']);
    const shelfItems = screen.getAllByTestId('space-canvas-shelf-item');
    expect(shelfItems).toHaveLength(1);
    expect(shelfItems[0].getAttribute('data-occurrence-id')).toBe('b');
    // No layout on plain render.
    expect(layoutCalls.count).toBe(0);
  });

  it('does NOT run layoutGraph on render, only on explicit arrange', () => {
    const model: SpaceCanvasModel = {
      items: [item('a', 'Alpha'), item('b', 'Beta')],
      occurrences: [occ('a', { x: 10, y: 20 }), occ('b', { x: 30, y: 40 })],
    };
    const batchWrite = vi.fn().mockResolvedValue({ occurrences: [], created: 0, updated: 2 });
    render(
      h(SpaceCanvas, { ...baseProps, spaceId: 'sp1', initialModel: model, batchWrite }),
    );
    expect(layoutCalls.count).toBe(0);
    fireEvent.click(screen.getByTestId('space-canvas-arrange-all'));
    expect(layoutCalls.count).toBe(1);
  });
});

describe('SpaceCanvas drag persistence + autosave', () => {
  it('optimistically moves a node and debounce-writes the batch with the id', async () => {
    vi.useFakeTimers();
    const model: SpaceCanvasModel = {
      items: [item('a', 'Alpha')],
      occurrences: [occ('a', { x: 10, y: 20 })],
    };
    const batchWrite = vi.fn().mockResolvedValue({ occurrences: [], created: 0, updated: 1 });
    render(
      h(SpaceCanvas, {
        ...baseProps,
        spaceId: 'sp1',
        initialModel: model,
        batchWrite,
        debounceMs: 100,
      }),
    );

    // Simulate a drag-end position change through React Flow's onNodesChange.
    act(() => {
      lastOnNodesChange?.([{ type: 'position', id: 'a', position: { x: 55, y: 66 }, dragging: false }]);
    });

    // Optimistic update is reflected immediately on the node.
    const node = screen.getByTestId('rf-node');
    expect(node.getAttribute('data-x')).toBe('55');
    expect(node.getAttribute('data-y')).toBe('66');

    // Autosave indicator has not yet fired the write (still debouncing).
    expect(batchWrite).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(120);
    });

    expect(batchWrite).toHaveBeenCalledTimes(1);
    expect(batchWrite).toHaveBeenCalledWith('sp1', [{ id: 'a', x: 55, y: 66 }]);
  });

  it('surfaces an error status and keeps the optimistic position on write failure', async () => {
    vi.useFakeTimers();
    const model: SpaceCanvasModel = {
      items: [item('a', 'Alpha')],
      occurrences: [occ('a', { x: 10, y: 20 })],
    };
    const batchWrite = vi.fn().mockRejectedValue(new Error('boom'));
    render(
      h(SpaceCanvas, {
        ...baseProps,
        spaceId: 'sp1',
        initialModel: model,
        batchWrite,
        debounceMs: 50,
      }),
    );

    act(() => {
      lastOnNodesChange?.([{ type: 'position', id: 'a', position: { x: 7, y: 8 }, dragging: false }]);
    });
    await act(async () => {
      vi.advanceTimersByTime(80);
    });

    const autosave = screen.getByTestId('space-canvas-autosave');
    expect(autosave.getAttribute('data-status')).toBe('error');
    // Optimistic position is preserved despite the failure.
    expect(screen.getByTestId('rf-node').getAttribute('data-x')).toBe('7');
  });
});

describe('SpaceCanvas SSE reconciliation', () => {
  it('reconciles occurrence positions WITHOUT resetting selection', async () => {
    const model: SpaceCanvasModel = {
      items: [item('a', 'Alpha'), item('b', 'Beta')],
      occurrences: [occ('a', { x: 10, y: 20 }), occ('b', { x: 30, y: 40 })],
    };
    const { client, emit } = makeFakeSse();
    const updated: SpaceCanvasModel = {
      items: model.items,
      occurrences: [occ('a', { x: 111, y: 222 }), occ('b', { x: 30, y: 40 })],
    };
    const loadModel = vi.fn().mockResolvedValue(updated);

    render(
      h(SpaceCanvas, {
        ...baseProps,
        spaceId: 'sp1',
        initialModel: model,
        loadModel,
        createSse: () => client,
      }),
    );

    const findNode = (id: string) =>
      screen.getAllByTestId('rf-node').find((n) => n.getAttribute('data-node-id') === id)!;

    // Select node 'a' through the React Flow select change.
    act(() => {
      lastOnNodesChange?.([{ type: 'select', id: 'a', selected: true }]);
    });
    await waitFor(() => expect(findNode('a').getAttribute('data-selected')).toBe('true'));

    // An SSE moved event for our space triggers a refetch + reconcile.
    await act(async () => {
      emit('space:occurrence:moved', { space_id: 'sp1' });
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(loadModel).toHaveBeenCalledWith('sp1'));

    // Position reconciled to the server value...
    await waitFor(() => expect(findNode('a').getAttribute('data-x')).toBe('111'));
    // ...but the selection is NOT reset by reconciliation.
    expect(findNode('a').getAttribute('data-selected')).toBe('true');
  });

  it('ignores moved events for a different space', async () => {
    const model: SpaceCanvasModel = {
      items: [item('a', 'Alpha')],
      occurrences: [occ('a', { x: 10, y: 20 })],
    };
    const { client, emit } = makeFakeSse();
    const loadModel = vi.fn().mockResolvedValue(model);
    render(
      h(SpaceCanvas, {
        ...baseProps,
        spaceId: 'sp1',
        initialModel: model,
        loadModel,
        createSse: () => client,
      }),
    );
    await act(async () => {
      emit('space:occurrence:moved', { space_id: 'other-space' });
      await Promise.resolve();
    });
    expect(loadModel).not.toHaveBeenCalled();
  });
});

describe('SpaceCanvas shelf placement', () => {
  it('places a shelf occurrence onto the canvas via a layout seed and queues a write', async () => {
    vi.useFakeTimers();
    const model: SpaceCanvasModel = {
      items: [item('a', 'Alpha'), item('b', 'Beta')],
      occurrences: [occ('a', { x: 10, y: 20 }), occ('b', { x: null, y: null })],
    };
    const batchWrite = vi.fn().mockResolvedValue({ occurrences: [], created: 0, updated: 1 });
    render(
      h(SpaceCanvas, {
        ...baseProps,
        spaceId: 'sp1',
        initialModel: model,
        batchWrite,
        debounceMs: 30,
      }),
    );

    // 'b' starts in the shelf.
    expect(screen.getAllByTestId('space-canvas-shelf-item')).toHaveLength(1);

    act(() => {
      fireEvent.click(screen.getByTestId('space-canvas-shelf-item'));
    });
    // Placement seeds via layoutGraph.
    expect(layoutCalls.count).toBeGreaterThanOrEqual(1);

    await act(async () => {
      vi.advanceTimersByTime(50);
    });
    expect(batchWrite).toHaveBeenCalledTimes(1);
    const [, entries] = batchWrite.mock.calls[0];
    expect(entries[0].id).toBe('b');
  });
});
