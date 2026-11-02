import type { MessagePrimaryAction } from '../components/shared/MessageActions';
import type { ReadingActionRun, ReadingRow } from './readingProjection';

export function readingRowTurnId(row: ReadingRow, actionRuns?: ReadonlyMap<string, ReadingActionRun>): string | undefined {
  return actionRuns?.get(row.actionGroup.key)?.events.find(event => event.item.role === 'assistant' && event.item.identity.native_turn_id)?.item.identity.native_turn_id
    ?? [...row.nodes, ...(row.activityGroup?.items ?? [])].flatMap(node => node.kind === 'assistant_turn' ? [node.turn.id]
      : node.kind === 'activity' && node.item.type !== 'activity' ? [node.item.turnId] : []).find((id): id is string => id !== undefined);
}
export function readingRowPrimaryActions(input: {
  copy: () => void; open: () => void; turnId?: string; selectedMessageId?: string | null; select?: (turnId: string) => void;
}): MessagePrimaryAction[] {
  const selected = input.selectedMessageId === input.turnId;
  return [
    { id: 'copy-group', title: 'Copy all', label: 'Copy all messages', icon: 'copyMessage', onAction: input.copy },
    { id: 'open-group-markdown', title: 'Open markdown', label: 'Open turn as markdown', icon: 'openMarkdown', onAction: input.open },
    ...(input.select && input.turnId ? [{ id: 'select-group', title: selected ? 'Deselect' : 'Select', label: selected ? 'Deselect turn' : 'Select turn',
      icon: selected ? 'messageSelected' as const : 'selectMessage' as const, onAction: () => input.select!(input.turnId!) }] : []),
  ];
}
