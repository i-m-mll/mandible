import type { ProviderAdapterEvent, ProviderLiveProjection } from "./types.js";
import type { ChatItem, ChatItemIdentity } from "../parsers/types.js";

export function emptyProviderLiveProjection(conversationId: string): ProviderLiveProjection {
  return { conversation_id: conversationId, revision: 0, generation: 0, events: [] };
}

function itemKind(item: ChatItem): string {
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
  if (identity.native_item_id) return JSON.stringify([...prefix, "item", identity.native_item_id, content]);
  if (identity.native_tool_id) return JSON.stringify([...prefix, "tool", identity.native_tool_id, content]);
  if (identity.native_turn_id) return JSON.stringify([...prefix, "turn", identity.native_turn_id, content]);
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
  limit = 256,
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
        events: [],
      }
    : base;
  if (event.kind === "transient-retirement") {
    if (!generationChanged && generationBase.events.length === 0) return generationBase;
    return {
      conversation_id: event.conversation_id,
      revision: generationBase.revision + 1,
      generation: Math.max(generationBase.generation, event.generation),
      events: [],
    };
  }
  if (event.kind === "durable-reconciliation") {
    const covered = new Set([
      ...event.covered_identities,
      ...(event.terminal_retired_identities ?? []),
    ]);
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
  const events = [...generationBase.events];
  if (priorIndex >= 0) events[priorIndex] = event;
  else events.push(event);
  const bounded = events.slice(-limit);
  return {
    conversation_id: event.conversation_id,
    revision: generationBase.revision + 1,
    generation: generationBase.generation,
    events: bounded,
  };
}
