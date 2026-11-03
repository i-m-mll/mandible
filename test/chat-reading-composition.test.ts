import { testRuntimeRoot } from './helpers/runtime-isolation';
import {chatItemIdentityKey} from '../src/conversation-control/provider-live';
import fs from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { migratedMemoryDb } from './helpers/ledger-fixtures';
import { CodexParser } from '../src/parsers/codex';
import { ClaudeParser } from '../src/parsers/claude';
import { activitySemanticFacts, semanticActivityIcon, presentActivityItems } from '../src/presentation/activity-presentation';
import { activityObservationTargets } from '../src/presentation/activity-targets';
import { operationObservationForTool } from '../src/presentation/tool-observation';
import { ConversationSourceStore } from '../src/conversations/source-store';
import { ConversationSourceReader } from '../src/conversations/source-reader';
import { CURRENT_CONVERSATION_SOURCE_EPOCHS } from '../src/conversations/source-types';
import { captureReadingPublication, readConversationReadingManifest, readReadingRowBatch } from '../src/conversations/reading-materialization';
import { planConversationReading } from '../src/presentation/reading-manifest';
import { composeConversationReading, materializeConversationReading, readingCompositionRequests } from '../src/presentation/reading-composition';
import type { CanonicalChatItemEvent } from '../src/presentation/types';

async function fixture(includeResult: boolean, native?: {provider:'codex'|'claude_code'; records:Record<string,unknown>[]}) {
  const root = fs.mkdtempSync(path.join(testRuntimeRoot, 'mandible-reading-composition-'));
  const db = migratedMemoryDb();
  const provider = native?.provider ?? 'codex';
  const file = path.join(root, provider === 'codex' ? '.codex/sessions/composition.jsonl' : '.claude/projects/-tmp/composition.jsonl');
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const records = native?.records ?? [
    {type: 'session_meta', payload: {id: 'composition', cwd: '/tmp'}},
    {type: 'event_msg', payload: {type: 'task_started', turn_id: 'turn'}},
    {type: 'response_item', payload: {type: 'message', role: 'user', content: [{type: 'input_text', text: 'inspect'}]}},
    {type: 'response_item', payload: {type: 'function_call', call_id: 'call', name: 'read', arguments: '{"file_path":"/tmp/exact-owner"}'}},
    ...(includeResult ? [{type: 'response_item', payload: {type: 'function_call_output', call_id: 'call', output: 'EXACT RESULT BODY'}}] : []),
  ];
  fs.writeFileSync(file, records.map(record => JSON.stringify(record)).join('\n') + '\n');
  const parsed = await (provider === 'codex' ? new CodexParser() : new ClaudeParser()).parse(file);
  if (!parsed) throw new Error('Native composition fixture did not parse.');
  db.prepare(`INSERT INTO conversations(id,source,source_path,source_hash,source_mtime,session_id,block_count,started_at)
    VALUES('composition',?,?,?,?,'composition',?,'2026-11-01')`).run(provider, file, parsed.conversation.source_hash, parsed.conversation.source_mtime, parsed.blocks.length);
  await new ConversationSourceStore(db).recordConversation({conversationId: 'composition', provider, nativeSessionId: 'composition',
    filePath: file, blocks: parsed.blocks, sourceSnapshot: parsed.sourceSnapshot, ...CURRENT_CONVERSATION_SOURCE_EPOCHS});
  const manifest = readConversationReadingManifest(db, 'composition', captureReadingPublication(db, 'composition')!)!;
  return {root, db, parsed, manifest, reader: new ConversationSourceReader(db), close: () => {db.close(); fs.rmSync(root, {recursive: true, force: true});}};
}

