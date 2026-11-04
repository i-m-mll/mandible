import { operationLabel } from './operation-registry.js';
import type { ToolPresentation } from './tool-presentation.js';
import type { ToolTransportResult } from './tool-transport.js';

/** Patch contents contain only the source context supplied by the patch author. */
export function patchFileChanges(patch: string): Array<{filePath:string;oldString:string;newString:string;kind:'edit'|'write'|'delete'|'move'}> {
  if (!patch.startsWith('*** Begin Patch\n') || !patch.trimEnd().endsWith('*** End Patch')) return [];
  const files:Array<{filePath:string;oldString:string;newString:string;kind:'edit'|'write'|'delete'|'move'}>=[];
  let file: {filePath:string;oldString:string;newString:string;kind:'edit'|'write'|'delete'|'move'}|undefined;
  for(const line of patch.split('\n').slice(1)) {
    const directive=/^\*\*\* (Update|Add|Delete) File: (.+)$/.exec(line);
    if(directive) {file={filePath:directive[2],oldString:'',newString:'',kind:directive[1]==='Add'?'write':directive[1]==='Delete'?'delete':'edit'};files.push(file);continue;}
    if(file && line.startsWith('*** Move to: ')) {file.filePath+=' → '+line.slice(13);file.kind='move';continue;}
    if(line.startsWith('*** ') || line.startsWith('@@') || !file) continue;
    if(line.startsWith('-') || line.startsWith(' ')) file.oldString+=line.slice(1)+'\n';
    if(line.startsWith('+') || line.startsWith(' ')) file.newString+=line.slice(1)+'\n';
  }
  return files;
}

export type OperationState = 'ongoing' | 'completed' | 'failed' | 'cancelled' | 'unknown';
/** Terminal failure/cancellation is more specific than settlement or historical progress. */
export function operationState(evidence:OperationState | undefined,result?:{failed?:boolean;is_error?:boolean},active=false):OperationState {
  if(evidence==='failed' || result?.failed || result?.is_error) return 'failed';
  if(evidence==='cancelled') return 'cancelled';
  return evidence ?? (result ? 'completed' : active ? 'ongoing' : 'unknown');
}
const neutral:Readonly<Record<string,string>>={read:'Read file',edit:'Edit file',write:'Write file',delete:'Remove file',move:'Move file',search:'Search',execute:'Run command',javascript:'Run JavaScript',fetch:'Fetch resource',browser:'Use browser',think:'Think',other:'Use tool'};
const ongoing:Readonly<Record<string,string>>={read:'Reading file',edit:'Editing file',write:'Writing file',delete:'Removing file',move:'Moving file',search:'Searching',execute:'Running command',javascript:'Running JavaScript',fetch:'Fetching resource',browser:'Using browser',think:'Thinking',other:'Using tool'};
export function operationPhrase(header:ToolPresentation,state:OperationState,result?:ToolTransportResult):string {
  const elapsed=result?.wallTimeSeconds ?? header.observation?.elapsedSeconds;
  const duration=elapsed!==undefined && elapsed>0 ? ` ${elapsed} s` : '';
  if(header.operation==='thread-wait') {const reports=result && header.resultAttribution!=='opaque' ? threadReports(result.text) : null;const report=reports?.length ? reports.every(report=>report.final)?'final':'update' : header.observation?.report;if(report) return report==='final' ? 'Received response from thread' : 'Received update from thread';}
  if(header.operation==='thread-wait') {const target=(header.targetCount??header.threadTargets?.length??0)>1?'threads':'thread';return state==='ongoing'?`Waiting for ${target}`:state==='unknown'&&!duration?`Wait for ${target}`:`Waited${duration} for ${target}`;}
  if(header.operation==='execution-wait') return state==='ongoing'?'Waiting for execution':state==='unknown' && !duration?'Wait for execution':`Waited${duration} for execution`;
  if(header.operation==='sleep') return state==='ongoing'?'Waiting':state==='unknown' && !duration?'Wait':`Waited${duration}`;
  if(header.operations?.length)return header.phrase;
  const registered=operationLabel(header.operation,state,Math.max(1,header.targetCount??0));if(registered)return registered;
  if(header.operation==='thread-read') return state==='ongoing'?'Reading thread':state==='unknown'?'Read thread':header.phrase;
  if(header.operation==='tool-discovery') return state==='ongoing'?'Checking available tools':state==='unknown'?'Check available tools':header.phrase;
  if(header.category==='other' && header.phrase.startsWith('Used ')) return state==='ongoing' ? header.phrase.replace(/^Used /,'Using ') : state==='unknown' ? header.phrase.replace(/^Used /,'Use ') : header.phrase;
  return state==='ongoing' ? ongoing[header.category] ?? header.phrase : state==='unknown' ? neutral[header.category] ?? header.phrase : header.phrase;
}
export function operationResult(header:ToolPresentation,result:ToolTransportResult):ToolTransportResult {
  if(!result.failed && !result.stderr && header.outputPolicy==='thread-wait' && emptyThreadWait(result.text) && (!Array.isArray(result.content) || result.content.every(block=>block.type==='text'))) return {...result,text:'',content:undefined};
  if(!result.failed && header.outputPolicy==='acknowledgement' && result.text.trim()==='{}' && !result.stderr && !result.content) return {...result,text:'',wallTimeSeconds:undefined};
  return result;
}
export function substantiveToolResult(result:ToolTransportResult):boolean {
  return Boolean(result.text.trim() || result.stderr?.trim() || result.failed || (Array.isArray(result.content) && result.content.some(block=>block.type!=='text' || block.text.trim())));
}

