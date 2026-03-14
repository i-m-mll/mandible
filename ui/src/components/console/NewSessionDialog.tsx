import type { JSX } from 'preact/jsx-runtime';
import { useEffect, useState } from 'preact/hooks';

type AgentKind = 'agent' | 'operator';
type Backend = 'claude' | 'codex' | 'gemini';

type NewSessionDialogProps = {
  open: boolean;
  onClose: () => void;
  onSubmit: (input: { label: string; backend: Backend; kind: AgentKind }) => void;
};

const KIND_OPTIONS: Array<{
  value: AgentKind;
  title: string;
  description: string;
}> = [
  {
    value: 'agent',
    title: 'Chat agent',
    description: 'Normal ongoing chat. Rich chat is the primary interface.',
  },
  {
    value: 'operator',
    title: 'Operator',
    description: 'Pinned Claude router that auto-starts and stays available across the app.',
  },
];

const BACKEND_OPTIONS: Array<{
  value: Backend;
  title: string;
  description: string;
  note?: string;
}> = [
  {
    value: 'claude',
    title: 'Claude Code',
    description: 'First-class chat with native Claude history.',
  },
  {
    value: 'codex',
    title: 'Codex',
    description: 'First-class chat backed by Codex exec JSON events and native Codex history.',
    note: 'Operator mode is not available for Codex yet.',
  },
  {
    value: 'gemini',
    title: 'Gemini',
    description: 'First-class chat backed by Gemini stream-json and native Gemini history.',
    note: 'Operator mode is not available for Gemini yet.',
  },
];

function OptionCard({
  title,
  description,
  selected,
  disabled = false,
  onClick,
  note,
}: {
  title: string;
  description: string;
  selected: boolean;
  disabled?: boolean;
  onClick: () => void;
  note?: string;
}): JSX.Element {
  return (
    <button
      type="button"
      className={`new-session-option${selected ? ' new-session-option--selected' : ''}${disabled ? ' new-session-option--disabled' : ''}`}
      onClick={onClick}
      disabled={disabled}
    >
      <span className="new-session-option__title">{title}</span>
      <span className="new-session-option__description">{description}</span>
      {note && <span className="new-session-option__note">{note}</span>}
    </button>
  );
}

export function NewSessionDialog({
  open,
  onClose,
  onSubmit,
}: NewSessionDialogProps): JSX.Element | null {
  const [label, setLabel] = useState('');
  const [kind, setKind] = useState<AgentKind>('agent');
  const [backend, setBackend] = useState<Backend>('claude');

  useEffect(() => {
    if (kind === 'operator' && backend !== 'claude') {
      setBackend('claude');
    }
  }, [backend, kind]);

  if (!open) return null;

  const handleSubmit = (e: Event) => {
    e.preventDefault();
    if (!label.trim()) return;
    onSubmit({ label: label.trim(), backend, kind });
    setLabel('');
    setKind('agent');
    setBackend('claude');
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
        <h3>New Agent Chat</h3>
        <p className="new-session-dialog__intro">
          Choose the chat role first, then the backend that will power it.
        </p>
        <form className="new-session-dialog__form" onSubmit={handleSubmit}>
          <div className="new-session-dialog__field">
            <label htmlFor="console-session-label" className="new-session-dialog__label">
              Name
            </label>
            <input
              id="console-session-label"
              type="text"
              value={label}
              onInput={(e) => setLabel((e.target as HTMLInputElement).value)}
              placeholder="e.g. Research thread, Operator"
              required
              autoFocus
              className="new-session-dialog__input"
            />
          </div>

          <div className="new-session-dialog__field">
            <div className="new-session-dialog__label">Kind</div>
            <div className="new-session-dialog__options">
              {KIND_OPTIONS.map((option) => (
                <OptionCard
                  key={option.value}
                  title={option.title}
                  description={option.description}
                  selected={kind === option.value}
                  onClick={() => setKind(option.value)}
                />
              ))}
            </div>
          </div>

          <div className="new-session-dialog__field">
            <div className="new-session-dialog__label">Backend</div>
            <div className="new-session-dialog__options">
              {BACKEND_OPTIONS.map((option) => {
                const disabled = kind === 'operator' && option.value !== 'claude';
                return (
                  <OptionCard
                    key={option.value}
                    title={option.title}
                    description={option.description}
                    note={disabled ? option.note : undefined}
                    selected={backend === option.value}
                    disabled={disabled}
                    onClick={() => setBackend(option.value)}
                  />
                );
              })}
            </div>
          </div>

          <div className="new-session-dialog__actions">
            <button type="button" onClick={onClose} className="new-session-dialog__button new-session-dialog__button--ghost">
              Cancel
            </button>
            <button type="submit" className="new-session-dialog__button new-session-dialog__button--primary">
              Create chat
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
