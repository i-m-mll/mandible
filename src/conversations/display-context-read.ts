import { DISPLAY_CONTEXT_VERSION, displaySummaryMembers, defaultDisplayEventsFromBlocks, displayFragmentId, type ConversationDisplayContext } from './display-context.js';
import type { DisplayContextPlan } from './display-index.js';
import { ConversationSourceReader } from './source-reader.js';
import type { SourceBackedConversationBlock, SourceReadResult } from './source-types.js';
import { projectDisplayFragments } from '../presentation/fragments.js';
import { activityRunFacts, presentActivityRunFacts } from '../presentation/activity-presentation.js';
import { presentTool } from '../presentation/tool-presentation.js';
import { sparseConversationBlockPosition } from './structure-cache.js';

/** Body-derived presentation is ephemeral and proved against the same native source snapshot. */
export async function readDisplayContext(input: {
  plan: DisplayContextPlan; conversationId: string; sourceVersionId: string; blockCount: number;
  reader: ConversationSourceReader; sourceBlocks?: readonly SourceBackedConversationBlock[]; actionScope: (position: number) => { start: number; end: number };
}): Promise<SourceReadResult<ConversationDisplayContext>> {
  const { plan, conversationId, sourceVersionId } = input;
  const read = input.sourceBlocks ? {status: 'source' as const, sourceVersionId, value: input.sourceBlocks} : plan.sourcePositions.length ? await input.reader.readPositions(conversationId, plan.sourcePositions,
    { expectedSourceVersionId: sourceVersionId, expectedBlockCount: input.blockCount }) : null;
  if (read && read.status !== 'source') return read;
  const blocks = read?.status === 'source' ? read.value : [];
  const events = defaultDisplayEventsFromBlocks(blocks.map(block => ({ ...block, metadata: JSON.parse(block.metadata_json),
    parentPosition: block.parent_id ? sparseConversationBlockPosition(conversationId, block.parent_id) : null })), conversationId);
  const actual = new Map(projectDisplayFragments(events).filter(fragment => fragment.position !== undefined)
    .map(fragment => [displayFragmentId({ position: fragment.position!, part: fragment.part }), fragment]));
  const activity_runs = [...plan.runs].map(([id, members]) => {
    const items = displaySummaryMembers(members).flatMap(member => {
      const hydrated = actual.get(member.id)?.node;
      const item = hydrated?.kind === 'activity' && member.summary_from_source ? hydrated.item : member.activity;
      return item ? [item] : [];
    });
    const facts = activityRunFacts(items);
    facts.hasDetails ||= members.some(member => member.has_details);
    return { id, first: members[0].coordinate, last: members[members.length - 1].coordinate,
      member_count: members.length, presentation: { ...presentActivityRunFacts(facts), facts } };
  });
  const owners: ConversationDisplayContext['owners'] = [];
  for (const owner of plan.ownerFragments) {
    const fragment = actual.get(owner.id);
    if (fragment?.node.kind !== 'activity' || fragment.node.item.type !== 'tool-call-activity') {
      return { status: 'stale', reason: 'Display owner no longer matches the indexed source fragment.' };
    }
    const { input: toolInput, result: _result, ...item } = fragment.node.item;
    owners.push({ fragment_id: owner.id, memberKey: fragment.memberKey, coordinate: owner.coordinate, item,
      source: { ...fragment.node.source!, detailsLoaded: false },
      header: item.operationContext ? presentTool(item.operationContext.name,item.operationContext.input as Record<string,unknown> | string,item.operationContext.kind) : presentTool(item.name, toolInput, item.toolKind), action_scope: input.actionScope(owner.coordinate.position) });
  }
  return { status: 'source', sourceVersionId, value: { version: DISPLAY_CONTEXT_VERSION,
    fragments: plan.fragments, aliases: plan.aliases, activity_runs, owners } };
}
