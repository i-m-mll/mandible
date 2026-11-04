// @vitest-environment jsdom
import { h } from 'preact';
import { act, cleanup, render, waitFor } from './helpers/dom';
import { useCompleteReading } from '../ui/src/chat/useCompleteReading';
import { afterEach, expect, it, vi } from 'vitest';
import { acquirePresentationRows, readPresentationRows, readingManifestOptions, readingManifestKey } from '../ui/src/query/readingPresentation';
import { queryClient } from '../ui/src/query/client';
import type { ReadingRow } from '../ui/src/chat/readingProjection';
import type { ReadingRowBatchRequest } from '../src/conversations/reading-materialization';
import { readingAcquisitionFixture } from './helpers/reading-acquisition-fixture';
const transport = vi.hoisted(() => ({ calls: [] as Array<{ url:string; request?:ReadingRowBatchRequest; signal: AbortSignal; finish: (response: Response) => void }> }));
vi.mock('../ui/src/client-auth-token', () => ({ browserSessionFetch: (url: string, init: RequestInit) => new Promise<Response>((resolve, reject) => {
  const signal = init.signal as AbortSignal;
  signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
  transport.calls.push({ url, request:init.body?JSON.parse(String(init.body)):undefined, signal, finish: resolve });
}) }));
afterEach(() => { cleanup(); queryClient.clear(); transport.calls = []; });
const callFor=(scope:string,ref:{key:string;revision:string})=>transport.calls.find(call=>call.url.includes(`/conversations/${scope}/reading-rows`)&&call.request?.rows.some(row=>row.key===ref.key&&row.revision===ref.revision));

it('does not let obsolete measurement cancel an overlapping visible row read', async () => {
  const measurement = new AbortController(); const visible = new AbortController();
  const request = { positionSpaceId: 'space', rows: [{ key: 'row', revision: 'same' }], expanded: {} };
  const obsolete = readPresentationRows('conv', request, measurement.signal).catch(error => error);
  const current = acquirePresentationRows('conv', request, visible.signal);
  await Promise.resolve();
  measurement.abort();
  await obsolete;
  expect(transport.calls).toHaveLength(1);
  expect(transport.calls[0].signal.aborted).toBe(false);
  const row = { key: 'row', revision: 'same', kind: 'content' } as ReadingRow & { revision: string };
  transport.calls[0].finish(new Response(JSON.stringify({ status: 'source', rows: [row] })));
  const lease = await current;
  expect(lease.rows).toEqual([row]);
  expect(queryClient.getQueryCache().findAll({ queryKey: ['chat', 'conversation', 'conv', 'reading-batch'] })).toHaveLength(1);
  lease.release(); lease.release();
  expect(queryClient.getQueryCache().findAll({ queryKey: ['chat', 'conversation', 'conv', 'reading-batch'] })).toHaveLength(0);
});

it('publishes ready visible source rows while another shared group remains pending and transfers overlapping custody',async()=>{
  const source=readingAcquisitionFixture('partial','same',['ready','pending']);
  let reading!:ReturnType<typeof useCompleteReading>;
  const empty:[]=[];const expanded={};const revisions={};
  const local={rows:[],membership:new Map(),viewMembership:new Map(),actionRuns:new Map()};
  function Harness(){reading=useCompleteReading({scope:'partial',space:'space',events:empty,extraRows:empty,expanded,
    disclosureRevisions:revisions,local,enabled:true,initial:false,actionIdentity:''});return null;}
  render(h(Harness,{}));
  await waitFor(()=>expect(transport.calls.find(call=>!call.request)).toBeTruthy());
  await act(async()=>transport.calls.find(call=>!call.request)!.finish(new Response(JSON.stringify({status:'source',manifest:source.manifest}))));
  await waitFor(()=>expect(reading.rows).toHaveLength(2));
  const [ready,pending]=reading.rows;
  await waitFor(()=>expect(callFor('partial',ready)).toBeTruthy());
  const readyCall=callFor('partial',ready)!;
  const measurementController=new AbortController();
  const measurement=reading.acquireMeasurement([pending],measurementController.signal);
  await waitFor(()=>expect(callFor('partial',pending)).toBeTruthy());
  const pendingCall=callFor('partial',pending)!;
  act(()=>reading.onRange({vector:reading.rows,required:[ready,pending],visible:[ready,pending],prefetch:[],start:0,end:400,height:400}));
  await act(async()=>{await Promise.resolve();});
  expect(readyCall.signal.aborted).toBe(false);
  expect(transport.calls.flatMap(call=>call.request?.rows??[]).filter(row=>row.key===pending.key)).toHaveLength(1);
  await act(async()=>readyCall.finish(new Response(JSON.stringify({status:'source',rows:source.materialize(readyCall.request!)}))));
  await waitFor(()=>expect(reading.getBody(ready)).toBeTruthy());
  expect(reading.getBody(pending)).toBeUndefined();
  expect(pendingCall.signal.aborted).toBe(false);
  await act(async()=>{pendingCall.finish(new Response(JSON.stringify({status:'source',rows:source.materialize(pendingCall.request!)})));(await measurement).release();});
  await waitFor(()=>expect(reading.getBody(pending)).toBeTruthy());
});

