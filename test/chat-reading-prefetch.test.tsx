// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from './helpers/dom';
import { afterEach, expect, it, vi } from 'vitest';
import { useCompleteReading } from '../ui/src/chat/useCompleteReading';
import { queryClient } from '../ui/src/query/client';
import { readingAcquisitionFixture } from './helpers/reading-acquisition-fixture';
import type { ConversationReadingManifest } from '../src/presentation/reading-manifest';

const boundary = vi.hoisted(() => ({ refresh: null as null | (() => Promise<{ revision: string }>), calls: [] as { scope:string; refs: {key:string;revision:string}[]; signal: AbortSignal; done:boolean; resolve: () => void; reject: (error: Error) => void }[] }));
const keys=Array.from({length:50},(_,index)=>`row:${index}`);
const source=(scope:string,revision:string)=>readingAcquisitionFixture(scope,revision,keys);
vi.mock('../ui/src/query/readingPresentation', () => ({
  readingManifestOptions: (scope: string) => ({ queryKey: ['prefetch-manifest', scope], queryFn: async () => source(scope,(boundary.refresh ? await boundary.refresh() : {revision:'1'}).revision).manifest }),
  isReadingPublicationChanged: (error: Error) => error.name === 'PublicationChanged',
  ReadingPresentationError: class extends Error {},
  acquirePresentationRows: (scope: string, request: any, signal: AbortSignal) => new Promise((resolve, reject) => {
    const manifest=queryClient.getQueryData<ConversationReadingManifest>(['prefetch-manifest',scope])!;
    const corpus=source(scope,manifest.sourceVersionId);
    const call = { scope, refs: request.rows, signal, done:false, reject: (error: Error) => {call.done=true;if (error.name === 'PublicationChanged') void queryClient.invalidateQueries({ queryKey: ['prefetch-manifest', scope] }); reject(error); }, resolve: () => {call.done=true;resolve({ rows:corpus.materialize(request), release: () => {} });} };
    boundary.calls.push(call);
    signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
  }),
}));
const events: [] = []; const extraRows: [] = []; const expanded = {}; const disclosureRevisions = {};
const local = { rows: [], membership: new Map(), viewMembership: new Map(), actionRuns: new Map() };
let reading: ReturnType<typeof useCompleteReading>;
function Harness({ scope = 'conv' }: { scope?: string }) {
  reading = useCompleteReading({ scope, space: 'space', events, extraRows, expanded, disclosureRevisions, local,
    enabled: true, initial: false, actionIdentity: '' });
  return null;
}
function demand(required: number[], prefetch: number[]) {
  reading.onRange({ vector: reading.rows, required: required.map(index => reading.rows[index]), prefetch: prefetch.map(index => reading.rows[index]), start: 0, end: 1000, height: 400 });
}
const live=(index:number,scope='conv')=>boundary.calls.find(call=>call.scope===scope&&!call.done&&!call.signal.aborted&&call.refs.some(ref=>ref.key===`row:${index}`));
async function requested(index:number,scope='conv') {await waitFor(()=>expect(live(index,scope)).toBeTruthy());return live(index,scope)!;}
afterEach(() => { cleanup(); queryClient.clear(); boundary.calls = []; boundary.refresh = null; });

it('retains useful overlapping work, promotes cached prefetch and evicts the old window', async () => {
  render(<Harness />);
  const initial=await requested(0);
  act(() => demand([0], [1, 2, 3]));
  expect(initial.signal.aborted).toBe(false);
  await act(async () => initial.resolve());
  const prefetched=await requested(1);
  act(() => demand([1], [2, 3, 4]));
  expect(prefetched.signal.aborted).toBe(false);
  await act(async () => prefetched.resolve());
  await waitFor(() => expect(reading.getBody(reading.rows[1])).toBeTruthy());
  const next=await requested(4);
  act(() => demand([2], [3, 4]));
  expect(reading.getBody(reading.rows[2])).toBeTruthy();
  expect(next.signal.aborted).toBe(false);
  act(() => demand([40], [41, 42]));
  await requested(40);
  expect(next.signal.aborted).toBe(true);
  await waitFor(() => expect(reading.getBody(reading.rows[2])).toBeUndefined());
});

it('preempts unrelated speculation through its own lease and keeps failures from replacing displayed content', async () => {
  const view = render(<Harness />);
  const initial=await requested(0);
  act(() => demand([0], [1, 2]));
  await act(async () => initial.resolve());
  const speculation=await requested(1);
  const measurementController = new AbortController();
  let measurement!: ReturnType<typeof reading.acquireMeasurement>;
  act(() => { measurement = reading.acquireMeasurement([reading.rows[30]], measurementController.signal); });
  const measured=await requested(30);
  act(() => demand([0, 10], [1, 2]));
  const required=await requested(10);
  expect(speculation.signal.aborted).toBe(true);
  expect(measured.signal.aborted).toBe(false);
  await act(async () => required.resolve());
  const failed=await requested(1);
  await act(async () => failed.reject(new Error('speculation unavailable')));
  await waitFor(() => expect(reading.error).toBeNull());
  expect(reading.getBody(reading.rows[0])).toBeTruthy();
  const calls=boundary.calls.length;
  act(() => reading.protect());
  await act(async () => { await Promise.resolve(); });
  expect(boundary.calls.length).toBe(calls);
  await act(async () => { measured.resolve(); (await measurement).release(); });
  view.rerender(<Harness scope="next" />);
  await requested(0,'next');
});

it('cancels stale source and scope ownership while keeping required failures explicit without retrying', async () => {
  const view = render(<Harness />);
  const initial=await requested(0);
  act(() => demand([0], [1, 2]));
  await act(async () => initial.resolve());
  const speculation=await requested(1);
  await act(async () => queryClient.setQueryData(['prefetch-manifest', 'conv'], source('conv','2').manifest));
  const replacement=await requested(0);
  expect(speculation.signal.aborted).toBe(true);
  expect(replacement.refs.some(ref=>ref.key===reading.rows[0].key&&ref.revision===reading.rows[0].revision)).toBe(true);
  view.rerender(<Harness scope="next" />);
  const current=await requested(0,'next');
  expect(replacement.signal.aborted).toBe(true);
  await act(async () => current.reject(new Error('required unavailable')));
  await waitFor(() => expect(reading.error).toBeTruthy());
  const calls=boundary.calls.length;
  act(() => reading.protect());
  await act(async () => { await Promise.resolve(); });
  expect(boundary.calls.length).toBe(calls);
});

it('preempts a formerly required request when current demand has demoted it to speculation', async () => {
  render(<Harness />);
  const initial=await requested(0);
  act(() => demand([10], [0]));
  await requested(10);
  expect(initial.signal.aborted).toBe(true);
});

it('retries unchanged canonical identities after reconciliation without spinning while publication is pending', async () => {
  render(<Harness />);
  const initial=await requested(0);
  let release!: (value: { revision: string }) => void;
  boundary.refresh = () => new Promise(resolve => { release = resolve; });
  const changed = new Error('publication changed'); changed.name = 'PublicationChanged';
  await act(async () => initial.reject(changed));
  await waitFor(() => expect(release).toBeTruthy());
  const calls=boundary.calls.length;
  act(() => reading.protect());
  await act(async () => { await Promise.resolve(); });
  expect(boundary.calls.length).toBe(calls);
  expect(reading.error).toBeNull();
  await act(async () => release({ revision: '1' }));
  const current=await requested(0);
  await act(async () => current.resolve());
  await waitFor(() => expect(reading.getBody(reading.rows[0])).toBeTruthy());
});
