import type { IndexKeyRecipe } from './conversation-index.js';
import type SqliteDatabase from '../sqlite.js';

export type KeyRecipeRow = {recipe:number;scope_id:number|null;item_kind:string|null;basis:string|null;native_id:string|null;content_index:number|null;record_ordinal:number|null;prefix:string|null;suffix:string|null};
export const KEY_RECIPE_COLUMNS = 'recipe,scope_id,item_kind,basis,native_id,content_index,record_ordinal,prefix,suffix';

/** The sole v18 string decoder; fresh ingestion supplies native primitives. */
export function legacyIndexKeyRecipe(key:string,conversationId:string):IndexKeyRecipe {
  const start=key.indexOf('[');
  if(start>=0) {
    let value:unknown;let end=-1;
    for(let index=start+1;index<key.length;index++)if(key[index]===']') {
      try {value=JSON.parse(key.slice(start,index+1));end=index+1;break;}catch { /* Quoted native strings and nested arrays can contain brackets. */ }
    }
    if(Array.isArray(value)&&typeof value[0]==='string'&&typeof value[1]==='string') {
      const scope={provider:value[0],sessionId:value[1]};const wrapper={prefix:key.slice(0,start)||undefined,suffix:key.slice(end)||undefined};
      if(value.length===6&&typeof value[2]==='string'&&['tool','item','turn','record'].includes(value[3]))return {kind:'identity',...scope,...wrapper,itemKind:value[2],basis:value[3],...(value[3]==='record'?{recordOrdinal:value[4]}:{nativeId:value[4]}),contentIndex:value[5]};
      if(value.length===3&&Array.isArray(value[2])&&!wrapper.prefix&&!wrapper.suffix) {
        if(value[2][0]==='record')return {kind:'response-record',...scope,recordOrdinal:value[2][1]};
        if(value[2][0]==='native')return {kind:'response-native',...scope,turnId:value[2][1]??null,nativeId:value[2][2]??null};
      }
      if(value.length===3&&typeof value[2]==='string'&&!wrapper.prefix&&!wrapper.suffix)return {kind:'execution',...scope,nativeId:value[2]};
      throw new Error('Unknown native Chat identity recipe');
    }
  }
  const source=`cblk:${conversationId}:`;const offset=key.indexOf(source);
  if(offset>=0) {
    const match=/^(\d+)(.*)$/s.exec(key.slice(offset+source.length));if(!match)throw new Error('Invalid source disclosure coordinate');
    return {kind:'source',position:Number(match[1]),prefix:key.slice(0,offset)||undefined,suffix:match[2]||undefined};
  }
  if(key.startsWith('intent:'))return {kind:'intent',id:key.slice(7)};
  // These are provider-native turn identities used by the assistant prefix constructor.
  if(key.endsWith(':'))return {kind:'native',value:key.slice(0,-1),suffix:':'};
  throw new Error(`Unknown legacy Chat key recipe: ${key.slice(0,100)}`);
}
type ScopeCatalog={byKey:Map<string,number>;byId:Map<number,{provider:string;session_id:string}>;next:number};
export function indexKeyEncoder(db:SqliteDatabase,generation:number,conversationId:string):(key:IndexKeyRecipe)=>unknown[] {
  const scopes=db.prepare('SELECT scope_id,provider,session_id FROM cache_native_scopes WHERE cache_conversation_id=?').all(generation) as Array<{scope_id:number;provider:string;session_id:string}>;
  const catalog:ScopeCatalog={byKey:new Map(scopes.map(row=>[JSON.stringify([row.provider,row.session_id]),row.scope_id])),byId:new Map(scopes.map(row=>[row.scope_id,row])),next:Math.max(0,...scopes.map(row=>row.scope_id))+1};
  return key=>encodeIndexKey(db,generation,conversationId,key,catalog);
}
export function encodeIndexKey(db:SqliteDatabase,generation:number,conversationId:string,key:IndexKeyRecipe,catalog?:ScopeCatalog): unknown[] {
  const empty={scope_id:null,item_kind:null,basis:null,native_id:null,content_index:null,record_ordinal:null,prefix:null,suffix:null};
  let row:KeyRecipeRow;
  const wrapper={prefix:'prefix' in key?key.prefix??null:null,suffix:'suffix' in key?key.suffix??null:null};
  if(key.kind==='native')row={recipe:0,...empty,...wrapper,native_id:key.value};
  else if(key.kind==='source')row={recipe:2,...empty,...wrapper,record_ordinal:key.position};
  else if(key.kind==='intent')row={recipe:3,...empty,native_id:key.id};
  else {
    const scopeKey=JSON.stringify([key.provider,key.sessionId]);
    let scopeId=catalog?.byKey.get(scopeKey);
    if(scopeId===undefined) {
      const scope=db.prepare('SELECT scope_id FROM cache_native_scopes WHERE cache_conversation_id=? AND provider=? AND session_id=?').get(generation,key.provider,key.sessionId) as {scope_id:number}|undefined;
      scopeId=scope?.scope_id ?? (catalog?catalog.next++:undefined) ?? (db.prepare('SELECT COALESCE(MAX(scope_id),0)+1 AS next FROM cache_native_scopes WHERE cache_conversation_id=?').get(generation) as {next:number}).next;
      if(!scope)db.prepare('INSERT INTO cache_native_scopes VALUES(?,?,?,?)').run(generation,scopeId,key.provider,key.sessionId);
      catalog?.byKey.set(scopeKey,scopeId);catalog?.byId.set(scopeId,{provider:key.provider,session_id:key.sessionId});
    }
    row={recipe:1,...empty,...wrapper,scope_id:scopeId};
    if(key.kind==='identity'){row.item_kind=key.itemKind;row.basis=key.basis;row.native_id=key.nativeId??null;row.record_ordinal=key.recordOrdinal??null;row.content_index=key.contentIndex;}
    else if(key.kind==='execution'){row.basis='execution';row.native_id=key.nativeId;}
    else if(key.kind==='response-record'){row.basis='response:record';row.record_ordinal=key.recordOrdinal;}
    else {row.basis='response:native';row.native_id=key.nativeId;row.item_kind=key.turnId;}
  }
  const decoded=decodeIndexKey(db,generation,conversationId,row,catalog?.byId);
  if(decoded!==indexKeyString(key,conversationId))throw new Error('Lossy Chat identity recipe');
  return KEY_RECIPE_COLUMNS.split(',').map(column=>row[column as keyof KeyRecipeRow]);
}
export function indexKeyString(key:IndexKeyRecipe,conversationId:string):string {
  if(key.kind==='native')return `${key.prefix??''}${key.value}${key.suffix??''}`;
  if(key.kind==='source')return `${key.prefix??''}cblk:${conversationId}:${key.position}${key.suffix??''}`;
  if(key.kind==='intent')return `intent:${key.id}`;
  const scope=[key.provider,key.sessionId];
  if(key.kind==='execution')return JSON.stringify([...scope,key.nativeId]);
  if(key.kind==='response-record')return JSON.stringify([...scope,['record',key.recordOrdinal]]);
  if(key.kind==='response-native')return JSON.stringify([...scope,['native',key.turnId,key.nativeId]]);
  return `${key.prefix??''}${JSON.stringify([...scope,key.itemKind,key.basis,key.basis==='record'?key.recordOrdinal:key.nativeId,key.contentIndex])}${key.suffix??''}`;
}
export function decodeIndexKey(db:SqliteDatabase,generation:number,conversationId:string,row:KeyRecipeRow,scopes?:ReadonlyMap<number,{provider:string;session_id:string}>):string {
  if(row.recipe===0)return `${row.prefix??''}${row.native_id}${row.suffix??''}`;
  if(row.recipe===3)return `intent:${row.native_id}`;
  if(row.recipe===2)return `${row.prefix??''}cblk:${conversationId}:${row.record_ordinal}${row.suffix??''}`;
  if(row.recipe!==1)throw new Error('Invalid Chat key recipe');
  const scope=scopes?scopes.get(row.scope_id!):db.prepare('SELECT provider,session_id FROM cache_native_scopes WHERE cache_conversation_id=? AND scope_id=?').get(generation,row.scope_id) as {provider:string;session_id:string}|undefined;
  if(!scope)throw new Error('Missing Chat native identity scope');
  const prefix=[scope.provider,scope.session_id];
  const value=row.basis==='execution' ? [...prefix,row.native_id]
    :row.basis==='response:record' ? [...prefix,['record',row.record_ordinal]]
    :row.basis==='response:native' ? [...prefix,['native',row.item_kind,row.native_id]]
    :[...prefix,row.item_kind,row.basis,row.basis==='record' ? row.record_ordinal : row.native_id,row.content_index];
  return `${row.prefix??''}${JSON.stringify(value)}${row.suffix??''}`;
}

