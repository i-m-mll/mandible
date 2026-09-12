import type { ActivityItem, ActivityKind, ConversationSource } from '../../../../src/parsers/types';
import { CompactActivityRow } from '../shared/ChatDisclosure';
import { OfficialProviderMark } from '../shared/OfficialProviderMark';
import { InfoIcon, IssuesIcon, MonitorIcon, TerminalIcon } from '../icons/TabIcons';

const ACTIVITY_LABELS: Record<ActivityKind, string> = {
  'reasoning-summary': 'Reasoning', thinking: 'Thinking',
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

export function plainActivityHeader(value: string): string {
  return stripPairedMarker(stripPairedMarker(value, '**'), '__');
}

export function plainActivityParts(item: ActivityItem): string[] {
  return item.parts
    .map((part) => plainActivityHeader(part.text).trim())
    .filter(Boolean);
}

function activityState(item: ActivityItem): string[] {
  return [
    item.severity && item.severity !== 'info' ? item.severity : undefined,
    item.execution_outcome && item.execution_outcome !== 'unknown' ? item.execution_outcome : undefined,
    item.status,
  ].filter((value): value is string => Boolean(value));
}

function activityDetails(item: ActivityItem, parts: readonly string[]): string[] {
  const details = [...parts.slice(1)];
  if (item.tool_name) details.push(`Tool: ${item.tool_name}`);
  if (item.elapsed_ms !== undefined) details.push(`${item.elapsed_ms.toLocaleString()} ms`);
  return details;
}

function activityItemSignature(item: ActivityItem): string {
  return JSON.stringify({
    provider: item.identity.provider,
    session: item.identity.session_id,
    speaker: item.role,
    kind: item.activity_kind,
    turn: item.identity.native_turn_id ?? null,
    parts: plainActivityParts(item),
    severity: item.severity ?? null,
    outcome: item.execution_outcome ?? null,
    status: item.status ?? null,
    elapsed: item.elapsed_ms ?? null,
    toolName: item.tool_name ?? null,
    toolId: item.tool_id ?? null,
    relatedToolIds: item.related_tool_ids ?? [],
  });
}

export type ActivityPresentation = {
  summary: string;
  details: string[];
  members: ActivityItem[];
};

/** Fold adjacent exact-visible duplicates without changing canonical membership. */
export function presentActivityItems(items: readonly ActivityItem[]): ActivityPresentation[] {
  const presentations: ActivityPresentation[] = [];
  let previousSignature: string | undefined;
  for (const item of items) {
    const signature = activityItemSignature(item);
    if (signature === previousSignature) {
      presentations[presentations.length - 1].members.push(item);
      continue;
    }
    const parts = plainActivityParts(item);
    const state = activityState(item);
    const base = parts[0] ?? ACTIVITY_LABELS[item.activity_kind];
    presentations.push({
      summary: [...new Set([base, ...state])].join(' · '),
      details: activityDetails(item, parts),
      members: [item],
    });
    previousSignature = signature;
  }
  return presentations;
}

function providerMark(provider: ConversationSource): JSX.Element | null {
  if (provider === 'codex') return <OfficialProviderMark kind="openai" />;
  if (provider === 'claude_code') return <OfficialProviderMark kind="anthropic" />;
  return null;
}

function ActivityIcon({ item }: { item: ActivityItem }): JSX.Element {
  if (item.activity_kind === 'reasoning-summary' || item.activity_kind === 'thinking') {
    return providerMark(item.identity.provider) ?? <MonitorIcon />;
  }
  if (item.activity_kind === 'tool-progress' || item.activity_kind === 'tool-summary') return <TerminalIcon />;
  if (item.activity_kind === 'information') return <InfoIcon />;
  if (item.activity_kind === 'diagnostic') return <IssuesIcon />;
  return <MonitorIcon />;
}

function activityDetailLines(presentations: readonly ActivityPresentation[]): string[] {
  return presentations.flatMap((presentation, index) => (
    index === 0 ? presentation.details : [presentation.summary, ...presentation.details]
  ));
}

function ActivityDetails({ lines }: { lines: readonly string[] }): JSX.Element {
  return <div className="activity-details">{lines.map((line, index) => <div key={index} className="activity-details__part">{line}</div>)}</div>;
}

export function ActivityRow({ item, expanded, onExpandedChange }: {
  item: ActivityItem;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}): JSX.Element {
  const presentation = presentActivityItems([item])[0];
  const lines = activityDetailLines([presentation]);
  const disclosure = lines.length > 0
    ? {
        content: <ActivityDetails lines={lines} />,
        regionLabel: `${presentation.summary} details`,
        expanded,
        onExpandedChange,
      }
    : undefined;
  return (
    <CompactActivityRow
      className={`activity-block${item.severity ? ` activity-block--${item.severity}` : ''}`}
      icon={<ActivityIcon item={item} />}
      summary={presentation.summary}
      disclosure={disclosure}
    />
  );
}

export function ActivityGroup({ items, expanded, onExpandedChange }: {
  items: readonly ActivityItem[];
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}): JSX.Element {
  const presentations = presentActivityItems(items);
  const state = [...new Set(items.flatMap(activityState))];
  const summary = [...new Set([...presentations[0].summary.split(' · '), ...state])].join(' · ');
  const lines = activityDetailLines(presentations);
  return (
    <CompactActivityRow
      className="activity-group"
      icon={<ActivityIcon item={items[0]} />}
      summary={summary}
      disclosure={lines.length > 0 ? {
        content: <ActivityDetails lines={lines} />,
        regionLabel: `${summary} details`,
        expanded,
        onExpandedChange,
      } : undefined}
    />
  );
}
