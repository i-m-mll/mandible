import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { DOMAIN_EVENTS } from '../../../src/contracts';
import type { NotificationTarget } from '../../../src/notices/notification-log';
import {
  canPerformOperation,
  getNotifications,
  markNotificationRead,
  type InstanceInfo,
  type NotificationListItem,
  type NotificationListResponse,
} from '../api';
import { useLiveLoad, useViewActive } from '../app-shell';
import { Icon } from '../components/icons/Icon';
import { appTip } from '../components/shared/AppHoverTips';
import { ContextualAction } from '../components/shared/ContextualAction';
import { DetailPaneHeader } from '../components/shared/DetailPaneHeader';
import { DetailPaneNotice } from '../components/shared/DetailPaneNotice';
import { DetailPaneShell } from '../components/shared/DetailPaneShell';
import { OfficialProviderMark, type OfficialProviderMarkKind } from '../components/shared/OfficialProviderMark';
import { formatRelativeTime } from '../lib/format';
import { entityHref, shortRouteId, viewHref } from '../routing';
import { acquireSharedSse } from '../sse-shared';

type NotificationLog = { rows: NotificationListItem[]; nextBefore: number | null };

const LOAD_OLDER_THRESHOLD_PX = 160;

const PROVIDER_MARKS: Record<string, OfficialProviderMarkKind | null> = {
  claude: 'anthropic',
  codex: 'openai',
  gemini: null,
};

export async function warmInitialData(): Promise<void> {
  await getNotifications();
}

function newestFirst(rows: NotificationListItem[]): NotificationListItem[] {
  return [...new Map(rows.map((row) => [row.id, row])).values()]
    .sort((a, b) => b.raised_at - a.raised_at || b.id.localeCompare(a.id));
}

/** The first page replaces what it covers; older pages already loaded stay. */
function withFirstPage(current: NotificationLog | null, page: NotificationListResponse): NotificationLog {
  if (page.next_before === null || !current) return { rows: page.notifications, nextBefore: page.next_before };
  const older = current.rows.filter((row) => row.raised_at < page.next_before!);
  return { rows: newestFirst([...page.notifications, ...older]), nextBefore: older.length ? current.nextBefore : page.next_before };
}

function targetLink(target: NotificationTarget): { href: string; label: string } {
  switch (target.kind) {
    case 'auth_request':
      return { href: entityHref('auth', target.id), label: `auth:${shortRouteId(target.id)}` };
    case 'conversation':
      return { href: viewHref('console', { conversation: target.id }), label: `conversation:${shortRouteId(target.id)}` };
    case 'reminder':
      return { href: viewHref('tasks', { task: `mandible-reminder:${target.id}` }), label: `reminder:${shortRouteId(target.id)}` };
  }
}

function Time({ value, tip }: { value: number; tip: string }): JSX.Element {
  const date = new Date(value);
  return (
    <time dateTime={date.toISOString()} {...appTip(`${tip} ${date.toLocaleString()}`)}>
      {formatRelativeTime(value, { style: 'recent' })}
    </time>
  );
}

function Recipient({ row }: { row: NotificationListItem }): JSX.Element {
  if (row.recipient.kind === 'user') {
    return (
      <span className="notification-row__recipient" {...appTip('You')}>
        <Icon name="notificationUser" size={14} label="You" />
      </span>
    );
  }
  const { provider, session_id: sessionId, responsible_agent_ref: agent } = row.recipient;
  const mark = PROVIDER_MARKS[provider];
  return (
    <a
      className="notification-row__recipient notification-row__recipient--session"
      href={viewHref('console', { session: sessionId })}
      {...appTip(agent)}
    >
      {mark ? <OfficialProviderMark kind={mark} className="notification-row__provider-mark" accessibleLabel={provider} /> : null}
      <span className="notification-row__ref">{shortRouteId(sessionId)}</span>
    </a>
  );
}

