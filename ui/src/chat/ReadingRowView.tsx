import type { ComponentChildren, Ref, JSX } from 'preact';
import { memo } from 'preact/compat';
import { PermissionApprovalCard } from '../components/console/PermissionApprovalCard';
import { TurnGroup } from '../components/message-blocks/TurnGroup';
import { ReadingContent, type ReadingContentProps } from './ReadingContent';
import type { ReadingRow } from './readingProjection';

export type ReadingRowFrameProps = {
  row: ReadingRow;
  index?: number;
  elementRef?: Ref<HTMLDivElement>;
  children: ComponentChildren;
  style?: JSX.CSSProperties;
};

export function ReadingRowFrame({ row, index, elementRef, children, style }: ReadingRowFrameProps) {
  return <div style={style} ref={elementRef} data-index={index} data-reading-key={row.key} className={`stream-renderer__virtual-row${row.turnStart ? ' stream-renderer__virtual-row--turn-start' : ''}${row.turnEnd ? ' stream-renderer__virtual-row--turn-end' : ''}${row.activityMember ? ' stream-renderer__virtual-row--activity-member' : ''}${row.activityEnd ? ' stream-renderer__virtual-row--activity-end' : ''}${row.activityGroup?.expanded ? ' stream-renderer__virtual-row--activity-open' : ''}`}>{children}</div>;
}

const StableReadingContent = memo(ReadingContent);
export function ReadingRowBody(props: ReadingContentProps) {
  return props.row.kind === 'permission' && props.activePermissionRequest && props.onPermissionRespond
    ? <TurnGroup speaker="system"><PermissionApprovalCard request={props.activePermissionRequest} backendType={props.permissionBackendType ?? 'sdk'} onRespond={props.onPermissionRespond} /></TurnGroup>
    : <StableReadingContent {...props} />;
}

export function ReadingRowView(props: ReadingContentProps) {
  return <ReadingRowFrame row={props.row}><ReadingRowBody {...props} /></ReadingRowFrame>;
}
