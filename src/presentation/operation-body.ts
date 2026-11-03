import type { ToolPresentation } from './tool-presentation.js';
import { toolInputObject } from './tool-presentation.js';
import { operationReceiptTargets } from './operation-registry.js';
import { patchFileChanges, substantiveToolResult, threadWaitBody, type ThreadReport } from './tool-operation.js';
import type { ToolTransportResult } from './tool-transport.js';

type RequestedRun={provider:'codex';model?:string;effort?:string};
export type OperationInputBody=({kind:'none'}|{kind:'unloaded'}|{kind:'prose';text:string}|{kind:'code';text:string;language:'javascript'}|{kind:'native'})&{requested?:RequestedRun};
export type OperationResultBody={kind:'none'}|{kind:'prose';reports:ThreadReport[];residual?:string}|{kind:'native'};
export function operationInputBody(header:ToolPresentation,input:Record<string,unknown>|string|undefined,options:{unloaded?:boolean;unresolvedSource?:string}={}):OperationInputBody {
  if(options.unresolvedSource!==undefined)return {kind:'code',text:options.unresolvedSource,language:'javascript'};
  const object=toolInputObject(input??{});
  if(['thread-create','thread-queue','thread-request'].includes(header.operation??'')) {
    const requested:RequestedRun={provider:'codex',...(typeof object.model==='string'?{model:object.model}:{}),...(typeof object.thinking==='string'?{effort:object.thinking}:typeof object.effort==='string'?{effort:object.effort}:{})};
    return typeof object.prompt==='string'&&object.prompt.trim()?{kind:'prose',text:object.prompt,requested}:options.unloaded?{kind:'unloaded',requested}:{kind:'none',requested};
  }
  if(['thread-read','thread-wait','sleep','tool-discovery','execution-wait','file-delete'].includes(header.operation??''))return {kind:'none'};
  if(options.unloaded&&(input===undefined||input===''||(typeof input==='object'&&!Object.keys(input).length)))return {kind:'unloaded'};
  return input===undefined||input===''||(typeof input==='object'&&!Object.keys(input).length)?{kind:'none'}:{kind:'native'};
}
export function operationResultBody(header:ToolPresentation,result:ToolTransportResult|undefined,input?:Record<string,unknown>|string):OperationResultBody {
  if(!result||!substantiveToolResult(result))return {kind:'none'};
  if(!result.failed&&!result.stderr&&header.resultAttribution!=='opaque') {
    if(['thread-create','thread-queue','thread-request'].includes(header.operation??'')&&operationReceiptTargets(header.operation!,result.text,{}).targets.length)return {kind:'none'};
    if(header.operation==='thread-wait'){const body=threadWaitBody(result.text);if(body)return body.reports.length||body.residual?{kind:'prose',...body}:{kind:'none'};}
    if(header.operation==='file-delete'&&header.outputPolicy==='acknowledgement'&&typeof input==='string'){
      const files=patchFileChanges(input);const acknowledgement='Success. Updated the following files:\n'+files.map(file=>'D '+file.filePath).join('\n');
      if(files.length&&files.every(file=>file.kind==='delete')&&result.text.trim()===acknowledgement)return {kind:'none'};
    }
  }
  return {kind:'native'};
}
