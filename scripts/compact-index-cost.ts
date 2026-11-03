import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConversationStructureCache, CONVERSATION_CACHE_FORMAT } from '../src/conversations/structure-cache.js';
import { indexDisplayFragments } from '../src/conversations/display-indexing.js';
import { buildReadingManifest, planConversationReading } from '../src/presentation/reading-manifest.js';
import { CURRENT_CONVERSATION_SOURCE_EPOCHS } from '../src/conversations/source-types.js';
import type { ChatItem, ConversationBlock } from '../src/parsers/types.js';
import { performance } from 'node:perf_hooks';
import SqliteDatabase from '../src/sqlite.js';
import { projectExecution } from '../src/presentation/execution-presentation.js';
import { compactToolOperation, compactToolRunFacts, toolRunFacts } from '../src/presentation/tool-presentation.js';
import { presentReasoning } from '../src/presentation/activity-presentation.js';
import { splitProviderDirectives } from '../src/presentation/provider-directives.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'mandible-compact-facts-'));
const repeats=3,iterations=500,window=128;
const cases=[
  {name:'direct-command',tool:'functions.exec_command',input:JSON.stringify({cmd:'printf hello',shell:'/bin/zsh'}),text:''},
  {name:'nested-wrapper',tool:'functions.exec',input:'const result = await tools.exec_command({cmd:"rg --files src",shell:"/bin/zsh"}); text(result); const edit = await tools.exec_command({cmd:"git diff --stat"}); text(edit);',text:''},
  {name:'reasoning-detail',tool:'',input:'',text:'**An authored heading**\n\n'+('A source-dependent detail.\n'.repeat(100))},
  {name:'inline-directives',tool:'',input:'',text:'Before\n::created-thread{threadId="native-child"}\nAfter\n<oai-mem-citation>\n<citation_entries>\nMEMORY.md:1|note=[source]\n</citation_entries>\n<rollout_ids>\nprovider-native-id\n</rollout_ids>\n</oai-mem-citation>'},
];
let sink=0;
function derive(value:typeof cases[number]) {
  if(value.tool) {
    const execution=projectExecution(value.tool,value.input)?.facts;
    const operations=toolRunFacts([{name:value.tool,input:value.input,execution}]).map(compactToolOperation);
    return {execution,operations,flags:0};
  }
  const detail=presentReasoning([value.text]);
  const directives=splitProviderDirectives(value.text);
  return {flags:(detail.hasBody?2:0)|(directives.some(segment=>segment.kind==='activity')?1:0)};
}
function time(run:()=>void):number {const started=performance.now();for(let index=0;index<iterations;index++)run();return performance.now()-started;}
const epochs=CURRENT_CONVERSATION_SOURCE_EPOCHS;
const cache=new ConversationStructureCache(undefined,{cachePath:path.join(root,'index')});
let cacheClosed=false;
const compact=cases.map(derive);
function normalized(value:typeof cases[number],position=0):Omit<ConversationBlock,'id'|'conversation_id'> {
  const base={identity:{provider:'codex' as const,session_id:'cost',native_item_id:`native-${position}`,native_turn_id:`turn-${position}`,source_record_ordinal:position,source_sub_block_ordinal:0},provenance:{provider:'codex' as const,source:'verified-provider-transcript' as const,source_event_type:'cost'},parts:value.tool?[]:[{type:'text' as const,text:value.text}],content_completion:'complete' as const};
  const item:ChatItem=value.tool?{...base,type:'tool-call',role:'assistant',phase:'call',tool_name:value.tool,tool_id:`tool-${position}`,input:value.input}
    :value.name==='reasoning-detail'?{...base,type:'activity',role:'assistant',activity_kind:'reasoning-summary'}:{...base,type:'message',role:'assistant'};
  return {position,type:value.tool?'tool_use':value.name==='reasoning-detail'?'event':'assistant_message',role:'assistant',content:value.text,timestamp:null,metadata:{chat_item:item}};
}
function header(id:string,count:number,version='one') {return {conversation_id:id,source_version_id:version,parser_format:epochs.parserFormat,parser_version:epochs.parserVersion,normalization_version:epochs.normalizationVersion,redaction_epoch:epochs.redactionEpoch,block_count:count};}
function publish(id:string,blocks:ReturnType<typeof normalized>[],count=blocks.length,version='one',prior?:string) {
  const indexStarted=performance.now();const display=indexDisplayFragments(blocks,id,()=>null);const indexMs=performance.now()-indexStarted;
  const started=performance.now();cache.replaceRows(header(id,count,version),blocks.map(block=>({position:block.position,type:block.type,role:block.role,parentPosition:null,recordOffset:0,recordLength:0,recordOrdinal:block.position,subBlockOrdinal:0})),new Map(),prior,display);
  return {index_ms:indexMs,publication_ms:performance.now()-started};
}
try {
  const publications=cases.map((value,id)=>publish('case-'+id,[normalized(value)]));
  const factDb=new SqliteDatabase(path.join(root,'index.v19'),{readonly:true});
  const ids=cases.map((_,id)=>(factDb.prepare('SELECT cache_id FROM cache_conversations WHERE conversation_id=? AND ready=1').get('case-'+id) as {cache_id:number}).cache_id);
  const scalar=factDb.prepare('SELECT flags,execution_kind,execution_count FROM cache_display_fragments WHERE cache_conversation_id=? AND position=0');
  const operations=factDb.prepare('SELECT category,count,native_name,other_kind FROM cache_fragment_operations WHERE cache_conversation_id=? AND position=0 ORDER BY ordinal');
  const steps=factDb.prepare('SELECT shell,forwarding FROM cache_execution_steps WHERE cache_conversation_id=? AND position=0 ORDER BY ordinal');
  const readFact=(id:number)=>{const facts=scalar.all(ids[id]) as Array<{flags:number;execution_kind:number|null;execution_count:number|null}>;sink+=facts.reduce((sum,row)=>sum+row.flags+(row.execution_count??0),0);for(const row of operations.all(ids[id]) as Array<{category:number;count:number}>)sink+=row.category+row.count;for(const row of steps.all(ids[id]) as Array<{shell:string|null;forwarding:number}>)sink+=row.forwarding+(row.shell?.length??0);};
  const read=(id:number)=>{const value=cache.readPresentationIndex('case-'+id,'one',epochs)!;sink+=value.fragments.length+value.positions.length;};
  const reports=cases.map((value,id)=>{
    const file=path.join(root,id+'.json');fs.writeFileSync(file,JSON.stringify(value));
    const samples=Array.from({length:repeats},()=>({
      derive_available_ms:time(()=>{const facts=derive(value);sink+=facts.flags+(facts.operations?.length??0);}),
      acquire_parse_derive_ms:time(()=>{const facts=derive(JSON.parse(fs.readFileSync(file,'utf8')));sink+=facts.flags+(facts.operations?.length??0);}),
      read_compact_ms:time(()=>readFact(id)),
      full_index_reader_ms:time(()=>read(id)),
      derive_compact_ms:time(()=>{const facts=compact[id];sink+=facts.flags+compactToolRunFacts(facts.operations??[]).length;}),
    }));
    return {name:value.name,source_bytes:fs.statSync(file).size,
      invocation_reuse:{complete_plan:1,bounded_acquisition:1,hydrated_rows:'source is already acquired for details'},samples};
  });
  factDb.close();
  const longBlocks=Array.from({length:window},(_,index)=>normalized(cases[index%cases.length],index));
  const longPublication=publish('selected',longBlocks);
  const complete=Array.from({length:repeats},()=>{const started=performance.now();const index=cache.readPresentationIndex('selected','one',epochs)!;
    const manifest=buildReadingManifest({conversationId:'selected',positionSpaceId:'space',sourceVersionId:'one',publicationRevision:1,blockCount:window,...index,readingContext:cache.readReadingContext('selected','one',0,window-1,epochs)!});
    sink+=planConversationReading(manifest,{}).rows.length;return performance.now()-started;});
  const bounded=Array.from({length:repeats},()=>{const started=performance.now();const result=cache.readDisplayContext('selected','one',longBlocks.map(block=>block.position),epochs)!;sink+=result.fragments.length;return performance.now()-started;});
  const append=publish('selected',[normalized(cases[1],window)],window+1,'two','one');
  cache.close();cacheClosed=true;
  const db=new SqliteDatabase(path.join(root,'index.v19'),{readonly:true});
  const storage=db.prepare(`SELECT name,SUM(pgsize) AS allocated,SUM(payload) AS payload,SUM(unused) AS unused FROM dbstat GROUP BY name ORDER BY allocated DESC`).all();db.close();
  console.log(JSON.stringify({schema:'compact-semantic-cost@1',runtime:Bun.version,repeats,iterations,publications,long_publication:longPublication,append,storage,owned_tables:CONVERSATION_CACHE_FORMAT.tables,reports,complete_128_plan_ms:complete,bounded_128_acquisition_ms:bounded,sink},null,2));
} finally {if(!cacheClosed)cache.close();fs.rmSync(root,{recursive:true,force:true});}
