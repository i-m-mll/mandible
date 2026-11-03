import type { ConversationSourceCoordinate } from '../query/conversationData';
import { getWindowHost } from '../api';

export type RowReadingAnchor = { kind: 'row'; rowKey: string; memberKey: string; position: number | null; offset: number };
export type ReadingAnchor = RowReadingAnchor | (ConversationSourceCoordinate & { kind: 'source' });
export type ReadingRestore = { positionSpaceId: string; anchor: RowReadingAnchor };
export type ReadingState = {
  version: 4;
  positionSpaceId: string;
  following: boolean;
  anchor: ReadingAnchor | null;
  disclosures: Record<string, boolean>;
};
const key = (id: string) => `mandible:chat-reading:${id}`;
const sessionKey = 'mandible:chat-reading-session';
function storage(): Storage {
  const host = getWindowHost();
  const store = window.sessionStorage;
  if (host.kind === 'browser') return store;
  const session = host.sessionId;
  if (store.getItem(sessionKey) !== session) {
    // Native WebKit may restore storage after relaunch. Only this feature's
    // choices belong to the process lifetime; other session state is untouched.
    for (const name of Object.keys(store)) if (name.startsWith('mandible:chat-reading:')) store.removeItem(name);
    store.setItem(sessionKey, session);
  }
  return store;
}
export function readReadingState(conversationId: string): ReadingState | null {
  try {
    const value = JSON.parse(storage().getItem(key(conversationId)) ?? 'null');
    if (![2, 3, 4].includes(value?.version) || typeof value.positionSpaceId !== 'string' || typeof value.following !== 'boolean') return null;
    if (value.version === 2 ? !Array.isArray(value.disclosures) : !value.disclosures || typeof value.disclosures !== 'object' || Array.isArray(value.disclosures)) return null;
    const anchor = value.anchor;
    if (anchor !== null) {
      if (!anchor || typeof anchor !== 'object' || !Number.isFinite(anchor.offset ?? 0)) return null;
      if (value.version === 4 && anchor.kind === 'row') {
        if (!Number.isFinite(anchor.offset) || typeof anchor.rowKey !== 'string' || !anchor.rowKey || typeof anchor.memberKey !== 'string' || !anchor.memberKey
          || (anchor.position !== null && (!Number.isSafeInteger(anchor.position) || anchor.position < 0))) return null;
      } else if ((value.version === 4 && anchor.kind !== 'source') || anchor.conversationId !== conversationId || anchor.positionSpaceId !== value.positionSpaceId
        || !Number.isSafeInteger(anchor.position) || anchor.position < 0) return null;
    }
    const entries = value.version === 2
      ? value.disclosures.filter((id: unknown) => typeof id === 'string').map((id: string) => [id, true])
      : Object.entries(value.disclosures).filter(([, expanded]) => typeof expanded === 'boolean');
    return { positionSpaceId: value.positionSpaceId, following: value.following, version: 4,
      anchor: anchor === null ? null : value.version === 4 ? anchor : { ...anchor, kind: 'source' }, disclosures: Object.fromEntries(entries.slice(-100)) };
  } catch { return null; }
}
export function writeReadingState(conversationId: string, value: ReadingState): void {
  try { storage().setItem(key(conversationId), JSON.stringify(value)); }
  catch { /* Storage may be unavailable; reading remains usable. */ }
}
