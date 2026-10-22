import { invalidateApiGetCache } from '../ui/src/api';
import { queryClient } from '../ui/src/query/client';
import { establishTestClientAccess } from './helpers/local-client-access';
// SpaceItemPicker tests (umbrella de56ffa, child e670176).
//
// Covers the search-and-add picker that adds issues/artifacts to the CURRENT
// space from inside the space view: candidate projection, title search filter,
// multi-select add (one addSpaceItem per selection), the afterAdd placement hook
// that materializes a placed canvas occurrence, and graceful already-present
// handling.
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';

import {
  SpaceItemPicker,
  issuesFromGraph,
  artifactsToCandidates,
  spacesFromGroups,
  matchesQuery,
  type PickerCandidate,
} from '../ui/src/views/spaces/SpaceItemPicker';
import type { GraphNode } from '../ui/src/types/graph';
import type { ArtifactRecord } from '../ui/src/api';

vi.mock('@xyflow/react', async () => {
  const { h } = await import('preact');
  const ReactFlow = (props: {
    nodes: Array<{
      id: string;
      data?: { label: string; kind: string };
      selected?: boolean;
      type?: string;
    }>;
    nodeTypes?: Record<string, (props: { data: { label: string; kind: string }; selected?: boolean }) => unknown>;
    children?: unknown;
  }) =>
    h(
      'div',
      { 'data-testid': 'rf-mock' },
      props.nodes.map((node) =>
        h(
          'div',
          { key: node.id, 'data-testid': 'rf-node', 'data-node-id': node.id },
          props.nodeTypes?.[node.type ?? ''] && node.data
            ? h(props.nodeTypes[node.type ?? '']!, { data: node.data, selected: node.selected })
            : node.id,
        ),
      ),
    );
  const Background = () => h('div', { 'data-testid': 'rf-bg' });
  const Controls = () => h('div', { 'data-testid': 'rf-controls' });
  const Handle = (props: { type?: string }) =>
    h('div', { 'data-testid': 'rf-handle', 'data-handle-type': props.type ?? '' });
  const Position = { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' };
  const MarkerType = { ArrowClosed: 'arrowclosed', Arrow: 'arrow' };
  return { ReactFlow, Background, Controls, Handle, Position, MarkerType };
});

beforeEach(async () => {
  invalidateApiGetCache(); queryClient.clear(); await establishTestClientAccess(); });

afterEach(() => {
  invalidateApiGetCache();
  queryClient.clear();
  cleanup();
  vi.unstubAllGlobals();
});

function candidate(over: Partial<PickerCandidate> = {}): PickerCandidate {
  return {
    key: 'issue:i1',
    ref_type: 'issue',
    ref_id: 'i1',
    title: 'Auth flow',
    projectLabel: 'alpha',
    ...over,
  };
}

describe('SpaceItemPicker projection helpers', () => {
  it('projects only issue graph nodes, preferring the ledger id', () => {
    const nodes: GraphNode[] = [
      { id: 'n1', type: 'issue', label: 'Issue One', detail: { ledger_issue_id: 'led-1', project_name: 'P' } },
      { id: 'n2', type: 'session', label: 'A session' } as unknown as GraphNode,
      { id: 'n3', type: 'issue', label: 'Issue Three', summary: { issue_id: 'disp-3' } } as unknown as GraphNode,
    ];
    const out = issuesFromGraph(nodes);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ ref_type: 'issue', ref_id: 'led-1', title: 'Issue One', projectLabel: 'P' });
    expect(out[1]).toMatchObject({ ref_id: 'disp-3', title: 'Issue Three' });
  });

  it('projects artifact records using metadata title then uri', () => {
    const records = [
      { id: 'a1', uri: 'artifact://a1', role: 'figure', metadata: { title: 'Chart' } },
      { id: 'a2', uri: 'artifact://a2', role: null, metadata: {} },
    ] as unknown as ArtifactRecord[];
    const out = artifactsToCandidates(records);
    expect(out[0]).toMatchObject({ ref_type: 'artifact', ref_id: 'a1', title: 'Chart', projectLabel: 'figure' });
    expect(out[1]).toMatchObject({ ref_id: 'a2', title: 'artifact://a2' });
  });

  it('projects grouped Spaces with type and project metadata, ordering same-project first', () => {
    const out = spacesFromGroups([
      {
        project_id: null,
        project_key: null,
        project_name: null,
        spaces: [
          { id: 'top', project_id: null, title: 'Top notes', default_renderer: 'collection', metadata: {} },
        ],
      },
      {
        project_id: 'other',
        project_key: 'feedbax',
        project_name: 'Feedbax',
        spaces: [
          { id: 'board-1', project_id: 'other', title: 'Board map', default_renderer: 'board', metadata: {} },
        ],
      },
      {
        project_id: 'prj1',
        project_key: 'mandible',
        project_name: 'Mandible',
        spaces: [
          { id: 'doc-1', project_id: 'prj1', title: 'Design doc', default_renderer: 'document', metadata: {} },
        ],
      },
    ] as never, 'prj1');
    expect(out[0]).toMatchObject({
      ref_type: 'space',
      ref_id: 'doc-1',
      title: 'Design doc',
      projectLabel: 'Mandible',
      metadata: {
        default_renderer: 'document',
        primary_type: 'document',
        primary_type_label: 'Document',
        project_id: 'prj1',
        project_label: 'Mandible',
      },
    });
    expect(out.map((candidate) => candidate.ref_id)).toEqual(['doc-1', 'board-1', 'top']);
  });

  it('matches by title, ref id, and project label', () => {
    const c = candidate({ title: 'Auth flow', ref_id: 'abc', projectLabel: 'alpha' });
    expect(matchesQuery(c, '')).toBe(true);
    expect(matchesQuery(c, 'auth')).toBe(true);
    expect(matchesQuery(c, 'ABC')).toBe(true);
    expect(matchesQuery(c, 'alph')).toBe(true);
    expect(matchesQuery(c, 'zzz')).toBe(false);
  });
});

