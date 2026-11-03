import type { PresentationIcon, ToolCategory } from './tool-presentation.js';
import type { ToolExecutionEvidence } from '../parsers/types.js';

export type OperationDefinition={category:ToolCategory;icon:PresentationIcon;neutral:string;ongoing:string;completed:string;plural:string;neutralPlural:string;ongoingPlural:string;noun:string;outputPolicy?:'thread-wait'|'sleep'};
const definition=(category:ToolCategory,icon:PresentationIcon,noun:string,neutral:string,ongoing:string,completed:string,plural:string,neutralPlural=neutral,ongoingPlural=ongoing):OperationDefinition=>({category,icon,noun,neutral,ongoing,completed,plural,neutralPlural,ongoingPlural});
const operations:Readonly<Record<string,OperationDefinition>>={
  'file-read':definition('read','toolRead','file read','Read file','Reading file','Read a file','Read some files','Read files','Reading files'),
  'file-edit':definition('edit','toolEdit','file edit','Edit file','Editing file','Edited a file','Edited some files','Edit files','Editing files'),
  'file-write':definition('write','toolWrite','file write','Write file','Writing file','Wrote a file','Wrote some files','Write files','Writing files'),
  'file-delete':definition('delete','toolDelete','file removal','Remove file','Removing file','Removed a file','Removed some files','Remove files','Removing files'),
  'file-move':definition('move','toolMove','file move','Move file','Moving file','Moved a file','Moved some files','Move files','Moving files'),
  'web-search':definition('search','toolSearch','web search','Search web','Searching web','Searched web','Searched web'),
  'web-open':definition('browser','toolBrowser','web page opening','Open web page','Opening web page','Opened web page','Opened web pages'),
  'web-click':definition('browser','toolBrowser','web link opening','Open web link','Opening web link','Opened web link','Opened web links'),
  search:definition('search','toolSearch','search','Search','Searching','Searched','Searched several times'),
  'tool-discovery':definition('search','toolSearch','tool check','Check available tools','Checking available tools','Checked available tools','Checked available tools'),
  'project-list':definition('search','toolSearch','project listing','List projects','Listing projects','Listed projects','Listed projects'),
  'thread-list':definition('search','chat','thread listing','List threads','Listing threads','Listed threads','Listed threads'),
  'thread-read':definition('read','chat','thread read','Read thread','Reading thread','Read thread','Read threads','Read threads','Reading threads'),
  'thread-send':definition('other','chat','message','Send message to thread','Sending message to thread','Sent message to thread','Sent messages to threads','Send messages to threads','Sending messages to threads'),
  'thread-request':definition('other','chat','thread request','Create thread','Creating thread','Requested thread','Requested threads','Create threads','Creating threads'),
  'thread-create':definition('other','chat','thread creation','Create thread','Creating thread','Created thread','Created threads','Create threads','Creating threads'),
  'thread-queue':definition('other','chat','thread request','Queue thread','Queuing thread','Queued thread','Queued threads','Queue threads','Queuing threads'),
  'thread-wait':{...definition('wait','history','thread wait','Wait for thread','Waiting for thread','Waited for thread','Waited for threads','Wait for threads','Waiting for threads'),outputPolicy:'thread-wait'},
  'execution-wait':definition('wait','history','execution wait','Wait for execution','Waiting for execution','Waited for execution','Waited for executions','Wait for executions','Waiting for executions'),
  sleep:{...definition('wait','history','wait','Wait','Waiting','Waited','Waited several times'),outputPolicy:'sleep'},
  'subagent-create':definition('other','subagent','subagent creation','Create subagent','Creating subagent','Created subagent','Created subagents','Create subagents','Creating subagents'),
  'subagent-resume':definition('other','subagent','subagent resumption','Resume subagent','Resuming subagent','Resumed subagent','Resumed subagents','Resume subagents','Resuming subagents'),
  'subagent-send':definition('other','subagent','subagent message','Send message to subagent','Sending message to subagent','Sent message to subagent','Sent messages to subagents','Send messages to subagents','Sending messages to subagents'),
  command:definition('execute','toolExecute','command','Run command','Running command','Ran command','Ran several commands','Run commands','Running commands'),
  javascript:definition('javascript','toolJavascript','JavaScript invocation','Run JavaScript','Running JavaScript','Ran JavaScript','Ran JavaScript several times','Run JavaScript','Running JavaScript'),
  batch:definition('other','monitor','batch','Run tools','Running tools','Ran tools','Ran batches','Run batches','Running batches'),
};
export function operationDefinition(operation:string|undefined):OperationDefinition|undefined{return operation?operations[operation]:undefined;}
export function registeredOperation(name:string,input:Record<string,unknown>):string|undefined {
  const normalized=name.trim().toLowerCase().replace(/^functions\./,'');
  if(['web__run','mcp__web__run','web.run'].includes(normalized)){
    const actions=['search_query','image_query','open','click','find','screenshot','finance','weather','sports','time'].filter(key=>Array.isArray(input[key])&&(input[key] as unknown[]).length);
    if(actions.length===1)return actions[0]==='search_query'||actions[0]==='image_query'?'web-search':actions[0]==='open'?'web-open':actions[0]==='click'?'web-click':undefined;
  }
  if(normalized==='__tool_discovery')return 'tool-discovery';
  const app=/^(?:mcp__)?codex_app__(list_projects|list_threads|read_thread|send_message_to_thread|create_thread|wait_threads)$/.exec(normalized);
  if(app)return ({list_projects:'project-list',list_threads:'thread-list',read_thread:'thread-read',send_message_to_thread:'thread-send',create_thread:'thread-create',wait_threads:'thread-wait'} as const)[app[1] as 'list_projects'];
  if(['clock.sleep','clock__sleep','mcp__clock__sleep','sleep'].includes(normalized))return 'sleep';
  if(normalized==='wait')return 'execution-wait';
  if(['spawn_agent','collaboration.spawn_agent'].includes(normalized))return 'subagent-create';
  if(['followup_task','collaboration.followup_task','send_message','collaboration.send_message'].includes(normalized))return 'subagent-send';
  if(['agent','task'].includes(normalized))return typeof input.resume==='string'||typeof input.to==='string'?'subagent-resume':'subagent-create';
  return undefined;
}
export function operationLabel(operation:string|undefined,state:ToolExecutionEvidence['state'],count=1):string|undefined {
  const value=operationDefinition(operation);if(!value)return undefined;
  if(state==='ongoing')return count>1?value.ongoingPlural:value.ongoing;
  if((state==='failed'||state==='cancelled')&&!['command','javascript'].includes(operation??''))return count>1?value.neutralPlural:value.neutral;
  if(state==='unknown')return count>1?value.neutralPlural:value.neutral;
  return count>1?value.plural:value.completed;
}

