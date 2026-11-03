import { activityTargetKey } from './activity-targets.js';
import { activitySemanticFacts } from './activity-presentation.js';
import type { ReadingPlanMember } from './reading-plan.js';
import type { PersistedBlockSource, RenderNode } from './types.js';
import type { CompactOperationObservation } from './operation-observation.js';

export type WaitTransportSegment={chainKey:string;seconds:number;start:number;end:number};
type Member=ReadingPlanMember&{transportSegment?:WaitTransportSegment;node?:RenderNode;sources?:readonly PersistedBlockSource[]};
const observation=(member:Member)=>member.activityFacts?.kind==='tool'?member.activityFacts.observation:member.activity?.type==='tool-call-activity'?member.activity.observation:undefined;
const targetKey=(value:CompactOperationObservation)=>JSON.stringify(value.targets.map(activityTargetKey).sort());
const wait=(member:Member)=>{const value=observation(member);return value?.operation==='thread-wait'&&!value.children?.length?value:undefined;};
const decimalPlaces=(value:number)=>String(value).split('.')[1]?.length??0;
const sumSeconds=(left:number,right:number)=>Number((left+right).toFixed(Math.min(12,Math.max(decimalPlaces(left),decimalPlaces(right)))));

/** Only adjacent, empty transport segments of the same native invocation combine. */
export function coalesceTransportWaitMembers<T extends Member>(members:readonly T[]):T[]{
  const result:T[]=[];
  for(const member of members){
    const previous=result.at(-1),before=previous&&wait(previous),after=wait(member);
    const left=previous?.transportSegment,right=member.transportSegment;
    if(!previous||!before||!after||!left||!right||before.payload.state!=='none'||left.chainKey!==right.chainKey||targetKey(before)!==targetKey(after)||right.start!==left.end+1||left.seconds<=0||right.seconds<=0){result.push(member);continue;}
    const seconds=sumSeconds(left.seconds,right.seconds);
    const merged:CompactOperationObservation={...after,timing:{elapsedSeconds:seconds,scope:'wrapper'}};
    const sourcePositions=[...new Set([...previous.sourcePositions,...member.sourcePositions])];
    const sources=[...(previous.sources??[]),...(member.sources??[])];
    const keys=[...new Set([...(previous.disclosures?.keys??[]),...(member.disclosures?.keys??[])])];
    const firstItem=previous.node?.kind==='activity'?previous.node.item:previous.activity;
    const lastItem=member.node?.kind==='activity'?member.node.item:member.activity;
    const activity=firstItem?.type==='tool-call-activity'&&lastItem?.type==='tool-call-activity'?{...firstItem,result:lastItem.result,observation:merged,executionEvidence:merged.execution}:previous.activity;
    const facts=member.activityFacts??(activity?activitySemanticFacts(activity):undefined);
    const sourceBlockId=previous.node?.kind==='activity'?previous.node.source?.blockId:undefined;
    const node=previous.node?.kind==='activity'&&activity?{...previous.node,item:activity,sourceAliases:sources.filter(source=>source.blockId!==sourceBlockId),disclosureAliases:keys.slice(1)}:previous.node;
    result[result.length-1]={...previous,activity,activityFacts:facts?.kind==='tool'?{...facts,observation:merged}:facts,
      transportSegment:{...left,seconds,end:right.end},sourcePositions,
      handoffKeys:[...new Set([...previous.handoffKeys,member.key,...member.handoffKeys])],
      handoffCoordinates:[...(previous.handoffCoordinates??[]),...(member.handoffCoordinates??[]),...(member.position===undefined?[]:[member.key,...member.handoffKeys].map(key=>({key,position:member.position!})))],
      dependencyRevision:JSON.stringify([previous.dependencyRevision,member.dependencyRevision]),
      disclosures:{...previous.disclosures,keys,prefixes:[...new Set([...(previous.disclosures?.prefixes??[]),...(member.disclosures?.prefixes??[])])]},
      ...(node?{node}:{}),...(previous.sources?{sources}:{}),
    };
  }
  return result;
}
