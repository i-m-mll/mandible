// Tests for the SpaceCanvas node renderer (umbrella de56ffa, child 1dfa2e1).
//
// Covers the load-bearing acceptance criteria:
//   - occurrences render from the model; drag persists via the batch client
//     (optimistic + non-success autosave feedback);
//   - legacy unplaced occurrences (x/y NULL) are auto-placed, not shelved;
//   - layoutGraph() runs only on explicit arrange/seed, never per render after a
//     user move (asserted via a layout-call spy);
//   - SSE `space:occurrence:moved` reconciles WITHOUT resetting selection.
//
// React Flow is mocked with a deterministic harness so node rendering, the
// `onNodesChange` drag/select contract, and reconciliation are observable in
// jsdom without real DOM measurement.

import { readFileSync } from 'node:fs';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';

import type { InstanceInfo, SpaceItem, SpaceOccurrence } from '../ui/src/api';

const canvasCss = readFileSync('ui/src/views/spaces/SpaceCanvas.css', 'utf8');

function ruleBody(css: string, selector: string): string {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (match[1]!.split(',').map((entry) => entry.trim()).includes(selector)) return match[2]!;
  }
  return '';
}

// --- React Flow harness mock --------------------------------------------------
// Renders one element per node and exposes the live `onNodesChange` callback on
// a module-level hook so tests can fire position/select changes deterministically.

let lastOnNodesChange: ((changes: unknown[]) => void) | null = null;
let lastOnConnect: ((connection: unknown) => void) | null = null;
let lastOnEdgesChange: ((changes: unknown[]) => void) | null = null;
let lastReactFlowProps: { fitView?: boolean; onInit?: (instance: unknown) => void } | null = null;
let reactFlowEdgeSnapshots: unknown[][] = [];

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
    lastOnEdgesChange = props.onEdgesChange ?? null;
    lastReactFlowProps = { fitView: props.fitView, onInit: props.onInit };
    reactFlowEdgeSnapshots.push(props.edges ?? []);
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
  SpaceCanvasFlowSurface,
  partitionOccurrences,
  isPlaced,
  indexItems,
  seedLayoutPositions,
  buildBatchEntries,
  reconcileOccurrences,
  applyOptimisticPosition,
  nextAddedItemPosition,
  occurrencesToGraph,
  edgesToFlowEdges,
  reconcileFlowEdges,
  connectionToEdgeRequest,
  canvasNodesToFlowNodes,
  applyLocalNodeChanges,
  type SpaceCanvasModel,
} from '../ui/src/views/spaces/SpaceCanvas';
import type { SpaceEdge } from '../ui/src/api';
import { reconcileEdges } from '../ui/src/views/spaces/edgeModel';
import type { SSEClient, SSEHandler } from '../ui/src/sse-client';

