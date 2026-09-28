import type { ActivityItem, ActivityKind } from '../../../../src/parsers/types';
import { CompactActivityRow } from '../shared/ChatDisclosure';
import type { DisplayActivityItem } from '../stream-renderer/types';
import { ChatIcon, HistoryIcon, InfoIcon, IssuesIcon, MonitorIcon, TerminalIcon } from '../icons/TabIcons';

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

type ActivityDetail = string
  | { kind: 'citation'; ref: string; note: string | null }
  | { kind: 'created-thread'; identity: 'threadId' | 'clientThreadId'; providerSessionId: string };

function activityState(item: DisplayActivityItem): string[] {
  if (item.type === 'provider-directive') return [];
  return [
    item.severity && item.severity !== 'info' ? item.severity : undefined,
    item.execution_outcome && item.execution_outcome !== 'unknown' ? item.execution_outcome : undefined,
    item.status,
  ].filter((value): value is string => Boolean(value));
}

function activityDetails(item: DisplayActivityItem, parts: readonly string[]): ActivityDetail[] {
  if (item.type === 'provider-directive') {
    if (item.directive.kind === 'memory-citation') {
      return [
        ...item.directive.citations.map((citation) => ({ kind: 'citation' as const, ...citation })),
        ...item.directive.rolloutIds.map((id) => `Task: ${id}`),
      ];
    }
    return [{
      kind: 'created-thread',
      identity: item.directive.identity,
      providerSessionId: item.directive.providerSessionId,
    }];
  }
  const details = [...parts.slice(1)];
  if (item.tool_name) details.push(`Tool: ${item.tool_name}`);
  if (item.elapsed_ms !== undefined) details.push(`${item.elapsed_ms.toLocaleString()} ms`);
  return details;
}

function activityItemSignature(item: DisplayActivityItem): string {
  if (item.type === 'provider-directive') {
    return JSON.stringify({
      kind: item.directive.kind,
      directive: item.directive,
      turn: item.turnId,
    });
  }
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
  details: ActivityDetail[];
  members: DisplayActivityItem[];
};

/** Fold adjacent exact-visible duplicates without changing canonical membership. */
function activitySummary(item: DisplayActivityItem, parts: readonly string[], state: readonly string[]): string {
  if (item.type === 'provider-directive') {
    return item.directive.kind === 'memory-citation' ? 'Used memory' : 'Created task';
  }
  const base = parts[0] ?? ACTIVITY_LABELS[item.activity_kind];
  return [...new Set([base, ...state])].join(' · ');
}

export function presentActivityItems(items: readonly DisplayActivityItem[]): ActivityPresentation[] {
  const presentations: ActivityPresentation[] = [];
  let previousSignature: string | undefined;
  for (const item of items) {
    const signature = activityItemSignature(item);
    if (signature === previousSignature) {
      presentations[presentations.length - 1].members.push(item);
      continue;
    }
    const parts = item.type === 'provider-directive' ? [] : plainActivityParts(item);
    const state = activityState(item);
    presentations.push({
      summary: activitySummary(item, parts, state),
      details: activityDetails(item, parts),
      members: [item],
    });
    previousSignature = signature;
  }
  return presentations;
}

function activityIcon(item: DisplayActivityItem): JSX.Element | undefined {
  if (item.type === 'provider-directive') {
    return item.directive.kind === 'memory-citation' ? <HistoryIcon /> : <ChatIcon />;
  }
  if (item.activity_kind === 'reasoning-summary' || item.activity_kind === 'thinking') {
    return undefined;
  }
  if (item.activity_kind === 'tool-progress' || item.activity_kind === 'tool-summary') return <TerminalIcon />;
  if (item.activity_kind === 'information') return <InfoIcon />;
  if (item.activity_kind === 'diagnostic') return <IssuesIcon />;
  return <MonitorIcon />;
}

function activityDetailLines(presentations: readonly ActivityPresentation[]): ActivityDetail[] {
  return presentations.flatMap((presentation, index) => (
    index === 0 ? presentation.details : [presentation.summary, ...presentation.details]
  ));
}

function ActivityDetails({ lines, onCreatedTaskNavigate }: {
  lines: readonly ActivityDetail[];
  onCreatedTaskNavigate?: (providerSessionId: string) => void | Promise<void>;
}): JSX.Element {
  return (
    <div className="activity-details">
      {lines.map((line, index) => {
        if (typeof line === 'string') return <div key={index} className="activity-details__part">{line}</div>;
        if (line.kind === 'citation') {
          return (
            <div key={index} className="activity-details__part">
              <code>{line.ref}</code>{line.note ? ` — ${line.note}` : ''}
            </div>
          );
        }
        return (
          <div key={index} className="activity-details__part">
            {onCreatedTaskNavigate ? (
              <button
                type="button"
                className="activity-details__task-link"
                aria-label={`Open created task (${line.identity})`}
                data-provider-session-id={line.providerSessionId}
                data-provider-session-identity={line.identity}
                onClick={() => { void onCreatedTaskNavigate(line.providerSessionId); }}
              >
                Open task
              </button>
            ) : <code>{line.providerSessionId}</code>}
          </div>
        );
      })}
    </div>
  );
}

export function ActivityRow({ item, expanded, onExpandedChange, onCreatedTaskNavigate }: {
  item: DisplayActivityItem;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  onCreatedTaskNavigate?: (providerSessionId: string) => void | Promise<void>;
}): JSX.Element {
  const presentation = presentActivityItems([item])[0];
  const lines = activityDetailLines([presentation]);
  const disclosure = lines.length > 0
    ? {
        content: <ActivityDetails lines={lines} onCreatedTaskNavigate={onCreatedTaskNavigate} />,
        regionLabel: `${presentation.summary} details`,
        expanded,
        onExpandedChange,
      }
    : undefined;
  return (
    <CompactActivityRow
      className={`activity-block${item.type === 'activity' && item.severity ? ` activity-block--${item.severity}` : ''}`}
      icon={activityIcon(item)}
      summary={presentation.summary}
      disclosure={disclosure}
    />
  );
}

export function ActivityGroup({ items, expanded, onExpandedChange, onCreatedTaskNavigate }: {
  items: readonly DisplayActivityItem[];
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  onCreatedTaskNavigate?: (providerSessionId: string) => void | Promise<void>;
}): JSX.Element {
  const presentations = presentActivityItems(items);
  const state = [...new Set(items.flatMap(activityState))];
  const summary = [...new Set([...presentations[0].summary.split(' · '), ...state])].join(' · ');
  const lines = activityDetailLines(presentations);
  return (
    <CompactActivityRow
      className="activity-group"
      icon={activityIcon(items[0])}
      summary={summary}
      disclosure={lines.length > 0 ? {
        content: <ActivityDetails lines={lines} onCreatedTaskNavigate={onCreatedTaskNavigate} />,
        regionLabel: `${summary} details`,
        expanded,
        onExpandedChange,
      } : undefined}
    />
  );
}
