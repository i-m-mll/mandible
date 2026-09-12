import type { ActivityItem, ActivityKind } from '../../../../src/parsers/types';
import type { ComponentChildren } from 'preact';
import { ChatDisclosure } from '../shared/ChatDisclosure';
import { InfoIcon, IssuesIcon, MonitorIcon, TerminalIcon } from '../icons/TabIcons';

const ACTIVITY_LABELS: Record<ActivityKind, string> = {
  'reasoning-summary': 'Reasoning summary', thinking: 'Thinking',
  'tool-progress': 'Tool progress', 'tool-summary': 'Tool summary',
  status: 'Status', information: 'Information', diagnostic: 'Diagnostic',
};

function stripPairedMarker(value: string, marker: '**' | '__'): string {
  let output = '';
  let cursor = 0;
  while (cursor < value.length) {
    const opening = value.indexOf(marker, cursor);
    if (opening < 0) return output + value.slice(cursor);
    const beforeOpening = value[opening - 1];
    const afterOpening = value[opening + marker.length];
    if ((beforeOpening && /[\p{L}\p{N}_]/u.test(beforeOpening)) || !afterOpening || /\s/u.test(afterOpening)) {
      output += value.slice(cursor, opening + marker.length);
      cursor = opening + marker.length;
      continue;
    }
    let closing = value.indexOf(marker, opening + marker.length);
    while (closing >= 0) {
      const beforeClosing = value[closing - 1];
      const afterClosing = value[closing + marker.length];
      if (beforeClosing && !/\s/u.test(beforeClosing)
          && (!afterClosing || !/[\p{L}\p{N}_]/u.test(afterClosing))) break;
      closing = value.indexOf(marker, closing + marker.length);
    }
    if (closing < 0) return output + value.slice(cursor);
    output += value.slice(cursor, opening) + value.slice(opening + marker.length, closing);
    cursor = closing + marker.length;
  }
  return output;
}

/** Remove balanced emphasis delimiters from inert compact-header text. */
export function plainActivityHeader(value: string): string {
  return stripPairedMarker(stripPairedMarker(value, '**'), '__');
}

function itemText(item: ActivityItem): string {
  return plainActivityHeader(item.parts.map((part) => part.text).join('\n'));
}

function itemState(item: ActivityItem): string[] {
  const state: string[] = [];
  if (item.severity && item.severity !== 'info') state.push(item.severity);
  if (item.execution_outcome && item.execution_outcome !== 'unknown') state.push(item.execution_outcome);
  if (item.status) state.push(item.status);
  return state;
}

function ActivityKindIcon({ kind }: { kind: ActivityKind }): JSX.Element {
  if (kind === 'tool-progress' || kind === 'tool-summary') return <TerminalIcon />;
  if (kind === 'information') return <InfoIcon />;
  if (kind === 'diagnostic') return <IssuesIcon />;
  return <MonitorIcon />;
}

export function ActivityRow({ item }: { item: ActivityItem }): JSX.Element {
  const state = itemState(item);
  const text = itemText(item);
  return (
    <div className={`activity-row${item.severity ? ` activity-row--${item.severity}` : ''}`}>
      <span className="activity-row__icon" aria-hidden="true"><ActivityKindIcon kind={item.activity_kind} /></span>
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
    failureCount > 0 ? 'failed' : '',
    warningCount > 0 ? 'warning' : '',
    ...new Set(important.filter((value) => !['warning', 'error', 'failed'].includes(value))),
  ].filter(Boolean).join(' · ');
  const label = ACTIVITY_LABELS[activityKind];
  return (
    <ChatDisclosure
      className="activity-group"
      summary={label}
      regionLabel={`${label} activity details`}
      expanded={expanded}
      onExpandedChange={onExpandedChange}
      leading={<span className="activity-row__icon"><ActivityKindIcon kind={activityKind} /></span>}
      trailing={stateSummary || undefined}
    >
      <div className="activity-group__body">
        {children ?? items.map((item) => <ActivityRow key={`${item.identity.provider}:${item.identity.session_id}:${item.identity.native_item_id ?? item.identity.source_record_ordinal}:${item.identity.source_sub_block_ordinal}`} item={item} />)}
      </div>
    </ChatDisclosure>
  );
}
