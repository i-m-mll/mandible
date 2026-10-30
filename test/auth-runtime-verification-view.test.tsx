// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../ui/src/app';
import { AuthQueueView, type AuthRequest } from '../ui/src/views/auth';
import type { AuthConvergence } from '../src/types';
import { act, fireEvent, screen, waitFor, within } from './helpers/dom';
import { render, mainInstance, stubRailSettingsFetch } from './helpers/ui-workspace-fixture';
import { jsonFixture } from './helpers/strict-ui-fixture';
import { __resetSharedSseForTests } from '../ui/src/sse-shared';
import { queryClient } from '../ui/src/query/client';

const id = '12345678-1234-4123-8123-123456789abc';
const desktopReason = 'Backend is at the expected build; the updated desktop has not been observed. Quit and reopen the installed Mandible app; verification will resume.';
const nextReason = 'The updated desktop is present; verification is waiting for a complete observation window.';
const pending = (reason = desktopReason, code = 'desktop_unconfirmed'): AuthConvergence => ({ state: 'pending', hooks: [],
  runtime_verification: { phase: 'verification-pending', code, reason } });
const request = (convergence: AuthConvergence): AuthRequest => ({
  id, type: 'merge', title: 'Verify installed update', repo: 'mandible', head_branch: 'feature/update', base_branch: 'main',
  status: 'completed', exit_code: 0, created_at: 1, updated_at: 2, actions: [], change_report: null,
  commit_message: 'Install the reviewed update.\n\nKeep the selected review visible.', output: '', spec_content: '', diff_summary: '', convergence,
});
const actionsFixture = { name: 'selected request actions', method: 'GET' as const,
  path: `/api/auth/request/${id}/actions`, respond: () => jsonFixture([]) };

class FixtureStream {
  static instances: FixtureStream[] = [];
  listeners = new Map<string, Set<EventListener>>();
  constructor(_url: string) { FixtureStream.instances.push(this); }
  addEventListener(type: string, listener: EventListener) {
    const listeners = this.listeners.get(type) ?? new Set(); listeners.add(listener); this.listeners.set(type, listeners);
  }
  close() {}
  emit(payload: unknown) { for (const listener of this.listeners.get('message') ?? []) listener(new MessageEvent('message', { data: JSON.stringify(payload) })); }
  disconnect() { for (const listener of this.listeners.get('error') ?? []) listener(new Event('error')); }
}

beforeEach(() => {
  queryClient.clear(); FixtureStream.instances = [];
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => queryClient.clear());

it('automatically shows and refreshes pending instructions through auth updates and reconnect without resetting the selected review', async () => {
  let current = request({ state: 'pending', hooks: [] });
  const other = { ...request({ state: 'complete', hooks: [] }), id: 'other-request', title: 'Other review' };
  const reads = vi.fn();
  stubRailSettingsFetch(undefined, false, [
    { name: 'selected auth queue', method: 'GET', path: '/api/auth/queue', respond: () => { reads(); return jsonFixture([current, other]); } },
    { name: 'auth history', method: 'GET', path: '/api/auth/history', respond: () => jsonFixture([]) },
    actionsFixture,
  ]);
  __resetSharedSseForTests(FixtureStream);
  window.__MANDIBLE_BOOTSTRAP__ = { instance: mainInstance };
  window.history.replaceState(null, '', `#/auth?request=${id}&view=info`);
  const view = render(<App />);
  await screen.findByRole('heading', { name: 'Verify installed update' });
  await waitFor(() => expect(FixtureStream.instances).toHaveLength(1));
  expect(screen.queryByText(desktopReason)).toBeNull();
  const body = document.querySelector<HTMLElement>('.auth-detail__body')!;
  fireEvent.click(screen.getByRole('button', { name: 'Description' }));
  expect(screen.getByRole('button', { name: 'Description' }).getAttribute('aria-expanded')).toBe('false');
  body.scrollTop = 73;
  fireEvent.scroll(body);
  const hash = window.location.hash;
  const verifySelection = () => {
    expect(window.location.hash).toBe(hash);
    expect(document.querySelector('.auth-detail__body')).toBe(body);
    expect(body.scrollTop).toBe(73);
    expect(screen.getByRole('heading', { name: 'Verify installed update' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Description' }).getAttribute('aria-expanded')).toBe('false');
  };

  current = request(pending());
  act(() => FixtureStream.instances[0].emit({ type: 'auth:updated', data: { request: current } }));
  const reason = await screen.findByText(desktopReason);
  const notice = reason.closest('.detail-pane-notice')!;
  expect(notice.getAttribute('data-severity')).toBe('info');
  expect(notice.getAttribute('role')).toBe('status');
  expect(notice.getAttribute('aria-live')).toBe('polite');
  expect(within(notice as HTMLElement).queryByRole('button')).toBeNull();
  verifySelection();

  current = request(pending(nextReason, 'observation_incomplete'));
  act(() => FixtureStream.instances[0].emit({ type: 'auth:updated', data: { request: current } }));
  await screen.findByText(nextReason);
  expect(screen.queryByText(desktopReason)).toBeNull();
  verifySelection();

  const beforeReconnect = reads.mock.calls.length;
  current = request(pending());
  act(() => FixtureStream.instances.at(-1)!.disconnect());
  await waitFor(() => expect(FixtureStream.instances.length).toBeGreaterThan(1));
  await waitFor(() => expect(reads.mock.calls.length).toBeGreaterThan(beforeReconnect));
  await screen.findByText(desktopReason);
  expect(screen.queryByText(nextReason)).toBeNull();
  verifySelection();

  const beforeCompletion = reads.mock.calls.length;
  current = request({ state: 'complete', hooks: [] });
  act(() => FixtureStream.instances.at(-1)!.disconnect());
  await waitFor(() => expect(reads.mock.calls.length).toBeGreaterThan(beforeCompletion));
  await waitFor(() => expect(screen.queryByText(desktopReason)).toBeNull());
  verifySelection();
  const writes = vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method && !['GET', 'HEAD'].includes(init.method));
  expect(writes).toEqual([]);
  view.unmount();
});

it('clears the notice from an omitted pending projection even while convergence remains pending', () => {
  const props = { historyQueue: [], outputs: {}, selectedAuthId: id, initialRequestId: id, daemonReady: true, instance: mainInstance,
    onApprove: vi.fn(), onReject: vi.fn(), onRetry: vi.fn(), onSelectAuth: vi.fn() };
  stubRailSettingsFetch(undefined, false, [actionsFixture]);
  const view = render(<AuthQueueView {...props} queue={[request(pending())]} />);
  expect(screen.getByText(desktopReason)).toBeTruthy();
  const selections = [...props.onSelectAuth.mock.calls];
  const body = document.querySelector('.auth-detail__body');
  view.rerender(<AuthQueueView {...props} queue={[request({ state: 'pending', hooks: [] })]} />);
  expect(screen.queryByText(desktopReason)).toBeNull();
  expect(document.querySelector('.auth-detail__body')).toBe(body);
  expect(props.onSelectAuth.mock.calls).toEqual(selections);
});
