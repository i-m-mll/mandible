import { queryClient } from './client';
import { browserSessionFetch } from '../client-auth-token';
import type { ConversationReadingManifest } from '../../../src/presentation/reading-manifest';
import type { ReadingRowBatchRequest, ReadingRowBatchResult } from '../../../src/conversations/reading-materialization';

export class ReadingPresentationError extends Error {
  constructor(readonly status: Exclude<ReadingRowBatchResult['status'], 'source'>, detail: string) { super(detail); }
}
export const isReadingPublicationChanged = (error: unknown): boolean => error instanceof ReadingPresentationError && error.status === 'changed';

class ReadingResponseDecodeError extends Error {
  constructor(readonly operation: string, readonly status: number, readonly contentType: string | null, readonly observedBytes: number) {
    super(`Invalid JSON from ${operation} (HTTP ${status}; ${contentType ?? 'content type missing'}; ${observedBytes} bytes).`);
    this.name = 'ReadingResponseDecodeError';
  }
}

async function decodeReadingResponse<T>(response: Response, operation: string, signal: AbortSignal): Promise<T> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  try { return JSON.parse(new TextDecoder().decode(bytes)) as T; }
  catch (error) {
    if (signal.aborted) throw error;
    throw new ReadingResponseDecodeError(operation, response.status, response.headers.get('content-type'), bytes.byteLength);
  }
}

let batchRequestId = 0;

export const readingManifestKey = (id: string, space: string) => ['chat', 'conversation', id, 'reading-manifest', space] as const;
export function readingManifestOptions(id: string, space: string) {
  return { queryKey: readingManifestKey(id, space), queryFn: async ({ signal }: { signal: AbortSignal }) => {
    const endpoint = `/api/conversations/${encodeURIComponent(id)}/reading-manifest?expected_position_space_id=${encodeURIComponent(space)}`;
    const response = await browserSessionFetch(endpoint, { signal });
    const result = await decodeReadingResponse<{ status: string; manifest?: ConversationReadingManifest; reason?: string }>(response, `GET ${endpoint}`, signal);
    if (result.status !== 'source' || !result.manifest) throw new Error(result.reason ?? result.status);
    return result.manifest;
  } };
}
export type ReadingRowsLease = { rows: Array<import('../chat/readingProjection').ReadingRow & { revision: string }>; release: () => void };
/** An acquired batch stays in Query custody until its bounded consumer releases it. */
export async function acquirePresentationRows(id: string, request: ReadingRowBatchRequest, signal: AbortSignal): Promise<ReadingRowsLease> {
  const queryKey = ['chat', 'conversation', id, 'reading-batch', ++batchRequestId, request] as const;
  let released = false;
  const children: ReadingRowsLease[] = [];
  const release = () => {
    if (released) return;
    released = true;
    signal.removeEventListener('abort', abort);
    queryClient.removeQueries({ queryKey, exact: true });
    for (const child of children) child.release();
  };
  const abort = () => { void queryClient.cancelQueries({ queryKey, exact: true }); release(); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    const result = await queryClient.fetchQuery({ queryKey, gcTime: Infinity, staleTime: 0, queryFn: async ({ signal: querySignal }) => {
      const endpoint = `/api/conversations/${encodeURIComponent(id)}/reading-rows`;
      const response = await browserSessionFetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal: querySignal,
      });
      return await decodeReadingResponse<ReadingRowBatchResult>(response, `POST ${endpoint}`, querySignal);
    } });
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    if (result.status === 'source') return { rows: result.rows, release };
    if (result.status === 'resource-limit' && request.rows.length > 1) {
      queryClient.removeQueries({ queryKey, exact: true });
      const middle = Math.ceil(request.rows.length / 2);
      const first = await acquirePresentationRows(id, { ...request, rows: request.rows.slice(0, middle) }, signal); children.push(first);
      const second = await acquirePresentationRows(id, { ...request, rows: request.rows.slice(middle) }, signal); children.push(second);
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      return { rows: [...first.rows, ...second.rows], release };
    }
    if (result.status === 'changed') void queryClient.invalidateQueries({ queryKey: readingManifestKey(id, request.positionSpaceId) });
    throw new ReadingPresentationError(result.status, result.status === 'position-space-changed' ? result.status : `${result.status}: ${result.reason}`);
  } catch (error) { release(); throw error; }
}
export async function readPresentationRows(id: string, request: ReadingRowBatchRequest, signal: AbortSignal): Promise<ReadingRowsLease['rows']> {
  const lease = await acquirePresentationRows(id, request, signal);
  try { return lease.rows; } finally { lease.release(); }
}
