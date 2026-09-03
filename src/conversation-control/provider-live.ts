import type { ProviderAdapterEvent, ProviderLiveProjection } from "./types.js";

export function emptyProviderLiveProjection(conversationId: string): ProviderLiveProjection {
  return { conversation_id: conversationId, revision: 0, events: [] };
}

export function providerAdapterEventKey(event: ProviderAdapterEvent): string {
  return event.kind === "provisional-content"
    ? `content:${event.identity}`
    : `lineage:${event.provider_event_id}:${event.receiver_provider_session_id}`;
}

export function mergeProviderLiveProjection(
  current: ProviderLiveProjection | null,
  event: ProviderAdapterEvent,
  limit = 256,
): ProviderLiveProjection {
  const base = current?.conversation_id === event.conversation_id
    ? current
    : emptyProviderLiveProjection(event.conversation_id);
  const key = providerAdapterEventKey(event);
  const prior = base.events.find((candidate) => providerAdapterEventKey(candidate) === key);
  if (prior && (
    prior.generation > event.generation
    || (prior.generation === event.generation && prior.sequence >= event.sequence)
  )) return base;
  const events = base.events
    .filter((candidate) => providerAdapterEventKey(candidate) !== key)
    .concat(event)
    .sort((left, right) => left.generation - right.generation || left.sequence - right.sequence)
    .slice(-limit);
  return {
    conversation_id: event.conversation_id,
    revision: base.revision + 1,
    events,
  };
}
