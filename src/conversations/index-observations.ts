import type SqliteDatabase from '../sqlite.js';
import type { CompactOperationObservation } from '../presentation/operation-observation.js';
import type { ActivityTarget } from '../presentation/activity-targets.js';
import { indexKeyEncoder } from './index-keys.js';

export const EXECUTION_STATES=['unknown','ongoing','completed','failed','cancelled'] as const;
export const EXECUTION_PROVENANCES=['provider-item','paired-result','native-wrapper','managed-generation'] as const;
export const FRAME_STATES=['running','completed','terminated'] as const;
const enumCode=<T extends string>(values:readonly T[],value:T):number=>{const index=values.indexOf(value);if(index<0)throw Error('Invalid observation code');return index;};
export const enumEntry=<T extends string>(values:readonly T[],index:number):T=>{const value=values[index];if(value===undefined)throw Error('Invalid observation code');return value;};

export function observationWriter(db:SqliteDatabase,generation:number,conversationId:string,encode=indexKeyEncoder(db,generation,conversationId)) {
  const insert=db.prepare('INSERT INTO cache_fragment_operations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const target=db.prepare('INSERT INTO cache_operation_targets VALUES(?,?,?,?,?,?,?,?,?,?)');
  return (position:number,kind:number,part:number,observation:CompactOperationObservation)=>{
    let next=0;
    const write=(value:CompactOperationObservation,parent:number|null)=>{
      const ordinal=next++;
      insert.run(generation,position,kind,part,ordinal,parent,value.operation,value.nativeName??null,value.subject??null,
        enumCode(EXECUTION_STATES,value.execution.state),enumCode(EXECUTION_PROVENANCES,value.execution.provenance),value.payload.state==='none'?0:1,
        value.timing?.elapsedSeconds??null,value.timing?value.timing.scope==='operation'?0:1:null,value.reportKind?value.reportKind==='final'?0:1:null);
      for(const [index,ref] of value.targets.entries()) {
        const scope=ref.kind==='pending-thread'?null:encode({kind:'execution',provider:ref.provider,sessionId:ref.kind==='thread'?ref.sessionId:ref.parentSessionId,nativeId:''})[1];
        target.run(generation,position,kind,part,ordinal,index,ref.kind==='thread'?0:ref.kind==='subagent'?1:2,scope,ref.kind==='thread'?null:ref.kind==='subagent'?ref.agentId:ref.clientThreadId,ref.labelHint??null);
      }
      for(const child of value.children??[])write(child,ordinal);
    };write(observation,null);
  };
}

export function readObservations(db:SqliteDatabase,generation:number,positions:readonly number[]):Map<string,CompactOperationObservation> {
  const encoded=JSON.stringify([...new Set(positions)]);
  const rows=db.prepare('SELECT * FROM cache_fragment_operations WHERE cache_conversation_id=? AND position IN(SELECT value FROM json_each(?)) ORDER BY position,part_kind,part_ordinal,ordinal').all(generation,encoded) as Array<any>;
  const refs=db.prepare(`SELECT t.*,s.provider,s.session_id FROM cache_operation_targets t LEFT JOIN cache_native_scopes s
    ON s.cache_conversation_id=t.cache_conversation_id AND s.scope_id=t.scope_id WHERE t.cache_conversation_id=? AND t.position IN(SELECT value FROM json_each(?)) ORDER BY t.ordinal`).all(generation,encoded) as Array<any>;
  const targets=new Map<string,ActivityTarget[]>();
  for(const row of refs){const key=`${row.position}:${row.part_kind}:${row.part_ordinal}:${row.operation_ordinal}`;let values=targets.get(key);if(!values)targets.set(key,values=[]);
    const hint=row.label_hint===null?{}:{labelHint:row.label_hint};
    values.push(row.kind===0?{kind:'thread',provider:row.provider,sessionId:row.session_id,...hint}:row.kind===1?{kind:'subagent',provider:row.provider,parentSessionId:row.session_id,agentId:row.native_id,...hint}:{kind:'pending-thread',provider:'codex',clientThreadId:row.native_id,...hint});}
  const result=new Map<string,CompactOperationObservation>();const nodes=new Map<string,CompactOperationObservation>();
  for(const row of rows){const key=`${row.position}:${row.part_kind}:${row.part_ordinal}`;const observation:CompactOperationObservation={operation:row.operation,
    ...(row.native_name===null?{}:{nativeName:row.native_name}),...(row.subject===null?{}:{subject:row.subject}),targets:targets.get(`${key}:${row.ordinal}`)??[],
    execution:{state:enumEntry(EXECUTION_STATES,row.execution_state),provenance:enumEntry(EXECUTION_PROVENANCES,row.execution_provenance)},payload:{state:row.payload_state===0?'none':'unloaded'},
    ...(row.elapsed_seconds===null?{}:{timing:{elapsedSeconds:row.elapsed_seconds,scope:row.timing_scope===0?'operation':'wrapper'}}),...(row.report_kind===null?{}:{reportKind:row.report_kind===0?'final':'update'})};
    if(row.parent_ordinal===null)result.set(key,observation);else{const parent=nodes.get(`${key}:${row.parent_ordinal}`);if(!parent)throw Error('Missing observation parent');(parent.children??=[]).push(observation);}nodes.set(`${key}:${row.ordinal}`,observation);}
  return result;
}
