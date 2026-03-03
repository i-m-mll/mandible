// Bug: b949700 — Console tab: modal dialog to start a new PTY session
import type { JSX } from 'preact/jsx-runtime';
import { useState } from 'preact/hooks';

type NewSessionDialogProps = {
  open: boolean;
  onClose: () => void;
  onSubmit: (label: string, agentType: string) => void;
};

const AGENT_TYPE_OPTIONS = [
  { value: 'operator', label: 'Operator (Claude agent, auto-restart)' },
  { value: 'claude', label: 'Claude (Claude agent)' },
  { value: 'codex', label: 'Codex' },
  { value: 'shell', label: 'Shell (bash)' },
] as const;

export function NewSessionDialog({ open, onClose, onSubmit }: NewSessionDialogProps): JSX.Element | null {
  const [label, setLabel] = useState('');
  const [agentType, setAgentType] = useState<string>('shell');

  if (!open) return null;

  const handleSubmit = (e: Event) => {
    e.preventDefault();
    if (!label.trim()) return;
    onSubmit(label.trim(), agentType);
    setLabel('');
    setAgentType('shell');
    onClose();
  };

  const handleOverlayClick = (e: MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  return (
    <div className="new-session-dialog-overlay" onClick={handleOverlayClick}>
      <div className="new-session-dialog">
        <h3>New Console Session</h3>
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label
              htmlFor="console-session-label"
              style={{ fontSize: '13px', color: 'var(--text-muted)' }}
            >
              Name
            </label>
            <input
              id="console-session-label"
              type="text"
              value={label}
              onInput={(e) => setLabel((e.target as HTMLInputElement).value)}
              placeholder="e.g. Operator, My Shell"
              required
              autoFocus
              style={{
                background: 'var(--bg-secondary)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: '8px',
                padding: '8px 12px',
                color: 'var(--text-primary)',
                fontSize: '14px',
                fontFamily: 'var(--font-sans)',
                outline: 'none',
              }}
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label
              htmlFor="console-agent-type"
              style={{ fontSize: '13px', color: 'var(--text-muted)' }}
            >
              Agent Type
            </label>
            <select
              id="console-agent-type"
              value={agentType}
              onChange={(e) => setAgentType((e.target as HTMLSelectElement).value)}
              style={{
                background: 'var(--bg-secondary)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: '8px',
                padding: '8px 12px',
                color: 'var(--text-primary)',
                fontSize: '14px',
                fontFamily: 'var(--font-sans)',
                outline: 'none',
                cursor: 'pointer',
              }}
            >
              {AGENT_TYPE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
          <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '4px' }}>
            <button
              type="button"
              onClick={onClose}
              style={{
                padding: '8px 16px',
                borderRadius: '8px',
                background: 'transparent',
                border: '1px solid rgba(255,255,255,0.1)',
                color: 'var(--text-muted)',
                cursor: 'pointer',
                fontSize: '14px',
                fontFamily: 'var(--font-sans)',
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              style={{
                padding: '8px 16px',
                borderRadius: '8px',
                background: 'var(--accent-blue)',
                border: 'none',
                color: '#fff',
                cursor: 'pointer',
                fontSize: '14px',
                fontFamily: 'var(--font-sans)',
                fontWeight: 600,
              }}
            >
              Start
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
