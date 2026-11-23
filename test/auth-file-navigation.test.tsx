// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from './helpers/dom';
import { RoutedAuthReview, navigationRequest, navigationRequestId } from './helpers/auth-navigation-fixture';
import { authReviewHref } from '../ui/src/views/auth-review-navigation';
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
  window.history.replaceState({ unrelated: 'preserved' }, '', `/auth/${navigationRequestId}?sidebar=hidden&agent_session=fixture-agent`);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const here = () => `${window.location.pathname}${window.location.search}`;
const body = () => document.querySelector<HTMLElement>('.auth-detail__body')!;
const offset = (node: HTMLElement, value: number) => { node.scrollTop = value; fireEvent.scroll(node); };
const info = () => screen.getByRole('tabpanel', { name: 'Reasons' });
const diff = () => screen.getByRole('tabpanel', { name: 'Files' });
const details = () => within(screen.getByRole('dialog', { name: 'Approval metadata' }));
const openDetails = () => {
  if (screen.queryByRole('dialog', { name: 'Approval metadata' })) return;
  fireEvent.click(screen.getByRole('button', { name: 'More' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Details' }));
};
const clickFile = (region: HTMLElement) => {
  const link = region.querySelector<HTMLAnchorElement>('a.auth-change-file')!;
  const destination = link.getAttribute('href');
  fireEvent.click(link);
  return destination;
};

it('restores two distinct Details visits and their live offsets even when storage writes fail', async () => {
  const view = render(<RoutedAuthReview />);
  await waitFor(info);
  offset(body(), 240);
  openDetails();
  const storageWrite = vi.mocked(window.localStorage.setItem).getMockImplementation();
  vi.mocked(window.localStorage.setItem).mockImplementation(() => { throw new Error('quota exceeded'); });
  fireEvent.click(screen.getByRole('button', { name: 'Expand Comment action' }));
  fireEvent.click(screen.getByRole('button', { name: /TypeScript/ }));
  fireEvent.click(screen.getByRole('button', { name: /JavaScript/ }));
  offset(screen.getByRole('region', { name: 'TypeScript files' }), 184);
  offset(screen.getByRole('region', { name: 'JavaScript files' }), 39);
  const destination1 = clickFile(screen.getByRole('region', { name: 'TypeScript files' }));
  await waitFor(diff);
  expect(here()).toBe(destination1);
  expect(window.history.state.unrelated).toBe('preserved');
  expect(here()).toContain('agent_session=fixture-agent');
  fireEvent.click(screen.getByRole('tab', { name: 'Reasons', exact: true }));
  await waitFor(info);
  offset(body(), 340);
  openDetails();
  fireEvent.click(screen.getByRole('tab', { name: 'Directory', exact: true }));
  fireEvent.click(details().getByRole('button', { name: /^src\// }));
  fireEvent.click(details().getByRole('button', { name: /^a-long-reviewed-directory\// }));
  offset(screen.getByRole('region', { name: 'Change breakdown items' }), 72);
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
  expect(screen.getByRole('button', { name: 'Collapse Comment action' }).getAttribute('aria-expanded')).toBe('true');
  vi.mocked(window.localStorage.setItem).mockImplementation(storageWrite!);
  offset(screen.getByRole('region', { name: 'TypeScript files' }), 250);
  view.rerender(<RoutedAuthReview requests={[{ ...navigationRequest }]} />);
  fireEvent.click(screen.getByRole('button', { name: /TypeScript/ }));
  fireEvent.click(screen.getByRole('button', { name: /TypeScript/ }));
  expect(screen.getByRole('region', { name: 'TypeScript files' }).scrollTop).toBe(250);
  act(() => window.history.forward());
  await waitFor(() => expect(here()).toBe(destination1));
  await waitFor(diff);
  act(() => window.history.go(2));
  await waitFor(() => expect(here()).toBe(destination2));
  await waitFor(diff);
});

it('honors an exact direct destination over a saved Console tab and cancels a deferred old request', async () => {
  window.localStorage.setItem(`auth-review-tab:${navigationRequestId}`, JSON.stringify('console'));
  const file = navigationRequest.change_report!.files[9]!;
  const fileName = `${file.old_path} → ${file.new_path}`;
  window.history.replaceState(null, '', authReviewHref(navigationRequestId, 'diff', { oldPath: file.old_path, newPath: file.new_path }));
  const pending = { ...navigationRequest, diff_summary: undefined, spec_content: undefined, output: undefined };
  const view = render(<RoutedAuthReview requests={[pending]} />);
  await waitFor(diff);
  expect(screen.queryByRole('status')).toBeNull();
  view.rerender(<RoutedAuthReview requests={[navigationRequest]} />);
  await waitFor(() => expect(screen.getByRole('button', { name: fileName }).getAttribute('aria-expanded')).toBe('true'));
  const validDestination = here();
  const mismatched = { oldPath: navigationRequest.change_report!.files[0]!.old_path, newPath: file.new_path };
  act(() => {
    window.history.pushState(null, '', authReviewHref(navigationRequestId, 'diff', mismatched));
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  const mismatchedDestination = here();
  const warning = await screen.findByRole('status');
  expect(warning.closest('[data-detail-pane-slot="notice"]')).toBeTruthy();
  expect(diff().contains(warning)).toBe(false);
  expect(here()).toContain('agent_session=fixture-agent');
  expect(here()).toContain('sidebar=hidden');
  view.rerender(<RoutedAuthReview requests={[{ ...navigationRequest }]} />);
  expect(screen.getByRole('status')).toBe(warning);
  expect(here()).toBe(mismatchedDestination);
  act(() => window.history.back());
  await waitFor(() => expect(here()).toBe(validDestination));
  await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  act(() => window.history.forward());
  await waitFor(() => expect(here()).toBe(mismatchedDestination));
  await screen.findByRole('status');
  fireEvent.click(screen.getByRole('tab', { name: 'Console', exact: true }));
  await waitFor(() => screen.getByRole('tabpanel', { name: 'Console' }));
  expect(here()).not.toContain('diff_old');
  expect(here()).not.toContain('diff_new');
  const other = { ...navigationRequest, id: 'other-navigation-request', diff_summary: undefined, spec_content: undefined, output: undefined, change_report: undefined };
  act(() => {
    window.history.pushState(null, '', authReviewHref(other.id, 'diff', { oldPath: 'other/file', newPath: 'other/file' }));
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  view.rerender(<RoutedAuthReview requests={[navigationRequest, other]} />);
  await waitFor(() => expect(screen.queryByRole('button', { name: fileName })).toBeNull());
  view.rerender(<RoutedAuthReview requests={[navigationRequest, { ...other, change_report: null }]} />);
  await waitFor(() => expect(screen.getByRole('status')).toBeTruthy());
  expect(body().contains(screen.getByRole('status'))).toBe(false);
});

it('keeps a restored Details visit mounted while another app tab owns history', async () => {
  const view = render(<RoutedAuthReview />);
  await waitFor(info);
  openDetails();
  fireEvent.click(screen.getByRole('button', { name: /TypeScript/ }));
  clickFile(screen.getByRole('region', { name: 'TypeScript files' }));
  await waitFor(diff);
  act(() => window.history.back());
  await waitFor(info);
  openDetails();
  offset(screen.getByRole('region', { name: 'TypeScript files' }), 250);
  const owner = body();
  view.rerender(<RoutedAuthReview active={false} />);
  act(() => {
    window.history.pushState({ otherTab: true }, '', '/issue/some-issue');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  view.rerender(<RoutedAuthReview active={false} requests={[{ ...navigationRequest }]} />);
  expect(body()).toBe(owner);
  expect(screen.getByRole('region', { name: 'TypeScript files' }).scrollTop).toBe(250);
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
    if (/^\/api\/auth\/request\/[^/]+$/.test(url)) {
      detailCalls.push(url);
      return detailCalls.length === 1 ? Promise.resolve(new Response(JSON.stringify(full), { headers: { 'Content-Type': 'application/json' } })) : new Promise<Response>(() => {});
    }
    return Promise.reject(new Error('Offline fixture'));
  }));
  window.localStorage.setItem(`auth-review-tab:${id}`, JSON.stringify('diff'));
  window.localStorage.setItem(`auth-review-scroll:${id}:diff`, '184');
  window.history.replaceState(null, '', `/auth/${id.slice(0, 8)}?view=diff`);
  const view = render(<RoutedAuthReview requests={[summary]} />);
  const fileViewControls = () => within(diff()).queryAllByRole('button', { name: /^Viewed / });
  await waitFor(() => expect(fileViewControls()).toHaveLength(40));
  view.rerender(<RoutedAuthReview requests={[{ ...summary, title: 'Refreshed list metadata' }]} />);
  expect(fileViewControls()).toHaveLength(40);
  expect(document.querySelector('.detail-pane-shell__header')?.textContent).toContain('Refreshed list metadata');
  expect(body().scrollTop).toBe(184);
  expect(detailCalls).toHaveLength(1);
  view.rerender(<RoutedAuthReview requests={[{ ...summary, diff_summary: '', spec_content: '', output: '', change_report: null, actions: [] }]} />);
  expect(fileViewControls()).toHaveLength(0);
  fireEvent.click(screen.getByRole('tab', { name: 'Reasons', exact: true }));
  await waitFor(info);
  openDetails();
});
