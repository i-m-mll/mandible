import { AppShellProvider } from '../ui/src/app-shell';
import { invalidateApiGetCache } from '../ui/src/api';
import { queryClient } from '../ui/src/query/client';
import { establishTestClientAccess } from './helpers/local-client-access';
// Routing + shell tests for Spaces nav/route scaffold (umbrella de56ffa,
// child 22b50f5).
import { render as testingRender, screen, cleanup, waitFor } from './helpers/dom.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getSpaceFactPacketMock = vi.hoisted(() => vi.fn());

vi.mock('../ui/src/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ui/src/api')>();
  return { ...actual, getSpaceFactPacket: getSpaceFactPacketMock };
});

import { detailRequestKey, writePersistedDetail } from '../ui/src/detail-cache';
import {
  SpacesViewShell,
  type SpaceRendererMountProps,
} from '../ui/src/views/spaces/SpacesViewShell';
import type { Space, SpaceFactPacket } from '../ui/src/api';

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

describe('SpacesViewShell', () => {
  it('normalizes an unknown renderer value back to the default', () => {
    render(<SpacesViewShell projectId="p1" renderer="bogus" />);
    expect(
      screen.getByTestId('spaces-view-shell').getAttribute('data-active-renderer'),
    ).toBe('collection');
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
});
