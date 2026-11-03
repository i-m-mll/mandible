import { expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ConversationStructureCache, projectConversationCache } from '../src/conversations/structure-cache';
import { indexDisplayFragments } from '../src/conversations/display-indexing';
import { CURRENT_CONVERSATION_SOURCE_EPOCHS } from '../src/conversations/source-types';
import { testRuntimeRoot } from './helpers/runtime-isolation';
import type { ChatItem, ConversationBlock } from '../src/parsers/types';
import { buildReadingManifest, planConversationReading } from '../src/presentation/reading-manifest';
import { readingNodeDisclosures, readingDisclosureState } from '../src/presentation/reading-disclosures';
import { projectDisplayFragments } from '../src/presentation/fragments';
import { defaultDisplayEventsFromBlocks } from '../src/conversations/display-context';

const epochs=CURRENT_CONVERSATION_SOURCE_EPOCHS;
const manifest=(version:string,count:number)=>({conversation_id:'conv',source_version_id:version,parser_format:epochs.parserFormat,parser_version:epochs.parserVersion,normalization_version:epochs.normalizationVersion,redaction_epoch:epochs.redactionEpoch,block_count:count});
function block(position:number,item:ChatItem):Omit<ConversationBlock,'id'|'conversation_id'> {
  return {position,type:item.type==='tool-call'?item.phase==='call'?'tool_use':'tool_result':item.type==='activity'?'event':'assistant_message',role:item.role,content:'source body',timestamp:null,metadata:{chat_item:item}};
}
function item(position:number):ChatItem {
  return {type:'tool-call',role:'assistant',phase:'call',tool_id:'Native[ID]:雪',tool_name:'CustomCASE',input:{code:'private code'},identity:{provider:'codex',session_id:'session"雪',native_tool_id:'Native[ID]:雪',native_turn_id:'turn:opaque',source_record_ordinal:position,source_sub_block_ordinal:0},provenance:{provider:'codex',source:'verified-provider-transcript',source_event_type:'function_call'},parts:[],content_completion:'complete'};
}
const rows=(blocks:readonly Omit<ConversationBlock,'id'|'conversation_id'>[],parent:(position:number)=>number|null)=>blocks.map(value=>({position:value.position,type:value.type,role:value.role,parentPosition:parent(value.position),recordOffset:value.position*10,recordLength:10,recordOrdinal:value.position,subBlockOrdinal:0}));
function plan(cache:ConversationStructureCache,version:string) {
  const index=cache.readPresentationIndex('conv',version,epochs)!;
  return buildReadingManifest({conversationId:'conv',positionSpaceId:'space',sourceVersionId:version,publicationRevision:1,blockCount:index.positions.length,...index,readingContext:cache.readReadingContext('conv',version,0,index.positions.length-1,epochs)!});
}

it('keeps admitted readers and disclosure identity while a late result updates its prior owner',()=>{
  const root=path.join(testRuntimeRoot,'compact-reader');fs.mkdirSync(root,{recursive:true});
  const cache=new ConversationStructureCache(undefined,{cachePath:path.join(root,'cache')});
  const call=block(0,item(0));
  try {
    cache.replaceRows(manifest('before',1),rows([call],()=>null),new Map(),undefined,indexDisplayFragments([call],'conv',()=>null));
    const admitted=cache.openReadSession();
    try {
      const before=plan(admitted.cache,'before');const member=before.members[0];const expanded={[member.disclosures!.keys[0]]:true};
      const resultItem:ChatItem={...item(1),type:'tool-call',role:'tool',phase:'result',output:'failed',execution_outcome:'failed'};
      const result=block(1,resultItem);result.metadata.display_tool_error=true;
      const id=cache.beginGeneration(manifest('after',2),'before');
      cache.appendGeneration(id,{rows:rows([result],()=>0),display:indexDisplayFragments([result],'conv',()=>0)});
      expect(cache.readPresentationIndex('conv','after',epochs)).toBeNull();
      cache.completeGeneration(id);
      const after=plan(cache,'after');
      expect(admitted.cache.readPresentationIndex('conv','after',epochs)).toBeNull();
      expect(plan(admitted.cache,'before').members[0].dependencyRevision).toBe(member.dependencyRevision);
      expect(after.members[0].disclosures).toEqual(member.disclosures);
      expect(after.members[0].handoffKeys).toEqual(expect.arrayContaining(before.members[0].handoffKeys));
      expect(after.members[0].sourcePositions).toEqual([0,1]);
      expect(after.members[0].dependencyRevision).not.toBe(member.dependencyRevision);
      expect(after.runs['0:tool:0'].presentation.summary).toBe('Used CustomCASE');
      expect(planConversationReading(after,expanded).rows[0].key).toBe(planConversationReading(before,expanded).rows[0].key);
      expect(cache.readDisplayContext('conv','after',[1],epochs)?.aliases).toEqual([{position:1,fragment_id:'0:tool:0'}]);
    } finally {admitted.close();}
  } finally {cache.close();fs.rmSync(root,{recursive:true,force:true});}
});

