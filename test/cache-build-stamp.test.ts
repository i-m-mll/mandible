// @vitest-environment jsdom
import { beforeEach, expect, it } from 'vitest';

import { readPersistedDetail, writePersistedDetail } from '../ui/src/detail-cache';
import { initialState, loadCachedState, saveCachedState } from '../ui/src/state';

function serveBuild(generation: string): void {
  window.__MANDIBLE_BOOTSTRAP__ = { instance: {
    role: 'main', instance_id: 'production', installation_id: 'installation', public_origin: 'https://app.mandible.localhost:19420',
    backend_generation: generation, allowed_effects: [], writable_roots: [], db_path: null, db_path_source: null,
  } };
}

beforeEach(() => window.localStorage.clear());

it('discards browser caches of server data written by a different backend build', () => {
  serveBuild('old');
  saveCachedState({ ...initialState, selectedAuthId: 'cached' });
  expect(writePersistedDetail('auth', 'cached', { candidate_acceptance: { state: 'running' } })).toBe(true);
  expect(loadCachedState().selectedAuthId).toBe('cached');
  expect(readPersistedDetail('auth', 'cached')).not.toBeNull();

  serveBuild('new');
  expect(loadCachedState()).toEqual({});
  expect(readPersistedDetail('auth', 'cached')).toBeNull();
});
