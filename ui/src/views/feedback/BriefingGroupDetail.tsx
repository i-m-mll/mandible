import { useQuery } from '@tanstack/preact-query';
import { useId, useRef, useState } from 'preact/hooks';
import type { BriefingGroupDocumentChange, TrackedBriefingProposal } from '../../../../src/contracts';
import {
  dismissBriefingGroupProposal, dispositionBriefingGroupProposal, getArtifactDiff,
  type BriefingBundle, type BriefingBundleLayoutEntry, type BriefingBundleLeaf, type BriefingGroup,
} from '../../api';
import { Icon, type IconName } from '../../components/icons/Icon';
import { appTip } from '../../components/shared/AppHoverTips';
import { ContextualAction } from '../../components/shared/ContextualAction';
import { DetailPaneHeader } from '../../components/shared/DetailPaneHeader';
import { DetailPaneMenuTrigger } from '../../components/shared/DetailPaneMenuTrigger';
import { DetailPaneModal } from '../../components/shared/DetailPaneModal';
import { DetailPaneNotice } from '../../components/shared/DetailPaneNotice';
import { DetailPaneShell } from '../../components/shared/DetailPaneShell';
import { RequestListRow } from '../../components/shared/RequestListRow';
import { SidebarGroupNode } from '../../components/shared/SidebarGroupNode';
import { SidebarItemBadge, SidebarItemRow } from '../../components/shared/SidebarItemRow';
import { useAnchoredMenu } from '../../hooks/useAnchoredMenu';
import { shortIdentityRef } from '../../identity-refs';
import { queryClient } from '../../query/client';
import { navigateTo } from '../../routing';
import { authReviewHref } from '../auth-review-navigation';
import type { FeedbackCollection } from './collection-model';
import { TrackedBriefingDocumentContent } from './TrackedBriefingDocumentPanel';

export type BriefingGroupDetailProps = {
  group: BriefingGroup;
  selectedUpdateId: string | null;
  onSelectUpdate(updateId: string | null): void;
  onDisposition?(group: BriefingGroup): void;
  onRefresh?(): void;
  onSelectBriefing?(briefing: FeedbackCollection): void;
};

const ACCEPT_BLOCKERS: Readonly<Record<string, string>> = {
  briefing_review_repository_authority_required: 'Accept after the protected merge',
  briefing_review_base_required: 'Set a current bundle first',
  briefing_review_provenance_drift: 'The proposal was made for a different revision',
  briefing_review_tracked_layout_drift: 'Tracked files require a protected merge',
  briefing_review_proposal_incomplete: 'A proposed document is unavailable',
  briefing_review_base_incomplete: 'A current document is unavailable',
  briefing_review_base_ambiguous: 'The current group lists a document twice',
  briefing_review_proposal_ambiguous: 'The proposal lists a document twice',
  briefing_review_custody_unavailable: 'The proposed document is unavailable',
  briefing_review_submission_required: 'Send a review for each changed document first',
  briefing_review_change_required: 'There are no changes to accept',
};

const HISTORY_DECISION: Record<NonNullable<BriefingGroup['history']>[number]['kind'], { icon: IconName; label: string }> = {
  accepted: { icon: 'markRead', label: 'Accepted' },
  promoted: { icon: 'mergeRequest', label: 'Merged' },
  dismissed: { icon: 'dismiss', label: 'Dismissed' },
  rejected: { icon: 'dismiss', label: 'Rejected' },
};

function subgroupMembers(entry: Extract<BriefingBundleLayoutEntry, { kind: 'subgroup' }>): BriefingBundleLeaf[] {
  return entry.members ?? entry.briefings.map(briefing => ({ kind: 'briefing', briefing }));
}

function withRemovedMembers(
  proposed: readonly BriefingBundleLayoutEntry[], current: readonly BriefingBundleLayoutEntry[],
  changes: readonly BriefingGroupDocumentChange[],
): BriefingBundleLayoutEntry[] {
  const removed = new Set(changes.flatMap(change => change.kind === 'removed' ? [change.base_briefing_id] : []));
  const result = [...proposed];
  const wasRemoved = (leaf: BriefingBundleLeaf) => leaf.kind === 'briefing' && removed.has(leaf.briefing.collectionId);
  for (const entry of current) {
    if (entry.kind === 'subgroup') {
      const members = subgroupMembers(entry).filter(wasRemoved);
      if (!members.length) continue;
      const index = result.findIndex(candidate => candidate.kind === 'subgroup' && candidate.name === entry.name);
      const existing = result[index];
      if (existing?.kind === 'subgroup') result[index] = { ...existing, members: [...subgroupMembers(existing), ...members] };
      else result.push({ ...entry, members });
    } else if (wasRemoved(entry)) result.push(entry);
  }
  return result;
}

