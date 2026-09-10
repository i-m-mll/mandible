import type { ProviderAdapterEvent, ProviderLiveProjection } from "./types.js";

export function emptyProviderLiveProjection(conversationId: string): ProviderLiveProjection {
  return { conversation_id: conversationId, revision: 0, events: [] };
}

export function providerAdapterEventKey(event: ProviderAdapterEvent): string {
  if (event.kind === "provisional-content") return `content:${event.identity}`;
  if (event.kind === "durable-reconciliation") return `reconciliation:${event.provider_event_id}`;
  return `lineage:${event.provider_event_id}:${event.receiver_provider_session_id}`;
}

export function mergeProviderLiveProjection(
  current: ProviderLiveProjection | null,
  event: ProviderAdapterEvent,
  limit = 256,
): ProviderLiveProjection {
  const base = current?.conversation_id === event.conversation_id
    ? current
    : emptyProviderLiveProjection(event.conversation_id);
  if (event.kind === "durable-reconciliation") {
    const covered = new Set(event.covered_identities);
    const events = base.events.filter((candidate) => candidate.kind !== "provisional-content" || !covered.has(candidate.identity));
    return events.length === base.events.length ? base : {
      conversation_id: event.conversation_id,
      revision: base.revision + 1,
      events,
    };
  }
  const key = providerAdapterEventKey(event);
  const prior = base.events.find((candidate) => providerAdapterEventKey(candidate) === key);
  const providerAcknowledgesOptimisticIntent = prior?.kind === "provisional-content"
    && event.kind === "provisional-content"
    && !prior.correlation
    && Boolean(event.correlation);
  if (prior && (
    prior.generation > event.generation
    || (prior.generation === event.generation && prior.sequence >= event.sequence)
  ) && !providerAcknowledgesOptimisticIntent) return base;
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
