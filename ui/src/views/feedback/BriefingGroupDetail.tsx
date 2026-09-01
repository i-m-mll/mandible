import type { BriefingGroup } from '../../api';
import { DetailPaneHeader } from '../../components/shared/DetailPaneHeader';
import { DetailPaneShell } from '../../components/shared/DetailPaneShell';
import { shortIdentityRef } from '../../identity-refs';

export type BriefingGroupDetailProps = {
  group: BriefingGroup;
  selectedUpdateId: string | null;
  onSelectUpdate(updateId: string | null): void;
};

export function BriefingGroupDetail({
  group,
  selectedUpdateId,
  onSelectUpdate,
}: BriefingGroupDetailProps): JSX.Element {
  const baseName = group.current?.name === 'Original' ? 'Base' : group.current?.name;
  return (
    <DetailPaneShell
      className="briefing-group-detail"
      header={(
        <DetailPaneHeader
          variant="standard"
          identity={{
            entityLabel: 'Briefing group',
            displayRef: shortIdentityRef(group.id),
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
        <section className="briefing-group-detail__current" aria-labelledby="briefing-group-current-title">
          <div className="briefing-group-detail__intro">
            <h3 id="briefing-group-current-title">Base</h3>
            <p>The accepted layout and comparison base for this group.</p>
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
        </section>
        {(group.history?.length ?? 0) > 0 ? (
          <section className="briefing-group-detail__history" aria-label="History">
            <details>
              <summary>History ({group.history?.length ?? 0})</summary>
              <ul className="briefing-group-detail__history-list">
                {(group.history ?? []).map((entry) => (
                  <li key={entry.id}>
                    <span>{entry.kind === 'promoted' ? 'Promoted to Base' : 'Dismissed'}</span>
                    <strong>{entry.proposal.name}</strong>
                    <span>{new Date(entry.createdAt).toLocaleString()}</span>
                    {entry.priorBase ? <span>Previous Base: {entry.priorBase.name === 'Original' ? 'Base' : entry.priorBase.name}</span> : null}
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
