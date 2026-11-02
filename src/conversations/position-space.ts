import { createHash, randomUUID } from 'node:crypto';
import type { ConversationBlock } from '../parsers/types.js';
import { chatItemIdentityKey } from '../conversation-control/provider-live.js';

export interface PositionSpacePublication {
  position_space_id: string;
  position_count: number;
  position_fingerprint: string;
  position_fingerprint_version: number;
}

export const POSITION_FINGERPRINT_VERSION = 1;
const EMPTY_PREFIX = createHash('sha256').update('mandible-normalized-position:1').digest('hex');

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value)
    .filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

/** Native item/subitem identity survives edits; immutable id-less items use semantic content. */
export function normalizedPositionIdentity(block: Omit<ConversationBlock, 'id' | 'conversation_id'>): string {
  const parsedItem = block.metadata.chat_item;
  const correlatedPrompt = parsedItem?.type === 'message' && parsedItem.role === 'user'
    && block.metadata.client_intent_id && parsedItem.identity.native_item_id === block.metadata.client_intent_id;
  const item = correlatedPrompt ? { ...parsedItem, identity: { ...parsedItem.identity,
    native_item_id: block.metadata.provider_message_id } } : parsedItem;
  const native = item && chatItemIdentityKey(item);
  if (native) return canonical(['native', native,
    item.identity.native_content_index === undefined ? item.identity.source_sub_block_ordinal : null]);
  const metadata = Object.fromEntries(Object.entries(block.metadata).filter(([key]) =>
    !key.startsWith('source_') && !key.startsWith('display_') && key !== 'chat_item' && key !== 'client_intent_id'));
  const semanticItem = item && { ...item, ...(item.type === "message" ? { assistant_response: undefined } : {}), identity: { provider: item.identity.provider, session_id: item.identity.session_id } };
  return canonical(['semantic', block.type, block.role, block.content, metadata, semanticItem ?? null]);
}

export function preparePositionSpace(
  blocks: ReadonlyArray<Omit<ConversationBlock, 'id' | 'conversation_id'>>,
  prior: PositionSpacePublication | null,
  verifiedAppend: boolean,
): PositionSpacePublication {
  let fingerprint = verifiedAppend && prior ? prior.position_fingerprint : EMPTY_PREFIX;
  let count = verifiedAppend && prior ? prior.position_count : 0;
  let prefixMatches = prior?.position_count === 0 && prior.position_fingerprint === EMPTY_PREFIX;
  for (const block of blocks) {
    if (block.position !== count) throw new Error('Normalized publication positions must be contiguous');
    fingerprint = createHash('sha256').update(fingerprint).update('\0').update(normalizedPositionIdentity(block)).digest('hex');
    count += 1;
    if (count === prior?.position_count) prefixMatches = fingerprint === prior.position_fingerprint;
  }
  const continuous = prior?.position_fingerprint_version === POSITION_FINGERPRINT_VERSION
    && (verifiedAppend || (count >= prior.position_count && prefixMatches));
  return { position_space_id: continuous ? prior.position_space_id : randomUUID(),
    position_count: count, position_fingerprint: fingerprint, position_fingerprint_version: POSITION_FINGERPRINT_VERSION };
}