it('keeps Claude command roles and stream facts through typed indexing and folded source materialization', async () => {
  const invocation = '<command-name>/memory</command-name>\n<command-message>memory</command-message>\n<command-args>project</command-args>';
  const output = 'Updated memory\nDETAIL ONLY IN SOURCE';
  const records = [
    {uuid:'old-invocation',type:'user',message:{role:'user',content:invocation}},
    {uuid:'old-output',parentUuid:'old-invocation',type:'user',message:{role:'user',content:`<local-command-stdout>${output}</local-command-stdout>`}},
    {uuid:'new-invocation',type:'system',subtype:'local_command',content:invocation},
    {uuid:'new-output',parentUuid:'new-invocation',type:'system',subtype:'local_command',commandRun:{command:'memory',args:'project'},content:'<local-command-stderr>Permission denied</local-command-stderr>'},
  ].map(record => ({sessionId:'composition',timestamp:'2026-11-01T00:00:00Z',...record}));
  const f = await fixture(false,{provider:'claude_code',records});
  try {
    expect(f.manifest.members.map(member => [member.speaker,member.sourcePositions])).toEqual([['user',[0]],['system',[1]],['user',[2]],['system',[3]]]);
    const outputs = f.manifest.members.filter(member => member.activityFacts?.localCommandStream);
    expect(outputs.map(member => member.activityFacts!.localCommandStream)).toEqual(['stdout','stderr']);
    expect(Object.values(f.manifest.summarySources).flat()).toEqual(expect.arrayContaining([1,3]));
    expect(JSON.stringify(f.manifest)).not.toContain('DETAIL ONLY IN SOURCE');
    const headers: unknown[] = [];
    for (const expanded of [{}, Object.fromEntries(outputs.flatMap(member => member.disclosures!.keys.map(key => [key,true])))]) {
      const plan = planConversationReading(f.manifest,expanded);
      const result = await readReadingRowBatch({db:f.db,reader:f.reader,conversationId:'composition',request:{positionSpaceId:f.manifest.positionSpaceId,rows:plan.rows,expanded}});
      expect(result.status).toBe('source');
      if(result.status !== 'source')throw new Error(result.status);
      const nodes = result.rows.flatMap(row => row.activityGroup?.items ?? row.nodes);
      expect(nodes.filter(node => node.kind === 'user_message')).toHaveLength(2);
      const activities = nodes.flatMap(node => node.kind === 'activity' && node.item.type === 'activity' && node.item.local_command ? [node.item] : []);
      expect(activities.map(item => item.local_command!.stream)).toEqual(['stdout','stderr']);
      headers.push(activities.map(item => ({presentation:presentActivityItems([item]).map(value => value.summary),icon:semanticActivityIcon(activitySemanticFacts(item))})));
    }
    expect(headers[1]).toEqual(headers[0]);
    expect(f.parsed.blocks[0].content).toBe(invocation);
    expect(f.parsed.blocks[1].role).toBe('user');
  } finally {f.close();}
});

it('retains Claude create/resume actions and parent-scoped targets in compact and materialized owners', async () => {
  const descriptions = ['Inspect settings','Continue inspection'];
  const records = descriptions.flatMap((description,index) => [
    {uuid:`call-${index}`,type:'assistant',message:{role:'assistant',content:[{type:'tool_use',id:`agent-${index}`,name:index?'Task':'Agent',input:{description,prompt:'Inspect',...(index?{resume:'native-agent'}:{})}}]}},
    {uuid:`result-${index}`,parentUuid:`call-${index}`,type:'user',toolUseResult:{agentId:'native-agent',...(index?{}:{description}),status:index?'completed':'async_launched'},message:{role:'user',content:[{type:'tool_result',tool_use_id:`agent-${index}`,content:'Agent result'}]}},
  ]).map(record => ({sessionId:'composition',timestamp:'2026-11-01T00:00:00Z',...record}));
  const f = await fixture(false,{provider:'claude_code',records});
  try {
    const members = f.manifest.members.filter(member => member.activityFacts?.kind === 'tool');
    expect(members).toHaveLength(2);
    expect(members.map(member => member.activityFacts!.observation!.operation)).toEqual(['subagent-create','subagent-resume']);
    const expected = descriptions.map(labelHint => [{kind:'subagent',provider:'claude_code',parentSessionId:'composition',agentId:'native-agent',labelHint}]);
    expect(members.map(member => activityObservationTargets(member.activityFacts!.observation!))).toEqual(expected);
    const expanded = {[`group:${members[0].activityRunId}`]:true};
    const plan = planConversationReading(f.manifest,expanded);
    const result = await readReadingRowBatch({db:f.db,reader:f.reader,conversationId:'composition',request:{positionSpaceId:f.manifest.positionSpaceId,rows:plan.rows,expanded}});
    expect(result.status).toBe('source');
    if(result.status !== 'source')throw new Error(result.status);
    const observed = result.rows.filter(row => row.kind === 'content').flatMap(row => row.nodes).flatMap(node => node.kind === 'activity' && node.item.type === 'tool-call-activity' ? [operationObservationForTool(node.item)] : []);
    expect(observed.map(item => item.operation)).toEqual(['subagent-create','subagent-resume']);
    expect(observed.map(activityObservationTargets)).toEqual(expected);
  } finally {f.close();}
});

