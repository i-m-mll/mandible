// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { render, cleanup } from './helpers/dom';
import { afterEach } from 'vitest';
import { projectExecution, projectExecutionResult } from '../src/presentation/execution-presentation';
import { ToolUseBlock } from '../ui/src/components/message-blocks/ToolUseBlock';
import { activityRunFacts, presentActivityRunFacts } from '../src/presentation/activity-presentation';
import { indexDisplayFragments } from '../src/conversations/display-indexing';
import { readDisplayContext } from '../src/conversations/display-context-read';
import { ConversationSourceReader } from '../src/conversations/source-reader';
import { migratedMemoryDb } from './helpers/ledger-fixtures';
import { CodexParser } from '../src/parsers/codex';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const command = 'printf "<hello>\\nworld\\n"';
const script = `const r = await tools.exec_command({cmd:${JSON.stringify(command)},shell:"/bin/zsh",max_output_tokens:20000}); text(r)\n`;
const envelope = {chunk_id:'c1b072',wall_time_seconds:0.000003041,exit_code:0,original_token_count:564,output:'<hello>\nworld\n'};
const result = `Script completed\nWall time 0.1 seconds\nOutput:\n\n${JSON.stringify(envelope)}`;
afterEach(cleanup);

it('unwraps only fully accounted literal wrappers and retains substantive or dynamic JavaScript', () => {
  expect(projectExecution('exec', script)?.operations).toEqual([{command, shell:'/bin/zsh', forwarding:'result'}]);
  expect(projectExecution('exec', 'text((await tools.exec_command({cmd:`echo literal`})).output)')?.operations).toEqual([{command:'echo literal',forwarding:'stdout'}]);
  const many = `${script}text(await tools.exec_command({cmd:'pwd'}))`;
  expect(projectExecution('exec', many)?.facts).toMatchObject({kind:'command',count:2});
  for (const substantive of [
    `const cmd = 'pwd'; text(await tools.exec_command({cmd}))`,
    `text(await tools.exec_command({cmd:\`echo \${name}\`}))`,
    `if (ready) { ${script} }`, `${script}text('extra')`,
    `const r = await tools.exec_command({cmd:'pwd'}); r.output='changed';text(r)`,
    `text(await tools.exec_command({cmd:'pwd',workdir:locate()}))`,
  ]) expect(projectExecution('exec', substantive)).toMatchObject({facts:{kind:'script'}, script:substantive, operations:[]});
  expect(projectExecution('unrelated_tool', script)).toBeNull();
});

it('decodes a proven envelope once and leaves malformed, mixed and already-forwarded stdout literal', () => {
  const execution = projectExecution('exec', script);
  expect(projectExecutionResult(execution,result)).toMatchObject({text:'<hello>\nworld\n',wallTimeSeconds:0.000003041,decoded:true,failed:false});
  const jsonStdout = JSON.stringify({...envelope,output:'{"output":"do not parse"}'});
  expect(projectExecutionResult(execution,jsonStdout).text).toBe('{"output":"do not parse"}');
  const stdout = projectExecution('exec',script.replace('text(r)','text(r.output)'));
  expect(projectExecutionResult(stdout,jsonStdout)).toMatchObject({text:jsonStdout,decoded:false});
  for (const value of [result.slice(0,-8),`warning: truncated\n${result}`,`${result}\nextra`,JSON.stringify({...envelope,new_state:'unknown'})]) {
    expect(projectExecutionResult(execution,value)).toMatchObject({text:value,decoded:false});
  }
  expect(projectExecutionResult(execution,JSON.stringify({...envelope,exit_code:7}))).toMatchObject({failed:true});
  expect(projectExecutionResult(execution,JSON.stringify({...envelope,exit_code:null,session_id:123}))).toMatchObject({running:true,metadata:expect.arrayContaining([{label:'session_id',value:'123'}])});
  expect(projectExecutionResult(projectExecution('exec',`${script}${'text(await tools.exec_command({cmd:"pwd"}))'}`), result).decoded).toBe(false);
});

