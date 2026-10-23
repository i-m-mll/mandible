import type { ConversationControlSnapshot, ProviderLiveContentEvent } from '../../../src/conversation-control/types';
import { conversationExecutionState } from './conversationControl';
import type { ConversationBlock, ProviderLiveProjection } from '../api';
import type { ChatItem } from '../../../src/parsers/types';
import { chatItemIdentityKey } from '../../../src/conversation-control/provider-live';
import type { AssistantEvent, CanonicalChatItemEvent, StreamEvent } from '../components/stream-renderer/types';

export function deriveStreamingState(events: StreamEvent[]): boolean {
  const last = events[events.length - 1];
  if (!last) return false;
  if (last.type === 'result') return false;
  if (last.type === 'assistant') {
    const assistantEvent = last as AssistantEvent;
    if (assistantEvent.message.stop_reason) return false;
  }
  return true;
}

export function flushPendingSSE(
  pendingSSERef: { current: StreamEvent[] },
  setStreamEvents: (fn: (prev: StreamEvent[]) => StreamEvent[]) => void,
  setStreaming: (v: boolean) => void,
): void {
  const pending = pendingSSERef.current;
  pendingSSERef.current = [];
  if (pending.length === 0) return;
  setStreamEvents((prev) => {
    const merged = [...prev];
    for (const event of pending) {
      const identity = stableProviderEventIdentity(event);
      const index = identity === null ? -1 : merged.findIndex((existing) => stableProviderEventIdentity(existing) === identity);
      if (index < 0) merged.push(event);
      else merged[index] = event;
    }
    setStreaming(deriveStreamingState(merged));
    return merged;
  });
}

export function computeLiveTail(
  historyEvents: StreamEvent[],
  memEvents: StreamEvent[],
): StreamEvent[] {
  const historyIds = new Set(historyEvents.map(stableProviderEventIdentity).filter((id): id is string => id !== null));
  return memEvents.filter((event) => {
    const identity = stableProviderEventIdentity(event);
    return identity === null || !historyIds.has(identity);
  });
}

export function stableProviderEventIdentity(event: StreamEvent): string | null {
  if (event.type === 'chat:item') {
    const identity = chatItemIdentityKey((event as { type: 'chat:item'; item: ChatItem }).item, { allowTranscriptCoordinates: true });
    return identity === null ? null : `chat-item:${identity}`;
  }
  const record = event as StreamEvent & { uuid?: unknown; message?: { id?: unknown } };
  if (typeof record.message?.id === 'string' && record.message.id) return `message:${record.message.id}`;
  if (typeof record.uuid === 'string' && record.uuid) return `event:${record.uuid}`;
  return null;
}

export function reconcileProviderProjection(
  historyEvents: StreamEvent[],
  projection: ProviderLiveProjection | null,
  intentAliases: Map<string, string> = new Map(),
  snapshot?: ConversationControlSnapshot | null,
): StreamEvent[] {
  const latest = new Map<string, ProviderLiveContentEvent>();
  for (const candidate of projection?.events ?? []) {
    if (candidate.kind !== 'provisional-content'
      || chatItemIdentityKey(candidate.item) !== candidate.identity
      || candidate.item.provenance.source !== 'live-provider-event') continue;
    const prior = latest.get(candidate.identity);
    if (!prior || candidate.generation > prior.generation
      || (candidate.generation === prior.generation && candidate.sequence > prior.sequence)) latest.set(candidate.identity, candidate);
    if (candidate.correlation && candidate.item.type === 'message' && candidate.item.role === 'user') {
      intentAliases.set(candidate.identity, `intent:${candidate.correlation.intent_id}`);
    }
  }
  const execution = conversationExecutionState(snapshot);
  const nativeTurns = new Map([...latest.values()].flatMap((candidate) => candidate.correlation && candidate.item.identity.native_turn_id
    ? [[candidate.item.identity.native_turn_id, candidate.correlation.turn_id] as const] : []));
  const executing = (candidate: ProviderLiveContentEvent): boolean => execution.isExecuting
    && candidate.generation === execution.generation
    && (candidate.control_turn_id ?? nativeTurns.get(candidate.item.identity.native_turn_id ?? '') ?? candidate.item.identity.native_turn_id) === execution.activeTurnId
    && candidate.item.type === 'tool-call' && candidate.item.phase === 'call'
    && (candidate.item.content_completion === 'streaming' || candidate.item.identity.provider === 'claude_code')
    && candidate.item.execution_outcome === undefined;
  const acknowledged = new Set([...latest.values()].flatMap((candidate) => candidate.correlation ? [candidate.correlation.intent_id] : []));
  const history = historyEvents.map((event): StreamEvent => {
    if (event.type !== 'chat:item') return event;
    const canonical = event as CanonicalChatItemEvent;
    const identity = chatItemIdentityKey(canonical.item, { allowTranscriptCoordinates: true });
    const displayKey = canonical.intentId ? `intent:${canonical.intentId}` : identity && intentAliases.get(identity);
    return displayKey ? { ...canonical, displayKey } : canonical;
  });
  const durable = new Map(history.map((event, index) => [stableProviderEventIdentity(event), index] as const));
  const candidates = [...latest.values()].filter((candidate) => candidate.item.provenance.source_event_type !== 'optimistic-user-prompt'
    || !acknowledged.has(candidate.item.identity.native_item_id ?? ''));
  const insertions = new Map<number, StreamEvent[]>();
  let priorAnchor = -1;
  candidates.forEach((candidate, index) => {
    const durableIndex = durable.get(`chat-item:${candidate.identity}`);
    if (durableIndex !== undefined) {
      priorAnchor = durableIndex;
      history[durableIndex] = { ...history[durableIndex], executionActive: executing(candidate) };
      const event = history[durableIndex] as CanonicalChatItemEvent;
      // Display windows omit lazy tool bodies. Keep the already observed input
      // until exact source details arrive; the durable row still owns position.
      if (event.source?.detailsLoaded === false) {
        history[durableIndex] = { ...event, item: { ...candidate.item, ...event.item,
          ...(event.item.type === 'tool-call' && candidate.item.type === 'tool-call'
            ? { input: candidate.item.input, output: candidate.item.output } : { parts: candidate.item.parts }),
        } as ChatItem };
      }
      return;
    }
    const nextAnchor = candidates.slice(index + 1).map((next) => durable.get(`chat-item:${next.identity}`))
      .find((position) => position !== undefined && position > priorAnchor);
    const chronologicalAnchor = history.findIndex((event, position) => {
      if (position <= priorAnchor || event.type !== 'chat:item') return false;
      const timestamp = (event as CanonicalChatItemEvent).source?.timestamp;
      return Boolean(timestamp && Date.parse(timestamp) >= candidate.observed_at);
    });
    const position = nextAnchor ?? (chronologicalAnchor >= 0 ? chronologicalAnchor : history.length);
    const displayKey = candidate.item.provenance.source_event_type === 'optimistic-user-prompt'
      ? `intent:${candidate.item.identity.native_item_id}` : intentAliases.get(candidate.identity);
    const events = insertions.get(position) ?? [];
    events.push({ type: 'chat:item', item: candidate.item, displayKey,
      executionActive: executing(candidate), persistencePending: ['terminal', 'unknown', 'idle'].includes(execution.phase) });
    insertions.set(position, events);
  });
  return history.flatMap((event, index) => [...(insertions.get(index) ?? []), event])
    .concat(insertions.get(history.length) ?? []);
}

