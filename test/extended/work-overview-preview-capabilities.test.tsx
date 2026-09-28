import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, expect, it, vi } from 'vitest';
import { h } from 'preact';

import { __resetBrowserSessionForTests } from '../../ui/src/client-auth-token';
import type { InstanceInfo } from '../../ui/src/api';
import { WorkOverviewView } from '../../ui/src/views/work';

const previewWithCopiedRepoWrites: InstanceInfo = {
  role: 'preview',
  instance_id: 'preview-projects',
  installation_id: 'test-installation',
  public_origin: 'http://localhost:19421',
  backend_generation: 'preview-generation',
  allowed_effects: ['ledger:read', 'ledger:write', 'files:preview'],
  writable_roots: ['/tmp/mandible-preview'],
  preview_root: '/tmp/mandible-preview',
  db_path: '/tmp/mandible-preview/db.sqlite',
  db_path_source: 'test',
};

afterEach(() => {
  cleanup();
  __resetBrowserSessionForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('keeps copied project controls while suppressing live Git actions and requests', async () => {
  const requests: Array<{ path: string; method: string }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const path = String(input);
    const method = (init.method ?? 'GET').toUpperCase();
    requests.push({ path, method });
    if (path === '/api/client-auth/whoami') {
      return new Response(JSON.stringify({ authenticated: true, session: { csrf_token: 'test-csrf' } }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    if (path === '/api/work/repos') {
      return new Response(JSON.stringify([
        { id: 'copied-repo', name: 'Copied repo', path: '/tmp/mandible-preview/repo', default_branch: 'main' },
      ]), { headers: { 'content-type': 'application/json' } });
    }
    if (path === '/api/work/repos/copied-repo' && method === 'PUT') {
      return new Response(JSON.stringify({
        id: 'copied-repo', name: 'Renamed copied repo', path: '/tmp/mandible-preview/repo', default_branch: 'main',
      }), { headers: { 'content-type': 'application/json' } });
    }
    if (path === '/api/work/repos/copied-repo' && method === 'DELETE') return new Response(null, { status: 204 });
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  }));

  const onRescan = vi.fn();
  const viewProps = {
    repos: [{ id: 'copied-repo', name: 'Copied repo', path: '/tmp/mandible-preview/repo', default_branch: 'main' }],
    branchesByRepo: {
      'copied-repo': [{ name: 'feature/copied', status: 'clean', last_commit_message: 'Copied branch data' }],
    },
    onRescan,
  };
  const { rerender } = render(h(WorkOverviewView, { ...viewProps, instance: null }));
  await waitFor(() => expect(requests.some(({ path }) => path === '/api/work/repos')).toBe(true));
  expect(requests.some(({ path }) => /\/audit(?:\?|$)|\/commits(?:\?|$)|\/compare(?:\?|$)|\/api\/work\/scan/.test(path))).toBe(false);

  rerender(h(WorkOverviewView, { ...viewProps, instance: previewWithCopiedRepoWrites }));

  expect(screen.getAllByText('Copied repo').length).toBeGreaterThan(0);
  expect(screen.getAllByText('feature/copied').length).toBeGreaterThan(0);
  expect(screen.getByText('Commit history is unavailable in this copied preview.')).toBeTruthy();
  expect(screen.getAllByText('Live branch audit is unavailable in this copied preview.').length).toBeGreaterThan(0);
  expect(screen.getByText('Adding projects and pushing are unavailable in this copied preview.')).toBeTruthy();
  expect(screen.queryByText('Loading commits')).toBeNull();
  expect(screen.getByRole('button', { name: '+ Add project' }).disabled).toBe(true);
  expect(screen.getByRole('button', { name: '\u2191\u2191 Push All' }).disabled).toBe(true);
  expect(screen.getByRole('button', { name: 'Run audit' }).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Branch point' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'vs main' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '+ Add project' }));
  fireEvent.click(screen.getByRole('button', { name: '\u2191\u2191 Push All' }));
  fireEvent.click(screen.getByRole('button', { name: 'Run audit' }));

  fireEvent.click(screen.getByRole('button', { name: 'Repo settings' }));
  const projectName = document.querySelector('.repo-settings-strip__input') as HTMLInputElement;
  fireEvent.input(projectName, { target: { value: 'Renamed copied repo' } });
  const saveButton = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
  expect(saveButton.disabled).toBe(false);
  fireEvent.click(saveButton);
  await waitFor(() => expect(requests.some(({ path, method }) => path === '/api/work/repos/copied-repo' && method === 'PUT')).toBe(true));
  expect((screen.getByRole('checkbox', { name: /Exclude from scans/ }) as HTMLInputElement).disabled).toBe(false);
  const removeButton = screen.getByRole('button', { name: 'Remove repo' }) as HTMLButtonElement;
  expect(removeButton.disabled).toBe(false);
  fireEvent.click(removeButton);
  fireEvent.click(screen.getByRole('button', { name: 'Confirm remove' }));
  await waitFor(() => expect(requests.some(({ path, method }) => path === '/api/work/repos/copied-repo' && method === 'DELETE')).toBe(true));

  window.dispatchEvent(new Event('focus'));
  await waitFor(() => expect(requests.some(({ path }) => path === '/api/work/repos')).toBe(true));
  expect(onRescan).not.toHaveBeenCalled();
  expect(requests.some(({ path }) => /\/audit(?:\?|$)|\/commits(?:\?|$)|\/compare(?:\?|$)|\/api\/work\/scan|\/api\/work\/repos\/add|\/api\/work\/push|\/api\/system\/open-path/.test(path))).toBe(false);
});

it('retains live Git controls and requests for a capable main instance', async () => {
  const requests: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    requests.push(path);
    if (path === '/api/client-auth/whoami') {
      return new Response(JSON.stringify({ authenticated: true, session: { csrf_token: 'test-csrf' } }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    if (path === '/api/work/repos') {
      return new Response(JSON.stringify([
        { id: 'main-repo', name: 'Main repo', path: '/tmp/main-repo', default_branch: 'main' },
      ]), { headers: { 'content-type': 'application/json' } });
    }
    if (path.endsWith('/audit')) {
      return new Response(JSON.stringify({ entries: [], worktree_inventory_known: true }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    if (path.includes('/commits')) {
      return new Response(JSON.stringify({ commits: [], total: 0, limit: 50, offset: 0 }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  }));

  const mainInstance: InstanceInfo = {
    role: 'main',
    instance_id: 'main-projects',
    installation_id: 'test-installation',
    public_origin: 'http://localhost:19420',
    backend_generation: 'main-generation',
    allowed_effects: ['ledger:read', 'ledger:write', 'files:production', 'network:publish', 'process:external'],
    writable_roots: ['/tmp'],
    db_path: '/tmp/mandible-main.db',
    db_path_source: 'test',
  };
  const onRescan = vi.fn();
  render(h(WorkOverviewView, {
    repos: [{ id: 'main-repo', name: 'Main repo', path: '/tmp/main-repo', default_branch: 'main' }],
    branchesByRepo: { 'main-repo': [{ name: 'feature/main', status: 'clean' }] },
    onRescan,
    instance: mainInstance,
  }));

  await waitFor(() => {
    expect(requests.some((path) => path.endsWith('/audit'))).toBe(true);
    expect(requests.some((path) => path.includes('/commits'))).toBe(true);
  });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Run audit' })).toBeTruthy());
  expect((screen.getByRole('button', { name: '+ Add project' }) as HTMLButtonElement).disabled).toBe(false);
  expect((screen.getByRole('button', { name: '\u2191\u2191 Push All' }) as HTMLButtonElement).disabled).toBe(false);
  expect((screen.getByRole('button', { name: 'Run audit' }) as HTMLButtonElement).disabled).toBe(false);

  window.dispatchEvent(new Event('focus'));
  expect(onRescan).toHaveBeenCalledTimes(1);
});
