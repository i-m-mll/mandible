import { expect, it } from 'vitest';
import { projectToolProgram } from '../src/presentation/tool-program';
import { toolObservation,operationObservationForTool,presentationForObservation } from '../src/presentation/tool-observation';
import { operationState, operationResult, substantiveToolResult, threadReports } from '../src/presentation/tool-operation';
import { rawToolResult, codexResultFrame } from '../src/presentation/tool-transport';

it('projects complete transparent wrappers while retaining arbitrary computation as source', () => {
  const input={threadId:'exact-provider-thread',hostId:'local'};
  const direct=toolObservation('codex_app__read_thread',input);
  const source=`const result=await tools.codex_app__read_thread(${JSON.stringify(input)});for(const part of (result?.content??[])) part.type==='image'?image(part):text(part.text??part);if(!result?.content)text(result);`;
  const wrapped=toolObservation('functions.exec',source,'custom_tool_call');
  expect(wrapped.header).toEqual(direct.header);
  const media=[{type:'image' as const,source:{type:'base64',media_type:'image/png',data:'aW1hZ2U='}}];
  expect(toolObservation('exec',source,undefined,{text:'',content:media}).result?.content).toEqual(media);
  expect(wrapped.header.threadTargets).toEqual([{type:'session',id:input.threadId}]);
  for(const computation of [source+'text("extra");',source.replace('text(part.text??part)','text(part.text.toUpperCase())')]) {
    const program=projectToolProgram('functions.exec',computation,'custom_tool_call');
    expect(program?.operations[0].name).toBe('codex_app__read_thread');
    expect(program?.outputAttributed).toBe(false);
    expect(toolObservation('functions.exec',computation,'custom_tool_call',{text:'retained opaque output'}).result?.text).toBe('retained opaque output');
  }
  expect(projectToolProgram('functions.exec','text(await tools.codex_app__read_thread(resolveTarget()))','custom_tool_call')).toBeNull();
  const discovery='const hits=ALL_TOOLS.filter(tool=>/thread/.test(tool.name+tool.description)).map(tool=>({name:tool.name,description:tool.description}));text(hits);';
  expect(projectToolProgram('functions.exec',discovery)?.operations).toHaveLength(1);
  expect(projectToolProgram('functions.exec',discovery+'await tools.exec_command({cmd:"pwd"})')).toBeNull();
  const forwarded='const hits=ALL_TOOLS.filter(x=>/codex_app__list_projects/.test(x.name));hits.forEach(x=>text(x));';
  expect(projectToolProgram('functions.exec',forwarded)?.operations).toEqual(projectToolProgram('functions.exec',discovery)?.operations);
  const aliased='const available=ALL_TOOLS;const hits=available.filter(x=>/codex_app__list_projects/.test(x.name));const matches=hits;const emit=text;matches.forEach(x=>{emit(x)});';
  expect(projectToolProgram('functions.exec',aliased)?.operations).toEqual(projectToolProgram('functions.exec',forwarded)?.operations);
  for(const computed of [forwarded.replace('text(x)','text(JSON.parse(x.name))'),forwarded.replace('text(x)','tools.exec_command(x)'),forwarded.replace('x=>text(x)','text=>text(text)'),forwarded+'text(42)']) expect(projectToolProgram('functions.exec',computed)).toBeNull();

});

