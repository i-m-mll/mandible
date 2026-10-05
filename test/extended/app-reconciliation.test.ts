import { railReorderReady, changeSelect, installMemoryLocalStorage, stubEventSource, stubAppShellFetch, stubRailSettingsFetch, railGroupLinks, mockRailRects, fireRailPointer, installPointerEventForTest, issueDetailProjection, render, reactFlowMockState, previewInstance, mainInstance, writablePreviewInstance } from '../helpers/ui-workspace-fixture';
import { screen, fireEvent, waitFor, act, within } from '@testing-library/preact';
import { describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { useCallback, useMemo, useRef, useState } from 'preact/hooks';
import { initialState, loadCachedState, saveCachedState } from '../../ui/src/state';
import { App } from '../../ui/src/app';
import { APP_RAIL_PREVIEW_ORDER_STORAGE_KEY } from '../../ui/src/app-rail-order';
import { getSettings, invalidateApiGetCache, type InstanceInfo } from '../../ui/src/api';
import { __resetAgentPageBindingForTests, adoptAgentSessionBinding } from '../../ui/src/agent-page-binding';
import { __resetBrowserSessionForTests } from '../../ui/src/client-auth-token';
import { AppShellProvider, RightSidebarIcon, useRegisterAppRightSidebar, type AppRightSidebarDescriptor, type AppShellContextValue } from '../../ui/src/app-shell';
import { GraphView } from '../../ui/src/views/graph';
import { readResolvedStylesheet } from '../helpers/css-manifest';

describe('app shell', () => {
  function RegisteredSidebar(): JSX.Element {
    const descriptor = useMemo<AppRightSidebarDescriptor>(() => ({
      id: 'test-panel',
      kind: 'panel',
      title: 'inspector',
      ariaLabel: 'Test inspector',
      open: true,
      width: 360,
      onOpenChange: () => undefined,
      onWidthChange: () => undefined,
      content: h('div', {}, 'Inspector content'),
    }), []);

    useRegisterAppRightSidebar(descriptor);
    return h('main', {}, 'Workspace');
  }

  function ShellProbe(): JSX.Element {
    const [rightSidebar, setRightSidebar] = useState<AppRightSidebarDescriptor | null>(null);
    const ownerRef = useRef<string | null>(null);
    const registerRightSidebar = useCallback((ownerId: string) => {
      ownerRef.current = ownerId;
      return () => setRightSidebar((current) => (current?.id === ownerId ? null : current));
    }, []);
    const updateRightSidebar = useCallback((ownerId: string, descriptor: AppRightSidebarDescriptor) => {
      if (ownerRef.current === ownerId) setRightSidebar(descriptor);
    }, []);
    const shell = useMemo<AppShellContextValue>(() => ({
      rightSidebar,
      registerRightSidebar,
      registerInitialRouteLoad: () => undefined,
      updateRightSidebar,
      setViewSidebarWidth: () => undefined,
      active: true,
    }), [rightSidebar, registerRightSidebar, updateRightSidebar]);

    return h(AppShellProvider, { value: shell }, [
      h('header', { className: 'app-header' }, [
        h('span', { className: 'app-header__brand-text' }, 'Mandible'),
        h('span', { className: 'app-header__route' }, 'Timeline'),
        rightSidebar?.content
          ? h('button', {
            type: 'button',
            'aria-label': rightSidebar.open ? `Hide ${rightSidebar.ariaLabel}` : `Show ${rightSidebar.ariaLabel}`,
            onClick: () => setRightSidebar({
              ...rightSidebar,
              open: !rightSidebar.open,
            }),
          }, h(RightSidebarIcon, {}))
          : null,
      ]),
      h(RegisteredSidebar, {}),
      rightSidebar?.open && rightSidebar.content
        ? h('aside', { className: 'app-right-sidebar', 'aria-label': rightSidebar.ariaLabel }, [
          h('div', { className: 'app-right-sidebar__content' }, rightSidebar.content),
        ])
        : null,
    ]);
  }


  it('renders shared header identity, route title, and registered right sidebar toggle', async () => {
    render(h(ShellProbe, {}));

    expect(screen.getByText('Mandible')).toBeTruthy();
    expect(screen.getByText('Timeline')).toBeTruthy();
    await waitFor(() => expect(screen.getByLabelText('Hide Test inspector')).toBeTruthy());
    expect(screen.getByLabelText('Test inspector')).toBeTruthy();
    expect(screen.getByText('Inspector content')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Hide Test inspector'));
    expect(screen.getByLabelText('Show Test inspector')).toBeTruthy();
    expect(screen.queryByLabelText('Test inspector')).toBeNull();
  });

  it('reconciles legacy groups into one upper order and keeps Logs adjacent to Settings', async () => {
    installMemoryLocalStorage();
    const stored = JSON.stringify({
      version: 1,
      groups: {
        primary: ['issues', 'settings', 'console', 'issues', 'unknown', 'timeline', 'auth', 'artifacts', 'spaces', 'briefing', 'inbox'],
        secondary: ['logs', 'work', 'graph'],
      },
    });
    stubRailSettingsFetch(stored);
    stubEventSource();
    window.history.replaceState(null, '', '#/spaces');

    const { container } = render(h(App, {}));
    await waitFor(() => expect(railGroupLinks(container, 'primary')[0]?.dataset.railItem).toBe('issues'));

    expect(railGroupLinks(container, 'primary').map((link) => link.dataset.railItem)).toEqual([
      'issues', 'console', 'auth', 'artifacts', 'briefing', 'inbox', 'work', 'tasks',
    ]);
    expect(railGroupLinks(container, 'secondary').map((link) => link.dataset.railItem)).toEqual([
      'graph', 'timeline', 'spaces',
    ]);
    expect(container.querySelectorAll('.app-rail__group[data-rail-group="upper"]')).toHaveLength(1);
    expect(container.querySelectorAll('.app-rail__group[data-rail-group="experimental"]')).toHaveLength(1);
    const footer = screen.getByRole('link', { name: 'Settings' }).closest('.app-rail__footer');
    expect(footer).toBeTruthy();
    const fixedLinks = Array.from(footer?.querySelectorAll('a') ?? []);
    expect(fixedLinks.slice(-2).map((link) => link.getAttribute('aria-label'))).toEqual(['Logs', 'Settings']);
    for (const fixed of fixedLinks) {
      expect(fixed.hasAttribute('data-rail-item')).toBe(false);
      expect(fixed.hasAttribute('data-rail-group')).toBe(false);
      expect(fixed.hasAttribute('draggable')).toBe(false);
      expect(fixed.hasAttribute('aria-keyshortcuts')).toBe(false);
      expect(fixed.hasAttribute('aria-describedby')).toBe(false);
    }
    const css = readResolvedStylesheet();
    expect(screen.getByRole('link', { name: 'Spaces' }).getAttribute('aria-current')).toBe('page');
    await waitFor(() => expect(vi.mocked(fetch).mock.calls
      .some(([input]) => String(input) === '/api/dashboard/badges')).toBe(true));
    expect(screen.getByRole('link', { name: 'Briefing' })
      .querySelector('.app-rail__badge')).toBeNull();
  });

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
    const { container } = render(h('div', {}, h(App, {}), h(App, {})));
    const shells = Array.from(container.querySelectorAll<HTMLElement>('.app-shell'));
    expect(shells).toHaveLength(2);

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

  it('converges from the authenticated row during disconnected-stream recovery polling', async () => {
    vi.useFakeTimers();
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

    await vi.waitFor(() => {
      expect(railGroupLinks(container, 'primary')[0]?.dataset.railItem).toBe('issues');
    });
    expect(settings.getCalls).toHaveBeenCalledTimes(1);

    settings.setRemote(secondOrder, 2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(railGroupLinks(container, 'primary')[0]?.dataset.railItem).toBe('tasks');
    expect(settings.getCalls).toHaveBeenCalledTimes(2);
  });

  it('quarantines legacy global and browser-cached rail order bytes', async () => {
    const staleOrder = JSON.stringify({
      version: 1,
      groups: { primary: ['briefing'], secondary: [] },
    });
    installMemoryLocalStorage({
      mandible_state_cache: JSON.stringify({
        v: 2,
        state: { settings: { app_theme: 'codex', app_rail_order: staleOrder } },
      }),
    });

    expect(loadCachedState().settings).toEqual({ app_theme: 'codex' });
    saveCachedState({
      ...initialState,
      settings: { app_theme: 'codex', app_rail_order: staleOrder },
    });
    expect(JSON.parse(window.localStorage.getItem('mandible_state_cache') ?? '{}')
      .state.settings).toEqual({ app_theme: 'codex' });

    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      app_theme: 'codex',
      app_rail_order: staleOrder,
    }), { headers: { 'content-type': 'application/json' } }))));
    invalidateApiGetCache();
    await expect(getSettings()).resolves.toEqual({ app_theme: 'codex' });
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
        return Promise.resolve(new Response(JSON.stringify({ auth: 0, briefing: 0, inbox: 0 }), {
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

  it('fails an old settings envelope closed and inserts a returning destination canonically', async () => {
    installMemoryLocalStorage();
    __resetAgentPageBindingForTests();
    const stored = JSON.stringify({
      version: 0,
      groups: { primary: ['issues', 'console'], secondary: ['logs', 'work'] },
    });
    stubRailSettingsFetch(stored);
    stubEventSource();
    window.history.replaceState(null, '', '#/spaces');

    const { container } = render(h(App, {}));
    await waitFor(() => expect(railGroupLinks(container, 'primary')[0]?.dataset.railItem).toBe('console'));
    expect(railGroupLinks(container, 'primary').slice(-3).map((link) => link.dataset.railItem))
      .toEqual(['inbox', 'work', 'tasks']);
    expect(railGroupLinks(container, 'secondary').map((link) => link.dataset.railItem))
      .toEqual(['timeline', 'graph', 'spaces']);

    act(() => adoptAgentSessionBinding('returning-session'));
    await waitFor(() => expect(railGroupLinks(container, 'primary')[0]?.dataset.railItem).toBe('overview'));
    expect(railGroupLinks(container, 'primary')[1]?.dataset.railItem).toBe('console');
    __resetAgentPageBindingForTests();
  });

  it('keeps click navigation intact below the pointer movement threshold', async () => {
    installMemoryLocalStorage();
    installPointerEventForTest();
    const { putCalls } = stubRailSettingsFetch();
    stubEventSource();
    window.history.replaceState(null, '', '#/spaces');
    render(h(App, {}));
    const chat = await screen.findByRole('link', { name: 'Chat' });

    fireRailPointer(chat, 'pointerdown', { pointerId: 3, button: 2, clientX: 10, clientY: 10 });
    fireRailPointer(chat, 'pointermove', { pointerId: 3, button: 2, clientX: 80, clientY: 80 });
    fireRailPointer(chat, 'pointerup', { pointerId: 3, button: 2, clientX: 80, clientY: 80 });
    fireEvent.contextMenu(chat);
    let modifierClickPrevented = true;
    document.addEventListener('click', (event) => {
      modifierClickPrevented = event.defaultPrevented;
      event.preventDefault();
    }, { once: true });
    fireEvent.click(chat, { ctrlKey: true });
    expect(modifierClickPrevented).toBe(false);
    expect(window.location.hash).toBe('#/spaces');

    fireRailPointer(chat, 'pointerdown', { pointerId: 4, button: 0, clientX: 10, clientY: 10 });
    fireRailPointer(chat, 'pointermove', { pointerId: 4, clientX: 13, clientY: 12 });
    fireRailPointer(chat, 'pointerup', { pointerId: 4, clientX: 13, clientY: 12 });
    fireEvent.click(chat);

    expect(window.location.hash).toBe('#/console');
    expect(putCalls).not.toHaveBeenCalled();
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
        return Promise.resolve(new Response(JSON.stringify({ auth: 0, briefing: 0, inbox: 0 })));
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

  it('pointer-reorders inside one group, suppresses the drag click, and cancels cleanly', async () => {
    installMemoryLocalStorage();
    installPointerEventForTest();
    const { putCalls } = stubRailSettingsFetch();
    stubEventSource();
    window.history.replaceState(null, '', '#/spaces');
    const mounted = render(h(App, {}));
    await railReorderReady();
    const primary = railGroupLinks(mounted.container, 'primary');
    mockRailRects(primary);
    const briefing = primary.find((link) => link.dataset.railItem === 'briefing')!;
    const capture = vi.fn();
    briefing.setPointerCapture = capture;

    fireRailPointer(briefing, 'pointerdown', { pointerId: 8, button: 0, clientX: 12, clientY: 250 });
    expect(capture).toHaveBeenCalledWith(8);
    fireRailPointer(briefing, 'pointermove', { pointerId: 8, clientX: 12, clientY: 1 });
    expect(briefing.classList.contains('app-rail__item--dragging')).toBe(true);
    fireRailPointer(briefing, 'pointerup', { pointerId: 8, clientX: 12, clientY: 1 });
    fireEvent.click(briefing);

    await waitFor(() => expect(putCalls).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(railGroupLinks(mounted.container, 'primary')[0]?.dataset.railItem).toBe('briefing'));
    expect(window.location.hash).toBe('#/spaces');
    expect(railGroupLinks(mounted.container, 'primary').slice(-3).map((link) => link.dataset.railItem))
      .toEqual(['inbox', 'work', 'tasks']);
    expect(screen.getByRole('link', { name: 'Logs' }).hasAttribute('data-rail-item')).toBe(false);

    const inbox = railGroupLinks(mounted.container, 'primary').find((link) => link.dataset.railItem === 'inbox')!;
    mockRailRects(railGroupLinks(mounted.container, 'primary'));
    fireRailPointer(inbox, 'pointerdown', { pointerId: 9, button: 0, clientX: 12, clientY: 250 });
    fireRailPointer(inbox, 'pointermove', { pointerId: 9, clientX: 12, clientY: 1 });
    fireRailPointer(inbox, 'pointercancel', { pointerId: 9 });
    expect(railGroupLinks(mounted.container, 'primary')[0]?.dataset.railItem).toBe('briefing');
    expect(putCalls).toHaveBeenCalledTimes(1);
  });

  it('keeps Logs and every footer utility outside pointer and keyboard reorder contracts', async () => {
    installMemoryLocalStorage();
    installPointerEventForTest();
    const settings = stubRailSettingsFetch();
    stubEventSource();
    window.history.replaceState(null, '', '#/spaces');
    const { container } = render(h(App, {}));
    await railReorderReady();
    const before = railGroupLinks(container, 'primary').map((link) => link.dataset.railItem);
    const footer = container.querySelector<HTMLElement>('.app-rail__footer')!;
    const fixedControls = Array.from(footer.querySelectorAll<HTMLElement>('a, button'));

    for (const control of fixedControls) {
      expect(control.hasAttribute('data-rail-item')).toBe(false);
      expect(control.hasAttribute('data-rail-group')).toBe(false);
      expect(control.hasAttribute('draggable')).toBe(false);
      expect(control.hasAttribute('aria-keyshortcuts')).toBe(false);
      expect(control.hasAttribute('aria-describedby')).toBe(false);
    }

    const logs = screen.getByRole('link', { name: 'Logs' });
    fireRailPointer(logs, 'pointerdown', { pointerId: 31, button: 0, clientX: 12, clientY: 100 });
    fireRailPointer(logs, 'pointermove', { pointerId: 31, clientX: 12, clientY: 1 });
    fireRailPointer(logs, 'pointerup', { pointerId: 31, clientX: 12, clientY: 1 });
    fireEvent.keyDown(logs, { key: 'ArrowUp', ctrlKey: true, shiftKey: true });
    await act(async () => Promise.resolve());

    expect(settings.putCalls).not.toHaveBeenCalled();
    expect(logs.classList.contains('app-rail__item--dragging')).toBe(false);
    expect(railGroupLinks(container, 'primary').map((link) => link.dataset.railItem)).toEqual(before);
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

  it('persists physical pointer reorder locally only for an explicit reject preview', async () => {
    installMemoryLocalStorage();
    installPointerEventForTest();
    (window as Window & { __MANDIBLE_BOOTSTRAP__?: { instance: InstanceInfo } }).__MANDIBLE_BOOTSTRAP__ = {
      instance: previewInstance,
    };
    const settings = stubRailSettingsFetch(undefined, true);
    stubEventSource();
    window.history.replaceState(null, '', '#/spaces');
    const mounted = render(h(App, {}));
    await railReorderReady();
    const primary = railGroupLinks(mounted.container, 'primary');
    mockRailRects(primary);
    const chat = primary.find((link) => link.dataset.railItem === 'console')!;

    fireRailPointer(chat, 'pointerdown', { pointerId: 20, button: 0, clientX: 12, clientY: 1 });
    fireRailPointer(chat, 'pointermove', { pointerId: 20, clientX: 12, clientY: 45 });
    fireRailPointer(chat, 'pointermove', { pointerId: 20, clientX: 12, clientY: 45 });
    fireRailPointer(chat, 'pointerup', { pointerId: 20, clientX: 12, clientY: 45 });

    await waitFor(() => expect(railGroupLinks(mounted.container, 'primary').slice(0, 2)
      .map((link) => link.dataset.railItem)).toEqual(['auth', 'console']));
    expect(settings.putCalls).not.toHaveBeenCalled();
    expect(JSON.parse(window.localStorage.getItem(APP_RAIL_PREVIEW_ORDER_STORAGE_KEY) ?? '{}')).toEqual({
      version: 1,
      groups: {
        primary: ['auth', 'console', 'issues', 'artifacts', 'briefing', 'inbox', 'work', 'tasks'],
        secondary: ['timeline', 'graph', 'spaces'],
      },
    });

    fireEvent.click(screen.getByRole('link', { name: 'Approvals' }));
    await waitFor(() => expect(window.location.hash).toBe('#/auth'));
    expect(railGroupLinks(mounted.container, 'primary').slice(0, 2)
      .map((link) => link.dataset.railItem)).toEqual(['auth', 'console']);

    mounted.unmount();
    window.history.replaceState(null, '', '#/spaces');
    const remounted = render(h(App, {}));
    await waitFor(() => expect(railGroupLinks(remounted.container, 'primary').slice(0, 2)
      .map((link) => link.dataset.railItem)).toEqual(['auth', 'console']));
  });

  it('direct keyboard reorder retains focus, announces, persists, and hydrates after remount', async () => {
    installMemoryLocalStorage();
    const settings = stubRailSettingsFetch();
    stubEventSource();
    window.history.replaceState(null, '', '#/spaces');
    const first = render(h(App, {}));
    await railReorderReady();
    const spaces = await screen.findByRole('link', { name: 'Spaces' });
    spaces.focus();

    fireEvent.keyDown(spaces, { key: 'ArrowUp', ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(settings.putCalls).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(document.activeElement?.getAttribute('aria-label')).toBe('Spaces'));
    const movedSpaces = screen.getByRole('link', { name: 'Spaces' });
    expect(document.activeElement).toBe(movedSpaces);
    await waitFor(() => expect(within(screen.getByRole('navigation', { name: 'Main navigation' })).getByRole('status').textContent).toContain('Spaces moved to position'));
    const persistedOrder = railGroupLinks(first.container, 'secondary').map((link) => link.dataset.railItem);
    expect(persistedOrder.indexOf('spaces')).toBeLessThan(persistedOrder.indexOf('graph'));

    first.unmount();
    window.history.replaceState(null, '', '#/spaces');
    const remounted = render(h(App, {}));
    await waitFor(() => expect(railGroupLinks(remounted.container, 'secondary').map((link) => link.dataset.railItem))
      .toEqual(persistedOrder));
    expect(settings.getStored()).toContain('"version":1');
  });

  it('does not hijack ordinary arrows or Enter activation and exposes no visual mode gate', async () => {
    installMemoryLocalStorage();
    const settings = stubRailSettingsFetch();
    stubEventSource();
    window.history.replaceState(null, '', '#/spaces');
    render(h(App, {}));
    await railReorderReady();
    const spaces = screen.getByRole('link', { name: 'Spaces' });
    spaces.focus();
    fireEvent.keyDown(spaces, { key: 'ArrowUp' });
    expect(settings.putCalls).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /reorder navigation/i })).toBeNull();
    fireEvent.keyDown(spaces, { key: 'Enter' });
    fireEvent.click(spaces);
    await waitFor(() => expect(window.location.hash).toBe('#/spaces'));
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



  it('keeps the app rail visible while sidebar=hidden hides the view sidebar', async () => {
    stubAppShellFetch();
    stubEventSource();
    window.history.replaceState(
      null,
      '',
      '#/issues?repo=dotfiles&issue=e70757d&sidebar=hidden',
    );

    const { container } = render(h(App, {}));

    expect(screen.getByLabelText('Main navigation')).toBeTruthy();
    expect(screen.queryByPlaceholderText('Filter issues...')).toBeNull();
    const reveal = screen.getByLabelText('Show view sidebar');
    const footer = container.querySelector('.app-rail__footer');
    const sidebarControls = container.querySelector('.app-rail__sidebar-controls');
    const header = container.querySelector('.app-header');

    expect(footer).toBeTruthy();
    expect(header?.classList.contains('app-header--sidebar-hidden')).toBe(true);
    expect(header?.querySelector('.app-header__mark')).toBeTruthy();
    expect(header?.querySelector('.app-header__brand-text')).toBeNull();
    expect(header?.querySelector('.app-header__route')).toBeNull();
    expect(sidebarControls?.parentElement).toBe(footer);
    expect(container.querySelector('.app-rail > .app-rail__sidebar-controls')).toBeNull();
    expect(screen.getByLabelText(/^App theme:/)).toBeTruthy();
    expect(container.querySelector('.app-rail__theme-toggle')).toBeTruthy();

    fireEvent.click(reveal);

    await waitFor(() => expect(screen.getByPlaceholderText('Filter issues...')).toBeTruthy());
    expect(window.location.hash).toBe('#/issues?repo=dotfiles&issue=e70757d');
  });

  it('persists Settings theme choices, applies root attributes, and follows system changes', async () => {
    stubEventSource();
    window.__MANDIBLE_BOOTSTRAP__ = { instance: mainInstance };
    window.history.replaceState(null, '', '#/settings');
    let storedTheme = 'system';
    let systemListener: (() => void) | null = null;
    const mediaQuery = {
      matches: false,
      media: '(prefers-color-scheme: dark)',
      onchange: null,
      addEventListener: vi.fn((_event: string, listener: () => void) => {
        systemListener = listener;
      }),
      removeEventListener: vi.fn((_event: string, listener: () => void) => {
        if (systemListener === listener) systemListener = null;
      }),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    };
    vi.stubGlobal('matchMedia', vi.fn(() => mediaQuery));
    const savedModes: string[] = [];
    let themeRevision = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/settings' && init?.method !== 'PUT') {
        return new Response(JSON.stringify({ app_theme: storedTheme }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url === '/api/host-preferences/app-theme' && init?.method !== 'PUT') {
        return new Response(JSON.stringify({
          version: 1,
          key: 'app_theme',
          value: themeRevision === 0 ? null : storedTheme,
          revision: themeRevision,
        }), { headers: { 'content-type': 'application/json' } });
      }
      if (url === '/api/host-preferences/app-theme' && init?.method === 'PUT') {
        storedTheme = (JSON.parse(String(init.body)) as { value: string }).value;
        themeRevision += 1;
        savedModes.push(storedTheme);
        return new Response(JSON.stringify({
          version: 1,
          key: 'app_theme',
          value: storedTheme,
          revision: themeRevision,
        }), { headers: { 'content-type': 'application/json' } });
      }
      if (url === '/api/projects') {
        return new Response(JSON.stringify({ projects: [] }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url === '/api/settings/instructions-delivery') {
        return new Response(JSON.stringify({ targets: [], postExport: '', configuredTargets: false }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
    }));

    render(h(App, {}));

    const themeSelect = await screen.findByRole('combobox', { name: 'App theme' });
    await waitFor(() => {
      expect(document.documentElement.dataset.themeMode).toBe('system');
      expect(document.documentElement.dataset.theme).toBe('light');
    });

    changeSelect(themeSelect, 'light');
    await waitFor(() => {
      expect(savedModes).toEqual(['light']);
      expect(document.documentElement.dataset.themeMode).toBe('light');
      expect(document.documentElement.dataset.theme).toBe('light');
    });

    const mainNavigation = screen.getByLabelText('Main navigation');
    fireEvent.click(within(mainNavigation).getByLabelText('Spaces'));
    fireEvent.click(screen.getByRole('link', { name: 'Settings' }));
    await waitFor(() => expect((themeSelect as HTMLSelectElement).value).toBe('light'));

    changeSelect(themeSelect, 'dark');
    await waitFor(() => {
      expect(savedModes).toEqual(['light', 'dark']);
      expect(document.documentElement.dataset.themeMode).toBe('dark');
      expect(document.documentElement.dataset.theme).toBe('dark');
    });

    changeSelect(themeSelect, 'system');
    await waitFor(() => {
      expect(savedModes).toEqual(['light', 'dark', 'system']);
      expect(document.documentElement.dataset.themeMode).toBe('system');
      expect(document.documentElement.dataset.theme).toBe('light');
    });

    act(() => {
      mediaQuery.matches = true;
      systemListener?.();
    });
    expect(document.documentElement.dataset.theme).toBe('dark');
  });


  it('shows one actionable access failure in the main outlet without a signed-out view', async () => {
    __resetBrowserSessionForTests();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(
      String(input).includes('/client-auth/whoami')
        ? { authenticated: false, failure_reason: 'wrong_audience' }
        : {},
    ), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const mounted = render(h(App, {}));
    await waitFor(() => expect(mounted.container.querySelectorAll(
      '.app-content > #app-operational-notices [data-notice-source="local-access"][role="alert"]',
    )).toHaveLength(1));
    expect(mounted.container.querySelector('aside [role="alert"]')).toBeNull();
    expect(mounted.container.querySelector('.desktop-login')).toBeNull();
    const before = fetchMock.mock.calls.filter(([url]) => String(url).includes('/client-auth/whoami')).length;
    fireEvent.click(within(mounted.container.querySelector('#app-operational-notices')!).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/client-auth/whoami'))).toHaveLength(before + 1));
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

  it('keeps the bottom rail sidebar toggle functional for Inbox', async () => {
    stubAppShellFetch();
    stubEventSource();
    window.history.replaceState(null, '', '#/inbox?sidebar=hidden');

    const { container } = render(h(App, {}));

    const reveal = screen.getByLabelText('Show view sidebar');
    expect(reveal.closest('.app-rail__footer')).toBeTruthy();
    expect(container.querySelector('.app-rail > .app-rail__sidebar-controls')).toBeNull();

    fireEvent.click(reveal);

    await waitFor(() => expect(screen.getByLabelText('Hide view sidebar')).toBeTruthy());
    expect(window.location.hash).toBe('#/inbox');
  });

  it('renders Graph detail in the shared right sidebar without a registration loop', async () => {
    stubEventSource();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/graph?')) {
        return Promise.resolve(
          new Response(JSON.stringify({
            mode: 'activity',
            nodes: [{
              id: 'repo:mandible',
              type: 'repo',
              label: 'mandible',
              status: 'active',
              repo: 'mandible',
            }],
            edges: [],
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
    });
    vi.stubGlobal('fetch', fetchMock);
    window.history.replaceState(null, '', '#/graph');

    render(h(App, {}));

    await waitFor(() => expect(screen.getByLabelText('Show Graph detail')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('Show Graph detail'));
    await waitFor(() => expect(screen.getByLabelText('Hide Graph detail')).toBeTruthy());
    const hideToggle = screen.getByLabelText('Hide Graph detail');
    expect(hideToggle.closest('.app-right-sidebar__header')).toBeTruthy();
    expect(hideToggle.getAttribute('aria-pressed')).toBe('true');
    const graphDetail = screen.getByLabelText('Graph detail');
    expect(graphDetail.classList.contains('app-right-sidebar')).toBe(true);
    await waitFor(() => expect(graphDetail.querySelector('.detail-pane-shell')).toBeTruthy());
    expect(screen.getAllByText('mandible').length).toBeGreaterThan(0);
    expect(fetchMock.mock.calls.filter(([input]) => String(input).startsWith('/api/graph?')).length)
      .toBeLessThan(5);
    fireEvent.click(hideToggle);
    await waitFor(() => expect(screen.getByLabelText('Show Graph detail')).toBeTruthy());
    const showToggle = screen.getByLabelText('Show Graph detail');
    expect(showToggle.closest('main')).toBeTruthy();
    expect(showToggle.getAttribute('aria-pressed')).toBe('false');
    await waitFor(() => expect(document.activeElement).toBe(showToggle));
  });

  // Issue 80ced49 regression guard. GraphView used to build its pending-payload
  // placeholder as a fresh object literal on every render, so `payload.nodes` and
  // `payload.edges` changed identity each pass. That invalidated the memoized
  // right-sidebar descriptor, re-ran the registration effect, wrote app shell
  // state, and re-rendered the view — an unbounded synchronous render loop that
  // hung the whole test file. This probe re-renders GraphView while the graph
  // request is still pending and records every registration, so a regression
  // fails on the count instead of spinning forever (the shell probe deliberately
  // holds no state, so the loop cannot self-sustain here).
  it('registers one stable Graph right sidebar descriptor while the payload is pending', async () => {
    stubEventSource();
    // The pending-payload path is only exercised when no cached graph detail is
    // available, so drop anything an earlier test persisted.
    if (typeof window.localStorage.clear === 'function') window.localStorage.clear();
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/graph?')) {
        return new Promise<Response>(() => undefined);
      }
      return Promise.resolve(new Response(JSON.stringify([]), {
        headers: { 'content-type': 'application/json' },
      }));
    }));

    const registrations: string[] = [];
    const updates: AppRightSidebarDescriptor[] = [];
    const navigate = (): void => undefined;
    let rerenderProbe: (() => void) | null = null;

    function PendingGraphProbe(): JSX.Element {
      const [, setTick] = useState(0);
      rerenderProbe = () => setTick((value) => value + 1);
      const registerRightSidebar = useCallback((ownerId: string) => {
        registrations.push(ownerId);
        return () => undefined;
      }, []);
      const updateRightSidebar = useCallback((_ownerId: string, descriptor: AppRightSidebarDescriptor) => {
        updates.push(descriptor);
      }, []);
      const shell = useMemo<AppShellContextValue>(() => ({
        rightSidebar: null,
        registerRightSidebar,
        registerInitialRouteLoad: () => undefined,
        updateRightSidebar,
        setViewSidebarWidth: () => undefined,
        active: true,
      }), [registerRightSidebar, updateRightSidebar]);

      return h(AppShellProvider, { value: shell }, h(GraphView, {
        onNavigate: navigate,
        refreshToken: 0,
      }));
    }

    render(h(PendingGraphProbe, {}));

    await waitFor(() => expect(registrations.length).toBeGreaterThan(0));
    expect(updates[0]).not.toHaveProperty('layout');
    expect(updates[0]?.content).toBeNull();

    for (let pass = 0; pass < 5; pass += 1) {
      // eslint-disable-next-line no-await-in-loop
      await act(async () => {
        rerenderProbe?.();
      });
    }

    expect(registrations).toHaveLength(1);
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
    const graphPanel = screen.getByLabelText('Graph detail');
    const detailShell = graphPanel.querySelector('.detail-pane-shell');
    expect(Array.from(detailShell?.children ?? []).map((element) => element.getAttribute('data-detail-pane-slot')))
      .toEqual(['header', 'notice', 'body', 'overlay-host']);
    const copyIdentity = within(graphPanel).getByRole('button', { name: 'Copy Repo reference' });
    expect(copyIdentity.closest('.detail-pane-shell__header')).toBeTruthy();
    expect(copyIdentity.closest('.detail-pane-shell__body')).toBeNull();
    expect(within(graphPanel).queryByText('Actions')).toBeNull();
    expect(reactFlowMockState.mountCount).toBe(1);

    fireEvent.click(screen.getByLabelText('Select graph node rf_beta'));

    await waitFor(() => expect(
      within(screen.getByLabelText('Graph detail')).getByRole('heading', { name: 'beta' }),
    ).toBeTruthy());
    expect(reactFlowMockState.mountCount).toBe(1);
    expect(reactFlowMockState.unmountCount).toBe(0);
  });

  it('resolves an empty hash to the first navigation destination on mount', async () => {
    window.__MANDIBLE_BOOTSTRAP__ = { instance: mainInstance };
    stubRailSettingsFetch(JSON.stringify({
      version: 1,
      groups: { primary: ['issues', 'console'], secondary: [] },
    }));
    stubEventSource();
    window.history.replaceState(null, '', '');
    expect(window.location.hash).toBe('');

    render(h(App, {}));

    const nav = await screen.findByLabelText('Main navigation');
    await waitFor(() => {
      expect(within(nav).getByLabelText('Issues').getAttribute('aria-current')).toBe('page');
      expect(window.location.hash).toBe('#/issues');
    });
    const graphNav = within(nav).getByLabelText('Graph');
    expect(graphNav.getAttribute('aria-current')).toBeNull();
  });

  it('resolves an unknown hash to the Spaces workspace on mount', async () => {
    stubAppShellFetch();
    stubEventSource();
    window.history.replaceState(null, '', '#/not-a-real-tab');

    render(h(App, {}));

    const nav = await screen.findByLabelText('Main navigation');
    await waitFor(() => {
      const spacesNav = within(nav).getByLabelText('Spaces');
      expect(spacesNav.getAttribute('aria-current')).toBe('page');
    });
  });

  it('shows non-blocking workspace population status while the daemon is not warm', async () => {
    stubEventSource();
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/health') {
        return Promise.resolve(new Response(JSON.stringify({ ready: true, warm: false }), {
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      return Promise.resolve(new Response(JSON.stringify([]), {
        headers: { 'Content-Type': 'application/json' },
      }));
    }));

    render(h(App, {}));

    expect(await screen.findByText('Still loading workspace data…')).toBeTruthy();
    expect(await screen.findByLabelText('Main navigation')).toBeTruthy();
  });

  it('renders the Spaces preview notice from boot instance data before health resolves', async () => {
    stubEventSource();
    (window as Window & { __MANDIBLE_BOOTSTRAP__?: { instance: InstanceInfo } }).__MANDIBLE_BOOTSTRAP__ = {
      instance: previewInstance,
    };
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/health') {
        return new Promise<Response>(() => undefined);
      }
      if (url === '/api/spaces/s1') {
        return new Promise<Response>(() => undefined);
      }
      if (url === '/api/settings') {
        return Promise.resolve(new Response(JSON.stringify({}), {
          headers: { 'Content-Type': 'application/json' },
        }));
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
      return Promise.resolve(new Response(JSON.stringify([]), {
        headers: { 'Content-Type': 'application/json' },
      }));
    }));
    window.history.replaceState(null, '', '#/spaces?project=p1&space=s1&renderer=collection');

    render(h(App, {}));

    const copyNotice = await screen.findByTestId('preview-copy-notice');
    const spacesNoticeOutlet = await waitFor(() => {
      const outlet = document.querySelector('.spaces-shell__main .app-operational-notice-slot');
      expect(outlet).toBeTruthy();
      return outlet as HTMLElement;
    });
    const notice = spacesNoticeOutlet.querySelector('.detail-pane-notice');
    const spacesHeader = document.querySelector('.spaces-shell__header');
    const appShell = copyNotice.parentElement;
    expect(appShell?.classList.contains('app-shell')).toBe(true);
    expect(appShell?.firstElementChild).toBe(copyNotice);
    expect(copyNotice.closest('.app-layout')).toBeNull();
    expect(spacesHeader?.nextElementSibling).toBe(spacesNoticeOutlet);
    expect(notice).toBeTruthy();
    expect(spacesNoticeOutlet?.contains(notice)).toBe(true);
    expect(spacesNoticeOutlet?.contains(copyNotice)).toBe(false);
    expect(document.querySelectorAll('.spaces-shell__main .detail-pane-notice')).toHaveLength(1);
    expect(document.querySelector('#app-operational-notices .detail-pane-notice')).toBeNull();
  });
});

