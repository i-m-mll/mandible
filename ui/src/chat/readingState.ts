import type { ConversationSourceCoordinate } from '../query/conversationData';

export type ReadingState = {
  version: 2;
  positionSpaceId: string;
  following: boolean;
  anchor: ConversationSourceCoordinate | null;
  disclosures: string[];
};
const key = (id: string) => `mandible:chat-reading:${id}`;
export function readReadingState(conversationId: string): ReadingState | null {
  try {
    const value = JSON.parse(localStorage.getItem(key(conversationId)) ?? 'null');
    if (value?.version !== 2 || typeof value.positionSpaceId !== 'string' || typeof value.following !== 'boolean' || !Array.isArray(value.disclosures)) return null;
    const anchor = value.anchor;
    if (anchor !== null && (anchor.conversationId !== conversationId || anchor.positionSpaceId !== value.positionSpaceId
      || !Number.isSafeInteger(anchor.position) || anchor.position < 0 || !Number.isFinite(anchor.offset ?? 0))) return null;
    return { ...value, disclosures: value.disclosures.filter((id: unknown) => typeof id === 'string').slice(-100) };
  } catch { return null; }
}
export function writeReadingState(conversationId: string, value: ReadingState): void {
  try { localStorage.setItem(key(conversationId), JSON.stringify(value)); }
  catch { /* Storage may be unavailable; reading remains usable. */ }
}
