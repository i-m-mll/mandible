import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { marked } from 'marked';
import { sanitizeHtml, sanitizeMarkdown } from '../../sanitize';
import type {
  LedgerIssueDetailAuthRequest,
  LedgerIssueDetailConflict,
  LedgerIssueDetailProjection,
  LedgerIssueDetailRelationship,
  LedgerIssueDetailSession,
  LedgerIssueTimelineEntry,
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
  const timeline = detail.timeline ?? fallbackTimeline(detail);
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
          {detail.sync.state !== 'clean' && (
            <span className={`ledger-sync-pill ledger-sync-pill--${syncTone}`}>{syncLabel(detail.sync.state)}</span>
          )}
        </div>
      </header>

      <div className="ledger-issue-detail__meta">
        <span>{detail.author.display}</span>
        <span>{formatRelativeTime(detail.created_at)}</span>
        <MetadataDisclosure label="Issue metadata">
          <MetadataRows rows={issueMetadataRows(detail)} />
        </MetadataDisclosure>
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
        <SectionTitle title="Timeline" count={timeline.length} />
        <div className="ledger-comment-list ledger-timeline-list">
          {timeline.map((entry) => (
            <TimelineEntryCard key={entry.id} entry={entry} detail={detail} />
          ))}
        </div>
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

      {(detail.sync.state !== 'clean' || detail.conflicts.length > 0) && (
        <section className="ledger-issue-detail__section">
          <SectionTitle title="Sync" count={detail.conflicts.length || undefined} />
          <SyncStatus detail={detail} onResolveConflict={onResolveConflict} busy={busy} />
        </section>
      )}
    </article>
  );
}

function fallbackTimeline(detail: LedgerIssueDetailProjection): LedgerIssueTimelineEntry[] {
  return [
    {
      id: `${detail.id}:body`,
      kind: 'body',
      ordinal: 0,
      body: detail.body,
      author: detail.author,
      source: detail.source,
      created_at: detail.created_at,
      updated_at: detail.updated_at,
    },
    ...detail.comments.map((comment) => ({
      id: comment.id,
      kind: 'comment' as const,
      comment_id: comment.id,
      ordinal: comment.ordinal ?? 0,
      body: comment.body,
      author: comment.author,
      source: comment.source,
      created_at: comment.created_at,
      updated_at: comment.updated_at,
    })),
  ];
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

function TimelineEntryCard({
  entry,
  detail,
}: {
  entry: LedgerIssueTimelineEntry;
  detail: LedgerIssueDetailProjection;
}): JSX.Element {
  if (entry.kind === 'state') {
    return (
      <div className="ledger-comment-card ledger-timeline-card ledger-timeline-card--state">
        <div className="ledger-comment-card__header">
          <span>{stateEntryLabel(entry)}</span>
          <time>{formatRelativeTime(entry.created_at)}</time>
          <MetadataDisclosure label="Timeline metadata">
            <MetadataRows rows={stateMetadataRows(entry)} />
          </MetadataDisclosure>
        </div>
      </div>
    );
  }
  const isBody = entry.kind === 'body';
  return (
    <div
      className="ledger-comment-card ledger-timeline-card"
      id={entry.kind === 'comment' ? `comment-${entry.comment_id}` : 'comment-0'}
      data-comment-ordinal={String(entry.ordinal)}
    >
      <div className="ledger-comment-card__header">
        <span>{entry.author.display}</span>
        <time>{formatRelativeTime(entry.created_at)}</time>
        <MetadataDisclosure label={isBody ? 'Opening metadata' : 'Comment metadata'}>
          <MetadataRows rows={isBody ? bodyMetadataRows(entry) : commentMetadataRows(entry)} />
        </MetadataDisclosure>
      </div>
      <MarkdownBlock className="ledger-comment-card__body spec-panel" source={entry.body} empty={isBody ? 'No description.' : ''} detail={detail} />
    </div>
  );
}

function MetadataDisclosure({
  label,
  children,
}: {
  label: string;
  children: JSX.Element;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const node = ref.current;
      if (!node || node.contains(event.target as Node)) return;
      setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer, true);
    document.addEventListener('keydown', closeOnEscape, true);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer, true);
      document.removeEventListener('keydown', closeOnEscape, true);
    };
  }, [open]);

  return (
    <details
      ref={ref}
      className="ledger-metadata-popover"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary aria-label={label} title={label}>i</summary>
      <div className="ledger-metadata-popover__panel">{children}</div>
    </details>
  );
}

