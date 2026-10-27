// @vitest-environment jsdom
import { App } from '../ui/src/app';
import { act, fireEvent, screen, waitFor } from './helpers/dom.js';
import { describe, expect, it, vi } from 'vitest';
import { installMemoryLocalStorage, stubEventSource, stubRailSettingsFetch, previewInstance, render, setViewportWidth } from './helpers/ui-workspace-fixture';
import { jsonFixture } from './helpers/strict-ui-fixture';
import type { ProjectTimelinePage } from '../ui/src/types/timeline';

const projection: ProjectTimelinePage = {
  project: { id: 'mandible', display_name: 'mandible', repo_id: 'mandible', repo_name: 'mandible', repo_root: '/repo' },
  inputs: { project_id: 'mandible', root_policy: 'coordination_and_explicit', root_specs: [], explicit_root_issue_ids: [],
    promoted_root_issue_ids: [], expanded_event_ids: [], expanded_paths: [], include_closed: false, statuses: ['open'],
    event_kinds: ['body', 'comment', 'state'], depth: 2, from: null, to: null },
  time_axis: { start: null, end: null, event_count: 0 }, rows: [], events: [], links: [],
  diagnostics: { total_issues: 0, deleted_issues: 0, root_count: 0, reachable_from_roots_count: 0,
    unreferenced_open_issue_ids: [], loner_open_issue_ids: [], derived_reference_count: 0,
    repeated_reference_target_issue_ids: [], multi_root_issue_ids: [], cycles: [], depth_limits: [], filtered_targets: [], missing_expansions: [] },
  page: { row_offset: 0, next_row_offset: null },
};

describe('Timeline theme switching preserves sidebar intent', () => {
  it.each([1280, 640])('keeps a deliberately visible sidebar at viewport %i', async width => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    installMemoryLocalStorage();
    setViewportWidth(width);
    let theme = 'light'; let revision = 0;
    stubRailSettingsFetch(undefined, false, [
      { name: 'host theme', method: 'GET', path: '/api/host-preferences/app-theme', respond: () => jsonFixture({ version: 1, key: 'app_theme', value: theme, revision }) },
      { name: 'save host theme', method: 'PUT', path: '/api/host-preferences/app-theme', respond: async request => {
        theme = (await request.json() as { value: string }).value; revision += 1;
        return jsonFixture({ version: 1, key: 'app_theme', value: theme, revision });
      } },
      { name: 'Timeline', method: 'POST', path: '/api/timeline/project', respond: () => jsonFixture(projection) },
    ]);
    const events = stubEventSource();
    window.__MANDIBLE_BOOTSTRAP__ = { instance: previewInstance };
    window.history.replaceState(null, '', '#/timeline?project=mandible&unknown=keep');
    const view = render(<App />);
    if (width < 700) {
      await screen.findByRole('button', { name: 'Show view sidebar' });
      fireEvent.click(screen.getByRole('button', { name: 'Show view sidebar' }));
    }
    await screen.findByRole('button', { name: 'Hide view sidebar' });
    await screen.findByRole('complementary', { name: 'Timeline controls' });
    await screen.findByRole('button', { name: 'App theme: Light. Switch to Dark' });
    const hash = location.hash;
    const sidebar = screen.getByRole('complementary', { name: 'Timeline controls' });
    for (const [mode, label] of [['dark', 'Dark. Switch to System'], ['system', 'System. Switch to Light'], ['light', 'Light. Switch to Dark']]) {
      fireEvent.click(screen.getByRole('button', { name: /^App theme:/ }));
      await waitFor(() => expect(document.documentElement.dataset.themeMode).toBe(mode));
      await screen.findByRole('button', { name: `App theme: ${label}` });
      expect(location.hash).toBe(hash);
      expect(screen.getByRole('complementary', { name: 'Timeline controls' })).toBe(sidebar);
      expect(screen.getByRole('button', { name: 'Hide view sidebar' })).toBeTruthy();
      act(() => events.emit({ type: 'settings:updated', data: { settings: { app_theme: mode } } }));
      expect(location.hash).toBe(hash);
    }
    if (width > 700) {
      setViewportWidth(640);
      await screen.findByRole('button', { name: 'Show view sidebar' });
      expect(location.hash).toBe(hash + '&sidebar=hidden');
      expect(screen.queryByRole('complementary', { name: 'Timeline controls' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Show view sidebar' }));
      await screen.findByRole('button', { name: 'Hide view sidebar' });
      setViewportWidth(640);
      fireEvent.click(screen.getByRole('button', { name: /^App theme:/ }));
      await screen.findByRole('button', { name: 'App theme: Dark. Switch to System' });
      expect(location.hash).toBe(hash);
      expect(screen.getByRole('complementary', { name: 'Timeline controls' })).toBeTruthy();
    }
    view.unmount();
  });
});
