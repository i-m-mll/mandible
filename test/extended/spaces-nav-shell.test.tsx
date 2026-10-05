import { AppShellProvider } from '../../ui/src/app-shell';
import { invalidateApiGetCache } from '../../ui/src/api';
import { queryClient } from '../../ui/src/query/client';
import { establishTestClientAccess } from '../helpers/local-client-access';
// Routing + shell tests for Spaces nav/route scaffold (umbrella de56ffa,
// child 22b50f5).
import { render as testingRender, screen, cleanup, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';

const getSpaceFactPacketMock = vi.hoisted(() => vi.fn());

vi.mock('../../ui/src/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../ui/src/api')>();
  return { ...actual, getSpaceFactPacket: getSpaceFactPacketMock };
});

import { parseRouteFromHash } from '../../ui/src/routing';
import { detailRequestKey, writePersistedDetail } from '../../ui/src/detail-cache';
import {
  SpacesViewShell,
  type SpaceRendererMountProps,
} from '../../ui/src/views/spaces/SpacesViewShell';
import type { Space, SpaceFactPacket } from '../../ui/src/api';

const render: typeof testingRender = (view, options) => {
  const wrap = (content: typeof view) => <AppShellProvider value={{
    active:true, noticeHost:document.getElementById('spaces-test-notices'), rightSidebar:null,
    registerRightSidebar:()=>()=>undefined, registerInitialRouteLoad:()=>undefined,
  }}>{content}</AppShellProvider>;
  const rendered=testingRender(wrap(view),options);
  return {...rendered,rerender:(next)=>rendered.rerender(wrap(next))};
};

function installMemoryLocalStorage(): void {
  const store = new Map<string, string>();
  const mem: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => {
      store.delete(key);
    },
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: mem, configurable: true, writable: true });
}

function makeSpace(overrides: Partial<Space> = {}): Space {
  return {
    id: 's1',
    project_id: 'p1',
    title: 'Canvas space',
    default_renderer: 'canvas',
    ...overrides,
  } as Space;
}

function makePacket(space: Space = makeSpace()): SpaceFactPacket {
  return {
    space,
    items: [],
    occurrences: [],
    edges: [],
  };
}

beforeEach(async () => {
  invalidateApiGetCache();
  queryClient.clear();
  await establishTestClientAccess();
  installMemoryLocalStorage();
  const host=document.createElement('div');host.id='spaces-test-notices';document.body.append(host);
  getSpaceFactPacketMock.mockReset();
});

afterEach(() => {
  invalidateApiGetCache();
  queryClient.clear();
  cleanup();
  document.getElementById('spaces-test-notices')?.remove();
});

describe('Spaces routing', () => {
  it('parses #/spaces into the spaces tab', () => {
    expect(parseRouteFromHash('#/spaces').tab).toBe('spaces');
  });

  it('preserves query params on the spaces route', () => {
    const route = parseRouteFromHash('#/spaces?project=p1&space=s1&renderer=canvas');
    expect(route.tab).toBe('spaces');
    expect(route.params).toMatchObject({ project: 'p1', space: 's1', renderer: 'canvas' });
  });

  it('defaults empty and unknown routes to spaces (graph demoted to drill-down)', () => {
    expect(parseRouteFromHash('').tab).toBe('spaces');
    expect(parseRouteFromHash('#/').tab).toBe('spaces');
    // An unknown path now falls back to spaces, not graph.
    expect(parseRouteFromHash('#/not-a-real-tab').tab).toBe('spaces');
    // Graph remains reachable as an explicit drill-down route.
    expect(parseRouteFromHash('#/graph').tab).toBe('graph');
  });
});

