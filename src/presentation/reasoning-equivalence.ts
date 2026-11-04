import { hash } from 'fast-sha256';
import type { ChatItem } from '../parsers/types.js';
import { presentReasoning } from './activity-presentation.js';
import type { ReadingPlanMember } from './reading-plan.js';
import type { PersistedBlockSource, RenderNode } from './types.js';

type ReasoningPrefixFingerprint={scope:string;lines:string[]};
const hex=(value:Uint8Array):string=>Array.from(value,byte=>byte.toString(16).padStart(2,'0')).join('');
const digest=(value:string):Uint8Array=>hash(new TextEncoder().encode(value));
export function decodeReasoningFingerprint(value:string):ReasoningPrefixFingerprint {
  if(!/^[0-9a-f]+$/.test(value)||value.length%2||value.slice(0,2)!=='01')throw Error('Invalid reasoning fingerprint version');
  const count=Number.parseInt(value.slice(2,6),16);
  if(count<1||count>256||value.length!==(35+32*count)*2)throw Error('Invalid reasoning fingerprint length');
  return {scope:value.slice(6,70),lines:Array.from({length:count},(_,index)=>value.slice(70+index*64,134+index*64))};
}
export function reasoningEquivalence(item:ChatItem,parts:readonly string[],turnHint?:string):string|undefined {
  const turn=item.identity.native_turn_id??turnHint;
  if(!turn)return undefined;
  const lines=parts.join('\n').replace(/\r\n?/g,'\n').split('\n').filter(line=>line.trim().length>0);
  if(!lines.length||lines.length>256)return undefined;
  const scope=digest(JSON.stringify(['reasoning-prefix-v1',item.identity.provider,item.identity.session_id,item.role,turn,presentReasoning(parts).summary]));
  const bytes=new Uint8Array(35+32*lines.length);bytes[0]=1;bytes[1]=lines.length>>8;bytes[2]=lines.length&255;bytes.set(scope,3);
  lines.forEach((line,index)=>bytes.set(digest(line),35+index*32));
  return hex(bytes);
}
function extendsReasoning(previous:string,current:string):boolean {
  const before=decodeReasoningFingerprint(previous),after=decodeReasoningFingerprint(current);
  return before.scope===after.scope&&before.lines.length<=after.lines.length&&before.lines.every((line,index)=>line===after.lines[index]);
}

type ReasoningCoordinate={equivalence?:string;position?:number;ordinal?:number};
export function adjacentReasoningGroups<T>(members:readonly T[],coordinate:(member:T)=>ReasoningCoordinate):Array<{first:T;members:T[]}> {
  const groups:Array<{first:T;members:T[]}>=[];
  let previous:ReasoningCoordinate|undefined;
  for(const member of members){const current=coordinate(member),last=groups.at(-1);
    const adjacent=previous&&((current.position!==undefined&&previous.position!==undefined&&current.position===previous.position+1)
      ||(current.position===undefined&&previous.position===undefined&&current.ordinal!==undefined&&previous.ordinal!==undefined&&current.ordinal===previous.ordinal+1));
    if(last&&adjacent&&current.equivalence&&previous?.equivalence&&extendsReasoning(previous.equivalence,current.equivalence))last.members.push(member);
    else groups.push({first:member,members:[member]});
    previous=current;
  }
  return groups;
}

type CoalescibleMember=ReadingPlanMember&{eventOrdinal?:number;node?:RenderNode;sources?:readonly PersistedBlockSource[]};
export function coalesceAdjacentReasoningMembers<T extends CoalescibleMember>(members:readonly T[]):T[] {
  return adjacentReasoningGroups(members,member=>({equivalence:member.activityFacts?.reasoningEquivalence,position:member.position,ordinal:member.eventOrdinal})).map(({first:initial,members})=>{
    const representative=members.at(-1)??initial;
    if(members.length===1)return representative;
    const sourcePositions=[...new Set(members.flatMap(member=>member.sourcePositions))];
    const keys=[...new Set([...(representative.disclosures?.keys??[]),...members.flatMap(member=>member.disclosures?.keys??[])])];
    const sources=members.flatMap(member=>member.sources??[]);
    const primarySource=representative.node?.kind==='activity'?representative.node.source:undefined;
    const node=representative.node?.kind==='activity'?{...representative.node,sourceAliases:sources.filter(source=>source.blockId!==primarySource?.blockId),disclosureAliases:keys.slice(1)}:representative.node;
    return {...representative,sourcePositions,handoffKeys:[...new Set(members.flatMap(member=>[member.key,...member.handoffKeys]))],
      handoffCoordinates:members.flatMap(member=>[...(member.handoffCoordinates??[]),...(member.position===undefined?[]:[member.key,...member.handoffKeys].map(key=>({key,position:member.position!})))]),
      dependencyRevision:JSON.stringify(members.map(member=>member.dependencyRevision)),
      ...(representative.disclosures?{disclosures:{...representative.disclosures,keys}}:{}),...(node?{node}:{}),...(representative.sources?{sources}:{}),
    };
  });
}
