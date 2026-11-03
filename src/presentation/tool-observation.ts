import type { ToolResultContent } from './types.js';
import { presentTool, type ToolPresentation } from './tool-presentation.js';
import { projectToolProgram } from './tool-program.js';
import { projectExecution } from './execution-presentation.js';
import { framedToolResult, programResults, projectToolResult, type NativeResultFrame, type ToolTransportResult } from './tool-transport.js';
import { operationResult, substantiveToolResult, threadReports } from './tool-operation.js';

/** Direct calls and fully recognized one-operation wrappers share the same operation. */
export function toolObservation(name:string,input:Record<string,unknown> | string = {},kind?:string,
  result?:{text:string;content?:ToolResultContent;frame?:NativeResultFrame;native?:ToolTransportResult;failed?:boolean},header?:ToolPresentation) {
  const program=projectToolProgram(name,input,kind);
  if(program?.operations.length===1) {
    const operation=program.operations[0];
    const presentation=presentTool(operation.name,operation.input);
    const framed=result ? framedToolResult(result.text,result.frame) : undefined;
    const decoded=result?.native?.decoded ? result.native : framed ? programResults(program,framed.text)?.[0] : undefined;
    const media=framed && !framed.decoded && Array.isArray(result?.content) && result.content.some(block=>block.type==='image') ? result.content : undefined;
    const projected=framed ? operationResult(presentation,{...framed,...decoded,...(media && !decoded?.content ? {content:media}:{}),wallTimeSeconds:decoded?.wallTimeSeconds ?? framed.wallTimeSeconds,failed:Boolean(result?.failed || framed.failed || decoded?.failed)}) : undefined;
    return {name:operation.name,input:operation.input,kind:undefined,result:projected,header:observedHeader(presentation,projected)};
  }
  const presentation=header ?? presentTool(name,input,kind);
  const transport=result ? projectToolResult(projectExecution(name,input,kind),result.text,result.frame,result.native,program) : undefined;
  const projected=transport ? operationResult(presentation,{...transport,failed:Boolean(result?.failed || transport.failed)}) : undefined;
  return {name,input,kind,header:observedHeader(presentation,projected),result:projected};
}

function observedHeader(header:ToolPresentation,result?:ToolTransportResult):ToolPresentation {
  if(!result && header.hasDetails!==undefined) return header;
  const reports=result && header.operation==='thread-wait' ? threadReports(result.text) : null;
  return {...header,hasDetails:!['thread-read','thread-wait','sleep','tool-discovery','execution-wait'].includes(header.operation ?? '') || Boolean(result && substantiveToolResult(result)),
    ...(result ? {observation:{...(result.wallTimeSeconds!==undefined ? {elapsedSeconds:result.wallTimeSeconds}:{}),...(reports?.length ? {report:reports.every(report=>report.final)?'final' as const:'update' as const}:{})}} : {})};
}
