import { useState } from 'preact/hooks';

import { dispositionBriefingGroupProposal, type BriefingBundleLeaf, type BriefingGroup } from '../../api';
import { TrackedBriefingDocumentPanel } from './TrackedBriefingDocumentPanel';
import type { FeedbackCollection } from './collection-model';
import { authReviewHref } from '../auth-review-navigation';
import { DetailPaneHeader } from '../../components/shared/DetailPaneHeader';
import { DetailPaneShell } from '../../components/shared/DetailPaneShell';
import { shortIdentityRef } from '../../identity-refs';

export type BriefingGroupDetailProps = {
  group: BriefingGroup;
  selectedUpdateId: string | null;
  onSelectUpdate(updateId: string | null): void;
  onDisposition?(group: BriefingGroup): void;
  onSelectBriefing?(briefing: FeedbackCollection): void;
};

export function BriefingGroupDetail({
  group,
  selectedUpdateId,
  onSelectUpdate,
  onDisposition,
  onSelectBriefing,
}: BriefingGroupDetailProps): JSX.Element {
  const [busy, setBusy] = useState<'accepted' | 'rejected' | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const baseName = group.current?.name === 'Original' ? 'Base' : group.current?.name;
  const selectedProposal = group.updates.find((update) => update.id === selectedUpdateId) ?? null;
  const layout = (selectedProposal ?? group.current)?.layout ?? [];
  const proposals = group.trackedProposals ?? [];
  const subgroupMembers = (entry: Extract<(typeof layout)[number], { kind: 'subgroup' }>): BriefingBundleLeaf[] =>
    entry.members ?? entry.briefings.map(briefing => ({ kind: 'briefing', briefing }));
  const showsTracked = layout.some(entry => entry.kind === 'tracked'
    || (entry.kind === 'subgroup' && subgroupMembers(entry).some(leaf => leaf.kind === 'tracked')));
  const renderLeaf = (entry: BriefingBundleLeaf) => {
    if (entry.kind === 'briefing') return <li key={entry.briefing.id}>
      <button type="button" onClick={() => onSelectBriefing?.(entry.briefing)}>{entry.briefing.label}</button>
    </li>;
    const { tracked } = entry;
    const matches = proposals.filter(proposal => proposal.members.some(member =>
      member.project_id === tracked.project_id && member.path === tracked.path));
    return <li key={`${tracked.project_id}:${tracked.path}`}>
      <TrackedBriefingDocumentPanel document={tracked} pending={matches.length}>
        {matches.map(proposal => <a key={proposal.request_id} href={authReviewHref(proposal.request_ref, 'diff')}>{proposal.title}</a>)}
      </TrackedBriefingDocumentPanel>
    </li>;
  };
  const reviewCandidate = group.reviewCandidates?.find((candidate) => candidate.proposalBundleId === selectedUpdateId) ?? null;
  const publishedReportCount = group.destinations.filter((destination) => destination.publicationMode === 'published-report').length;
  const reviewedDocumentCount = group.destinations.filter((destination) => destination.publicationMode === 'reviewed-document').length;
  const disposition = async (decision: 'accepted' | 'rejected') => {
    if (!selectedProposal || !group.current || !reviewCandidate?.ready || !reviewCandidate.bindingDigest || busy) return;
    const verb = decision === 'accepted' ? 'accept' : 'reject';
    if (typeof window !== 'undefined' && !window.confirm(
      `${verb[0].toUpperCase()}${verb.slice(1)} “${selectedProposal.name}” against the current Base?`,
    )) return;
    setBusy(decision);
    setStatus(null);
    try {
      const result = await dispositionBriefingGroupProposal(group.id, {
        decision,
        expectedBaseBundleId: group.current.id,
        proposalBundleId: selectedProposal.id,
        bindingDigest: reviewCandidate.bindingDigest,
        destinationChanges: reviewCandidate.destinationChanges,
      });
      setStatus(result.changed
        ? `Proposal ${decision === 'accepted' ? 'accepted as Base' : 'rejected'}.`
        : `Proposal was already ${decision}.`);
      onDisposition?.(result.group);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };
  return (
    <DetailPaneShell
      className="briefing-group-detail"
      header={(
        <DetailPaneHeader
          variant="standard"
          identity={{
            entityLabel: 'Briefing group',
            displayRef: group.key,
            canonicalRef: group.id,
          }}
          title={group.name}
        />
      )}
      bodyClassName="briefing-group-detail__body"
    >
      <div className="briefing-group-detail__sections">
        {group.archivedAt != null ? (
          <p className="briefing-empty" role="status">Archived collection. Its bundles, Briefings, and review history remain intact.</p>
        ) : null}
        {group.destinations.length > 0 ? (
          <div className="briefing-empty">
            <p>
            Owns {group.destinations.length} recurring destination{group.destinations.length === 1 ? '' : 's'}
            {publishedReportCount > 0 ? `: ${publishedReportCount} published report${publishedReportCount === 1 ? '' : 's'}` : ''}
            {publishedReportCount > 0 && reviewedDocumentCount > 0 ? ' and ' : ''}
            {reviewedDocumentCount > 0 ? `${reviewedDocumentCount} reviewed document${reviewedDocumentCount === 1 ? '' : 's'}` : ''}.
            Published reports advance Current without Accept or Reject and do not imply human endorsement.
            </p>
            <ul>
              {group.destinations.map((destination) => (
                <li key={destination.logicalArtifactId}>
                  {shortIdentityRef(destination.logicalArtifactId)}: {destination.publicationMode ?? 'unrouted'}
                  {destination.routeKeys.length ? ` · ${destination.routeKeys.join(', ')}` : ''}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <section className="briefing-group-detail__current" aria-labelledby="briefing-group-current-title">
          <div className="briefing-group-detail__intro">
            <h3 id="briefing-group-current-title">Base</h3>
            <p>The current layout and comparison base for reviewed documents. Published reports can be placed directly.</p>
          </div>
          {group.current ? (
            <button
              type="button"
              className={`briefing-group-detail__update briefing-group-detail__current-card${selectedUpdateId === null ? ' briefing-group-detail__update--selected' : ''}`}
              aria-label={`Show Base layout ${baseName}`}
              aria-pressed={selectedUpdateId === null}
              onClick={() => onSelectUpdate(null)}
            >
              <span className="briefing-group-detail__update-name">{baseName}</span>
              <span className="briefing-group-detail__update-ref">{shortIdentityRef(group.current.id)}</span>
            </button>
          ) : (
            <p className="briefing-empty">No Base layout is available.</p>
          )}
        </section>
        <section className="briefing-group-detail__updates" aria-labelledby="briefing-group-updates-title">
          <div className="briefing-group-detail__intro">
            <h3 id="briefing-group-updates-title">Proposed updates</h3>
            <p>Choose which proposed update supplies this group’s sidebar layout.</p>
          </div>
          {group.updates.length === 0 ? (
            <p className="briefing-empty">No proposed updates are available.</p>
          ) : (
            <ul className="briefing-group-detail__update-list">
              {group.updates.map((update) => {
                const selected = update.id === selectedUpdateId;
                return (
                  <li key={update.id}>
                    <button
                      type="button"
                      className={`briefing-group-detail__update${selected ? ' briefing-group-detail__update--selected' : ''}`}
                      aria-label={`Preview proposed update ${update.name}`}
                      aria-pressed={selected}
                      onClick={() => onSelectUpdate(update.id)}
                    >
                      <span className="briefing-group-detail__update-name">{update.name}</span>
                      <span className="briefing-group-detail__update-ref">{shortIdentityRef(update.id)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {selectedProposal ? (
            <div className="briefing-group-detail__review" aria-label="Human review disposition">
              {reviewCandidate?.ready ? (
                <>
                  <p>
                    Frozen review ready for {reviewCandidate.items.filter((item) => item.changed).length} changed document{reviewCandidate.items.filter((item) => item.changed).length === 1 ? '' : 's'}
                    {reviewCandidate.layoutChanged ? ', a layout change' : ''}
                    {reviewCandidate.destinationChanges.length > 0 ? `, and ${reviewCandidate.destinationChanges.length} destination move${reviewCandidate.destinationChanges.length === 1 ? '' : 's'}` : ''}.
                  </p>
                  <div className="briefing-group-detail__review-actions">
                    <button type="button" className="briefing-group-detail__accept" disabled={busy !== null}
                      onClick={() => void disposition('accepted')}>{busy === 'accepted' ? 'Accepting…' : 'Accept as Base'}</button>
                    <button type="button" className="briefing-group-detail__reject" disabled={busy !== null}
                      onClick={() => void disposition('rejected')}>{busy === 'rejected' ? 'Rejecting…' : 'Reject proposal'}</button>
                  </div>
                </>
              ) : (
                <p>{reviewCandidate?.blockerMessage ?? 'This proposal is not eligible for human-reviewed disposition.'}</p>
              )}
            </div>
          ) : null}
          {status ? <p className="briefing-group-detail__review-status" role="status">{status}</p> : null}
        </section>
        {showsTracked ? (
          <section aria-label="Group documents">
            <ul>{layout.map(entry => entry.kind === 'subgroup'
              ? <li key={entry.name}><span>{entry.name}</span><ul>{subgroupMembers(entry).map(renderLeaf)}</ul></li>
              : renderLeaf(entry))}</ul>
          </section>
        ) : null}
        {proposals.length ? (
          <section aria-label="Merge requests">
            <h3>Merge requests</h3>
            <ul>{proposals.map(proposal => (
              <li key={proposal.request_id}>
                <a href={authReviewHref(proposal.request_ref, 'diff')}>{proposal.title}</a> · {proposal.project_key}
                {proposal.depends_on.length ? <ul aria-label="Depends on">{proposal.depends_on.map(dep => (
                  <li key={dep.requested_id}>Depends on {dep.request_id
                    ? <a href={authReviewHref(dep.request_id, 'diff')}>{shortIdentityRef(dep.request_id)}</a>
                    : shortIdentityRef(dep.requested_id)} · {dep.state}</li>
                ))}</ul> : null}
              </li>
            ))}</ul>
          </section>
        ) : null}
        {(group.history?.length ?? 0) > 0 ? (
          <section className="briefing-group-detail__history" aria-label="History">
            <details>
              <summary>History ({group.history?.length ?? 0})</summary>
              <ul className="briefing-group-detail__history-list">
                {(group.history ?? []).map((entry) => (
                  <li key={entry.id}>
                    <span>{entry.kind === 'promoted' ? 'Promoted to Base'
                      : entry.kind === 'accepted' ? 'Accepted as Base'
                        : entry.kind === 'rejected' ? 'Rejected' : 'Dismissed'}</span>
                    <strong>{entry.proposal.name}</strong>
                    <span>{new Date(entry.createdAt).toLocaleString()}</span>
                    {entry.priorBase ? <span>Previous Base: {entry.priorBase.name === 'Original' ? 'Base' : entry.priorBase.name}</span> : null}
                  </li>
                ))}
              </ul>
            </details>
          </section>
        ) : null}
        {group.destinationHistory.length > 0 ? (
          <section className="briefing-group-detail__history" aria-label="Destination history">
            <details>
              <summary>Report placement history ({group.destinationHistory.length})</summary>
              <ul className="briefing-group-detail__history-list">
                {group.destinationHistory.map((entry) => (
                  <li key={entry.id}>
                    <span>{entry.priorGroupId === null ? 'Placed' : entry.resultingGroupId === group.id ? 'Moved in' : 'Moved out'}</span>
                    <strong>{shortIdentityRef(entry.logicalArtifactId)}</strong>
                    <span>{new Date(entry.createdAt).toLocaleString()}</span>
                    <span>By {shortIdentityRef(entry.actorUserId)}</span>
                  </li>
                ))}
              </ul>
            </details>
          </section>
        ) : null}
      </div>
    </DetailPaneShell>
  );
}

export default BriefingGroupDetail;
