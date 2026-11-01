import { chatItemIdentityKey } from '../conversation-control/provider-live.js';
import type { ChatItem } from '../parsers/types.js';
import type { BlockType, Role } from '../parsers/types.js';

export const readingSpeaker = (role: Role): 'user' | 'assistant' | 'system' => role === 'tool' ? 'assistant' : role;
export function readingMemberKeys(item: ChatItem, intentId?: string): string[] {
  const native = chatItemIdentityKey(item);
  return [...(native ? [native] : []), ...(intentId ? [`intent:${intentId}`] : [])];
}

export type ReadingContextEntry = {
  position: number;
  activity_owner: number | null;
  action_scope: { start: number; end: number };
};
export type ConversationReadingContext = {
  positions: Array<{ position: number; activity_owner_position: number | null; speaker_run_start: number }>;
  speaker_runs: Array<{ start: number; end: number }>;
};
export function packReadingContext(entries: readonly ReadingContextEntry[]): ConversationReadingContext {
  const scopes = new Map(entries.map(entry => [entry.action_scope.start, entry.action_scope]));
  return { positions: entries.map(entry => ({ position: entry.position, activity_owner_position: entry.activity_owner, speaker_run_start: entry.action_scope.start })), speaker_runs: [...scopes.values()] };
}
export type ReadingContextState = ReadingContextEntry & { role: Role; type: BlockType };

/** Source publication assigns ownership once, independently of fetched window edges. */
export function nextReadingContext(
  row: { position: number; type: BlockType; role: Role; parentPosition: number | null },
  previous: ReadingContextState | null,
  parentOwner: number | null,
): ReadingContextState {
  const speaker = readingSpeaker(row.role);
  const previousSpeaker = previous ? readingSpeaker(previous.role) : null;
  const start = speaker === previousSpeaker ? previous!.action_scope.start : row.position;
  const activity = ['thinking', 'tool_use', 'tool_result', 'event'].includes(row.type);
  const owner = !activity ? null : row.parentPosition !== null ? parentOwner ?? row.parentPosition
    : row.type === 'tool_use' ? row.position : (speaker === previousSpeaker ? previous?.activity_owner : null) ?? row.position;
  return { position: row.position, type: row.type, role: row.role, activity_owner: owner, action_scope: { start, end: row.position } };
}
