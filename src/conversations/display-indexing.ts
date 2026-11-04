import { reasoningEquivalence } from '../presentation/reasoning-equivalence.js';
import { framedToolResult, projectNativeToolResult } from '../presentation/tool-transport.js';
import { inlineActivityKeyParts } from '../presentation/reading-disclosures.js';
import { chatItemIdentityRecipe } from './index-keys.js';
import { compactActivityFacts } from './conversation-index.js';
import type { IndexKeyRecipe, IndexWriteBatch } from './conversation-index.js';
import { toolObservation, operationObservationForTool } from '../presentation/tool-observation.js';
import { extractToolResultText } from '../presentation/model.js';
import { projectExecution } from '../presentation/execution-presentation.js';
import {isRoutineActivityStatus} from '../presentation/model.js';
import { createHash } from 'node:crypto';
import { readingSpeaker } from './reading-context.js';
import { defaultDisplayEventsFromBlocks, displayFragmentId } from './display-context.js';
import { projectDisplayFragments } from '../presentation/fragments.js';
import { presentActivityItems, activityDetailLines } from '../presentation/activity-presentation.js';
import type { ConversationBlock } from '../parsers/types.js';

export function indexDisplayFragments(blocks: readonly Omit<ConversationBlock, 'id' | 'conversation_id'>[],
  conversationId: string, parentPosition: (position: number) => number | null): IndexWriteBatch {
  const events = defaultDisplayEventsFromBlocks(blocks.map(block => ({ ...block, parentPosition: parentPosition(block.position) })), conversationId);
  const sourceByPosition=new Map(blocks.map(block=>[block.position,block]));
  const fragments = projectDisplayFragments(events, true).flatMap(fragment => {
    if (fragment.position === undefined) return [];
    const node = fragment.node;
    const coordinate = { position: fragment.position, part: fragment.part };
    const activity = node.kind === 'activity' ? node.item : null;
    const presentations = activity ? presentActivityItems([activity]) : [];
    let compact = activity;
    if (activity?.type === 'tool-call-activity') {
      const operation=activity.operationContext;
      const name=operation?.name ?? activity.name, input=operation?.input as Record<string,unknown> | string | undefined ?? activity.input, kind=operation?.kind ?? activity.toolKind;
      const execution=projectExecution(name,input,kind);
      const result=activity.result;
      const observation=toolObservation(name,input,kind,result ? {text:result.fullText ?? extractToolResultText(result.content),content:result.content,frame:result.source?.toolFrame,native:result.presentation,failed:result.is_error} : undefined);
      const projected=observation.result;
      const {children:_children,...header}=observation.header;
      header.target=['execute','javascript'].includes(header.category) || header.target.length>256 ? '' : header.target;
      const {operationContext:_operationContext,...bounded}=activity;
      const source=result?.source ? {...result.source,toolOperation:undefined} : undefined;
      compact={...bounded,observation:operationObservationForTool(activity),header,execution:execution?.facts,operations:observation.header.operations,input:'',result:result ? {...result,source,content:'',fullText:undefined,presentation:undefined,is_error:result.is_error || projected?.failed,running:activity.executionEvidence ? activity.executionEvidence.state==='ongoing' : projected?.running} : null};
    }
    else if (activity?.type === 'thinking-block-activity') compact = { ...activity, content: '' };
    else if (activity?.type === 'provider-directive') compact = { ...activity, directive: activity.directive.kind === 'memory-citation'
      ? { kind: 'memory-citation', citations: [], rolloutIds: [] } : { ...activity.directive } };
    else if (activity?.type === 'activity') compact = { ...activity, parts: [] };
    const facts=compact?compactActivityFacts(compact):null;
    const native=sourceByPosition.get(fragment.position);
    if(facts&&native?.metadata.chat_item&&(activity?.type==='thinking-block-activity'||(activity?.type==='activity'&&['thinking','reasoning-summary'].includes(activity.activity_kind))))facts.reasoningEquivalence=reasoningEquivalence(native.metadata.chat_item,activity.type==='thinking-block-activity'?[activity.content]:activity.parts.map(part=>part.text),native.metadata.display_reasoning_turn_id);
    return [{ id: displayFragmentId(coordinate), coordinate, kind: activity ? 'activity' as const : 'content' as const,
      activity_run_id: null, paired_source_positions: fragment.pairedSourcePositions,
      summary_eligible: !(activity?.type === 'activity' && isRoutineActivityStatus(activity, node.kind === 'activity' && node.source?.hasBody)),
      speaker: node.entity, disclosureRecipes: sourceDisclosures(node,fragment.position), activity:facts, summary_from_source: activity?.type === 'activity' && activity.parts.some(part => Boolean(part.text.trim())),
      has_details: activityDetailLines(presentations).length > 0 }];
  });
  const aliases = blocks.flatMap(block => {
    const parent = parentPosition(block.position);
    return block.type === 'tool_result' && parent !== null ? [{ position: block.position, owner_position: parent,
      failed: block.metadata.display_tool_error === true || block.metadata.chat_item?.execution_outcome === 'failed',
      receipt:{scope:block.metadata.chat_item?{provider:block.metadata.chat_item.identity.provider,sessionId:block.metadata.chat_item.identity.session_id}:undefined,result:(()=>{const item=block.metadata.chat_item;const native=item?.type==='tool-call'?projectNativeToolResult(item.output,block.content,item.tool_kind,item.tool_name,item.tool_id):undefined;
        const context=block.metadata.display_tool_operation;
        return context?toolObservation(context.name,context.input as Record<string,unknown>|string,context.kind,{text:native?.text??block.content,frame:block.metadata.display_tool_frame,native,failed:block.metadata.display_tool_error===true}).result!:
          native?.decoded?native:framedToolResult(native?.text??block.content,block.metadata.display_tool_frame);})(),execution:block.metadata.display_tool_execution,
        ...(block.metadata.display_tool_targets ? {targets:block.metadata.display_tool_targets} : {})} }] : [];
  });
  const positions = blocks.map(block => {
    const item = block.metadata.chat_item;
    const usage = block.metadata.token_usage;
    return { position: block.position, speaker: readingSpeaker(block.role), revision: createHash('sha256').update(JSON.stringify([
      block.type, block.role, block.content, block.timestamp, block.metadata, parentPosition(block.position),
    ])).digest('hex'), handoff: [...(item ? [chatItemIdentityRecipe(item,{allowTranscriptCoordinates:true})].filter((key):key is IndexKeyRecipe=>key!==null) : []),...(block.metadata.client_intent_id ? [{kind:'intent' as const,id:block.metadata.client_intent_id}] : [])],
      turnId: item?.identity.native_turn_id,
      ...(block.metadata.display_tool_origin ? {presentationDependencies:[block.metadata.display_tool_origin.position]} : {}),
      ...(item?.type==='message'&&item.role==='assistant' ? {response:{identity:item.provenance.source==='verified-provider-transcript' ? {kind:'response-record' as const,provider:item.identity.provider,sessionId:item.identity.session_id,recordOrdinal:item.identity.source_record_ordinal} : {kind:'response-native' as const,provider:item.identity.provider,sessionId:item.identity.session_id,turnId:item.identity.native_turn_id??null,nativeId:item.identity.native_item_id??null},classification:item.content_completion==='complete'?item.assistant_response??'unknown':'unknown'}} : {}),
      ...(item?.type === 'tool-call' && (item.tool_id ?? item.identity.native_tool_id) ? {execution: {kind:'execution' as const,provider:item.identity.provider,sessionId:item.identity.session_id,nativeId:(item.tool_id ?? item.identity.native_tool_id)!}} : {}),
      ...(item && usage && Number.isFinite(usage.input) && Number.isFinite(usage.output)
        ? { usage: { key: typeof block.metadata.provider_message_id === 'string' ? block.metadata.provider_message_id : `record:${item.identity.source_record_ordinal}`,
          input: usage.input, output: usage.output } } : {}) };
  });
  return { fragments, aliases, positions };
}

