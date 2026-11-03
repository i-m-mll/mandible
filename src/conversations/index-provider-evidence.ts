import type SqliteDatabase from '../sqlite.js';
import type { BlockMetadata } from '../parsers/types.js';
import { EXECUTION_STATES, EXECUTION_PROVENANCES, FRAME_STATES, enumEntry } from './index-observations.js';
export type ProviderIndexEvidence=Pick<BlockMetadata,'display_tool_execution'|'display_tool_origin'|'display_tool_frame'>;
export function providerEvidenceWriter(db:SqliteDatabase,generation:number) {
  const insert=db.prepare('INSERT INTO cache_provider_evidence VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  return (position:number,value:ProviderIndexEvidence|undefined)=>{
    if(!value)return;const execution=value.display_tool_execution,frame=value.display_tool_frame,origin=value.display_tool_origin;
    if(!execution&&!frame&&!origin)return;
    insert.run(generation,position,execution?EXECUTION_STATES.indexOf(execution.state):null,execution?EXECUTION_PROVENANCES.indexOf(execution.provenance):null,
      frame?.payloadStart??null,frame?.payloadEnd??null,frame?FRAME_STATES.indexOf(frame.state):null,frame?.cellID??null,frame?.wallTimeSeconds??null,
      origin?.session_id??null,origin?.native_tool_id??null,origin?.native_turn_id??null,origin?.position??null,origin?.source_record_ordinal??null,origin?.source_sub_block_ordinal??null);
  };
}
export function readProviderEvidence(db:SqliteDatabase,generation:number,positions?:readonly number[]):Map<number,ProviderIndexEvidence> {
  const rows=db.prepare(`SELECT * FROM cache_provider_evidence WHERE cache_conversation_id=? ${positions?'AND position IN(SELECT value FROM json_each(?))':''}`).all(generation,...(positions?[JSON.stringify([...new Set(positions)])]:[])) as Array<any>;
  return new Map(rows.map(row=>[row.position,{
    ...(row.execution_state===null?{}:{display_tool_execution:{state:enumEntry(EXECUTION_STATES,row.execution_state),provenance:enumEntry(EXECUTION_PROVENANCES,row.execution_provenance)}}),
    ...(row.frame_start===null?{}:{display_tool_frame:{kind:'codex-script' as const,payloadStart:row.frame_start,payloadEnd:row.frame_end,state:enumEntry(FRAME_STATES,row.frame_state),timingScope:'wrapper' as const,...(row.frame_cell===null?{}:{cellID:row.frame_cell}),...(row.frame_seconds===null?{}:{wallTimeSeconds:row.frame_seconds})}}),
    ...(row.origin_position===null?{}:{display_tool_origin:{provider:'codex' as const,session_id:row.origin_session,native_tool_id:row.origin_tool,...(row.origin_turn===null?{}:{native_turn_id:row.origin_turn}),position:row.origin_position,source_record_ordinal:row.origin_record,source_sub_block_ordinal:row.origin_sub_block}}),
  }]));
}
