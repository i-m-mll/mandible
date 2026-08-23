import type { BriefingGroup } from '../../api';
import { DetailPaneHeader } from '../../components/shared/DetailPaneHeader';
import { DetailPaneShell } from '../../components/shared/DetailPaneShell';
import { shortIdentityRef } from '../../identity-refs';

export type BriefingGroupDetailProps = {
  group: BriefingGroup;
  selectedUpdateId: string | null;
  onSelectUpdate(updateId: string): void;
};

export function BriefingGroupDetail({
  group,
  selectedUpdateId,
  onSelectUpdate,
}: BriefingGroupDetailProps): JSX.Element {
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
    </DetailPaneShell>
  );
}

export default BriefingGroupDetail;
