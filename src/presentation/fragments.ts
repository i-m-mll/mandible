import { buildStreamState, expandInlineActivities } from './model.js';
import { chatItemIdentityKey } from '../conversation-control/provider-live.js';
import type { CanonicalChatItemEvent, ContentBlock, PersistedBlockSource, RenderNode, StreamEvent } from './types.js';

export type DisplayFragmentCoordinate = { position: number; part: string };
export type DisplayFragment = {
  part: string;
  memberKey: string;
  position?: number;
  node: RenderNode;
  pairedSourcePositions: number[];
};

/** Exact semantic pairing/expansion followed by source-boundary splitting for measured members. */
export function projectDisplayFragments(events: readonly StreamEvent[]): DisplayFragment[] {
  const sources = new Map<string, PersistedBlockSource>();
  for (const event of events) {
    if (event.type !== 'chat:item') continue;
    const canonical = event as CanonicalChatItemEvent;
    const native = chatItemIdentityKey(canonical.item, { allowTranscriptCoordinates: true });
    const key = canonical.displayKey ?? native;
    if (canonical.source) {
      if (key) sources.set(key, canonical.source);
      sources.set(canonical.source.blockId, canonical.source);
    }
  }
  const nodes = expandInlineActivities(buildStreamState([...events]).nodes);
  const fragments: DisplayFragment[] = [];
  const ordinals = new Map<string, number>();
  const emit = (node: RenderNode, source: PersistedBlockSource | undefined, kind: string, paired: number[] = [], memberKey = node.key): void => {
    const owner = source?.blockId ?? memberKey;
    const discriminator = `${owner}:${kind}`;
    const ordinal = ordinals.get(discriminator) ?? 0;
    ordinals.set(discriminator, ordinal + 1);
    const part = `${kind}:${ordinal}`;
    fragments.push({ part, memberKey, position: source?.position, node, pairedSourcePositions: paired });
  };
  for (const node of nodes) {
    if (node.kind === 'transcript_boundary') continue;
    if (node.kind === 'assistant_turn') {
      for (const block of node.turn.assistantEvent.message.content) {
        const source = block.source ?? (block.contentKey ? sources.get(block.contentKey) : undefined);
        const content = { ...block, source } as ContentBlock;
        emit({ ...node, turn: { ...node.turn, assistantEvent: { ...node.turn.assistantEvent,
          message: { ...node.turn.assistantEvent.message, content: [content] } } } }, source, 'content', [], block.contentKey ?? node.key);
      }
    } else if (node.kind === 'activity') {
      const source = node.source ?? (node.item.type === 'provider-directive' && node.item.blockId
        ? sources.get(node.item.blockId) : sources.get(node.key));
      const paired = node.item.type === 'tool-call-activity' && node.item.result?.source?.position !== undefined
        ? [node.item.result.source.position] : [];
      const kind = node.item.type === 'provider-directive' ? 'directive' : node.item.type === 'tool-call-activity' ? 'tool' : 'activity';
      emit({ ...node, source }, source, kind, paired, node.memberKey ?? node.key);
    } else if (node.kind === 'user_message') emit(node, node.persisted, 'content');
    else if (node.kind === 'semantic_event') emit(node, node.event.source, 'content');
    else emit(node, node.result.source, 'content');
  }
  return fragments;
}