it('renders source-owned output, exact highlighted command and inner timing without interpreting stdout markup', () => {
  const view=render(<ToolUseBlock toolName="exec" toolKind="custom_tool_call" input={script} expanded result={{type:'tool_result',tool_use_id:'call',content:result,source:{blockId:'cblk:chat:2'},truncated:true,omittedCharacters:42}} />);
  expect(view.container.querySelector('.compact-activity__summary')?.textContent).toBe('Ran command');
  const code=view.container.querySelector('code')!;
  expect(code.textContent).toBe(command);
  expect(code.querySelector('span')).not.toBeNull();
  expect(view.container.querySelector('.tool-card__terminal-output')?.textContent).toBe('<hello>\nworld\n');
  expect(view.container.querySelector('hello')).toBeNull();
  expect(view.container.querySelector('[data-block-id="cblk:chat:2"]')?.textContent).toContain('0.000003041 s');
  expect(view.container.textContent).toContain('42 chars hidden');
  expect(view.container.textContent).not.toContain('Wall time 0.1');
});

it('derives compact command facts from saved native wrappers without retaining bodies, with matching live summaries', async () => {
  const root=mkdtempSync(join(tmpdir(),'mandible-execution-'));
  try {
    const file=join(root,'chat.jsonl');
    writeFileSync(file,[
      {type:'session_meta',payload:{id:'exec-test',cwd:'/tmp'}},
      {type:'response_item',payload:{type:'custom_tool_call',call_id:'call',name:'exec',input:script}},
      {type:'response_item',payload:{type:'custom_tool_call_output',call_id:'call',output:[{type:'input_text',text:'Script completed\nWall time 0.1 seconds\nOutput:\n'},{type:'input_text',text:JSON.stringify(envelope)}]}},
      {type:'response_item',payload:{type:'function_call',call_id:'read',name:'read',arguments:'{"file_path":"/tmp/file"}'}},
    ].map(row=>JSON.stringify(row)).join('\n')+'\n');
    const parsed=await new CodexParser().parse(file);
    expect(parsed).not.toBeNull();
    expect(parsed!.blocks[1].content).toBe('Script completed\nWall time 0.1 seconds\nOutput:\n\n'+JSON.stringify(envelope));
    expect(parsed!.blocks[1].metadata.display_tool_frame).toMatchObject({kind:'codex-script',timingScope:'wrapper',wallTimeSeconds:0.1});
    const indexed=indexDisplayFragments(parsed!.blocks,'conversation',position=>position===1?0:null);
    expect(projectExecutionResult(projectExecution('exec',script), parsed!.blocks[1].content)).toMatchObject({text:envelope.output,decoded:true});
    const db=migratedMemoryDb();
    try {
      const context=await readDisplayContext({conversationId:'conversation',sourceVersionId:'version',blockCount:parsed!.blocks.length,
        reader:new ConversationSourceReader(db),actionScope:()=>({start:0,end:2}),
        plan:{fragments:indexed.fragments, aliases:[], runs:new Map([['run',indexed.fragments]]),ownerFragments:[indexed.fragments[0]],sourcePositions:[0]},
        sourceBlocks:parsed!.blocks.map(block=>({...block,id:`cblk:conversation:${block.position}`,conversation_id:'conversation',metadata_json:JSON.stringify(block.metadata),
          dag_uuid:block.dag_uuid??null,dag_parent_uuid:null,locator:null}))});
      expect(context.status).toBe('source');
      if(context.status==='source') {
        expect(context.value.owners[0]).toMatchObject({coordinate:{position:0},header:{target:command,category:'execute'},action_scope:{start:0,end:2}});
        expect(context.value.owners[0].item).not.toHaveProperty('input');
        expect(context.value.activity_runs[0].presentation.summary).toBe('Ran command; read a file');
      }
    } finally {db.close();}
    const compact=indexed.fragments.flatMap(fragment=>fragment.activity?[fragment.activity]:[]);
    expect(JSON.stringify(compact)).not.toContain('printf');
    expect(JSON.stringify(compact)).not.toContain('hello');
    const facts=activityRunFacts(compact);
    expect(presentActivityRunFacts(facts).summary).toBe('Ran command; read a file');
    expect(facts.tools[0]).toMatchObject({category:'execute',count:1,presentation:{execution:{kind:'command',shells:['/bin/zsh'],forwarding:['result']}}});
    const live=activityRunFacts([{type:'tool-call-activity',id:'call',name:'exec',toolKind:'custom_tool_call',input:script,result:null,sessionId:'exec-test'},...compact.slice(1)]);
    expect(presentActivityRunFacts(live).summary).toBe(presentActivityRunFacts(facts).summary);
  } finally {rmSync(root,{recursive:true,force:true});}
});

