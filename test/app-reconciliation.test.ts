// @vitest-environment jsdom
import { railReorderReady, installMemoryLocalStorage, stubEventSource, stubRailSettingsFetch, railGroupLinks, mockRailRects, fireRailPointer, installPointerEventForTest, issueDetailProjection, render, reactFlowMockState, previewInstance, writablePreviewInstance } from './helpers/ui-workspace-fixture';
import { screen, fireEvent, waitFor, act, within } from './helpers/dom.js';
import { describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { App } from '../ui/src/app';
import { APP_RAIL_PREVIEW_ORDER_STORAGE_KEY } from '../ui/src/app-rail-order';
import { type InstanceInfo } from '../ui/src/api';
import { __resetAgentPageBindingForTests } from '../ui/src/agent-page-binding';
import { __resetBrowserSessionForTests } from '../ui/src/client-auth-token';
import { AppShellProvider } from '../ui/src/app-shell';
import { DetailPaneNotice } from '../ui/src/components/shared/DetailPaneNotice';

describe('app shell', () => {

  it('refetches a same-user SSE revision and ignores an already-applied echo', async () => {
    installMemoryLocalStorage();
    const firstOrder = JSON.stringify({
      version: 1,
      groups: { primary: ['issues', 'console'], secondary: ['logs', 'work'] },
    });
    const secondOrder = JSON.stringify({
      version: 1,
      groups: { primary: ['briefing', 'console'], secondary: ['graph', 'work'] },
    });
    const settings = stubRailSettingsFetch(firstOrder);
    const events = stubEventSource();
    window.history.replaceState(null, '', '#/spaces');

    const { container } = render(h(App, {}));
    await waitFor(() => expect(railGroupLinks(container, 'primary')[0]?.dataset.railItem).toBe('issues'));
    expect(settings.getCalls).toHaveBeenCalledTimes(1);

    settings.setRemote(secondOrder, 2);
    act(() => events.emit({
      type: 'user-setting:updated',
      data: { version: 1, key: 'app_rail_order', revision: 2 },
    }));
    await waitFor(() => expect(railGroupLinks(container, 'primary')[0]?.dataset.railItem).toBe('briefing'));
    expect(railGroupLinks(container, 'primary').slice(0, 2).map((link) => link.dataset.railItem))
      .toEqual(['briefing', 'console']);
    expect(railGroupLinks(container, 'secondary')[0]?.dataset.railItem).toBe('graph');
    expect(settings.getCalls).toHaveBeenCalledTimes(2);

    act(() => events.emit({
      type: 'user-setting:updated',
      data: { version: 1, key: 'app_rail_order', revision: 1 },
    }));
    await act(async () => Promise.resolve());
    expect(settings.getCalls).toHaveBeenCalledTimes(2);
  });

  it('converges two simultaneous same-user clients on one event revision', async () => {
    installMemoryLocalStorage();
    const firstOrder = JSON.stringify({
      version: 1,
      groups: { primary: ['issues', 'console'], secondary: [] },
    });
    const secondOrder = JSON.stringify({
      version: 1,
      groups: { primary: ['graph', 'work'], secondary: [] },
    });
    const settings = stubRailSettingsFetch(firstOrder);
    const events = stubEventSource();
    window.history.replaceState(null, '', '#/spaces');
    const shells = [render(h(App, {})).container, render(h(App, {})).container];

    await waitFor(() => {
      expect(railGroupLinks(shells[0]!, 'primary')[0]?.dataset.railItem).toBe('issues');
      expect(railGroupLinks(shells[1]!, 'primary')[0]?.dataset.railItem).toBe('issues');
    });
    expect(settings.getCalls).toHaveBeenCalledTimes(2);

    settings.setRemote(secondOrder, 2);
    act(() => events.emit({
      type: 'user-setting:updated',
      data: { version: 1, key: 'app_rail_order', revision: 2 },
    }));
    await waitFor(() => {
      expect(railGroupLinks(shells[0]!, 'primary')[0]?.dataset.railItem).toBe('work');
      expect(railGroupLinks(shells[1]!, 'primary')[0]?.dataset.railItem).toBe('work');
      expect(railGroupLinks(shells[0]!, 'secondary')[0]?.dataset.railItem).toBe('timeline');
      expect(railGroupLinks(shells[1]!, 'secondary')[0]?.dataset.railItem).toBe('timeline');
    });
    expect(settings.getCalls).toHaveBeenCalledTimes(4);
  });

  it('refetches the authenticated row when a missed-event client becomes visible again', async () => {
    installMemoryLocalStorage();
    const firstOrder = JSON.stringify({
      version: 1,
      groups: { primary: ['issues', 'console'], secondary: [] },
    });
    const secondOrder = JSON.stringify({
      version: 1,
      groups: { primary: ['tasks', 'spaces'], secondary: [] },
    });
    const settings = stubRailSettingsFetch(firstOrder);
    stubEventSource();
    window.history.replaceState(null, '', '#/spaces');
    const { container } = render(h(App, {}));

    await waitFor(() => expect(railGroupLinks(container, 'primary')[0]?.dataset.railItem).toBe('issues'));
    expect(settings.getCalls).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    settings.setRemote(secondOrder, 2);
    fireEvent(document, new Event('visibilitychange'));
    expect(settings.getCalls).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    fireEvent(document, new Event('visibilitychange'));
    await waitFor(() => expect(railGroupLinks(container, 'primary')[0]?.dataset.railItem).toBe('tasks'));
    expect(settings.getCalls).toHaveBeenCalledTimes(2);
  });

  it('does not let a stale SSE refetch overwrite a newer local mutation', async () => {
    installMemoryLocalStorage();
    (window as Window & { __MANDIBLE_BOOTSTRAP__?: { instance: InstanceInfo } }).__MANDIBLE_BOOTSTRAP__ = {
      instance: writablePreviewInstance,
    };
    let userGetCount = 0;
    let resolvePut!: (response: Response) => void;
    let resolveStaleGet!: (response: Response) => void;
    const putResponse = new Promise<Response>((resolve) => { resolvePut = resolve; });
    const staleGetResponse = new Promise<Response>((resolve) => { resolveStaleGet = resolve; });
    let localValue = '';
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/settings') {
        return Promise.resolve(new Response(JSON.stringify({}), {
          headers: { 'content-type': 'application/json' },
        }));
      }
      if (url === '/api/user-settings/app_rail_order' && init?.method !== 'PUT') {
        userGetCount += 1;
        if (userGetCount === 1) {
          return Promise.resolve(new Response(JSON.stringify({
            version: 1,
            key: 'app_rail_order',
            value: null,
            revision: 1,
          }), { headers: { 'content-type': 'application/json' } }));
        }
        return staleGetResponse;
      }
      if (url === '/api/user-settings/app_rail_order' && init?.method === 'PUT') {
        localValue = (JSON.parse(String(init.body)) as { value: string }).value;
        return putResponse;
      }
      if (url === '/api/dashboard/badges') {
        return Promise.resolve(new Response(JSON.stringify({ auth: 0, briefing: 0, inbox: 0, work: 0, incidents: 0, tasks: 0 }), {
          headers: { 'content-type': 'application/json' },
        }));
      }
      return Promise.resolve(new Response(JSON.stringify([]), {
        headers: { 'content-type': 'application/json' },
      }));
    }));
    const events = stubEventSource();
    window.history.replaceState(null, '', '#/spaces');
    const { container } = render(h(App, {}));
    await railReorderReady();

    const spaces = screen.getByRole('link', { name: 'Spaces' });
    spaces.focus();
    fireEvent.keyDown(spaces, { key: 'ArrowUp', ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(localValue).toContain('"secondary":["timeline","spaces","graph"]'));
    act(() => events.emit({
      type: 'user-setting:updated',
      data: { version: 1, key: 'app_rail_order', revision: 2 },
    }));
    await waitFor(() => expect(userGetCount).toBe(2));

    await act(async () => {
      resolvePut(new Response(JSON.stringify({
        version: 1,
        key: 'app_rail_order',
        value: localValue,
        revision: 3,
      }), { headers: { 'content-type': 'application/json' } }));
      await putResponse;
    });
    await act(async () => {
      resolveStaleGet(new Response(JSON.stringify({
        version: 1,
        key: 'app_rail_order',
        value: JSON.stringify({
          version: 1,
          groups: { primary: ['issues', 'console'], secondary: ['logs', 'work'] },
        }),
        revision: 2,
      }), { headers: { 'content-type': 'application/json' } }));
      await staleGetResponse;
    });

    await waitFor(() => expect(railGroupLinks(container, 'primary')[0]?.dataset.railItem).toBe('console'));
    const finalOrder = railGroupLinks(container, 'secondary').map((link) => link.dataset.railItem);
    expect(finalOrder.indexOf('spaces')).toBeLessThan(finalOrder.indexOf('graph'));
  });

  it('removes the reorder toggle and fails closed until authenticated user settings hydrate', async () => {
    const browserCachedOrder = JSON.stringify({
      version: 1,
      groups: { primary: ['briefing', 'console'], secondary: ['logs', 'work'] },
    });
    installMemoryLocalStorage({
      mandible_state_cache: JSON.stringify({
        v: 2,
        state: { settings: { app_rail_order: browserCachedOrder } },
      }),
    });
    installPointerEventForTest();
    (window as Window & { __MANDIBLE_BOOTSTRAP__?: { instance: InstanceInfo } }).__MANDIBLE_BOOTSTRAP__ = {
      instance: writablePreviewInstance,
    };
    let resolveUserSetting!: (response: Response) => void;
    const userSettingResponse = new Promise<Response>((resolve) => {
      resolveUserSetting = resolve;
    });
    const putCalls = vi.fn();
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/settings') return Promise.resolve(new Response(JSON.stringify({
        app_rail_order: browserCachedOrder,
      }), { headers: { 'content-type': 'application/json' } }));
      if (url === '/api/user-settings/app_rail_order' && init?.method !== 'PUT') {
        return userSettingResponse;
      }
      if (url === '/api/user-settings/app_rail_order' && init?.method === 'PUT') {
        putCalls(input, init);
        return Promise.resolve(new Response(JSON.stringify({
          version: 1,
          key: 'app_rail_order',
          value: (JSON.parse(String(init.body)) as { value: string }).value,
          revision: 1,
        }), { headers: { 'content-type': 'application/json' } }));
      }
      if (url === '/api/dashboard/badges') {
        return Promise.resolve(new Response(JSON.stringify({ auth: 0, briefing: 0, inbox: 0, work: 0, incidents: 0, tasks: 0 })));
      }
      return Promise.resolve(new Response(JSON.stringify([])));
    }));
    stubEventSource();
    window.history.replaceState(null, '', '#/spaces');
    render(h(App, {}));

    expect(screen.queryByRole('button', { name: 'Reorder navigation' })).toBeNull();
    expect(screen.getAllByRole('link')[0]?.getAttribute('data-rail-item')).toBe('console');
    const chat = screen.getByRole('link', { name: 'Chat' });
    fireRailPointer(chat, 'pointerdown', { pointerId: 12, button: 0, clientX: 10, clientY: 10 });
    fireRailPointer(chat, 'pointermove', { pointerId: 12, clientX: 80, clientY: 80 });
    fireRailPointer(chat, 'pointerup', { pointerId: 12, clientX: 80, clientY: 80 });
    expect(putCalls).not.toHaveBeenCalled();

    await act(async () => {
      resolveUserSetting(new Response(JSON.stringify({
        version: 1,
        key: 'app_rail_order',
        value: null,
        revision: 0,
      }), {
        headers: { 'content-type': 'application/json' },
      }));
      await userSettingResponse;
    });
    await railReorderReady();
    expect(putCalls).not.toHaveBeenCalled();
  });

  it('does not read or mutate user rail settings when capability is unknown', async () => {
    installMemoryLocalStorage();
    const fetchMock = vi.fn((input: RequestInfo | URL) => Promise.resolve(new Response(
      String(input) === '/api/settings' ? JSON.stringify({}) : JSON.stringify([]),
      { headers: { 'content-type': 'application/json' } },
    )));
    vi.stubGlobal('fetch', fetchMock);
    stubEventSource();
    window.history.replaceState(null, '', '#/spaces');
    render(h(App, {}));

    const spaces = await screen.findByRole('link', { name: 'Spaces' });
    spaces.focus();
    fireEvent.keyDown(spaces, { key: 'ArrowUp', ctrlKey: true, shiftKey: true });
    await act(async () => Promise.resolve());
    expect(fetchMock.mock.calls.some(([input]) => String(input).startsWith('/api/user-settings/'))).toBe(false);
  });

  it('does not infer reject-mode fallback from an authenticated-settings 403', async () => {
    installMemoryLocalStorage();
    (window as Window & { __MANDIBLE_BOOTSTRAP__?: { instance: InstanceInfo } }).__MANDIBLE_BOOTSTRAP__ = {
      instance: writablePreviewInstance,
    };
    const putCalls = vi.fn();
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/user-settings/app_rail_order' && init?.method !== 'PUT') {
        return Promise.resolve(new Response(JSON.stringify({
          error: 'Forbidden',
          code: 'forbidden',
        }), { status: 403, headers: { 'content-type': 'application/json' } }));
      }
      if (url === '/api/user-settings/app_rail_order' && init?.method === 'PUT') {
        putCalls(input, init);
      }
      if (url === '/api/settings') {
        return Promise.resolve(new Response(JSON.stringify({
          app_rail_order: JSON.stringify({
            version: 1,
            groups: { primary: ['issues', 'console'], secondary: ['logs', 'work'] },
          }),
        }), { headers: { 'content-type': 'application/json' } }));
      }
      return Promise.resolve(new Response(JSON.stringify([]), {
        headers: { 'content-type': 'application/json' },
      }));
    }));
    stubEventSource();
    window.history.replaceState(null, '', '#/spaces');
    const { container } = render(h(App, {}));

    await waitFor(() => expect(railGroupLinks(container, 'primary')[0]?.dataset.railItem).toBe('console'));
    const spaces = screen.getByRole('link', { name: 'Spaces' });
    fireEvent.keyDown(spaces, { key: 'ArrowUp', ctrlKey: true, shiftKey: true });
    await act(async () => Promise.resolve());
    expect(putCalls).not.toHaveBeenCalled();
    expect(railGroupLinks(container, 'primary')[0]?.dataset.railItem).toBe('console');
  });

  it('keeps repeated pointer frames over one captured target from undoing the drop', async () => {
    const ignoredPreviewOrder = JSON.stringify({
      version: 1,
      groups: { primary: ['briefing', 'console'], secondary: ['logs', 'work'] },
    });
    installMemoryLocalStorage({ [APP_RAIL_PREVIEW_ORDER_STORAGE_KEY]: ignoredPreviewOrder });
    installPointerEventForTest();
    (window as Window & { __MANDIBLE_BOOTSTRAP__?: { instance: InstanceInfo } }).__MANDIBLE_BOOTSTRAP__ = {
      instance: writablePreviewInstance,
    };
    const settings = stubRailSettingsFetch();
    stubEventSource();
    window.history.replaceState(null, '', '#/spaces');
    const mounted = render(h(App, {}));
    await railReorderReady();
    const primary = railGroupLinks(mounted.container, 'primary');
    expect(primary[0]?.dataset.railItem).toBe('console');
    mockRailRects(primary);
    const chat = primary.find((link) => link.dataset.railItem === 'console')!;

    fireRailPointer(chat, 'pointerdown', { pointerId: 18, button: 0, clientX: 12, clientY: 1 });
    fireRailPointer(chat, 'pointermove', { pointerId: 18, clientX: 12, clientY: 45 });
    fireRailPointer(chat, 'pointermove', { pointerId: 18, clientX: 12, clientY: 45 });
    fireRailPointer(chat, 'pointermove', { pointerId: 18, clientX: 12, clientY: 1 });
    fireRailPointer(chat, 'pointermove', { pointerId: 18, clientX: 12, clientY: 45 });
    fireRailPointer(chat, 'pointerup', { pointerId: 18, clientX: 12, clientY: 45 });

    await waitFor(() => expect(settings.putCalls).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(railGroupLinks(mounted.container, 'primary').slice(0, 2)
      .map((link) => link.dataset.railItem)).toEqual(['auth', 'console']));

    // The optimistic order precedes persistence; start the next drag only after its save completes.
    await waitFor(() => expect(within(screen.getByRole('navigation', { name: 'Main navigation' }))
      .getByRole('status').textContent).toContain('Chat moved to position'));

    const unifiedUpper = railGroupLinks(mounted.container, 'primary');
    mockRailRects(unifiedUpper);
    const projects = unifiedUpper.find((link) => link.dataset.railItem === 'work')!;
    fireRailPointer(projects, 'pointerdown', { pointerId: 19, button: 0, clientX: 12, clientY: 250 });
    fireRailPointer(projects, 'pointermove', { pointerId: 19, clientX: 12, clientY: 1 });
    fireRailPointer(projects, 'pointermove', { pointerId: 19, clientX: 12, clientY: 1 });
    fireRailPointer(projects, 'pointerup', { pointerId: 19, clientX: 12, clientY: 1 });

    await waitFor(() => expect(settings.putCalls).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(railGroupLinks(mounted.container, 'primary').slice(0, 3)
      .map((link) => link.dataset.railItem)).toEqual(['work', 'auth', 'console']));

    fireEvent.click(screen.getByRole('link', { name: 'Approvals' }));
    await waitFor(() => expect(window.location.hash).toBe('#/auth'));
    expect(railGroupLinks(mounted.container, 'primary').slice(0, 3)
      .map((link) => link.dataset.railItem)).toEqual(['work', 'auth', 'console']);

    mounted.unmount();
    window.history.replaceState(null, '', '#/spaces');
    const remounted = render(h(App, {}));
    await waitFor(() => expect(railGroupLinks(remounted.container, 'primary').slice(0, 3)
      .map((link) => link.dataset.railItem)).toEqual(['work', 'auth', 'console']));
    expect(settings.getStored()).toContain('"primary":["work","auth","console"');
    expect(settings.getStored()).toContain('"secondary":["timeline","graph","spaces"]');
    expect(settings.getStored()).not.toContain('"logs"');
    expect(window.localStorage.getItem(APP_RAIL_PREVIEW_ORDER_STORAGE_KEY)).toBe(ignoredPreviewOrder);
  });

  it('ignores a malformed preview override and skips durable settings under explicit reject', async () => {
    installMemoryLocalStorage({
      [APP_RAIL_PREVIEW_ORDER_STORAGE_KEY]: JSON.stringify({
        version: 1,
        groups: { primary: 'issues', secondary: [] },
      }),
    });
    (window as Window & { __MANDIBLE_BOOTSTRAP__?: { instance: InstanceInfo } }).__MANDIBLE_BOOTSTRAP__ = {
      instance: previewInstance,
    };
    const serverOrder = JSON.stringify({
      version: 1,
      groups: { primary: ['issues', 'console'], secondary: ['logs', 'work'] },
    });
    const settings = stubRailSettingsFetch(serverOrder);
    stubEventSource();
    window.history.replaceState(null, '', '#/spaces');
    const { container } = render(h(App, {}));

    await waitFor(() => expect(railGroupLinks(container, 'primary')[0]?.dataset.railItem).toBe('console'));
    expect(railGroupLinks(container, 'primary').slice(-3).map((link) => link.dataset.railItem))
      .toEqual(['inbox', 'work', 'tasks']);
    expect(settings.getCalls).not.toHaveBeenCalled();
    expect(settings.putCalls).not.toHaveBeenCalled();
  });

  it('restores server-authoritative order and announces a failed mutation', async () => {
    installMemoryLocalStorage();
    const settings = stubRailSettingsFetch(undefined, true);
    stubEventSource();
    window.history.replaceState(null, '', '#/spaces');
    const { container } = render(h(App, {}));
    await railReorderReady();
    const original = railGroupLinks(container, 'secondary').map((link) => link.dataset.railItem);
    const spaces = screen.getByRole('link', { name: 'Spaces' });
    spaces.focus();
    fireEvent.keyDown(spaces, { key: 'ArrowUp', ctrlKey: true, shiftKey: true });

    await waitFor(() => expect(within(screen.getByRole('navigation', { name: 'Main navigation' })).getByRole('status').textContent)
      .toBe('Navigation order was not saved. The previous order has been restored.'));
    expect(railGroupLinks(container, 'secondary').map((link) => link.dataset.railItem)).toEqual(original);
    await waitFor(() => expect(document.activeElement?.getAttribute('aria-label')).toBe('Spaces'));
    expect(settings.putCalls).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(APP_RAIL_PREVIEW_ORDER_STORAGE_KEY)).toBeNull();
  });

  it('renders a deep-linked issue detail while the global issue list is pending', async () => {
    stubEventSource();
    if (typeof window.localStorage.removeItem === 'function') {
      window.localStorage.removeItem('mandible_state_cache');
    }
    window.history.replaceState(
      null,
      '',
      '#/issues?repo=mandible&issue=4c26383&sidebar=hidden',
    );
    const fetchCalls: string[] = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      fetchCalls.push(url);
      if (url === '/api/issues') {
        return new Promise<Response>(() => undefined);
      }
      if (
        url === '/api/issues/mandible/4c26383/ledger-detail?stage=initial' ||
        url === '/api/issues/mandible/4c26383/ledger-detail'
      ) {
        return Promise.resolve(new Response(JSON.stringify(issueDetailProjection({
          displayId: '4c26383',
          title: 'Route detail before list',
          comments: ['Detail loaded before sidebar list'],
          stage: url.includes('stage=initial') ? 'initial' : 'full',
        })), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (url === '/api/inbox/global') {
        return Promise.resolve(new Response(JSON.stringify({
          continuations: [],
          auth_results: [],
          open_issues: [],
          total: 0,
        }), { headers: { 'Content-Type': 'application/json' } }));
      }
      if (url.startsWith('/api/conversations')) {
        return Promise.resolve(new Response(JSON.stringify({ conversations: [], total: 0 }), {
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      if (url === '/api/settings') {
        return Promise.resolve(new Response(JSON.stringify({}), {
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      return Promise.resolve(new Response(JSON.stringify([]), {
        headers: { 'Content-Type': 'application/json' },
      }));
    }));

    render(h(App, {}));

    expect(await screen.findByRole('heading', { name: 'Route detail before list' })).toBeTruthy();
    expect(screen.getByText('Detail loaded before sidebar list')).toBeTruthy();
    expect(fetchCalls).toContain('/api/issues');
    expect(fetchCalls).toContain('/api/issues/mandible/4c26383/ledger-detail?stage=initial');
  });

  it('updates Graph selection without remounting the flow canvas', async () => {
    stubEventSource();
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/graph?')) {
        return Promise.resolve(
          new Response(JSON.stringify({
            mode: 'activity',
            nodes: [
              {
                id: 'alpha',
                type: 'repo',
                label: 'alpha',
                status: 'active',
                repo: 'mandible',
              },
              {
                id: 'beta',
                type: 'repo',
                label: 'beta',
                status: 'active',
                repo: 'mandible',
              },
            ],
            edges: [{
              id: 'alpha-beta',
              type: 'related',
              source: 'alpha',
              target: 'beta',
            }],
          }), {
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify([]), {
          headers: { 'content-type': 'application/json' },
        }),
      );
    }));
    window.history.replaceState(null, '', '#/graph');

    render(h(App, {}));

    await waitFor(() => expect(screen.getByLabelText('Show Graph detail')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('Show Graph detail'));
    await waitFor(() => expect(
      within(screen.getByLabelText('Graph detail')).getByRole('heading', { name: 'alpha' }),
    ).toBeTruthy());
    expect(reactFlowMockState.mountCount).toBe(1);

    fireEvent.click(screen.getByLabelText('Select graph node rf_beta'));

    await waitFor(() => expect(
      within(screen.getByLabelText('Graph detail')).getByRole('heading', { name: 'beta' }),
    ).toBeTruthy());
    expect(reactFlowMockState.mountCount).toBe(1);
    expect(reactFlowMockState.unmountCount).toBe(0);
  });

  it('does not publish notices from a mounted inactive route', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const inactive = {
      active: false,
      noticeHost: host,
      rightSidebar: null,
      registerRightSidebar: () => () => undefined,
      registerInitialRouteLoad: () => undefined,
      updateRightSidebar: () => undefined,
    };
    render(h(AppShellProvider, { value: inactive }, [
      h(DetailPaneNotice, { severity: 'error', title: 'Detail unavailable' }, 'Hidden failure.'),
      h(DetailPaneNotice, { severity: 'warning', source: 'local-access' }, 'Connecting.'),
      h(DetailPaneNotice, { severity: 'success' }, 'Saved.'),
    ]));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    expect(host.childElementCount).toBe(0);
    host.remove();
  });
});