/** Source-backed nodes use the same explicit constructors as their hydrated disclosures. */
function sourceDisclosures(node:import('../presentation/types.js').RenderNode,position:number):NonNullable<IndexWriteBatch['fragments'][number]['disclosureRecipes']> {
  const source=(prefix?:string,suffix?:string):IndexKeyRecipe=>({kind:'source',position,prefix,suffix});
  const nodeSource=node.kind==='user_message'?node.persisted:node.kind==='activity'?node.source:undefined;
  const nativeNode=(suffix?:string):IndexKeyRecipe=>nodeSource&&node.key===nodeSource.blockId?source(undefined,suffix):{kind:'native',value:node.key,suffix};
  switch(node.kind) {
    case 'activity': {
      if(node.item.type==='provider-directive'&&node.item.directive.kind==='created-thread')return {keys:[],prefixes:[]};
      let key:IndexKeyRecipe;
      if(node.item.type==='thinking-block-activity'||node.item.type==='provider-directive') {
        if(!node.inlineIdentity)throw new Error('Inline activity omitted its projected turn identity');
        const {prefix,suffix}=inlineActivityKeyParts(node.inlineIdentity);
        key=source('activity:'+prefix,suffix||undefined);
      } else key=source('activity:');
      return {keys:[key],prefixes:node.item.type==='tool-call-activity'?[source('activity:',':operation:')]:[],...(node.item.type==='thinking-block-activity'?{thinkingDefaults:[{key,turnId:node.item.turnId}]}:{})};
    }
    case 'semantic_event':return {keys:[source('semantic:')],prefixes:[]};
    case 'unmatched_tool_result':return {keys:[source('unmatched-tool-result:')],prefixes:[]};
    case 'user_message':return {keys:[],prefixes:[source(undefined,':')]};
    case 'assistant_turn':return {keys:[source()],prefixes:[node.key===node.turn.assistantEvent.message.content[0]?.source?.blockId?source(undefined,':'):nativeNode(':')]};
    case 'transcript_boundary':throw new Error('Transcript boundary is not a source fragment');
  }
}