describe('SpaceItemPicker component', () => {
  const loadIssues = async (): Promise<PickerCandidate[]> => [
    candidate({ key: 'issue:i1', ref_id: 'i1', title: 'Auth flow' }),
    candidate({ key: 'issue:i2', ref_id: 'i2', title: 'Rendering pipeline' }),
  ];
  const loadArtifacts = async (): Promise<PickerCandidate[]> => [
    candidate({ key: 'artifact:a1', ref_type: 'artifact', ref_id: 'a1', title: 'Benchmark chart' }),
  ];

  it('lists candidates from both sources and filters by the search text', async () => {
    render(
      h(SpaceItemPicker, {
        spaceId: 'sp1',
        projectId: 'prj1',
        loadIssues,
        loadArtifacts,
        addItem: vi.fn(),
      }),
    );
    expect(await screen.findByText('Auth flow')).toBeTruthy();
    expect(screen.getByText('Rendering pipeline')).toBeTruthy();
    expect(screen.getByText('Benchmark chart')).toBeTruthy();

    fireEvent.input(screen.getByTestId('space-item-picker-search'), { target: { value: 'render' } });
    await waitFor(() => {
      expect(screen.queryByText('Auth flow')).toBeNull();
      expect(screen.getByText('Rendering pipeline')).toBeTruthy();
    });
  });

  it('multi-selects and calls addSpaceItem once per selection, running afterAdd for created items', async () => {
    const addItem = vi
      .fn()
      .mockResolvedValueOnce({ item: { id: 'm1' }, created: true, already_present: false })
      .mockResolvedValueOnce({ item: { id: 'm2' }, created: true, already_present: false });
    const afterAdd = vi.fn().mockResolvedValue(undefined);
    const onAdded = vi.fn();

    render(
      h(SpaceItemPicker, { spaceId: 'sp1', projectId: 'prj1', loadIssues, loadArtifacts, addItem, afterAdd, onAdded }),
    );
    fireEvent.click(await screen.findByText('Auth flow'));
    fireEvent.click(screen.getByText('Benchmark chart'));
    expect(screen.getByTestId('space-item-picker-count').textContent).toContain('2 selected');

    fireEvent.click(screen.getByTestId('space-item-picker-add'));

    await waitFor(() => expect(addItem).toHaveBeenCalledTimes(2));
    expect(addItem).toHaveBeenNthCalledWith(1, 'sp1', expect.objectContaining({ ref_type: 'issue', ref_id: 'i1' }));
    expect(addItem).toHaveBeenNthCalledWith(2, 'sp1', expect.objectContaining({ ref_type: 'artifact', ref_id: 'a1' }));
    // The placement hook runs once per CREATED item.
    await waitFor(() => expect(afterAdd).toHaveBeenCalledTimes(2));
    expect(onAdded).toHaveBeenCalledWith({ added: 2, alreadyPresent: 0 });
  });

  it('runs the placement hook for an already-present Space member that is not in this view', async () => {
    const addItem = vi.fn().mockResolvedValue({ item: { id: 'm1' }, created: false, already_present: true });
    const afterAdd = vi.fn().mockResolvedValue(undefined);
    render(h(SpaceItemPicker, { spaceId: 'sp1', projectId: 'prj1', loadIssues, loadArtifacts, addItem, afterAdd }));
    fireEvent.click(await screen.findByText('Auth flow'));
    fireEvent.click(screen.getByTestId('space-item-picker-add'));

    await waitFor(() => expect(addItem).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(afterAdd).toHaveBeenCalledWith({ id: 'm1' }));
    expect((await screen.findByTestId('space-item-picker-feedback')).textContent).toContain('Already present');
  });

  it('lists existing Space members and disables rows already in the current view', async () => {
    const addItem = vi.fn();
    const afterAdd = vi.fn();
    render(
      h(SpaceItemPicker, {
        spaceId: 'sp1',
        projectId: 'prj1',
        loadIssues: async () => [],
        loadArtifacts: async () => [],
        addItem,
        afterAdd,
        existingItems: [
          { id: 'm1', space_id: 'sp1', ref_type: 'issue', ref_id: 'i1', ref_uri: null, title: 'Already visible' },
          { id: 'm2', space_id: 'sp1', ref_type: 'issue', ref_id: 'i2', ref_uri: null, title: 'Needs placement' },
        ] as never,
        isItemInView: (item) => item.id === 'm1',
        alreadyInViewLabel: 'Already on board',
      }),
    );

    const visible = await screen.findByText('Already visible');
    expect(visible.closest('button')?.getAttribute('disabled')).toBe('');
    expect(screen.getByText('Already on board')).toBeTruthy();
    fireEvent.click(screen.getByText('Needs placement'));
    fireEvent.click(screen.getByTestId('space-item-picker-add'));
    await waitFor(() => expect(afterAdd).toHaveBeenCalledWith(expect.objectContaining({ id: 'm2' })));
    expect(addItem).not.toHaveBeenCalled();
  });

  it('filters existing Space members by allowed ref types', async () => {
    render(
      h(SpaceItemPicker, {
        spaceId: 'sp1',
        projectId: 'prj1',
        includeIssues: false,
        includeArtifacts: false,
        includeSpaces: false,
        existingItemRefTypes: ['issue', 'comment', 'artifact', 'external_ref'],
        existingItems: [
          { id: 'm1', space_id: 'sp1', ref_type: 'issue', ref_id: 'i1', ref_uri: null, title: 'Visible issue' },
          { id: 'm2', space_id: 'sp1', ref_type: 'space', ref_id: 'doc-1', ref_uri: null, title: 'Linked doc' },
        ] as never,
        addItem: vi.fn(),
      }),
    );

    expect(await screen.findByText('Visible issue')).toBeTruthy();
    expect(screen.queryByText('Linked doc')).toBeNull();
  });

  it('surfaces an add failure without crashing', async () => {
    const addItem = vi.fn().mockRejectedValue(new Error('boom'));
    render(h(SpaceItemPicker, { spaceId: 'sp1', projectId: 'prj1', loadIssues, loadArtifacts, addItem }));
    fireEvent.click(await screen.findByText('Auth flow'));
    fireEvent.click(screen.getByTestId('space-item-picker-add'));
    const feedback = await screen.findByTestId('space-item-picker-feedback');
    expect(feedback.textContent).toContain('boom');
  });

  it('still lists the artifacts when the issue load fails', async () => {
    render(
      h(SpaceItemPicker, {
        spaceId: 'sp1',
        projectId: 'prj1',
        loadIssues: async () => {
          throw new Error('graph down');
        },
        loadArtifacts,
        addItem: vi.fn(),
      }),
    );
    expect(await screen.findByText('Benchmark chart')).toBeTruthy();
  });

  it('links an existing Space with explicit type and project metadata', async () => {
    const addItem = vi.fn().mockResolvedValue({
      item: {
        id: 'm-space',
        space_id: 'sp1',
        ref_type: 'space',
        ref_id: 'target-doc',
        ref_uri: null,
        title: 'Design doc',
        metadata: { default_renderer: 'document', project_label: 'Mandible' },
        created_at: 0,
        updated_at: 0,
      },
      created: true,
      already_present: false,
    });
    const afterAdd = vi.fn().mockResolvedValue(undefined);
    render(
      h(SpaceItemPicker, {
        spaceId: 'sp1',
        projectId: 'prj1',
        includeIssues: false,
        includeArtifacts: false,
        includeSpaces: true,
        title: 'Link Space',
        addButtonLabel: 'Link',
        loadSpaces: async () => [
          candidate({
            key: 'space:target-doc',
            ref_type: 'space',
            ref_id: 'target-doc',
            title: 'Design doc',
            projectLabel: 'Mandible',
            metadata: {
              default_renderer: 'document',
              primary_type: 'document',
              primary_type_label: 'Document',
              project_id: 'prj1',
              project_label: 'Mandible',
            },
          }),
          candidate({ key: 'space:sp1', ref_type: 'space', ref_id: 'sp1', title: 'Current', projectLabel: 'Mandible' }),
        ],
        addItem,
        afterAdd,
      }),
    );
    expect(await screen.findByText('Design doc')).toBeTruthy();
    expect(screen.queryByText('Current')).toBeNull();
    fireEvent.click(screen.getByText('Design doc'));
    fireEvent.click(screen.getByTestId('space-item-picker-add'));

    await waitFor(() => expect(addItem).toHaveBeenCalledTimes(1));
    expect(addItem).toHaveBeenCalledWith('sp1', {
      ref_type: 'space',
      ref_id: 'target-doc',
      ref_uri: null,
      title: 'Design doc',
      metadata: {
        default_renderer: 'document',
        primary_type: 'document',
        primary_type_label: 'Document',
        project_id: 'prj1',
        project_label: 'Mandible',
      },
    });
    await waitFor(() => expect(afterAdd).toHaveBeenCalledWith(expect.objectContaining({ ref_type: 'space' })));
  });
});

