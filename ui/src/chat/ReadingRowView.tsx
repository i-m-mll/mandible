import type { ComponentChildren, Ref, JSX } from 'preact';
import { memo } from 'preact/compat';
import { PermissionApprovalCard } from '../components/console/PermissionApprovalCard';
import { TurnGroup } from '../components/message-blocks/TurnGroup';
import { ReadingContent, type ReadingContentProps } from './ReadingContent';
import type { ReadingRow } from './readingProjection';
import { isCompactReadingRow } from './readingRowPresentation';
import { ActivityTargetLabelsContext } from '../components/shared/ActivityTargetLinks';

export type ReadingRowFrameProps = {
  row: Pick<ReadingRow, 'key' | 'turnStart' | 'turnEnd' | 'activityMember' | 'activityEnd' | 'activityGroup'> & Partial<Pick<ReadingRow, 'kind' | 'nodes'>>;
  busy?: boolean;
  index?: number;
  elementRef?: Ref<HTMLDivElement>;
  children: ComponentChildren;
  style?: JSX.CSSProperties;
};

export function ReadingRowFrame({ row, index, busy, elementRef, children, style }: ReadingRowFrameProps) {
  const compact = isCompactReadingRow(row);
  const leading = !row.activityMember;
  const trailing = row.activityMember ? row.activityEnd : !row.activityGroup?.expanded;
  return <div style={style} ref={elementRef} aria-busy={busy || undefined} data-index={index} data-reading-key={row.key} className={`stream-renderer__virtual-row${compact ? ' stream-renderer__virtual-row--compact' : ''}${leading ? ' stream-renderer__virtual-row--item-start' : ''}${trailing ? ' stream-renderer__virtual-row--item-end' : ''}${row.activityMember ? ' stream-renderer__virtual-row--activity-member activity-nested-headers' : ''}${row.activityGroup?.expanded ? ' stream-renderer__virtual-row--activity-open' : ''}`}>{children}</div>;
}

const StableReadingContent = memo(ReadingContent);
export function ReadingRowBody(props: ReadingContentProps) {
  return <ActivityTargetLabelsContext.Provider value={props.targetLabels ?? {}}>{props.row.kind === 'permission' && props.activePermissionRequest && props.onPermissionRespond
    ? <TurnGroup speaker="system"><PermissionApprovalCard request={props.activePermissionRequest} backendType={props.permissionBackendType ?? 'sdk'} onRespond={props.onPermissionRespond} /></TurnGroup>
    : <StableReadingContent {...props} />}</ActivityTargetLabelsContext.Provider>;
}

export function ReadingRowView(props: ReadingContentProps) {
  return <ReadingRowFrame row={props.row}><ReadingRowBody {...props} /></ReadingRowFrame>;
}
