import { getAgentPageBinding, hashWithAgentSession } from '../agent-page-binding';
import { routeHashWithParams } from '../routing';

export type ConversationAnchor = { expected_position_space_id?: string } & ({ block: string } | { turn: string } | { position: number });

export function conversationAnchorFromHash(hash: string): ConversationAnchor | null {
  const query = hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : '';
  const params = new URLSearchParams(query);
  const block = params.get('block');
  const turn = params.get('turn');
  const position = params.get('position');
  const expected_position_space_id = params.get('position_space') ?? undefined;
  if (block) return { block, ...(expected_position_space_id ? { expected_position_space_id } : {}) };
  if (turn) return { turn, ...(expected_position_space_id ? { expected_position_space_id } : {}) };
  if (position !== null && Number.isSafeInteger(Number(position)) && Number(position) >= 0) {
    return { position: Number(position), ...(expected_position_space_id ? { expected_position_space_id } : {}) };
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
    ...('position' in anchor ? { position: String(anchor.position) } : 'block' in anchor ? { block: anchor.block } : { turn: anchor.turn }),
    position_space: anchor.expected_position_space_id,
  }, ['conversation', 'session', 'block', 'turn', 'position', 'position_space']);
}

export function messageLinkUrl(currentUrl: string, conversationId: string, blockId: string, positionSpaceId?: string): string {
  const url = new URL(currentUrl);
  url.hash = hashWithAgentSession(
    conversationAnchorHref(conversationId, { block: blockId, expected_position_space_id: positionSpaceId }, url.hash), getAgentPageBinding(),
  );
  return url.href;
}
