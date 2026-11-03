import { hash } from 'fast-sha256';
import type { ChatItem } from '../parsers/types.js';
import { presentReasoning } from './activity-presentation.js';
import type { ReadingPlanMember } from './reading-plan.js';
import type { PersistedBlockSource, RenderNode } from './types.js';

export function reasoningEquivalence(item:ChatItem,parts:readonly string[],turnHint?:string):string|undefined {
  const turn=item.identity.native_turn_id??turnHint;
  if(!turn)return undefined;
  const payload=JSON.stringify(['reasoning-display-v1',item.identity.provider,item.identity.session_id,item.role,turn,presentReasoning(parts)]);
  return Array.from(hash(new TextEncoder().encode(payload)),byte=>byte.toString(16).padStart(2,'0')).join('');
}

type ReasoningCoordinate={equivalence?:string;position?:number;ordinal?:number};
export function adjacentReasoningGroups<T>(members:readonly T[],coordinate:(member:T)=>ReasoningCoordinate):Array<{first:T;members:T[]}> {
  const groups:Array<{first:T;members:T[]}>=[];
  let previous:ReasoningCoordinate|undefined;
  for(const member of members){const current=coordinate(member),last=groups.at(-1);
    const adjacent=previous&&((current.position!==undefined&&previous.position!==undefined&&current.position===previous.position+1)
      ||(current.position===undefined&&previous.position===undefined&&current.ordinal!==undefined&&previous.ordinal!==undefined&&current.ordinal===previous.ordinal+1));
    if(last&&adjacent&&current.equivalence&&current.equivalence===previous?.equivalence)last.members.push(member);
    else groups.push({first:member,members:[member]});
    previous=current;
  }
  return groups;
}

type CoalescibleMember=ReadingPlanMember&{eventOrdinal?:number;node?:RenderNode;sources?:readonly PersistedBlockSource[]};
export function coalesceAdjacentReasoningMembers<T extends CoalescibleMember>(members:readonly T[]):T[] {
  return adjacentReasoningGroups(members,member=>({equivalence:member.activityFacts?.reasoningEquivalence,position:member.position,ordinal:member.eventOrdinal})).map(({first,members})=>{
    if(members.length===1)return first;
    const sourcePositions=[...new Set(members.flatMap(member=>member.sourcePositions))];
    const keys=[...new Set(members.flatMap(member=>member.disclosures?.keys??[]))];
    const sources=members.flatMap(member=>member.sources??[]);
    const primarySource=first.node?.kind==='activity'?first.node.source:undefined;
    const node=first.node?.kind==='activity'?{...first.node,sourceAliases:sources.filter(source=>source.blockId!==primarySource?.blockId),disclosureAliases:keys.slice(1)}:first.node;
    return {...first,sourcePositions,handoffKeys:[...new Set(members.flatMap(member=>[member.key,...member.handoffKeys]))],
      handoffCoordinates:members.flatMap(member=>[...(member.handoffCoordinates??[]),...(member.position===undefined?[]:[member.key,...member.handoffKeys].map(key=>({key,position:member.position!})))]),
      dependencyRevision:JSON.stringify(members.map(member=>member.dependencyRevision)),
      ...(first.disclosures?{disclosures:{...first.disclosures,keys}}:{}),...(node?{node}:{}),...(first.sources?{sources}:{}),
    };
  });
}