function LinesChanged({ additions, deletions }: { additions: number | null; deletions: number | null }) {
  if (additions === null && deletions === null) return null;
  return (
    <>
      {additions !== null ? <span className="auth-change-file__added" aria-label={`${additions} added`}>+{additions}</span> : null}
      {deletions !== null ? <span className="auth-change-file__deleted" aria-label={`${deletions} removed`}>−{deletions}</span> : null}
    </>
  );
}

function mergedCounts(files: TrackedBriefingProposal['files']) {
  const sum = (key: 'additions' | 'deletions') => {
    const counted = files.flatMap(file => file[key] ?? []);
    return counted.length === files.length && counted.length ? counted.reduce((total, count) => total + count, 0) : null;
  };
  return { additions: sum('additions'), deletions: sum('deletions') };
}

function DocumentCount({ count }: { count: number }) {
  return <span>{count} {count === 1 ? 'document' : 'documents'}</span>;
}

function CustodyChangeCount({ change }: { change: BriefingGroupDocumentChange }) {
  const before = change.kind === 'modified' ? change.base_artifact_version_id : null;
  const after = change.kind === 'modified' ? change.proposal_artifact_version_id : null;
  const stats = useQuery({
    queryKey: ['briefing-compare-stats', before, after],
    queryFn: ({ signal }) => getArtifactDiff(before!, after!, { format: 'patch', signal }),
    enabled: before !== null && after !== null,
    staleTime: Infinity,
    retry: false,
  }, queryClient).data?.stats;
  if (change.kind === 'added') return <SidebarItemBadge ariaLabel="Added document">+1</SidebarItemBadge>;
  if (change.kind === 'removed') return <SidebarItemBadge ariaLabel="Removed document">−1</SidebarItemBadge>;
  return stats ? <LinesChanged additions={stats.added} deletions={stats.removed} /> : null;
}

function groupLeafId(entry: BriefingBundleLeaf) {
  return entry.kind === 'briefing' ? entry.briefing.collectionId : `${entry.tracked.project_id}:${entry.tracked.path}`;
}

function dateLabel(timestamp: number) {
  return new Date(timestamp).toLocaleDateString();
}

