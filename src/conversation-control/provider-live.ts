import { chatItemIdentityRecipe, indexKeyString } from '../conversations/index-keys.js';
import type { ProviderAdapterEvent, ProviderLiveProjection } from "./types.js";
import type { ChatItem } from "../parsers/types.js";

export function emptyProviderLiveProjection(conversationId: string): ProviderLiveProjection {
  return { conversation_id: conversationId, revision: 0, generation: 0, events: [] };
}

/** Native identity wins; transcript coordinates are a durable-only fallback. */
export function chatItemIdentityKey(item:ChatItem,options:{allowTranscriptCoordinates?:boolean}={}):string|null {
  const recipe=chatItemIdentityRecipe(item,options);
  return recipe?indexKeyString(recipe,''):null;
}

export function providerAdapterEventKey(event: ProviderAdapterEvent): string {
  if (event.kind === "provisional-content") return `content:${event.identity}`;
  if (event.kind === "durable-reconciliation") return `reconciliation:${event.provider_event_id}`;
  return `retirement:${event.provider_event_id}`;
}

export function mergeProviderLiveProjection(
  current: ProviderLiveProjection | null,
  event: ProviderAdapterEvent,
): ProviderLiveProjection {
  const base = current?.conversation_id === event.conversation_id
    ? current
    : emptyProviderLiveProjection(event.conversation_id);
  if (event.generation < base.generation) return base;
  const generationChanged = event.generation > base.generation;
  const generationBase: ProviderLiveProjection = event.generation > base.generation
    ? {
        conversation_id: event.conversation_id,
        revision: base.revision,
        generation: event.generation,
        events: base.events,
      }
    : base;
  // Disconnect and ownership changes stop execution, not content custody.
  if (event.kind === "durable-reconciliation") {
    const covered = new Set(event.covered_identities);
    const events = generationBase.events.filter((candidate) => candidate.kind !== "provisional-content" || !covered.has(candidate.identity));
    return events.length === generationBase.events.length && !generationChanged ? generationBase : {
      conversation_id: event.conversation_id,
      revision: generationBase.revision + 1,
      generation: generationBase.generation,
      events,
    };
  }
  if (event.kind === "provisional-content") {
    const identity = chatItemIdentityKey(event.item);
    if (identity === null
        || identity !== event.identity
        || event.item.provenance.source !== "live-provider-event"
        || event.item.identity.provider !== event.item.provenance.provider
        || event.item.identity.session_id !== event.provider_session_id) return generationBase;
  }
  const key = providerAdapterEventKey(event);
  const priorIndex = generationBase.events.findIndex((candidate) => providerAdapterEventKey(candidate) === key);
  const prior = priorIndex < 0 ? undefined : generationBase.events[priorIndex];
  const providerAcknowledgesOptimisticIntent = prior?.kind === "provisional-content"
    && event.kind === "provisional-content"
    && !prior.correlation
    && Boolean(event.correlation);
  if (prior && (
    prior.generation > event.generation
    || (prior.generation === event.generation && prior.sequence >= event.sequence)
  ) && !providerAcknowledgesOptimisticIntent) return generationBase;
  if (prior?.kind === "provisional-content" && event.kind === "provisional-content"
      && JSON.stringify(prior.item) === JSON.stringify(event.item)
      && JSON.stringify(prior.correlation) === JSON.stringify(event.correlation)) return generationBase;
  const intentId = event.kind === "provisional-content" ? event.correlation?.intent_id : undefined;
  const optimisticIndex = intentId
    ? generationBase.events.findIndex((candidate) => candidate.kind === "provisional-content"
      && candidate.item.provenance.source_event_type === "optimistic-user-prompt"
      && candidate.item.identity.native_item_id === intentId) : -1;
  const optimistic = generationBase.events[optimisticIndex];
  const events = generationBase.events.filter((candidate) => !(event.kind === "provisional-content"
    && event.correlation && candidate.kind === "provisional-content"
    && candidate.item.provenance.source_event_type === "optimistic-user-prompt"
    && candidate.item.identity.native_item_id === event.correlation.intent_id));
  const retainedIndex = events.findIndex((candidate) => providerAdapterEventKey(candidate) === key);
  if (prior?.kind === "provisional-content" && event.kind === "provisional-content") {
    event = { ...event, observed_at: prior.observed_at, item: { ...prior.item, ...event.item } as ChatItem };
  }
  if (optimistic && event.kind === "provisional-content") event = { ...event, observed_at: optimistic.observed_at };
  if (retainedIndex >= 0) events[retainedIndex] = event;
  else if (optimisticIndex >= 0) events.splice(optimisticIndex, 0, event);
  else events.push(event);
  return {
    conversation_id: event.conversation_id,
    revision: generationBase.revision + 1,
    generation: generationBase.generation,
    events,
  };
}
