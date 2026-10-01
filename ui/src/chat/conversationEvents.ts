import type { ConversationBlock, ProviderLiveProjection } from '../api';
import type { ChatItem } from '../../../src/parsers/types';
import { chatItemIdentityKey } from '../../../src/conversation-control/provider-live';
import type { AssistantEvent, StreamEvent } from '../components/stream-renderer/types';

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
    const newEvents = pending.filter((pe) => {
      const peJson = JSON.stringify(pe);
      return !prev.some((existing) => JSON.stringify(existing) === peJson);
    });
    const merged = newEvents.length > 0 ? [...prev, ...newEvents] : prev;
    setStreaming(deriveStreamingState(merged));
    return merged;
  });
}

export function computeLiveTail(
  historyEvents: StreamEvent[],
  memEvents: StreamEvent[],
): StreamEvent[] {
  const historyIds = new Set(historyEvents.map(stableProviderEventIdentity).filter((id): id is string => id !== null));
  let lastReconciled = -1;
  for (let index = 0; index < memEvents.length; index += 1) {
    const identity = stableProviderEventIdentity(memEvents[index]);
    if (identity && historyIds.has(identity)) lastReconciled = index;
  }
  return memEvents.slice(lastReconciled + 1).filter((event) => {
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
): StreamEvent[] {
  if (!projection || projection.events.length === 0) return historyEvents;
  const historyIds = new Set(historyEvents.map(stableProviderEventIdentity).filter((id): id is string => id !== null));
  const latest = new Map<string, Extract<ProviderLiveProjection['events'][number], { kind: 'provisional-content' }>>();
  for (const candidate of projection.events) {
    if (candidate.kind !== 'provisional-content') continue;
    const canonicalIdentity = chatItemIdentityKey(candidate.item);
    if (canonicalIdentity === null
      || canonicalIdentity !== candidate.identity
      || candidate.item.provenance.source !== 'live-provider-event'
      || historyIds.has(`chat-item:${candidate.identity}`)) continue;
    const prior = latest.get(candidate.identity);
    if (!prior
      || candidate.generation > prior.generation
      || (candidate.generation === prior.generation && candidate.sequence > prior.sequence)) {
      latest.set(candidate.identity, candidate);
    }
  }
  const provisional = [...latest.values()]
    .sort((left, right) => left.generation - right.generation || left.sequence - right.sequence)
    .map((candidate): StreamEvent => ({ type: 'chat:item', item: candidate.item }));
  return provisional.length > 0 ? [...historyEvents, ...provisional] : historyEvents;
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
      if (item && identity) events.push({ type: 'chat:item', item, source });
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
