// Bug: b949700 — Console tab: view mode toggle (Terminal / Rich)
import type { JSX } from 'preact/jsx-runtime';

type ViewToggleProps = {
  current: 'terminal' | 'rich';
  onChange: (mode: 'terminal' | 'rich') => void;
};

export function ViewToggle({ current, onChange }: ViewToggleProps): JSX.Element {
  return (
    <div className="view-toggle">
      <button
        type="button"
        className={`view-toggle__btn${current === 'terminal' ? ' view-toggle__btn--active' : ''}`}
        onClick={() => onChange('terminal')}
      >
        Terminal
      </button>
      <button
        type="button"
        className={`view-toggle__btn${current === 'rich' ? ' view-toggle__btn--active' : ''}`}
        onClick={() => onChange('rich')}
      >
        Rich
      </button>
    </div>
  );
}
