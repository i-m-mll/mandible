import { useEffect, useRef, useState } from 'preact/hooks';
import { artifactLinkBadgeLabel, formatAbsoluteTime, formatRelativeTime } from '../../lib/format';
import { renderInlineMarkdown } from '../../lib/markdown';
import {
  artifactDetailHref,
  compactArtifactBlobRef,
  compactArtifactRef,
  displayResourceRef,
  seriesDetailHref,
  versionDetailHref,
} from '../../resource-refs';
import type {
  LedgerIssueDetailAssociatedArtifact,
  LedgerIssueDetailArtifactLink,
  LedgerIssueDetailAuthRequest,
  LedgerIssueDetailConflict,
  LedgerIssueDetailProjection,
  LedgerIssueDetailRelationship,
  LedgerIssueDetailSession,
  LedgerIssueDetailWorkUnit,
  LedgerIssueTimelineEntry,
} from '../../api';
import { LedgerRenderedBody } from './LedgerRenderedBody';
import { DetailPaneModal } from '../shared/DetailPaneModal';
import { AttributionIdentity, DetailHeaderIdentity } from '../shared/DetailHeaderIdentity';
import { DetailPaneShell } from '../shared/DetailPaneShell';

const LEDGER_TIME_OPTIONS = { zeroIsEmpty: true } as const;

type EntityType = 'issue' | 'session' | 'auth_request' | 'conversation';
type IssueMetadataRow = [label: string, value: string, copyable?: boolean, copyValue?: string];
type IssueMetadataSection = {
  title: string;
  rows: IssueMetadataRow[];
};
const ISSUE_METADATA_SCROLL_OWNER_SELECTORS = [
  '.issues-detail',
  '.graph-detail-pane',
  '.space-canvas__inspector',
  '.spaces-block-editor__inspector',
  '.ledger-issue-detail',
];
type RenderTimelineEntry =
  | LedgerIssueTimelineEntry
  | {
      id: string;
      kind: 'auth';
      auth: LedgerIssueDetailAuthRequest;
      created_at: number;
    };

export type LedgerIssueDetailProps = {
  detail: LedgerIssueDetailProjection;
  compact?: boolean;
  hydrating?: boolean;
  fullLoadFailed?: boolean;
  actionInFlight?: boolean;
  onAddComment?: (body: string) => Promise<void> | void;
  onSetStatus?: (status: 'open' | 'closed') => Promise<void> | void;
  onStartAgent?: () => Promise<void> | void;
  onOpenEntity?: (type: EntityType, id: string, repoId?: string) => void;
  onShowChildren?: (issue: LedgerIssueDetailProjection) => void;
  onResolveConflict?: (conflictId: string, resolution: string, status?: 'resolved' | 'dismissed') => Promise<void> | void;
  // Add-to-Space affordance (umbrella de56ffa, child 08c312a). When provided,
  // the issue-actions menu surfaces an "Add to Space" item even on otherwise
  // read-only panes — hence it is part of the `hasIssueActions` gate below, not
  // just a menu addition. The host wires the actual Space picker (it owns the
  // project scope + ref); IssueDetail only renders the entry point so the
  // graph/issue surfaces stay pickers rather than Space editors.
  onAddToSpace?: () => void;
};

