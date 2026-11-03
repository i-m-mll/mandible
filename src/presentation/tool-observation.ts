import { presentTool, type ToolPresentation } from './tool-presentation.js';
import { projectToolProgram } from './tool-program.js';
import { projectExecution } from './execution-presentation.js';
import { framedToolResult, programResults, projectToolResult, type NativeResultFrame, type ToolTransportResult } from './tool-transport.js';
import { operationResult } from './tool-operation.js';

/** Direct calls and fully recognized one-operation wrappers share the same operation. */
export function toolObservation(name:string,input:Record<string,unknown> | string = {},kind?:string,
  result?:{text:string;frame?:NativeResultFrame;native?:ToolTransportResult;failed?:boolean},header?:ToolPresentation) {
  const program=projectToolProgram(name,input,kind);
  if(program?.operations.length===1) {
    const operation=program.operations[0];
    const presentation=presentTool(operation.name,operation.input);
    const framed=result ? framedToolResult(result.text,result.frame) : undefined;
    const decoded=framed ? programResults(program,framed.text)?.[0] : undefined;
    const projected=framed ? operationResult(presentation,{...framed,...decoded,wallTimeSeconds:decoded?.wallTimeSeconds ?? framed.wallTimeSeconds,failed:Boolean(result?.failed || framed.failed || decoded?.failed)}) : undefined;
    return {name:operation.name,input:operation.input,kind:undefined,header:presentation,result:projected};
  }
  const presentation=header ?? presentTool(name,input,kind);
  return {name,input,kind,header:presentation,result:result ? operationResult(presentation,projectToolResult(projectExecution(name,input,kind),result.text,result.frame,result.native,program)) : undefined};
}
