// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, cleanup, configure, fireEvent, screen, waitFor } from './helpers/dom';
import { AuthChangeBreakdown } from '../ui/src/views/AuthChangeBreakdown';
import { normalizeAuthChangeBreakdownViewState, DEFAULT_AUTH_CHANGE_BREAKDOWN_VIEW_STATE } from '../ui/src/views/auth-change-breakdown-state';
import { authBreakdownFixture } from './helpers/auth-breakdown-fixture';

beforeEach(() => {
  configure({ asyncUtilTimeout: 1000 });
  const values = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value),
  } });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(2000);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(300);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('exposes file statuses, paths and types', () => {
  const report = authBreakdownFixture();
  render(<AuthChangeBreakdown requestId="files" report={report} />);
  fireEvent.click(screen.getByRole('button', { name: /TypeScript/ }));
  const items = screen.getByRole('region', { name: 'TypeScript files' });
  expect(items.querySelectorAll('.auth-change-file')).toHaveLength(report.files.length);
  for (const status of ['Added', 'Deleted', 'Modified', 'Renamed', 'Copied', 'Type changed']) {
    expect(screen.getAllByLabelText(status).length).toBeGreaterThan(0);
  }
  expect([...items.querySelectorAll('code')].some(node => node.textContent?.includes('previous/location/') && node.textContent.includes(' → '))).toBe(true);
  for (const fact of ['binary', 'symlink', 'gitlink', 'generated', 'third-party']) {
    expect([...items.querySelectorAll('code')].some(node => node.title.includes(fact))).toBe(true);
  }
  expect(screen.getByLabelText('Submodule reference change').textContent).toBe('submodule');
});

it('scopes item positions by request, tab and directory while preserving folding intent', async () => {
  const report = authBreakdownFixture();
  const view = render(<AuthChangeBreakdown requestId="read-a" report={report} />);
  const items = () => screen.queryByRole('region', { name: 'Change breakdown items' }) ?? screen.getByRole('region', { name: 'TypeScript files' });
  fireEvent.click(screen.getByRole('button', { name: /TypeScript/ }));
  items().scrollTop = 184; fireEvent.scroll(items());
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
  await waitFor(() => expect(screen.getByRole('button', { name: /TypeScript/ }).getAttribute('aria-expanded')).toBe('false'));
  fireEvent.click(screen.getByRole('button', { name: /TypeScript/ }));
  expect(items().scrollTop).toBe(0);
  view.rerender(<AuthChangeBreakdown requestId="read-a" report={report} />);
  await waitFor(() => expect(items().scrollTop).toBe(184));
});

it('keeps sibling group offsets independent and separates grouped modes', () => {
  const report = authBreakdownFixture(32);
  report.files.forEach((file, index) => { if (index % 2) file.language = 'JavaScript'; });
  render(<AuthChangeBreakdown requestId="sibling-groups" report={report} />);
  fireEvent.click(screen.getByRole('button', { name: /TypeScript/ }));
  fireEvent.click(screen.getByRole('button', { name: /JavaScript/ }));
  const typescript = screen.getByRole('region', { name: 'TypeScript files' });
  const javascript = screen.getByRole('region', { name: 'JavaScript files' });
  typescript.scrollTop = 120; fireEvent.scroll(typescript);
  javascript.scrollTop = 88; fireEvent.scroll(javascript);
  fireEvent.click(screen.getByRole('tab', { name: 'File role' }));
  fireEvent.click(screen.getByRole('button', { name: /Implementation/ }));
  const role = screen.getByRole('region', { name: 'Implementation files' });
  expect(role.scrollTop).toBe(0);
  role.scrollTop = 77; fireEvent.scroll(role);
  fireEvent.click(screen.getByRole('tab', { name: 'Generated / third-party' }));
  fireEvent.click(screen.getByRole('button', { name: /^Generated\b/ }));
  expect(screen.getByRole('region', { name: 'Generated files' }).querySelectorAll('a')).toHaveLength(1);
  fireEvent.click(screen.getByRole('tab', { name: 'Language' }));
  expect(screen.getByRole('region', { name: 'TypeScript files' }).scrollTop).toBe(120);
  expect(screen.getByRole('region', { name: 'JavaScript files' }).scrollTop).toBe(88);
  fireEvent.click(screen.getByRole('button', { name: /TypeScript/ }));
  expect(screen.getByRole('region', { name: 'JavaScript files' }).scrollTop).toBe(88);
  fireEvent.click(screen.getByRole('tab', { name: 'File role' }));
  expect(screen.getByRole('region', { name: 'Implementation files' }).scrollTop).toBe(77);
});


