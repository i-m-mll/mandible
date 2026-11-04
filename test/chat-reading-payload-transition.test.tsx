// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from './helpers/dom';
import { afterEach, expect, it, vi } from 'vitest';
import { readingBodyKey, readingPayloadKey, readingTargetLabels, useCompleteReading } from '../ui/src/chat/useCompleteReading';
import { queryClient } from '../ui/src/query/client';
import { activityTargetOptions } from '../ui/src/query/activityTargets';
import { activityTargetKey } from '../src/presentation/activity-targets';
import type { ConversationReadingManifest } from '../src/presentation/reading-manifest';
function manifest(): ConversationReadingManifest {
  const activity={type:'provider-directive' as const,provider:'codex' as const,sessionId:'parent',blockId:null,sequence:0,directive:{kind:'created-thread' as const,identity:'threadId' as const,providerSessionId:'native-child'}};
  return {conversationId:'conv',positionSpaceId:'space',sourceVersionId:boundary.revision,publicationRevision:boundary.revision==='old'?1:2,blockCount:boundary.targets?2:1,runs:{},summarySources:{},scopes:[],
    members:Array.from({length:boundary.targets?2:1},(_,index)=>({key:index?'unrelated':'row',position:index,part:'message',kind:index||!boundary.targets?'content' as const:'activity' as const,speaker:index||!boundary.targets?'user' as const:'assistant' as const,
      actionGroup:{key:`scope:${index}`,start:index,end:index},activity:!index&&boundary.targets?activity:null,activityRunId:null,dependencyRevision:boundary.revision,sourcePositions:[index],handoffKeys:[]}))};
}
const boundary = vi.hoisted(() => ({ revision: 'old', release: null as null | (() => void), targets:false, reads:0, resolveLabels:null as null | (()=>Promise<void>) }));
vi.mock('../ui/src/api', () => ({resolveActivityTargets: async (targets:any[]) => {
  await boundary.resolveLabels?.();
  return targets.map(target => ({key:activityTargetKey(target),status:'resolved',conversationId:'canonical-child',title:'Original title'}));
}}));
vi.mock('../ui/src/query/readingPresentation', () => ({
  readingManifestOptions: () => ({ queryKey: ['payload-transition-manifest'], queryFn: async () => manifest() }),
  isReadingPublicationChanged: () => false,
  ReadingPresentationError: class extends Error {},
  acquirePresentationRows: async (_id: string, request: any) => {
    boundary.reads++;
    if (boundary.revision === 'new') await new Promise<void>(resolve => { boundary.release = resolve; });
    return { rows: request.rows.map((ref: any) => {
      const member=manifest().members.find(member=>member.key===ref.key)!;
      const source={blockId:`cblk:conv:${member.position}`,position:member.position,detailsLoaded:true};
      return {...ref,kind:'content',materializedMemberKeys:[ref.key],sources:[source],nodes:member.activity?[{kind:'activity',key:'created',entity:'assistant',source,item:member.activity}]:[{kind:'user_message',key:ref.key,text:boundary.revision,persisted:source}],items:[]};
    }), release: () => {} };
  },
}));
const events: [] = []; const extraRows: [] = []; const expanded = {}; const disclosureRevisions = {};
const local = { rows: [], membership: new Map(), viewMembership: new Map(), actionRuns: new Map() };
let reading: ReturnType<typeof useCompleteReading>;
function Harness() {
  reading = useCompleteReading({ scope: 'conv', space: 'space', events, extraRows, expanded, disclosureRevisions, local,
    enabled: true, initial: false, actionIdentity: '' });
  return null;
}
afterEach(() => { cleanup(); queryClient.clear(); boundary.revision = 'old'; boundary.release = null; boundary.targets = false; boundary.reads = 0; boundary.resolveLabels=null; });

it('publishes demanded source bodies without waiting for metadata resolution', async () => {
  boundary.targets=true;
  let finish!:()=>void;
  boundary.resolveLabels=()=>new Promise<void>(resolve=>{finish=resolve;});
  render(<Harness/>);
  await waitFor(()=>expect(reading.rows[0] && reading.getBody(reading.rows[0])).toBeTruthy());
  const row=reading.rows[0];
  const body=reading.getBody(row);
  const reads=boundary.reads;
  await waitFor(()=>expect(finish).toBeTypeOf('function'));
  await act(async()=>finish());
  await waitFor(()=>expect(Object.values(reading.rows[0].targetLabels??{}).some(label=>label.selection)).toBe(true));
  expect(reading.getBody(reading.rows[0])).toBe(body);
  expect(boundary.reads).toBe(reads);
});

it('keeps the applied payload paintable until matching pending geometry replaces it', async () => {
  render(<Harness />);
  await waitFor(() => expect(reading!.rows[0] && reading!.getBody(reading!.rows[0])).toBeTruthy());
  const old = reading!.rows[0];
  act(() => { reading!.onRange({ vector: [old], required: [old], prefetch: [], start: 0, end: 100, height: 100 }); reading!.retainGeometry([old]); });
  boundary.revision = 'new';
  await act(async () => { queryClient.setQueryData(['payload-transition-manifest'], manifest()); });
  await waitFor(() => expect(boundary.release).toBeTruthy());
  const pending = reading!.rows[0];
  expect(reading!.getBody(old)?.revision).toBe(old.revision);
  expect(reading!.getBody(pending)).toBeUndefined();
  await act(async () => { boundary.release!(); await Promise.resolve(); });
  await waitFor(() => expect(reading!.getBody(pending)).toBeTruthy());
  act(() => reading!.retainGeometry([pending]));
  expect(reading!.getBody(old)?.revision).toBe(old.revision);
  await act(async () => { reading!.commitGeometry(reading!.rows); reading!.onRange({ vector: [pending], required: [pending], prefetch: [], start: 0, end: 100, height: 100 }); });
  await waitFor(() => expect(reading!.getBody(old)).toBeUndefined());
  expect(reading!.getBody(pending)?.revision).toBe(pending.revision);
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
  expect(reading.getBody(offscreen)).toBeTruthy();
  expect(readingTargetLabels(offscreen)?.[key]?.label).not.toBe(reading.rows[0].targetLabels?.[key]?.label);
  expect(reading.getBody(reading.rows[0])).toBeTruthy();
});
