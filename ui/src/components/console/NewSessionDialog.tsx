// Bug: 11f4f47 — NewSessionDialog with preset selector for SDK sessions
// Bug: 8baedeb — session validation warnings for convention-setting links
// Bug: b5e1c51 — PTY+Channel transport option for channel-connected sessions
import type { JSX } from 'preact/jsx-runtime';
import { useEffect, useState } from 'preact/hooks';
import type { Preset, SessionValidationWarning } from '../../api';
import {
  getConsoleLanePolicy,
  getPresets,
  getDefaultPresetIds,
  getSettings,
  validatePresetIds,
} from '../../api';
import { PresetPillSelector } from '../presets/PresetPillSelector';

type AgentKind = 'agent' | 'operator';
type Backend = 'claude' | 'codex' | 'gemini';
type Transport = 'pty' | 'sdk' | 'spawn' | 'acp';
type TransportLane = 'sdk' | 'pty' | 'channel' | 'acp';
type TransportLaneOption = {
  value: TransportLane;
  title: string;
  description: string;
  note: string;
};

type NewSessionDialogProps = {
  open: boolean;
  onClose: () => void;
  onSubmit: (input: {
    label: string;
    backend: Backend;
    kind: AgentKind;
    backend_type: Transport;
    transport_lane: TransportLane;
    channel_enabled?: boolean;
    presetIds?: string[];
  }) => void;
  /** Pre-selected instruction artifact or legacy preset ID from navigation. */
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
    description: 'First-class chat backed by the Codex ACP adapter and native Codex history.',
    note: 'Operator mode is not available for Codex yet.',
  },
  {
    value: 'gemini',
    title: 'Gemini',
    description: 'First-class chat backed by Gemini ACP live events.',
    note: 'Operator mode is not available for Gemini yet.',
  },
];

// Issue 8aadf70 — Claude's default lane is the Agent SDK, the documented
// embedding surface. Claude PTY/Channel drive the interactive CLI terminal and
// are local-only developer lanes, hidden unless the daemon reports them
// enabled.
function defaultTransportLaneForBackend(backend: Backend): TransportLane {
  if (backend === 'claude') return 'sdk';
  if (backend === 'gemini' || backend === 'codex') return 'acp';
  return 'pty';
}

function backendTypeForLane(lane: TransportLane): Transport {
  if (lane === 'channel') return 'pty';
  return lane;
}