describe('SpaceCanvas afterAdd placement round trip', () => {
  it('creates a placed canvas occurrence so a new item lands directly on the canvas', async () => {
    // The canvas afterAdd hook is exercised end-to-end here: adding an item must
    // create a `canvas` occurrence with x/y immediately. The picker reads
    // candidates and posts through the real api client, so we stub fetch for the
    // graph/artifact/items/occurrence routes.
    const { SpaceCanvas } = await import('../ui/src/views/spaces/SpaceCanvas');

    const newOcc = {
      id: 'occ-new', space_id: 'sp1', item_id: 'new-item', renderer: 'canvas', x: 0, y: 0,
      parent_id: null, width: null, height: null, z_index: null, sort_key: null, section_id: null,
      note: null, metadata: {}, created_at: 0, updated_at: 0,
    };
    const newItem = {
      id: 'new-item', space_id: 'sp1', ref_type: 'issue', ref_id: 'i1', ref_uri: null, title: 'Auth flow',
      metadata: {}, created_at: 0, updated_at: 0,
    };

    let createOccurrenceCalls: unknown[] = [];
    let itemsPosted = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'GET' && url.includes('/api/graph')) {
        return new Response(
          JSON.stringify({ nodes: [{ id: 'n1', type: 'issue', label: 'Auth flow', detail: { ledger_issue_id: 'i1' } }], edges: [] }),
          { headers: { 'content-type': 'application/json' } },
        );
      }
      if (method === 'GET' && url.includes('/api/artifacts')) {
        return new Response(JSON.stringify({ artifacts: [] }), { headers: { 'content-type': 'application/json' } });
      }
      if (method === 'POST' && /\/api\/spaces\/sp1\/items$/.test(url)) {
        itemsPosted += 1;
        return new Response(JSON.stringify({ item: newItem, created: true, already_present: false }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      if (method === 'POST' && /\/api\/spaces\/sp1\/occurrences$/.test(url)) {
        createOccurrenceCalls.push(JSON.parse(String(init?.body ?? '{}')));
        return new Response(JSON.stringify({ occurrence: newOcc }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    // After the add, the reload reads back the new placed occurrence.
    let reloadCount = 0;
    const loadModel = vi.fn().mockImplementation(async () => {
      reloadCount += 1;
      return reloadCount === 1
        ? { occurrences: [], items: [] }
        : { occurrences: [newOcc], items: [newItem] };
    });

    const fakeSse = {
      connect: () => {},
      close: () => {},
      on: () => () => {},
      off: () => {},
    };

    render(
      h(SpaceCanvas, {
        spaceId: 'sp1',
        projectId: 'prj1',
        renderer: 'canvas' as const,
        loadModel,
        createSse: () => fakeSse as never,
      }),
    );

    // Open the add-items picker, pick the issue, add it.
    fireEvent.click(await screen.findByTestId('space-canvas-add-items'));
    fireEvent.click(await screen.findByText('Auth flow'));
    fireEvent.click(screen.getByTestId('space-item-picker-add'));

    await waitFor(() => expect(itemsPosted).toBe(1));
    // afterAdd materializes the placed canvas occurrence.
    await waitFor(() =>
      expect(createOccurrenceCalls).toContainEqual({
        item_id: 'new-item',
        renderer: 'canvas',
        x: 0,
        y: 0,
      }),
    );
    // And the reloaded occurrence is drawn on the canvas, with no shelf UI.
    await waitFor(() => expect(screen.getByTestId('space-canvas-node')).toBeTruthy());
    expect(screen.getByText('Auth flow')).toBeTruthy();
    expect(screen.queryByTestId('space-canvas-shelf')).toBeNull();

    vi.unstubAllGlobals();
  });

  it('links an existing Space from the canvas toolbar and places it as a node', async () => {
    const { SpaceCanvas } = await import('../ui/src/views/spaces/SpaceCanvas');

    const newOcc = {
      id: 'occ-space', space_id: 'sp1', item_id: 'space-item', renderer: 'canvas', x: 0, y: 0,
      parent_id: null, width: null, height: null, z_index: null, sort_key: null, section_id: null,
      note: null, metadata: {}, created_at: 0, updated_at: 0,
    };
    const newItem = {
      id: 'space-item',
      space_id: 'sp1',
      ref_type: 'space',
      ref_id: 'target-doc',
      ref_uri: null,
      title: 'Design doc',
      metadata: {
        default_renderer: 'document',
        primary_type: 'document',
        primary_type_label: 'Document',
        project_id: 'prj1',
        project_label: 'Mandible',
      },
      created_at: 0,
      updated_at: 0,
    };

    let itemPostBody: unknown = null;
    const createOccurrenceCalls: unknown[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'GET' && /\/api\/spaces$/.test(url)) {
        return new Response(
          JSON.stringify({
            groups: [
              {
                project_id: 'prj1',
                project_key: 'mandible',
                project_name: 'Mandible',
                spaces: [
                  {
                    id: 'sp1',
                    project_id: 'prj1',
                    title: 'Current canvas',
                    default_renderer: 'canvas',
                    metadata: {},
                    description: null,
                    created_at: 0,
                    updated_at: 0,
                  },
                  {
                    id: 'target-doc',
                    project_id: 'prj1',
                    title: 'Design doc',
                    default_renderer: 'document',
                    metadata: {},
                    description: null,
                    created_at: 0,
                    updated_at: 0,
                  },
                ],
              },
            ],
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }
      if (method === 'POST' && /\/api\/spaces\/sp1\/items$/.test(url)) {
        itemPostBody = JSON.parse(String(init?.body ?? '{}'));
        return new Response(JSON.stringify({ item: newItem, created: true, already_present: false }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      if (method === 'POST' && /\/api\/spaces\/sp1\/occurrences$/.test(url)) {
        createOccurrenceCalls.push(JSON.parse(String(init?.body ?? '{}')));
        return new Response(JSON.stringify({ occurrence: newOcc }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    let reloadCount = 0;
    const loadModel = vi.fn().mockImplementation(async () => {
      reloadCount += 1;
      return reloadCount === 1
        ? { occurrences: [], items: [] }
        : { occurrences: [newOcc], items: [newItem] };
    });
    const fakeSse = {
      connect: () => {},
      close: () => {},
      on: () => () => {},
      off: () => {},
    };

    render(
      h(SpaceCanvas, {
        spaceId: 'sp1',
        projectId: 'prj1',
        renderer: 'canvas' as const,
        loadModel,
        createSse: () => fakeSse as never,
      }),
    );

    fireEvent.click(await screen.findByTestId('space-canvas-link-space'));
    fireEvent.click(await screen.findByText('Design doc'));
    fireEvent.click(screen.getByTestId('space-item-picker-add'));

    await waitFor(() =>
      expect(itemPostBody).toMatchObject({
        ref_type: 'space',
        ref_id: 'target-doc',
        title: 'Design doc',
        metadata: {
          default_renderer: 'document',
          primary_type: 'document',
          primary_type_label: 'Document',
          project_id: 'prj1',
          project_label: 'Mandible',
        },
      }),
    );
    await waitFor(() =>
      expect(createOccurrenceCalls).toContainEqual({
        item_id: 'space-item',
        renderer: 'canvas',
        x: 0,
        y: 0,
      }),
    );
    await waitFor(() => expect(screen.getByTestId('space-canvas-linked-space-open')).toBeTruthy());
    expect(screen.getByText('Document')).toBeTruthy();

    vi.unstubAllGlobals();
  });
});