it('colors generic shell commands without changing text or guessing an unsupported explicit shell', () => {
  const input={cmd:command};
  const generic=render(<ToolUseBlock toolName="exec_command" input={input} expanded />);
  const genericCode=generic.container.querySelector('code')!;
  expect(genericCode.textContent).toBe(command);
  expect(genericCode.querySelector('span')).not.toBeNull();
  generic.unmount();
  const explicit=render(<ToolUseBlock toolName="exec_command" input={{...input,shell:'/custom/interpreter'}} expanded />);
  const explicitCode=explicit.container.querySelector('code')!;
  expect(explicitCode.textContent).toBe(command);
  expect(explicitCode.querySelector('span')).toBeNull();
  expect(projectExecution('exec_command',{...input,shell:'/custom/interpreter'})?.facts).toMatchObject({shells:['/custom/interpreter']});
});

it('pairs an indexed static command batch atomically and preserves rejected or unavailable correspondence', async () => {
  const {projectToolProgram}=await import('../src/presentation/tool-program');
  const {programResults}=await import('../src/presentation/tool-transport');
  const batch='const r=await Promise.all([tools.exec_command({cmd:"printf one"}),tools.exec_command({cmd:"printf two"})]);r.forEach((x,i)=>text(JSON.stringify({i,...x})));';
  const program=projectToolProgram('exec',batch)!;
  const output=[{i:0,...envelope,output:'one\n'},{i:1,...envelope,wall_time_seconds:0.25,output:'two\n',exit_code:4}].map(value=>JSON.stringify(value)).join('\n');
  const view=render(<ToolUseBlock toolName="exec" input={batch} expanded result={{type:'tool_result',tool_use_id:'native',content:output,source:{blockId:'cblk:batch:5'}}} />);
  expect([...view.container.querySelectorAll('.tool-card__terminal code')].map(node=>node.textContent)).toEqual(['printf one','printf two']);
  expect([...view.container.querySelectorAll('.tool-card__terminal-output')].map(node=>node.textContent)).toEqual(['one\n','two\n']);
  expect(view.container.querySelector('[data-block-id="cblk:batch:5"]')).not.toBeNull();
  expect(view.container.querySelector('[data-block-id="cblk:batch:6"]')).toBeNull();
  expect(view.container.textContent).toContain('0.25 s');
  expect(view.container.textContent).toContain('Failed');
  for(const malformed of [output.replace('"i":1','"i":0'),output.replace('"i":1','"i":9'),output.slice(0,-5),output+'\nwarning: truncated']) expect(programResults(program,malformed)).toBeNull();
  const settled=projectToolProgram('exec',batch.replace('Promise.all(','Promise.allSettled(').replace('{i,...x}','{i,result:x}'))!;
  expect(programResults(settled,[{i:0,result:{status:'fulfilled',value:envelope}},{i:1,result:{status:'rejected',reason:'denied'}}].map(value=>JSON.stringify(value)).join('\n'))?.map(result=>[result.failed,result.text])).toEqual([[false,envelope.output],[true,'denied']]);
  const direct=projectToolProgram('exec','text(await Promise.all([tools.exec_command({cmd:"one"}),tools.exec_command({cmd:"two"})]))')!;
  expect(programResults(direct,JSON.stringify([envelope,{...envelope,output:'second'}]))?.map(result=>result.text)).toEqual([envelope.output,'second']);
});

it('uses existing edit and command presenters for mixed wrappers and keeps compact facts body-free', async () => {
  const {toolRunFacts,summarizeToolRunFacts}=await import('../src/presentation/tool-presentation');
  const mixed='const results=await Promise.all([tools.exec_command({cmd:"echo secret-command"}),tools.Edit({file_path:"/private/example.ts",old_string:"before",new_string:"after"})]);results.forEach((value,index)=>text(JSON.stringify({index,result:value})));';
  const output=[{index:0,result:envelope},{index:1,result:{content:[{type:'text',text:'application content'}]}}].map(value=>JSON.stringify(value)).join('\n');
  const view=render(<ToolUseBlock toolName="exec" input={mixed} expanded result={{type:'tool_result',tool_use_id:'native',content:output}} />);
  expect(view.container.querySelector('.tool-card__terminal code')?.textContent).toBe('echo secret-command');
  expect(view.container.textContent).toContain('before');
  expect(view.container.textContent).toContain('after');
  expect(view.container.textContent).toContain('application content');
  expect(view.container.textContent).toContain('\"content\":');
  const facts=toolRunFacts([{name:'exec',input:mixed}]);
  expect(summarizeToolRunFacts(facts)).toEqual(['ran command','edited a file']);
  expect(JSON.stringify(facts)).not.toMatch(/secret-command|private\/example|before|after/);
  expect(projectExecution('exec',mixed+'text("extra")')?.facts.kind).toBe('script');
});