export function BriefingGroupDetail({
  group, selectedUpdateId, onSelectUpdate, onDisposition, onRefresh, onSelectBriefing,
}: BriefingGroupDetailProps): JSX.Element {
  const id = useId();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [openTrackedId, setOpenTrackedId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const historyButton = useRef<HTMLButtonElement>(null);
  const historyPanel = useRef<HTMLDivElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const moreMenu = useRef<HTMLDivElement>(null);
  const historyStyle = useAnchoredMenu({
    open: historyOpen, anchorRef: historyButton, menuRef: historyPanel, onDismiss: () => setHistoryOpen(false),
  });
  const moreStyle = useAnchoredMenu({
    open: moreOpen, anchorRef: moreButton, menuRef: moreMenu, onDismiss: () => setMoreOpen(false),
  });

  const selectedProposal = group.updates.find(update => update.id === selectedUpdateId);
  const trackedProposals = group.trackedProposals ?? [];
  const selectedRequest = trackedProposals.find(proposal => proposal.request_id === selectedUpdateId);
  const currentLayout = group.current?.layout ?? [];
  const changesByProposal = new Map(group.proposalChanges?.map(update => [update.proposal_bundle_id, update.members]));
  const selectedChanges = selectedProposal ? changesByProposal.get(selectedProposal.id) ?? [] : [];
  const changesByDocument = new Map(selectedChanges.map(change => [
    change.kind === 'removed' ? change.base_briefing_id : change.proposal_briefing_id, change,
  ]));
  const displayedLayout = selectedProposal
    ? withRemovedMembers(selectedProposal.layout, currentLayout, selectedChanges)
    : currentLayout;
  const countLayout = group.current ? currentLayout : selectedProposal?.layout ?? [];
  const documentCount = countLayout.reduce((count, entry) => count + (entry.kind === 'subgroup' ? subgroupMembers(entry).length : 1), 0);
  const candidateByProposal = new Map(group.reviewCandidates?.map(candidate => [candidate.proposalBundleId, candidate]));
  const unsent = new Set(group.draftCommentBriefingIds);
  const history = group.history ?? [];

  const selectPending = (updateId: string) => onSelectUpdate(updateId === selectedUpdateId ? null : updateId);
  const decisionReason = (proposalId: string, decision: 'Accept' | 'Dismiss'): string | null => {
    const candidate = candidateByProposal.get(proposalId);
    if (group.archivedAt != null) return 'This group is archived';
    if (!candidate || !onDisposition) return `${decision} is unavailable for this session`;
    if (decision === 'Dismiss') return null;
    return candidate.ready && candidate.bindingDigest && group.current ? null
      : ACCEPT_BLOCKERS[candidate.blockerCode ?? ''] ?? 'Accept is unavailable for this proposal';
  };

  const disposition = async (update: BriefingBundle, decision: 'Accept' | 'Dismiss') => {
    if (busy || decisionReason(update.id, decision)) return;
    setBusy(update.id);
    setError(null);
    try {
      if (decision === 'Dismiss') {
        onDisposition?.(await dismissBriefingGroupProposal(group, update.id));
      } else {
        const candidate = candidateByProposal.get(update.id)!;
        const result = await dispositionBriefingGroupProposal(group.id, {
          decision: 'accepted',
          expectedBaseBundleId: group.current!.id,
          proposalBundleId: update.id,
          bindingDigest: candidate.bindingDigest!,
          destinationChanges: candidate.destinationChanges,
        });
        onDisposition?.(result.group);
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      onRefresh?.();
    } finally {
      setBusy(null);
    }
  };

  const renderLeaf = (entry: BriefingBundleLeaf) => {
    const leafId = groupLeafId(entry);
    const change = changesByDocument.get(leafId);
    const tracked = entry.kind === 'tracked' ? entry.tracked : null;
    const match = tracked && selectedRequest?.members.find(member => member.project_id === tracked.project_id && member.path === tracked.path);
    const files = match ? (selectedRequest?.files ?? []).filter(file => match.file_indexes.includes(file.index)) : [];
    const touched = Boolean(change || match);
    const dimmed = Boolean(selectedUpdateId && !touched);
    const label = entry.kind === 'briefing' ? entry.briefing.label : entry.tracked.path;
    const openTracked = openTrackedId === leafId;
    const hasDraft = unsent.has(leafId);
    const firstFile = files[0];
    return (
      <li key={leafId} className={dimmed ? 'briefing-group-detail__document--dimmed' : undefined}>
        <SidebarItemRow
          label={label}
          selectionLabel={`Open ${label}`}
          selectionDescription={hasDraft ? 'Unsent comments' : undefined}
          selected={openTracked}
          onSelect={() => {
            if (entry.kind === 'briefing') onSelectBriefing?.(entry.briefing);
            else if (selectedRequest && firstFile) navigateTo(authReviewHref(selectedRequest.request_ref, 'diff', {
              oldPath: firstFile.old_path, newPath: firstFile.new_path,
            }));
            else setOpenTrackedId(openTracked ? null : leafId);
          }}
          badges={<>
            {tracked ? <SidebarItemBadge>{tracked.project_key}</SidebarItemBadge> : (
              <span {...appTip('Held by Mandible, not in a repository')}><Icon name="custodyPackage" size={14} /></span>
            )}
            {hasDraft ? <span className="briefing-group-detail__draft-dot" {...appTip('Unsent comments')} /> : null}
            {change ? <CustodyChangeCount change={change} /> : null}
            {match ? <LinesChanged {...mergedCounts(files)} /> : null}
          </>}
        />
        {openTracked && tracked && !match ? <TrackedBriefingDocumentContent document={tracked} /> : null}
      </li>
    );
  };

  return (
    <DetailPaneShell
      className="briefing-group-detail"
      header={(
        <DetailPaneHeader
          variant="compact"
          title={group.name}
          supportingMetadata={<DocumentCount count={documentCount} />}
          actions={<>
            <span {...appTip(history.length ? 'History' : 'No decisions yet')}>
              <ContextualAction ref={historyButton} presentation="compact" aria-label="History" aria-haspopup="dialog"
                aria-expanded={historyOpen} disabled={history.length === 0} onClick={() => setHistoryOpen(open => !open)}>
                <Icon name="history" />
              </ContextualAction>
            </span>
            <DetailPaneMenuTrigger buttonRef={moreButton} label="More" expanded={moreOpen}
              onClick={() => setMoreOpen(open => !open)} />
            {moreOpen ? (
              <div ref={moreMenu} className="auth-detail__actions-menu app-anchored-menu" role="menu" aria-label="More"
                popover="manual" style={moreStyle}>
                <button type="button" className="auth-detail__actions-item" role="menuitem"
                  onClick={() => { setMoreOpen(false); setDetailsOpen(true); }}>Details</button>
              </div>
            ) : null}
          </>}
        />
      )}
      bodyClassName="briefing-group-detail__body"
      notice={error ? <DetailPaneNotice severity="error" density="compact" title="Proposal could not be updated">{error}</DetailPaneNotice> : null}
      overlays={<>
        {historyOpen ? (
          <div ref={historyPanel} className="sidebar-search-filter__panel sidebar-search-filter__panel--popover app-anchored-menu"
            popover="manual" role="dialog" aria-label="History" style={historyStyle}>
            <ul className="briefing-group-detail__history">
              {history.map(entry => {
                const decision = HISTORY_DECISION[entry.kind];
                return (
                  <li key={entry.id}>
                    <span {...appTip(decision.label)}><Icon name={decision.icon} label={decision.label} /></span>
                    <strong>{entry.proposal.name}</strong>
                    <time dateTime={new Date(entry.createdAt).toISOString()}>{dateLabel(entry.createdAt)}</time>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
        <DetailPaneModal open={detailsOpen} onClose={() => setDetailsOpen(false)} titleId={`${id}-details`}
          title="Details" closeLabel="Close details" panelClassName="briefing-detail__metadata">
          <dl>
            <div><dt>Group</dt><dd>{group.key}</dd></div>
            <div><dt>Created</dt><dd>{dateLabel(group.createdAt)}</dd></div>
            <div><dt>Updated</dt><dd>{dateLabel(group.updatedAt)}</dd></div>
            {group.archivedAt ? <div><dt>Archived</dt><dd>{dateLabel(group.archivedAt)}</dd></div> : null}
            {group.destinations.map(destination => (
              <div key={destination.logicalArtifactId}><dt>{shortIdentityRef(destination.logicalArtifactId)}</dt>
                <dd>{destination.routeKeys.join(', ') || destination.publicationMode}</dd></div>
            ))}
          </dl>
        </DetailPaneModal>
      </>}
    >
      <div className="briefing-group-detail__sections">
        {trackedProposals.length || group.updates.length ? (
          <ul className="feedback-collections-sidebar__list" aria-label="Pending changes">
            {trackedProposals.map(proposal => {
              const href = authReviewHref(proposal.request_ref, 'diff');
              return (
                <li key={proposal.request_id}>
                  <RequestListRow leading={<Icon name="mergeRequest" />} title={proposal.title}
                    selected={selectedUpdateId === proposal.request_id} selection="toggle"
                    onSelect={() => selectPending(proposal.request_id)}
                    metadata={<><DocumentCount count={proposal.members.length} /><LinesChanged {...mergedCounts(proposal.files ?? [])} /></>}
                    actions={<ContextualAction presentation="compact" aria-label="Open the request"
                      {...appTip('Open the request')} onClick={() => navigateTo(href)}><Icon name="openLink" /></ContextualAction>}
                  />
                </li>
              );
            })}
            {group.updates.map(update => (
              <li key={update.id}>
                <RequestListRow leading={<Icon name="custodyPackage" />} title={update.name}
                  selected={selectedUpdateId === update.id} selection="toggle" onSelect={() => selectPending(update.id)}
                  metadata={<><time dateTime={new Date(update.createdAt).toISOString()}>{dateLabel(update.createdAt)}</time>
                    <DocumentCount count={changesByProposal.get(update.id)?.length ?? 0} /></>}
                  actions={(['Accept', 'Dismiss'] as const).map(decision => {
                    const reason = decisionReason(update.id, decision);
                    return (
                      <span key={decision} {...appTip(reason ?? decision)}>
                        <ContextualAction presentation="compact" aria-label={decision}
                          disabled={busy !== null || reason !== null}
                          onClick={() => void disposition(update, decision)}>
                          <Icon name={decision === 'Accept' ? 'markRead' : 'dismiss'} />
                        </ContextualAction>
                      </span>
                    );
                  })}
                />
              </li>
            ))}
          </ul>
        ) : null}
        <ul className="feedback-collections-sidebar__list" aria-label="Documents">
          {displayedLayout.map(entry => entry.kind === 'subgroup' ? (
            <li key={`subgroup:${entry.name}`}>
              <SidebarGroupNode id={`${id}-${entry.name}`} presentation="nested" label={entry.name} bodyAs="ul"
                expanded={!collapsed.has(entry.name)}
                onToggle={() => setCollapsed(current => {
                  const updated = new Set(current);
                  if (!updated.delete(entry.name)) updated.add(entry.name);
                  return updated;
                })}>
                {subgroupMembers(entry).map(renderLeaf)}
              </SidebarGroupNode>
            </li>
          ) : renderLeaf(entry))}
        </ul>
      </div>
    </DetailPaneShell>
  );
}

export default BriefingGroupDetail;
