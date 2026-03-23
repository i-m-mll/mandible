// Bug: b949700 — Console tab: view mode toggle (Chat / Debug terminal)
// Bug: b5e1c51 — Channel-enabled PTY sessions show Terminal / Events tabs
import type { JSX } from 'preact/jsx-runtime';

type ViewToggleProps = {
  current: 'terminal' | 'rich' | 'events';
  onChange: (mode: 'terminal' | 'rich' | 'events') => void;
  showTerminal?: boolean;
  /** Whether this PTY session has channel integration (Terminal + Events tabs). */
  channelEnabled?: boolean;
  /** Number of unseen channel events (displayed as badge on Events tab). */
  unseenEventCount?: number;
};

export function ViewToggle({
  current,
  onChange,
  showTerminal = true,
  channelEnabled = false,
  unseenEventCount = 0,
}: ViewToggleProps): JSX.Element | null {
  // Bug: b5e1c51 — Channel-enabled PTY sessions: show Terminal | Events toggle
  if (channelEnabled && showTerminal) {
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
          className={`view-toggle__btn view-toggle__btn--events${current === 'events' ? ' view-toggle__btn--active' : ''}`}
          onClick={() => onChange('events')}
        >
          Events
          {unseenEventCount > 0 && (
            <span className="view-toggle__badge" />
          )}
        </button>
      </div>
    );
  }

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
