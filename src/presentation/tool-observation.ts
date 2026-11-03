import { extractToolResultText } from './model.js';
import { operationDefinition, operationInputTargets, operationReceiptTargets } from './operation-registry.js';
import type { ToolResultContent } from './types.js';
import { compactOperationObservation, type OperationObservation, type CompactOperationObservation } from './operation-observation.js';
import type { ToolCallActivity } from './types.js';
import { activityTargetKey, type ActivityTarget } from './activity-targets.js';
import { presentTool, toolInputObject, toolRunFacts, summarizeToolRunFacts, type ToolPresentation } from './tool-presentation.js';
import { projectToolProgram } from './tool-program.js';
import { projectExecution } from './execution-presentation.js';
import { framedToolResult, programResults, projectToolResult, type NativeResultFrame, type ToolTransportResult } from './tool-transport.js';
import { operationResult, substantiveToolResult, threadReports } from './tool-operation.js';

/** Direct calls and fully recognized one-operation wrappers share the same operation. */
export function toolObservation(name:string,input:Record<string,unknown> | string = {},kind?:string,
  result?:{text:string;content?:ToolResultContent;frame?:NativeResultFrame;native?:ToolTransportResult;failed?:boolean;unloaded?:boolean},header?:ToolPresentation) {
  const program=projectToolProgram(name,input,kind);
  if(program?.operations.length===1&&program.effectsComplete!==false) {
    const operation=program.operations[0];
    const presentation:ToolPresentation={...presentTool(operation.name,operation.input),...(program.outputAttributed===false?{resultAttribution:'opaque',outputPolicy:undefined}:{})};
    const framed=result ? framedToolResult(result.text,result.frame) : undefined;
    const decoded=result?.native?.decoded ? result.native : framed ? programResults(program,framed.text)?.[0] : undefined;
    const media=framed && !framed.decoded && Array.isArray(result?.content) && result.content.some(block=>block.type==='image') ? result.content : undefined;
    const projected=framed ? operationResult(presentation,{...framed,...decoded,...(media && !decoded?.content ? {content:media}:{}),wallTimeSeconds:decoded?.wallTimeSeconds ?? framed.wallTimeSeconds,failed:Boolean(result?.failed || framed.failed || decoded?.failed)}) : undefined;
    return {name:operation.name,input:operation.input,kind:undefined,result:projected,header:observedHeader(presentation,projected,result?.unloaded)};
  }
  const presentation=header ?? presentTool(name,input,kind);
  const transport=result ? projectToolResult(projectExecution(name,input,kind),result.text,result.frame,result.native,program) : undefined;
  const projected=transport ? operationResult(presentation,{...transport,failed:Boolean(result?.failed || transport.failed)}) : undefined;
  return {name,input,kind,header:observedHeader(presentation,projected,result?.unloaded),result:projected};
}

function observedHeader(header:ToolPresentation,result?:ToolTransportResult,unloaded=false):ToolPresentation {
  if(unloaded || (!result && header.hasDetails!==undefined)) return header;
  const reports=result && header.resultAttribution!=='opaque' && header.operation==='thread-wait' ? threadReports(result.text) : null;
  return {...header,hasDetails:header.resultAttribution==='opaque' || !['thread-read','thread-wait','sleep','tool-discovery','execution-wait'].includes(header.operation ?? '') || Boolean(result && substantiveToolResult(result)),
    ...(result ? {observation:{...(result.wallTimeSeconds!==undefined ? {elapsedSeconds:result.wallTimeSeconds}:{}),...(reports?.length ? {report:reports.every(report=>report.final)?'final' as const:'update' as const}:{})}} : {})};
}

