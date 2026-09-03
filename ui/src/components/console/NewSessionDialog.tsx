// Bug: b5e1c51 — PTY+Channel transport option for channel-connected sessions
import type { JSX } from 'preact/jsx-runtime';
import { createPortal } from 'preact/compat';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { SessionRunOptionsSnapshot, SessionRunOptionState, SessionRunOptionValue } from '../../api';
import {
  getConsoleRunOptions,
  getConsoleLanePolicy,
  getSettings,
} from '../../api';
import { DisclosureChevronIcon } from '../shared/DisclosureChevronIcon';

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

const DEFAULT_MODEL_SETTING_BY_BACKEND: Record<Backend, string> = {
  claude: 'conversations.default_model.claude',
  codex: 'conversations.default_model.codex',
  gemini: 'conversations.default_model.gemini',
};

const ADVANCED_RUN_OPTION_IDS = new Set([
  'max_turns',
  'max_cost_usd',
  'system_prompt',
  'setting_sources',
]);

type NewSessionDialogProps = {
  open: boolean;
  cwd?: string;
  portalTarget?: HTMLElement | null;
  onClose: () => void;
  onSubmit: (input: {
    label: string;
    backend: Backend;
    kind: AgentKind;
    backend_type: Transport;
    transport_lane: TransportLane;
    channel_enabled?: boolean;
    runOptions?: Record<string, SessionRunOptionValue>;
    cwd?: string;
  }) => Promise<void>;
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
  cwd,
  portalTarget,
  onClose,
  onSubmit,
}: NewSessionDialogProps): JSX.Element | null {
  const [label, setLabel] = useState('');
  const [kind, setKind] = useState<AgentKind>('agent');
  const [backend, setBackend] = useState<Backend>('claude');
  const [transportLane, setTransportLane] = useState<TransportLane>('sdk');
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null);
  // Issue 8aadf70 — daemon-reported gate for the local-only Claude PTY lanes.
  const [claudePtyLaneEnabled, setClaudePtyLaneEnabled] = useState(false);
  // Bug: 8baedeb — convention-setting validation warnings
  const [runOptions, setRunOptions] = useState<SessionRunOptionsSnapshot | null>(null);
  const [runOptionValues, setRunOptionValues] = useState<Record<string, SessionRunOptionValue>>({});
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [appSettings, setAppSettings] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const runOptionScopeRef = useRef<string | null>(null);

  useEffect(() => {
    if (open) setSubmitError(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    const backendType = backendTypeForLane(transportLane);
    const optionScope = `${backendType}:${backend}`;
    void getConsoleRunOptions(backendType, backend).then((snapshot) => {
      if (!active) return;
      setRunOptions(snapshot);
      setRunOptionValues((current) => {
        const sameScope = runOptionScopeRef.current === optionScope;
        runOptionScopeRef.current = optionScope;
        return Object.fromEntries(snapshot.options
          .filter((option) => option.enforcement.status !== 'unsupported')
          .map((option) => {
            const concreteDefault = option.id === 'permission_mode' ? 'default' : null;
            return [option.id, (sameScope ? current[option.id] : null) ?? option.currentValue ?? concreteDefault];
          })
          .filter(([, value]) => value !== null));
      });
    }).catch(() => { if (active) setRunOptions(null); });
    return () => { active = false; };
  }, [appSettings, backend, open, transportLane]);

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
      setAppSettings(settings);
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

  const transportOptions = availableTransportLanes(backend, hasApiKey, claudePtyLaneEnabled);

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    if (submitting) return;
    const backendType = backendTypeForLane(transportLane);
    const effectiveRunOptions = { ...runOptionValues };
    const configuredModel = appSettings[DEFAULT_MODEL_SETTING_BY_BACKEND[backend]]?.trim();
    if (configuredModel && effectiveRunOptions.model == null) effectiveRunOptions.model = configuredModel;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await onSubmit({
        label: label.trim() || 'New chat',
        backend,
        kind,
        backend_type: backendType,
        transport_lane: transportLane,
        channel_enabled: transportLane === 'channel' || undefined,
        runOptions: Object.keys(effectiveRunOptions).length > 0 ? effectiveRunOptions : undefined,
        cwd,
      });
      setLabel('');
      setKind('agent');
      setBackend('claude');
      setTransportLane(defaultTransportLaneForBackend('claude'));
      setRunOptions(null);
      setRunOptionValues({});
      runOptionScopeRef.current = null;
      setAdvancedOpen(false);
      onClose();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSubmitError(message === 'instance_mutation_forbidden'
        ? 'This preview cannot create chats. Open the main Mandible instance to start one.'
        : `Could not create chat: ${message}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleOverlayClick = (e: MouseEvent) => {
    if (e.target === e.currentTarget && !submitting) {
      onClose();
    }
  };

  const supportedRunOptions = (runOptions?.options ?? [])
    .filter((option) => option.enforcement.status !== 'unsupported')
    // Provider-discovered choices do not exist until the provider session is
    // initialized. Do not misrepresent an unconstrained text field as a model
    // selector; the real selector appears in the running session once the
    // provider advertises its inventory.
    .filter((option) => option.kind !== 'select' || (option.allowedValues?.length ?? 0) > 0);
  const basicRunOptions = supportedRunOptions.filter((option) => !ADVANCED_RUN_OPTION_IDS.has(option.id));
  const advancedRunOptions = supportedRunOptions.filter((option) => ADVANCED_RUN_OPTION_IDS.has(option.id));

  const renderRunOption = (option: SessionRunOptionState): JSX.Element => (
    <label key={option.id} className="new-session-dialog__run-option">
      <span className="new-session-dialog__run-option-label">{option.label}</span>
      {option.kind === 'select' && (option.allowedValues?.length ?? 0) > 0 ? (
        <select className="new-session-dialog__input" value={String(runOptionValues[option.id] ?? '')}
          onChange={(event) => setRunOptionValues((current) => ({ ...current, [option.id]: event.currentTarget.value || null }))}>
          {option.nullable && (
            <option value="">
              {option.id === 'model'
                ? `Use app default (${appSettings[DEFAULT_MODEL_SETTING_BY_BACKEND[backend]]?.trim() || 'provider default'})`
                : 'Use app default'}
            </option>
          )}
          {option.id === 'model' && appSettings[DEFAULT_MODEL_SETTING_BY_BACKEND[backend]]?.trim()
            && !(option.allowedValues ?? []).some((choice) => String(choice.value) === appSettings[DEFAULT_MODEL_SETTING_BY_BACKEND[backend]]?.trim())
            ? <option value={appSettings[DEFAULT_MODEL_SETTING_BY_BACKEND[backend]].trim()}>{appSettings[DEFAULT_MODEL_SETTING_BY_BACKEND[backend]].trim()}</option>
            : null}
          {(option.allowedValues ?? []).map((choice) => <option key={String(choice.value)} value={String(choice.value)}>{choice.label}</option>)}
        </select>
      ) : option.kind === 'multi_select' && (option.allowedValues?.length ?? 0) > 0 ? (
        <span className="new-session-dialog__multi-select">
          {(option.allowedValues ?? []).map((choice) => {
            const selectedValues = runOptionValues[option.id];
            const selected = Array.isArray(selectedValues) && selectedValues.includes(String(choice.value));
            return (
              <label key={String(choice.value)} className="new-session-dialog__multi-select-option">
                <input type="checkbox" checked={selected} onChange={(event) => {
                  const value = String(choice.value);
                  const checked = event.currentTarget.checked;
                  setRunOptionValues((current) => {
                    const currentValue = current[option.id];
                    const existing = Array.isArray(currentValue) ? currentValue : [];
                    const next = checked
                      ? [...existing, value]
                      : existing.filter((item) => item !== value);
                    return next.length > 0
                      ? { ...current, [option.id]: next }
                      : Object.fromEntries(Object.entries(current).filter(([id]) => id !== option.id));
                  });
                }} />
                <span>{choice.label}</span>
              </label>
            );
          })}
        </span>
      ) : option.kind === 'boolean' ? (
        <input type="checkbox" checked={runOptionValues[option.id] === true}
          onChange={(event) => setRunOptionValues((current) => ({ ...current, [option.id]: event.currentTarget.checked }))} />
      ) : (
        <input className="new-session-dialog__input"
          type={option.kind === 'integer' || option.kind === 'number' ? 'number' : 'text'}
          min={option.kind === 'integer' ? '1' : option.kind === 'number' ? '0' : undefined}
          placeholder="Optional"
          value={String(runOptionValues[option.id] ?? '')}
          onInput={(event) => {
            const raw = event.currentTarget.value;
            const value = option.kind === 'integer' || option.kind === 'number' ? (raw ? Number(raw) : null) : (raw || null);
            setRunOptionValues((current) => raw ? { ...current, [option.id]: value } : Object.fromEntries(Object.entries(current).filter(([id]) => id !== option.id)));
          }} />
      )}
      {option.description && <span className="new-session-dialog__option-note">{option.description}</span>}
    </label>
  );

  const dialog = (
    <div className="new-session-dialog-overlay" onClick={handleOverlayClick}>
      <div className="new-session-dialog" role="dialog" aria-modal="true" aria-labelledby="new-session-dialog-title">
        <h3 id="new-session-dialog-title">New Agent Chat</h3>
        <p className="new-session-dialog__intro">
          Choose a provider and chat role, then adjust any run options.
        </p>
        <form className="new-session-dialog__form" onSubmit={handleSubmit}>
          <div className="new-session-dialog__content">
          <div className="new-session-dialog__field">
            <div className="new-session-dialog__section-title">Provider</div>
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
            <div className="new-session-dialog__section-title">Chat role</div>
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
            <label htmlFor="console-session-label" className="new-session-dialog__label">
              Name <span className="new-session-dialog__optional">Optional</span>
            </label>
            <input
              id="console-session-label"
              type="text"
              aria-label="Name"
              value={label}
              onInput={(e) => setLabel((e.target as HTMLInputElement).value)}
              placeholder="New chat"
              className="new-session-dialog__input"
            />
          </div>

          {supportedRunOptions.length > 0 && (
            <div className="new-session-dialog__field">
              <div className="new-session-dialog__section-title">Run options</div>
              {basicRunOptions.length > 0 && (
                <div className="new-session-dialog__run-options">
                  {basicRunOptions.map(renderRunOption)}
                </div>
              )}
              {advancedRunOptions.length > 0 && (
                <div className="new-session-dialog__advanced">
                  <button
                    type="button"
                    className="new-session-dialog__advanced-toggle"
                    aria-expanded={advancedOpen}
                    onClick={() => setAdvancedOpen((value) => !value)}
                  >
                    <span>Advanced</span>
                    <DisclosureChevronIcon expanded={advancedOpen} size={13} />
                  </button>
                  {advancedOpen && (
                    <div className="new-session-dialog__run-options">
                      {advancedRunOptions.map(renderRunOption)}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {transportOptions.length > 1 && (
            <div className="new-session-dialog__field">
              <div className="new-session-dialog__section-title">Connection</div>
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
          )}
          </div>

          {submitError ? <div className="new-session-dialog__error" role="alert">{submitError}</div> : null}
          <div className="new-session-dialog__actions">
            <button type="button" onClick={onClose} disabled={submitting} className="new-session-dialog__button new-session-dialog__button--ghost">
              Cancel
            </button>
            <button type="submit" disabled={submitting} className="new-session-dialog__button new-session-dialog__button--primary">
              {submitting ? 'Creating…' : 'Create chat'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
  return createPortal(dialog, portalTarget ?? document.body);
}
