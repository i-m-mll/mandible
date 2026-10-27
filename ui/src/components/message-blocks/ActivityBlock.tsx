import { Icon } from '../icons/Icon';
import type { ActivityItem, ActivityKind } from '../../../../src/parsers/types';
import { CompactActivityRow } from '../shared/ChatDisclosure';
import type { DisplayActivityItem, ToolCallActivity } from '../stream-renderer/types';

import { plainActivityHeader } from './activityText';
import { classifyTool, presentTool, summarizeToolRunParts } from './toolPresentation';

export { plainActivityHeader };

const ACTIVITY_LABELS: Record<ActivityKind, string> = {
  'reasoning-summary': 'Thought', thinking: 'Thought',
  'tool-progress': 'Tool progress', 'tool-summary': 'Tool summary',
  status: 'Status', information: 'Information', diagnostic: 'Diagnostic',
};

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
  if (item.type === 'tool-call-activity') {
    return item.result?.is_error ? ['Failed'] : [];
  }
  if (item.type === 'thinking-block-activity') return [];
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
  if (item.type === 'tool-call-activity') return [];
  if (item.type === 'thinking-block-activity') return item.content.trim() ? [item.content.trim()] : [];
  if (item.activity_kind === 'thinking') return [...parts.slice(1)];
  const details = [...parts.slice(1)];
  if (item.tool_name) details.push(`Tool: ${item.tool_name}`);
  if (item.elapsed_ms !== undefined) details.push(`${item.elapsed_ms.toLocaleString()} ms`);
  return details;
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
  if (item.type === 'tool-call-activity') return presentTool(item.name, item.input, item.toolKind).phrase;
  if (item.type === 'thinking-block-activity') return 'Thought';
  const base = parts[0] ?? ACTIVITY_LABELS[item.activity_kind];
  return [...new Set([base, ...state])].join(' · ');
}

export function presentActivityItems(items: readonly DisplayActivityItem[]): ActivityPresentation[] {
  const presentations: ActivityPresentation[] = [];
  for (const item of items) {
    const parts = item.type === 'activity' ? plainActivityParts(item)
      : item.type === 'thinking-block-activity' ? item.content.split('\n').map((part) => part.trim()).filter(Boolean)
        : [];
    const state = activityState(item);
    presentations.push({
      summary: activitySummary(item, parts, state),
      details: activityDetails(item, parts),
      members: [item],
    });
  }
  return presentations;
}

function activityIcon(item: DisplayActivityItem): JSX.Element | undefined {
  if (item.type === 'provider-directive') {
    return item.directive.kind === 'memory-citation' ? <Icon name="history" /> : <Icon name="chat" />;
  }
  if (item.type === 'tool-call-activity') {
    return <Icon name={presentTool(item.name, item.input, item.toolKind).icon} />;
  }
  if (item.type === 'thinking-block-activity') return <Icon name="thought" />;
  if (item.activity_kind === 'thinking' || item.activity_kind === 'reasoning-summary') {
    return <Icon name="thought" />;
  }
  if (item.activity_kind === 'tool-progress' || item.activity_kind === 'tool-summary') return <Icon name="terminal" />;
  if (item.activity_kind === 'information') return <Icon name="info" />;
  if (item.activity_kind === 'diagnostic') return <Icon name="issues" />;
  return <Icon name="monitor" />;
}

function activityDetailLines(
  presentations: readonly ActivityPresentation[],
  includeMemberLabels = false,
): ActivityDetail[] {
  return presentations.flatMap((presentation, index) => {
    const item = presentation.members[0];
    if (includeMemberLabels && item) {
      if (item.type === 'thinking-block-activity' || item.type === 'tool-call-activity') return presentation.details;
      return [presentation.summary, ...presentation.details];
    }
    return index === 0 ? presentation.details : [presentation.summary, ...presentation.details];
  });
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

export function ActivityRow({ item, expanded, onExpandedChange, onCreatedTaskNavigate, memberRefs, detailsAvailable = false }: {
  item: DisplayActivityItem;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  onCreatedTaskNavigate?: (providerSessionId: string) => void | Promise<void>;
  memberRefs?: string;
  detailsAvailable?: boolean;
}): JSX.Element {
  const presentation = presentActivityItems([item])[0];
  const lines = activityDetailLines([presentation]);
  const disclosure = lines.length > 0 || detailsAvailable
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
      memberRefs={memberRefs}
    />
  );
}

