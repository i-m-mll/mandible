import { observeOperationReceipt } from '../presentation/tool-observation.js';
import { observationWriter, readObservations } from './index-observations.js';
import { readProviderEvidence } from './index-provider-evidence.js';
import { createHash } from 'node:crypto';
import type SqliteDatabase from '../sqlite.js';
import { displayFragmentId, displaySummaryMembers, type IndexedDisplayFragment, type DisplayFragmentDescriptor, type DisplayPositionFacts } from './display-context.js';
import { semanticActivityUnified } from '../presentation/activity-presentation.js';
import { KEY_RECIPE_COLUMNS, indexKeyEncoder, indexKeyDecoder, type KeyRecipeRow } from './index-keys.js';
import type { ActivityFacts, IndexWriteBatch } from './conversation-index.js';

export type DisplayIndexInput = IndexWriteBatch;
const PARTS=['content','activity','tool','directive'] as const;
const ACTIVITIES=['tool','thinking','directive-memory','directive-thread','activity'] as const;
const SUBTYPES=['reasoning-summary','thinking','tool-progress','tool-summary','status','information','diagnostic'] as const;
const SEVERITIES=['info','warning','error'] as const;
const OUTCOMES=['unknown','succeeded','failed','cancelled'] as const;
const FORWARDING=['result','stdout','direct'] as const;
const RESPONSES=['unknown','interim','final'] as const;
function code<T extends string>(values:readonly T[],value:T|undefined):number|null {if(value===undefined)return null;const index=values.indexOf(value);if(index<0)throw new Error(`Invalid compact enum: ${value}`);return index;}
function enumValue<T extends string>(values:readonly T[],value:number|null):T|undefined {if(value===null)return undefined;const decoded=values[value];if(decoded===undefined)throw new Error(`Invalid compact enum code: ${value}`);return decoded;}
export function fragmentPart(part:string):[number,number] {
  const match=/^(content|activity|tool|directive):(\d+)$/.exec(part);if(!match)throw new Error(`Unsupported Chat fragment part: ${part}`);
  return [PARTS.indexOf(match[1] as typeof PARTS[number]),Number(match[2])];
}
const partName=(kind:number,ordinal:number):string=>{const value=PARTS[kind];if(!value)throw new Error('Invalid fragment kind');return `${value}:${ordinal}`;};
type FragmentRow={position:number;part_kind:number;part_ordinal:number;ordinal:number;kind:number;run_position:number|null;run_kind:number|null;run_ordinal:number|null;
  activity_kind:number|null;activity_subtype:number|null;severity:number|null;outcome:number|null;status:string|null;tool_name:string|null;tool_kind:string|null;turn_id:string|null;flags:number;execution_kind:number|null;execution_count:number|null;role_code:number};