it('projects only proven native task notifications and retains repeated reports and raw source',async()=>{
  const summary='Agent "Inspect settings" finished';
  const report='First finding\n\nSecond finding';
  const envelope=`<task-notification>\n<task-id>same-agent</task-id>\n<tool-use-id>native-call</tool-use-id>\n<output-file>/private/tasks/same-agent.output</output-file>\n<status>completed</status>\n<summary>${summary}</summary>\n<note>The same task may notify after resuming.</note>\n<result>${report}</result>\n<usage><tool_uses>2</tool_uses></usage>\n</task-notification>`;
  const producer={origin:{kind:'task-notification',producer:'session-task',runId:'native-run'},promptSource:'system',turnOrigin:'task_notification'};
  const ids=['notification-one','notification-two','quoted-by-user'];
  const records=ids.map((uuid,index)=>({uuid,type:'user',sessionId:'composition',timestamp:'2026-11-01T00:00:00Z',...(index<2?producer:{}),message:{role:'user',content:envelope}}));
  const f=await fixture(false,{provider:'claude_code',records});
  try {
    const notifications=f.manifest.members.filter(member=>member.activityFacts?.activityKind==='tool-summary');
    expect(notifications.map(member=>member.sourcePositions)).toEqual([[0],[1]]);
    expect(new Set(notifications.map(member=>member.key)).size).toBe(2);
    expect(f.manifest.members.find(member=>member.position===2)?.speaker).toBe('user');
    const expanded={[`group:${notifications[0].activityRunId}`]:true,...Object.fromEntries(notifications.flatMap(member=>member.disclosures!.keys.map(key=>[key,true])))};
    const plan=planConversationReading(f.manifest,expanded);
    const rendered=await readReadingRowBatch({db:f.db,reader:f.reader,conversationId:'composition',request:{positionSpaceId:f.manifest.positionSpaceId,rows:plan.rows,expanded}});
    expect(rendered.status).toBe('source');
    if(rendered.status!=='source')throw new Error(rendered.status);
    const nodes=rendered.rows.filter(row=>row.kind==='content').flatMap(row=>row.nodes);
    const events=nodes.flatMap(node=>node.kind==='activity'&&node.item.type==='activity'?[node.item]:[]);
    expect(events.map(item=>item.identity.native_item_id)).toEqual(ids.slice(0,2));
    expect(events.map(item=>item.parts.map(part=>part.text))).toEqual([[summary,report],[summary,report]]);
    expect(nodes.filter(node=>node.kind==='user_message')).toHaveLength(1);
    const raw=await f.reader.readPositions('composition',[0,1]);
    expect(raw.status).toBe('source');
    if(raw.status!=='source')throw new Error(raw.status);
    expect(raw.value.map(block=>[block.type,block.role,block.content])).toEqual([['user_message','user',envelope],['user_message','user',envelope]]);
    expect(f.parsed.blocks.map(block=>block.metadata.chat_item!.identity.native_item_id)).toEqual(ids);
  } finally {f.close();}
});

