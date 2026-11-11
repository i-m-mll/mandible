import { Icon } from '../components/icons/Icon';
import { appTip } from '../components/shared/AppHoverTips';
import { openInterfaceNotesMenuAt } from './InterfaceNotesMenu';
import { useInterfaceNotes } from './interfaceNotesStore';

type AgentationToggleButtonProps = {
  visible: boolean;
  expandedRail: boolean;
  onToggle: () => void;
};

export function AgentationToggleButton({ visible, expandedRail, onToggle }: AgentationToggleButtonProps): JSX.Element {
  const { unfiled, pendingWrites, loadedIssue } = useInterfaceNotes();
  const label = `${visible ? 'Hide' : 'Show'} Agentation`;
  const tip = [
    label,
    unfiled.length ? `${unfiled.length} unfiled ${unfiled.length === 1 ? 'note' : 'notes'}` : null,
    pendingWrites ? `${pendingWrites} not saved yet` : null,
    loadedIssue ? `Pins of issue ${loadedIssue.id}` : null,
  ].filter(Boolean).join(' · ');
  return (
    <button
      type="button"
      data-feedback-toolbar
      className="app-rail__item"
      aria-label={label}
      aria-pressed={visible}
      {...appTip(tip, 'right')}
      onClick={onToggle}
      onContextMenu={(event) => {
        event.preventDefault();
        openInterfaceNotesMenuAt(event.currentTarget);
      }}
    >
      <span className="app-rail__icon">
        <Icon name="annotate" size={18} />
      </span>
      {expandedRail ? <span className="app-rail__label">Agentation</span> : null}
      {unfiled.length || pendingWrites ? (
        <span className={`tab-badge app-rail__badge${pendingWrites ? ' tab-badge--pending' : ''}`}>
          {unfiled.length}
        </span>
      ) : null}
    </button>
  );
}