function NotificationRow({
  row,
  canRead,
  onRead,
}: {
  row: NotificationListItem;
  canRead: boolean;
  onRead: (id: string) => void;
}): JSX.Element {
  const link = row.target ? targetLink(row.target) : null;
  const user = row.recipient.kind === 'user';
  const unread = user && row.delivered_at === null;
  return (
    <li
      className={`notification-row contextual-action-owner${unread ? ' notification-row--unread' : ''}`}
      data-recipient={row.recipient.kind}
    >
      <div className="notification-row__meta">
        <Recipient row={row} />
        {link ? <a className="artifact-xref resource-ref__link notification-row__subject" href={link.href}>{link.label}</a> : null}
        <span className="notification-row__times">
          <Time value={row.raised_at} tip="Raised" />
          {row.delivered_at !== null ? (
            <>
              <span className="notification-row__arrow" aria-hidden="true">→</span>
              <Time value={row.delivered_at} tip={user ? 'Read' : 'Delivered'} />
            </>
          ) : user ? null : (
            <span className="notification-row__state">undelivered</span>
          )}
        </span>
        {unread && canRead ? (
          <span className="notification-row__actions contextual-action-group contextual-action-group--persistent">
            <ContextualAction aria-label="Mark read" {...appTip('Mark read')} onClick={() => onRead(row.id)}>
              <Icon name="markRead" size={14} />
            </ContextualAction>
          </span>
        ) : null}
      </div>
      {row.text ? <p className="notification-row__text">{row.text}</p> : null}
    </li>
  );
}

export function NotificationsView({ instance = null }: { instance?: InstanceInfo | null }): JSX.Element {
  const [log, setLog] = useState<NotificationLog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadingOlder = useRef(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const refresh = useLiveLoad(async (signal) => {
    try {
      const page = await getNotifications({ signal });
      if (signal.aborted) return;
      setLog((current) => withFirstPage(current, page));
      setError(null);
    } catch (cause) {
      if (!signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  const viewActive = useViewActive();
  useEffect(() => {
    if (!viewActive) return undefined;
    const client = acquireSharedSse();
    const off = client.on(DOMAIN_EVENTS.NOTIFICATION_CHANGED, () => refresh());
    client.connect();
    return () => {
      off();
      client.close();
    };
  }, [refresh, viewActive]);

  const loadOlder = useCallback(async () => {
    const before = log?.nextBefore;
    if (before === null || before === undefined || loadingOlder.current) return;
    loadingOlder.current = true;
    try {
      const page = await getNotifications({ before });
      setLog((current) => current && current.nextBefore === before
        ? { rows: newestFirst([...current.rows, ...page.notifications]), nextBefore: page.next_before }
        : current);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      loadingOlder.current = false;
    }
  }, [log?.nextBefore]);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return undefined;
    const check = () => {
      if (body.scrollHeight - body.scrollTop - body.clientHeight < LOAD_OLDER_THRESHOLD_PX) void loadOlder();
    };
    check();
    body.addEventListener('scroll', check, { passive: true });
    return () => body.removeEventListener('scroll', check);
  }, [loadOlder, log]);

  const read = useCallback(async (id: string) => {
    try {
      const updated = await markNotificationRead(id);
      setLog((current) => current && { ...current, rows: current.rows.map((row) => (row.id === id ? updated : row)) });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  return (
    <DetailPaneShell
      className="notifications-view"
      bodyClassName="notifications-view__body"
      bodyRef={bodyRef}
      headerPlacement="frame"
      header={<DetailPaneHeader variant="compact" title="Notifications" />}
      notice={error ? (
        <DetailPaneNotice severity="error" density="compact" source="notifications-load" title="Notifications could not be loaded">
          {error}
        </DetailPaneNotice>
      ) : null}
      ariaBusy={log === null && error === null}
    >
      {log ? (
        <ol className="notification-log" aria-label="Notifications">
          {log.rows.map((row) => (
            <NotificationRow
              key={row.id}
              row={row}
              canRead={canPerformOperation(instance, 'POST', `/api/notifications/${encodeURIComponent(row.id)}/read`)}
              onRead={(id) => void read(id)}
            />
          ))}
        </ol>
      ) : null}
    </DetailPaneShell>
  );
}
