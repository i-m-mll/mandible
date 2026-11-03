import type { Db } from '../db.js';
import { normalizePersistedUsage, type NormalizedUsageTelemetry } from '../parsers/context-usage.js';
import { captureReadingPublication } from './reading-materialization.js';
import { ConversationSourceReader } from './source-reader.js';
import { getConversationStructureCache } from './structure-cache.js';

/** The telemetry owner acquires usage independently of the visible reader's body demand. */
export async function readLatestPersistedUsage(db:Db,sessionRef:string|null,transcriptPath:string|null,signal?:AbortSignal):Promise<NormalizedUsageTelemetry|undefined>{
  const candidates=(transcriptPath?db.prepare('SELECT id,source FROM conversations WHERE source_path=?').all(transcriptPath):db.prepare('SELECT id,source FROM conversations WHERE session_id=?').all(sessionRef)) as Array<{id:string;source:string}>;
  if(candidates.length!==1)return undefined;
  const conversation=candidates[0],source=captureReadingPublication(db,conversation.id);if(!source)return undefined;
  const cache=getConversationStructureCache(db),types=conversation.source==='codex'?['event']:['assistant_message'];
  const page=cache.readPage(conversation.id,source.current_version_id,{offset:0,limit:0,types,epochs:source});if(!page)return undefined;
  const reader=new ConversationSourceReader(db);
  for(let offset=page.total-1;offset>=0;offset--){
    if(signal?.aborted)return undefined;
    const position=cache.readPage(conversation.id,source.current_version_id,{offset,limit:1,types,epochs:source})?.rows[0]?.position;if(position===undefined)return undefined;
    const read=await reader.readPositions(conversation.id,[position],{expectedSourceVersionId:source.current_version_id,signal});if(read.status!=='source')return undefined;
    const metadata=JSON.parse(read.value[0].metadata_json);
    const usage=normalizePersistedUsage(metadata.usage_telemetry??metadata.context_usage);if(usage)return usage;
  }
  return undefined;
}
