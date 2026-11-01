import type { ConversationSourceCoordinate } from '../query/conversationData';

export type ReadingState = {
  version: 3;
  positionSpaceId: string;
  following: boolean;
  anchor: ConversationSourceCoordinate | null;
  disclosures: Record<string, boolean>;
};
const key = (id: string) => `mandible:chat-reading:${id}`;
export function readReadingState(conversationId: string): ReadingState | null {
  try {
    const value = JSON.parse(localStorage.getItem(key(conversationId)) ?? 'null');
    if (![2, 3].includes(value?.version) || typeof value.positionSpaceId !== 'string' || typeof value.following !== 'boolean') return null;
    if (value.version === 2 ? !Array.isArray(value.disclosures) : !value.disclosures || typeof value.disclosures !== 'object' || Array.isArray(value.disclosures)) return null;
    const anchor = value.anchor;
    if (anchor !== null && (anchor.conversationId !== conversationId || anchor.positionSpaceId !== value.positionSpaceId
      || !Number.isSafeInteger(anchor.position) || anchor.position < 0 || !Number.isFinite(anchor.offset ?? 0))) return null;
    const entries = value.version === 2
      ? value.disclosures.filter((id: unknown) => typeof id === 'string').map((id: string) => [id, true])
      : Object.entries(value.disclosures).filter(([, expanded]) => typeof expanded === 'boolean');
    return { ...value, version: 3, disclosures: Object.fromEntries(entries.slice(-100)) };
  } catch { return null; }
}
export function writeReadingState(conversationId: string, value: ReadingState): void {
  try { localStorage.setItem(key(conversationId), JSON.stringify(value)); }
  catch { /* Storage may be unavailable; reading remains usable. */ }
}
