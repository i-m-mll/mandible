import { Icon } from '../icons/Icon';
import type { ComponentChildren } from 'preact';
import { CompactActivityRow } from '../shared/ChatDisclosure';
import { ReasoningDetails } from '../shared/ReasoningDetails';
import { useContext } from 'preact/hooks';
import { activityDirectiveTargets } from '../../../../src/presentation/activity-targets';
import { ActivityTargetLink, ActivityTargetLinks, ActivityTargetLabelsContext, activityTargetLabel } from '../shared/ActivityTargetLinks';
import type { DisplayActivityItem } from '../stream-renderer/types';

import { plainActivityHeader } from './activityText';
import { activityIconName, presentActivityItems, presentReasoning, activityDetailLines, summarizeActivityRun, type ActivityDetail } from '../../../../src/presentation/activity-presentation';
export { plainActivityParts, presentActivityItems } from '../../../../src/presentation/activity-presentation';
export type { ActivityPresentation } from '../../../../src/presentation/activity-presentation';

export { plainActivityHeader };

function activityIcon(item: DisplayActivityItem): JSX.Element {
  return <Icon name={activityIconName(item)} />;
}

function ActivityDetails({ lines }: {
  lines: readonly ActivityDetail[];
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
            <ActivityTargetLink target={{kind:'thread',provider:'codex',sessionId:line.providerSessionId}} />
          </div>
        );
      })}
    </div>
  );
}

export function ActivityRow({ item, expanded, onExpandedChange, memberRefs, detailsAvailable = false, headerMetadata }: {
  item: DisplayActivityItem;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean, trigger?: HTMLElement) => void;
  memberRefs?: string;
  detailsAvailable?: boolean;
  headerMetadata?: ComponentChildren;
}): JSX.Element {
  const labels = useContext(ActivityTargetLabelsContext);
  const presentation = presentActivityItems([item])[0];
  const lines = activityDetailLines([presentation]);
  const reasoning = item.type === 'activity' && (item.activity_kind === 'thinking' || item.activity_kind === 'reasoning-summary')
    ? presentReasoning(item.parts.map(part => part.text)) : undefined;
  const targets = item.type === 'provider-directive' && item.directive.kind === 'created-thread' ? activityDirectiveTargets(item.directive) : [];
  const summary = targets.length ? `${presentation.summary} ${targets.map(target=>activityTargetLabel(target,labels)).join(', ')}` : presentation.summary;
  const disclosure = !targets.length && (lines.length > 0 || detailsAvailable)
    ? {
        content: reasoning ? <ReasoningDetails parts={reasoning.details} /> : <ActivityDetails lines={lines} />,
        regionLabel: `${presentation.summary} details`,
        expanded,
        onExpandedChange,
      }
    : undefined;
  return (
    <CompactActivityRow
      className={`activity-block${item.type === 'activity' && item.severity ? ` activity-block--${item.severity}` : ''}`}
      icon={activityIcon(item)}
      summary={summary}
      summaryContent={targets.length ? <>{presentation.summary} <ActivityTargetLinks targets={targets} /></> : undefined}
      metadata={headerMetadata}
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
    <div className="activity-details activity-group__members activity-nested-headers">
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
  presentation,
  externalMembers = false,
  headerMetadata,
}: {
  items: readonly DisplayActivityItem[];
  active?: boolean;
  actions?: import('preact').ComponentChildren;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean, trigger?: HTMLElement) => void;
  memberRefs?: readonly (string | undefined)[];
  renderMember: (item: DisplayActivityItem, index: number) => JSX.Element | null;
  /** Complete canonical run facts when member bodies are loaded independently. */
  presentation?: ReturnType<typeof import('../../../../src/presentation/activity-presentation').presentActivityRunFacts>;
  externalMembers?: boolean;
  headerMetadata?: ComponentChildren;
}): JSX.Element {
  const presentations = presentActivityItems(items);
  const summary = presentation?.summary ?? summarizeActivityRun(items, presentations);
  const hasMemberDisclosure = presentation?.hasDisclosure ?? (items.some((item) => item.type !== 'activity'
    || item.activity_kind === 'thinking'
    || item.activity_kind === 'reasoning-summary')
    || activityDetailLines(presentations).length > 0);
  const activeTool = active && items.find((item) => item.type === 'tool-call-activity' && item.executionActive);
  return (
    <CompactActivityRow
      className={`activity-group${active ? ' activity-group--active' : ''}`}
      collection
      icon={activeTool ? activityIcon(activeTool) : presentation ? <Icon name={presentation.icon} /> : activityIcon(items[0])}
      summary={summary}
      metadata={headerMetadata}
      actions={actions}
      memberRefs={memberRefs?.filter(Boolean).join(' ')}
      disclosure={hasMemberDisclosure ? {
        content: externalMembers ? null : (
          <ActivityGroupDetails
            items={items}
            renderMember={renderMember}
          />
        ),
        regionLabel: `${summary} details`,
        expanded,
        defaultExpanded: presentation?.defaultExpanded,
        onExpandedChange,
      } : undefined}
    />
  );
}
