// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, cleanup, fireEvent, screen, waitFor } from './helpers/dom';
import { AuthChangeBreakdown } from '../ui/src/views/AuthChangeBreakdown';
import { authBreakdownFixture } from './helpers/auth-breakdown-fixture';

beforeEach(() => {
  const values = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value),
  } });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(2000);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(300);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('retains full file semantics with Git status first and one detailed totals authority', () => {
  const report = authBreakdownFixture();
  const frozen = JSON.stringify(report);
  const view = render(<AuthChangeBreakdown requestId="files" report={report} />);
  fireEvent.click(screen.getByRole('button', { name: /TypeScript/ }));
  const panel = view.container.querySelector('section')!;
  expect(panel.querySelector('.collapsible-panel__header [aria-label="Change totals"]')).toBeTruthy();
  expect(panel.querySelectorAll('[aria-label="Change totals"]')).toHaveLength(1);
  const items = screen.getByRole('region', { name: 'Change breakdown items' });
  expect(items.querySelector('[role="tablist"]')).toBeNull();
  expect(items.querySelector('.auth-change-columns-header')).toBeNull();
  expect(items.querySelectorAll('.auth-change-file')).toHaveLength(report.files.length);
  for (const status of ['Added', 'Deleted', 'Modified', 'Renamed', 'Copied', 'Type changed']) {
    const marker = screen.getAllByLabelText(status)[0]!;
    expect(marker.parentElement?.firstElementChild).toBe(marker);
  }
  expect([...items.querySelectorAll('code')].some(node => node.textContent?.includes('previous/location/') && node.textContent.includes(' → '))).toBe(true);
  for (const fact of ['binary', 'symlink', 'gitlink', 'generated', 'vendor']) {
    expect([...items.querySelectorAll('code')].some(node => node.title.includes(fact))).toBe(true);
  }
  expect(screen.getByLabelText('Binary byte sizes').textContent).toContain('2.0 KiB → 4.0 KiB');
  expect(screen.getByLabelText('Submodule reference change').textContent).toBe('submodule');
  expect(JSON.stringify(report)).toBe(frozen);
});

it('preserves item positions by request, tab and directory through refetch, collapse and remount', async () => {
  const report = authBreakdownFixture();
  const view = render(<AuthChangeBreakdown requestId="read-a" report={report} />);
  const items = () => screen.getByRole('region', { name: 'Change breakdown items' });
  fireEvent.click(screen.getByRole('button', { name: /TypeScript/ }));
  items().scrollTop = 184; fireEvent.scroll(items());
  view.rerender(<AuthChangeBreakdown requestId="read-a" report={{ ...report, files: [...report.files] }} />);
  expect(items().scrollTop).toBe(184);
  fireEvent.click(screen.getByRole('tab', { name: 'Directory' }));
  fireEvent.click(screen.getByRole('button', { name: /^src\// }));
  fireEvent.click(screen.getByRole('button', { name: /^a-long-reviewed-directory\// }));
  items().scrollTop = 72; fireEvent.scroll(items());
  fireEvent.click(screen.getByRole('tab', { name: 'Largest files' }));
  items().scrollTop = 39; fireEvent.scroll(items());
  fireEvent.click(screen.getByRole('tab', { name: 'Directory' }));
  expect(items().scrollTop).toBe(72);
  expect(screen.getByRole('navigation', { name: 'Change report directory' }).textContent).toContain('a-long-reviewed-directory');
  fireEvent.click(screen.getByRole('tab', { name: 'Language' }));
  expect(items().scrollTop).toBe(184);
  fireEvent.click(screen.getByRole('button', { name: 'Change breakdown', exact: true }));
  expect(screen.queryByRole('region', { name: 'Change breakdown items' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Change breakdown', exact: true }));
  expect(items().scrollTop).toBe(184);
  view.rerender(<AuthChangeBreakdown requestId="read-b" report={report} />);
  await waitFor(() => expect(items().scrollTop).toBe(0));
  view.rerender(<AuthChangeBreakdown requestId="read-a" report={report} />);
  await waitFor(() => expect(items().scrollTop).toBe(184));
  view.unmount();
  render(<AuthChangeBreakdown requestId="read-a" report={report} />);
  expect(items().scrollTop).toBe(184);
});