const nonempty=(value:unknown):value is string=>typeof value==='string'&&Boolean(value.trim());
export function operationInputTargets(operation:string|undefined,input:Record<string,unknown>,scope:{provider?:import('../parsers/types.js').ConversationSource;sessionId?:string}):import('./activity-targets.js').ActivityTarget[] {
  if(['thread-read','thread-send'].includes(operation??''))return nonempty(input.threadId??input.thread_id)?[{kind:'thread',provider:'codex',sessionId:String(input.threadId??input.thread_id)}]:nonempty(input.clientThreadId)?[{kind:'pending-thread',provider:'codex',clientThreadId:input.clientThreadId}]:[];
  if(operation==='thread-wait')return (Array.isArray(input.targets)?input.targets:[]).flatMap(target=>target&&typeof target==='object'&&nonempty(target.threadId)?[{kind:'thread' as const,provider:'codex' as const,sessionId:target.threadId}]:[]);
  if(operation==='subagent-resume'&&scope.provider==='claude_code'&&scope.sessionId&&nonempty(input.resume))return [{kind:'subagent',provider:'claude_code',parentSessionId:scope.sessionId,agentId:input.resume,...(nonempty(input.description)?{labelHint:input.description.slice(0,256)}:{})}];
  return [];
}
export function operationReceiptTargets(operation:string,result:string,scope:{provider?:import('../parsers/types.js').ConversationSource;sessionId?:string},labelHint?:string):{operation:string;targets:import('./activity-targets.js').ActivityTarget[]} {
  let value:unknown;try{value=JSON.parse(result);}catch{return {operation,targets:[]};}
  if(!value||typeof value!=='object'||Array.isArray(value))return {operation,targets:[]};
  const fields=value as Record<string,unknown>,hint=labelHint?{labelHint:labelHint.slice(0,256)}:{};
  if(operation==='thread-create'||operation==='thread-queue'||operation==='thread-request') {
    if(nonempty(fields.threadId))return {operation:'thread-create',targets:[{kind:'thread',provider:'codex',sessionId:fields.threadId,...hint}]};
    if(nonempty(fields.clientThreadId))return {operation:'thread-queue',targets:[{kind:'pending-thread',provider:'codex',clientThreadId:fields.clientThreadId,...hint}]};
  }
  if(operation==='subagent-create'&&scope.provider==='codex'&&scope.sessionId&&nonempty(fields.task_name))return {operation,targets:[{kind:'subagent',provider:'codex',parentSessionId:scope.sessionId,agentId:fields.task_name,...hint}]};
  return {operation,targets:[]};
}

/** Native web receipts carry the resolved page beside the exact request reference. */
export function operationReceiptSubject(operation:string,subject:string|undefined,text:string):string|undefined {
  if(!['web-open','web-click'].includes(operation))return subject;
  const page=/^([^\n]+) \((https?:\/\/[^\n]+)\)\r?\n/.exec(text);
  const source=/Source: (open|click)\((\{[^\n]+?\})\);/.exec(text);
  if(!page||!source||source[1]!==operation.slice(4))return subject;
  let request:unknown;try{request=JSON.parse(source[2]);}catch{return subject;}
  if(!request||typeof request!=='object'||(request as Record<string,unknown>).ref_id!==subject)return subject;
  return page[1]+' ('+page[2]+')';
}
