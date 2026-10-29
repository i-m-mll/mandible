// @vitest-environment jsdom
// SpaceCanvas keeps a user's drag and selection against stale, out-of-order and
// foreign-space reconciliation input. React Flow is mocked with a deterministic
// harness so the `onNodesChange` drag/select contract is observable in jsdom.

import { render, screen, cleanup, act, waitFor } from './helpers/dom.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';

import type { SpaceItem, SpaceOccurrence } from '../ui/src/api';

// --- React Flow harness mock --------------------------------------------------
// Renders one element per node and exposes the live `onNodesChange` callback on
// a module-level hook so tests can fire position/select changes deterministically.

let lastOnNodesChange: ((changes: unknown[]) => void) | null = null;
let lastOnConnect: ((connection: unknown) => void) | null = null;

vi.mock('@xyflow/react', async () => {
  const actual = await vi.importActual<typeof import('@xyflow/react')>('@xyflow/react');
  const ReactFlow = (props: {
    nodes: Array<{
      id: string;
      position: { x: number; y: number };
      selected?: boolean;
      dragging?: boolean;
      measured?: { width?: number; height?: number };
      data?: { label: string; kind: string };
      type?: string;
    }>;
    edges?: Array<{ id: string; source: string; target: string; label?: string; selected?: boolean }>;
    nodeTypes?: Record<string, (props: { data: { label: string; kind: string }; selected?: boolean }) => unknown>;
    onNodesChange?: (changes: unknown[]) => void;
    onEdgesChange?: (changes: unknown[]) => void;
    onConnect?: (connection: unknown) => void;
    onInit?: (instance: unknown) => void;
    fitView?: boolean;
    children?: unknown;
  }) => {
    lastOnNodesChange = props.onNodesChange ?? null;
    lastOnConnect = props.onConnect ?? null;
    return h('div', { 'data-testid': 'rf-mock' }, [
      ...props.nodes.map((node) =>
        h(
          'div',
          {
            key: node.id,
            'data-testid': 'rf-node',
            'data-node-id': node.id,
            'data-x': String(node.position.x),
            'data-y': String(node.position.y),
            'data-selected': node.selected ? 'true' : 'false',
            'data-dragging': node.dragging ? 'true' : 'false',
            'data-measured-width': String(node.measured?.width ?? ''),
            'data-measured-height': String(node.measured?.height ?? ''),
          },
          props.nodeTypes?.[node.type ?? ''] && node.data
            ? h(props.nodeTypes[node.type ?? '']!, { data: node.data, selected: node.selected })
            : node.id,
        ),
      ),
      ...(props.edges ?? []).map((edge) =>
        h(
          'div',
          {
            key: edge.id,
            'data-testid': 'rf-edge',
            'data-edge-id': edge.id,
            'data-source': edge.source,
            'data-target': edge.target,
            'data-label': edge.label ?? '',
            'data-selected': edge.selected ? 'true' : 'false',
          },
        ),
      ),
    ]);
  };
  const Background = () => h('div', { 'data-testid': 'rf-bg' });
  const Controls = () => h('div', { 'data-testid': 'rf-controls' });
  const Handle = (props: { type?: string; className?: string; position?: string }) =>
    h('div', {
      'data-testid': 'rf-handle',
      'data-handle-type': props.type ?? '',
      'data-position': props.position ?? '',
      className: props.className ?? '',
    });
  return { ...actual, ReactFlow, Background, Controls, Handle };
});

import {
  SpaceCanvas,
  partitionOccurrences,
  reconcileOccurrences,
  type SpaceCanvasModel,
  type SpaceCanvasProps,
} from '../ui/src/views/spaces/SpaceCanvas';
import type { SpaceEdge } from '../ui/src/api';

