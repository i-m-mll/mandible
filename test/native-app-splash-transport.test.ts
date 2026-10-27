import { expect, it, vi } from 'vitest';
import { controlledReadinessFetch } from './provisioned/fixtures/native-app-splash-transport';

const page = new URL('https://preview.mandible.localhost:19421/dist/proofs/3434b09/splash.html?reason=starting');

it.each(['ipc://localhost/plugin%3Awindow%7Cstart_dragging', 'http://ipc.localhost/plugin%3Awindow%7Cstart_dragging'])('preserves native IPC POST transport and response for %s', async url => {
  const response = new Response('native response', { headers: { 'Tauri-Response': 'ok' } });
  const transport = vi.fn(async () => response);
  const controlled = controlledReadinessFetch(transport, page, 'starting');
  const init = { method: 'POST', body: '{"label":"main"}', headers: { 'Tauri-Callback': '4', 'Tauri-Error': '5' } };
  expect(await controlled(url, init)).toBe(response);
  expect(transport).toHaveBeenCalledExactlyOnceWith(url, init);
});

it('blocks same-origin daemon API mutations without calling the real transport', async () => {
  const transport = vi.fn();
  const controlled = controlledReadinessFetch(transport, page, 'starting');
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const response = await controlled(new Request(page.origin + '/api/issues', { method }));
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('read-only');
  }
  expect(transport).not.toHaveBeenCalled();
});

it.each(['starting', 'rebuilding'] as const)('controls %s readiness while preserving actual health metadata', async reason => {
  const health = { ready: true, warm: true, rebuilding: false, instance: { instance_id: 'owned-preview' }, generation: 'exact-candidate' };
  const transport = vi.fn(async () => Response.json(health));
  const response = await controlledReadinessFetch(transport, page, reason)('/api/health');
  expect(await response.json()).toEqual({ ...health, ready: false, warm: false, rebuilding: reason === 'rebuilding' });
});

it('passes other daemon reads and unsuccessful health responses through unchanged', async () => {
  const response = new Response('not ready', { status: 503 });
  const transport = vi.fn(async () => response);
  const controlled = controlledReadinessFetch(transport, page, 'starting');
  expect(await controlled('/api/settings')).toBe(response);
  expect(await controlled('/api/health')).toBe(response);
  expect(await controlled('/api/health', { method: 'HEAD' })).toBe(response);
});
