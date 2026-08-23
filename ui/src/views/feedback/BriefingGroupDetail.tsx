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
        <section className="briefing-group-detail__current" aria-labelledby="briefing-group-current-title">
          <div className="briefing-group-detail__intro">
            <h3 id="briefing-group-current-title">Current</h3>
            <p>The current sidebar layout for this group.</p>
          </div>
          {group.current ? (
            <button
              type="button"
              className={`briefing-group-detail__update briefing-group-detail__current-card${selectedUpdateId === null ? ' briefing-group-detail__update--selected' : ''}`}
              aria-label={`Show current layout ${group.current.name}`}
              aria-pressed={selectedUpdateId === null}
              onClick={() => onSelectUpdate(null)}
            >
              <span className="briefing-group-detail__update-name">{group.current.name}</span>
              <span className="briefing-group-detail__update-ref">{shortIdentityRef(group.current.id)}</span>
            </button>
          ) : (
            <p className="briefing-empty">No current layout is available.</p>
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
      </div>
    </DetailPaneShell>
  );
}

export default BriefingGroupDetail;
