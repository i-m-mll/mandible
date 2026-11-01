import { getAgentPageBinding, hashWithAgentSession } from '../agent-page-binding';
import { routeHashWithParams } from '../routing';

export type ConversationAnchor = { block: string } | { turn: string } | { position: number };

export function conversationAnchorFromHash(hash: string): ConversationAnchor | null {
  const query = hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : '';
  const params = new URLSearchParams(query);
  const block = params.get('block');
  const turn = params.get('turn');
  const position = params.get('position');
  if (block) return { block };
  if (turn) return { turn };
  if (position !== null && Number.isSafeInteger(Number(position)) && Number(position) >= 0) {
    return { position: Number(position) };
  }
  return null;
}

export function conversationAnchorHref(
  conversationId: string,
  anchor: ConversationAnchor,
  currentHash = '',
): string {
  return routeHashWithParams(currentHash, 'console', {
    conversation: conversationId,
    ...('position' in anchor ? { position: String(anchor.position) } : anchor),
  }, ['conversation', 'session', 'block', 'turn', 'position']);
}

export function messageLinkUrl(currentUrl: string, conversationId: string, blockId: string): string {
  const url = new URL(currentUrl);
  url.hash = hashWithAgentSession(
    conversationAnchorHref(conversationId, { block: blockId }, url.hash), getAgentPageBinding(),
  );
  return url.href;
}
