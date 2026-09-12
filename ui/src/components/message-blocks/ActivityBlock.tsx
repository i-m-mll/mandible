import type { ActivityItem, ActivityKind } from '../../../../src/parsers/types';
import type { ComponentChildren } from 'preact';
import { ChatDisclosure } from '../shared/ChatDisclosure';

const ACTIVITY_LABELS: Record<ActivityKind, string> = {
  'reasoning-summary': 'Reasoning summary', thinking: 'Thinking',
  'tool-progress': 'Tool progress', 'tool-summary': 'Tool summary',
  status: 'Status', information: 'Information', diagnostic: 'Diagnostic',
};

function itemText(item: ActivityItem): string {
  return item.parts.map((part) => part.text).join('\n');
}

function itemState(item: ActivityItem): string[] {
  const state: string[] = [];
  if (item.severity && item.severity !== 'info') state.push(item.severity);
  if (item.execution_outcome && item.execution_outcome !== 'unknown') state.push(item.execution_outcome);
  if (item.status) state.push(item.status);
  return state;
}

export function ActivityRow({ item }: { item: ActivityItem }): JSX.Element {
  const state = itemState(item);
  const text = itemText(item);
  return (
    <div className={`activity-row${item.severity ? ` activity-row--${item.severity}` : ''}`}>
      <span className="activity-row__label">{ACTIVITY_LABELS[item.activity_kind]}</span>
      {text ? <span className="activity-row__text">{text}</span> : null}
      {state.length > 0 ? <span className="activity-row__state">{state.join(' · ')}</span> : null}
      {item.elapsed_ms !== undefined ? <span className="activity-row__elapsed">{item.elapsed_ms.toLocaleString()} ms</span> : null}
    </div>
  );
}

export function ActivityGroup({ activityKind, items, expanded, onExpandedChange, children }: {
  activityKind: ActivityKind;
  items: readonly ActivityItem[];
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  children?: ComponentChildren;
}): JSX.Element {
  const important = items.flatMap(itemState);
  const warningCount = items.filter((item) => item.severity === 'warning').length;
  const failureCount = items.filter((item) => item.severity === 'error' || item.execution_outcome === 'failed').length;
  const stateSummary = [
    failureCount > 0 ? `${failureCount} failed` : '',
    warningCount > 0 ? `${warningCount} warning${warningCount === 1 ? '' : 's'}` : '',
    ...new Set(important.filter((value) => !['warning', 'error', 'failed'].includes(value))),
  ].filter(Boolean).join(' · ');
  const label = ACTIVITY_LABELS[activityKind];
  return (
    <ChatDisclosure
      className="activity-group"
      summary={`${label} · ${items.length}`}
      regionLabel={`${label} activity details`}
      expanded={expanded}
      onExpandedChange={onExpandedChange}
      trailing={stateSummary || undefined}
    >
      <div className="activity-group__body">
        {children ?? items.map((item) => <ActivityRow key={`${item.identity.provider}:${item.identity.session_id}:${item.identity.native_item_id ?? item.identity.source_record_ordinal}:${item.identity.source_sub_block_ordinal}`} item={item} />)}
      </div>
    </ChatDisclosure>
  );
}
