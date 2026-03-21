// Bug: 11f4f47 — NewSessionDialog with preset selector for SDK sessions
// Bug: 8baedeb — session validation warnings for convention-setting links
import type { JSX } from 'preact/jsx-runtime';
import { useEffect, useState } from 'preact/hooks';
import type { Preset, SessionValidationWarning } from '../../api';
import { getPresets, getDefaultPresetIds, validatePresetIds } from '../../api';
import { PresetPillSelector } from '../presets/PresetPillSelector';

type AgentKind = 'agent' | 'operator';
type Backend = 'claude' | 'codex' | 'gemini';
type Transport = 'pty' | 'sdk' | 'spawn';

type NewSessionDialogProps = {
  open: boolean;
  onClose: () => void;
  onSubmit: (input: {
    label: string;
    backend: Backend;
    kind: AgentKind;
    backend_type: Transport;
    presetIds?: string[];
  }) => void;
  /** Pre-selected preset ID from navigation (e.g., "Start Chat" from Presets tab). */
  initialPresetId?: string | null;
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
  initialPresetId,
}: NewSessionDialogProps): JSX.Element | null {
  const [label, setLabel] = useState('');
  const [kind, setKind] = useState<AgentKind>('agent');
  const [backend, setBackend] = useState<Backend>('claude');
  const [transport, setTransport] = useState<Transport>('sdk');
  const [presetIds, setPresetIds] = useState<string[]>([]);
  const [allPresets, setAllPresets] = useState<Preset[]>([]);
  const [presetsLoaded, setPresetsLoaded] = useState(false);
  // Bug: 8baedeb — convention-setting validation warnings
  const [validationWarnings, setValidationWarnings] = useState<SessionValidationWarning[]>([]);

  // Load available presets and default selections when dialog opens
  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    const loadPresets = async () => {
      try {
        const [presets, defaults] = await Promise.all([
          getPresets(),
          getDefaultPresetIds(),
        ]);
        if (cancelled) return;
        setAllPresets(presets);

        // If an initial preset ID was passed (e.g., from "Start Chat" button),
        // use it; otherwise use defaults
        if (initialPresetId) {
          const ids = presets.some((p) => p.id === initialPresetId)
            ? [initialPresetId]
            : [];
          // Merge with defaults, initial first
          const merged = [...ids, ...defaults.filter((d) => !ids.includes(d))];
          setPresetIds(merged.filter((id) => presets.some((p) => p.id === id)));
        } else {
          setPresetIds(defaults.filter((id) => presets.some((p) => p.id === id)));
        }
        setPresetsLoaded(true);
      } catch {
        if (!cancelled) {
          setAllPresets([]);
          setPresetIds([]);
          setPresetsLoaded(true);
        }
      }
    };
    void loadPresets();
    return () => { cancelled = true; };
  }, [open, initialPresetId]);

  // Bug: 8baedeb — validate selected presets for unsatisfied setting requirements
  useEffect(() => {
    if (!presetsLoaded || presetIds.length === 0 || transport !== 'sdk') {
      setValidationWarnings([]);
      return;
    }
    let cancelled = false;
    void validatePresetIds(presetIds).then((result) => {
      if (!cancelled) {
        setValidationWarnings(result.warnings);
      }
    }).catch(() => {
      if (!cancelled) setValidationWarnings([]);
    });
    return () => { cancelled = true; };
  }, [presetIds, presetsLoaded, transport]);

  useEffect(() => {
    if (kind === 'operator' && backend !== 'claude') {
      setBackend('claude');
      setTransport('sdk');
    }
  }, [backend, kind]);

  useEffect(() => {
    // Bug: 8d3328c — Non-Claude backends use spawn (no terminal emulation)
    if (backend !== 'claude' && transport !== 'spawn') {
      setTransport('spawn');
    }
  }, [backend, transport]);

  if (!open) return null;

  const isSDK = transport === 'sdk';

  const handleSubmit = (e: Event) => {
    e.preventDefault();
    if (!label.trim()) return;
    onSubmit({
      label: label.trim(),
      backend,
      kind,
      backend_type: transport,
      presetIds: isSDK ? presetIds : undefined,
    });
    setLabel('');
    setKind('agent');
    setBackend('claude');
    setTransport('sdk');
    setPresetIds([]);
    setPresetsLoaded(false);
    setValidationWarnings([]);
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
                    onClick={() => {
                      setBackend(option.value);
                      setTransport(option.value === 'claude' ? 'sdk' : 'spawn');
                    }}
                  />
                );
              })}
            </div>
          </div>

          {backend === 'claude' && (
            <div className="new-session-dialog__field">
              <div className="new-session-dialog__label">Transport</div>
              <div className="new-session-dialog__options">
                <OptionCard
                  title="Claude SDK"
                  description="Structured events, Mandible permissions, and SDK-native session control."
                  selected={transport === 'sdk'}
                  onClick={() => setTransport('sdk')}
                />
                <OptionCard
                  title="PTY"
                  description="Classic terminal transport with a raw debug terminal fallback."
                  selected={transport === 'pty'}
                  onClick={() => setTransport('pty')}
                />
              </div>
            </div>
          )}

          {/* Bug: 11f4f47 — Preset selector shown only for SDK sessions */}
          {isSDK && presetsLoaded && (
            <div className="new-session-dialog__field">
              <div className="new-session-dialog__label">Presets</div>
              <PresetPillSelector
                selectedPresetIds={presetIds}
                onChange={setPresetIds}
                presets={allPresets}
              />
              {/* Bug: 8baedeb — validation warnings for unconfigured required settings */}
              {validationWarnings.length > 0 && (
                <div className="new-session-dialog__validation-warnings">
                  {validationWarnings.map((w, i) => (
                    <div key={i} className="new-session-dialog__validation-warning">
                      <span className="new-session-dialog__validation-warning-icon">{'\u26A0'}</span>
                      <span>
                        Convention "{w.conventionTitle}" requires setting "{w.settingKey}" to be configured.{' '}
                        <a
                          href="#/settings"
                          className="new-session-dialog__validation-warning-link"
                          onClick={(e) => {
                            e.preventDefault();
                            window.location.hash = '#/settings';
                          }}
                        >
                          Configure now {'\u2192'}
                        </a>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

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