afterEach(() => {
  cleanup();
  lastOnNodesChange = null;
  lastOnConnect = null;
  lastOnEdgesChange = null;
  lastReactFlowProps = null;
  reactFlowEdgeSnapshots = [];
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

function previewInstance(allowedEffects: string[]): InstanceInfo {
  return {
    role: 'preview',
    instance_id: 'preview-1',
    installation_id: 'install-1',
    public_origin: 'http://localhost:19420',
    backend_generation: 'test-generation',
    allowed_effects: allowedEffects,
    writable_roots: ['/tmp/mandible-preview'],
    db_path: '/tmp/mandible-preview/mandible.db',
    db_path_source: 'iab-preview-copy',
  };
}

function linkedSpaceItem(id: string, title: string, over: Partial<SpaceItem> = {}): SpaceItem {
  return {
    id: `item-${id}`,
    space_id: 'sp1',
    ref_type: 'space',
    ref_id: id,
    ref_uri: null,
    title,
    metadata: {
      default_renderer: 'document',
      primary_type: 'document',
      primary_type_label: 'Document',
      project_label: 'Mandible',
    },
    created_at: 0,
    updated_at: 0,
    ...over,
  } as unknown as SpaceItem;
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
  it('places canvas occurrences with both x and y, shelves unplaced canvas occurrences only', () => {
    const items = [item('a', 'A'), item('b', 'B'), item('c', 'C')];
    const occurrences = [
      occ('a', { x: 10, y: 20 }),
      occ('b', { x: null, y: null }), // unplaced
      occ('c', { x: 5, y: null }), // half-placed → shelf
      occ('board-card', { renderer: 'board', x: 30, y: 40 }),
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
  it('maps canvas parent_id links to hierarchy edges and ignores non-canvas occurrences', () => {
    const occurrences = [
      occ('p', { x: null, y: null }),
      occ('c', { x: null, y: null, parent_id: 'p' }),
      occ('board-card', { renderer: 'board', x: 10, y: 10, parent_id: 'p' }),
    ];
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

  it('preserves positions waiting for a server acknowledgement', () => {
    const previous = [occ('a', { x: 55, y: 66 })];
    const incoming = [occ('a', { x: 10, y: 20 })];
    const next = reconcileOccurrences(incoming, new Set(), previous, {
      a: { x: 55, y: 66 },
    });
    expect(next[0]).toMatchObject({ x: 55, y: 66 });
  });

  it('keeps an actively dragged occurrence when a refetch temporarily omits it', () => {
    const previous = [occ('a', { x: 55, y: 66 }), occ('b', { x: 1, y: 1 })];
    const incoming = [occ('b', { x: 2, y: 2 })];
    const next = reconcileOccurrences(incoming, new Set(['a']), previous);

    expect(next.map((entry) => entry.id).sort()).toEqual(['a', 'b']);
    expect(next.find((entry) => entry.id === 'a')).toBe(previous[0]);
    expect(next.find((entry) => entry.id === 'b')).toMatchObject({ x: 2, y: 2 });
  });
});

describe('applyOptimisticPosition', () => {
  it('updates only the targeted occurrence', () => {
    const next = applyOptimisticPosition([occ('a'), occ('b')], 'b', 7, 8);
    expect(next.find((o) => o.id === 'a')).toMatchObject({ x: 100, y: 200 });
    expect(next.find((o) => o.id === 'b')).toMatchObject({ x: 7, y: 8 });
  });
});

describe('nextAddedItemPosition', () => {
  it('places the first added item immediately and subsequent items to the right', () => {
    expect(nextAddedItemPosition([])).toEqual({ x: 0, y: 0 });
    const placed = partitionOccurrences(
      [occ('a', { x: 10, y: 40 }), occ('b', { x: 120, y: 20 })],
      {},
    ).placed;
    expect(nextAddedItemPosition(placed)).toEqual({ x: 380, y: 20 });
  });
});

describe('React Flow local node helpers', () => {
  it('apply position changes without needing the parent canvas state', () => {
    const nodes = canvasNodesToFlowNodes(
      partitionOccurrences([occ('a', { x: 10, y: 20 })], {}).placed,
      new Set(),
    );
    const next = applyLocalNodeChanges(nodes, [
      { type: 'position', id: 'a', position: { x: 25, y: 30 }, dragging: true } as never,
    ]);
    expect(next[0].position).toEqual({ x: 25, y: 30 });
  });

  it('uses React Flow controlled-mode semantics for drag, dimensions, add, remove, and replace', () => {
    const nodes = canvasNodesToFlowNodes(
      partitionOccurrences([occ('a', { x: 10, y: 20 }), occ('b', { x: 40, y: 50 })], {}).placed,
      new Set(),
    );
    const replacement = {
      id: 'b',
      position: { x: 70, y: 80 },
      data: { label: 'Bravo replacement', kind: 'issue' },
      type: 'spaceOccurrence',
    } as const;
    const added = {
      id: 'c',
      position: { x: 90, y: 100 },
      data: { label: 'Charlie', kind: 'issue' },
      type: 'spaceOccurrence',
    } as const;

    const next = applyLocalNodeChanges(nodes, [
      { type: 'position', id: 'a', position: { x: 25, y: 30 }, dragging: true },
      { type: 'dimensions', id: 'a', dimensions: { width: 240, height: 120 }, setAttributes: true },
      { type: 'remove', id: 'b' },
      { type: 'replace', id: 'b', item: replacement },
      { type: 'add', item: added },
    ]);

    expect(next.find((node) => node.id === 'a')).toMatchObject({
      position: { x: 25, y: 30 },
      dragging: true,
      measured: { width: 240, height: 120 },
      width: 240,
      height: 120,
    });
    expect(next.find((node) => node.id === 'b')).toEqual(replacement);
    expect(next.find((node) => node.id === 'c')).toEqual(added);
  });
});

// ============================================================================
// Component behavior
// ============================================================================

const baseProps = { projectId: 'p1', renderer: 'canvas' as const };

describe('SpaceCanvas rendering', () => {
  it('keeps pending initial load distinct from a truly empty canvas', async () => {
    let resolveLoad: (model: SpaceCanvasModel) => void = () => {};
    const pendingLoad = new Promise<SpaceCanvasModel>((resolve) => {
      resolveLoad = resolve;
    });
    const loadModel = vi.fn().mockReturnValue(pendingLoad);
    const { client } = makeFakeSse();

    render(h(SpaceCanvas, { ...baseProps, spaceId: 'sp1', loadModel, createSse: () => client }));

    expect(screen.getByTestId('space-canvas-loading').textContent).toBe('Loading canvas items...');
    expect(screen.queryByText('No canvas items yet.')).toBeNull();
    expect(screen.queryByTestId('rf-node')).toBeNull();

    await act(async () => {
      resolveLoad({ items: [], occurrences: [] });
      await pendingLoad;
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByTestId('space-canvas-empty')).toBeTruthy());
    expect(screen.getByTestId('space-canvas-empty').textContent).toBe('No canvas items yet.');
    expect(screen.queryByTestId('space-canvas-loading')).toBeNull();
  });

  it('renders loaded nodes after a pending initial model resolves', async () => {
    let resolveLoad: (model: SpaceCanvasModel) => void = () => {};
    const pendingLoad = new Promise<SpaceCanvasModel>((resolve) => {
      resolveLoad = resolve;
    });
    const loadModel = vi.fn().mockReturnValue(pendingLoad);
    const { client } = makeFakeSse();

    render(h(SpaceCanvas, { ...baseProps, spaceId: 'sp1', loadModel, createSse: () => client }));

    expect(screen.getByTestId('space-canvas-loading')).toBeTruthy();
    expect(screen.queryByText('No canvas items yet.')).toBeNull();

    await act(async () => {
      resolveLoad({
        items: [item('a', 'Alpha')],
        occurrences: [occ('a', { x: 10, y: 20 })],
      });
      await pendingLoad;
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByTestId('rf-node').getAttribute('data-node-id')).toBe('a'));
    expect(screen.getByText('Alpha')).toBeTruthy();
    expect(screen.queryByTestId('space-canvas-empty')).toBeNull();
    expect(screen.queryByTestId('space-canvas-loading')).toBeNull();
  });

  it('renders placed canvas occurrences as nodes and ignores other renderer occurrences', () => {
    const model: SpaceCanvasModel = {
      items: [item('a', 'Alpha'), item('b', 'Beta')],
      occurrences: [occ('a', { x: 10, y: 20 }), occ('b', { renderer: 'board', x: 30, y: 40 })],
    };
    render(h(SpaceCanvas, { ...baseProps, spaceId: 'sp1', initialModel: model }));
    const nodes = screen.getAllByTestId('rf-node');
    expect(nodes.map((n) => n.getAttribute('data-node-id'))).toEqual(['a']);
    expect(screen.queryByTestId('space-canvas-shelf')).toBeNull();
    // No layout on plain render.
    expect(layoutCalls.count).toBe(0);
  });

  it('preserves the toolbar boundary without casting a shadow into the canvas', () => {
    const model: SpaceCanvasModel = {
      items: [item('a', 'Alpha')],
      occurrences: [occ('a', { x: 10, y: 20 })],
    };
    const style = document.createElement('style');
    style.textContent = `.space-canvas__toolbar { ${ruleBody(canvasCss, '.space-canvas__toolbar')} }`;
    document.head.append(style);
    try {
      render(h(SpaceCanvas, { ...baseProps, spaceId: 'sp1', initialModel: model }));
      const toolbar = screen.getByRole('toolbar', { name: 'Canvas actions' });
      const computed = getComputedStyle(toolbar);
      expect(computed.boxShadow).toBe('none');
      expect(ruleBody(canvasCss, '.space-canvas__toolbar'))
        .toContain('border-bottom: 1px solid var(--border, #2a2a2a)');
    } finally {
      style.remove();
    }
  });

  it('does not render or announce an idle Saved success status', () => {
    const model: SpaceCanvasModel = {
      items: [item('a', 'Alpha')],
      occurrences: [occ('a', { x: 10, y: 20 })],
    };
    render(h(SpaceCanvas, { ...baseProps, spaceId: 'sp1', initialModel: model }));
    expect(screen.queryByTestId('space-canvas-autosave')).toBeNull();
    expect(screen.queryByText('Saved')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('resizes the bottom inspector from the invisible top-border handle', async () => {
    const model: SpaceCanvasModel = {
      items: [item('a', 'Alpha')],
      occurrences: [occ('a', { x: 10, y: 20 })],
    };
    render(h(SpaceCanvas, { ...baseProps, spaceId: 'sp1', initialModel: model }));
    const inspector = screen.getByTestId('space-canvas-inspector') as HTMLElement;
    const handle = screen.getByTestId('space-canvas-inspector-resize') as HTMLElement;

    inspector.getBoundingClientRect = () => ({
      x: 0,
      y: 440,
      width: 800,
      height: 220,
      top: 440,
      right: 800,
      bottom: 660,
      left: 0,
      toJSON: () => ({}),
    });
    (inspector.parentElement as HTMLElement).getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      width: 800,
      height: 600,
      top: 0,
      right: 800,
      bottom: 600,
      left: 0,
      toJSON: () => ({}),
    });

    fireEvent.mouseDown(handle, { clientY: 440 });
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientY: 380 }));
      window.dispatchEvent(new MouseEvent('pointerup'));
    });

    await waitFor(() => expect(inspector.style.flexBasis).toBe('280px'));
    expect(handle.getAttribute('role')).toBe('separator');
    expect(handle.getAttribute('aria-orientation')).toBe('horizontal');
  });

  it('renders stable left target and right source handles on nodes', () => {
    const model: SpaceCanvasModel = {
      items: [item('a', 'Alpha')],
      occurrences: [occ('a', { x: 10, y: 20 })],
    };
    render(h(SpaceCanvas, { ...baseProps, spaceId: 'sp1', initialModel: model }));
    const handles = screen.getAllByTestId('rf-handle');
    expect(handles.map((handle) => handle.getAttribute('data-handle-type'))).toEqual([
      'target',
      'source',
    ]);
    expect(handles.map((handle) => handle.getAttribute('data-position'))).toEqual([
      'left',
      'right',
    ]);
    expect(handles[0].className).toContain('space-canvas__handle--target');
    expect(handles[1].className).toContain('space-canvas__handle--source');
  });

  it('renders linked Space nodes with type/project cues and a canonical Open route', () => {
    window.location.hash = '#/spaces?project=rlrmp&space=old&filter=open&sidebar=hidden&agent_session=01a0217a&other=keep&renderer=canvas';
    const model: SpaceCanvasModel = {
      items: [linkedSpaceItem('7038d21f-b494-47fb-b9b8-d5fb93b3309a', 'Design doc')],
      occurrences: [occ('7038d21f-b494-47fb-b9b8-d5fb93b3309a', { x: 10, y: 20 })],
    };
    render(h(SpaceCanvas, { ...baseProps, spaceId: 'sp1', initialModel: model }));
    const node = screen.getByTestId('space-canvas-node');
    expect(node.getAttribute('data-ref-type')).toBe('space');
    const typeIndicator = screen.getByText('Document').closest('.space-type-indicator');
    expect(typeIndicator).toBeTruthy();
    expect(typeIndicator?.closest('.space-canvas__node-space-type')).toBeTruthy();
    expect(typeIndicator?.closest('.space-canvas__node-space-badge')).toBeNull();
    expect(screen.getByText('Mandible')).toBeTruthy();
    expect(screen.getByText('Design doc')).toBeTruthy();
    const open = screen.getByTestId('space-canvas-linked-space-open') as HTMLAnchorElement;
    expect(open.getAttribute('href')).toBe(
      '#/spaces?project=rlrmp&space=7038d21f&filter=open&sidebar=hidden&agent_session=01a0217a&other=keep',
    );
    expect(open.textContent).toBe('Open');
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
    fireEvent.click(screen.getByTestId('space-canvas-actions-menu'));
    fireEvent.click(screen.getByTestId('space-canvas-arrange-all'));
    expect(layoutCalls.count).toBe(1);
  });
});

describe('SpaceCanvas drag persistence + autosave', () => {
  it('announces drag start once per active drag id while still applying every position frame', () => {
    const nodes = canvasNodesToFlowNodes(
      partitionOccurrences([occ('a', { x: 10, y: 20 })], {}).placed,
      new Set(),
    );
    const onNodeDragStart = vi.fn();
    const onNodeDragStop = vi.fn();
    render(
      h(SpaceCanvasFlowSurface as any, {
        nodes,
        edges: [],
        nodeTypes: { spaceOccurrence: () => h('div') },
        onNodeDragStart,
        onNodeDragStop,
        onNodeSelectionChange: vi.fn(),
        onEdgesChange: vi.fn(),
        onConnect: vi.fn(),
      }),
    );

    act(() => {
      lastOnNodesChange?.([
        { type: 'position', id: 'a', position: { x: 25, y: 30 }, dragging: true },
      ]);
      lastOnNodesChange?.([
        { type: 'position', id: 'a', position: { x: 35, y: 40 }, dragging: true },
      ]);
    });

    expect(onNodeDragStart).toHaveBeenCalledTimes(1);
    expect(onNodeDragStart).toHaveBeenCalledWith('a');
    expect(screen.getByTestId('rf-node').getAttribute('data-x')).toBe('35');
    expect(screen.getByTestId('rf-node').getAttribute('data-y')).toBe('40');

    act(() => {
      lastOnNodesChange?.([
        { type: 'position', id: 'a', position: { x: 55, y: 66 }, dragging: false },
      ]);
    });
    expect(onNodeDragStop).toHaveBeenCalledTimes(1);
    expect(onNodeDragStop).toHaveBeenCalledWith('a', { x: 55, y: 66 });
  });

  it('fits the viewport once on init without keeping React Flow fitView active during drag', () => {
    const model: SpaceCanvasModel = {
      items: [item('a', 'Alpha')],
      occurrences: [occ('a', { x: 10, y: 20 })],
    };
    render(h(SpaceCanvas, { ...baseProps, spaceId: 'sp1', initialModel: model }));

    expect(lastReactFlowProps?.fitView).toBeUndefined();
    const fitView = vi.fn().mockResolvedValue(true);
    act(() => {
      lastReactFlowProps?.onInit?.({ fitView });
      lastReactFlowProps?.onInit?.({ fitView });
    });
    expect(fitView).toHaveBeenCalledTimes(1);
    expect(fitView).toHaveBeenCalledWith({ padding: 0.16, duration: 0 });

    act(() => {
      lastOnNodesChange?.([{ type: 'position', id: 'a', position: { x: 25, y: 30 }, dragging: true }]);
    });
    expect(lastReactFlowProps?.fitView).toBeUndefined();
  });

  it('keeps pointer-frame drag updates local until drag stop', async () => {
    vi.useFakeTimers();
    const model: SpaceCanvasModel = {
      items: [item('a', 'Alpha')],
      occurrences: [occ('a', { x: 10, y: 20 })],
    };
    const batchWrite = vi.fn().mockResolvedValue({
      occurrences: [occ('a', { x: 55, y: 66, updated_at: 100 })],
      created: 0,
      updated: 1,
    });
    render(
      h(SpaceCanvas, {
        ...baseProps,
        spaceId: 'sp1',
        initialModel: model,
        batchWrite,
        debounceMs: 100,
      }),
    );

    act(() => {
      lastOnNodesChange?.([{ type: 'position', id: 'a', position: { x: 25, y: 30 }, dragging: true }]);
    });
    expect(screen.getByTestId('rf-node').getAttribute('data-x')).toBe('25');
    expect(batchWrite).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(150);
    });
    expect(batchWrite).not.toHaveBeenCalled();

    act(() => {
      lastOnNodesChange?.([{ type: 'position', id: 'a', position: { x: 55, y: 66 }, dragging: false }]);
    });
    await act(async () => {
      vi.advanceTimersByTime(120);
    });
    expect(batchWrite).toHaveBeenCalledWith('sp1', [{ id: 'a', x: 55, y: 66 }]);
  });

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
    expect(screen.queryByTestId('space-canvas-autosave')).toBeNull();
    expect(screen.queryByText('Saved')).toBeNull();
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

  it('shows saving-disabled preview state without retrying rejected preview mutations', async () => {
    vi.useFakeTimers();
    const model: SpaceCanvasModel = {
      items: [item('a', 'Alpha')],
      occurrences: [occ('a', { x: 10, y: 20 })],
    };
    const batchWrite = vi.fn();

    render(
      h(SpaceCanvas, {
        ...baseProps,
        spaceId: 'sp1',
        initialModel: model,
        batchWrite,
        debounceMs: 50,
        instance: previewInstance(['ledger:read']),
      }),
    );

    act(() => {
      lastOnNodesChange?.([{ type: 'position', id: 'a', position: { x: 55, y: 66 }, dragging: false }]);
    });
    await act(async () => {
      vi.advanceTimersByTime(60);
    });

    expect(batchWrite).not.toHaveBeenCalled();
    expect(screen.getByTestId('space-canvas-autosave').getAttribute('data-status')).toBe('disabled');
    expect(screen.getByTestId('space-canvas-autosave').textContent).toBe('Saving disabled');
    expect(screen.queryByTestId('space-canvas-preview-disabled')).toBeNull();
    expect(screen.getByTestId('rf-node').getAttribute('data-x')).toBe('55');
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

  it('does not rematerialize an actively dragged node when an SSE refetch returns', async () => {
    const model: SpaceCanvasModel = {
      items: [item('a', 'Alpha')],
      occurrences: [occ('a', { x: 10, y: 20 })],
    };
    const { client, emit } = makeFakeSse();
    const stale: SpaceCanvasModel = {
      items: model.items,
      occurrences: [occ('a', { x: 111, y: 222 })],
    };
    const loadModel = vi.fn().mockResolvedValue(stale);

    render(
      h(SpaceCanvas, {
        ...baseProps,
        spaceId: 'sp1',
        initialModel: model,
        loadModel,
        createSse: () => client,
      }),
    );

    act(() => {
      lastOnNodesChange?.([
        { type: 'dimensions', id: 'a', dimensions: { width: 240, height: 120 }, setAttributes: true },
        { type: 'position', id: 'a', position: { x: 25, y: 30 }, dragging: true },
      ]);
    });
    expect(screen.getByTestId('rf-node').getAttribute('data-x')).toBe('25');
    expect(screen.getByTestId('rf-node').getAttribute('data-dragging')).toBe('true');
    expect(screen.getByTestId('rf-node').getAttribute('data-measured-width')).toBe('240');

    await act(async () => {
      emit('space:occurrence:moved', { space_id: 'sp1' });
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(loadModel).toHaveBeenCalledWith('sp1'));
    expect(screen.getByTestId('rf-node').getAttribute('data-x')).toBe('25');
    expect(screen.getByTestId('rf-node').getAttribute('data-y')).toBe('30');
    expect(screen.getByTestId('rf-node').getAttribute('data-dragging')).toBe('true');
    expect(screen.getByTestId('rf-node').getAttribute('data-measured-width')).toBe('240');
  });

  it('keeps an actively dragged node mounted when an SSE refetch temporarily omits it', async () => {
    const model: SpaceCanvasModel = {
      items: [item('a', 'Alpha'), item('b', 'Beta')],
      occurrences: [occ('a', { x: 10, y: 20 }), occ('b', { x: 40, y: 50 })],
    };
    const { client, emit } = makeFakeSse();
    const stale: SpaceCanvasModel = {
      items: model.items,
      occurrences: [occ('b', { x: 44, y: 55 })],
    };
    const loadModel = vi.fn().mockResolvedValue(stale);

    render(
      h(SpaceCanvas, {
        ...baseProps,
        spaceId: 'sp1',
        initialModel: model,
        loadModel,
        createSse: () => client,
      }),
    );

    act(() => {
      lastOnNodesChange?.([{ type: 'position', id: 'a', position: { x: 25, y: 30 }, dragging: true }]);
    });

    await act(async () => {
      emit('space:occurrence:moved', { space_id: 'sp1' });
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(loadModel).toHaveBeenCalledWith('sp1'));
    const nodes = screen.getAllByTestId('rf-node');
    const dragged = nodes.find((node) => node.getAttribute('data-node-id') === 'a');
    expect(dragged?.getAttribute('data-x')).toBe('25');
    expect(dragged?.getAttribute('data-y')).toBe('30');
    expect(dragged?.getAttribute('data-dragging')).toBe('true');
  });

  it('ignores an out-of-order refetch that started before a drag stop', async () => {
    let resolveLoad: (model: SpaceCanvasModel) => void = () => {};
    const pendingLoad = new Promise<SpaceCanvasModel>((resolve) => {
      resolveLoad = resolve;
    });
    const model: SpaceCanvasModel = {
      items: [item('a', 'Alpha')],
      occurrences: [occ('a', { x: 10, y: 20 })],
    };
    const { client, emit } = makeFakeSse();
    const loadModel = vi.fn().mockReturnValue(pendingLoad);

    render(
      h(SpaceCanvas, {
        ...baseProps,
        spaceId: 'sp1',
        initialModel: model,
        loadModel,
        createSse: () => client,
      }),
    );

    act(() => {
      emit('space:occurrence:moved', { space_id: 'sp1' });
    });
    expect(loadModel).toHaveBeenCalledWith('sp1');

    act(() => {
      lastOnNodesChange?.([{ type: 'position', id: 'a', position: { x: 55, y: 66 }, dragging: false }]);
    });
    expect(screen.getByTestId('rf-node').getAttribute('data-x')).toBe('55');

    await act(async () => {
      resolveLoad({ items: model.items, occurrences: [occ('a', { x: 10, y: 20 })] });
      await pendingLoad;
      await Promise.resolve();
    });

    expect(screen.getByTestId('rf-node').getAttribute('data-x')).toBe('55');
    expect(screen.getByTestId('rf-node').getAttribute('data-y')).toBe('66');
  });

  it('keeps a dropped position when a post-save SSE refetch is stale', async () => {
    vi.useFakeTimers();
    const model: SpaceCanvasModel = {
      items: [item('a', 'Alpha')],
      occurrences: [occ('a', { x: 10, y: 20 })],
    };
    const { client, emit } = makeFakeSse();
    const stale: SpaceCanvasModel = {
      items: model.items,
      occurrences: [occ('a', { x: 10, y: 20 })],
    };
    const batchWrite = vi.fn().mockResolvedValue({ occurrences: [], created: 0, updated: 1 });
    const loadModel = vi.fn().mockResolvedValue(stale);

    render(
      h(SpaceCanvas, {
        ...baseProps,
        spaceId: 'sp1',
        initialModel: model,
        batchWrite,
        loadModel,
        createSse: () => client,
        debounceMs: 50,
      }),
    );

    act(() => {
      lastOnNodesChange?.([{ type: 'position', id: 'a', position: { x: 55, y: 66 }, dragging: false }]);
    });
    await act(async () => {
      vi.advanceTimersByTime(60);
      await Promise.resolve();
    });
    expect(batchWrite).toHaveBeenCalledWith('sp1', [{ id: 'a', x: 55, y: 66 }]);

    await act(async () => {
      emit('space:occurrence:moved', { space_id: 'sp1' });
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(loadModel).toHaveBeenCalledWith('sp1'));
    expect(screen.getByTestId('rf-node').getAttribute('data-x')).toBe('55');
    expect(screen.getByTestId('rf-node').getAttribute('data-y')).toBe('66');
  });

  it('keeps a preview-disabled dropped position when backend reconciliation refetches stale data', async () => {
    vi.useFakeTimers();
    const model: SpaceCanvasModel = {
      items: [item('a', 'Alpha')],
      occurrences: [occ('a', { x: 10, y: 20 })],
    };
    const { client, emit } = makeFakeSse();
    const stale: SpaceCanvasModel = {
      items: model.items,
      occurrences: [occ('a', { x: 10, y: 20 })],
    };
    const loadModel = vi.fn().mockResolvedValue(stale);
    const batchWrite = vi.fn();

    render(
      h(SpaceCanvas, {
        ...baseProps,
        spaceId: 'sp1',
        initialModel: model,
        batchWrite,
        loadModel,
        createSse: () => client,
        debounceMs: 50,
        instance: previewInstance(['ledger:read']),
      }),
    );

    act(() => {
      lastOnNodesChange?.([{ type: 'position', id: 'a', position: { x: 55, y: 66 }, dragging: false }]);
    });
    await act(async () => {
      vi.advanceTimersByTime(60);
      await Promise.resolve();
    });
    expect(batchWrite).not.toHaveBeenCalled();

    await act(async () => {
      emit('space:occurrence:moved', { space_id: 'sp1' });
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(loadModel).toHaveBeenCalledWith('sp1'));
    expect(screen.getByTestId('rf-node').getAttribute('data-x')).toBe('55');
    expect(screen.getByTestId('rf-node').getAttribute('data-y')).toBe('66');
  });

  it('accepts a newer server position after the saved drag is acknowledged', async () => {
    vi.useFakeTimers();
    const model: SpaceCanvasModel = {
      items: [item('a', 'Alpha')],
      occurrences: [occ('a', { x: 10, y: 20 })],
    };
    const { client, emit } = makeFakeSse();
    const newer: SpaceCanvasModel = {
      items: model.items,
      occurrences: [occ('a', { x: 70, y: 80, updated_at: 101 })],
    };
    const batchWrite = vi.fn().mockResolvedValue({
      occurrences: [occ('a', { x: 55, y: 66, updated_at: 100 })],
      created: 0,
      updated: 1,
    });
    const loadModel = vi.fn().mockResolvedValue(newer);

    render(
      h(SpaceCanvas, {
        ...baseProps,
        spaceId: 'sp1',
        initialModel: model,
        batchWrite,
        loadModel,
        createSse: () => client,
        debounceMs: 50,
      }),
    );

    act(() => {
      lastOnNodesChange?.([{ type: 'position', id: 'a', position: { x: 55, y: 66 }, dragging: false }]);
    });
    await act(async () => {
      vi.advanceTimersByTime(60);
      await Promise.resolve();
    });

    await act(async () => {
      emit('space:occurrence:moved', { space_id: 'sp1' });
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(loadModel).toHaveBeenCalledWith('sp1'));
    expect(screen.getByTestId('rf-node').getAttribute('data-x')).toBe('70');
    expect(screen.getByTestId('rf-node').getAttribute('data-y')).toBe('80');
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

describe('SpaceCanvas legacy unplaced placement', () => {
  it('auto-places an unplaced occurrence without rendering a shelf and queues a write', async () => {
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

    expect(screen.queryByTestId('space-canvas-shelf')).toBeNull();
    // Placement seeds via layoutGraph.
    await waitFor(() => expect(layoutCalls.count).toBeGreaterThanOrEqual(1));
    await waitFor(() =>
      expect(screen.getAllByTestId('rf-node').map((node) => node.getAttribute('data-node-id'))).toEqual([
        'a',
        'b',
      ]),
    );

    await act(async () => {
      vi.advanceTimersByTime(50);
    });
    expect(batchWrite).toHaveBeenCalledTimes(1);
    const [, entries] = batchWrite.mock.calls[0];
    expect(entries[0].id).toBe('b');
  });
});

// ============================================================================
// Edges: drag-to-connect (onConnect) + rendering space_edges on the canvas
// ============================================================================

describe('edgesToFlowEdges (pure)', () => {
  it('maps space_edges to React Flow edges between placed nodes (occurrence ids == node ids)', () => {
    const placed = new Set(['a', 'b', 'c']);
    const flow = edgesToFlowEdges([edge('e1', 'a', 'b', 'blocks'), edge('e2', 'b', 'c')], placed);
    expect(flow.map((e) => [e.id, e.source, e.target])).toEqual([
      ['e1', 'a', 'b'],
      ['e2', 'b', 'c'],
    ]);
    // Label passes through; an empty/null label becomes undefined (no chip).
    expect(flow[0].label).toBe('blocks');
    expect(flow[1].label).toBeUndefined();
  });

  it('skips edges whose endpoint is not currently placed on the canvas (shelf)', () => {
    const placed = new Set(['a']); // 'b' is on the shelf
    const flow = edgesToFlowEdges([edge('e1', 'a', 'b')], placed);
    expect(flow).toHaveLength(0);
  });

  it('marks the selected edge for React Flow styling', () => {
    const flow = edgesToFlowEdges([edge('e1', 'a', 'b')], new Set(['a', 'b']), 'e1');
    expect(flow[0].selected).toBe(true);
    expect(flow[0].markerEnd).toMatchObject({ color: 'var(--accent-blue)' });
  });

  it('reuses Flow edge objects across no-op echoes and replaces them when selected styling changes', () => {
    const placed = new Set(['a', 'b']);
    const first = reconcileFlowEdges([edge('e1', 'a', 'b', 'blocks')], placed, null);
    const second = reconcileFlowEdges([edge('e1', 'a', 'b', 'blocks')], placed, null, first);

    expect(second).toBe(first);
    expect(second[0]).toBe(first[0]);

    const selected = reconcileFlowEdges([edge('e1', 'a', 'b', 'blocks')], placed, 'e1', second);
    expect(selected).not.toBe(second);
    expect(selected[0]).not.toBe(second[0]);
    expect(selected[0]).toMatchObject({
      selected: true,
      className: 'space-canvas__edge',
      markerEnd: { color: 'var(--accent-blue)' },
    });
  });

  it('keeps the Flow edge array stable when no-op echoes include still-unplaced edges', () => {
    const placed = new Set(['a', 'b']);
    const modelEdges = [edge('visible', 'a', 'b'), edge('hidden', 'a', 'shelf')];
    const first = reconcileFlowEdges(modelEdges, placed, null);
    const second = reconcileFlowEdges(modelEdges, placed, null, first);

    expect(first).toHaveLength(1);
    expect(second).toBe(first);
    expect(second[0].id).toBe('visible');
  });

  it('reuses model edge objects across no-op SSE echoes', () => {
    const previous = [edge('e1', 'a', 'b', 'blocks')];
    const incoming = [edge('e1', 'a', 'b', 'blocks')];
    const next = reconcileEdges(incoming, new Set(), previous);

    expect(next).toBe(previous);
    expect(next[0]).toBe(previous[0]);
  });
});

describe('connectionToEdgeRequest (pure)', () => {
  it('builds a create request with an EMPTY label (no blocking prompt)', () => {
    expect(connectionToEdgeRequest({ source: 'a', target: 'b' } as never)).toEqual({
      source: 'a',
      target: 'b',
      label: '',
    });
  });

  it('rejects a self-loop or a connection missing an endpoint', () => {
    expect(connectionToEdgeRequest({ source: 'a', target: 'a' } as never)).toBeNull();
    expect(connectionToEdgeRequest({ source: 'a', target: null } as never)).toBeNull();
    expect(connectionToEdgeRequest({ source: null, target: 'b' } as never)).toBeNull();
  });
});

describe('SpaceCanvas renders authored edges as lines', () => {
  it('draws an rf-edge for each space_edge whose endpoints are both placed', () => {
    const model: SpaceCanvasModel = {
      items: [item('a', 'Alpha'), item('b', 'Beta')],
      occurrences: [occ('a', { x: 10, y: 20 }), occ('b', { x: 30, y: 40 })],
      edges: [edge('e1', 'a', 'b', 'relates')],
    };
    render(h(SpaceCanvas, { ...baseProps, spaceId: 'sp1', initialModel: model }));
    const rendered = screen.getAllByTestId('rf-edge');
    expect(rendered).toHaveLength(1);
    expect(rendered[0].getAttribute('data-edge-id')).toBe('e1');
    expect(rendered[0].getAttribute('data-source')).toBe('a');
    expect(rendered[0].getAttribute('data-target')).toBe('b');
  });

  it('selects an edge and edits its label through the Canvas inspector', async () => {
    const model: SpaceCanvasModel = {
      items: [item('a', 'Alpha'), item('b', 'Beta')],
      occurrences: [occ('a', { x: 10, y: 20 }), occ('b', { x: 30, y: 40 })],
      edges: [edge('e1', 'a', 'b', 'relates')],
    };
    const updateEdge = vi.fn().mockResolvedValue(edge('e1', 'a', 'b', 'blocks'));
    render(h(SpaceCanvas, { ...baseProps, spaceId: 'sp1', initialModel: model, updateEdge }));

    act(() => {
      lastOnEdgesChange?.([{ type: 'select', id: 'e1', selected: true }]);
    });
    expect(screen.getByTestId('rf-edge').getAttribute('data-selected')).toBe('true');
    expect(screen.getByTestId('space-canvas-edge-inspector')).toBeTruthy();

    const input = screen.getByTestId('space-canvas-edge-label-input') as HTMLInputElement;
    input.focus();
    fireEvent.input(input, { target: { value: 'blocks' } });
    await act(async () => {
      input.blur();
    });
    expect(updateEdge).toHaveBeenCalledWith('sp1', 'e1', { label: 'blocks' });
    expect(screen.queryByText(/saved/i)).toBeNull();
  });

  it('promotes and deletes a selected edge through the Canvas inspector', async () => {
    const model: SpaceCanvasModel = {
      items: [item('a', 'Alpha'), item('b', 'Beta')],
      occurrences: [occ('a', { x: 10, y: 20 }), occ('b', { x: 30, y: 40 })],
      edges: [edge('e1', 'a', 'b', 'blocks')],
    };
    const promote = vi.fn().mockResolvedValue({ action_id: 'act-1' });
    const removeEdge = vi.fn().mockResolvedValue(undefined);
    render(
      h(SpaceCanvas, {
        ...baseProps,
        spaceId: 'sp1',
        initialModel: model,
        promote,
        removeEdge,
      }),
    );

    act(() => {
      lastOnEdgesChange?.([{ type: 'select', id: 'e1', selected: true }]);
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('space-canvas-edge-promote-btn'));
    });
    expect(promote).toHaveBeenCalledWith({
      sourceRef: 'a',
      targetRef: 'b',
      linkType: 'blocks',
      note: 'blocks',
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('space-canvas-edge-delete-btn'));
    });
    expect(removeEdge).toHaveBeenCalledWith('sp1', 'e1');
    expect(screen.queryByTestId('rf-edge')).toBeNull();
  });
});

describe('SpaceCanvas onConnect (drag-to-create)', () => {
  it('calls createSpaceEdge with the two node ids and an empty label, then renders the new edge', async () => {
    const model: SpaceCanvasModel = {
      items: [item('a', 'Alpha'), item('b', 'Beta')],
      occurrences: [occ('a', { x: 10, y: 20 }), occ('b', { x: 30, y: 40 })],
      edges: [],
    };
    const createEdge = vi.fn().mockResolvedValue(edge('new1', 'a', 'b', ''));
    render(h(SpaceCanvas, { ...baseProps, spaceId: 'sp1', initialModel: model, createEdge }));

    // No edges yet.
    expect(screen.queryAllByTestId('rf-edge')).toHaveLength(0);

    // Simulate React Flow firing onConnect from a node-to-node drag.
    await act(async () => {
      lastOnConnect?.({ source: 'a', target: 'b' });
    });

    expect(createEdge).toHaveBeenCalledWith('sp1', { source: 'a', target: 'b', label: '' });
    // The created edge renders optimistically.
    await waitFor(() => expect(screen.getAllByTestId('rf-edge')).toHaveLength(1));
    expect(screen.getByTestId('rf-edge').getAttribute('data-edge-id')).toBe('new1');
  });

  it('ignores a self-loop connection (does not create an edge)', async () => {
    const model: SpaceCanvasModel = {
      items: [item('a', 'Alpha')],
      occurrences: [occ('a', { x: 10, y: 20 })],
      edges: [],
    };
    const createEdge = vi.fn();
    render(h(SpaceCanvas, { ...baseProps, spaceId: 'sp1', initialModel: model, createEdge }));
    await act(async () => {
      lastOnConnect?.({ source: 'a', target: 'a' });
    });
    expect(createEdge).not.toHaveBeenCalled();
  });

  it('does not duplicate an edge already present when an SSE echo arrives', async () => {
    const model: SpaceCanvasModel = {
      items: [item('a', 'Alpha'), item('b', 'Beta')],
      occurrences: [occ('a', { x: 10, y: 20 }), occ('b', { x: 30, y: 40 })],
      edges: [],
    };
    const created = edge('new1', 'a', 'b', '');
    const createEdge = vi.fn().mockResolvedValue(created);
    const { client, emit } = makeFakeSse();
    // The reconciliation loader returns the canonical edge list (with the new edge).
    const loadModel = vi.fn().mockResolvedValue({ ...model, edges: [created] });

    render(
      h(SpaceCanvas, {
        ...baseProps,
        spaceId: 'sp1',
        initialModel: model,
        createEdge,
        loadModel,
        createSse: () => client,
      }),
    );

    await act(async () => {
      lastOnConnect?.({ source: 'a', target: 'b' });
    });
    await waitFor(() => expect(screen.getAllByTestId('rf-edge')).toHaveLength(1));

    // An SSE created event refetches + reconciles; the edge must not duplicate.
    await act(async () => {
      emit('space:edge:created', { space_id: 'sp1' });
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(loadModel).toHaveBeenCalledWith('sp1'));
    expect(screen.getAllByTestId('rf-edge')).toHaveLength(1);
  });

  it('keeps the React Flow edge object stable when an SSE echo returns equivalent data', async () => {
    const existing = edge('e1', 'a', 'b', 'blocks');
    const model: SpaceCanvasModel = {
      items: [item('a', 'Alpha'), item('b', 'Beta')],
      occurrences: [occ('a', { x: 10, y: 20 }), occ('b', { x: 30, y: 40 })],
      edges: [existing],
    };
    const { client, emit } = makeFakeSse();
    const loadModel = vi.fn().mockResolvedValue({
      ...model,
      edges: [edge('e1', 'a', 'b', 'blocks')],
    });

    render(
      h(SpaceCanvas, {
        ...baseProps,
        spaceId: 'sp1',
        initialModel: model,
        loadModel,
        createSse: () => client,
      }),
    );

    const firstEdge = reactFlowEdgeSnapshots.at(-1)?.[0];
    await act(async () => {
      emit('space:edge:updated', { space_id: 'sp1' });
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(loadModel).toHaveBeenCalledWith('sp1'));

    expect(reactFlowEdgeSnapshots.at(-1)?.[0]).toBe(firstEdge);
  });

  it('reconciles a dropdown-created edge (SSE) onto the canvas without resetting selection', async () => {
    const model: SpaceCanvasModel = {
      items: [item('a', 'Alpha'), item('b', 'Beta')],
      occurrences: [occ('a', { x: 10, y: 20 }), occ('b', { x: 30, y: 40 })],
      edges: [],
    };
    const { client, emit } = makeFakeSse();
    // Simulates the SpaceEdgeLayer dropdown having created an edge server-side.
    const loadModel = vi
      .fn()
      .mockResolvedValue({ ...model, edges: [edge('drop1', 'a', 'b', 'manual')] });

    render(
      h(SpaceCanvas, {
        ...baseProps,
        spaceId: 'sp1',
        initialModel: model,
        loadModel,
        createSse: () => client,
      }),
    );

    expect(screen.queryAllByTestId('rf-edge')).toHaveLength(0);
    await act(async () => {
      emit('space:edge:created', { space_id: 'sp1' });
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getAllByTestId('rf-edge')).toHaveLength(1));
    expect(screen.getByTestId('rf-edge').getAttribute('data-edge-id')).toBe('drop1');
  });
});