it('partitions flags once, reconciles metrics, and restores legacy expansion intent', () => {
  const report = authBreakdownFixture(8);
  report.files.forEach((file, index) => {
    file.generated = index % 4 < 2;
    file.vendor = index % 2 === 0;
    file.additions = index % 4 === 3 ? 1000 : 1;
    file.deletions = 2;
  });
  for (const [legacy, expected] of Object.entries({
    'flag:generated': ['flag:generated-only', 'flag:both'],
    'flag:not-generated': ['flag:third-party-only', 'flag:neither'],
    'flag:vendor': ['flag:third-party-only', 'flag:both'],
    'flag:not-vendor': ['flag:generated-only', 'flag:neither'],
  })) {
    expect(normalizeAuthChangeBreakdownViewState({ expandedGroups: [legacy] }, DEFAULT_AUTH_CHANGE_BREAKDOWN_VIEW_STATE).expandedGroups).toEqual(expected);
  }
  const state = normalizeAuthChangeBreakdownViewState({ view: 'flags',
    expandedGroups: ['flag:generated', 'flag:not-generated', 'flag:vendor', 'role:other'], directoryPath: ['src'] }, DEFAULT_AUTH_CHANGE_BREAKDOWN_VIEW_STATE);
  expect(new Set(state.expandedGroups)).toEqual(new Set(['flag:both', 'flag:generated-only', 'flag:third-party-only', 'flag:neither', 'role:other']));
  expect(state.directoryPath).toEqual(['src']);
  const view = render(<AuthChangeBreakdown requestId="partition" report={report} initialState={state} />);
  const groups = [...view.container.querySelectorAll('.auth-change-group__row--outside')];
  expect(groups).toHaveLength(4);
  expect(groups.at(-1)?.querySelector('.auth-change-group__name')?.textContent).toBe('Other files');
  const displayedPaths = [...view.container.querySelectorAll('.auth-change-file__path')].map(node => node.textContent);
  expect(displayedPaths).toHaveLength(report.files.length);
  expect(new Set(displayedPaths).size).toBe(report.files.length);
  const metrics = groups.map(group => [...group.children].slice(1).map(node => Number(node.textContent?.replace(/[^0-9]/g, ''))));
  expect(metrics.reduce((sum, row) => sum + row[0]!, 0)).toBe(report.files.length);
  expect(metrics.reduce((sum, row) => sum + row[1]!, 0)).toBe(report.files.reduce((sum, file) => sum + file.additions!, 0));
  expect(metrics.reduce((sum, row) => sum + row[2]!, 0)).toBe(report.files.reduce((sum, file) => sum + file.deletions!, 0));
});

it('puts residual roles and languages last while treating a directory named Other normally', () => {
  const report = authBreakdownFixture(2);
  Object.assign(report.files[0]!, { new_path: 'Other/opaque', language: 'Unknown', file_role: 'other', additions: 9000, deletions: 0 });
  Object.assign(report.files[1]!, { new_path: 'program.py', language: 'Python', file_role: 'implementation', additions: 1, deletions: 0 });
  const view = render(<AuthChangeBreakdown requestId="residuals" report={report} />);
  const labels = () => [...view.container.querySelectorAll('.auth-change-group__name')].map(node => node.textContent);
  expect(labels()).toEqual(['Python', 'Unknown']);
  fireEvent.click(screen.getByRole('tab', { name: 'File role' }));
  expect(labels()).toEqual(['Implementation', 'Other']);
  fireEvent.click(screen.getByRole('tab', { name: 'Directory' }));
  expect(labels()).toEqual(['Other/']);
});
