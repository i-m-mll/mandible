import type { ReadingRowBatchRequest } from '../../src/conversations/reading-materialization';
import { planConversationReading, type ConversationReadingManifest } from '../../src/presentation/reading-manifest';
import { materializePreparedReadingRows, type PreparedReadingMember } from '../../src/presentation/reading';

/** Complete canonical corpus for acquisition tests; production composition owns its rows. */
export function readingAcquisitionFixture(conversationId: string, revision: string, keys: readonly string[]) {
  const members: PreparedReadingMember[] = keys.map((key,position)=>{
    const source={blockId:`cblk:${conversationId}:${position}`,position,detailsLoaded:true};
    return {key,position,part:'message',kind:'content',speaker:'user',actionGroup:{key:`scope:${position}`,start:position,end:position},activity:null,
      dependencyRevision:revision,sourcePositions:[position],handoffKeys:[],sources:[source],
      node:{kind:'user_message',key,entity:'user',source:'stream',text:revision,persisted:source}};
  });
  const manifest:ConversationReadingManifest={conversationId,positionSpaceId:'space',sourceVersionId:revision,publicationRevision:1,blockCount:keys.length,runs:{},summarySources:{},scopes:keys.map((_,position)=>({start:position,end:position,speaker:'user'})),
    members:members.map(({node:_,sources:__,...member})=>({...member,activityRunId:null}))};
  const materialize=(request:Pick<ReadingRowBatchRequest,'rows'|'expanded'|'streaming'>)=>{
    const plan=planConversationReading(manifest,request.expanded,request.streaming);
    const wanted=new Map(request.rows.map(ref=>[ref.key,ref.revision]));
    const descriptors=plan.rows.filter(row=>wanted.get(row.key)===row.revision);
    if(descriptors.length!==wanted.size)throw new Error('Acquisition fixture publication does not match requested canonical rows.');
    return materializePreparedReadingRows(descriptors,members);
  };
  return {manifest,materialize};
}