export function LedgerIssueDetail({
  detail,
  compact = false,
  hydrating = false,
  fullLoadFailed = false,
  actionInFlight = false,
  onAddComment,
  onSetStatus,
  onStartAgent,
  onOpenEntity,
  onShowChildren,
  onResolveConflict,
  onAddToSpace,
}: LedgerIssueDetailProps): JSX.Element {
  const [commentText, setCommentText] = useState('');
  const [showComposer, setShowComposer] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [metadataOpen, setMetadataOpen] = useState(false);
  const [authEvidenceOpen, setAuthEvidenceOpen] = useState(false);
  const [localBusy, setLocalBusy] = useState(false);
  const actionMenuRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);
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
  const associatedArtifacts = detail.associated_artifacts ?? [];
  const displayLabels = detail.labels.filter((label) => !isMetadataLabel(label));
  const timelineEntries = buildTimelineEntries(timeline, detail.auth_requests);
  const isInitialDetail = detail.detail_stage === 'initial';
  const shouldShowFullDetailLoading = (
    fullLoadFailed ||
    (isInitialDetail && detail.timeline_partial === true)
  );
  const hasIssueMetadata = Boolean(
    detail.source !== 'mandible' ||
    detail.author.type !== 'mandible_user' ||
    detail.kind !== 'feature' ||
    detail.priority !== 'unknown' ||
    detail.aliases.length > 0 ||
    detail.checkpoints.length > 0,
  );
  const hasIssueActions = Boolean(
    hasIssueMetadata ||
    onAddComment ||
    onSetStatus ||
    onStartAgent ||
    onShowChildren ||
    onResolveConflict ||
    onAddToSpace,
  );
  const syncTone = detail.sync.state === 'clean'
    ? 'clean'
    : detail.sync.state === 'pending'
      ? 'pending'
      : detail.sync.state === 'conflicted'
        ? 'conflicted'
        : 'failed';
  const projectRef = issueProjectRef(detail);

  useEffect(() => {
    if (!actionsOpen) return undefined;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const node = actionMenuRef.current;
      if (!node || node.contains(event.target as Node)) return;
      setActionsOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setActionsOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer, true);
    document.addEventListener('keydown', closeOnEscape, true);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer, true);
      document.removeEventListener('keydown', closeOnEscape, true);
    };
  }, [actionsOpen]);

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

  const overlays = (
    <>
      <DetailPaneModal
        open={metadataOpen}
        onClose={() => setMetadataOpen(false)}
        titleId="issue-metadata-title"
        title="Issue metadata"
        closeLabel="Close issue metadata"
        excludeAboveRef={headerRef}
        scrollOwnerSelector={ISSUE_METADATA_SCROLL_OWNER_SELECTORS}
        scrollLockClassName="issues-detail--metadata-open"
        className="ledger-issue-detail__metadata-modal"
        panelClassName="ledger-issue-detail__metadata-panel"
      >
        <IssueMetadataContent detail={detail} />
      </DetailPaneModal>
      {authEvidenceOpen && (
        <AuthEvidenceModal
          authRequests={detail.auth_requests}
          onOpenEntity={onOpenEntity}
          onClose={() => setAuthEvidenceOpen(false)}
        />
      )}
    </>
  );

  return (
    <DetailPaneShell
      className={`ledger-issue-detail${compact ? ' ledger-issue-detail--compact' : ''}`}
      headerClassName="ledger-issue-detail__header"
      headerPrimaryClassName="ledger-issue-detail__header-primary"
      bodyClassName="ledger-issue-detail__body"
      headerRef={headerRef}
      header={(
        <>
        <div className="ledger-issue-detail__heading">
          <DetailHeaderIdentity
            className="ledger-issue-detail__eyebrow"
            contextLabel={detail.project.repo_name ?? detail.project.display_name}
            shortId={detail.display_id}
            copyValue={`${projectRef}/${detail.display_id}`}
          >
            <StatusPill
              status={detail.status}
              resolution={detail.resolution}
              linkedAuth={resolvingAuth}
              onOpenAuth={onOpenEntity ? (auth) => onOpenEntity('auth_request', auth.id) : undefined}
            />
          </DetailHeaderIdentity>
          <div className="ledger-issue-detail__title-row">
            <h2 dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(detail.title) }} />
            {hasIssueActions && (
              <IssueActionsMenu
                menuRef={actionMenuRef}
                open={actionsOpen}
                busy={busy}
                detail={detail}
                liveSession={liveSession}
                primaryWorkUnit={primaryWorkUnit}
                onToggle={() => setActionsOpen((prev) => !prev)}
                onClose={() => setActionsOpen(false)}
                onStartAgent={isInitialDetail ? undefined : onStartAgent}
                onSetStatus={onSetStatus}
                onAddComment={onAddComment ? () => setShowComposer(true) : undefined}
                onAddToSpace={onAddToSpace}
                onShowMetadata={hasIssueMetadata ? () => setMetadataOpen(true) : undefined}
                onShowAuthEvidence={detail.auth_requests.length > 0 ? () => setAuthEvidenceOpen(true) : undefined}
                onShowChildren={detail.labels.includes('umbrella') ? onShowChildren : undefined}
              />
            )}
          </div>
          <div className="ledger-issue-detail__meta">
            <AttributionIdentity
              className="ledger-issue-detail__byline-author"
              display={detail.author.display}
              attribution={detail.author.attribution}
              source={detail.source}
            />
            <time>{formatRelativeTime(detail.created_at, LEDGER_TIME_OPTIONS)}</time>
            {displayLabels.length > 0 && (
              <>
                <span className="ledger-issue-detail__meta-separator" aria-hidden="true" />
                <span className="ledger-issue-detail__label-row">
                  {displayLabels.map((label) => (
                    <span key={label} className="ledger-label">{displayLabel(label)}</span>
                  ))}
                </span>
              </>
            )}
          </div>
        </div>
        {detail.sync.state !== 'clean' && (
          <div className="ledger-issue-detail__header-actions">
            <span className={`ledger-sync-pill ledger-sync-pill--${syncTone}`}>{syncLabel(detail.sync.state)}</span>
          </div>
        )}
        </>
      )}
      overlays={overlays}
      ariaBusy={hydrating}
    >
        <section className="ledger-issue-detail__section">
          <div className="ledger-comment-list ledger-timeline-list">
            {timelineEntries.map((entry) => (
              <TimelineEntryCard key={entry.id} entry={entry} detail={detail} onOpenEntity={onOpenEntity} />
            ))}
          </div>
          {shouldShowFullDetailLoading && (
            <p className="text-muted">
              {fullLoadFailed
                ? 'Full issue detail failed to load.'
                : detail.timeline_partial
                  ? 'Loading full issue detail; more timeline entries may appear.'
                  : 'Loading full issue detail...'}
            </p>
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

        {associatedArtifacts.length > 0 && (
          <section className="ledger-issue-detail__section">
            <SectionTitle title="Associated Artifacts" count={associatedArtifacts.length} />
            <AssociatedArtifactList artifacts={associatedArtifacts} />
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
    </DetailPaneShell>
  );
}

function issueProjectRef(detail: LedgerIssueDetailProjection): string {
  return (
    detail.project.project_key?.trim() ||
    detail.project.repo_id?.trim() ||
    detail.project.repo_name?.trim() ||
    detail.project.display_name?.trim() ||
    detail.project.id
  );
}

function AssociatedArtifactList({
  artifacts,
}: {
  artifacts: LedgerIssueDetailAssociatedArtifact[];
}): JSX.Element {
  return (
    <div className="ledger-evidence-list">
      {artifacts.flatMap((artifact) => {
        const links = artifact.links.length > 0 ? artifact.links : [null];
        return links.map((link) => (
          <a
            key={`${artifact.id}:${link?.id ?? 'artifact'}`}
            className="ledger-evidence-row"
            href={artifactLinkHref(artifact, link)}
            title={artifact.uri}
          >
            <span>{artifactSourceLabel(artifact)}</span>
            <strong>{artifactTitle(artifact)}</strong>
            <span className="ledger-evidence-row__meta">
              {link && <ArtifactLinkBadge link={link} />}
              <code>{artifactMetaLabel(artifact)}</code>
            </span>
          </a>
        ));
      })}
    </div>
  );
}

function ArtifactLinkBadge({ link }: { link: LedgerIssueDetailArtifactLink }): JSX.Element {
  const kind = link.link_kind === 'living' ? 'living' : 'pinned';
  return (
    <span className={`type-badge type-badge--sm artifact-link-badge artifact-link-badge--${kind}`}>
      {artifactLinkBadgeLabel(link)}
    </span>
  );
}

function artifactLinkHref(
  artifact: LedgerIssueDetailAssociatedArtifact,
  link: LedgerIssueDetailArtifactLink | null,
): string {
  if (!link) return artifactDetailHref(artifact.id);

  const seriesRef = link.series_ref
    ? logicalArtifactRefFromSeriesId(link.series_ref)
    : link.series_id
      ? logicalArtifactRefFromSeriesId(link.series_id)
      : null;
  if (link.link_kind === 'living') {
    return seriesRef ? seriesDetailHref(seriesRef) : artifactDetailHref(artifact.id);
  }

  return seriesRef && typeof link.resolved_version_no === 'number'
    ? versionDetailHref(seriesRef, link.resolved_version_no)
    : artifactDetailHref(artifact.id);
}

function logicalArtifactRefFromSeriesId(ref: string): string {
  const trimmed = ref.trim();
  if (/^artifact-series:/i.test(trimmed)) return trimmed;
  return `artifact-series:${trimmed.replace(/^artifact:/i, '')}`;
}

function artifactSourceLabel(artifact: LedgerIssueDetailAssociatedArtifact): string {
  if (artifact.links.length > 0 && artifact.refs.length > 0) return 'linked + referenced';
  if (artifact.links.length > 0) return artifact.links[0].link_type.replace(/_/g, ' ');
  return 'referenced';
}

function artifactTitle(artifact: LedgerIssueDetailAssociatedArtifact): string {
  const ref = artifact.refs[0];
  if (ref) return displayResourceRef(ref);
  return artifactFileLabel(artifact.uri)
    || displayResourceRef(artifact.uri)
    || compactArtifactBlobRef(`artifact-blob:${artifact.content_hash}`);
}

function artifactMetaLabel(artifact: LedgerIssueDetailAssociatedArtifact): string {
  const parts = [
    artifact.role,
    artifact.media_type,
    artifact.provider_id,
    artifact.availability === 'unchecked' ? null : artifact.availability,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : artifact.id;
}

function artifactFileLabel(uri: string): string {
  if (!uri.startsWith('file://')) return '';
  const pathname = uri.slice('file://'.length);
  const basename = pathname.split(/[\\/]/).filter(Boolean).at(-1) ?? '';
  return basename && !/^[0-9a-f]{64}$/i.test(basename) ? basename : '';
}

function IssueActionsMenu({
  menuRef,
  open,
  busy,
  detail,
  liveSession,
  primaryWorkUnit,
  onToggle,
  onClose,
  onStartAgent,
  onSetStatus,
  onAddComment,
  onAddToSpace,
  onShowMetadata,
  onShowAuthEvidence,
  onShowChildren,
}: {
  menuRef: { current: HTMLDivElement | null };
  open: boolean;
  busy: boolean;
  detail: LedgerIssueDetailProjection;
  liveSession: LedgerIssueDetailSession | null;
  primaryWorkUnit: LedgerIssueDetailWorkUnit | null;
  onToggle: () => void;
  onClose: () => void;
  onStartAgent?: () => Promise<void> | void;
  onSetStatus?: (status: 'open' | 'closed') => Promise<void> | void;
  onAddComment?: () => void;
  onAddToSpace?: () => void;
  onShowMetadata?: () => void;
  onShowAuthEvidence?: () => void;
  onShowChildren?: (issue: LedgerIssueDetailProjection) => void;
}): JSX.Element {
  const closeAfter = (callback: () => void) => {
    callback();
    onClose();
  };
  return (
    <div className="ledger-issue-actions-menu" ref={menuRef}>
      <button
        type="button"
        className={`ledger-issue-actions-menu__trigger${open ? ' ledger-issue-actions-menu__trigger--active' : ''}`}
        aria-label="Issue actions"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Issue actions"
        onClick={onToggle}
      >
        <HorizontalDotsIcon />
      </button>
      {open && (
        <div className="ledger-issue-actions-menu__dropdown" role="menu">
          {liveSession && (
            <a
              className="ledger-issue-actions-menu__item"
              role="menuitem"
              href={`#/console?session=${encodeURIComponent(liveSession.id)}`}
              onClick={onClose}
            >
              Open Console
            </a>
          )}
          {!liveSession && onStartAgent && (
            <button
              type="button"
              className="ledger-issue-actions-menu__item"
              role="menuitem"
              disabled={busy}
              onClick={() => closeAfter(() => void onStartAgent())}
            >
              {primaryWorkUnit?.continuation ? 'Resume Work' : 'Start Agent'}
            </button>
          )}
          {onAddComment && (
            <button
              type="button"
              className="ledger-issue-actions-menu__item"
              role="menuitem"
              disabled={busy}
              onClick={() => closeAfter(onAddComment)}
            >
              Add Comment
            </button>
          )}
          {/* Add-to-Space region (child 08c312a) — disjoint from and after C6's
              linkify call-site region (which lives in LedgerRenderedBody). */}
          {onAddToSpace && (
            <button
              type="button"
              className="ledger-issue-actions-menu__item"
              role="menuitem"
              disabled={busy}
              onClick={() => closeAfter(onAddToSpace)}
            >
              Add to Space
            </button>
          )}
          {onShowMetadata && (
            <button
              type="button"
              className="ledger-issue-actions-menu__item"
              role="menuitem"
              onClick={() => closeAfter(onShowMetadata)}
            >
              Show metadata
            </button>
          )}
          {onShowChildren && (
            <button
              type="button"
              className="ledger-issue-actions-menu__item"
              role="menuitem"
              disabled={busy}
              onClick={() => closeAfter(() => onShowChildren(detail))}
            >
              Show Children
            </button>
          )}
          {onShowAuthEvidence && (
            <button
              type="button"
              className="ledger-issue-actions-menu__item"
              role="menuitem"
              disabled={busy}
              onClick={() => closeAfter(onShowAuthEvidence)}
            >
              Auth Evidence
            </button>
          )}
          {onSetStatus && (
            <button
              type="button"
              className={`ledger-issue-actions-menu__item${detail.status === 'open' ? ' ledger-issue-actions-menu__item--danger' : ''}`}
              role="menuitem"
              disabled={busy}
              onClick={() => closeAfter(() => void onSetStatus(detail.status === 'open' ? 'closed' : 'open'))}
            >
              {detail.status === 'open' ? 'Close Issue' : 'Reopen Issue'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

async function copyText(value: string): Promise<void> {
  if (copyTextWithSelection(value)) return;

  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  throw new Error('copy failed');
}

function copyTextWithSelection(value: string): boolean {
  if (!document.queryCommandSupported?.('copy')) return false;

  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.top = '0';
  document.body.appendChild(textarea);
  textarea.focus({ preventScroll: true });
  textarea.select();
  textarea.setSelectionRange(0, value.length);
  const copied = document.execCommand('copy');
  document.body.removeChild(textarea);
  return copied;
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
    ...(detail.checkpoints ?? []).map((checkpoint) => ({
      id: checkpoint.id,
      kind: 'checkpoint' as const,
      checkpoint_id: checkpoint.id,
      checkpoint_kind: checkpoint.kind,
      payload: checkpoint.payload,
      author: checkpoint.author,
      source: checkpoint.source,
      created_at: checkpoint.created_at,
    })),
  ];
}

function buildTimelineEntries(
  timeline: LedgerIssueTimelineEntry[],
  authRequests: LedgerIssueDetailAuthRequest[],
): RenderTimelineEntry[] {
  const authEntries = authRequests
    .filter((auth) => auth.status === 'completed')
    .map((auth) => ({
      id: `auth:${auth.id}:${auth.link_type}`,
      kind: 'auth' as const,
      auth,
      created_at: auth.resolved_at ?? auth.approved_at ?? auth.link_created_at ?? auth.created_at ?? 0,
    }))
    .filter((entry) => entry.created_at > 0);
  return [...timeline, ...authEntries].sort((a, b) => {
    const timeDelta = a.created_at - b.created_at;
    if (timeDelta !== 0) return timeDelta;
    return timelineRank(a) - timelineRank(b);
  });
}

function timelineRank(entry: RenderTimelineEntry): number {
  if (entry.kind === 'body') return 0;
  if (entry.kind === 'comment') return 1;
  if (entry.kind === 'auth') return 2;
  if (entry.kind === 'checkpoint') return 3;
  return 4;
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
  onOpenEntity,
}: {
  entry: RenderTimelineEntry;
  detail: LedgerIssueDetailProjection;
  onOpenEntity?: LedgerIssueDetailProps['onOpenEntity'];
}): JSX.Element {
  if (entry.kind === 'auth') {
    return (
      <button
        type="button"
        className="ledger-timeline-event ledger-timeline-event--auth"
        disabled={!onOpenEntity}
        onClick={() => onOpenEntity?.('auth_request', entry.auth.id)}
      >
        <span className="ledger-timeline-event__dot" aria-hidden="true" />
        <span className="ledger-timeline-event__text">
          <strong>{authEvidenceLinkLabel(entry.auth)}</strong>
          <span>{entry.auth.title || entry.auth.id}</span>
        </span>
        <time>{formatRelativeTime(entry.created_at, LEDGER_TIME_OPTIONS)}</time>
      </button>
    );
  }
  if (entry.kind === 'state') {
    return (
      <div className="ledger-timeline-event ledger-timeline-event--state">
        <span className="ledger-timeline-event__dot" aria-hidden="true" />
        <span className="ledger-timeline-event__text">
          <strong>{stateEntryLabel(entry)}</strong>
          <AttributionIdentity
            display={entry.author.display}
            attribution={entry.author.attribution}
            source={entry.source}
          />
        </span>
        <time>{formatRelativeTime(entry.created_at, LEDGER_TIME_OPTIONS)}</time>
        <MetadataDisclosure label="Timeline metadata">
          <MetadataRows rows={stateMetadataRows(entry)} />
        </MetadataDisclosure>
      </div>
    );
  }
  if (entry.kind === 'checkpoint') {
    return (
      <div className="ledger-timeline-event ledger-timeline-event--state">
        <span className="ledger-timeline-event__dot" aria-hidden="true" />
        <span className="ledger-timeline-event__text">
          <strong>{checkpointEntryLabel(entry.checkpoint_kind)}</strong>
          <AttributionIdentity
            display={entry.author.display}
            attribution={entry.author.attribution}
            source={entry.source}
          />
        </span>
        <time>{formatRelativeTime(entry.created_at, LEDGER_TIME_OPTIONS)}</time>
        <MetadataDisclosure label="Checkpoint payload">
          <MetadataRows rows={checkpointMetadataRows(entry)} />
        </MetadataDisclosure>
      </div>
    );
  }
  if (entry.kind === 'event') {
    return (
      <div className="ledger-timeline-event ledger-timeline-event--state">
        <span className="ledger-timeline-event__dot" aria-hidden="true" />
        <span className="ledger-timeline-event__text">
          <strong>{timelineEventLabel(entry)}</strong>
          <AttributionIdentity
            display={entry.author.display}
            attribution={entry.author.attribution}
            source={entry.source}
          />
        </span>
        <time>{formatRelativeTime(entry.created_at, LEDGER_TIME_OPTIONS)}</time>
        <MetadataDisclosure label="Timeline metadata">
          <MetadataRows rows={eventMetadataRows(entry)} />
        </MetadataDisclosure>
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
        <AttributionIdentity
          display={entry.author.display}
          attribution={entry.author.attribution}
          source={entry.source}
        />
        <time>{formatRelativeTime(entry.created_at, LEDGER_TIME_OPTIONS)}</time>
        <MetadataDisclosure label={isBody ? 'Opening metadata' : 'Comment metadata'}>
          <MetadataRows rows={isBody ? bodyMetadataRows(entry) : commentMetadataRows(entry)} />
        </MetadataDisclosure>
      </div>
      <LedgerRenderedBody className="ledger-comment-card__body spec-panel" source={entry.body} empty={isBody ? 'No description.' : ''} detail={detail} />
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
  const [panelOffset, setPanelOffset] = useState(0);
  const ref = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const positionPanel = () => {
      const panel = ref.current?.querySelector<HTMLElement>('.ledger-metadata-popover__panel');
      const summary = ref.current?.querySelector<HTMLElement>('summary');
      if (!panel || !summary || !ref.current) return;
      setPanelOffset(0);
      requestAnimationFrame(() => {
        const popoverBounds = ref.current?.getBoundingClientRect();
        const detailBounds = ref.current?.closest('.ledger-issue-detail')?.getBoundingClientRect();
        if (!popoverBounds) return;
        const inset = 8;
        const panelWidth = panel.offsetWidth;
        const minLeft = Math.max(inset, (detailBounds?.left ?? 0) + inset);
        const maxLeft = Math.min(window.innerWidth - inset, detailBounds?.right ?? window.innerWidth) - panelWidth;
        const summaryBounds = summary.getBoundingClientRect();
        const preferredLeft = summaryBounds.left + (summaryBounds.width / 2) - (panelWidth / 2);
        const clampedLeft = Math.min(Math.max(preferredLeft, minLeft), Math.max(minLeft, maxLeft));
        setPanelOffset(Math.round(clampedLeft - popoverBounds.left));
      });
    };
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
    window.addEventListener('resize', positionPanel);
    positionPanel();
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer, true);
      document.removeEventListener('keydown', closeOnEscape, true);
      window.removeEventListener('resize', positionPanel);
    };
  }, [open]);

  return (
    <details
      ref={ref}
      className="ledger-metadata-popover"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary aria-label={label} title={label}>
        <MetadataIcon />
      </summary>
      <div className="ledger-metadata-popover__panel" style={{ left: `${panelOffset}px` }}>{children}</div>
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

function IssueMetadataContent({ detail }: { detail: LedgerIssueDetailProjection }): JSX.Element {
  const sections = issueMetadataSections(detail);
  return (
    <>
      {sections.map((section) => (
        <section key={section.title} className="artifact-detail__section ledger-issue-detail__metadata-section">
          <h3>{section.title}</h3>
          <IssueMetadataKeyValue rows={section.rows} />
        </section>
      ))}
    </>
  );
}

function IssueMetadataKeyValue({ rows }: { rows: IssueMetadataRow[] }): JSX.Element {
  return (
    <div className="artifact-detail__kv ledger-issue-detail__metadata-kv">
      {rows.filter(([, value]) => value).map(([key, value, copyable, copyValue]) => (
        <div key={key}>
          <span>{key}</span>
          {copyable ? (
            <button
              type="button"
              className="artifact-detail__copy-value"
              onClick={() => void copyText(copyValue ?? value)}
              title={`Copy ${key}`}
            >
              <code>{value}</code>
            </button>
          ) : (
            <code>{value}</code>
          )}
        </div>
      ))}
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
          <span>{authEvidenceLinkLabel(auth)}</span>
          <strong>{auth.title || auth.id}</strong>
          <code>{auth.status}{auth.head_branch ? ` · ${auth.head_branch}` : ''}</code>
        </button>
      ))}
    </div>
  );
}

function AuthEvidenceModal({
  authRequests,
  onOpenEntity,
  onClose,
}: {
  authRequests: LedgerIssueDetailAuthRequest[];
  onOpenEntity?: LedgerIssueDetailProps['onOpenEntity'];
  onClose: () => void;
}): JSX.Element {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', closeOnEscape, true);
    return () => document.removeEventListener('keydown', closeOnEscape, true);
  }, [onClose]);

  return (
    <div className="ledger-issue-modal" role="presentation" onClick={onClose}>
      <div
        className="ledger-issue-modal__panel"
        role="dialog"
        aria-modal="true"
        aria-label="Auth evidence"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="ledger-issue-modal__header">
          <h3>Auth Evidence</h3>
          <button type="button" className="ledger-icon-button" aria-label="Close auth evidence" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <AuthEvidenceShelf
          authRequests={authRequests}
          onOpenEntity={onOpenEntity ? (type, id, repoId) => {
            onClose();
            onOpenEntity(type, id, repoId);
          } : undefined}
        />
      </div>
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
      {session.owner && (
        <span className="ledger-session-row__owner">
          {session.owner.display_name}
          <small>{session.owner.kind}</small>
        </span>
      )}
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

function issueMetadataRows(detail: LedgerIssueDetailProjection): Array<[string, string]> {
  const rows: Array<[string, string]> = [
    ['Reference', detail.display_id],
    ['Kind', detail.kind],
    ['Priority', detail.priority],
    ['Source', detail.source || 'unknown'],
    ['Project', detail.project.repo_name ?? detail.project.display_name],
    ['Created', formatAbsoluteTime(detail.created_at, LEDGER_TIME_OPTIONS)],
    ['Updated', formatAbsoluteTime(detail.updated_at, LEDGER_TIME_OPTIONS)],
  ];
  if (detail.id !== detail.display_id) rows.push(['Canonical ID', detail.id]);
  if (detail.closed_at) {
    rows.push(['Closed', formatAbsoluteTime(detail.closed_at, LEDGER_TIME_OPTIONS)]);
  }
  const alternateAliases = detail.aliases
    .map((alias) => alias.alias || alias.external_id)
    .filter((alias) => alias && alias !== detail.id && alias !== detail.display_id);
  if (alternateAliases.length > 0) rows.push(['Alternate refs', alternateAliases.join(', ')]);
  if (detail.sync.state !== 'clean') rows.push(['Sync', syncLabel(detail.sync.state)]);
  return rows.filter(([, value]) => Boolean(value));
}

function issueMetadataSections(detail: LedgerIssueDetailProjection): IssueMetadataSection[] {
  const sourceRows = issueMetadataRows(detail);
  const copyable = new Set(['Reference', 'Canonical ID', 'Alternate refs']);
  const rowsByKey = new Map(sourceRows.map(([key, value]) => [
    key,
    [key, value, copyable.has(key), copyValueForIssueMetadata(key, value)] as IssueMetadataRow,
  ]));
  const pullRows = (keys: string[]) => keys
    .map((key) => rowsByKey.get(key))
    .filter((row): row is IssueMetadataRow => Boolean(row));
  const sections: IssueMetadataSection[] = [
    { title: 'Identity', rows: pullRows(['Reference', 'Canonical ID', 'Alternate refs', 'Project']) },
    { title: 'Status', rows: pullRows(['Kind', 'Priority', 'Sync']) },
    { title: 'Provenance', rows: pullRows(['Source', 'Created', 'Updated', 'Closed']) },
  ];
  return sections.filter((section) => section.rows.length > 0);
}

function copyValueForIssueMetadata(key: string, value: string): string {
  if (key !== 'Alternate refs') return value;
  return value.split(',')[0]?.trim() || value;
}

function bodyMetadataRows(entry: Extract<LedgerIssueTimelineEntry, { kind: 'body' }>): Array<[string, string]> {
  return [
    ['Entry', '#0'],
    ['Author type', entry.author.type.replace(/_/g, ' ')],
    ['Source', entry.source || 'unknown'],
    ['Created', formatAbsoluteTime(entry.created_at, LEDGER_TIME_OPTIONS)],
    ['Updated', formatAbsoluteTime(entry.updated_at, LEDGER_TIME_OPTIONS)],
  ].filter(([, value]) => Boolean(value));
}

function commentMetadataRows(comment: Extract<LedgerIssueTimelineEntry, { kind: 'comment' }>): Array<[string, string]> {
  const rows: Array<[string, string]> = [
    ['Comment', `#${comment.ordinal}`],
    ['Comment ID', comment.comment_id],
    ['Author type', comment.author.type.replace(/_/g, ' ')],
    ['Source', comment.source || 'unknown'],
    ['Created', formatAbsoluteTime(comment.created_at, LEDGER_TIME_OPTIONS)],
  ];
  if (comment.updated_at) {
    rows.push(['Updated', formatAbsoluteTime(comment.updated_at, LEDGER_TIME_OPTIONS)]);
  }
  if (comment.author.id) rows.push(['Author ID', comment.author.id]);
  return rows;
}

function stateMetadataRows(entry: Extract<LedgerIssueTimelineEntry, { kind: 'state' }>): Array<[string, string]> {
  return [
    ['Event ID', entry.id],
    ['Event type', entry.event_type],
    ['Source', entry.source || 'unknown'],
    ['Created', formatAbsoluteTime(entry.created_at, LEDGER_TIME_OPTIONS)],
  ].filter(([, value]) => Boolean(value));
}

function eventMetadataRows(entry: Extract<LedgerIssueTimelineEntry, { kind: 'event' }>): Array<[string, string]> {
  const rows: Array<[string, string]> = [
    ['Event ID', entry.id],
    ['Event type', entry.event_type],
    ['Author type', entry.author.type.replace(/_/g, ' ')],
    ['Source', entry.source || 'unknown'],
    ['Created', formatAbsoluteTime(entry.created_at, LEDGER_TIME_OPTIONS)],
    ['Payload', formatJsonValue(entry.payload)],
  ];
  if (entry.author.id) rows.push(['Author ID', entry.author.id]);
  return rows.filter(([, value]) => Boolean(value));
}

function checkpointMetadataRows(entry: Extract<LedgerIssueTimelineEntry, { kind: 'checkpoint' }>): Array<[string, string]> {
  const rows: Array<[string, string]> = [
    ['Checkpoint ID', entry.checkpoint_id],
    ['Kind', entry.checkpoint_kind],
    ['Author type', entry.author.type.replace(/_/g, ' ')],
    ['Source', entry.source || 'unknown'],
    ['Created', formatAbsoluteTime(entry.created_at, LEDGER_TIME_OPTIONS)],
    ['Payload', formatJsonValue(entry.payload)],
  ];
  if (entry.author.id) rows.push(['Author ID', entry.author.id]);
  return rows.filter(([, value]) => Boolean(value));
}

function stateEntryLabel(entry: Extract<LedgerIssueTimelineEntry, { kind: 'state' }>): string {
  if (entry.status === 'closed') return entry.resolution ? `Closed: ${entry.resolution}` : 'Closed';
  if (entry.status === 'open') return 'Reopened';
  return 'State updated';
}

function timelineEventLabel(entry: Extract<LedgerIssueTimelineEntry, { kind: 'event' }>): string {
  if (entry.event_type === 'relationship.added') return 'Relationship added';
  if (entry.event_type === 'relationship.removed') return 'Relationship removed';
  return entry.event_type;
}

function checkpointEntryLabel(kind: string): string {
  return `Checkpoint: ${kind}`;
}

function formatJsonValue(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function displayLabel(label: string): string {
  if (label === 'error') return 'bug';
  return label;
}

function isMetadataLabel(label: string): boolean {
  return label === 'merged';
}

function authEvidenceLinkLabel(auth: LedgerIssueDetailAuthRequest): string {
  if (auth.link_type === 'resolves' || auth.link_type === 'fixed_by') return 'resolved by';
  if (auth.link_type === 'references') return 'referenced by';
  return `${auth.link_type.replace(/_/g, ' ')} by`;
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

function MetadataIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 17v-5" />
      <path d="M12 8h.01" />
    </svg>
  );
}

function HorizontalDotsIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="5" cy="12" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="19" cy="12" r="1.5" />
    </svg>
  );
}

function CloseIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m18 6-12 12" />
      <path d="m6 6 12 12" />
    </svg>
  );
}