it('retains exact source disclosure constructors and the system speaker of an unmatched tool result',()=>{
  const cache=new ConversationStructureCache(undefined,{cachePath:':memory:'});
  const result=block(0,{...item(0),type:'tool-call',role:'tool',phase:'result',output:'orphan'});
  try {
    const incomplete=cache.beginGeneration(manifest('incomplete',1));
    cache.appendGeneration(incomplete,{rows:rows([result],()=>null)});
    expect(()=>cache.completeGeneration(incomplete)).toThrow('position facts are incomplete');
    expect(cache.readPresentationIndex('conv','incomplete',epochs)).toBeNull();
    cache.discardGeneration(incomplete);
    const events=defaultDisplayEventsFromBlocks([{...result,parentPosition:null}],'conv');
    const visible=projectDisplayFragments(events,true)[0];
    cache.replaceRows(manifest('orphan',1),rows([result],()=>null),new Map(),undefined,indexDisplayFragments([result],'conv',()=>null));
    const stored=cache.readPresentationIndex('conv','orphan',epochs)!.fragments[0];
    expect(stored.speaker).toBe('system');
    expect(stored.disclosures).toEqual(readingNodeDisclosures(visible.node));
    expect(planConversationReading(plan(cache,'orphan'),{}).rows[0].sourcePositions).toEqual([0]);
    const message=(position:number,text:string)=>block(position,{type:'message',role:'assistant',identity:{...item(position).identity,native_turn_id:undefined,native_tool_id:undefined,native_item_id:`message-${position}`},
      provenance:item(position).provenance,parts:[{type:'text',text}],content_completion:'complete'});
    const messages=[message(0,'Earlier'),message(1,'<oai-mem-citation>\n<citation_entries>\nMEMORY.md:1|note=[source]\n</citation_entries>\n<rollout_ids>\nnative-rollout\n</rollout_ids>\n</oai-mem-citation>')];
    const projected=projectDisplayFragments(defaultDisplayEventsFromBlocks(messages.map(value=>({...value,parentPosition:null})),'conv'),true);
    cache.replaceRows(manifest('missing-native-turn',messages.length),rows(messages,()=>null),new Map(),undefined,indexDisplayFragments(messages,'conv',()=>null));
    const directive=cache.readPresentationIndex('conv','missing-native-turn',epochs)!.fragments.find(fragment=>fragment.activity?.kind==='directive-memory')!;
    const visibleDirective=projected.find(fragment=>fragment.node.kind==='activity'&&fragment.node.item.type==='provider-directive')!;
    const expected=readingNodeDisclosures(visibleDirective.node);
    expect(directive.disclosures).toEqual(expected);
    expect(expected.keys).toEqual(['activity:provider-directive:cblk:conv:0:cblk:conv:1:0']);
    const expanded={[expected.keys[0]]:true};
    expect(readingDisclosureState(directive.disclosures,expanded)).toEqual([[expected.keys[0],true]]);

  } finally {cache.close();}
});

it('admits timer cancellation between projection batches without a custom scheduling callback',async()=>{
  const root=path.join(testRuntimeRoot,'compact-projection-cancel');fs.mkdirSync(root,{recursive:true});
  const source=new ConversationStructureCache(undefined,{cachePath:path.join(root,'source')});
  const call=block(0,item(0));
  try {
    source.replaceRows(manifest('ready',1),rows([call],()=>null),new Map(),undefined,indexDisplayFragments([call],'conv',()=>null));
    const controller=new AbortController();const reason=new Error('projection cancelled at timer barrier');
    const barrier=new Promise<void>(resolve=>setImmediate(()=>{controller.abort(reason);resolve();}));
    const destination=path.join(root,'selected.v19');
    await expect(projectConversationCache(source.cachePath,destination,[manifest('ready',1)],{batchSize:1,signal:controller.signal})).rejects.toBe(reason);
    await barrier;
    const selected=new ConversationStructureCache(undefined,{cachePath:destination,readonly:true});
    try {expect(selected.readPresentationIndex('conv','ready',epochs)).toBeNull();}finally{selected.close();}
  } finally {source.close();fs.rmSync(root,{recursive:true,force:true});}
});
