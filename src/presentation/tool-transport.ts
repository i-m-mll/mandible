import type { ToolProgram } from './tool-program.js';

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
export type ToolTransportResult = { content?: import('./types.js').ToolResultContent; stderr?: string; timingScope?: 'operation' | 'wrapper'; text: string; failed: boolean; wallTimeSeconds?: number; metadata: Array<{label:string;value:string}>; running: boolean; decoded: boolean };
export function rawToolResult(text: string): ToolTransportResult { return {text,failed:false,metadata:[],running:false,decoded:false}; }
/** Only the MCP content contract is transport; JSON inside text blocks remains application data. */
export function toolContentEnvelope(value: unknown): ToolTransportResult | null {
  if (!record(value) || !Array.isArray(value.content) || Object.keys(value).some(key=>!['content','isError','structuredContent','_meta'].includes(key))
      || (value.isError !== undefined && typeof value.isError !== 'boolean')) return null;
  const content: Array<{type:'text';text:string} | {type:'image';source:{type:string;media_type:string;data:string}}> = [];
  for(const block of value.content) {
    if(!record(block)) return null;
    if(block.type==='text' && typeof block.text==='string') content.push({type:'text',text:block.text});
    else if(block.type==='image' && typeof block.data==='string' && typeof block.mimeType==='string') content.push({type:'image',source:{type:'base64',media_type:block.mimeType,data:block.data}});
    else if(['audio','resource','resource_link'].includes(String(block.type))) content.push({type:'text',text:JSON.stringify(block,null,2)});
    else return null;
  }
  if(value.structuredContent!=null) content.push({type:'text',text:JSON.stringify(value.structuredContent,null,2)});
  return {...rawToolResult(content.flatMap(block=>block.type==='text' ? [block.text] : []).join('\n')),content:content as import('./types.js').ToolResultContent,failed:value.isError===true,decoded:true};
}
export function projectNativeToolResult(value: unknown, fallback: string, kind?: string, name?: string, id?: string): ToolTransportResult {
  const text=typeof value==='string' ? value : value===undefined ? fallback : JSON.stringify(value,null,2);
  const raw=rawToolResult(text);
  if(kind==='claude_tool_result' && Array.isArray(value) && value.every(block=>record(block) && ((block.type==='text' && typeof block.text==='string') || (block.type==='image' && record(block.source) && typeof block.source.media_type==='string' && typeof block.source.data==='string')))) return {...rawToolResult(value.flatMap(block=>block.type==='text' ? [block.text] : []).join('\n')),content:value as import('./types.js').ToolResultContent,decoded:true};
  if(kind==='dynamicToolCall' && Array.isArray(value)) {
    const content=[];
    for(const block of value) {
      if(!record(block)) return raw;
      if(block.type==='inputText' && typeof block.text==='string') content.push({type:'text',text:block.text});
      else if(block.type==='inputImage' && typeof block.imageUrl==='string') {
        const image=/^data:([^;,]+);base64,(.*)$/.exec(block.imageUrl);
        if(!image) return raw;
        content.push({type:'image',mimeType:image[1],data:image[2]});
      } else if(block.type==='inputAudio' && typeof block.audioUrl==='string') content.push({type:'audio',url:block.audioUrl});
      else return raw;
    }
    return toolContentEnvelope({content}) ?? raw;
  }
  if(kind==='mcpToolCall') {
    if(record(value) && Object.keys(value).length===1 && typeof value.message==='string') return {...rawToolResult(value.message),failed:true,decoded:true};
    return toolContentEnvelope(value) ?? raw;
  }
  if(kind==='gemini_tool_result') {
    let native=value;
    if(typeof native==='string') {try {native=JSON.parse(native);} catch {return raw;}}
    if(!Array.isArray(native) || !native.length) return raw;
    const results: ToolTransportResult[]=[];
    for(const part of native) {
      if(!record(part) || Object.keys(part).length!==1 || !record(part.functionResponse)) return raw;
      const response=part.functionResponse;
      if(response.name!==name || (id && response.id!==undefined && response.id!==id) || !record(response.response)) return raw;
      const body=response.response;
      if(name==='run_shell_command' && typeof body.stdout==='string' && typeof body.stderr==='string') results.push({...rawToolResult(body.stdout),stderr:body.stderr,failed:typeof body.exit_code==='number' && body.exit_code!==0,decoded:true});
      else if(Object.keys(body).length===1 && typeof body.output==='string') results.push({...rawToolResult(name==='run_shell_command' && body.output.startsWith('Output: ') ? body.output.slice(8) : body.output),decoded:true});
      else {const envelope=toolContentEnvelope(body);results.push(envelope ?? {...rawToolResult(JSON.stringify(body,null,2)),decoded:true});}
    }
    return {...rawToolResult(results.map(result=>result.text).join('\n')),stderr:results.map(result=>result.stderr ?? '').filter(Boolean).join('\n') || undefined,failed:results.some(result=>result.failed),decoded:true};
  }
  return raw;
}
function jsonValues(text: string): unknown[] | null {
  const values: unknown[]=[];
  let offset=0;
  while(offset<text.length) {
    while(offset<text.length && /\s/.test(text[offset])) offset++;
    if(offset===text.length) break;
    let end=offset,depth=0,quoted=false,escaped=false;
    const container=['{','['].includes(text[offset]);
    const string=text[offset]==='"';
    for(;end<text.length;end++) {
      const char=text[end];
      if(quoted) {if(escaped) escaped=false;else if(char==='\\') escaped=true;else if(char==='"') {quoted=false;if(string && depth===0) {end++;break;}}}
      else if(char==='"') quoted=true;
      else if(char==='{' || char==='[') depth++;
      else if(char==='}' || char===']') {if(--depth===0) {end++;break;}}
      else if(!container && !string && /\s/.test(char)) break;
    }
    if(depth || quoted) return null;
    try {values.push(JSON.parse(text.slice(offset,end)));} catch{return null;}
    offset=end;
  }
  return values.length ? values : null;
}
export function commandTransport(value: unknown): ToolTransportResult | null {
  if (!record(value)) return null;
  const known = ['output','wall_time_seconds','exit_code','session_id','chunk_id','original_token_count'];
  if(Object.keys(value).some(key=>!known.includes(key)) || typeof value.output !== 'string' || typeof value.wall_time_seconds !== 'number' || !Number.isFinite(value.wall_time_seconds) || value.wall_time_seconds<0
      || (value.exit_code != null && !Number.isInteger(value.exit_code)) || (value.session_id != null && !Number.isInteger(value.session_id))
      || (value.chunk_id != null && typeof value.chunk_id !== 'string') || (value.original_token_count != null && !Number.isInteger(value.original_token_count))) return null;
  return {text:value.output,wallTimeSeconds:value.wall_time_seconds,timingScope:'operation',failed:typeof value.exit_code === 'number' && value.exit_code!==0,running:value.session_id!=null && value.exit_code==null,decoded:true,
    metadata:Object.entries(value).filter(([key,value])=>!['output','wall_time_seconds'].includes(key) && value!=null).map(([label,value])=>({label,value:String(value)}))};
}
export function programResults(program: ToolProgram, text: string): ToolTransportResult[] | null {
  const frame=/^(?:Script completed\r?\n|Wall time(?::)? [0-9.]+ seconds\r?\n|Total output lines: \d+\r?\n|Output:\r?\n|\s)*/.exec(text)?.[0] ?? '';
  const start=frame.length;
  const emitted=jsonValues(text.slice(start));
  if(!emitted) return null;
  const values: unknown[]=[];
  let operationIndex=0;
  for(const value of emitted) {
    const operation=program.operations[operationIndex];
    if(!operation) return null;
    if(operation.collection!==undefined) {
      const count=program.operations.slice(operationIndex).findIndex(next=>next.collection!==operation.collection);
      const length=count<0 ? program.operations.length-operationIndex : count;
      if(!Array.isArray(value) || value.length!==length) return null;
      values.push(...value);operationIndex+=length;
    } else {values.push(value);operationIndex++;}
  }
  if(values.length!==program.operations.length) return null;
  const results: ToolTransportResult[]=[];
  for(let index=0;index<values.length;index++) {
    const operation=program.operations[index];
    let value=values[index];
    if(operation.indexKey!==undefined) {
      if(!record(value) || value[operation.indexKey ?? 'i']!==operation.index) return null;
      const body={...value}; delete body[operation.indexKey ?? 'i'];
      if (operation.resultKey) {if(Object.keys(body).length!==1 || !Object.hasOwn(body,operation.resultKey)) return null;value=body[operation.resultKey];} else value=body;
    }
    if(operation.forwarding==='stdout') {if(typeof value!=='string') return null;results.push({...rawToolResult(value),decoded:true});continue;}
    if(operation.settled) {
      if(!record(value)) return null;
      if(value.status==='rejected' && Object.keys(value).every(key=>['status','reason'].includes(key)) && Object.hasOwn(value,'reason')) {results.push({...rawToolResult(typeof value.reason === 'string' ? value.reason : JSON.stringify(value.reason,null,2)),failed:true,decoded:true});continue;}
      if(value.status!=='fulfilled' || Object.keys(value).some(key=>!['status','value'].includes(key))) return null;
      value=value.value;
    }
    const command = ['exec_command','functions.exec_command','write_stdin','functions.write_stdin'].includes(operation.name) ? commandTransport(value) : null;
    const content = operation.name.startsWith('mcp__') ? toolContentEnvelope(value) : null;
    if(operation.indexKey!==undefined && !operation.resultKey && !operation.settled && !command && !content) return null;
    const result=command ?? content ?? {...rawToolResult(typeof value === 'string' ? value : JSON.stringify(value,null,2)),decoded:true};
    results.push(result);
  }
  return results;
}