it.each(['manifest', 'rows'] as const)('keeps source bytes out of uncancelled malformed %s errors', async kind => {
  const controller = new AbortController();
  const request = {positionSpaceId: 'space', rows: [{key: 'row', revision: 'same'}], expanded: {}};
  const result = (kind === 'manifest' ? queryClient.fetchQuery(readingManifestOptions('conv'))
    : acquirePresentationRows('conv', request, controller.signal)).catch(error => error);
  await Promise.resolve();
  const body = '{"status":"source","private":"CONTENT MUST NOT APPEAR"';
  transport.calls[0].finish(new Response(body, {status: 200, headers: {'content-type': 'application/json'}}));
  const error = await result;
  expect(error.message).not.toContain('CONTENT MUST NOT APPEAR');
  expect(controller.signal.aborted).toBe(false);
});

it('keeps abandoned partial bodies out of the visible error and preserves a current malformed response alert', async () => {
  const empty: [] = []; const expanded = {}; const disclosures = {};
  const publication=(revision:string)=>readingAcquisitionFixture('consumer',revision,['row']);
  const local = {rows: [], membership: new Map(), viewMembership: new Map(), actionRuns: new Map()};
  let reading!:ReturnType<typeof useCompleteReading>;
  function Harness() {
    reading = useCompleteReading({scope: 'consumer', space: 'space', events: empty, extraRows: empty, expanded,
      disclosureRevisions: disclosures, local, enabled: true, initial: false, actionIdentity: ''});
    return reading.error?h('div',{role:'alert'},reading.error):null;
  }
  const view = render(h(Harness, {}));
  await waitFor(() => expect(transport.calls.find(call=>!call.request)).toBeTruthy());
  await act(async () => transport.calls.find(call=>!call.request)!.finish(new Response(JSON.stringify({status: 'source', manifest: publication('obsolete').manifest}))));
  await waitFor(() => expect(reading.rows[0]&&callFor('consumer',reading.rows[0])).toBeTruthy());
  const obsolete=callFor('consumer',reading.rows[0])!;
  let partial!: ReadableStreamDefaultController<Uint8Array>;
  await act(async () => obsolete.finish(new Response(new ReadableStream<Uint8Array>({
    start(controller) {partial = controller; controller.enqueue(new TextEncoder().encode('{"status":'));},
  }))));
  const current=publication('current');
  await act(async () => queryClient.setQueryData(readingManifestKey('consumer'), current.manifest));
  await waitFor(() => {expect(reading.rows[0].revision).not.toBe(obsolete.request!.rows[0].revision);expect(callFor('consumer',reading.rows[0])).toBeTruthy();});
  const currentRef=reading.rows[0];const currentCall=callFor('consumer',currentRef)!;
  await act(async () => currentCall.finish(new Response(JSON.stringify({status: 'source', rows: current.materialize(currentCall.request!)}))));
  await waitFor(() => expect(reading.getBody(currentRef)?.revision).toBe(currentRef.revision));
  await act(async () => partial.close());
  expect(view.queryByRole('alert')).toBeNull();
  expect(reading.getBody(currentRef)?.revision).toBe(currentRef.revision);
  await act(async () => queryClient.setQueryData(readingManifestKey('consumer'), publication('malformed').manifest));
  await waitFor(() => {expect(reading.rows[0].revision).not.toBe(currentRef.revision);expect(callFor('consumer',reading.rows[0])).toBeTruthy();});
  await act(async () => callFor('consumer',reading.rows[0])!.finish(new Response('{"status":', {headers: {'content-type': 'application/json'}})));
  await waitFor(() => expect(view.getByRole('alert')).toBeTruthy());
});
