// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { acquirePresentationRows, readPresentationRows } from '../ui/src/query/readingPresentation';
import { queryClient } from '../ui/src/query/client';
import type { ReadingRow } from '../ui/src/chat/readingProjection';
const transport = vi.hoisted(() => ({ calls: [] as Array<{ signal: AbortSignal; finish: (response: Response) => void }> }));
vi.mock('../ui/src/client-auth-token', () => ({ browserSessionFetch: (_url: string, init: RequestInit) => new Promise<Response>((resolve, reject) => {
  const signal = init.signal as AbortSignal;
  signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
  transport.calls.push({ signal, finish: resolve });
}) }));
afterEach(() => { queryClient.clear(); transport.calls = []; });

it('does not let obsolete measurement cancel an overlapping visible row read', async () => {
  const measurement = new AbortController(); const visible = new AbortController();
  const request = { positionSpaceId: 'space', rows: [{ key: 'row', revision: 'same' }], expanded: {} };
  const obsolete = readPresentationRows('conv', request, measurement.signal).catch(error => error);
  const current = acquirePresentationRows('conv', request, visible.signal);
  await Promise.resolve();
  measurement.abort();
  await obsolete;
  expect(transport.calls[1].signal.aborted).toBe(false);
  const row = { key: 'row', revision: 'same', kind: 'content' } as ReadingRow & { revision: string };
  transport.calls[1].finish(new Response(JSON.stringify({ status: 'source', rows: [row] })));
  const lease = await current;
  expect(lease.rows).toEqual([row]);
  expect(queryClient.getQueryCache().findAll({ queryKey: ['chat', 'conversation', 'conv', 'reading-batch'] })).toHaveLength(1);
  lease.release(); lease.release();
  expect(queryClient.getQueryCache().findAll({ queryKey: ['chat', 'conversation', 'conv', 'reading-batch'] })).toHaveLength(0);
});
