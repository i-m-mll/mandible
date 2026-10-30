// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from './helpers/dom';
import { RoutedAuthReview, navigationRequest, navigationRequestId } from './helpers/auth-navigation-fixture';
import { authReviewHash } from '../ui/src/views/auth-review-navigation';
import { establishTestClientAccess } from './helpers/local-client-access';

beforeEach(() => {
  const values = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', { configurable: true, value: {
    get length() { return values.size; }, key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
  } });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('Offline fixture'))));
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(4000);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(300);
  window.history.replaceState({ unrelated: 'preserved' }, '', `#/auth?request=${navigationRequestId}&sidebar=hidden&agent_session=fixture-agent`);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const body = () => document.querySelector<HTMLElement>('.auth-detail__body')!;
const offset = (node: HTMLElement, value: number) => { node.scrollTop = value; fireEvent.scroll(node); };
const info = () => screen.getByRole('tabpanel', { name: 'Info' });
const diff = () => screen.getByRole('tabpanel', { name: 'Diff' });
const clickFile = (region: HTMLElement) => {
  const link = region.querySelector<HTMLAnchorElement>('a.auth-change-file')!;
  const destination = link.getAttribute('href');
  fireEvent.click(link);
  return destination;
};

it('restores two distinct Info visits and their live disclosures and offsets even when storage writes fail', async () => {
  const view = render(<RoutedAuthReview />);
  await waitFor(info);
  const storageWrite = vi.mocked(window.localStorage.setItem).getMockImplementation();
  vi.mocked(window.localStorage.setItem).mockImplementation(() => { throw new Error('quota exceeded'); });
  fireEvent.click(screen.getByRole('button', { name: 'Description', exact: true }));
  fireEvent.click(screen.getByRole('button', { name: 'References', exact: true }));
  fireEvent.click(screen.getByRole('button', { name: 'Expand Comment action' }));
  fireEvent.click(screen.getByRole('button', { name: /TypeScript/ }));
  fireEvent.click(screen.getByRole('button', { name: /JavaScript/ }));
  offset(screen.getByRole('region', { name: 'TypeScript files' }), 184);
  offset(screen.getByRole('region', { name: 'JavaScript files' }), 39);
  offset(body(), 240);
  const destination1 = clickFile(screen.getByRole('region', { name: 'TypeScript files' }));
  await waitFor(diff);
  expect(window.location.hash).toBe(destination1);
  expect(window.history.state.unrelated).toBe('preserved');
  expect(window.location.hash).toContain('agent_session=fixture-agent');
  fireEvent.click(screen.getByRole('tab', { name: 'Info', exact: true }));
  await waitFor(info);
  fireEvent.click(screen.getByRole('tab', { name: 'Directory', exact: true }));
  fireEvent.click(screen.getByRole('button', { name: /^src\// }));
  fireEvent.click(screen.getByRole('button', { name: /^a-long-reviewed-directory\// }));
  offset(screen.getByRole('region', { name: 'Change breakdown items' }), 72);
  offset(body(), 340);
  const destination2 = clickFile(screen.getByRole('region', { name: 'Change breakdown items' }));
  await waitFor(diff);
  act(() => window.history.back());
  await waitFor(() => expect(screen.getByRole('tab', { name: 'Directory', exact: true }).getAttribute('aria-selected')).toBe('true'));
  expect(body().scrollTop).toBe(340);
  expect(screen.getByRole('region', { name: 'Change breakdown items' }).scrollTop).toBe(72);
  expect(screen.getByRole('navigation', { name: 'Change report directory' }).textContent).toContain('a-long-reviewed-directory');
  act(() => window.history.go(-2));
  await waitFor(() => expect(screen.getByRole('tab', { name: 'Language', exact: true }).getAttribute('aria-selected')).toBe('true'));
  expect(body().scrollTop).toBe(240);
  expect(screen.getByRole('region', { name: 'TypeScript files' }).scrollTop).toBe(184);
  expect(screen.getByRole('region', { name: 'JavaScript files' }).scrollTop).toBe(39);
  expect(screen.getByRole('button', { name: 'Description', exact: true }).getAttribute('aria-expanded')).toBe('false');
  expect(screen.getByRole('button', { name: 'References', exact: true }).getAttribute('aria-expanded')).toBe('false');
  expect(screen.getByRole('button', { name: 'Collapse Comment action' }).getAttribute('aria-expanded')).toBe('true');
  vi.mocked(window.localStorage.setItem).mockImplementation(storageWrite!);
  offset(screen.getByRole('region', { name: 'TypeScript files' }), 250);
  view.rerender(<RoutedAuthReview requests={[{ ...navigationRequest }]} />);
  fireEvent.click(screen.getByRole('button', { name: /TypeScript/ }));
  fireEvent.click(screen.getByRole('button', { name: /TypeScript/ }));
  expect(screen.getByRole('region', { name: 'TypeScript files' }).scrollTop).toBe(250);
  act(() => window.history.forward());
  await waitFor(() => expect(window.location.hash).toBe(destination1));
  await waitFor(diff);
  act(() => window.history.go(2));
  await waitFor(() => expect(window.location.hash).toBe(destination2));
  await waitFor(diff);
});

it('honors an exact direct destination over a saved Console tab and cancels a deferred old request', async () => {
  window.localStorage.setItem(`auth-review-tab:${navigationRequestId}`, JSON.stringify('console'));
  const file = navigationRequest.change_report!.files[9]!;
  window.history.replaceState(null, '', authReviewHash(window.location.hash, navigationRequestId, 'diff', { oldPath: file.old_path, newPath: file.new_path }));
  const pending = { ...navigationRequest, diff_summary: undefined, spec_content: undefined, output: undefined };
  const view = render(<RoutedAuthReview requests={[pending]} />);
  await waitFor(diff);
  expect(screen.queryByRole('status')).toBeNull();
  view.rerender(<RoutedAuthReview requests={[navigationRequest]} />);
  await waitFor(() => expect(screen.getByRole('button', { name: file.new_path! }).getAttribute('aria-expanded')).toBe('true'));
  const validDestination = window.location.hash;
  const mismatched = { oldPath: navigationRequest.change_report!.files[0]!.old_path, newPath: file.new_path };
  act(() => {
    window.history.pushState(null, '', authReviewHash(window.location.hash, navigationRequestId, 'diff', mismatched));
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
  const mismatchedDestination = window.location.hash;
  const warning = await screen.findByRole('status');
  expect(warning.closest('[data-detail-pane-slot="notice"]')).toBeTruthy();
  expect(diff().contains(warning)).toBe(false);
  expect(window.location.hash).toContain('agent_session=fixture-agent');
  expect(window.location.hash).toContain('sidebar=hidden');
  view.rerender(<RoutedAuthReview requests={[{ ...navigationRequest }]} />);
  expect(screen.getByRole('status')).toBe(warning);
  expect(window.location.hash).toBe(mismatchedDestination);
  act(() => window.history.back());
  await waitFor(() => expect(window.location.hash).toBe(validDestination));
  await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  act(() => window.history.forward());
  await waitFor(() => expect(window.location.hash).toBe(mismatchedDestination));
  await screen.findByRole('status');
  fireEvent.click(screen.getByRole('tab', { name: 'Console', exact: true }));
  await waitFor(() => screen.getByRole('tabpanel', { name: 'Console' }));
  expect(window.location.hash).not.toContain('diff_old');
  expect(window.location.hash).not.toContain('diff_new');
  const other = { ...navigationRequest, id: 'other-navigation-request', diff_summary: undefined, spec_content: undefined, output: undefined };
  act(() => {
    window.history.pushState(null, '', authReviewHash(window.location.hash, other.id, 'diff', { oldPath: 'other/file', newPath: 'other/file' }));
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
  view.rerender(<RoutedAuthReview requests={[navigationRequest, other]} />);
  await waitFor(() => expect(screen.queryByRole('button', { name: file.new_path! })).toBeNull());
  view.rerender(<RoutedAuthReview requests={[navigationRequest, { ...other, diff_summary: '' }]} />);
  await waitFor(() => expect(screen.getByRole('status')).toBeTruthy());
  expect(body().contains(screen.getByRole('status'))).toBe(false);
});

it('keeps an edited restored visit mounted while another app tab owns history', async () => {
  const view = render(<RoutedAuthReview />);
  await waitFor(info);
  fireEvent.click(screen.getByRole('button', { name: /TypeScript/ }));
  clickFile(screen.getByRole('region', { name: 'TypeScript files' }));
  await waitFor(diff);
  act(() => window.history.back());
  await waitFor(info);
  fireEvent.click(screen.getByRole('button', { name: 'Description', exact: true }));
  offset(screen.getByRole('region', { name: 'TypeScript files' }), 250);
  offset(body(), 260);
  const owner = body();
  view.rerender(<RoutedAuthReview active={false} />);
  act(() => {
    window.history.pushState({ otherTab: true }, '', '#/issues?issue=some-issue');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
  view.rerender(<RoutedAuthReview active={false} requests={[{ ...navigationRequest }]} />);
  expect(body()).toBe(owner);
  expect(body().scrollTop).toBe(260);
  expect(screen.getByRole('region', { name: 'TypeScript files' }).scrollTop).toBe(250);
  expect(screen.getByRole('button', { name: 'Description', exact: true }).getAttribute('aria-expanded')).toBe('false');
});

it('retains canonical detail content across compact-route summary reconciliation while explicit current values win', async () => {
  await establishTestClientAccess();
  const id = '5e68b070-1111-4444-8888-0123456789ab';
  const full = { ...navigationRequest, id };
  const summary = { ...full, title: 'Current list metadata', diff_summary: undefined, spec_content: undefined, output: undefined,
    change_report: undefined, actions: undefined };
  const detailCalls: string[] = [];
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/actions')) return Promise.resolve(new Response(JSON.stringify({ actions: full.actions }), { headers: { 'Content-Type': 'application/json' } }));
    if (url.startsWith('/api/auth/request/')) {
      detailCalls.push(url);
      return detailCalls.length === 1 ? Promise.resolve(new Response(JSON.stringify(full), { headers: { 'Content-Type': 'application/json' } })) : new Promise<Response>(() => {});
    }
    return Promise.reject(new Error('Offline fixture'));
  }));
  window.localStorage.setItem(`auth-review-tab:${id}`, JSON.stringify('diff'));
  window.localStorage.setItem(`auth-review-scroll:${id}:diff`, '184');
  window.history.replaceState(null, '', `#/auth?request=${id.slice(0, 8)}&view=diff`);
  const view = render(<RoutedAuthReview requests={[summary]} />);
  await waitFor(() => expect(document.querySelectorAll('.diff-viewer__file-header')).toHaveLength(40));
  view.rerender(<RoutedAuthReview requests={[{ ...summary, title: 'Refreshed list metadata' }]} />);
  expect(document.querySelectorAll('.diff-viewer__file-header')).toHaveLength(40);
  expect(document.querySelector('.detail-pane-shell__header')?.textContent).toContain('Refreshed list metadata');
  expect(body().scrollTop).toBe(184);
  expect(detailCalls).toEqual(['/api/auth/request/5e68b070']);
  view.rerender(<RoutedAuthReview requests={[{ ...summary, diff_summary: '', spec_content: '', output: '', change_report: null, actions: [] }]} />);
  expect(document.querySelectorAll('.diff-viewer__file-header')).toHaveLength(0);
  fireEvent.click(screen.getByRole('tab', { name: 'Info', exact: true }));
  await waitFor(info);
});