export function operationObservationForTool(item:ToolCallActivity):CompactOperationObservation {
  if(item.observation)return item.observation;
  const context=item.operationContext??item.result?.source?.toolOperation;
  const input=context?.input;
  const value=typeof input==='string'||(input&&typeof input==='object'&&!Array.isArray(input))?input as Record<string,unknown>|string:item.input;
  const name=context?.name??item.name,kind=context?.kind??item.toolKind;
  const result=item.result;
  const observation=toolObservation(name,value,kind,result?{text:result.fullText??extractToolResultText(result.content),content:result.content,frame:result.source?.toolFrame,native:result.presentation,failed:result.is_error}:undefined,item.header);
  const header=observation.header;
  const execution=item.executionEvidence??result?.source?.toolExecution??{state:result?(result.is_error||observation.result?.failed?'failed':'completed'):'unknown',provenance:result?'paired-result':'provider-item'};
  const native=projectToolProgram(name,value,kind);
  const object=toolInputObject(observation.input??{});
  const scope={provider:item.sourceIdentity?.provider as import('../parsers/types.js').ConversationSource|undefined,sessionId:item.sourceIdentity?.sessionId??item.sessionId};
  if(!scope.provider&&['spawn_agent','collaboration.spawn_agent'].includes(name))scope.provider='codex';
  const semantic=item.callSource?.toolOperationKind??result?.source?.toolOperationKind??header.operation??header.category;
  const subject=typeof object.title==='string'?object.title:typeof object.task_name==='string'?object.task_name:header.target;
  const receipt=observation.result&&header.resultAttribution!=='opaque'?operationReceiptTargets(semantic,observation.result.text,scope,subject):{operation:semantic,targets:[]};
  const results=native&&result?programResults(native,framedToolResult(result.fullText??extractToolResultText(result.content),result.source?.toolFrame).text):null;
  const children=native&&(native.operations.length>1||native.effectsComplete===false)?native.operations.map((operation,index)=>operationObservationForTool({type:'tool-call-activity',id:item.id+':'+index,name:operation.name,input:operation.input,result:results?.[index]?{type:'tool_result',tool_use_id:'',content:results[index].text,presentation:results[index],is_error:results[index].failed}:null,sessionId:item.sessionId,sourceIdentity:item.sourceIdentity,
    executionEvidence:{state:results?.[index]?results[index].failed?'failed':results[index].running?'unknown':'completed':execution.state==='completed'&&native.effectsComplete!==false&&!operation.settled?'completed':'unknown',provenance:results?.[index]?'paired-result':execution.provenance}})):undefined;
  return compactOperationObservation({operation:children?native?.effectsComplete===false?'javascript':'batch':semantic==='thread-create'&&execution.state==='completed'&&!receipt.targets.length?'thread-request':receipt.operation,nativeName:observation.name,
    ...(subject&&!['execute','javascript'].includes(header.category)?{subject:subject.slice(0,256)}:{}),
    targets:[...(item.callSource?.toolTargets??[]),...operationInputTargets(semantic,object,scope),...receipt.targets,...(semantic==='thread-wait'&&header.resultAttribution!=='opaque'&&observation.result?(threadReports(observation.result.text)??[]).map(report=>({kind:'thread' as const,provider:'codex' as const,sessionId:report.threadId})):[]),...(result?.source?.toolTargets??[]),...(header.threadTargets??[]).filter(target=>target.type==='session').map(target=>({kind:'thread' as const,provider:'codex' as const,sessionId:target.id}))].filter((target,index,all)=>all.findIndex(other=>activityTargetKey(other)===activityTargetKey(target))===index),
    execution:observation.result?.failed||result?.is_error?{...execution,state:'failed'}:execution,payload:{state:header.hasDetails===false?'none':'unloaded'},
    ...(header.observation?.elapsedSeconds===undefined?{}:{timing:{elapsedSeconds:header.observation.elapsedSeconds,scope:observation.result?.timingScope??'wrapper'}}),
    ...(header.resultAttribution==='opaque'?{resultAttribution:'opaque' as const}:{}),
    ...(header.observation?.report?{reportKind:header.observation.report}:{}),...(children?{children}:{})});
}