function availableTransportLanes(
  backend: Backend,
  hasApiKey: boolean | null = null,
  claudePtyLaneEnabled = false,
): TransportLaneOption[] {
  if (backend === 'claude') {
    const lanes: TransportLaneOption[] = [
      {
        value: 'sdk',
        title: 'Claude SDK',
        description: 'Structured SDK session with Mandible-native control and permissions.',
        note: hasApiKey
          ? 'ANTHROPIC_API_KEY is set: this session bills to the Anthropic API.'
          : 'Uses your local Claude Code credentials and their subscription limits.',
      },
    ];
    // Issue 8aadf70 — the terminal-driving Claude lanes are only offered when
    // the daemon reports them enabled; otherwise creating one is rejected
    // server-side, so showing the option would be a dead end.
    if (claudePtyLaneEnabled) {
      lanes.push(
        {
          value: 'pty',
          title: 'Claude PTY (local only)',
          description: 'Runs your local Claude Code CLI in a Mandible-owned terminal.',
          note: 'Developer lane, not part of a released build. Uses Claude subscription interactive limits.',
        },
        {
          value: 'channel',
          title: 'Claude Channel (local only)',
          description: 'Runs Claude Code in a PTY with Mandible channel integration enabled.',
          note: 'Developer lane, not part of a released build. Uses Claude subscription interactive limits.',
        },
      );
    }
    return lanes;
  }
  const provider = backend === 'codex' ? 'Codex' : 'Gemini';
  return [
    {
      value: 'acp',
      title: `${provider} ACP`,
      description: `Structured ${provider} live session through Agent Client Protocol.`,
      note: backend === 'codex' ? 'Uses your ChatGPT plan.' : 'Uses your Gemini plan.',
    },
    {
      value: 'pty',
      title: `${provider} PTY`,
      description: `Runs the local ${backend} CLI in a Mandible-owned terminal.`,
      note: 'Terminal fallback for CLI workflows.',
    },
  ];
}

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
  const [transportLane, setTransportLane] = useState<TransportLane>('sdk');
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null);
  // Issue 8aadf70 — daemon-reported gate for the local-only Claude PTY lanes.
  const [claudePtyLaneEnabled, setClaudePtyLaneEnabled] = useState(false);
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
        const resolvePresetId = (id: string): string | null => {
          const match = presets.find((p) => p.id === id || p.legacy_preset_id === id);
          return match?.id ?? null;
        };

        // If an initial preset ID was passed (e.g., from "Start Chat" button),
        // use it; otherwise use defaults
        if (initialPresetId) {
          const initialId = resolvePresetId(initialPresetId);
          const ids = initialId
            ? [initialId]
            : [];
          // Merge with defaults, initial first
          const defaultIds = defaults
            .map(resolvePresetId)
            .filter((id): id is string => Boolean(id));
          const merged = [...ids, ...defaultIds.filter((d) => !ids.includes(d))];
          setPresetIds(merged.filter((id) => presets.some((p) => p.id === id)));
        } else {
          setPresetIds(defaults
            .map(resolvePresetId)
            .filter((id): id is string => Boolean(id)));
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

  // Bug: b5e1c51 — Check if API key is configured to determine default transport
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void getSettings().then((settings) => {
      if (cancelled) return;
      const apiKeyConfigured = Boolean(
        settings.anthropic_api_key || settings.ANTHROPIC_API_KEY,
      );
      setHasApiKey(apiKeyConfigured);
    }).catch(() => {
      if (!cancelled) setHasApiKey(null);
    });
    return () => { cancelled = true; };
  }, [open]);

  // Issue 8aadf70 — ask the daemon which Claude lanes it ships before offering them.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void getConsoleLanePolicy().then((policy) => {
      if (!cancelled) setClaudePtyLaneEnabled(policy.claude_pty_lane_enabled);
    }).catch(() => {
      if (!cancelled) setClaudePtyLaneEnabled(false);
    });
    return () => { cancelled = true; };
  }, [open]);

  // Bug: 8baedeb — validate selected presets for unsatisfied setting requirements
  useEffect(() => {
    if (!presetsLoaded || presetIds.length === 0 || backend !== 'claude') {
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
  }, [presetIds, presetsLoaded, backend]);

  useEffect(() => {
    if (kind === 'operator' && backend !== 'claude') {
      setBackend('claude');
      setTransportLane(defaultTransportLaneForBackend('claude'));
    }
  }, [backend, kind]);

  useEffect(() => {
    const allowed = availableTransportLanes(backend, hasApiKey, claudePtyLaneEnabled)
      .some((option) => option.value === transportLane);
    if (!allowed) {
      setTransportLane(defaultTransportLaneForBackend(backend));
    }
  }, [backend, claudePtyLaneEnabled, hasApiKey, transportLane]);

  if (!open) return null;

  const isSDK = transportLane === 'sdk';
  // Issue 2181ffd — instruction artifacts are supported for both SDK and PTY Claude sessions.
  const supportsPresets = backend === 'claude';
  const transportOptions = availableTransportLanes(backend, hasApiKey, claudePtyLaneEnabled);

  const handleSubmit = (e: Event) => {
    e.preventDefault();
    if (!label.trim()) return;
    const backendType = backendTypeForLane(transportLane);
    onSubmit({
      label: label.trim(),
      backend,
      kind,
      backend_type: backendType,
      transport_lane: transportLane,
      channel_enabled: transportLane === 'channel' || undefined,
      presetIds: supportsPresets ? presetIds : undefined,
    });
    setLabel('');
    setKind('agent');
    setBackend('claude');
    setTransportLane(defaultTransportLaneForBackend('claude'));
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
                      setTransportLane(defaultTransportLaneForBackend(option.value));
                    }}
                  />
                );
              })}
            </div>
          </div>

          <div className="new-session-dialog__field">
            <div className="new-session-dialog__label">Transport lane</div>
            <div className="new-session-dialog__options">
              {transportOptions.map((option) => (
                <OptionCard
                  key={option.value}
                  title={option.title}
                  description={option.description}
                  note={option.note}
                  selected={transportLane === option.value}
                  onClick={() => setTransportLane(option.value)}
                />
              ))}
            </div>
          </div>

          {/* Issue 2181ffd — instruction artifact selector shown for all Claude sessions (SDK + PTY) */}
          {supportsPresets && presetsLoaded && (
            <div className="new-session-dialog__field">
              <div className="new-session-dialog__label">Instructions</div>
              <PresetPillSelector
                selectedPresetIds={presetIds}
                onChange={setPresetIds}
                presets={allPresets}
              />
              {/* Bug: 790433d — Mode-specific note about preset mutability */}
              {!isSDK && (
                <div className="new-session-dialog__preset-note">
                  Instructions will be applied at session start. Restart session to change.
                </div>
              )}
              {isSDK && (
                <div className="new-session-dialog__preset-note new-session-dialog__preset-note--muted">
                  Instructions can be changed mid-conversation.
                </div>
              )}
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
