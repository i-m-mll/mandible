import { Icon } from '../icons/Icon';
import { CompactActivityRow } from '../shared/ChatDisclosure';
import type { DisplayActivityItem } from '../stream-renderer/types';

import { plainActivityHeader } from './activityText';
import { activityIconName, presentActivityItems, activityDetailLines, summarizeActivityRun, type ActivityDetail } from '../../../../src/presentation/activity-presentation';
export { plainActivityParts, presentActivityItems } from '../../../../src/presentation/activity-presentation';
export type { ActivityPresentation } from '../../../../src/presentation/activity-presentation';

export { plainActivityHeader };

function activityIcon(item: DisplayActivityItem): JSX.Element {
  return <Icon name={activityIconName(item)} />;
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

export function ActivityGroup({
  items,
  expanded,
  onExpandedChange,
  memberRefs,
  renderMember,
  active = false,
  actions,
}: {
  items: readonly DisplayActivityItem[];
  active?: boolean;
  actions?: import('preact').ComponentChildren;
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
      actions={actions}
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
