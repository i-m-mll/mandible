import { queryClient } from './client';
import { browserSessionFetch } from '../client-auth-token';
import type { ConversationReadingManifest } from '../../../src/presentation/reading-manifest';
import type { ReadingRowBatchRequest, ReadingRowBatchResult } from '../../../src/conversations/reading-materialization';
import { traceReadingAcquisition } from '../chat/readingNavigationObservation';

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

export const readingManifestKey = (id: string) => ['chat', 'conversation', id, 'reading-manifest'] as const;
export function readingManifestOptions(id: string) {
  return { queryKey: readingManifestKey(id), staleTime:Infinity, queryFn: async ({ signal }: { signal: AbortSignal }) => {
    const endpoint = `/api/conversations/${encodeURIComponent(id)}/reading-manifest`;
    const response = await browserSessionFetch(endpoint, { signal });
    const result = await decodeReadingResponse<{ status: string; manifest?: ConversationReadingManifest; reason?: string }>(response, `GET ${endpoint}`, signal);
    if (result.status !== 'source' || !result.manifest) throw new Error(result.reason ?? result.status);
    return result.manifest;
  } };
}
export type ReadingRowsLease = { rows: Array<import('../chat/readingProjection').ReadingRow & { revision: string }>; release: () => void };
/** An acquired batch stays in Query custody until its bounded consumer releases it. */
async function acquireBatch(id: string, request: ReadingRowBatchRequest, signal: AbortSignal): Promise<ReadingRowsLease> {
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
      const first = await acquireBatch(id, { ...request, rows: request.rows.slice(0, middle) }, signal); children.push(first);
      const second = await acquireBatch(id, { ...request, rows: request.rows.slice(middle) }, signal); children.push(second);
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      return { rows: [...first.rows, ...second.rows], release };
    }
    if (result.status === 'changed') void queryClient.invalidateQueries({ queryKey: readingManifestKey(id) });
    throw new ReadingPresentationError(result.status, result.status === 'position-space-changed' ? result.status : `${result.status}: ${result.reason}`);
  } catch (error) { release(); throw error; }
}
type SharedRow = { owners: number; body: Promise<ReadingRowsLease['rows'][number]>; release: () => void;
  batch:{id:number;rows:number;startedAt:number;finishedAt?:number}; };
const acquiredRows = new Map<string, SharedRow>();
let acquisitionGroupId=0;

/** Viewport and measurement share exact rows, while cancellation releases only its own custody. */
export async function acquirePresentationRows(id: string, request: ReadingRowBatchRequest, signal: AbortSignal,
  onReady?:(rows:readonly ReadingRowsLease['rows'][number][])=>void): Promise<ReadingRowsLease> {
  if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
  const key = (row: ReadingRowBatchRequest['rows'][number]) => JSON.stringify([id, request.positionSpaceId, row.key, row.revision]);
  const missing = request.rows.filter(row => !acquiredRows.has(key(row)));
  if (missing.length) {
    const controller = new AbortController();
    let lease: ReadingRowsLease | undefined;
    const entries: SharedRow[] = [];
    const group={id:++acquisitionGroupId,rows:missing.length,startedAt:performance.now(),finishedAt:undefined as number|undefined};
    const releaseBatch = () => {
      if (entries.some(entry => entry.owners > 0)) return;
      controller.abort(); lease?.release();
    };
    const batch = acquireBatch(id, { ...request, rows: missing }, controller.signal).then(value => {
      group.finishedAt=performance.now();
      traceReadingAcquisition({event:'batch-ready',scope:id,batch:group.id,rows:group.rows,elapsedMs:group.finishedAt-group.startedAt});
      lease = value; releaseBatch(); return value;
    });
    for (const [index, row] of missing.entries()) {
      const identity = key(row);
      const entry: SharedRow = { owners: 0, body: batch.then(value => value.rows[index]),batch:group,release: () => {
        if (--entry.owners === 0 && acquiredRows.get(identity) === entry) acquiredRows.delete(identity);
        releaseBatch();
      } };
      entries.push(entry); acquiredRows.set(identity, entry);
    }
  }
  const entries = request.rows.map(row => acquiredRows.get(key(row))!);
  traceReadingAcquisition({event:'acquire',scope:id,keys:request.rows.map(row=>row.key),
    groups:[...new Set(entries.map(entry=>entry.batch))].map(batch=>({id:batch.id,rows:batch.rows,ageMs:performance.now()-batch.startedAt,ready:batch.finishedAt!==undefined}))});
  for (const entry of entries) entry.owners++;
  let released = false;
  const release = () => {
    if (released) return;
    released = true; signal.removeEventListener('abort', abort);
    for (const entry of entries) entry.release();
  };
  let rejectAbort!: (reason: unknown) => void;
  const abort = () => { release(); rejectAbort(new DOMException('Cancelled', 'AbortError')); };
  const cancelled = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  signal.addEventListener('abort', abort, { once: true });
  let rejectPartial!:(error:unknown)=>void;
  const partialFailure=new Promise<never>((_resolve,reject)=>{rejectPartial=reject;});
  if(onReady){
    let scheduled=false;
    let ready:ReadingRowsLease['rows']=[];
    for(const entry of entries)void entry.body.then(row=>{
      if(released||signal.aborted)return;
      ready.push(row);
      if(scheduled)return;
      scheduled=true;
      queueMicrotask(()=>{
        scheduled=false;const batch=ready;ready=[];
        if(released||signal.aborted)return;
        try{onReady(batch);}catch(error){rejectPartial(error);}
      });
    },()=>{});
  }
  try {
    const rows = await Promise.race([Promise.all(entries.map(entry => entry.body)), cancelled,partialFailure]);
    return { rows, release };
  } catch (error) { release(); throw error; }
}
export async function readPresentationRows(id: string, request: ReadingRowBatchRequest, signal: AbortSignal): Promise<ReadingRowsLease['rows']> {
  const lease = await acquirePresentationRows(id, request, signal);
  try { return lease.rows; } finally { lease.release(); }
}
