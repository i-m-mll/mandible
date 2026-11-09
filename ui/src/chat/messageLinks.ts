import { getAgentPageBinding, withAgentSession } from '../agent-page-binding';
import { routeWithParams } from '../routing';
import type { ChatRouteTarget } from '../api';

export type ConversationAnchor = { expected_position_space_id?: string } & ({ block: string } | { turn: string } | { position: number });

/** The message anchor a Chat query ("?conversation=…&block=…") names. */
export function conversationAnchorFromSearch(search: string): ConversationAnchor | null {
  const params = new URLSearchParams(search);
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
  currentSearch = '',
): string {
  return routeWithParams({ kind: 'view', tab: 'console' }, {
    conversation: conversationId,
    ...('position' in anchor ? { position: String(anchor.position) } : 'block' in anchor ? { block: anchor.block } : { turn: anchor.turn }),
    position_space: anchor.expected_position_space_id,
  }, ['conversation', 'session', 'block', 'turn', 'position', 'position_space'], currentSearch);
}

export function messageLinkUrl(currentUrl: string, conversationId: string, blockId: string, positionSpaceId?: string): string {
  const url = new URL(currentUrl);
  return new URL(withAgentSession(
    conversationAnchorHref(conversationId, { block: blockId, expected_position_space_id: positionSpaceId }, url.search), getAgentPageBinding(),
  ), url).href;
}

export function chatRouteHref(target: ChatRouteTarget, currentSearch = ''): string {
  return routeWithParams({ kind: 'view', tab: 'console' }, { [target.type]: target.id },
    ['conversation', 'session', 'block', 'turn', 'position', 'position_space'], currentSearch);
}
