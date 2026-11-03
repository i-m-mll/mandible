import { expect, it } from 'vitest';
import { projectToolProgram } from '../src/presentation/tool-program';
import { toolObservation } from '../src/presentation/tool-observation';
import { operationResult, substantiveToolResult, threadReports } from '../src/presentation/tool-operation';
import { rawToolResult } from '../src/presentation/tool-transport';

it('projects complete transparent wrappers while retaining arbitrary computation as source', () => {
  const input={threadId:'exact-provider-thread',hostId:'local'};
  const direct=toolObservation('codex_app__read_thread',input);
  const source=`const result=await tools.codex_app__read_thread(${JSON.stringify(input)});for(const part of (result?.content??[])) part.type==='image'?image(part):text(part.text??part);if(!result?.content)text(result);`;
  const wrapped=toolObservation('functions.exec',source,'custom_tool_call');
  expect(wrapped.header).toEqual(direct.header);
  const media=[{type:'image' as const,source:{type:'base64',media_type:'image/png',data:'aW1hZ2U='}}];
  expect(toolObservation('exec',source,undefined,{text:'',content:media}).result?.content).toEqual(media);
  expect(wrapped.header.threadTargets).toEqual([{type:'session',id:input.threadId}]);
  for(const computation of [source+'text("extra");',source.replace('text(part.text??part)','text(part.text.toUpperCase())'),`text(await tools.codex_app__read_thread(resolveTarget()))`]) {
    expect(projectToolProgram('functions.exec',computation,'custom_tool_call')).toBeNull();
  }
  const discovery='const hits=ALL_TOOLS.filter(tool=>/thread/.test(tool.name+tool.description)).map(tool=>({name:tool.name,description:tool.description}));text(hits);';
  expect(projectToolProgram('functions.exec',discovery)?.operations).toHaveLength(1);
  expect(projectToolProgram('functions.exec',discovery+'await tools.exec_command({cmd:"pwd"})')).toBeNull();
});

it('suppresses only a known empty patch acknowledgement and retains reports, errors and unknown output', () => {
  const patch='*** Begin Patch\n*** Update File: /tmp/example.ts\n@@\n-before\n+after\n*** End Patch';
  const source=`const patch=${JSON.stringify(patch)};text(await tools.apply_patch(patch));`;
  const observation=toolObservation('exec',source,'custom_tool_call',{text:'{}'});
  expect(observation.header.target).toBe('/tmp/example.ts');
  expect(substantiveToolResult(observation.result!)).toBe(false);
  for(const result of [{...rawToolResult('{}'),failed:true},rawToolResult('{"unexpected":"retained"}')]) expect(substantiveToolResult(operationResult(observation.header,result))).toBe(true);
  const report={timedOut:false,polls:[{thread:{id:'child',hostId:'local'},latestAssistantMessage:{phase:'final_answer',text:'Substantive child report'}}]};
  const value=toolObservation('codex_app__wait_threads',{targets:[{threadId:'child',hostId:'local'}]},undefined,{text:JSON.stringify(report)});
  expect(threadReports(value.result!.text)).toMatchObject([{threadId:'child',text:report.polls[0].latestAssistantMessage.text,final:true}]);
  expect(substantiveToolResult(value.result!)).toBe(true);
  expect(threadReports('arbitrary application output')).toBeNull();
  const waiting=toolObservation('codex_app__wait_threads',{targets:[{threadId:'child',hostId:'local'}]},undefined,{text:JSON.stringify({timedOut:true,polls:[]})});
  expect(waiting.header.hasDetails).toBe(false);
  const diagnostic=toolObservation('codex_app__wait_threads',{},undefined,{text:JSON.stringify({timedOut:true,polls:[],error:'retained'})});
  expect(substantiveToolResult(diagnostic.result!)).toBe(true);
});