export type ThreadReport = {threadId:string;hostId?:string;text:string;final:boolean;truncated?:boolean;originalChars?:number};
const record=(value:unknown):value is Record<string,unknown>=>Boolean(value) && typeof value==='object' && !Array.isArray(value);
export type ThreadWaitBody={reports:ThreadReport[];notice?:string;residual?:string};
const extras=(value:Record<string,unknown>,known:readonly string[])=>Object.fromEntries(Object.entries(value).filter(([key,value])=>!known.includes(key)&&value!=null));
/** Decode the provider envelope once; unfamiliar substantive fields remain visible. */
export function threadWaitBody(text:string):ThreadWaitBody|null {
  let value:unknown;try{value=JSON.parse(text);}catch{return null;}
  if(record(value)&&typeof value.message==='string'&&typeof value.timedOut==='boolean'&&Object.keys(value).every(key=>key==='message'||key==='timedOut'))return {reports:[],notice:value.message};
  if(!record(value)||typeof value.timedOut!=='boolean'||!Array.isArray(value.polls))return null;
  const reports:ThreadReport[]=[];
  const residual:unknown[]=[];
  const envelope=extras(value,['timedOut','wake','polls']);if(Object.keys(envelope).length)residual.push(envelope);
  if(value.wake!=null){if(!record(value.wake))return null;const extra=extras(value.wake,['reason','turnId','threadId','hostId']);if(Object.keys(extra).length)residual.push({wake:extra});}
  for(const poll of value.polls){
    if(!record(poll)||!record(poll.thread)||typeof poll.thread.id!=='string')return null;
    const extra=extras(poll,['schemaVersion','cursor','revision','changed','thread','latestTurn','latestAssistantMessageId','latestAssistantMessage','latestToolMarkerId','latestToolMarker','text']);
    const threadExtra=extras(poll.thread,['id','hostId','status']);if(Object.keys(threadExtra).length)extra.thread=threadExtra;
    if(poll.latestTurn!=null){if(!record(poll.latestTurn))return null;const turnExtra=extras(poll.latestTurn,['id','status','startedAt','completedAt','durationMs']);if(turnExtra.error==null)delete turnExtra.error;if(Object.keys(turnExtra).length)extra.latestTurn=turnExtra;}
    if(poll.thread.status!=null){if(!record(poll.thread.status))return null;const statusExtra=extras(poll.thread.status,['type','activeFlags']);if(Object.keys(statusExtra).length)extra.threadStatus=statusExtra;}
    if(poll.latestToolMarker!=null){if(!record(poll.latestToolMarker))return null;const markerExtra=extras(poll.latestToolMarker,['id','turnId','type','name','status']);if(Object.keys(markerExtra).length)extra.latestToolMarker=markerExtra;}
    const message=poll.latestAssistantMessage;
    if(message!=null&&!record(message))return null;
    const body=record(message)?message:poll;
    if(body.text!=null&&typeof body.text!=='string')return null;
    if(typeof body.text==='string'&&body.text.trim())reports.push({threadId:poll.thread.id,...(typeof poll.thread.hostId==='string'?{hostId:poll.thread.hostId}:{}),text:body.text,final:body.phase==='final_answer',...(body.truncated===true?{truncated:true}:{}),...(typeof body.originalChars==='number'?{originalChars:body.originalChars}:{})});
    if(record(message)){const messageExtra=extras(message,['id','turnId','phase','text','truncated','originalChars']);if(Object.keys(messageExtra).length)extra.latestAssistantMessage=messageExtra;}
    if(Object.keys(extra).length)residual.push({threadId:poll.thread.id,...extra});
  }
  return {reports,...(residual.length?{residual:JSON.stringify(residual,null,2)}:{})};
}
export function threadReports(text:string):ThreadReport[]|null{return threadWaitBody(text)?.reports??null;}
function emptyThreadWait(text:string):boolean{const body=threadWaitBody(text);return body!==null&&!body.reports.length&&!body.notice&&!body.residual;}
