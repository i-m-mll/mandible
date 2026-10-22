import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import { ConversationSpawnApiError, invalidateApiGetCache, listCanonicalProjects, startProviderChat } from '../ui/src/api';
import { __resetBrowserSessionForTests } from '../ui/src/client-auth-token';

import { establishTestClientAccess } from './helpers/local-client-access';

beforeEach(establishTestClientAccess);

afterEach(() => {
  invalidateApiGetCache();
  __resetBrowserSessionForTests();
  vi.unstubAllGlobals();
});

describe('provider Chat creation payload', () => {
  it('posts only the version-3 UUID, provider, and canonical placement', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify({ session: {} }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await startProviderChat(
      '10000000-0000-4000-8000-000000000001',
      'codex',
      { kind: 'project', project_id: 'project-1', checkout_id: 'checkout-1' },
    );

    const spawnCall = fetchMock.mock.calls.find(([input]) => String(input) === '/api/conversation-spawns');
    expect(JSON.parse(String(spawnCall?.[1]?.body))).toEqual({
      schema: 'mandible-conversation-spawn-request@3',
      idempotency_key: '10000000-0000-4000-8000-000000000001',
      provider: 'codex',
      placement: { kind: 'project', project_id: 'project-1', checkout_id: 'checkout-1' },
    });
  });

  it('preserves typed provider startup failure data from the spawn boundary', async () => {
    const failure = {
      code: 'provider_startup_timeout',
      message: 'The provider did not become ready in time.',
      retryable: true,
      phase: 'readiness' as const,
      provenance: {
        backend_type: 'acp' as const,
        provider: 'codex',
        implementation: {
          kind: 'package' as const,
          name: '@agentclientprotocol/codex-acp',
          version: '1.0.2',
          entrypoint: 'dist/index.js',
          launcher: 'node',
        },
      },
    };
    const spawn = {
      schema: 'mandible-conversation-spawn-receipt@2' as const,
      reservation_id: 'reservation-1',
      request: {},
      state: 'failed' as const,
      attempt_count: 1,
      native_session_id: null,
      provider_session_id: null,
      provider_receipt: null,
      error: failure,
      created_at: 1,
      updated_at: 2,
    };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify({ ok: false, error: failure, spawn }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    })));

    const result = startProviderChat(
      '10000000-0000-4000-8000-000000000001',
      'codex',
      { kind: 'project', project_id: 'project-1', checkout_id: 'checkout-1' },
    );
    await expect(result).rejects.toBeInstanceOf(ConversationSpawnApiError);
    await expect(result).rejects.toMatchObject({ status: 502, failure, spawn });
  });

  it('forwards caller cancellation without adding a second browser deadline', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      if (init?.signal?.aborted) {
        reject(init.signal.reason);
        return;
      }
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const result = startProviderChat(
      '10000000-0000-4000-8000-000000000001',
      'codex',
      { kind: 'project', project_id: 'project-1', checkout_id: 'checkout-1' },
      { signal: controller.signal },
    );
    controller.abort(new DOMException('abandoned', 'AbortError'));
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    const spawnCall = fetchMock.mock.calls.find(([input]) => String(input) === '/api/conversation-spawns');
    expect(spawnCall?.[1]?.signal).toBe(controller.signal);
  });
});

describe('canonical Chat project registry payload', () => {
  it('retains canonical project and checkout IDs while reading the existing projects route', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify({
      projects: [{
        id: 'prj-1', project_key: 'mandible', display_name: 'Mandible',
        checkouts: [{
          id: 'checkout-1', project_id: 'prj-1', work_repo_id: 'mandible',
          root: '/repos/mandible', name: 'Mandible', default_branch: 'main', remote_url: '',
        }],
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(listCanonicalProjects()).resolves.toEqual([{
      id: 'prj-1', project_key: 'mandible', display_name: 'Mandible',
      checkouts: [expect.objectContaining({ id: 'checkout-1', project_id: 'prj-1', root: '/repos/mandible' })],
    }]);
    expect(fetchMock).toHaveBeenCalledWith('/api/projects', expect.anything());
  });
});