it('materializes exact disclosed call/result targets through the normal row source', async () => {
  const f = await fixture(true);
  try {
    const call = f.manifest.members.find(member => member.activityFacts?.kind === 'tool')!;
    const closed = planConversationReading(f.manifest, {});
    const expanded = {[call.disclosures!.keys[0]]: true};
    const open = planConversationReading(f.manifest, expanded);
    const descriptor = open.rows.find(row => row.key === call.key)!;
    expect(descriptor.revision).not.toBe(closed.rows.find(row => row.key === call.key)!.revision);
    const result = await readReadingRowBatch({db: f.db, reader: f.reader, conversationId: 'composition',
      request: {positionSpaceId: f.manifest.positionSpaceId, rows: [descriptor], expanded}});
    expect(result.status).toBe('source');
    if (result.status !== 'source') throw new Error(result.status);
    const node = result.rows[0].nodes[0];
    expect(node).toMatchObject({kind: 'activity', source: {position: call.position, detailsLoaded: true},
      item: {input: expect.stringContaining('exact-owner'), result: {content: 'EXACT RESULT BODY', source: {detailsLoaded: true}}}});
    const positions = call.sourcePositions;
    expect(open.membership.get(positions[0])?.subtarget).not.toBe(open.membership.get(positions[1])?.subtarget);
    const resultKey = chatItemIdentityKey(f.parsed.blocks.find(block => block.type === 'tool_result')!.metadata.chat_item!)!;
    expect(open.viewMembership.get(resultKey)?.position).toBe(positions[1]);
    expect(JSON.stringify(f.manifest)).not.toContain('EXACT RESULT BODY');
  } finally {f.close();}
});

it('composes a live result and live suffix with the canonical owner through one plan and bounded canonical-only reads', async () => {
  const f = await fixture(false);
  try {
    const call = f.parsed.blocks.find(block => block.type === 'tool_use')!.metadata.chat_item!;
    const result: CanonicalChatItemEvent = {type: 'chat:item', item: {...call, phase: 'result', role: 'tool', output: 'LIVE RESULT', input: undefined,
      provenance: {...call.provenance, source: 'live-provider-event'}} as CanonicalChatItemEvent['item']};
    const suffix: CanonicalChatItemEvent = {type: 'chat:item', item: {...call, tool_id: 'second-call', tool_name: 'edit', input: '{"file_path":"/tmp/new"}',
      identity: {...call.identity, native_item_id: 'second-call', native_tool_id: 'second-call'}, provenance: {...call.provenance, source: 'live-provider-event'}} as CanonicalChatItemEvent['item']};
    const composed = composeConversationReading({manifest: f.manifest, events: [result, suffix], expanded: {}});
    const owner = f.manifest.members.find(member => member.activityFacts?.kind === 'tool')!;
    const summary = composed.plan.rows.find(row => row.kind === 'activity-summary')!;
    expect(composed.members.find(member=>member.key===owner.key)?.activityFacts?.observation?.execution.state).toBe('completed');
    expect(summary.memberKeys).toHaveLength(2);
    expect(composed.actionRuns.get(summary.actionGroup.key)?.events).toContain(result);
    expect(composed.plan.membership.get(owner.position!)?.rowKey).toBe(summary.key);
    const refs = readingCompositionRequests(composed, [summary]);
    const canonical = await readReadingRowBatch({db: f.db, reader: f.reader, conversationId: 'composition',
      request: {positionSpaceId: f.manifest.positionSpaceId, rows: refs, expanded: {}}});
    if (canonical.status !== 'source') throw new Error(canonical.status);
    const hydrated = materializeConversationReading(composed, [summary], canonical.rows);
    expect(hydrated.status).toBe('source');
    if (hydrated.status !== 'source') throw new Error(hydrated.reason);
    expect(hydrated.rows[0].activityGroup?.items.find(node => node.source?.position === owner.position)?.item).toMatchObject({result: {content: 'LIVE RESULT'}});
    expect(hydrated.rows[0].activityGroup?.items.find(node => !node.source)?.item).toMatchObject({name: 'edit'});
    const hydratedOwner=hydrated.rows[0].activityGroup!.items.find(node=>node.source?.position===owner.position)!;
    if(hydratedOwner.item.type!=='tool-call-activity')throw Error('Expected the exact tool owner');
    expect(hydratedOwner.item.observation).toEqual(composed.members.find(member=>member.key===owner.key)?.activityFacts?.observation);
    expect(JSON.stringify(refs)).not.toContain('LIVE RESULT');
  } finally {f.close();}
});