function ActivityGroupDetails({
  items,
  renderMember,
}: {
  items: readonly DisplayActivityItem[];
  renderMember: (item: DisplayActivityItem, index: number) => JSX.Element | null;
}): JSX.Element {
  return (
    <div className="activity-details activity-group__members">
      {items.map(renderMember)}
    </div>
  );
}

function summarizeActivityRun(
  items: readonly DisplayActivityItem[],
  presentations: readonly ActivityPresentation[],
): string {
  const unifiedRun = items.some((item) => item.type !== 'activity'
    || item.activity_kind === 'thinking'
    || item.activity_kind === 'reasoning-summary');
  if (!unifiedRun) {
    const state = [...new Set(items.flatMap(activityState))];
    return [...new Set([...presentations[0].summary.split(' · '), ...state])].join(' · ');
  }

  const tools = items.filter((item): item is ToolCallActivity => item.type === 'tool-call-activity');
  const toolLabels = summarizeToolRunParts(tools.map((item) => ({ name: item.name, toolKind: item.toolKind })));
  const labels = new Map<string, { label: string; count: number }>();
  const presentationByMember = new Map<DisplayActivityItem, ActivityPresentation>();
  for (const presentation of presentations) {
    for (const member of presentation.members) presentationByMember.set(member, presentation);
  }
  const hasThinkingTool = tools.some((item) => classifyTool(item.name) === 'think');

  const addLabel = (key: string, label: string): void => {
    const existing = labels.get(key);
    if (existing) existing.count += 1;
    else labels.set(key, { label, count: 1 });
  };

  items.forEach((item) => {
    if (item.type === 'tool-call-activity') return;
    if (item.type === 'thinking-block-activity'
      || (item.type === 'activity' && (item.activity_kind === 'thinking' || item.activity_kind === 'reasoning-summary'))) {
      if (!hasThinkingTool) addLabel('thought', 'thought');
      return;
    }
    if (item.type === 'provider-directive') {
      if (item.directive.kind === 'memory-citation') addLabel('memory', 'used memory');
      else addLabel('created-task', 'created task');
      return;
    }
    const presentation = presentationByMember.get(item);
    if (presentation) {
      const label = presentation.summary.charAt(0).toLowerCase() + presentation.summary.slice(1);
      addLabel(`${item.activity_kind}:${label}`, label);
    }
  });

  const activityLabels = Array.from(labels.entries()).map(([key, value]) => {
    if (key === 'created-task' && value.count > 1) return 'created tasks';
    return value.label;
  });
  const toolStates = [...new Set(tools.flatMap(activityState))]
    .map((state) => state.charAt(0).toLowerCase() + state.slice(1));
  const summary = [...toolLabels, ...activityLabels, ...toolStates].join('; ');
  return summary.charAt(0).toUpperCase() + summary.slice(1);
}

export function ActivityGroup({
  items,
  expanded,
  onExpandedChange,
  memberRefs,
  renderMember,
  active = false,
}: {
  items: readonly DisplayActivityItem[];
  active?: boolean;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  memberRefs?: readonly (string | undefined)[];
  renderMember: (item: DisplayActivityItem, index: number) => JSX.Element | null;
}): JSX.Element {
  const presentations = presentActivityItems(items);
  const summary = summarizeActivityRun(items, presentations);
  const hasMemberDisclosure = items.some((item) => item.type !== 'activity'
    || item.activity_kind === 'thinking'
    || item.activity_kind === 'reasoning-summary')
    || activityDetailLines(presentations).length > 0;
  return (
    <CompactActivityRow
      className={`activity-group${active ? ' activity-group--active' : ''}`}
      icon={activityIcon((active && items.find((item) => item.type === 'tool-call-activity' && item.executionActive)) || items[0])}
      summary={summary}
      memberRefs={memberRefs?.filter(Boolean).join(' ')}
      disclosure={hasMemberDisclosure ? {
        content: (
          <ActivityGroupDetails
            items={items}
            renderMember={renderMember}
          />
        ),
        regionLabel: `${summary} details`,
        expanded,
        onExpandedChange,
      } : undefined}
    />
  );
}