const speaker=(role:number):DisplayPositionFacts['speaker']=>role===0?'user':role===2?'system':'assistant';
const fragmentSpeaker=(row:Pick<FragmentRow,'flags'|'role_code'>):DisplayPositionFacts['speaker']=>((row.flags>>6)&3)===1?'user':((row.flags>>6)&3)===2?'assistant':((row.flags>>6)&3)===3?'system':speaker(row.role_code);
const fragmentSelect=`SELECT f.*,b.role_code FROM cache_display_fragments f JOIN cache_blocks b ON b.cache_conversation_id=f.cache_conversation_id AND b.position=f.position`;
function conversationId(db:SqliteDatabase,id:number):string {const row=db.prepare('SELECT conversation_id FROM cache_conversations WHERE cache_id=?').get(id) as {conversation_id:string}|undefined;if(!row)throw new Error('Missing index generation');return row.conversation_id;}
export function writeDisplayIndex(db:SqliteDatabase,cacheId:number,input:DisplayIndexInput):void {
  const encodeKey=indexKeyEncoder(db,cacheId,conversationId(db,cacheId));
  const update=db.prepare('UPDATE cache_blocks SET revision=?,turn_id=?,response_class=?,usage_key=?,usage_input=?,usage_output=? WHERE cache_conversation_id=? AND position=?');
  const identity=db.prepare(`INSERT INTO cache_position_identities VALUES(?,?,?,?,${KEY_RECIPE_COLUMNS.split(',').map(()=>'?').join(',')})`);
  const deleteIdentities=db.prepare('DELETE FROM cache_position_identities WHERE cache_conversation_id=? AND position=?');
  for(const position of input.positions) {
    if(!/^[0-9a-f]{64}$/.test(position.revision))throw new Error('Invalid source revision digest');
    const result=update.run(Buffer.from(position.revision,'hex'),position.turnId??null,code(RESPONSES,position.response?.classification),position.usage?.key??null,position.usage?.input??null,position.usage?.output??null,cacheId,position.position);
    if(!result.changes)throw new Error('Presentation facts have no source position');
    deleteIdentities.run(cacheId,position.position);
    for(const [kind,keys] of [position.handoff,position.response?[position.response.identity]:[],position.execution?[position.execution]:[]].entries())
      for(const [ordinal,key] of keys.entries())identity.run(cacheId,position.position,kind,ordinal,...encodeKey(key));
  }
  let previous=db.prepare(`${fragmentSelect} WHERE f.cache_conversation_id=? ORDER BY f.position DESC,f.ordinal DESC LIMIT 1`).get(cacheId) as FragmentRow|undefined;
  const toolOwners=new Set(input.fragments.filter(fragment=>fragment.activity?.kind==='tool').map(fragment=>fragment.coordinate.position));
  const ownerExists=db.prepare('SELECT 1 FROM cache_display_fragments WHERE cache_conversation_id=? AND position=? AND activity_kind=0');
  const paired=new Set(input.aliases.filter(alias=>toolOwners.has(alias.owner_position)||ownerExists.get(cacheId,alias.owner_position)).map(alias=>alias.position));
  const insert=db.prepare('INSERT INTO cache_display_fragments VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const disclosure=db.prepare(`INSERT INTO cache_fragment_disclosures VALUES(?,?,?,?,?,?,?,${KEY_RECIPE_COLUMNS.split(',').map(()=>'?').join(',')})`);
  const roles=new Map((db.prepare('SELECT position,role_code FROM cache_blocks WHERE cache_conversation_id=? AND position IN (SELECT value FROM json_each(?))').all(cacheId,JSON.stringify(input.fragments.map(fragment=>fragment.coordinate.position))) as Array<{position:number;role_code:number}>).map(row=>[row.position,row.role_code]));
  const writeObservation=observationWriter(db,cacheId,conversationId(db,cacheId),encodeKey);
  const insertStep=db.prepare('INSERT INTO cache_execution_steps VALUES(?,?,?,?,?,?,?)');
  for(const [ordinal,fragment] of input.fragments.entries()) {
    if(paired.has(fragment.coordinate.position))continue;
    const [kind,partOrdinal]=fragmentPart(fragment.coordinate.part);const position=fragment.coordinate.position;
    const run=fragment.kind==='activity' ? previous?.kind===1&&fragmentSpeaker(previous)===fragment.speaker
      ? [previous.run_position!,previous.run_kind!,previous.run_ordinal!] : [position,kind,partOrdinal] : [null,null,null];
    const activity=fragment.activity;
    const sourceRole=roles.get(position)!;
    const speakerOverride=speaker(sourceRole)===fragment.speaker?0:(fragment.speaker==='user'?1:fragment.speaker==='assistant'?2:3)<<6;
    const flags=speakerOverride|(fragment.summary_from_source?1:0)|(fragment.has_details&&!activity?.observation?2:0)|(fragment.summary_eligible===false?4:0)|(activity?.failed&&!activity.observation?8:0)|(activity?.running&&!activity.observation?16:0)|(activity?.hasResult?32:0)
      |(activity?.localCommandStream ? 256|(activity.localCommandStream==='stderr'?512:0) : 0);
    insert.run(cacheId,position,kind,partOrdinal,ordinal,fragment.kind==='activity'?1:0,...run,
      code(ACTIVITIES,activity?.kind),code(SUBTYPES,activity?.activityKind),code(SEVERITIES,activity?.severity),code(OUTCOMES,activity?.outcome),
      activity?.status??null,activity?.toolName??null,activity?.toolKind??null,activity?.turnId??null,flags,
      activity?.execution ? activity.execution.kind==='command'?0:1 : null,activity?.execution?.kind==='command'?activity.execution.count:null);
    for(const [disclosureKind,keys] of [fragment.disclosureRecipes?.keys??[],fragment.disclosureRecipes?.prefixes??[],fragment.disclosureRecipes?.thinkingDefaults?.map(value=>value.key)??[]].entries())
      for(const [index,key] of keys.entries())disclosure.run(cacheId,position,kind,partOrdinal,disclosureKind,index,disclosureKind===2?fragment.disclosureRecipes?.thinkingDefaults?.[index]?.turnId??null:null,...encodeKey(key));
    if(activity?.observation)writeObservation(position,kind,partOrdinal,activity.observation);
    if(activity?.execution?.kind==='command')for(const [index,forwarding] of activity.execution.forwarding.entries())insertStep.run(cacheId,position,kind,partOrdinal,index,activity.execution.shells[index]??null,code(FORWARDING,forwarding));
    previous={position,kind:fragment.kind==='activity'?1:0,role_code:fragment.speaker==='user'?0:fragment.speaker==='system'?2:1,run_position:run[0],run_kind:run[1],run_ordinal:run[2],flags:0} as FragmentRow;
  }
  const findOwner=db.prepare('SELECT part_kind,part_ordinal FROM cache_display_fragments WHERE cache_conversation_id=? AND position=? AND activity_kind=0 ORDER BY ordinal LIMIT 1');
  const insertAlias=db.prepare('INSERT OR REPLACE INTO cache_display_aliases VALUES(?,?,?,?,?)');
  const setResult=db.prepare('UPDATE cache_display_fragments SET flags=flags|32 WHERE cache_conversation_id=? AND position=? AND part_kind=? AND part_ordinal=?');
  const setFailed=db.prepare('UPDATE cache_display_fragments SET flags=flags|8 WHERE cache_conversation_id=? AND position=? AND part_kind=? AND part_ordinal=?');
  for(const alias of input.aliases) {
    const owner=findOwner.get(cacheId,alias.owner_position) as {part_kind:number;part_ordinal:number}|undefined;
    if(!owner)continue;
    insertAlias.run(cacheId,alias.position,alias.owner_position,owner.part_kind,owner.part_ordinal);
    setResult.run(cacheId,alias.owner_position,owner.part_kind,owner.part_ordinal);
    if(alias.failed)setFailed.run(cacheId,alias.owner_position,owner.part_kind,owner.part_ordinal);
    if(alias.receipt) {
      const key=`${alias.owner_position}:${owner.part_kind}:${owner.part_ordinal}`;
      const current=readObservations(db,cacheId,[alias.owner_position]).get(key);
      if(current) {
        const observed=observeOperationReceipt(current,{...alias.receipt,result:{...alias.receipt.result,failed:alias.failed||alias.receipt.result.failed}});
        db.prepare('DELETE FROM cache_operation_targets WHERE cache_conversation_id=? AND position=? AND part_kind=? AND part_ordinal=?').run(cacheId,alias.owner_position,owner.part_kind,owner.part_ordinal);
        db.prepare('DELETE FROM cache_fragment_operations WHERE cache_conversation_id=? AND position=? AND part_kind=? AND part_ordinal=?').run(cacheId,alias.owner_position,owner.part_kind,owner.part_ordinal);
        writeObservation(alias.owner_position,owner.part_kind,owner.part_ordinal,observed);
        if(observed.payload.state!=='none')db.prepare('UPDATE cache_display_fragments SET flags=flags|2 WHERE cache_conversation_id=? AND position=? AND part_kind=? AND part_ordinal=?').run(cacheId,alias.owner_position,owner.part_kind,owner.part_ordinal);
      }
    }
  }
}
function decodeRows(db:SqliteDatabase,id:number,rows:FragmentRow[]):IndexedDisplayFragment[] {
  if(!rows.length)return [];
  const decodeKey=indexKeyDecoder(db,id,conversationId(db,id));const positions=JSON.stringify([...new Set(rows.map(row=>row.position))]);
  const children=(table:string)=>db.prepare(`SELECT * FROM ${table} WHERE cache_conversation_id=? AND position IN (SELECT value FROM json_each(?)) ORDER BY position,part_kind,part_ordinal,ordinal`).all(id,positions) as Array<any>;
  const group=(values:Array<any>)=>{const result=new Map<string,any[]>();for(const value of values){const key=`${value.position}:${value.part_kind}:${value.part_ordinal}`;let list=result.get(key);if(!list)result.set(key,list=[]);list.push(value);}return result;};
  const disclosures=group(children('cache_fragment_disclosures'));const observations=readObservations(db,id,rows.map(row=>row.position));const steps=group(children('cache_execution_steps'));
  const paired=group((db.prepare('SELECT position AS paired_position,owner_position AS position,owner_kind AS part_kind,owner_ordinal AS part_ordinal FROM cache_display_aliases WHERE cache_conversation_id=? AND owner_position IN (SELECT value FROM json_each(?)) ORDER BY paired_position').all(id,positions) as any[]));
  return rows.map(row=>{
    const key=`${row.position}:${row.part_kind}:${row.part_ordinal}`;
    const activityKind=enumValue(ACTIVITIES,row.activity_kind);
    const activity:ActivityFacts|null=activityKind ? {kind:activityKind,
      ...(row.activity_subtype===null?{}:{activityKind:enumValue(SUBTYPES,row.activity_subtype)}),...(row.severity===null?{}:{severity:enumValue(SEVERITIES,row.severity)}),...(row.outcome===null?{}:{outcome:enumValue(OUTCOMES,row.outcome)}),
      ...(row.status===null?{}:{status:row.status}),...(row.tool_name===null?{}:{toolName:row.tool_name}),...(row.tool_kind===null?{}:{toolKind:row.tool_kind}),...(row.turn_id===null?{}:{turnId:row.turn_id}),
      ...(row.flags&32?{hasResult:true}:{}),...(row.flags&8?{failed:true}:{}),...(row.flags&16?{running:true}:{}),
      ...(row.flags&256?{localCommandStream:row.flags&512?'stderr' as const:'stdout' as const}:{}),
      ...(row.execution_kind===null?{}:{execution:row.execution_kind===1?{kind:'script',language:'javascript'}:{kind:'command',count:row.execution_count!,shells:(steps.get(key)??[]).map(step=>step.shell),forwarding:(steps.get(key)??[]).map(step=>enumValue(FORWARDING,step.forwarding)!)}}),
      ...(observations.has(key)?{observation:observations.get(key)!}:{})}:null;
    const disclosureRows=disclosures.get(key)??[];
    const disclosureKeys=(kind:number)=>disclosureRows.filter(value=>value.kind===kind).map(value=>decodeKey(value));
    const coordinate={position:row.position,part:partName(row.part_kind,row.part_ordinal)};
    return {id:displayFragmentId(coordinate),coordinate,kind:row.kind===1?'activity':'content',speaker:fragmentSpeaker(row),
      activity_run_id:row.run_position===null?null:displayFragmentId({position:row.run_position,part:partName(row.run_kind!,row.run_ordinal!)}),
      activity,paired_source_positions:(paired.get(key)??[]).map(value=>value.paired_position),summary_from_source:Boolean(row.flags&1),has_details:observations.has(key)?observations.get(key)!.payload.state!=='none':Boolean(row.flags&2),summary_eligible:!(row.flags&4),
      disclosures:{keys:disclosureKeys(0),prefixes:disclosureKeys(1),...(disclosureRows.some(value=>value.kind===2)?{thinkingDefaults:disclosureRows.filter(value=>value.kind===2).map(value=>({key:decodeKey(value),...(value.turn_id===null?{}:{turnId:value.turn_id})}))}:{})}};
  });
}
export type DisplayContextPlan={fragments:DisplayFragmentDescriptor[];aliases:Array<{position:number;fragment_id:string}>;runs:Map<string,IndexedDisplayFragment[]>;ownerFragments:IndexedDisplayFragment[];sourcePositions:number[]};
export function readDisplayContextPlan(db:SqliteDatabase,id:number,positions:readonly number[]):DisplayContextPlan {
  const params=JSON.stringify(positions);
  const aliasRows=db.prepare('SELECT * FROM cache_display_aliases WHERE cache_conversation_id=? AND position IN (SELECT value FROM json_each(?))').all(id,params) as Array<{position:number;owner_position:number;owner_kind:number;owner_ordinal:number}>;
  const owners=JSON.stringify([...positions,...aliasRows.map(alias=>alias.owner_position)]);
  const rows=db.prepare(`${fragmentSelect} WHERE f.cache_conversation_id=? AND f.position IN (SELECT value FROM json_each(?)) ORDER BY f.position,f.ordinal`).all(id,owners) as FragmentRow[];
  const decoded=decodeRows(db,id,rows);const runs=new Map<string,IndexedDisplayFragment[]>();const sourcePositions=new Set<number>();
  const runCoordinates=new Map(rows.filter(row=>row.run_position!==null).map(row=>[`${row.run_position}:${row.run_kind}:${row.run_ordinal}`,row]));
  for(const row of runCoordinates.values()) {
    const members=decodeRows(db,id,db.prepare(`${fragmentSelect} WHERE f.cache_conversation_id=? AND f.run_position=? AND f.run_kind=? AND f.run_ordinal=? ORDER BY f.position,f.ordinal`).all(id,row.run_position,row.run_kind,row.run_ordinal) as FragmentRow[]);
    runs.set(members[0].activity_run_id!,members);
    const contributors=displaySummaryMembers(members);const unified=contributors.some(member=>member.activity&&semanticActivityUnified(member.activity));
    for(const [index,member] of contributors.entries())if(member.summary_from_source&&(contributors.length===1||(!unified&&index===0)||(unified&&member.activity&&!semanticActivityUnified(member.activity))))sourcePositions.add(member.coordinate.position);
  }
  const ownerFragments=decoded.filter(fragment=>fragment.activity?.kind==='tool');for(const owner of ownerFragments)sourcePositions.add(owner.coordinate.position);
  const evidence=readProviderEvidence(db,id);
  for(const position of [...sourcePositions]){let origin=evidence.get(position)?.display_tool_origin?.position;const seen=new Set<number>();while(origin!==undefined&&!seen.has(origin)){seen.add(origin);sourcePositions.add(origin);origin=evidence.get(origin)?.display_tool_origin?.position;}}
  return {fragments:decoded.map(({id,coordinate,kind,activity_run_id,paired_source_positions})=>({id,coordinate,kind,activity_run_id,paired_source_positions})),
    aliases:aliasRows.map(alias=>({position:alias.position,fragment_id:displayFragmentId({position:alias.owner_position,part:partName(alias.owner_kind,alias.owner_ordinal)})})),runs,ownerFragments,sourcePositions:[...sourcePositions].sort((a,b)=>a-b)};
}
export function readCompleteDisplayIndex(db:SqliteDatabase,id:number):{fragments:IndexedDisplayFragment[];positions:DisplayPositionFacts[];aliases:DisplayContextPlan['aliases'];revisions:{members:Record<string,string>;runs:Record<string,string>}} {
  const fragments=decodeRows(db,id,db.prepare(`${fragmentSelect} WHERE f.cache_conversation_id=? ORDER BY f.position,f.ordinal`).all(id) as FragmentRow[]);
  const decodeKey=indexKeyDecoder(db,id,conversationId(db,id));
  const keys=new Map<number,Array<KeyRecipeRow&{kind:number;ordinal:number}>>();
  for(const row of db.prepare('SELECT * FROM cache_position_identities WHERE cache_conversation_id=? ORDER BY position,kind,ordinal').all(id) as Array<KeyRecipeRow&{position:number;kind:number;ordinal:number}>) {let values=keys.get(row.position);if(!values)keys.set(row.position,values=[]);values.push(row);}
  const evidence=readProviderEvidence(db,id);
  const positions=(db.prepare('SELECT position,role_code,revision,turn_id,response_class,usage_key,usage_input,usage_output FROM cache_blocks WHERE cache_conversation_id=? ORDER BY position').all(id) as Array<any>).map(row=>{
    const identities=keys.get(row.position)??[];const key=(kind:number)=>identities.filter(value=>value.kind===kind).map(value=>decodeKey(value));
    const response=key(1)[0],execution=key(2)[0];
    return {position:row.position,...(evidence.get(row.position)?.display_tool_origin?{presentationDependencies:[evidence.get(row.position)!.display_tool_origin!.position]}:{}),speaker:speaker(row.role_code),revision:row.revision?Buffer.from(row.revision).toString('hex'):'',handoffKeys:key(0),...(row.turn_id===null?{}:{turnId:row.turn_id}),
      ...(response?{assistantResponse:{key:response,classification:enumValue(RESPONSES,row.response_class)!}}:{}),...(execution?{executionKey:execution}:{}),...(row.usage_key===null?{}:{usage:{key:row.usage_key,input:row.usage_input,output:row.usage_output}})};
  });
  const aliases=fragments.flatMap(fragment=>fragment.paired_source_positions.map(position=>({position,fragment_id:fragment.id}))).sort((a,b)=>a.position-b.position);
  const byPosition=new Map(positions.map(position=>[position.position,position]));const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const dependencies=(positions:readonly number[])=>{const seen=new Set(positions);for(const position of seen)for(const dependency of byPosition.get(position)?.presentationDependencies??[])seen.add(dependency);return [...seen].sort((a,b)=>a-b);};
  const members=Object.fromEntries(fragments.map(fragment=>[fragment.id,hash([fragment.coordinate,fragment.kind,fragment.speaker,fragment.activity?.kind==='tool'?fragment.activity.observation:undefined,
    dependencies([fragment.coordinate.position,...fragment.paired_source_positions]).map(position=>[position,byPosition.get(position)?.revision])])]));
  const runs=new Map<string,string[]>();for(const fragment of fragments)if(fragment.activity_run_id){let values=runs.get(fragment.activity_run_id);if(!values)runs.set(fragment.activity_run_id,values=[]);values.push(members[fragment.id]);}
  return {fragments,positions,aliases,revisions:{members,runs:Object.fromEntries([...runs].map(([id,values])=>[id,hash(values)]))}};
}
