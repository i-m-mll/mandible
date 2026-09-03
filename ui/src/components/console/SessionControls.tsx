import type { JSX } from 'preact/jsx-runtime';
import { useEffect, useMemo, useState } from 'preact/hooks';
import {
  getConsoleSessionOptions,
  type SessionRunOptionState,
  type SessionRunOptionsSnapshot,
  type SessionRunOptionValue,
  updateConsoleSessionOptions,
} from '../../api';

type SessionControlsProps = {
  sessionId: string;
  runOptions?: SessionRunOptionsSnapshot | null;
  allowedTools?: string[] | null;
  availableTools?: string[];
  onModelSaved?: (model: string | undefined) => void;
  hideModel?: boolean;
  hiddenOptionIds?: readonly string[];
  /** Retained while callers migrate; descriptors, never this value, drive rendering. */
  backendType?: 'pty' | 'sdk' | 'acp';
  model?: string;
  modelOptions?: string[];
};

type SessionModelControlProps = Pick<SessionControlsProps, 'sessionId' | 'runOptions' | 'onModelSaved'> & {
  compact?: boolean;
};

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return 'Unable to save session options';
  return error.message;
}

function displayValue(value: SessionRunOptionValue): string {
  return value === null || Array.isArray(value) ? '' : String(value);
}

function useRunOptions(sessionId: string, supplied?: SessionRunOptionsSnapshot | null) {
  const [snapshot, setSnapshot] = useState<SessionRunOptionsSnapshot | null>(supplied ?? null);
  useEffect(() => { if (supplied) setSnapshot(supplied); }, [supplied]);
  useEffect(() => {
    if (supplied) return;
    let active = true;
    void getConsoleSessionOptions(sessionId).then((result) => {
      if (active) setSnapshot(result.runOptions);
    }).catch(() => { /* The inline error is shown when a mutation is attempted. */ });
    return () => { active = false; };
  }, [sessionId, supplied]);
  return [snapshot, setSnapshot] as const;
}

export function SessionModelControl({
  sessionId,
  runOptions,
  onModelSaved,
  compact = false,
}: SessionModelControlProps): JSX.Element | null {
  const [snapshot, setSnapshot] = useRunOptions(sessionId, runOptions);
  const model = snapshot?.options.find((option) => option.id === 'model');
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setDraft(displayValue(model?.currentValue ?? null)), [model?.currentValue]);
  if (!model || model.enforcement.status === 'unsupported') return null;
  const save = async (value: string) => {
    setSaving(true); setError(null);
    try {
      const result = await updateConsoleSessionOptions(sessionId, { runOptions: { model: value || null } }) as {
        runOptions?: SessionRunOptionsSnapshot;
      };
      if (result.runOptions) setSnapshot(result.runOptions);
      onModelSaved?.(value || undefined);
    } catch (nextError) { setError(errorMessage(nextError)); }
    finally { setSaving(false); }
  };
  return (
    <label className={compact ? 'session-controls__field session-controls__field--compact' : 'session-controls__field'}>
      <span className="session-controls__label">{model.label}</span>
      <select className={compact ? 'session-controls__select session-controls__select--compact' : 'session-controls__select'}
        value={draft} disabled={saving || model.availability !== 'available'} aria-label={model.label}
        onChange={(event) => { const value = event.currentTarget.value; setDraft(value); void save(value); }}>
        {model.nullable && <option value="">Default</option>}
        {(model.allowedValues ?? []).map((choice) => (
          <option key={String(choice.value)} value={String(choice.value)}>{choice.label}</option>
        ))}
      </select>
      {model.availability !== 'available' && <span className="session-controls__placeholder">{model.availability === 'awaiting_provider' ? 'Waiting for provider…' : 'Unavailable'}</span>}
      {error && <span className="session-controls__error">{error}</span>}
    </label>
  );
}