it('accepts a captured row snapshot when publication freshness advances without changing its dependencies', async () => {
  const f = await fixture(true);
  try {
    const descriptor = planConversationReading(f.manifest, {}).rows[0];
    const original = f.reader.readPositions.bind(f.reader);
    const race = vi.spyOn(f.reader, 'readPositions').mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      f.db.prepare("UPDATE conversation_sources SET publication_revision=publication_revision+1 WHERE conversation_id='composition'").run();
      return result;
    });
    try {
      const result = await readReadingRowBatch({db: f.db, reader: f.reader, conversationId: 'composition',
        request: {positionSpaceId: f.manifest.positionSpaceId, rows: [descriptor], expanded: {}}});
      expect(result).toMatchObject({status: 'source', publicationRevision: f.manifest.publicationRevision});
    } finally {race.mockRestore();}
  } finally {f.close();}
});

it('preserves the tool row and source positions when empty completion metadata appends', async () => {
  const f = await fixture(false);
  try {
    const call = f.manifest.members.find(member => member.activityFacts?.kind === 'tool')!;
    const first = planConversationReading(f.manifest, {}).rows.find(row => row.key === call.key)!;
    const file = path.join(f.root, '.codex/sessions/composition.jsonl');
    fs.appendFileSync(file, JSON.stringify({type: 'event_msg', payload: {type: 'task_complete', turn_id: 'turn'}}) + '\n');
    const parsed = await new CodexParser().parse(file);
    if (!parsed) throw new Error('Appended native source did not parse.');
    await new ConversationSourceStore(f.db).recordConversation({conversationId: 'composition', provider: 'codex', nativeSessionId: 'composition',
      filePath: file, blocks: parsed.blocks, sourceSnapshot: parsed.sourceSnapshot, ...CURRENT_CONVERSATION_SOURCE_EPOCHS});
    const manifest = readConversationReadingManifest(f.db, 'composition', captureReadingPublication(f.db, 'composition')!)!;
    expect(manifest.blockCount).toBe(f.manifest.blockCount + 1);
    expect(manifest.positionSpaceId).toBe(f.manifest.positionSpaceId);
    const plan = planConversationReading(manifest, {});
    const retained = plan.rows.find(row => row.key === first.key)!;
    expect(retained.memberKeys).toEqual(first.memberKeys);
    expect(plan.membership.has(parsed.blocks.at(-1)!.position)).toBe(false);
  } finally {f.close();}
});

it('coalesces only adjacent complete reasoning equivalents while retaining every native source alias',async()=>{
  const text='**Planning retry**\n\nPreparing consultation';
  const reasoning=(id:string,body:string)=>({type:'response_item',payload:{type:'reasoning',id,summary:[{type:'summary_text',text:body}],internal_chat_message_metadata_passthrough:{turn_id:'same-turn'}}});
  const mirror={type:'event_msg',payload:{type:'item_completed',turn_id:'same-turn',item:{type:'Reasoning',id:'mirror'}}};
  const f=await fixture(false,{provider:'codex',records:[{type:'session_meta',payload:{id:'composition',cwd:'/tmp'}},reasoning('first',text),mirror,mirror,reasoning('second',text),
    {type:'event_msg',payload:{type:'task_started',turn_id:'same-turn'}},reasoning('after-status',text),reasoning('distinct-body','**Planning retry**\n\nDifferent consultation')]});
  try {
    const source=f.parsed.blocks.filter(block=>block.type==='thinking');
    expect(source).toHaveLength(4);
    const representatives=f.manifest.members.filter(member=>member.activityFacts?.reasoningEquivalence);
    expect(representatives).toHaveLength(3);
    expect(representatives[0].sourcePositions).toEqual(source.slice(0,2).map(block=>block.position));
    expect(representatives[1].activityFacts?.reasoningEquivalence).toBe(representatives[0].activityFacts?.reasoningEquivalence);
    expect(representatives[2].activityFacts?.reasoningEquivalence).not.toBe(representatives[0].activityFacts?.reasoningEquivalence);
    const [first,second]=source;
    const closed=planConversationReading(f.manifest,{});
    expect(closed.membership.get(first.position)?.memberKey).toBe(closed.membership.get(second.position)?.memberKey);
    expect(closed.membership.get(first.position)?.subtarget).not.toBe(closed.membership.get(second.position)?.subtarget);
    const expanded={[representatives[0].disclosures!.keys[0]]:true,...(representatives[0].activityRunId?{[`group:${representatives[0].activityRunId}`]:true}:{})};
    const open=planConversationReading(f.manifest,expanded);
    const descriptor=open.rows.find(row=>row.key===representatives[0].key)!;
    const read=await readReadingRowBatch({db:f.db,reader:f.reader,conversationId:'composition',request:{positionSpaceId:f.manifest.positionSpaceId,rows:[descriptor],expanded}});
    if(read.status!=='source')throw Error(read.status);
    expect(read.rows[0].nodes).toHaveLength(1);
    expect(read.rows[0].sources.map(source=>source.position)).toEqual([first.position,second.position]);
    const node=read.rows[0].nodes[0];
    if(node.kind!=='activity')throw Error('Expected representative reasoning event');
    expect(node.sourceAliases?.map(source=>source.position)).toEqual([second.position]);
  } finally {f.close();}
});