afterEach(() => {
  cleanup();
  lastOnNodesChange = null;
  lastOnConnect = null;
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

function mountCanvas(props: SpaceCanvasProps) {
  const view = render(h(SpaceCanvas, props));
  return { ...view, update: (model: SpaceCanvasModel) => view.rerender(h(SpaceCanvas, { ...props, model })) };
}

// ============================================================================
// Pure helpers
// ============================================================================

describe('partitionOccurrences / shelf vs canvas', () => {
  it('treats an occurrence at the literal origin as placed (0,0 is a real position)', () => {
    const { placed } = partitionOccurrences([occ('z', { x: 0, y: 0 })], {});
    expect(placed).toHaveLength(1);
    expect(placed[0].x).toBe(0);
    expect(placed[0].y).toBe(0);
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

  it('preserves positions waiting for a server acknowledgement', () => {
    const previous = [occ('a', { x: 55, y: 66 })];
    const incoming = [occ('a', { x: 10, y: 20 })];
    const next = reconcileOccurrences(incoming, new Set(), previous, {
      a: { x: 55, y: 66 },
    });
    expect(next[0]).toMatchObject({ x: 55, y: 66 });
  });
});

// ============================================================================
// Component behavior
// ============================================================================

const baseProps = { projectId: 'p1', renderer: 'canvas' as const };

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
        model: model,
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
    expect(screen.queryByTestId('space-canvas-autosave')).toBeNull();
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
        model: model,
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

describe('SpaceCanvas packet reconciliation', () => {
  it('reconciles occurrence positions WITHOUT resetting selection', async () => {
    const model: SpaceCanvasModel = {
      items: [item('a', 'Alpha'), item('b', 'Beta')],
      occurrences: [occ('a', { x: 10, y: 20 }), occ('b', { x: 30, y: 40 })],
    };
    const updated: SpaceCanvasModel = {
      items: model.items,
      occurrences: [occ('a', { x: 111, y: 222 }), occ('b', { x: 30, y: 40 })],
    };

    const view = mountCanvas({
        ...baseProps,
        spaceId: 'sp1',
        model: model,
    });

    const findNode = (id: string) =>
      screen.getAllByTestId('rf-node').find((n) => n.getAttribute('data-node-id') === id)!;

    // Select node 'a' through the React Flow select change.
    act(() => {
      lastOnNodesChange?.([{ type: 'select', id: 'a', selected: true }]);
    });
    await waitFor(() => expect(findNode('a').getAttribute('data-selected')).toBe('true'));

    // An SSE moved event for our space triggers a refetch + reconcile.
    act(() => view.update(updated));


    // Position reconciled to the server value...
    await waitFor(() => expect(findNode('a').getAttribute('data-x')).toBe('111'));
    // ...but the selection is NOT reset by reconciliation.
    expect(findNode('a').getAttribute('data-selected')).toBe('true');
  });

  it('does not rematerialize an actively dragged node when an incoming packet returns', async () => {
    const model: SpaceCanvasModel = {
      items: [item('a', 'Alpha')],
      occurrences: [occ('a', { x: 10, y: 20 })],
    };
    const stale: SpaceCanvasModel = {
      items: model.items,
      occurrences: [occ('a', { x: 111, y: 222 })],
    };

    const view = mountCanvas({
        ...baseProps,
        spaceId: 'sp1',
        model: model,
    });

    act(() => {
      lastOnNodesChange?.([
        { type: 'dimensions', id: 'a', dimensions: { width: 240, height: 120 }, setAttributes: true },
        { type: 'position', id: 'a', position: { x: 25, y: 30 }, dragging: true },
      ]);
    });
    expect(screen.getByTestId('rf-node').getAttribute('data-x')).toBe('25');
    expect(screen.getByTestId('rf-node').getAttribute('data-dragging')).toBe('true');
    expect(screen.getByTestId('rf-node').getAttribute('data-measured-width')).toBe('240');

    act(() => view.update(stale));

    expect(screen.getByTestId('rf-node').getAttribute('data-x')).toBe('25');
    expect(screen.getByTestId('rf-node').getAttribute('data-y')).toBe('30');
    expect(screen.getByTestId('rf-node').getAttribute('data-dragging')).toBe('true');
    expect(screen.getByTestId('rf-node').getAttribute('data-measured-width')).toBe('240');
  });

  it('keeps an actively dragged node mounted when an incoming packet temporarily omits it', async () => {
    const model: SpaceCanvasModel = {
      items: [item('a', 'Alpha'), item('b', 'Beta')],
      occurrences: [occ('a', { x: 10, y: 20 }), occ('b', { x: 40, y: 50 })],
    };
    const stale: SpaceCanvasModel = {
      items: model.items,
      occurrences: [occ('b', { x: 44, y: 55 })],
    };

    const view = mountCanvas({
        ...baseProps,
        spaceId: 'sp1',
        model: model,
    });

    act(() => {
      lastOnNodesChange?.([{ type: 'position', id: 'a', position: { x: 25, y: 30 }, dragging: true }]);
    });

    act(() => view.update(stale));

    const nodes = screen.getAllByTestId('rf-node');
    const dragged = nodes.find((node) => node.getAttribute('data-node-id') === 'a');
    expect(dragged?.getAttribute('data-x')).toBe('25');
    expect(dragged?.getAttribute('data-y')).toBe('30');
    expect(dragged?.getAttribute('data-dragging')).toBe('true');
  });

  it('keeps a dropped position when a post-save packet is stale', async () => {
    vi.useFakeTimers();
    const model: SpaceCanvasModel = {
      items: [item('a', 'Alpha')],
      occurrences: [occ('a', { x: 10, y: 20 })],
    };
    const stale: SpaceCanvasModel = {
      items: model.items,
      occurrences: [occ('a', { x: 10, y: 20 })],
    };
    const batchWrite = vi.fn().mockResolvedValue({ occurrences: [], created: 0, updated: 1 });

    const view = mountCanvas({
        ...baseProps,
        spaceId: 'sp1',
        model: model,
        batchWrite,
        debounceMs: 50,
    });

    act(() => {
      lastOnNodesChange?.([{ type: 'position', id: 'a', position: { x: 55, y: 66 }, dragging: false }]);
    });
    await act(async () => {
      vi.advanceTimersByTime(60);
      await Promise.resolve();
    });
    expect(batchWrite).toHaveBeenCalledWith('sp1', [{ id: 'a', x: 55, y: 66 }]);

    act(() => view.update(stale));

    expect(screen.getByTestId('rf-node').getAttribute('data-x')).toBe('55');
    expect(screen.getByTestId('rf-node').getAttribute('data-y')).toBe('66');
  });

  it('accepts a newer server position after the saved drag is acknowledged', async () => {
    vi.useFakeTimers();
    const model: SpaceCanvasModel = {
      items: [item('a', 'Alpha')],
      occurrences: [occ('a', { x: 10, y: 20 })],
    };
    const newer: SpaceCanvasModel = {
      items: model.items,
      occurrences: [occ('a', { x: 70, y: 80, updated_at: 101 })],
    };
    const batchWrite = vi.fn().mockResolvedValue({
      occurrences: [occ('a', { x: 55, y: 66, updated_at: 100 })],
      created: 0,
      updated: 1,
    });

    const view = mountCanvas({
        ...baseProps,
        spaceId: 'sp1',
        model: model,
        batchWrite,
        debounceMs: 50,
    });

    act(() => {
      lastOnNodesChange?.([{ type: 'position', id: 'a', position: { x: 55, y: 66 }, dragging: false }]);
    });
    await act(async () => {
      vi.advanceTimersByTime(60);
      await Promise.resolve();
    });

    act(() => view.update(newer));

    expect(screen.getByTestId('rf-node').getAttribute('data-x')).toBe('70');
    expect(screen.getByTestId('rf-node').getAttribute('data-y')).toBe('80');
  });


});

// ============================================================================
// Edges: drag-to-connect (onConnect) + rendering space_edges on the canvas
// ============================================================================

describe('SpaceCanvas onConnect (drag-to-create)', () => {
  it('does not duplicate an edge already present when its canonical packet arrives', async () => {
    const model: SpaceCanvasModel = {
      items: [item('a', 'Alpha'), item('b', 'Beta')],
      occurrences: [occ('a', { x: 10, y: 20 }), occ('b', { x: 30, y: 40 })],
      edges: [],
    };
    const created = edge('new1', 'a', 'b', '');
    const createEdge = vi.fn().mockResolvedValue(created);
    // The reconciliation loader returns the canonical edge list (with the new edge).

    const view = mountCanvas({
        ...baseProps,
        spaceId: 'sp1',
        model: model,
        createEdge,
    });

    await act(async () => {
      lastOnConnect?.({ source: 'a', target: 'b' });
    });
    await waitFor(() => expect(screen.getAllByTestId('rf-edge')).toHaveLength(1));

    // An SSE created event refetches + reconciles; the edge must not duplicate.
    act(() => view.update({ ...model, edges: [created] }));
    expect(screen.getAllByTestId('rf-edge')).toHaveLength(1);
  });
});
