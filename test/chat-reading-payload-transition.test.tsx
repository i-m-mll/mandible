// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from './helpers/dom';
import { afterEach, expect, it, vi } from 'vitest';
import { readingBodyKey, readingPayloadKey, useCompleteReading } from '../ui/src/chat/useCompleteReading';
import { queryClient } from '../ui/src/query/client';
import { activityTargetOptions } from '../ui/src/query/activityTargets';
import { activityTargetKey } from '../src/presentation/activity-targets';
const boundary = vi.hoisted(() => ({ revision: 'old', release: null as null | (() => void), targets:false, reads:0 }));
vi.mock('../ui/src/api', () => ({resolveActivityTargets: async (targets:any[]) => targets.map(target => ({key:activityTargetKey(target),status:'resolved',conversationId:'canonical-child',title:'Original title'}))}));
vi.mock('../ui/src/query/readingPresentation', () => ({
  readingManifestOptions: () => ({ queryKey: ['payload-transition-manifest'], queryFn: async () => ({ revision: boundary.revision }) }),
  isReadingPublicationChanged: () => false,
  ReadingPresentationError: class extends Error {},
  acquirePresentationRows: async (_id: string, request: any) => {
    boundary.reads++;
    if (request.rows[0].revision === 'new') await new Promise<void>(resolve => { boundary.release = resolve; });
    return { rows: request.rows.map((ref: any) => ({ ...ref, kind: 'content', sources: [], nodes: boundary.targets && ref.key === 'row' ? [{kind:'activity',key:'created',entity:'assistant',item:{type:'provider-directive',provider:'codex',sessionId:'parent',blockId:null,sequence:0,directive:{kind:'created-thread',identity:'threadId',providerSessionId:'native-child'}}}] : [], items: [] })), release: () => {} };
  },
}));
vi.mock('../src/presentation/reading-composition', () => ({
  composeConversationReading: ({ manifest }: any) => ({ plan: { rows: [{ key: 'row', revision: manifest.revision, sourcePositions: [] }, ...(boundary.targets ? [{key:'unrelated',revision:manifest.revision,sourcePositions:[]}] : [])], membership: new Map() }, actionRuns: new Map() }),
  readingCompositionRequests: (_composition: any, refs: any) => refs,
  materializeConversationReading: (_composition: any, _refs: any, rows: any) => ({ status: 'source', rows }),
}));
const events: [] = []; const extraRows: [] = []; const expanded = {}; const disclosureRevisions = {};
const local = { rows: [], membership: new Map(), viewMembership: new Map(), actionRuns: new Map() };
let reading: ReturnType<typeof useCompleteReading>;
function Harness() {
  reading = useCompleteReading({ scope: 'conv', space: 'space', events, extraRows, expanded, disclosureRevisions, local,
    enabled: true, initial: false, actionIdentity: '' });
  return null;
}
afterEach(() => { cleanup(); queryClient.clear(); boundary.revision = 'old'; boundary.release = null; boundary.targets = false; boundary.reads = 0; });

it('keeps the applied payload paintable until matching pending geometry replaces it', async () => {
  render(<Harness />);
  await waitFor(() => expect(reading!.rows[0] && reading!.getBody(reading!.rows[0])).toBeTruthy());
  const old = reading!.rows[0];
  act(() => { reading!.onRange({ vector: [old], required: [old], prefetch: [], start: 0, end: 100, height: 100 }); reading!.retainGeometry([old]); });
  boundary.revision = 'new';
  await act(async () => { queryClient.setQueryData(['payload-transition-manifest'], { revision: 'new' }); });
  await waitFor(() => expect(boundary.release).toBeTruthy());
  const pending = reading!.rows[0];
  expect(reading!.getBody(old)?.revision).toBe('old');
  expect(reading!.getBody(pending)).toBeUndefined();
  await act(async () => { boundary.release!(); await Promise.resolve(); });
  await waitFor(() => expect(reading!.getBody(pending)).toBeTruthy());
  act(() => reading!.retainGeometry([pending]));
  expect(reading!.getBody(old)?.revision).toBe('old');
  await act(async () => { reading!.commitGeometry(reading!.rows); reading!.onRange({ vector: [pending], required: [pending], prefetch: [], start: 0, end: 100, height: 100 }); });
  await waitFor(() => expect(reading!.getBody(old)).toBeUndefined());
  expect(reading!.getBody(pending)?.revision).toBe('new');
});

it('changes only the retained target row layout on title reconciliation and reuses its source body', async () => {
  boundary.targets = true;
  render(<Harness />);
  const target = {kind:'thread' as const,provider:'codex' as const,sessionId:'native-child'};
  const key = activityTargetKey(target);
  await waitFor(() => expect(reading.rows[0]?.targetLabels?.[key]?.selection).toEqual({type:'conversation',id:'canonical-child'}));
  const before = reading.rows;
  const body = reading.getBody(before[0]);
  const reads = boundary.reads;
  const previousLabel = before[0].targetLabels![key].label;
  await act(async () => { queryClient.setQueryData(activityTargetOptions(target).queryKey,{key,status:'resolved',conversationId:'canonical-child',title:'Renamed canonical title'}); });
  await waitFor(() => expect(reading.rows[0].targetLabels?.[key]?.label).not.toBe(previousLabel));
  const after = reading.rows;
  expect(after[0].revision).toBe(before[0].revision);
  expect(readingPayloadKey(after[0])).not.toBe(readingPayloadKey(before[0]));
  expect(readingBodyKey(after[0])).toBe(readingBodyKey(before[0]));
  expect(after[1].disclosureIdentity).toBe(before[1].disclosureIdentity);
  expect(before[0].targetLabels![key].label).toBe(previousLabel);
  const lease = await reading.acquireMeasurement([after[0]],new AbortController().signal);
  expect(lease.bodies[0]).toBe(body);
  lease.release();
  expect(boundary.reads).toBe(reads);
  act(() => reading.onRange({vector:after,required:[after[1]],prefetch:[],start:0,end:100,height:100}));
  await waitFor(() => expect(reading.getBody(reading.rows[1])).toBeTruthy());
  await waitFor(() => expect(reading.getBody(after[0])).toBeUndefined());
  const offscreen = reading.rows[0];
  const offscreenReads = boundary.reads;
  await act(async () => { queryClient.setQueryData(activityTargetOptions(target).queryKey,{key,status:'resolved',conversationId:'canonical-child',title:'Changed while offscreen'}); });
  expect(reading.rows[0].disclosureIdentity).toBe(offscreen.disclosureIdentity);
  expect(reading.rows[0].targetLabels).toBeUndefined();
  expect(boundary.reads).toBe(offscreenReads);
  act(() => reading.onRange({vector:reading.rows,required:[offscreen],prefetch:[],start:0,end:100,height:100}));
  await waitFor(() => expect(reading.rows[0].targetLabels?.[key]?.label).toBe('Changed while offscreen'));
  expect(reading.getBody(offscreen)).toBeUndefined();
  expect(reading.getBody(reading.rows[0])).toBeTruthy();
});
