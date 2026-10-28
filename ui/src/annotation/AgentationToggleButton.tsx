import { Icon } from '../components/icons/Icon';
import { appTip } from '../components/shared/AppHoverTips';
type AgentationToggleButtonProps = {
  visible: boolean;
  expandedRail: boolean;
  onToggle: () => void;
};

export function AgentationToggleButton({ visible, expandedRail, onToggle }: AgentationToggleButtonProps): JSX.Element {
  const label = `${visible ? 'Hide' : 'Show'} Agentation`;
  return (
    <button
      type="button"
      data-feedback-toolbar
      className="app-rail__item"
      aria-label={label}
      aria-pressed={visible}
      {...appTip(label, 'right')}
      onClick={onToggle}
    >
      <span className="app-rail__icon">
        <Icon name="annotate" size={18} />
      </span>
      {expandedRail ? <span className="app-rail__label">Agentation</span> : null}
    </button>
  );
}
