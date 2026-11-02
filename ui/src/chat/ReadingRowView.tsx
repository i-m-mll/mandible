import type { ComponentChildren, Ref, JSX } from 'preact';
import { memo } from 'preact/compat';
import { PermissionApprovalCard } from '../components/console/PermissionApprovalCard';
import { TurnGroup } from '../components/message-blocks/TurnGroup';
import { ReadingContent, type ReadingContentProps } from './ReadingContent';
import type { ReadingRow } from './readingProjection';
import { isCompactReadingRow } from './readingRowPresentation';

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
  return <div style={style} ref={elementRef} aria-busy={busy || undefined} data-index={index} data-reading-key={row.key} className={`stream-renderer__virtual-row${compact ? ' stream-renderer__virtual-row--compact' : ''}${row.turnStart && !compact ? ' stream-renderer__virtual-row--turn-start' : ''}${row.turnEnd && !compact ? ' stream-renderer__virtual-row--turn-end' : ''}${row.activityMember ? ' stream-renderer__virtual-row--activity-member' : ''}${row.activityEnd && !compact ? ' stream-renderer__virtual-row--activity-end' : ''}${row.activityGroup?.expanded ? ' stream-renderer__virtual-row--activity-open' : ''}`}>{children}</div>;
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