export function chatItemIdentityRecipe(item:import('../parsers/types.js').ChatItem,options:{allowTranscriptCoordinates?:boolean}={}):IndexKeyRecipe|null {
  if(!item||typeof item!=='object'||!item.identity||!item.provenance)return null;
  const identity=item.identity;if(!identity.provider||!identity.session_id||!item.type)return null;
  if(identity.native_content_index!==undefined&&(!Number.isInteger(identity.native_content_index)||identity.native_content_index<0))return null;
  const common={kind:'identity' as const,provider:identity.provider,sessionId:identity.session_id,
    itemKind:item.type==='message'?`message:${item.role}`:item.type==='activity'?`activity:${item.activity_kind}`:item.type==='tool-call'?`tool-call:${item.phase}`:item.type,
    contentIndex:identity.native_content_index??null};
  const toolId=item.type==='tool-call'?item.tool_id??identity.native_tool_id:undefined;
  if(toolId)return {...common,basis:'tool',nativeId:toolId,contentIndex:null};
  if(identity.native_item_id)return {...common,basis:'item',nativeId:identity.native_item_id};
  if(identity.native_tool_id)return {...common,basis:'tool',nativeId:identity.native_tool_id};
  if(identity.native_turn_id&&identity.native_content_index!==undefined)return {...common,basis:'turn',nativeId:identity.native_turn_id};
  if(!options.allowTranscriptCoordinates||!Number.isInteger(identity.source_record_ordinal)||identity.source_record_ordinal<0||!Number.isInteger(identity.source_sub_block_ordinal)||identity.source_sub_block_ordinal<0)return null;
  return {...common,basis:'record',recordOrdinal:identity.source_record_ordinal,contentIndex:identity.source_sub_block_ordinal};
}

export function indexKeyDecoder(db:SqliteDatabase,generation:number,conversationId:string):(row:KeyRecipeRow)=>string {
  const scopes=new Map((db.prepare('SELECT scope_id,provider,session_id FROM cache_native_scopes WHERE cache_conversation_id=?').all(generation) as Array<{scope_id:number;provider:string;session_id:string}>).map(row=>[row.scope_id,row]));
  return row=>decodeIndexKey(db,generation,conversationId,row,scopes);
}