export type NativeResultFrame = { kind:'codex-script'; payloadStart:number; payloadEnd:number; timingScope:'wrapper'; wallTimeSeconds?: number };
export function codexResultFrame(output: unknown): NativeResultFrame | undefined {
  if (!Array.isArray(output) || output.length < 2 || !output.every(block=>record(block) && ['text','input_text','output_text'].includes(String(block.type)) && typeof block.text==='string')) return undefined;
  const first=output[0];
  if (!record(first) || !['text','input_text','output_text'].includes(String(first.type)) || typeof first.text !== 'string') return undefined;
  const match=/^Script completed\r?\nWall time(?::)? ([0-9.]+) seconds\r?\n(?:Total output lines: \d+\r?\n)?Output:\r?\n$/.exec(first.text);
  if (!match || !Number.isFinite(Number(match[1]))) return undefined;
  return {kind:'codex-script',payloadStart:first.text.length+1,payloadEnd:output.map(block=>block.text).filter(Boolean).join('\n').length,timingScope:'wrapper',wallTimeSeconds:Number(match[1])};
}
export function framedToolResult(text: string, frame?: NativeResultFrame): ToolTransportResult {
  return frame && frame.kind==='codex-script' && frame.payloadStart>=0 && frame.payloadEnd===text.length && frame.payloadStart<=frame.payloadEnd ? {...rawToolResult(text.slice(frame.payloadStart,frame.payloadEnd)),wallTimeSeconds:frame.wallTimeSeconds,timingScope:'wrapper',decoded:true} : rawToolResult(text);
}

