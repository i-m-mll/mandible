import type { JSX } from 'preact/jsx-runtime';
import { appColors } from '../../theme';

export function Composer({
  prompt,
  disabled,
  onPromptChange,
  onSubmit,
}: {
  prompt: string;
  disabled: boolean;
  onPromptChange: (value: string) => void;
  onSubmit: (event: JSX.TargetedEvent<HTMLFormElement, Event>) => void;
}): JSX.Element {
  return (
    <form
      onSubmit={onSubmit}
      style={{
        padding: '12px 16px',
        borderTop: '1px solid var(--border-subtle)',
        background: 'var(--bg-inset)',
        display: 'flex',
        gap: '12px',
        alignItems: 'center',
        flexShrink: 0,
      }}
    >
      <input
        type="text"
        value={prompt}
        onInput={(e) => onPromptChange(e.currentTarget.value)}
        placeholder="Send a message to the agent..."
        disabled={disabled}
        style={{
          flex: 1,
          background: 'var(--bg-page)',
          border: '1px solid var(--border-subtle)',
          borderRadius: '8px',
          padding: '10px 14px',
          color: 'var(--fg-default)',
          fontSize: '14px',
          fontFamily: 'var(--font-sans)',
          outline: 'none',
        }}
      />
      <button
        type="submit"
        disabled={!prompt.trim() || disabled}
        style={{
          padding: '8px 16px',
          borderRadius: '6px',
          background: prompt.trim() ? 'var(--accent-blue)' : 'var(--bg-muted)',
          color: appColors.fgInverse,
          border: 'none',
          cursor: prompt.trim() ? 'pointer' : 'default',
          fontSize: '14px',
          fontFamily: 'var(--font-sans)',
        }}
      >
        Send
      </button>
    </form>
  );
}