function OptionControl({ option, value, disabled, onChange }: {
  option: SessionRunOptionState;
  value: SessionRunOptionValue;
  disabled: boolean;
  onChange: (value: SessionRunOptionValue) => void;
}): JSX.Element {
  const common = { className: 'session-controls__input', disabled };
  if (option.kind === 'select') return (
    <select className="session-controls__select" value={displayValue(value)} disabled={disabled}
      aria-label={option.label} onChange={(event) => onChange(event.currentTarget.value || null)}>
      {option.nullable && <option value="">Default</option>}
      {(option.allowedValues ?? []).map((choice) => <option key={String(choice.value)} value={String(choice.value)}>{choice.label}</option>)}
    </select>
  );
  if (option.kind === 'boolean') return <input type="checkbox" checked={value === true} disabled={disabled}
    onChange={(event) => onChange(event.currentTarget.checked)} />;
  if (option.kind === 'multi_select') {
    const selected = new Set((Array.isArray(value) ? value : []).map(String));
    return (
      <select className="session-controls__select" multiple disabled={disabled}
        onChange={(event) => onChange(Array.from(event.currentTarget.selectedOptions).map((item) => item.value))}>
        {(option.allowedValues ?? []).map((choice) => (
          <option key={String(choice.value)} value={String(choice.value)} selected={selected.has(String(choice.value))}>{choice.label}</option>
        ))}
      </select>
    );
  }
  if (option.kind === 'text') return <textarea {...common} value={displayValue(value)} onInput={(event) => onChange(event.currentTarget.value || null)} />;
  return <input {...common} type="number" min={option.kind === 'integer' ? '1' : '0'} step={option.kind === 'integer' ? '1' : '0.01'}
    value={displayValue(value)} onInput={(event) => onChange(event.currentTarget.value ? Number(event.currentTarget.value) : null)} />;
}

export function SessionControls({
  sessionId, runOptions, allowedTools, availableTools = [], onModelSaved, hideModel = false,
  hiddenOptionIds = [],
}: SessionControlsProps): JSX.Element {
  const [snapshot, setSnapshot] = useRunOptions(sessionId, runOptions);
  const editable = useMemo(() => (snapshot?.options ?? []).filter((option) =>
    option.enforcement.status !== 'unsupported'
    && (!hideModel || option.id !== 'model')
    && !hiddenOptionIds.includes(option.id)),
  [hiddenOptionIds, hideModel, snapshot]);
  const [draft, setDraft] = useState<Record<string, SessionRunOptionValue>>({});
  const [draftAllowedTools, setDraftAllowedTools] = useState<string[]>(allowedTools ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setDraft(Object.fromEntries(editable.map((option) => [option.id, option.currentValue]))), [snapshot?.revision]);
  useEffect(() => setDraftAllowedTools(allowedTools ?? []), [allowedTools]);

  const save = async () => {
    setSaving(true); setError(null);
    try {
      const result = await updateConsoleSessionOptions(sessionId, { runOptions: draft, allowedTools: draftAllowedTools }) as {
        runOptions?: SessionRunOptionsSnapshot;
      };
      if (result.runOptions) setSnapshot(result.runOptions);
      const model = draft.model;
      if (typeof model === 'string') onModelSaved?.(model || undefined);
    } catch (nextError) { setError(errorMessage(nextError)); }
    finally { setSaving(false); }
  };
  return (
    <div className="session-controls">
      {editable.map((option) => (
        <label key={option.id} className="session-controls__field">
          <span className="session-controls__label">{option.label}</span>
          <OptionControl option={option} value={draft[option.id] ?? option.currentValue}
            disabled={saving || option.availability !== 'available' || option.enforcement.status === 'pending' || option.enforcement.status === 'indeterminate'}
            onChange={(value) => setDraft((current) => ({ ...current, [option.id]: value }))} />
          {option.description && <span className="session-controls__placeholder">{option.description}</span>}
          {option.availability !== 'available' && <span className="session-controls__placeholder">{option.availability === 'awaiting_provider' ? 'Waiting for provider…' : 'Unavailable'}</span>}
        </label>
      ))}
      {availableTools.length > 0 && <div className="session-controls__tools">
        <div className="session-controls__label">Allowed tools</div>
        <div className="session-controls__tool-grid">{availableTools.map((tool) => <label key={tool} className="session-controls__tool-toggle">
          <input type="checkbox" checked={draftAllowedTools.includes(tool)} onChange={() => setDraftAllowedTools((current) =>
            current.includes(tool) ? current.filter((entry) => entry !== tool) : [...current, tool].sort())} />
          <span>{tool}</span>
        </label>)}</div>
      </div>}
      {(editable.length > 0 || availableTools.length > 0) && <div className="session-controls__actions">
        <button type="button" className="session-controls__button" disabled={saving} onClick={() => { void save(); }}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>}
      {error && <div className="session-controls__error">{error}</div>}
    </div>
  );
}