it('removes only source-proven native framing from stdout and retains a literal imitation inside the payload', async () => {
  const {codexResultFrame,framedToolResult}=await import('../src/presentation/tool-transport');
  const {normalizedPositionIdentity}=await import('../src/conversations/position-space');
  const prefix='Script completed\nWall time 0.1 seconds\nOutput:\n';
  const stdout='total=46 codex=14 named=32\n'+prefix;
  const native=[{type:'input_text',text:prefix},{type:'input_text',text:stdout}];
  const text=native.map(part=>part.text).join('\n');
  const frame=codexResultFrame(native)!;
  expect(framedToolResult(text,frame)).toMatchObject({text:stdout,wallTimeSeconds:0.1,timingScope:'wrapper'});
  expect(framedToolResult(text)).toMatchObject({text,decoded:false});
  expect(codexResultFrame([{type:'input_text',text}])).toBeUndefined();
  const view=render(<ToolUseBlock toolName="exec" input='const r=await tools.exec_command({cmd:"git worktree list --porcelain | awk ..."});text(r.output);' expanded result={{type:'tool_result',tool_use_id:'native',content:text,source:{blockId:'native-result',toolFrame:frame}}} />);
  expect(view.container.querySelector('.tool-card__terminal-output')?.textContent).toBe(stdout);
  expect(view.container.textContent).toContain('0.1 s');
  const block={type:'tool_result' as const,role:'tool' as const,content:text,position:1,parent_id:'0',metadata:{tool_kind:'custom_tool_call_output'}};
  expect(normalizedPositionIdentity({...block,metadata:{...block.metadata,display_tool_frame:frame}})).toBe(normalizedPositionIdentity(block));
});

it('normalizes native MCP, dynamic and Gemini result contracts while preserving application JSON and media', async () => {
  const {projectNativeToolResult}=await import('../src/presentation/tool-transport');
  const mcp={content:[{type:'text',text:'{"output":"literal application JSON"}'},{type:'image',mimeType:'image/png',data:'aW1hZ2U='}],structuredContent:{remaining:3},_meta:null};
  expect(projectNativeToolResult(mcp,'','mcpToolCall')).toMatchObject({decoded:true,text:'{"output":"literal application JSON"}\n{\n  "remaining": 3\n}',content:expect.arrayContaining([{type:'image',source:{type:'base64',media_type:'image/png',data:'aW1hZ2U='}}])});
  expect(projectNativeToolResult(mcp,'','claude_tool_result').decoded).toBe(false);
  expect(projectNativeToolResult([{type:'inputText',text:'native dynamic'},{type:'inputImage',imageUrl:'data:image/png;base64,aW1hZ2U='}],'','dynamicToolCall')).toMatchObject({text:'native dynamic',decoded:true});
  const gemini=[{functionResponse:{id:'shell',name:'run_shell_command',response:{output:'Output: hello\nProcess Group PGID: 123'}}}];
  expect(projectNativeToolResult(JSON.stringify(gemini),'','gemini_tool_result','run_shell_command','shell')).toMatchObject({text:'hello\nProcess Group PGID: 123',decoded:true});
  expect(projectNativeToolResult(JSON.stringify(gemini),'','gemini_tool_result','other','shell').decoded).toBe(false);
  expect(projectExecution('run_shell_command',{command:'printf hello',description:'A descriptive phrase'})?.operations).toEqual([{command:'printf hello',forwarding:'direct'}]);
  expect(projectExecution('command','printf live','commandExecution')?.operations).toEqual([{command:'printf live',forwarding:'direct'}]);
});