function parseMetadata(json: string): Record<string, unknown> {
  try {
    return JSON.parse(json || '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
}

function canonicalChatItem(value: unknown): ChatItem | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<ChatItem>;
  if (!['message', 'plan', 'tool-call', 'activity'].includes(String(candidate.type))) return null;
  if (!candidate.identity || !candidate.provenance || !Array.isArray(candidate.parts)) return null;
  return candidate as ChatItem;
}

export function conversationBlocksToStreamEvents(
  providerSessionId: string,
  blocks: Array<Pick<ConversationBlock, 'id' | 'type' | 'content' | 'metadata_json' | 'timestamp' | 'dag_uuid'>
    & Partial<Pick<ConversationBlock, 'details_loaded'>>
    & Partial<Pick<ConversationBlock, 'position'>>
    & Partial<Pick<ConversationBlock, 'parent_id'>>>,
): StreamEvent[] {
  const events: StreamEvent[] = [];
  let lastPosition: number | null = null;

  for (const block of blocks) {
    if (lastPosition !== null && block.position !== undefined && block.position > lastPosition + 1) {
      events.push({ type: 'transcript:boundary' });
    }
    if (block.position !== undefined) lastPosition = block.position;
    const metadata = parseMetadata(block.metadata_json);
    const source = {
      blockId: block.id,
      ...(Number.isSafeInteger(block.position) ? { position: block.position } : {}),
      ...(block.details_loaded === undefined ? {} : { detailsLoaded: block.details_loaded }),
      ...(typeof metadata.display_has_body === 'boolean' ? { hasBody: metadata.display_has_body } : {}),
      ...(block.parent_id ? { parentBlockId: block.parent_id } : {}),
      timestamp: block.timestamp || undefined,
      dagUuid: block.dag_uuid ?? undefined,
    };

    // Canonical normalized content is the sole transcript-to-Chat boundary.
    // Missing or malformed items fail closed instead of being guessed from a
    // provider-shaped block.
    if (Object.prototype.hasOwnProperty.call(metadata, 'chat_item')) {
      const item = canonicalChatItem(metadata.chat_item);
      const identity = item && item.provenance.source === 'verified-provider-transcript'
        ? chatItemIdentityKey(item, { allowTranscriptCoordinates: true })
        : null;
      if (item && identity) events.push({ type: 'chat:item', item, source,
        ...(typeof metadata.client_intent_id === 'string' ? { intentId: metadata.client_intent_id } : {}),
      });
    }
  }

  if (events.length > 0) {
    events.push({
      type: 'result',
      session_id: providerSessionId,
      subtype: 'success',
      duration_ms: 0,
      duration_api_ms: 0,
      is_error: false,
      num_turns: 0,
      result: '',
      cost_usd: 0,
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
    } as unknown as StreamEvent);
  }
  return events;
}
