// @vitest-environment jsdom
import { render } from './helpers/notice-test-render';
import { establishTestClientAccess } from './helpers/local-client-access';
import { bindTestInstanceCatalog } from './helpers/instance-operation-fixtures';
import { cleanup, fireEvent, screen, waitFor, within } from './helpers/dom.js';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { h } from 'preact';

import { __resetBrowserSessionForTests } from '../ui/src/client-auth-token';
import type { InstanceInfo } from '../ui/src/api';
import { WorkOverviewView } from '../ui/src/views/work';

const copiedPreview: InstanceInfo = {
  role: 'preview',
  instance_id: 'preview-projects',
  installation_id: 'test-installation',
  public_origin: 'http://localhost:19421',
  backend_generation: 'preview-generation',
  allowed_effects: ['ledger:read', 'ledger:write', 'files:preview'],
  writable_roots: ['/tmp/mandible-preview'],
  db_path: '/tmp/mandible-preview/db.sqlite',
  db_path_source: 'test',
};

beforeEach(async () => {
  await establishTestClientAccess();
  bindTestInstanceCatalog(copiedPreview);
});

afterEach(() => {
  cleanup();
  __resetBrowserSessionForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('keeps copied project metadata writable while gating host Git operations', async () => {
  const requests: Array<{ path: string; method: string }> = [];
  const copiedRepo = {
    id: 'copied-repo',
    name: 'Copied repo',
    path: '/tmp/mandible-preview/repo',
    default_branch: 'main',
  };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), window.location.origin);
    const method = (init.method ?? 'GET').toUpperCase();
    requests.push({ path: url.pathname, method });
    if (url.pathname === '/api/client-auth/whoami') {
      return new Response(JSON.stringify({ authenticated: true, session: { csrf_token: 'test-csrf' } }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.pathname === '/api/work/repos/add' && method === 'POST') {
      return new Response(JSON.stringify({ error: 'effect_not_allowed: process:external' }), {
        status: 403, headers: { 'content-type': 'application/json' },
      });
    }
    if (url.pathname === '/api/work/repos') {
      return new Response(JSON.stringify([copiedRepo]), { headers: { 'content-type': 'application/json' } });
    }
    if (url.pathname === '/api/work/repos/copied-repo' && method === 'PUT') {
      const body = JSON.parse(String(init.body)) as { name?: string };
      return new Response(JSON.stringify({ ...copiedRepo, name: body.name ?? copiedRepo.name }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.pathname === '/api/work/repos/copied-repo' && method === 'DELETE') {
      return new Response(null, { status: 204 });
    }
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  }));

  const onRescan = vi.fn();
  const props = {
    repos: [copiedRepo],
    branchesByRepo: {
      'copied-repo': [{ name: 'feature/copied', status: 'clean' }],
    },
    onRescan,
    instance: copiedPreview,
    params: { compare: 'base..feature' },
  };
  const view = render(h(WorkOverviewView, props));

  const addProject = screen.getByRole('button', { name: 'Add project' }) as HTMLButtonElement;
  const pushAll = screen.getByRole('button', { name: /Push All/ }) as HTMLButtonElement;
  // Dynamic route hints admit the attempt; the daemon owns exact effect permission.
  expect(addProject.disabled).toBe(false);
  expect(pushAll.disabled).toBe(true);
  fireEvent.click(addProject);
  const projectPath = screen.getByRole('textbox', { name: 'Project path' });
  fireEvent.input(projectPath, { target: { value: '/tmp/new-project' } });
  fireEvent.click(within(projectPath.parentElement!).getByRole('button', { name: 'Add project' }));
  await screen.findByText('effect_not_allowed: process:external');
  expect(requests).toContainEqual({ path: '/api/work/repos/add', method: 'POST' });
  expect(onRescan).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  fireEvent.click(pushAll);

  fireEvent.click(screen.getByRole('button', { name: 'Repo settings' }));
  fireEvent.input(screen.getByRole('textbox', { name: 'Name' }), {
    target: { value: 'Renamed copied repo' },
  });
  view.rerender(h(WorkOverviewView, { ...props, params: { ...props.params, sidebar: 'hidden' } }));
  expect(screen.queryByRole('complementary', { name: 'Projects' })).toBeNull();
  expect((screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value).toBe('Renamed copied repo');
  view.rerender(h(WorkOverviewView, props));
  expect(screen.getByRole('complementary', { name: 'Projects' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(requests).toContainEqual({ path: '/api/work/repos/copied-repo', method: 'PUT' }));

  fireEvent.click(screen.getByRole('button', { name: 'Remove repo' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm remove' }));
  await waitFor(() => expect(requests).toContainEqual({ path: '/api/work/repos/copied-repo', method: 'DELETE' }));

  window.dispatchEvent(new Event('focus'));
  expect(onRescan).not.toHaveBeenCalled();
  expect(requests.filter(({ path }) =>
    /\/audit$|\/commits$|\/compare$/.test(path)
    || ['/api/work/scan', '/api/work/push', '/api/system/open-path'].includes(path),
  )).toEqual([]);
});
