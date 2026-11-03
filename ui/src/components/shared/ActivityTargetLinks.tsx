import { createContext, type JSX } from 'preact';
import { useContext } from 'preact/hooks';
import { activityTargetKey, type ActivityTarget } from '../../../../src/presentation/activity-targets';
import type { ChatRouteTarget } from '../../api';
import { chatRouteHref } from '../../chat/messageLinks';

export type ActivityTargetLabel = { label: string; selection?: ChatRouteTarget };
export type ActivityTargetLabels = Readonly<Record<string, ActivityTargetLabel>>;
export const ActivityTargetLabelsContext = createContext<ActivityTargetLabels>({});

export function ActivityTargetLink({ target }: { target: ActivityTarget }): JSX.Element {
  const labels = useContext(ActivityTargetLabelsContext);
  const resolved = labels[activityTargetKey(target)];
  const nativeId = target.kind === 'thread' ? target.sessionId : target.kind === 'pending-thread' ? target.clientThreadId : target.agentId;
  const label = resolved?.label || target.labelHint || nativeId.slice(0, 8);
  const selection = resolved?.selection ?? (target.kind === 'thread' ? { type: 'session' as const, id: target.sessionId } : undefined);
  return selection ? <a href={chatRouteHref(selection, window.location.hash)}>{label}</a> : <span>{label}</span>;
}

export function ActivityTargetLinks({ targets }: { targets: readonly ActivityTarget[] }): JSX.Element {
  return <>{targets.map((target, index) => <span key={`${activityTargetKey(target)}:${index}`}>{index ? ', ' : ''}<ActivityTargetLink target={target} /></span>)}</>;
}
