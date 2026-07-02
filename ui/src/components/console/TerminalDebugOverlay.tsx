import type { JSX } from 'preact/jsx-runtime';
import { appColors } from '../../theme';

export function TerminalDebugOverlay({
  visible,
  message,
  buttonLabel,
  onClick,
}: {
  visible: boolean;
  message: string;
  buttonLabel: string;
  onClick: () => void;
}): JSX.Element | null {
  if (!visible) return null;
  return (
    <div className="terminal-pane__reconnect-overlay">
      <span>{message}</span>
      <button
        type="button"
        onClick={onClick}
        style={{
          padding: '8px 20px',
          borderRadius: '8px',
          background: 'var(--accent-blue)',
          border: 'none',
          color: appColors.fgInverse,
          cursor: 'pointer',
          fontSize: '14px',
          fontFamily: 'var(--font-sans)',
        }}
      >
        {buttonLabel}
      </button>
    </div>
  );
}