export function wrapperCommandResult(execution: {operations: Array<{forwarding:string}>} | null, text: string): ToolTransportResult {
  const raw=rawToolResult(text);
  if(execution?.operations.length!==1 || execution.operations[0].forwarding!=='result') return raw;
  const start=text.indexOf('{');
  if(start<0 || !/^(?:Script completed\r?\n|Wall time(?::)? [0-9.]+ seconds\r?\n|Total output lines: \d+\r?\n|Output:\r?\n|\s)*$/.test(text.slice(0,start))) return raw;
  let value: unknown;
  try {value=JSON.parse(text.slice(start));} catch{return raw;}
  return commandTransport(value) ?? raw;
}
export function projectToolResult(execution: {operations:Array<{forwarding:string}>} | null, text: string, frame?: NativeResultFrame, native?: ToolTransportResult, program?: ToolProgram | null): ToolTransportResult {
  if(native?.decoded) return native;
  const framed=framedToolResult(text,frame);
  const command=wrapperCommandResult(execution,framed.text);
  const result=command.decoded ? command : framed;
  const operations=program ? programResults(program,framed.text) : null;
  return {...result,failed:result.failed || Boolean(native?.failed) || Boolean(operations?.some(value=>value.failed)),running:result.running || Boolean(native?.running) || Boolean(operations?.some(value=>value.running))};
}