export function presentationForObservation(observation:OperationObservation,kind?:string):ToolPresentation {
  const names:Record<string,string>={'tool-discovery':'__tool_discovery','thread-read':'codex_app__read_thread','thread-wait':'codex_app__wait_threads','execution-wait':'wait',sleep:'clock__sleep',command:'exec_command',javascript:'js','file-read':'Read','file-edit':'Edit','file-write':'Write','file-delete':'Delete','file-move':'Move'};
  const definition=operationDefinition(observation.operation);
  const base=presentTool(observation.operation==='javascript'?'js':observation.nativeName??names[observation.operation]??'tool',{},kind);
  const children=observation.children?.map(child=>({name:child.nativeName??'tool',header:presentationForObservation(child),state:child.execution.state}));
  const operations=children?toolRunFacts([...children.map(child=>({name:child.name,header:child.header,state:child.state})),...(observation.operation==='javascript'?[{name:'js'}]:[])]):undefined;
  if(operations&&['failed','cancelled'].includes(observation.execution.state)&&!observation.children?.some(child=>child.execution.state===observation.execution.state))operations.push({operation:observation.operation==='javascript'?'javascript':'batch',category:base.category,presentation:{...base,operation:observation.operation==='javascript'?'javascript':'batch'},count:1,names:[observation.nativeName??''],state:observation.execution.state,outcomeOnly:true});
  const summary=operations?summarizeToolRunFacts(operations).join('; '):undefined;
  return {...base,...(definition?{category:definition.category,icon:definition.icon,phrase:definition.completed,outputPolicy:definition.outputPolicy}:{}),...(observation.resultAttribution?{resultAttribution:observation.resultAttribution,outputPolicy:undefined}:{}),operation:observation.operation,targetCount:observation.targets.length,target:['thread-create','thread-queue','subagent-create','subagent-resume'].includes(observation.operation)?'':observation.subject??'',hasDetails:observation.payload.state!=='none',
    threadTargets:observation.targets.filter((target):target is Extract<ActivityTarget,{kind:'thread'}>=>target.kind==='thread').map(target=>({type:'session',id:target.sessionId})),
    observation:{...(observation.timing?{elapsedSeconds:observation.timing.elapsedSeconds}:{}),...(observation.reportKind?{report:observation.reportKind}:{})},
    ...(summary?{phrase:summary.charAt(0).toUpperCase()+summary.slice(1),operations,children}:{}),
    ...(observation.operation==='command'?{execution:{kind:'command',count:1,shells:[null],forwarding:['direct']}}:{})};
}

export type OperationReceipt={scope?:{provider:import('../parsers/types.js').ConversationSource;sessionId:string};targets?:ActivityTarget[];result:ToolTransportResult;execution?:import('../parsers/types.js').ToolExecutionEvidence};
export function mergeOperationExecution(current:import('../parsers/types.js').ToolExecutionEvidence,incoming:import('../parsers/types.js').ToolExecutionEvidence|undefined,failed=false):import('../parsers/types.js').ToolExecutionEvidence {
  if(failed||incoming?.state==='failed')return {state:'failed',provenance:incoming?.provenance??'paired-result'};
  if(current.state==='failed'||current.state==='cancelled')return current;
  if(incoming?.state==='cancelled')return incoming;
  if(current.state==='completed')return current;
  return incoming??{state:'completed',provenance:'paired-result'};
}
/** A native receipt enriches known operation facts without inventing child attribution. */
export function observeOperationReceipt(current:CompactOperationObservation,receipt:OperationReceipt):CompactOperationObservation {
  const header=presentationForObservation(current);
  const result=operationResult(header,receipt.result);
  const reports=current.operation==='thread-wait'&&current.resultAttribution!=='opaque'?threadReports(result.text):null;
  const receiptFacts=current.resultAttribution==='opaque'?{operation:current.operation,targets:[]}:operationReceiptTargets(current.operation,result.text,receipt.scope??{},current.subject);
  const targets=[...current.targets,...receiptFacts.targets,...(receipt.targets??[]),...(reports??[]).map(report=>({kind:'thread' as const,provider:'codex' as const,sessionId:report.threadId}))];
  const uniqueTargets=new Map<string,ActivityTarget>();for(const target of targets)if(!uniqueTargets.has(activityTargetKey(target)))uniqueTargets.set(activityTargetKey(target),target);
  return {...current,operation:receiptFacts.operation,execution:mergeOperationExecution(current.execution,receipt.execution,result.failed),
    payload:{state:current.payload.state==='unloaded'||substantiveToolResult(result)?'unloaded':'none'},
    targets:[...uniqueTargets.values()],
    ...(result.wallTimeSeconds===undefined?{}:{timing:{elapsedSeconds:result.wallTimeSeconds,scope:result.timingScope??'operation'}}),
    ...(reports?.length?{reportKind:reports.every(report=>report.final)?'final':'update'}:{})};
}