describe('SpacesViewShell', () => {
  it('renders the shell frame as a smoke test', () => {
    render(<SpacesViewShell projectId="p1" />);
    expect(screen.getByTestId('spaces-view-shell')).toBeTruthy();
    expect(screen.getByTestId('spaces-shell-body')).toBeTruthy();
  });

  it('defaults to the collection renderer and shows the empty-state when no renderer is registered', () => {
    render(<SpacesViewShell projectId="p1" />);
    const shell = screen.getByTestId('spaces-view-shell');
    expect(shell.getAttribute('data-active-renderer')).toBe('collection');
    expect(screen.getByTestId('spaces-shell-empty')).toBeTruthy();
  });

  it('normalizes an unknown renderer value back to the default', () => {
    render(<SpacesViewShell projectId="p1" renderer="bogus" />);
    expect(
      screen.getByTestId('spaces-view-shell').getAttribute('data-active-renderer'),
    ).toBe('collection');
  });

  it('honors a known renderer value', () => {
    render(<SpacesViewShell projectId="p1" renderer="canvas" />);
    expect(
      screen.getByTestId('spaces-view-shell').getAttribute('data-active-renderer'),
    ).toBe('canvas');
    expect(screen.getByTestId('spaces-shell-renderer').textContent).toBe('Canvas');
  });

  it('mounts a registered renderer at the matching mount point and forwards the fact packet', async () => {
    const seen: SpaceRendererMountProps[] = [];
    function CanvasMount(props: SpaceRendererMountProps): JSX.Element {
      seen.push(props);
      return <div data-testid="canvas-mount">canvas mount</div>;
    }
    const packet = makePacket();
    render(
      <SpacesViewShell
        projectId="p1"
        spaceId="s1"
        renderer="canvas"
        renderers={{ canvas: CanvasMount }}
        loadSpaceFactPacket={vi.fn().mockResolvedValue(packet)}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('canvas-mount')).toBeTruthy());
    // The empty-state is replaced when a renderer is registered.
    expect(screen.queryByTestId('spaces-shell-empty')).toBeNull();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ projectId: 'p1', spaceId: 's1', renderer: 'canvas' });
    expect(seen[0].initialFactPacket).toBe(packet);
  });

  it('passes the full canonical Space id to renderers after resolving a short route ref', async () => {
    const fullId = '7038d21f-b494-47fb-b9b8-d5fb93b3309a';
    const seen: SpaceRendererMountProps[] = [];
    function CanvasMount(props: SpaceRendererMountProps): JSX.Element {
      seen.push(props);
      return <div data-testid="canvas-mount">canvas mount</div>;
    }
    render(
      <SpacesViewShell
        projectId="rlrmp"
        spaceId="7038d21f"
        renderers={{ canvas: CanvasMount }}
        loadSpaceFactPacket={vi.fn().mockResolvedValue(makePacket(makeSpace({
          id: fullId,
          project_id: 'prj_00mpmto02f_ec55d4e21bfe5ce116fb',
        })))}
      />,
    );

    await waitFor(() => expect(screen.getByTestId('canvas-mount')).toBeTruthy());
    expect(seen.at(-1)).toMatchObject({
      projectId: 'prj_00mpmto02f_ec55d4e21bfe5ce116fb',
      spaceId: fullId,
    });
  });

  it('does not upgrade a short ref from one stale sidebar match when the backend reports ambiguity', async () => {
    const staleFullId = '7038d21f-b494-47fb-b9b8-d5fb93b3309a';
    localStorage.setItem('spaces-tree:groups:v1', JSON.stringify([{
      project_id: 'prj-stale',
      project_key: 'stale',
      project_name: 'Stale',
      spaces: [makeSpace({ id: staleFullId, project_id: 'prj-stale' })],
    }]));
    function CanvasMount(): JSX.Element {
      return <div data-testid="wrong-canvas-mount">wrong canvas</div>;
    }

    render(
      <SpacesViewShell
        projectId="stale"
        spaceId="7038d21f"
        renderers={{ canvas: CanvasMount }}
        loadSpaceFactPacket={vi.fn().mockRejectedValue(new Error("ambiguous space ref '7038d21f'"))}
      />,
    );

    await waitFor(() => expect(screen.getByText("ambiguous space ref '7038d21f'")).toBeTruthy());
    expect(screen.queryByTestId('wrong-canvas-mount')).toBeNull();
  });

  it('does not preload a persisted detail packet keyed by an unverified generated short ref', async () => {
    const shortRef = '7038d21f';
    writePersistedDetail(
      'spaces',
      detailRequestKey('spaces', { spaceId: shortRef }),
      makePacket(makeSpace({ id: '7038d21f-b494-47fb-b9b8-d5fb93b3309a' })),
    );
    function CanvasMount(): JSX.Element {
      return <div data-testid="wrong-cached-canvas-mount">wrong cached canvas</div>;
    }

    render(
      <SpacesViewShell
        projectId="rlrmp"
        spaceId={shortRef}
        renderers={{ canvas: CanvasMount }}
        loadSpaceFactPacket={vi.fn().mockRejectedValue(new Error("ambiguous space ref '7038d21f'"))}
      />,
    );

    await waitFor(() => expect(screen.getByText("ambiguous space ref '7038d21f'")).toBeTruthy());
    expect(screen.queryByTestId('wrong-cached-canvas-mount')).toBeNull();
  });

  it('does not mount an explicit renderer before or after a short ref is rejected as ambiguous', async () => {
    let rejectLoad: ((error: Error) => void) | undefined;
    getSpaceFactPacketMock.mockReturnValue(new Promise((_resolve, reject) => {
      rejectLoad = reject;
    }));
    const seenSpaceIds: Array<string | null> = [];
    function CanvasMount(props: SpaceRendererMountProps): JSX.Element {
      seenSpaceIds.push(props.spaceId);
      return <div data-testid="unresolved-explicit-canvas">canvas mount</div>;
    }

    render(
      <SpacesViewShell
        projectId="rlrmp"
        spaceId="7038d21f"
        renderer="canvas"
        renderers={{ canvas: CanvasMount }}
      />,
    );

    expect(getSpaceFactPacketMock).toHaveBeenCalledWith('7038d21f');
    const mountedBeforeRejection = screen.queryByTestId('unresolved-explicit-canvas');
    rejectLoad?.(new Error("ambiguous space ref '7038d21f'"));

    await waitFor(() => expect(screen.getByText("ambiguous space ref '7038d21f'")).toBeTruthy());
    expect(mountedBeforeRejection).toBeNull();
    expect(screen.queryByTestId('unresolved-explicit-canvas')).toBeNull();
    expect(seenSpaceIds).toEqual([]);
  });

  it('uses the cached primary renderer while waiting for the fact packet', () => {
    localStorage.setItem(
      'spaces:selected-space:v1',
      JSON.stringify({
        id: 's1',
        project_id: 'p1',
        title: 'Cached canvas',
        default_renderer: 'canvas',
      }),
    );
    const loadSpaceFactPacket = vi.fn(() => new Promise<SpaceFactPacket>(() => {}));
    const seen: SpaceRendererMountProps[] = [];
    function CanvasMount(props: SpaceRendererMountProps): JSX.Element {
      seen.push(props);
      return <div data-testid="canvas-mount">canvas mount</div>;
    }

    render(
      <SpacesViewShell
        projectId="p1"
        spaceId="s1"
        renderers={{ canvas: CanvasMount }}
        loadSpaceFactPacket={loadSpaceFactPacket}
      />,
    );

    expect(screen.getByTestId('spaces-view-shell').getAttribute('data-active-renderer')).toBe('canvas');
    expect(screen.getByTestId('spaces-shell-identity').textContent).toContain('Cached canvas');
    expect(screen.getByTestId('spaces-shell-loading')).toBeTruthy();
    expect(screen.queryByTestId('canvas-mount')).toBeNull();
    expect(seen).toHaveLength(0);
  });

  it('shows the selected Space read error when no cached snapshot exists', async () => {
    function CollectionMount(): JSX.Element {
      return <div data-testid="collection-mount">collection mount</div>;
    }
    const loadSpaceFactPacket = vi.fn().mockRejectedValue(new Error('space read failed'));

    render(
      <SpacesViewShell
        projectId="p1"
        spaceId="s1"
        renderers={{ collection: CollectionMount }}
        loadSpaceFactPacket={loadSpaceFactPacket}
      />,
    );

    await waitFor(() => expect(screen.getByText('space read failed')).toBeTruthy());
    expect(screen.queryByTestId('collection-mount')).toBeNull();
  });

  it('falls back to the empty-state when the active renderer has no registered mount point', () => {
    function CanvasMount(): JSX.Element {
      return <div data-testid="canvas-mount">canvas mount</div>;
    }
    // collection is active (default) but only a canvas mount is registered.
    render(<SpacesViewShell projectId="p1" renderers={{ canvas: CanvasMount }} />);
    expect(screen.queryByTestId('canvas-mount')).toBeNull();
    expect(screen.getByTestId('spaces-shell-empty')).toBeTruthy();
  });
});
