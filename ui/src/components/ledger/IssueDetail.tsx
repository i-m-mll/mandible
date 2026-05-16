import { useMemo, useState } from 'preact/hooks';
import { marked } from 'marked';
import { sanitizeHtml, sanitizeMarkdown } from '../../sanitize';
import type {
  LedgerIssueDetailAuthRequest,
  LedgerIssueDetailComment,
  LedgerIssueDetailConflict,
  LedgerIssueDetailProjection,
  LedgerIssueDetailRelationship,
  LedgerIssueDetailSession,
} from '../../api';

type EntityType = 'issue' | 'session' | 'auth_request' | 'conversation';

export type LedgerIssueDetailProps = {
  detail: LedgerIssueDetailProjection;
  compact?: boolean;
  actionInFlight?: boolean;
  onAddComment?: (body: string) => Promise<void> | void;
  onSetStatus?: (status: 'open' | 'closed') => Promise<void> | void;
  onStartAgent?: () => Promise<void> | void;
  onOpenEntity?: (type: EntityType, id: string, repoId?: string) => void;
  onShowChildren?: (issue: LedgerIssueDetailProjection) => void;
  onResolveConflict?: (conflictId: string, resolution: string, status?: 'resolved' | 'dismissed') => Promise<void> | void;
};

export function LedgerIssueDetail({
  detail,
  compact = false,
  actionInFlight = false,
  onAddComment,
  onSetStatus,
  onStartAgent,
  onOpenEntity,
  onShowChildren,
  onResolveConflict,
}: LedgerIssueDetailProps): JSX.Element {
  const [commentText, setCommentText] = useState('');
  const [showComposer, setShowComposer] = useState(false);
  const [localBusy, setLocalBusy] = useState(false);
  const busy = actionInFlight || localBusy;
  const resolvingAuth = detail.auth_requests.find((auth) =>
    (auth.link_type === 'resolves' || auth.link_type === 'fixed_by') &&
    (auth.status === 'completed' || auth.status === 'approved' || auth.status === 'executing')
  );
  const liveSession = detail.sessions.find((session) => session.status === 'active' || session.status === 'idle') ?? null;
  const activeSessions = detail.sessions.filter((session) => session.status === 'active' || session.status === 'idle');
  const historicalSessions = detail.sessions.filter((session) => session.status !== 'active' && session.status !== 'idle');
  const primaryWorkUnit = detail.work_units[0] ?? null;
  const syncTone = detail.sync.state === 'clean'
    ? 'clean'
    : detail.sync.state === 'pending'
      ? 'pending'
      : detail.sync.state === 'conflicted'
        ? 'conflicted'
        : 'failed';

  const submitComment = async () => {
    if (!onAddComment || !commentText.trim() || busy) return;
    setLocalBusy(true);
    try {
      await onAddComment(commentText.trim());
      setCommentText('');
      setShowComposer(false);
    } finally {
      setLocalBusy(false);
    }
  };

  return (
    <article className={`ledger-issue-detail${compact ? ' ledger-issue-detail--compact' : ''}`}>
      <header className="ledger-issue-detail__header">
        <div className="ledger-issue-detail__heading">
          <div className="ledger-issue-detail__eyebrow">
            <span>{detail.project.repo_name ?? detail.project.display_name}</span>
            <code>{detail.display_id}</code>
          </div>
          <h2 dangerouslySetInnerHTML={{ __html: inlineMarkdown(detail.title) }} />
        </div>
        <div className="ledger-issue-detail__header-actions">
          <StatusPill
            status={detail.status}
            resolution={detail.resolution}
            linkedAuth={resolvingAuth}
            onOpenAuth={onOpenEntity ? (auth) => onOpenEntity('auth_request', auth.id) : undefined}
          />
          <span className={`ledger-sync-pill ledger-sync-pill--${syncTone}`}>{syncLabel(detail.sync.state)}</span>
        </div>
      </header>

      <div className="ledger-issue-detail__meta">
        <span>{detail.kind}</span>
        <span>{detail.priority}</span>
        <span>{detail.author.display}</span>
        <span>{formatRelativeTime(detail.created_at)}</span>
        {detail.source && <span>{detail.source}</span>}
      </div>

      {detail.labels.length > 0 && (
        <div className="ledger-issue-detail__labels">
          {detail.labels.map((label) => (
            <span key={label} className="ledger-label">{displayLabel(label)}</span>
          ))}
          {detail.labels.includes('umbrella') && onShowChildren && (
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => onShowChildren(detail)}>
              Show children
            </button>
          )}
        </div>
      )}

      {(liveSession || primaryWorkUnit || onStartAgent || onSetStatus) && (
        <div className="ledger-issue-detail__actions">
          {liveSession && (
            <a className="issue-hub__action-btn issue-hub__action-btn--primary" href={`#/console?session=${encodeURIComponent(liveSession.id)}`}>
              Open Console
            </a>
          )}
          {!liveSession && onStartAgent && (
            <button
              type="button"
              className="issue-hub__action-btn issue-hub__action-btn--secondary"
              disabled={busy}
              onClick={() => void onStartAgent()}
            >
              {primaryWorkUnit?.continuation ? 'Resume Work' : 'Start Agent'}
            </button>
          )}
          {onSetStatus && (
            <button
              type="button"
              className={`btn ${detail.status === 'open' ? 'btn--danger' : 'btn--success'}`}
              disabled={busy}
              onClick={() => void onSetStatus(detail.status === 'open' ? 'closed' : 'open')}
            >
              {detail.status === 'open' ? 'Close Issue' : 'Reopen Issue'}
            </button>
          )}
        </div>
      )}

      <section className="ledger-issue-detail__section">
        <MarkdownBlock className="ledger-issue-detail__body spec-panel" empty="No description." source={detail.body} />
      </section>

      <section className="ledger-issue-detail__section">
        <SectionTitle title="Comments" count={detail.comments.length} />
        {detail.comments.length === 0 ? (
          <div className="ledger-issue-detail__empty">No comments yet.</div>
        ) : (
          <div className="ledger-comment-list">
            {detail.comments.map((comment) => (
              <CommentCard key={comment.id} comment={comment} />
            ))}
          </div>
        )}
        {onAddComment && (
          <div className="ledger-comment-composer">
            {!showComposer ? (
              <button type="button" className="btn btn--ghost" onClick={() => setShowComposer(true)}>
                Add Comment
              </button>
            ) : (
              <>
                <textarea
                  className="issue-comment-form__input"
                  placeholder="Write a comment..."
                  rows={compact ? 3 : 4}
                  value={commentText}
                  onInput={(event) => setCommentText(event.currentTarget.value)}
                />
                <div className="ledger-comment-composer__actions">
                  <button type="button" className="btn btn--active" disabled={busy || !commentText.trim()} onClick={submitComment}>
                    Submit Comment
                  </button>
                  <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => setShowComposer(false)}>
                    Cancel
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </section>

      {detail.relationships.length > 0 && (
        <section className="ledger-issue-detail__section">
          <SectionTitle title="Relationships" count={detail.relationships.length} />
          <RelationshipList relationships={detail.relationships} onOpenEntity={onOpenEntity} />
        </section>
      )}

      {detail.auth_requests.length > 0 && (
        <section className="ledger-issue-detail__section">
          <SectionTitle title="Auth Evidence" count={detail.auth_requests.length} />
          <AuthEvidenceShelf authRequests={detail.auth_requests} onOpenEntity={onOpenEntity} />
        </section>
      )}

      {(activeSessions.length > 0 || historicalSessions.length > 0) && (
        <section className="ledger-issue-detail__section">
          <SectionTitle title="Sessions" count={detail.sessions.length} />
          <SessionHistory active={activeSessions} historical={historicalSessions} onOpenEntity={onOpenEntity} />
        </section>
      )}

      {detail.work_units.length > 0 && (
        <section className="ledger-issue-detail__section">
          <SectionTitle title="Work Units" count={detail.work_units.length} />
          <div className="ledger-kv-list">
            {detail.work_units.map((work) => (
              <div key={work.id} className="ledger-kv-card">
                <span>{work.state}</span>
                <code>{work.branch ?? work.id}</code>
                {work.assigned_session_id && <small>assigned {work.assigned_session_id.slice(0, 10)}</small>}
              </div>
            ))}
          </div>
        </section>
      )}

      {(detail.sync.state !== 'clean' || detail.conflicts.length > 0) && (
        <section className="ledger-issue-detail__section">
          <SectionTitle title="Sync" count={detail.conflicts.length || undefined} />
          <SyncStatus detail={detail} onResolveConflict={onResolveConflict} busy={busy} />
        </section>
      )}
    </article>
  );
}

function StatusPill({
  status,
  resolution,
  linkedAuth,
  onOpenAuth,
}: {
  status: string;
  resolution: string | null;
  linkedAuth?: LedgerIssueDetailAuthRequest;
  onOpenAuth?: (auth: LedgerIssueDetailAuthRequest) => void;
}): JSX.Element {
  const label = status === 'closed' && resolution ? `${status}: ${resolution}` : status;
  const cls = status === 'open' ? 'status-pill--success' : resolution === 'merged' ? 'status-pill--merged' : 'status-pill--dismissed';
  if (linkedAuth && onOpenAuth) {
    return (
      <button type="button" className={`status-pill status-pill--lg ledger-status-button ${cls}`} onClick={() => onOpenAuth(linkedAuth)}>
        {label}
      </button>
    );
  }
  return <span className={`status-pill status-pill--lg ${cls}`}>{label}</span>;
}

function CommentCard({ comment }: { comment: LedgerIssueDetailComment }): JSX.Element {
  return (
    <div className="ledger-comment-card">
      <div className="ledger-comment-card__header">
        <span>{comment.author.display}</span>
        <em>{comment.author.type.replace(/_/g, ' ')}</em>
        <small>{comment.source}</small>
        <time>{formatRelativeTime(comment.created_at)}</time>
      </div>
      <MarkdownBlock className="ledger-comment-card__body spec-panel" source={comment.body} empty="" />
    </div>
  );
}

function RelationshipList({
  relationships,
  onOpenEntity,
}: {
  relationships: LedgerIssueDetailRelationship[];
  onOpenEntity?: LedgerIssueDetailProps['onOpenEntity'];
}): JSX.Element {
  return (
    <div className="ledger-relationship-list">
      {relationships.map((relationship) => {
        const related = relationship.related_issue;
        return (
          <button
            key={relationship.id}
            type="button"
            className="ledger-relationship-row"
            disabled={!related || !onOpenEntity}
            onClick={() => related && onOpenEntity?.('issue', related.display_id)}
          >
            <span>{relationship.direction === 'incoming' ? 'from' : 'to'}</span>
            <strong>{relationship.relationship_type.replace(/_/g, ' ')}</strong>
            <code>{related ? `${related.display_id} ${related.title}` : 'missing issue'}</code>
          </button>
        );
      })}
    </div>
  );
}

function AuthEvidenceShelf({
  authRequests,
  onOpenEntity,
}: {
  authRequests: LedgerIssueDetailAuthRequest[];
  onOpenEntity?: LedgerIssueDetailProps['onOpenEntity'];
}): JSX.Element {
  return (
    <div className="ledger-evidence-list">
      {authRequests.map((auth) => (
        <button
          key={`${auth.id}:${auth.link_type}`}
          type="button"
          className="ledger-evidence-row"
          disabled={!onOpenEntity}
          onClick={() => onOpenEntity?.('auth_request', auth.id)}
        >
          <span>{auth.link_type.replace(/_/g, ' ')}</span>
          <strong>{auth.title || auth.id}</strong>
          <code>{auth.status}{auth.head_branch ? ` · ${auth.head_branch}` : ''}</code>
        </button>
      ))}
    </div>
  );
}

function SessionHistory({
  active,
  historical,
  onOpenEntity,
}: {
  active: LedgerIssueDetailSession[];
  historical: LedgerIssueDetailSession[];
  onOpenEntity?: LedgerIssueDetailProps['onOpenEntity'];
}): JSX.Element {
  return (
    <div className="ledger-session-history">
      {active.map((session) => (
        <SessionRow key={session.id} session={session} onOpenEntity={onOpenEntity} />
      ))}
      {historical.length > 0 && (
        <details className="ledger-session-history__historical">
          <summary>{historical.length} historical</summary>
          {historical.map((session) => (
            <SessionRow key={session.id} session={session} onOpenEntity={onOpenEntity} />
          ))}
        </details>
      )}
    </div>
  );
}

function SessionRow({
  session,
  onOpenEntity,
}: {
  session: LedgerIssueDetailSession;
  onOpenEntity?: LedgerIssueDetailProps['onOpenEntity'];
}): JSX.Element {
  return (
    <button
      type="button"
      className="ledger-session-row"
      disabled={!onOpenEntity}
      onClick={() => onOpenEntity?.(session.has_conversation ? 'conversation' : 'session', session.id)}
    >
      <span className={`ledger-session-row__dot ledger-session-row__dot--${session.status}`} />
      <strong>{session.app || session.agent_type || 'session'}</strong>
      <code>{session.branch ?? session.id}</code>
      <em>{session.status}</em>
    </button>
  );
}

function SyncStatus({
  detail,
  onResolveConflict,
  busy,
}: {
  detail: LedgerIssueDetailProjection;
  onResolveConflict?: LedgerIssueDetailProps['onResolveConflict'];
  busy: boolean;
}): JSX.Element {
  const outboxEntries = Object.entries(detail.sync.outbox).filter(([, count]) => count > 0);
  return (
    <div className="ledger-sync-panel">
      <div className={`ledger-sync-panel__summary ledger-sync-panel__summary--${detail.sync.state}`}>
        <span>{syncLabel(detail.sync.state)}</span>
        {outboxEntries.length > 0 && (
          <code>{outboxEntries.map(([status, count]) => `${status} ${count}`).join(' · ')}</code>
        )}
      </div>
      {detail.conflicts.map((conflict) => (
        <div key={conflict.id} className="ledger-conflict-card">
          <div className="ledger-conflict-card__header">
            <strong>{conflict.field}</strong>
            <span>{conflict.adapter}</span>
          </div>
          <div className="ledger-conflict-card__values">
            <code>{safeJson(conflict.local_value)}</code>
            <code>{safeJson(conflict.remote_value)}</code>
          </div>
          {onResolveConflict && (
            <div className="ledger-conflict-card__actions">
              <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => void onResolveConflict(conflict.id, 'keep_mandible', 'resolved')}>
                Keep Mandible
              </button>
              <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => void onResolveConflict(conflict.id, 'dismissed', 'dismissed')}>
                Dismiss
              </button>
              <button type="button" className="btn btn--ghost btn--sm" disabled title="Manual merge is not wired yet">
                Manual Merge
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function SectionTitle({ title, count }: { title: string; count?: number }): JSX.Element {
  return (
    <h3 className="ledger-section-title">
      <span>{title}</span>
      {count !== undefined && <em>{count}</em>}
    </h3>
  );
}

function MarkdownBlock({ source, className, empty }: { source: string; className: string; empty: string }): JSX.Element {
  const html = useMemo(() => {
    if (!source) return '';
    const parsed = marked.parse(source, { async: false });
    return sanitizeMarkdown(typeof parsed === 'string' ? parsed : '');
  }, [source]);
  if (!html) {
    return <div className={`${className} spec-panel--empty`}>{empty}</div>;
  }
  return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}

function inlineMarkdown(source: string): string {
  const parsed = marked.parse(source || '', { async: false });
  const html = typeof parsed === 'string' ? parsed : '';
  return sanitizeHtml(html.replace(/^<p>([\s\S]*?)<\/p>\n?$/, '$1').trim());
}

function formatRelativeTime(value?: number | string | null): string {
  if (!value) return '';
  const parsed = typeof value === 'number' ? value : Date.parse(value);
  if (Number.isNaN(parsed)) return String(value);
  const delta = Date.now() - parsed;
  if (delta < 0) return 'just now';
  const seconds = Math.floor(delta / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 1) return `${days}d ago`;
  if (days === 1) return 'yesterday';
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return `${seconds}s ago`;
}

function displayLabel(label: string): string {
  if (label === 'error') return 'bug';
  return label;
}

function syncLabel(state: string): string {
  if (state === 'clean') return 'synced';
  if (state === 'pending') return 'pending sync';
  if (state === 'conflicted') return 'conflict';
  return 'sync failed';
}

function safeJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
