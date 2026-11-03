// @vitest-environment jsdom
import { h } from 'preact';
import { act, cleanup, render, waitFor } from './helpers/dom';
import { useCompleteReading } from '../ui/src/chat/useCompleteReading';
import { afterEach, expect, it, vi } from 'vitest';
import { acquirePresentationRows, readPresentationRows, readingManifestOptions, readingManifestKey } from '../ui/src/query/readingPresentation';
import { queryClient } from '../ui/src/query/client';
import type { ReadingRow } from '../ui/src/chat/readingProjection';
const transport = vi.hoisted(() => ({ calls: [] as Array<{ signal: AbortSignal; finish: (response: Response) => void }> }));
vi.mock('../ui/src/client-auth-token', () => ({ browserSessionFetch: (_url: string, init: RequestInit) => new Promise<Response>((resolve, reject) => {
  const signal = init.signal as AbortSignal;
  signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
  transport.calls.push({ signal, finish: resolve });
}) }));
vi.mock('../src/presentation/reading-composition', () => ({
  composeConversationReading: ({manifest}: any) => ({plan: {rows: (manifest.keys??['row']).map((key:string)=>({key, revision: manifest.revision, sourcePositions: []})), membership: new Map(),viewMembership:new Map()}, actionRuns: new Map()}),
  readingCompositionRequests: (_composition: any, refs: any) => refs,
  materializeConversationReading: (_composition: any, _refs: any, rows: any) => ({status: 'source', rows}),
}));
afterEach(() => { cleanup(); queryClient.clear(); transport.calls = []; });

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
  let reading!:ReturnType<typeof useCompleteReading>;
  const empty:[]=[];const expanded={};const revisions={};
  const local={rows:[],membership:new Map(),viewMembership:new Map(),actionRuns:new Map()};
  function Harness(){reading=useCompleteReading({scope:'partial',space:'space',events:empty,extraRows:empty,expanded,
    disclosureRevisions:revisions,local,enabled:true,initial:false,actionIdentity:''});return null;}
  render(h(Harness,{}));
  await waitFor(()=>expect(transport.calls).toHaveLength(1));
  await act(async()=>transport.calls[0].finish(new Response(JSON.stringify({status:'source',manifest:{revision:'same',keys:['ready','pending']}}))));
  await waitFor(()=>expect(transport.calls).toHaveLength(2));
  const [ready,pending]=reading.rows;
  const measurementController=new AbortController();
  const measurement=reading.acquireMeasurement([pending],measurementController.signal);
  await waitFor(()=>expect(transport.calls).toHaveLength(3));
  act(()=>reading.onRange({vector:reading.rows,required:[ready,pending],visible:[ready,pending],prefetch:[],start:0,end:400,height:400}));
  await act(async()=>{await Promise.resolve();});
  expect(transport.calls).toHaveLength(3);
  expect(transport.calls[1].signal.aborted).toBe(false);
  const body=(ref:typeof ready)=>({...ref,kind:'content',nodes:[],items:[],sources:[]});
  await act(async()=>transport.calls[1].finish(new Response(JSON.stringify({status:'source',rows:[body(ready)]}))));
  await waitFor(()=>expect(reading.getBody(ready)).toBeTruthy());
  expect(reading.getBody(pending)).toBeUndefined();
  expect(transport.calls[2].signal.aborted).toBe(false);
  await act(async()=>{transport.calls[2].finish(new Response(JSON.stringify({status:'source',rows:[body(pending)]})));(await measurement).release();});
  await waitFor(()=>expect(reading.getBody(pending)).toBeTruthy());
});


it.each(['manifest', 'rows'] as const)('keeps source bytes out of uncancelled malformed %s errors', async kind => {
  const controller = new AbortController();
  const request = {positionSpaceId: 'space', rows: [{key: 'row', revision: 'same'}], expanded: {}};
  const result = (kind === 'manifest' ? queryClient.fetchQuery(readingManifestOptions('conv', 'space'))
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
  const local = {rows: [], membership: new Map(), viewMembership: new Map(), actionRuns: new Map()};
  function Harness() {
    const reading = useCompleteReading({scope: 'consumer', space: 'space', events: empty, extraRows: empty, expanded,
      disclosureRevisions: disclosures, local, enabled: true, initial: false, actionIdentity: ''});
    const ref = reading.rows[0];
    return h('div', {}, [h('span', {}, ref ? reading.getBody(ref)?.revision ?? 'loading' : 'loading'),
      reading.error ? h('div', {role: 'alert'}, reading.error) : null]);
  }
  const view = render(h(Harness, {}));
  await waitFor(() => expect(transport.calls).toHaveLength(1));
  await act(async () => transport.calls[0].finish(new Response(JSON.stringify({status: 'source', manifest: {revision: 'obsolete'}}))));
  await waitFor(() => expect(transport.calls).toHaveLength(2));
  let partial!: ReadableStreamDefaultController<Uint8Array>;
  await act(async () => transport.calls[1].finish(new Response(new ReadableStream<Uint8Array>({
    start(controller) {partial = controller; controller.enqueue(new TextEncoder().encode('{"status":'));},
  }))));
  await act(async () => queryClient.setQueryData(readingManifestKey('consumer', 'space'), {revision: 'current'}));
  await waitFor(() => expect(transport.calls).toHaveLength(3));
  const row = {key: 'row', revision: 'current', kind: 'content', nodes: [], items: [], sources: []};
  await act(async () => transport.calls[2].finish(new Response(JSON.stringify({status: 'source', rows: [row]}))));
  await waitFor(() => expect(view.container.textContent).toBe('current'));
  await act(async () => partial.close());
  expect(view.queryByRole('alert')).toBeNull();
  expect(view.container.textContent).toBe('current');
  await act(async () => queryClient.setQueryData(readingManifestKey('consumer', 'space'), {revision: 'malformed'}));
  await waitFor(() => expect(transport.calls).toHaveLength(4));
  await act(async () => transport.calls[3].finish(new Response('{"status":', {headers: {'content-type': 'application/json'}})));
  await waitFor(() => expect(view.getByRole('alert')).toBeTruthy());
});