it('suppresses only a known empty patch acknowledgement and retains reports, errors and unknown output', () => {
  const patch='*** Begin Patch\n*** Update File: /tmp/example.ts\n@@\n-before\n+after\n*** End Patch';
  const source=`const patch=${JSON.stringify(patch)};text(await tools.apply_patch(patch));`;
  const observation=toolObservation('exec',source,'custom_tool_call',{text:'{}'});
  expect(observation.header.target).toBe('/tmp/example.ts');
  expect(substantiveToolResult(observation.result!)).toBe(false);
  for(const result of [{...rawToolResult('{}'),failed:true},rawToolResult('{"unexpected":"retained"}')]) expect(substantiveToolResult(operationResult(observation.header,result))).toBe(true);
  const report={timedOut:false,polls:[{thread:{id:'child',hostId:'local'},latestAssistantMessage:{phase:'final_answer',text:'Substantive child report',truncated:true,originalChars:32186}}]};
  const value=toolObservation('codex_app__wait_threads',{targets:[{threadId:'child',hostId:'local'}]},undefined,{text:JSON.stringify(report)});
  expect(threadReports(value.result!.text)).toMatchObject([{threadId:'child',text:report.polls[0].latestAssistantMessage.text,final:true,truncated:true,originalChars:32186}]);
  expect(substantiveToolResult(value.result!)).toBe(true);
  expect(threadReports(JSON.stringify({...report,polls:[{...report.polls[0],latestAssistantMessage:{...report.polls[0].latestAssistantMessage,diagnostic:'must remain visible'}}]}))).toBeNull();
  const failure=toolObservation('exec','text(await tools.exec_command({cmd:"false"}))',undefined,{text:JSON.stringify({output:'diagnostic',exit_code:7,wall_time_seconds:0.1})});
  expect(operationState('completed',failure.result)).toBe('failed');
  expect(threadReports('arbitrary application output')).toBeNull();
  const waiting=toolObservation('codex_app__wait_threads',{targets:[{threadId:'child',hostId:'local'}]},undefined,{text:JSON.stringify({timedOut:true,polls:[]})});
  expect(waiting.header.hasDetails).toBe(false);
  const diagnostic=toolObservation('codex_app__wait_threads',{},undefined,{text:JSON.stringify({timedOut:true,polls:[],error:'retained'})});
  expect(substantiveToolResult(diagnostic.result!)).toBe(true);
});

it('keeps native termination separate from explicit inner failure', () => {
  const prefix='Script terminated\nWall time: 1 seconds\nOutput:\n';
  const call={name:'functions.exec',kind:'custom_tool_call'};
  const terminated=prefix+'partial output';
  const cancelled=toolObservation(call.name,'await arbitraryComputation()',call.kind,{text:terminated,frame:codexResultFrame(terminated,call)});
  expect(operationState('cancelled',cancelled.result)).toBe('cancelled');
  expect(cancelled.result?.text).toBe('partial output');
  const failed=prefix+JSON.stringify({output:'inner diagnostic',exit_code:7,wall_time_seconds:0.5});
  const inner=toolObservation(call.name,'text(await tools.exec_command({cmd:"false"}))',call.kind,{text:failed,frame:codexResultFrame(failed,call)});
  expect(operationState('cancelled',inner.result)).toBe('failed');
  expect(inner.result?.text).toBe('inner diagnostic');
});

it('associates batched creation receipts with authored titles and scopes an unattributed wrapper failure',()=>{
  const input='const [native,queued]=await Promise.all([tools.codex_app__create_thread({title:"Native review"}),tools.codex_app__create_thread({title:"Queued review"})]);text(JSON.stringify({native,queued}));';
  const item={type:'tool-call-activity' as const,id:'batch',name:'exec',input,sessionId:'parent',sourceIdentity:{provider:'codex',sessionId:'parent'}};
  const observation=operationObservationForTool({...item,result:{type:'tool_result',tool_use_id:'batch',content:JSON.stringify({native:'{"threadId":"exact-native"}',queued:'{"clientThreadId":"client-new-thread:exact"}'})}});
  expect(observation.children?.map(child=>({operation:child.operation,targets:child.targets}))).toEqual([
    {operation:'thread-create',targets:[{kind:'thread',provider:'codex',sessionId:'exact-native',labelHint:'Native review'}]},
    {operation:'thread-queue',targets:[{kind:'pending-thread',provider:'codex',clientThreadId:'client-new-thread:exact',labelHint:'Queued review'}]},
  ]);
  const failed=operationObservationForTool({...item,executionEvidence:{state:'failed',provenance:'native-wrapper'},result:{type:'tool_result',tool_use_id:'batch',content:'outer diagnostic',is_error:true}});
  expect(failed.children?.some(child=>child.execution.state==='failed')).toBe(false);
  expect(presentationForObservation(failed).operations?.filter(fact=>fact.outcomeOnly)).toMatchObject([{operation:'batch',state:'failed',count:1}]);
});

it('preserves semantic buckets and phases when operation facts arrive in separate contributions',async()=>{
  const {toolRunFacts,mergeToolRunFacts}=await import('../src/presentation/tool-presentation');
  const tools=[{name:'exec_command',input:{cmd:'pwd'},state:'completed' as const},{name:'functions.exec_command',input:{cmd:'ls'},state:'completed' as const},{name:'exec_command',input:{cmd:'tail'},state:'ongoing' as const}];
  expect(mergeToolRunFacts(toolRunFacts(tools.slice(0,1)),toolRunFacts(tools.slice(1)))).toEqual(toolRunFacts(tools));
});
