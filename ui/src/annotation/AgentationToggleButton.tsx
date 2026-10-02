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
      title={label}
      onClick={onToggle}
    >
      <span className="app-rail__icon">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="7" />
          <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
        </svg>
      </span>
      {expandedRail ? <span className="app-rail__label">Agentation</span> : <span className="app-rail__tooltip">{label}</span>}
    </button>
  );
}
