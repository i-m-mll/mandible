import type { ProviderAdapterEvent, ProviderLiveProjection } from "./types.js";
import type { ChatItem, ChatItemIdentity } from "../parsers/types.js";

export function emptyProviderLiveProjection(conversationId: string): ProviderLiveProjection {
  return { conversation_id: conversationId, revision: 0, generation: 0, events: [] };
}

function itemKind(item: ChatItem): string {
  if (item.type === "message") return `message:${item.role}`;
  if (item.type === "activity") return `activity:${item.activity_kind}`;
  if (item.type === "tool-call") return `tool-call:${item.phase}`;
  return item.type;
}

/**
 * Return the only identity accepted for live reconciliation. Native provider
 * identity wins; verified transcript coordinates are a durable-only fallback.
 */
export function chatItemIdentityKey(
  item: ChatItem,
  options: { allowTranscriptCoordinates?: boolean } = {},
): string | null {
  if (!item || typeof item !== "object" || !item.identity || !item.provenance) return null;
  const identity: ChatItemIdentity = item.identity;
  if (!identity.provider || !identity.session_id || !item.type) return null;
  if (identity.native_content_index !== undefined
      && (!Number.isInteger(identity.native_content_index) || identity.native_content_index < 0)) return null;
  const prefix = [identity.provider, identity.session_id, itemKind(item)];
  const content = identity.native_content_index ?? null;
  const toolId = item.type === "tool-call" ? item.tool_id ?? identity.native_tool_id : undefined;
  if (toolId) return JSON.stringify([...prefix, "tool", toolId, null]);
  if (identity.native_item_id) return JSON.stringify([...prefix, "item", identity.native_item_id, content]);
  if (identity.native_tool_id) return JSON.stringify([...prefix, "tool", identity.native_tool_id, content]);
  if (identity.native_turn_id && identity.native_content_index !== undefined) return JSON.stringify([...prefix, "turn", identity.native_turn_id, content]);
  if (!options.allowTranscriptCoordinates) return null;
  if (!Number.isInteger(identity.source_record_ordinal) || identity.source_record_ordinal < 0
      || !Number.isInteger(identity.source_sub_block_ordinal) || identity.source_sub_block_ordinal < 0) return null;
  return JSON.stringify([...prefix, "record", identity.source_record_ordinal, identity.source_sub_block_ordinal]);
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
