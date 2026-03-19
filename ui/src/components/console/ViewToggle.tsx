// Bug: b949700 — Console tab: view mode toggle (Chat / Debug terminal)
import type { JSX } from 'preact/jsx-runtime';

type ViewToggleProps = {
  current: 'terminal' | 'rich';
  onChange: (mode: 'terminal' | 'rich') => void;
  showTerminal?: boolean;
};

export function ViewToggle({ current, onChange, showTerminal = true }: ViewToggleProps): JSX.Element | null {
  // Bug: 6634023 — When there is no debug terminal (SDK non-operator sessions),
  // "Chat" is the only button and it's always active. Hide the entire toggle.
  if (!showTerminal) {
    return null;
  }

  return (
    <div className="view-toggle">
      <button
        type="button"
        className={`view-toggle__btn${current === 'rich' ? ' view-toggle__btn--active' : ''}`}
        onClick={() => onChange('rich')}
      >
        Chat
      </button>
      <button
        type="button"
        className={`view-toggle__btn${current === 'terminal' ? ' view-toggle__btn--active' : ''}`}
        onClick={() => onChange('terminal')}
      >
        Debug Terminal
      </button>
    </div>
  );
}
