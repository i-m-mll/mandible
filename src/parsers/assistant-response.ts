import type { AssistantResponseClassification, ChatItem } from './types.js';

export function codexAssistantResponse(phase: unknown): AssistantResponseClassification {
  return phase === 'final' || phase === 'final_answer' ? 'final'
    : phase === 'commentary' || phase === 'partial_answer' ? 'interim' : 'unknown';
}

export function claudeAssistantResponse(stopReason: unknown): AssistantResponseClassification {
  return stopReason === 'end_turn' ? 'final'
    : stopReason === 'tool_use' || stopReason === 'max_tokens' || stopReason === 'stop_sequence' ? 'interim' : 'unknown';
}

export type AssistantResponseMembership = { key: string; classification: AssistantResponseClassification };

/** Content indexes identify siblings within a response, rather than separate responses. */
export function assistantResponseMembership(item: ChatItem): AssistantResponseMembership | undefined {
  if (item.type !== 'message' || item.role !== 'assistant') return undefined;
  const identity = item.identity;
  return { key: JSON.stringify([identity.provider, identity.session_id,
    item.provenance.source === 'verified-provider-transcript' ? ['record', identity.source_record_ordinal]
      : ['native', identity.native_turn_id ?? null, identity.native_item_id]]),
    classification: item.content_completion === 'complete' ? item.assistant_response ?? 'unknown' : 'unknown' };
}
