import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { __resetBrowserSessionForTests } from '../../ui/src/client-auth-token';
import { AuthHooksPanel } from '../../ui/src/views/auth';
import type { AuthHook, InstanceInfo } from '../../ui/src/api';

const instance: InstanceInfo = {
  role: 'main',
  instance_id: 'auth-hooks-panel-test',
  installation_id: 'auth-hooks-panel-test',
  public_origin: 'http://localhost:19420',
  backend_generation: 'test',
  allowed_effects: ['auth:protected'],
  writable_roots: [],
  db_path: null,
  db_path_source: null,
};

function hook(id: string, label: string, command: string): AuthHook {
  return {
    id,
    repo_pattern: '*',
    auth_type: 'merge',
    command,
    label,
    enabled: true,
    builtin: false,
    position: 0,
    created_at: 1,
    updated_at: 1,
  };
}

function setupFetch(initialHooks: AuthHook[]) {
  const hooks = [...initialHooks];
  const updates: Array<{ id: string; fields: Record<string, unknown> }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/client-auth/whoami') {
      return new Response(JSON.stringify({ authenticated: true, session: {
        family_id: 'auth-hooks-panel-test', audience: 'production', csrf_token: 'csrf',
        effect_ceiling: ['auth:protected'],
      } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url === '/api/auth/hooks' && (!init?.method || init.method === 'GET')) {
      return new Response(JSON.stringify({ hooks }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const match = url.match(/^\/api\/auth\/hooks\/([^/]+)$/);
    if (match && init?.method === 'PUT') {
      const id = decodeURIComponent(match[1]);
      const fields = JSON.parse(String(init.body)) as Record<string, unknown>;
      updates.push({ id, fields });
      const index = hooks.findIndex((item) => item.id === id);
      hooks[index] = { ...hooks[index], ...fields };
      return new Response(JSON.stringify(hooks[index]), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return updates;
}

afterEach(() => {
  cleanup();
  __resetBrowserSessionForTests();
  vi.unstubAllGlobals();
});

describe('Approval Hooks settings editor', () => {
  it('finishes a pending edit before switching to another hook', async () => {
    const updates = setupFetch([hook('hook-a', 'Alpha', 'echo alpha'), hook('hook-b', 'Beta', 'echo beta')]);
    render(<AuthHooksPanel instance={instance} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Edit Alpha' }));
    fireEvent.input(screen.getByRole('textbox', { name: 'Hook command' }), { target: { value: 'echo alpha newest' } });
    fireEvent.click(screen.getByRole('button', { name: 'Edit Beta' }));

    await waitFor(() => expect(updates).toContainEqual({ id: 'hook-a', fields: {
      repo_pattern: '*', auth_type: 'merge', command: 'echo alpha newest', label: 'Alpha',
    } }));
    await waitFor(() => expect((screen.getByRole('textbox', { name: 'Hook command' }) as HTMLTextAreaElement).value).toBe('echo beta'));
  });

  it('persists a valid pending edit when the Settings panel unmounts', async () => {
    const updates = setupFetch([hook('hook-a', 'Alpha', 'echo alpha')]);
    render(<AuthHooksPanel instance={instance} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Edit Alpha' }));
    fireEvent.input(screen.getByRole('textbox', { name: 'Hook command' }), { target: { value: 'echo before unmount' } });
    expect(document.querySelectorAll('[data-settings-searchable]').length).toBeGreaterThan(1);
    cleanup();

    await waitFor(() => expect(updates).toContainEqual({ id: 'hook-a', fields: {
      repo_pattern: '*', auth_type: 'merge', command: 'echo before unmount', label: 'Alpha',
    } }));
  });
});
