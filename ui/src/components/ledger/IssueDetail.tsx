import { useEffect, useRef, useState } from 'preact/hooks';
import { artifactLinkBadgeLabel, formatAbsoluteTime, formatRelativeTime } from '../../lib/format';
import { renderInlineMarkdown } from '../../lib/markdown';
import { isApiErrorStatus } from '../../api';
import {
  artifactDetailHref,
  compactArtifactBlobRef,
  compactArtifactRef,
  displayResourceRef,
  resourceRefHref,
  seriesDetailHref,
  versionDetailHref,
} from '../../resource-refs';
import type {
  LedgerIssueDetailAssociatedArtifact,
  LedgerIssueDetailArtifactLink,
  LedgerIssueDetailAuthRequest,
  LedgerIssueDetailProjection,
  LedgerIssueDetailRelationship,
  LedgerIssueDetailSession,
  LedgerIssueDetailWorkUnit,
  LedgerIssueSummaryRef,
  LedgerIssueTimelineEntry,
} from '../../api';
import { AgentDispatchDialog } from '../agent-dispatch/AgentDispatchDialog';
import { LedgerRenderedBody } from './LedgerRenderedBody';
import { AttributionIdentity } from '../shared/DetailHeaderIdentity';
import { DetailPaneHeader } from '../shared/DetailPaneHeader';
import { DetailPaneMenuTrigger } from '../shared/DetailPaneMenuTrigger';
import { DetailPaneModal } from '../shared/DetailPaneModal';
import { DetailPaneShell, type DetailPanePresentation } from '../shared/DetailPaneShell';
import { CollapsiblePanel } from '../shared/CollapsiblePanel';
import { useAnchoredMenu } from '../../hooks/useAnchoredMenu';
import {
  LEDGER_ISSUE_RESOLUTIONS,
  type LedgerIssueResolution,
} from '../../types/issues';

const LEDGER_TIME_OPTIONS = { zeroIsEmpty: true } as const;

