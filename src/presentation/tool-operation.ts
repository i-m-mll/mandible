import type { ToolPresentation } from './tool-presentation.js';
import type { ToolTransportResult } from './tool-transport.js';

/** Patch contents contain only the source context supplied by the patch author. */
export function patchFileChanges(patch: string): Array<{filePath:string;oldString:string;newString:string}> {
  if (!patch.startsWith('*** Begin Patch\n') || !patch.trimEnd().endsWith('*** End Patch')) return [];
  const files:Array<{filePath:string;oldString:string;newString:string}>=[];
  let file: {filePath:string;oldString:string;newString:string}|undefined;
  for(const line of patch.split('\n').slice(1)) {
    const directive=/^\*\*\* (Update|Add|Delete) File: (.+)$/.exec(line);
    if(directive) {file={filePath:directive[2],oldString:'',newString:''};files.push(file);continue;}
    if(line.startsWith('*** ') || line.startsWith('@@') || !file) continue;
    if(line.startsWith('-') || line.startsWith(' ')) file.oldString+=line.slice(1)+'\n';
    if(line.startsWith('+') || line.startsWith(' ')) file.newString+=line.slice(1)+'\n';
  }
  return files;
}

export type OperationState = 'ongoing' | 'completed' | 'failed' | 'cancelled' | 'unknown';
const neutral:Readonly<Record<string,string>>={read:'Read file',edit:'Edit file',write:'Write file',delete:'Remove file',move:'Move file',search:'Search',execute:'Run command',javascript:'Run JavaScript',fetch:'Fetch resource',browser:'Use browser',think:'Think',other:'Use tool'};
const ongoing:Readonly<Record<string,string>>={read:'Reading file',edit:'Editing file',write:'Writing file',delete:'Removing file',move:'Moving file',search:'Searching',execute:'Running command',javascript:'Running JavaScript',fetch:'Fetching resource',browser:'Using browser',think:'Thinking',other:'Using tool'};
export function operationPhrase(header:ToolPresentation,state:OperationState,result?:ToolTransportResult):string {
  const elapsed=result?.wallTimeSeconds ?? header.observation?.elapsedSeconds;
  const duration=elapsed!==undefined && elapsed>0 ? ` ${elapsed} s` : '';
  if(header.operation==='thread-wait') {const reports=result ? threadReports(result.text) : null;const report=reports?.length ? reports.every(report=>report.final)?'final':'update' : header.observation?.report;if(report) return report==='final' ? 'Received response from thread' : 'Received update from thread';}
  if(header.operation==='thread-wait') return state==='ongoing'?'Waiting for thread':state==='unknown' && !duration?'Wait for thread':`Waited${duration} for thread`;
  if(header.operation==='execution-wait') return state==='ongoing'?'Waiting for execution':state==='unknown' && !duration?'Wait for execution':`Waited${duration} for execution`;
  if(header.operation==='sleep') return state==='ongoing'?'Waiting':state==='unknown' && !duration?'Wait':`Waited${duration}`;
  if(header.operation==='thread-read') return state==='ongoing'?'Reading thread':state==='unknown'?'Read thread':header.phrase;
  if(header.operation==='tool-discovery') return state==='ongoing'?'Checking available tools':state==='unknown'?'Check available tools':header.phrase;
  if(header.category==='other' && header.phrase.startsWith('Used ')) return state==='ongoing' ? header.phrase.replace(/^Used /,'Using ') : state==='unknown' ? header.phrase.replace(/^Used /,'Use ') : header.phrase;
  return state==='ongoing' ? ongoing[header.category] ?? header.phrase : state==='unknown' ? neutral[header.category] ?? header.phrase : header.phrase;
}
export function operationResult(header:ToolPresentation,result:ToolTransportResult):ToolTransportResult {
  if(!result.failed && header.outputPolicy==='acknowledgement' && result.text.trim()==='{}' && !result.stderr && !result.content) return {...result,text:'',wallTimeSeconds:undefined};
  return result;
}
export function substantiveToolResult(result:ToolTransportResult):boolean {
  return Boolean(result.text.trim() || result.stderr?.trim() || result.failed || (Array.isArray(result.content) && result.content.some(block=>block.type!=='text' || block.text.trim())));
}

export type ThreadReport = {threadId:string;hostId?:string;text:string;final:boolean};
/** Only the native thread-wait report envelope identifies a returned child report. */
export function threadReports(text:string):ThreadReport[] | null {
  let value:unknown;
  try {value=JSON.parse(text);} catch{return null;}
  if(!value || typeof value!=='object' || Array.isArray(value)) return null;
  const envelope=value as Record<string,unknown>;
  if(typeof envelope.timedOut!=='boolean' || !Array.isArray(envelope.polls) || envelope.error!=null) return null;
  const reports:ThreadReport[]=[];
  for(const entry of envelope.polls) {
    if(!entry || typeof entry!=='object') return null;
    const poll=entry as Record<string,unknown>;
    const turn=poll.latestTurn;
    if(poll.error!=null || (turn && typeof turn==='object' && (turn as Record<string,unknown>).error!=null)) return null;
    const message=poll.latestAssistantMessage;
    const thread=poll.thread;
    if(!message) continue;
    if(typeof message!=='object' || !thread || typeof thread!=='object') return null;
    const body=message as Record<string,unknown>;
    const target=thread as Record<string,unknown>;
    if(typeof body.text!=='string' || typeof target.id!=='string') return null;
    if(body.text.trim()) reports.push({threadId:target.id,...(typeof target.hostId==='string'?{hostId:target.hostId}:{}),text:body.text,final:body.phase==='final_answer'});
  }
  return reports;
}