it('keeps compact and hydrated wait chains identical without crossing semantic interruptions',async()=>{
  const report='## Native child report\n\nPreserve this result exactly.';
  const response=(payload:Record<string,unknown>)=>({type:'response_item',payload});
  const run=(id:string)=>response({type:'custom_tool_call',call_id:id,name:'exec',input:'text(await tools.codex_app__wait_threads({targets:[{threadId:"child"}]}));'});
  const wait=(id:string)=>response({type:'function_call',call_id:id,name:'wait',arguments:'{"cell_id":"106"}'});
  const yielded=(id:string,type:string,seconds:number)=>response({type,call_id:id,output:`Script running with cell ID 106\nWall time ${seconds} seconds\nOutput:\n`});
  const terminal=response({type:'function_call_output',call_id:'terminal',output:[{type:'input_text',text:'Script completed\nWall time 12.3 seconds\nOutput:\n'},{type:'input_text',text:JSON.stringify({timedOut:false,polls:[{thread:{id:'child'},latestAssistantMessage:{phase:'final_answer',text:report}}]})}]});
  for(const interrupted of [false,true]){
    const f=await fixture(false,{provider:'codex',records:[{type:'session_meta',payload:{id:'composition',cwd:'/tmp'}},run('origin'),yielded('origin','custom_tool_call_output',31),
      {type:'event_msg',payload:{type:'token_count'}},...(interrupted?[{type:'event_msg',payload:{type:'task_started',turn_id:'turn'}}]:[]),wait('continuation'),yielded('continuation','function_call_output',61),wait('terminal'),terminal]});
    try{
      const members=f.manifest.members.filter(member=>member.activityFacts?.observation?.operation==='thread-wait');
      expect(members).toHaveLength(interrupted?2:1);
      const owner=members.at(-1)!;
      const expanded=Object.fromEntries([...(owner.disclosures?.keys??[]),...(owner.activityRunId?[`group:${owner.activityRunId}`]:[])].map(key=>[key,true]));
      const plan=planConversationReading(f.manifest,expanded);
      const descriptor=plan.rows.find(row=>row.key===owner.key)!;
      const read=await readReadingRowBatch({db:f.db,reader:f.reader,conversationId:'composition',request:{positionSpaceId:f.manifest.positionSpaceId,rows:[descriptor],expanded}});
      if(read.status!=='source')throw Error(read.status);
      const node=read.rows[0].nodes[0];
      if(node.kind!=='activity'||node.item.type!=='tool-call-activity')throw Error('Missing wait owner');
      expect(node.item.observation).toEqual(owner.activityFacts!.observation);
      expect(node.item.result?.fullText??node.item.result?.content).toContain(report.replaceAll('\n','\\n'));
      expect(new Set(read.rows[0].sources.map(source=>source.position))).toEqual(new Set(owner.sourcePositions));
      const composition=composeConversationReading({manifest:f.manifest,events:[],expanded});
      const composedDescriptor=composition.plan.rows.find(row=>row.key===owner.key)!;
      const composed=materializeConversationReading(composition,[composedDescriptor],read.rows);
      if(composed.status!=='source')throw Error(composed.reason);
      expect(new Set(composed.rows[0].sources.map(source=>source.position))).toEqual(new Set(owner.sourcePositions));
      const nativeCalls=f.parsed.blocks.filter(block=>block.type==='tool_use');
      for(const call of nativeCalls.filter(call=>owner.sourcePositions.includes(call.position)))expect(plan.membership.get(call.position)?.memberKey).toBe(owner.key);
    }finally{f.close();}
  }
});
