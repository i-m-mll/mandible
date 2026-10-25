// @vitest-environment jsdom
import { render } from './helpers/notice-test-render';
import { establishTestClientAccess } from './helpers/local-client-access';
import { bindTestInstanceCatalog } from './helpers/instance-operation-fixtures';
import { act, cleanup, fireEvent, screen, waitFor } from './helpers/dom.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { h } from 'preact';

import { __resetBrowserSessionForTests } from '../ui/src/client-auth-token';
import type { InstanceInfo } from '../ui/src/api';
import { AppShellProvider, useAppShell } from '../ui/src/app-shell';
import { WorkOverviewView } from '../ui/src/views/work';
import { PRODUCTION_EFFECTS } from '../src/security/effect-policy';

const instance: InstanceInfo = {
  role: 'main', db_path: '/tmp/mandible.db', db_path_source: 'default',
  allowed_effects: PRODUCTION_EFFECTS, writable_roots: ['/tmp'], preview_root: null,
  instance_id: 'production', installation_id: 'test', public_origin: 'https://app.mandible.localhost:19420',
  backend_generation: 'test', source_db_path: null, source_db_path_source: null,
};
const repo = { id: 'repo-a', name: 'Repo A', path: '/tmp/repo-a', default_branch: 'main' };
const branches = { 'repo-a': [{ name: 'main', status: 'clean' }, { name: 'feature/x', status: 'clean' }] };

let reads: string[] = [];
let scans = 0;

beforeEach(async () => {
  await establishTestClientAccess();
  bindTestInstanceCatalog(instance);
  reads = [];
  scans = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), window.location.origin);
    const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/api/work/scan' && init.method === 'POST') scans += 1;
    if (url.pathname.endsWith('/audit')) {
      reads.push(`audit${url.search}`);
      return json({ repo: {}, maintenance_issue_ref: null, maintenance_issue_note: '', worktree_inventory_known: true, entries: [] });
    }
    if (url.pathname.endsWith('/commits')) {
      reads.push(`commits ${decodeURIComponent(url.pathname.split('/branches/')[1] ?? '').replace(/\/commits$/, '')}`);
      return json({ repo_root: repo.path, branch: 'feature/x', default_branch: 'main', merge_base: null, commits: [], total: 0, limit: 50, offset: 0 });
    }
    if (url.pathname === '/api/work/repos') return json([repo]);
    return json({});
  }));
});

afterEach(() => {
  cleanup();
  __resetBrowserSessionForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function Work({ active, info }: { active: boolean; info: InstanceInfo }): JSX.Element {
  const parent = useAppShell();
  return (
    <AppShellProvider value={{ ...parent, active }}>
      <WorkOverviewView
        repos={[repo]}
        branchesByRepo={branches}
        onRescan={async () => { await fetch('/api/work/scan', { method: 'POST' }); }}
        instance={info}
        params={{ repo: 'repo-a', branch: 'feature/x' }}
      />
    </AppShellProvider>
  );
}

it('audits on activation, Rescan and scan completion only, never while hidden', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  const view = render(<Work active info={instance} />);
  await waitFor(() => expect(reads).toEqual(['audit', 'commits feature/x']));

  // Instance identity churn alone reads nothing.
  view.rerender(<Work active info={{ ...instance }} />);
  view.rerender(<Work active info={{ ...instance }} />);

  // Hidden: no interval rescans, and a completed scan only marks the data stale.
  view.rerender(<Work active={false} info={{ ...instance }} />);
  act(() => { window.dispatchEvent(new CustomEvent('work:scan:completed')); });
  await act(async () => { vi.advanceTimersByTime(10 * 60_000); });
  expect(scans).toBe(0);
  expect(reads).toEqual(['audit', 'commits feature/x']);

  // Activation refreshes once, keeping the selected branch.
  view.rerender(<Work active info={{ ...instance }} />);
  await waitFor(() => expect(reads).toEqual(['audit', 'commits feature/x', 'audit', 'commits feature/x']));

  // Hiding and re-showing within the skip window with nothing new reads nothing.
  view.rerender(<Work active={false} info={instance} />);
  view.rerender(<Work active info={instance} />);

  // Rescan forces a daemon refresh.
  fireEvent.click(await screen.findByRole('button', { name: 'Run audit' }));
  await waitFor(() => expect(reads.at(-1)).toBe('audit?refresh=1'));
  expect(reads).toHaveLength(5);

  // While active, the interval rescans and its completion reloads once.
  await act(async () => { vi.advanceTimersByTime(60_000); });
  expect(scans).toBe(1);
  act(() => { window.dispatchEvent(new CustomEvent('work:scan:completed')); });
  await waitFor(() => expect(reads.slice(5)).toEqual(['audit', 'commits feature/x']));
});