function MetadataRows({ rows }: { rows: Array<[string, string]> }): JSX.Element {
  return (
    <dl className="ledger-metadata-grid">
      {rows.map(([key, value]) => (
        <div key={key}>
          <dt>{key}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
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

function MarkdownBlock({
  source,
  className,
  empty,
  detail,
}: {
  source: string;
  className: string;
  empty: string;
  detail: LedgerIssueDetailProjection;
}): JSX.Element {
  const html = useMemo(() => {
    if (!source) return '';
    const parsed = marked.parse(source, { async: false });
    const sanitized = sanitizeMarkdown(typeof parsed === 'string' ? parsed : '');
    return linkifyLedgerRefs(sanitized, detail);
  }, [source, detail.id, detail.display_id, detail.project.repo_id]);
  if (!html) {
    return <div className={`${className} spec-panel--empty`}>{empty}</div>;
  }
  return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}

const REF_PATTERN = /\[#(\d+)\]|\[(issue|comment):([^\]\s]+)\]|(?<![\w/])#([0-9a-f]{7,64})\b|(?<![\w/])([0-9a-f]{7,64})\b|(?<![\w])iss_[A-Za-z0-9_]+/g;

function linkifyLedgerRefs(html: string, detail: LedgerIssueDetailProjection): string {
  if (typeof document === 'undefined' || !html) return html;
  const container = document.createElement('div');
  container.innerHTML = html;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest('a, code, pre')) return NodeFilter.FILTER_REJECT;
      REF_PATTERN.lastIndex = 0;
      return REF_PATTERN.test(node.nodeValue ?? '') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const nodes: Text[] = [];
  let node = walker.nextNode();
  while (node) {
    nodes.push(node as Text);
    node = walker.nextNode();
  }
  for (const textNode of nodes) {
    const fragment = document.createDocumentFragment();
    const text = textNode.nodeValue ?? '';
    REF_PATTERN.lastIndex = 0;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = REF_PATTERN.exec(text))) {
      if (match.index > lastIndex) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }
      const link = refLink(match, detail);
      fragment.appendChild(link ?? document.createTextNode(match[0]));
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
    }
    textNode.replaceWith(fragment);
  }
  return container.innerHTML;
}

function refLink(match: RegExpExecArray, detail: LedgerIssueDetailProjection): HTMLAnchorElement | null {
  const ordinalCommentRef = match[1];
  const explicitType = match[2];
  const explicitRef = match[3];
  const hashIssueRef = match[4];
  const bareIssueRef = match[5];
  const canonicalIssueRef = !ordinalCommentRef && !explicitType && !hashIssueRef && !bareIssueRef ? match[0] : '';
  if (ordinalCommentRef) {
    const anchor = document.createElement('a');
    anchor.className = 'ledger-xref';
    anchor.textContent = `#${ordinalCommentRef}`;
    anchor.href = issueHref(detail.project.repo_id ?? detail.project.display_name, detail.display_id, ordinalCommentRef);
    anchor.title = `Open comment #${ordinalCommentRef}`;
    return anchor;
  }
  const ref = explicitRef || hashIssueRef || bareIssueRef || canonicalIssueRef;
  if (!ref) return null;

  const anchor = document.createElement('a');
  anchor.className = 'ledger-xref';
  if (explicitType === 'comment') {
    const parsed = parseCommentRef(ref, detail);
    if (!parsed) return null;
    anchor.textContent = commentRefLabel(parsed, detail);
    anchor.href = issueHref(parsed.repo, parsed.issue, parsed.comment);
    anchor.title = `Open comment ${parsed.comment}`;
    return anchor;
  }

  const parsedIssue = parseIssueRef(ref, detail);
  if (!parsedIssue) return null;
  anchor.textContent = explicitType ? issueRefLabel(parsedIssue, detail) : (bareIssueRef || match[0]);
  anchor.href = issueHref(parsedIssue.repo, parsedIssue.issue);
  anchor.title = `Open issue ${parsedIssue.issue}`;
  return anchor;
}

function issueRefLabel(parsed: { repo: string; issue: string }, detail: LedgerIssueDetailProjection): string {
  const currentRepo = detail.project.repo_id ?? detail.project.display_name;
  return parsed.repo === currentRepo ? parsed.issue : `${parsed.repo}/${parsed.issue}`;
}

function commentRefLabel(parsed: { repo: string; issue: string; comment: string }, detail: LedgerIssueDetailProjection): string {
  const issueLabel = issueRefLabel(parsed, detail);
  return `${issueLabel}#${parsed.comment}`;
}

function issueMetadataRows(detail: LedgerIssueDetailProjection): Array<[string, string]> {
  const rows: Array<[string, string]> = [
    ['Reference', detail.display_id],
    ['Kind', detail.kind],
    ['Priority', detail.priority],
    ['Source', detail.source || 'unknown'],
    ['Project', detail.project.repo_name ?? detail.project.display_name],
    ['Created', formatAbsoluteTime(detail.created_at)],
    ['Updated', formatAbsoluteTime(detail.updated_at)],
  ];
  if (detail.id !== detail.display_id) rows.push(['Canonical ID', detail.id]);
  if (detail.closed_at) rows.push(['Closed', formatAbsoluteTime(detail.closed_at)]);
  const alternateAliases = detail.aliases
    .map((alias) => alias.alias || alias.external_id)
    .filter((alias) => alias && alias !== detail.id && alias !== detail.display_id);
  if (alternateAliases.length > 0) rows.push(['Alternate refs', alternateAliases.join(', ')]);
  if (detail.sync.state !== 'clean') rows.push(['Sync', syncLabel(detail.sync.state)]);
  return rows.filter(([, value]) => Boolean(value));
}

function bodyMetadataRows(entry: Extract<LedgerIssueTimelineEntry, { kind: 'body' }>): Array<[string, string]> {
  return [
    ['Entry', '#0'],
    ['Author type', entry.author.type.replace(/_/g, ' ')],
    ['Source', entry.source || 'unknown'],
    ['Created', formatAbsoluteTime(entry.created_at)],
    ['Updated', formatAbsoluteTime(entry.updated_at)],
  ].filter(([, value]) => Boolean(value));
}

function commentMetadataRows(comment: Extract<LedgerIssueTimelineEntry, { kind: 'comment' }>): Array<[string, string]> {
  const rows: Array<[string, string]> = [
    ['Comment', `#${comment.ordinal}`],
    ['Comment ID', comment.comment_id],
    ['Author type', comment.author.type.replace(/_/g, ' ')],
    ['Source', comment.source || 'unknown'],
    ['Created', formatAbsoluteTime(comment.created_at)],
  ];
  if (comment.updated_at) rows.push(['Updated', formatAbsoluteTime(comment.updated_at)]);
  if (comment.author.id) rows.push(['Author ID', comment.author.id]);
  return rows;
}

function stateMetadataRows(entry: Extract<LedgerIssueTimelineEntry, { kind: 'state' }>): Array<[string, string]> {
  return [
    ['Event ID', entry.id],
    ['Event type', entry.event_type],
    ['Source', entry.source || 'unknown'],
    ['Created', formatAbsoluteTime(entry.created_at)],
  ].filter(([, value]) => Boolean(value));
}

function stateEntryLabel(entry: Extract<LedgerIssueTimelineEntry, { kind: 'state' }>): string {
  if (entry.status === 'closed') return entry.resolution ? `Closed: ${entry.resolution}` : 'Closed';
  if (entry.status === 'open') return 'Reopened';
  return 'State updated';
}

function parseIssueRef(ref: string, detail: LedgerIssueDetailProjection): { repo: string; issue: string } | null {
  const scoped = ref.match(/^([^/#]+)\/([^/#]+)$/);
  if (scoped) return { repo: scoped[1], issue: scoped[2] };
  return { repo: detail.project.repo_id ?? detail.project.display_name, issue: ref.replace(/^#/, '') };
}

function parseCommentRef(ref: string, detail: LedgerIssueDetailProjection): { repo: string; issue: string; comment: string } | null {
  if (ref.startsWith('#')) {
    return { repo: detail.project.repo_id ?? detail.project.display_name, issue: detail.display_id, comment: ref.slice(1) };
  }
  const scoped = ref.match(/^([^/#]+)\/([^/#]+)#([^#]+)$/);
  if (scoped) return { repo: scoped[1], issue: scoped[2], comment: scoped[3] };
  const currentProject = ref.match(/^([^/#]+)#([^#]+)$/);
  if (currentProject) {
    return { repo: detail.project.repo_id ?? detail.project.display_name, issue: currentProject[1], comment: currentProject[2] };
  }
  return null;
}

function issueHref(repo: string, issue: string, comment?: string): string {
  const params = new URLSearchParams({ repo, issue });
  if (comment) params.set('comment', comment);
  return `#/issues?${params.toString()}`;
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

function formatAbsoluteTime(value?: number | string | null): string {
  if (!value) return '';
  const parsed = typeof value === 'number' ? value : Date.parse(value);
  if (Number.isNaN(parsed)) return String(value);
  return new Date(parsed).toLocaleString();
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