type EntityType = 'issue' | 'session' | 'auth_request' | 'conversation';
type IssueMetadataRow = [label: string, value: string, copyable?: boolean, copyValue?: string];
type IssueMetadataSection = {
  title: string;
  rows: IssueMetadataRow[];
};
const ISSUE_DETAIL_SCROLL_OWNER_SELECTORS = [
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

type WorkNotesDraft = {
  draft: string;
  baseRevision: string | null;
};

// Keep the component's historical export name while sourcing the values from
// the browser-safe canonical issue contract.
export const LEDGER_ISSUE_CLOSE_RESOLUTIONS = LEDGER_ISSUE_RESOLUTIONS;
export type LedgerIssueCloseResolution = LedgerIssueResolution;

/**
 * Umbrella 96c5090: `parent_child` relationship edges are the only source of
 * truth for umbrella membership, so an umbrella's children arrive in the detail
 * projection as ordinary outgoing relationships. Split them out so the pane can
 * answer "what does this umbrella own?" at a glance without listing the same
 * issue twice.
 *
 * Matched on `relationship_type` because that is the field the UI projection
 * type carries and the field the existing relationship list already reads; the
 * daemon writes the same value into both `relationship_type` and `link_type`
 * (`src/ledger/issue-detail.ts`).
 *
 * An edge whose `related_issue` did not resolve has no id, title, or status to
 * put in a shelf row, so it stays in Relationships, where the existing list
 * renders it as "missing issue". A broken edge stays visible rather than
 * vanishing into a shelf that cannot describe it.
 */
export type UmbrellaChildRelationship = LedgerIssueDetailRelationship & {
  related_issue: LedgerIssueSummaryRef;
};

function isUmbrellaChild(
  relationship: LedgerIssueDetailRelationship,
): relationship is UmbrellaChildRelationship {
  return (
    relationship.direction === 'outgoing' &&
    relationship.relationship_type === 'parent_child' &&
    relationship.related_issue !== null
  );
}

export function partitionUmbrellaChildren(detail: LedgerIssueDetailProjection): {
  children: UmbrellaChildRelationship[];
  rest: LedgerIssueDetailRelationship[];
} {
  const children: UmbrellaChildRelationship[] = [];
  const rest: LedgerIssueDetailRelationship[] = [];
  for (const relationship of detail.relationships) {
    if (isUmbrellaChild(relationship)) children.push(relationship);
    else rest.push(relationship);
  }
  return { children, rest };
}

export type LedgerIssueDetailProps = {
  detail: LedgerIssueDetailProjection;
  compact?: boolean;
  presentation?: DetailPanePresentation;
  hydrating?: boolean;
  fullLoadFailed?: boolean;
  actionInFlight?: boolean;
  onAddComment?: (body: string) => Promise<void> | void;
  onUpdateWorkNotes?: (body: string, expectedRevision: string | null) => Promise<void> | void;
  onSetStatus?: (status: 'open' | 'closed', resolution?: LedgerIssueCloseResolution) => Promise<void> | void;
  onStartAgent?: () => Promise<void> | void;
  onOpenEntity?: (type: EntityType, id: string, repoId?: string) => void;
  onShowChildren?: (issue: LedgerIssueDetailProjection) => void;
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
  presentation = 'main',
  hydrating = false,
  fullLoadFailed = false,
  actionInFlight = false,
  onAddComment,
  onUpdateWorkNotes,
  onSetStatus,
  onStartAgent,
  onOpenEntity,
  onShowChildren,
  onAddToSpace,
}: LedgerIssueDetailProps): JSX.Element {
  const [commentText, setCommentText] = useState('');
  const [workNotesDraft, setWorkNotesDraft] = useState(detail.work_notes ?? '');
  const [editingWorkNotes, setEditingWorkNotes] = useState(false);
  const [workNotesEditorIssueId, setWorkNotesEditorIssueId] = useState(detail.id);
  const [workNotesBaseRevision, setWorkNotesBaseRevision] = useState<string | null>(detail.work_notes_revision ?? null);
  const [workNotesSaveError, setWorkNotesSaveError] = useState<string | null>(null);
  const [workNotesConflict, setWorkNotesConflict] = useState(false);
  const [showComposer, setShowComposer] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [metadataOpen, setMetadataOpen] = useState(false);
  const [workNotesOpen, setWorkNotesOpen] = useState(false);
  const [authEvidenceOpen, setAuthEvidenceOpen] = useState(false);
  const [childrenExpanded, setChildrenExpanded] = useState(false);
  const [relationshipsExpanded, setRelationshipsExpanded] = useState(false);
  const [artifactsExpanded, setArtifactsExpanded] = useState(false);
  // Launch-agent (issue ce83a84) is confirm-first: this flag only opens the
  // confirmation dialog, which previews the exact prompt before anything is
  // written or spawned. Distinct from `onStartAgent`, which is the
  // session-manager work-unit path.
  const [launchAgentOpen, setLaunchAgentOpen] = useState(false);
  const [localBusy, setLocalBusy] = useState(false);
  const headerRef = useRef<HTMLElement>(null);
  const workNotesDetailIdRef = useRef(detail.id);
  const workNotesDraftsRef = useRef(new Map<string, WorkNotesDraft>());
  workNotesDetailIdRef.current = detail.id;
  const busy = actionInFlight || localBusy;
  const resolvingAuth = detail.auth_requests.find((auth) =>
    (auth.link_type === 'resolves' || auth.link_type === 'fixed_by') &&
    (auth.status === 'completed' || auth.status === 'approved' || auth.status === 'executing')
  );
  const liveSession = detail.sessions.find((session) => session.liveness === 'live') ?? null;
  const activeSessions = detail.sessions.filter((session) => session.liveness !== 'stopped');
  const historicalSessions = detail.sessions.filter((session) => session.liveness === 'stopped');
  const primaryWorkUnit = detail.work_units[0] ?? null;
  const timeline = detail.timeline ?? fallbackTimeline(detail);
  const associatedArtifacts = detail.associated_artifacts ?? [];
  const displayLabels = detail.labels;
  const { children: umbrellaChildren, rest: otherRelationships } = partitionUmbrellaChildren(detail);
  const dependencies = detail.dependencies ?? [];
  const editingCurrentIssue = editingWorkNotes && workNotesEditorIssueId === detail.id;
  const hasIssueWorkNotes = typeof detail.work_notes === 'string' && (Boolean(onUpdateWorkNotes) || Boolean(detail.work_notes));
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
    detail.priority !== 'normal' ||
    detail.aliases.length > 0 ||
    detail.checkpoints.length > 0,
  );
  const hasIssueActions = Boolean(
    hasIssueMetadata ||
    onAddComment ||
    onSetStatus ||
    onStartAgent ||
    onShowChildren ||
    onAddToSpace ||
    hasIssueWorkNotes,
  );
  const projectRef = issueProjectRef(detail);

  useEffect(() => {
    setChildrenExpanded(false);
    setRelationshipsExpanded(false);
    setArtifactsExpanded(false);
    setWorkNotesOpen(false);
  }, [detail.id]);

  useEffect(() => {
    if (workNotesEditorIssueId !== detail.id) {
      if (editingWorkNotes) {
        workNotesDraftsRef.current.set(workNotesEditorIssueId, {
          draft: workNotesDraft,
          baseRevision: workNotesBaseRevision,
        });
      }
      const savedDraft = workNotesDraftsRef.current.get(detail.id);
      setWorkNotesEditorIssueId(detail.id);
      setWorkNotesDraft(savedDraft?.draft ?? detail.work_notes ?? '');
      setWorkNotesBaseRevision(savedDraft ? savedDraft.baseRevision : detail.work_notes_revision ?? null);
      setWorkNotesSaveError(null);
      setWorkNotesConflict(false);
      setEditingWorkNotes(Boolean(savedDraft));
      return;
    }
    if (editingWorkNotes) return;
    setWorkNotesDraft(detail.work_notes ?? '');
    setWorkNotesBaseRevision(detail.work_notes_revision ?? null);
    setWorkNotesSaveError(null);
    setWorkNotesConflict(false);
  }, [detail.id, detail.work_notes, detail.work_notes_revision, editingWorkNotes, workNotesEditorIssueId]);

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

  const submitWorkNotes = async () => {
    if (!onUpdateWorkNotes || busy || !editingCurrentIssue) return;
    const saveIssueId = detail.id;
    const saveDraft = workNotesDraft;
    const saveBaseRevision = workNotesBaseRevision;
    setLocalBusy(true);
    try {
      await onUpdateWorkNotes(saveDraft, saveBaseRevision);
      if (workNotesDetailIdRef.current === saveIssueId) {
        workNotesDraftsRef.current.delete(saveIssueId);
        setWorkNotesSaveError(null);
        setWorkNotesConflict(false);
        setEditingWorkNotes(false);
      }
    } catch (error) {
      if (workNotesDetailIdRef.current !== saveIssueId) return;
      if (isApiErrorStatus(error, 409)) {
        setWorkNotesConflict(true);
        setWorkNotesSaveError('Working notes changed while you were editing. Review the draft, then use the latest notes or save again after reconciling.');
      } else {
        setWorkNotesConflict(false);
        setWorkNotesSaveError('Could not save working notes. Your draft is still here.');
      }
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
        scrollOwnerSelector={ISSUE_DETAIL_SCROLL_OWNER_SELECTORS}
        scrollLockClassName="issues-detail--metadata-open"
        className="ledger-issue-detail__metadata-modal"
        panelClassName="ledger-issue-detail__metadata-panel"
      >
        <IssueMetadataContent detail={detail} />
      </DetailPaneModal>
      {hasIssueWorkNotes && (
        <DetailPaneModal
          open={workNotesOpen}
          onClose={() => setWorkNotesOpen(false)}
          titleId={`issue-working-notes-title-${detail.id}`}
          title="Working notes"
          closeLabel="Close working notes"
          excludeAboveRef={headerRef}
          scrollOwnerSelector={ISSUE_DETAIL_SCROLL_OWNER_SELECTORS}
          panelClassName="ledger-issue-detail__working-notes-panel"
        >
          <div className="ledger-issue-detail__working-notes-content">
            {onUpdateWorkNotes && !editingCurrentIssue && (
              <div className="ledger-issue-detail__working-notes-toolbar">
                <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => {
                  setWorkNotesEditorIssueId(detail.id);
                  setWorkNotesBaseRevision(detail.work_notes_revision ?? null);
                  setWorkNotesDraft(detail.work_notes ?? '');
                  workNotesDraftsRef.current.set(detail.id, {
                    draft: detail.work_notes ?? '',
                    baseRevision: detail.work_notes_revision ?? null,
                  });
                  setWorkNotesSaveError(null);
                  setWorkNotesConflict(false);
                  setEditingWorkNotes(true);
                }}>
                  Edit
                </button>
              </div>
            )}
            {editingCurrentIssue ? (
              <>
                <textarea
                  className="ledger-work-notes-editor"
                  aria-label="Working notes"
                  rows={compact ? 4 : 7}
                  value={workNotesDraft}
                  onInput={(event) => {
                    const draft = event.currentTarget.value;
                    setWorkNotesDraft(draft);
                    workNotesDraftsRef.current.set(detail.id, { draft, baseRevision: workNotesBaseRevision });
                  }}
                />
                {workNotesSaveError && <p className="text-muted ledger-work-notes-error" role="alert">{workNotesSaveError}</p>}
                <div className="ledger-comment-composer__actions">
                  <button type="button" className="btn btn--active" disabled={busy} onClick={() => void submitWorkNotes()}>
                    Save notes
                  </button>
                  {workNotesConflict && (
                    <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => {
                      setWorkNotesDraft(detail.work_notes ?? '');
                      setWorkNotesBaseRevision(detail.work_notes_revision ?? null);
                      workNotesDraftsRef.current.delete(detail.id);
                      setWorkNotesSaveError(null);
                      setWorkNotesConflict(false);
                    }}>
                      Use latest notes
                    </button>
                  )}
                  <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => {
                    setWorkNotesDraft(detail.work_notes ?? '');
                    setWorkNotesBaseRevision(detail.work_notes_revision ?? null);
                    workNotesDraftsRef.current.delete(detail.id);
                    setWorkNotesSaveError(null);
                    setWorkNotesConflict(false);
                    setEditingWorkNotes(false);
                  }}>
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <LedgerRenderedBody
                className="ledger-work-notes-body spec-panel"
                source={detail.work_notes ?? ''}
                empty="No working notes."
                detail={detail}
              />
            )}
          </div>
        </DetailPaneModal>
      )}
      {launchAgentOpen && (
        <AgentDispatchDialog
          subject={{ kind: 'issue', issue_ref: detail.display_id }}
          instruction={`Work on issue ${detail.display_id}: ${detail.title}`}
          title="Launch an agent on this issue"
          onClose={() => setLaunchAgentOpen(false)}
        />
      )}
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
      presentation={presentation}
      className={`ledger-issue-detail${compact ? ' ledger-issue-detail--compact' : ''}`}
      headerClassName="ledger-issue-detail__header"
      headerPrimaryClassName="ledger-issue-detail__header-primary"
      bodyClassName="ledger-issue-detail__body"
      headerRef={headerRef}
      header={(
        <DetailPaneHeader
          presentation={presentation}
          variant="standard"
          identity={{
            entityLabel: detail.project.repo_name ?? detail.project.display_name,
            displayRef: detail.display_id,
            canonicalRef: `${projectRef}/${detail.id}`,
            copyRef: `${projectRef}/${detail.display_id}`,
            copyLabel: `Copy ${projectRef}/${detail.display_id}`,
          }}
          title={<span dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(detail.title) }} />}
          status={(
            <>
              <StatusPill
                status={detail.status}
                resolution={detail.resolution}
                linkedAuth={resolvingAuth}
                onOpenAuth={onOpenEntity ? (auth) => onOpenEntity('auth_request', auth.id) : undefined}
              />
            </>
          )}
          actions={hasIssueActions ? (
            <IssueActionsMenu
              open={actionsOpen}
              busy={busy}
              detail={detail}
              liveSession={liveSession}
              primaryWorkUnit={primaryWorkUnit}
              onToggle={() => setActionsOpen((prev) => !prev)}
              onClose={() => setActionsOpen(false)}
              onStartAgent={isInitialDetail ? undefined : onStartAgent}
              onLaunchAgent={isInitialDetail ? undefined : () => setLaunchAgentOpen(true)}
              onSetStatus={onSetStatus}
              onAddComment={onAddComment ? () => setShowComposer(true) : undefined}
              onAddToSpace={onAddToSpace}
              onShowMetadata={hasIssueMetadata ? () => setMetadataOpen(true) : undefined}
              onShowWorkNotes={hasIssueWorkNotes ? () => setWorkNotesOpen(true) : undefined}
              onShowAuthEvidence={detail.auth_requests.length > 0 ? () => setAuthEvidenceOpen(true) : undefined}
              onShowChildren={umbrellaChildren.length > 0 ? onShowChildren : undefined}
            />
          ) : undefined}
          actionsLabel="Issue header actions"
          secondaryMetadata={(
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
          )}
        />
      )}
      overlays={overlays}
      ariaBusy={hydrating}
    >
        {umbrellaChildren.length > 0 && (
          <CollapsiblePanel
            className="ledger-issue-detail__section ledger-issue-detail__collapsible"
            title={<ShelfTitle title="Children" count={umbrellaChildren.length} />}
            expanded={childrenExpanded}
            onExpandedChange={setChildrenExpanded}
          >
            <UmbrellaChildrenShelf rows={umbrellaChildren} projectId={detail.project.id} onOpenEntity={onOpenEntity} />
          </CollapsiblePanel>
        )}

        {dependencies.length > 0 && (
          <section className="ledger-issue-detail__section ledger-issue-detail__dependencies-section">
            <SectionTitle title="Prerequisites" count={dependencies.length} />
            <DependencyList dependencies={dependencies} projectId={detail.project.id} onOpenEntity={onOpenEntity} />
          </section>
        )}

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

        {otherRelationships.length > 0 && (
          <CollapsiblePanel
            className="ledger-issue-detail__section ledger-issue-detail__collapsible"
            title={<ShelfTitle title="Relationships" count={otherRelationships.length} />}
            expanded={relationshipsExpanded}
            onExpandedChange={setRelationshipsExpanded}
          >
            <RelationshipList relationships={otherRelationships} projectId={detail.project.id} onOpenEntity={onOpenEntity} />
          </CollapsiblePanel>
        )}

        {associatedArtifacts.length > 0 && (
          <CollapsiblePanel
            className="ledger-issue-detail__section ledger-issue-detail__collapsible"
            title={<ShelfTitle title="Associated Artifacts" count={associatedArtifacts.length} />}
            expanded={artifactsExpanded}
            onExpandedChange={setArtifactsExpanded}
          >
            <AssociatedArtifactList artifacts={associatedArtifacts} />
          </CollapsiblePanel>
        )}

        {(activeSessions.length > 0 || historicalSessions.length > 0) && (
          <section className="ledger-issue-detail__section">
            <SectionTitle title="Sessions" count={detail.sessions.length} />
            <SessionHistory active={activeSessions} historical={historicalSessions} onOpenEntity={onOpenEntity} />
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
        const rows: Array<{ key: string; link: LedgerIssueDetailArtifactLink | null; authoredRef: string | null }> = [
          ...artifact.refs.map((ref) => ({ key: `ref:${ref}`, link: null, authoredRef: ref })),
          ...artifact.links.map((link) => ({ key: `link:${link.id}`, link, authoredRef: null })),
        ];
        if (rows.length === 0) rows.push({ key: 'artifact', link: null, authoredRef: null });
        return rows.map(({ key, link, authoredRef }) => (
          <a
            key={`${artifact.id}:${key}`}
            className="ledger-evidence-row"
            href={artifactLinkHref(artifact, link, authoredRef)}
            title={artifact.uri}
          >
            <span>{artifactSourceLabel(link, authoredRef)}</span>
            <strong>{artifactTitle(artifact)}</strong>
            <span className="ledger-evidence-row__meta">
              {link && <ArtifactLinkBadge link={link} />}
              <code>{artifactTypedRef(artifact, link, authoredRef)}</code>
              {artifactMetaLabel(artifact) && <span>{artifactMetaLabel(artifact)}</span>}
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
  authoredRef: string | null,
): string {
  if (authoredRef) return resourceRefHref(authoredRef);
  if (!link) return artifact.ref ? resourceRefHref(artifact.ref) : artifactDetailHref(artifact.id);
  if (link.target_id) return resourceRefHref(link.target_id);

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

function artifactSourceLabel(
  link: LedgerIssueDetailArtifactLink | null,
  authoredRef: string | null,
): string {
  if (authoredRef) return 'referenced';
  if (link) return link.link_type.replace(/_/g, ' ');
  return 'referenced';
}

function artifactTitle(artifact: LedgerIssueDetailAssociatedArtifact): string {
  return artifact.title
    || artifact.logical_name
    || artifactFileLabel(artifact.uri)
    || displayResourceRef(artifact.uri)
    || compactArtifactBlobRef(`artifact-blob:${artifact.content_hash}`);
}

function artifactTypedRef(
  artifact: LedgerIssueDetailAssociatedArtifact,
  link: LedgerIssueDetailArtifactLink | null,
  authoredRef: string | null,
): string {
  if (authoredRef) return displayResourceRef(authoredRef);
  if (link?.target_id) return displayResourceRef(link.target_id);
  if (link?.link_kind === 'living') {
    const seriesRef = link.series_ref ?? link.series_id;
    if (seriesRef) return displayResourceRef(seriesRef);
  }
  if (link?.series_ref && typeof link.resolved_version_no === 'number') {
    return `${displayResourceRef(link.series_ref)}@${link.resolved_version_no}`;
  }
  if (artifact.ref) return displayResourceRef(artifact.ref);
  return compactArtifactRef(artifact.id);
}

function artifactMetaLabel(artifact: LedgerIssueDetailAssociatedArtifact): string {
  return [
    artifact.role,
    artifact.media_type,
    artifact.provider_id,
    artifact.availability === 'unchecked' ? null : artifact.availability,
  ].filter(Boolean).join(' · ');
}

function artifactFileLabel(uri: string): string {
  if (!uri.startsWith('file://')) return '';
  const pathname = uri.slice('file://'.length);
  const basename = pathname.split(/[\\/]/).filter(Boolean).at(-1) ?? '';
  return basename && !/^[0-9a-f]{64}$/i.test(basename) ? basename : '';
}

function IssueActionsMenu({
  open,
  busy,
  detail,
  liveSession,
  primaryWorkUnit,
  onToggle,
  onClose,
  onStartAgent,
  onLaunchAgent,
  onSetStatus,
  onAddComment,
  onAddToSpace,
  onShowMetadata,
  onShowWorkNotes,
  onShowAuthEvidence,
  onShowChildren,
}: {
  open: boolean;
  busy: boolean;
  detail: LedgerIssueDetailProjection;
  liveSession: LedgerIssueDetailSession | null;
  primaryWorkUnit: LedgerIssueDetailWorkUnit | null;
  onToggle: () => void;
  onClose: () => void;
  onStartAgent?: () => Promise<void> | void;
  onLaunchAgent?: () => void;
  onSetStatus?: (status: 'open' | 'closed', resolution?: LedgerIssueCloseResolution) => Promise<void> | void;
  onAddComment?: () => void;
  onAddToSpace?: () => void;
  onShowMetadata?: () => void;
  onShowWorkNotes?: () => void;
  onShowAuthEvidence?: () => void;
  onShowChildren?: (issue: LedgerIssueDetailProjection) => void;
}): JSX.Element {
  const [closeResolutionOpen, setCloseResolutionOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuStyle = useAnchoredMenu({
    open,
    anchorRef: triggerRef,
    menuRef,
    onDismiss: onClose,
  });
  const closeAfter = (callback: () => void) => {
    callback();
    onClose();
  };
  useEffect(() => {
    if (!open) setCloseResolutionOpen(false);
  }, [open]);
  return (
    <div className="ledger-issue-actions-menu">
      <DetailPaneMenuTrigger
        buttonRef={triggerRef}
        label="Issue actions"
        expanded={open}
        onClick={onToggle}
      />
      {open && (
        <div
          ref={menuRef}
          className="ledger-issue-actions-menu__dropdown app-anchored-menu"
          role="menu"
          popover="manual"
          style={menuStyle}
        >
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
          {onLaunchAgent && (
            <button
              type="button"
              className="ledger-issue-actions-menu__item"
              role="menuitem"
              disabled={busy}
              onClick={() => closeAfter(onLaunchAgent)}
            >
              Launch agent…
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
          {onShowWorkNotes && (
            <button
              type="button"
              className="ledger-issue-actions-menu__item"
              role="menuitem"
              onClick={() => closeAfter(onShowWorkNotes)}
            >
              Working notes
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
              Approval Evidence
            </button>
          )}
          {onSetStatus && detail.status === 'open' && !closeResolutionOpen && (
            <button
              type="button"
              className="ledger-issue-actions-menu__item ledger-issue-actions-menu__item--danger"
              role="menuitem"
              disabled={busy}
              onClick={() => setCloseResolutionOpen(true)}
            >
              Close Issue
            </button>
          )}
          {onSetStatus && detail.status === 'open' && closeResolutionOpen && (
            <div role="group" aria-label="Close issue resolution">
              <div className="ledger-issue-actions-menu__subheading">Choose a resolution</div>
              {LEDGER_ISSUE_CLOSE_RESOLUTIONS.map((resolution) => (
                <button
                  key={resolution}
                  type="button"
                  className="ledger-issue-actions-menu__item ledger-issue-actions-menu__item--danger"
                  role="menuitem"
                  disabled={busy}
                  onClick={() => closeAfter(() => void onSetStatus('closed', resolution))}
                >
                  Close as {resolution}
                </button>
              ))}
              <button
                type="button"
                className="ledger-issue-actions-menu__item"
                role="menuitem"
                disabled={busy}
                onClick={() => setCloseResolutionOpen(false)}
              >
                Back
              </button>
            </div>
          )}
          {onSetStatus && detail.status === 'closed' && (
            <button
              type="button"
              className="ledger-issue-actions-menu__item"
              role="menuitem"
              disabled={busy}
              onClick={() => closeAfter(() => void onSetStatus('open'))}
            >
              Reopen Issue
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
  size = 'lg',
}: {
  status: string;
  resolution: string | null;
  linkedAuth?: LedgerIssueDetailAuthRequest;
  onOpenAuth?: (auth: LedgerIssueDetailAuthRequest) => void;
  // The header pill is the pane's headline status and stays large. Inline row
  // pills (the umbrella children shelf) take the base size so a row keeps the
  // same height as every other ledger row.
  size?: 'sm' | 'lg';
}): JSX.Element {
  const label = status === 'closed' && resolution ? `${status}: ${resolution}` : status;
  const cls = status === 'open' ? 'status-pill--success' : resolution === 'delivered' ? 'status-pill--merged' : 'status-pill--dismissed';
  const sizeCls = size === 'lg' ? ' status-pill--lg' : '';
  if (linkedAuth && onOpenAuth) {
    return (
      <button type="button" className={`status-pill${sizeCls} ledger-status-button ${cls}`} onClick={() => onOpenAuth(linkedAuth)}>
        {label}
      </button>
    );
  }
  return <span className={`status-pill${sizeCls} ${cls}`}>{label}</span>;
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
    const isWorkNotesEvent = entry.event_type === 'issue.work_notes_updated';
    const resultingWorkNotes = isWorkNotesEvent && typeof entry.payload.work_notes === 'string'
      ? entry.payload.work_notes
      : null;
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
        {resultingWorkNotes !== null ? (
          <details className="ledger-work-notes-history">
            <summary>{resultingWorkNotes ? 'View saved working notes' : 'Working notes cleared'}</summary>
            {resultingWorkNotes && (
              <LedgerRenderedBody
                className="ledger-work-notes-history__body spec-panel"
                source={resultingWorkNotes}
                empty="Working notes cleared."
                detail={detail}
              />
            )}
          </details>
        ) : (
          <MetadataDisclosure label="Timeline metadata">
            <MetadataRows rows={eventMetadataRows(entry)} />
          </MetadataDisclosure>
        )}
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

/** A related issue's id, qualified with its project when that is not `projectId`. */
function relatedIssueId(related: LedgerIssueSummaryRef, projectId: string): string {
  return related.project_id === projectId ? related.display_id : `${related.project_ref}/${related.display_id}`;
}

function RelationshipList({
  relationships,
  projectId,
  onOpenEntity,
}: {
  relationships: LedgerIssueDetailRelationship[];
  projectId: string;
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
            onClick={() => related && onOpenEntity?.('issue', related.display_id, related.project_ref)}
          >
            <span>{relationship.direction === 'incoming' ? 'from' : 'to'}</span>
            <strong>{relationship.relationship_type.replace(/_/g, ' ')}</strong>
            <code>{related ? `${relatedIssueId(related, projectId)} ${related.title}` : 'missing issue'}</code>
          </button>
        );
      })}
    </div>
  );
}

function DependencyList({
  dependencies,
  projectId,
  onOpenEntity,
}: {
  dependencies: LedgerIssueSummaryRef[];
  projectId: string;
  onOpenEntity?: LedgerIssueDetailProps['onOpenEntity'];
}): JSX.Element {
  return (
    <div className="ledger-dependency-list">
      {dependencies.map((dependency) => (
        <button
          key={dependency.id}
          type="button"
          className="ledger-dependency-row"
          disabled={!onOpenEntity}
          onClick={() => onOpenEntity?.('issue', dependency.display_id, dependency.project_ref)}
        >
          <code>{relatedIssueId(dependency, projectId)}</code>
          <strong>{dependency.title}</strong>
          <StatusPill status={dependency.status} resolution={dependency.resolution} size="sm" />
          {dependency.status === 'open' && <span className="ledger-dependency-row__warning">Open prerequisite</span>}
        </button>
      ))}
    </div>
  );
}

function UmbrellaChildrenShelf({
  rows,
  projectId,
  onOpenEntity,
}: {
  rows: UmbrellaChildRelationship[];
  projectId: string;
  onOpenEntity?: LedgerIssueDetailProps['onOpenEntity'];
}): JSX.Element {
  return (
    <div className="ledger-child-list">
      {rows.map((relationship) => {
        const related = relationship.related_issue;
        return (
          <button
            key={relationship.id}
            type="button"
            className="ledger-child-row"
            disabled={!onOpenEntity}
            onClick={() => onOpenEntity?.('issue', related.display_id, related.project_ref)}
          >
            <code>{relatedIssueId(related, projectId)}</code>
            <strong>{related.title}</strong>
            <StatusPill status={related.status} resolution={related.resolution} size="sm" />
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
        aria-label="Approval evidence"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="ledger-issue-modal__header">
          <h3>Approval Evidence</h3>
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
      <span className={`ledger-session-row__dot ledger-session-row__dot--${session.liveness}`} />
      <strong>{session.provider ?? session.agent ?? 'session'}</strong>
      <code>{session.branch ?? session.id}</code>
      {session.owner && (
        <span className="ledger-session-row__owner">
          {session.owner.display_name}
          <small>{session.owner.kind}</small>
        </span>
      )}
      <em>{session.liveness}</em>
    </button>
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

function ShelfTitle({ title, count }: { title: string; count: number }): JSX.Element {
  return (
    <>
      <span>{title}</span>
      <em className="ledger-collapsible-panel__count">{count}</em>
    </>
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
    { title: 'Status', rows: pullRows(['Kind', 'Priority']) },
    { title: 'Provenance', rows: pullRows(['Source', 'Created', 'Updated', 'Closed']) },
  ];
  return sections.filter((section) => section.rows.length > 0);
}

function copyValueForIssueMetadata(key: string, value: string): string {
  if (key !== 'Alternate refs') return value;
  return value.split(',')[0]?.trim() || value;
}

function bodyMetadataRows(entry: Extract<LedgerIssueTimelineEntry, { kind: 'body' }>): Array<[string, string]> {
  const rows: Array<[string, string]> = [
    ['Entry', '#0'],
    ['Author type', entry.author.type.replace(/_/g, ' ')],
    ['Source', entry.source || 'unknown'],
    ['Created', formatAbsoluteTime(entry.created_at, LEDGER_TIME_OPTIONS)],
    ['Updated', formatAbsoluteTime(entry.updated_at, LEDGER_TIME_OPTIONS)],
  ];
  return rows.filter(([, value]) => Boolean(value));
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
  const rows: Array<[string, string]> = [
    ['Event ID', entry.id],
    ['Event type', entry.event_type],
    ['Source', entry.source || 'unknown'],
    ['Created', formatAbsoluteTime(entry.created_at, LEDGER_TIME_OPTIONS)],
  ];
  return rows.filter(([, value]) => Boolean(value));
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
  if (entry.event_type === 'issue.work_notes_updated') return 'Working notes updated';
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
  return label;
}

function authEvidenceLinkLabel(auth: LedgerIssueDetailAuthRequest): string {
  if (auth.link_type === 'resolves' || auth.link_type === 'fixed_by') return 'resolved by';
  if (auth.link_type === 'references') return 'referenced by';
  return `${auth.link_type.replace(/_/g, ' ')} by`;
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

function CloseIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m18 6-12 12" />
      <path d="m6 6 12 12" />
    </svg>
  );
}
