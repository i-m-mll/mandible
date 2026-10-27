import { Icon } from '../components/icons/Icon';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ConversationControlSnapshot, ConversationRuntimeOptions } from '../api';
import type { ManagedPermissionRequest, ConversationRunOption, RuntimeSettingsApplication } from '../../../src/conversation-control/types';
import { ChoiceDropdown } from '../components/shared/ChoiceDropdown';
import { conversationExecutionState } from './conversationControl';
import { browserSessionFetch } from '../client-auth-token';

type Permission = ManagedPermissionRequest;
type Settings = { application?: RuntimeSettingsApplication; revision: number; runtime_options: ConversationRuntimeOptions; usage: { generation: number; snapshot: Record<string, unknown> }[] };
async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await browserSessionFetch(path, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.message ?? result.error?.message ?? result.error?.kind ?? result.error ?? 'Conversation action failed');
  return result.value as T;
}

function usageFields(snapshot: Record<string, unknown>): [string, number][] {
  const usage = snapshot.usage as Record<string, unknown> | undefined;
  const tokens = usage?.total as Record<string, unknown> | undefined ?? usage;
  const entries: [string, unknown][] = [
    ['Input tokens', tokens?.inputTokens ?? tokens?.input_tokens],
    ['Output tokens', tokens?.outputTokens ?? tokens?.output_tokens],
    ['Cached input tokens', tokens?.cachedInputTokens ?? tokens?.cache_read_input_tokens],
    ['Cost (USD)', snapshot.total_cost_usd],
    ['Duration (seconds)', typeof snapshot.duration_ms === 'number' ? snapshot.duration_ms / 1000 : undefined],
  ];
  return entries.filter((entry): entry is [string, number] => typeof entry[1] === 'number');
}

export function useManagedConversationControlState(control: ConversationControlSnapshot | null) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<ConversationRuntimeOptions>({});
  const [options, setOptions] = useState<ConversationRunOption[]>([]);
  const [interruptPending, setInterruptPending] = useState<{ generation: number; turnId: string | null } | null>(null);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const permissionScope = useRef<number | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dirtyRef = useRef(false);
  const settingsReadEpoch = useRef(0);
  const settingsRef = useRef<Settings | null>(null);
  const draftRef = useRef<ConversationRuntimeOptions>({});
  const pendingEdits = useRef<ConversationRuntimeOptions>({});
  const savingScope = useRef<number | null>(null);
  const savingPromise = useRef<Promise<void> | null>(null);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const id = control?.conversation_id;
  const controllerGeneration = control?.ownership.generation;
  const scopeRef = useRef({ id, controllerGeneration, generation: 0 });
  if (scopeRef.current.id !== id || scopeRef.current.controllerGeneration !== controllerGeneration) scopeRef.current = { id, controllerGeneration, generation: scopeRef.current.generation + 1 };
  const generation = scopeRef.current.generation;
  const settingsScope = useRef({ id, epoch: 0 });
  if (settingsScope.current.id !== id) settingsScope.current = { id, epoch: settingsScope.current.epoch + 1 };
  const settingsEpoch = settingsScope.current.epoch;
  const settingsCurrent = () => settingsScope.current.epoch === settingsEpoch;
  const current = () => scopeRef.current.generation === generation;
  const path = `/api/conversations/${encodeURIComponent(id ?? '')}/control`;
  useEffect(() => {
    dirtyRef.current = false; settingsRef.current = null; draftRef.current = {}; pendingEdits.current = {}; savingScope.current = null; setSettingsSaving(false); setSettingsError(null);
    busyRef.current = false; setBusy(false);
    setInterruptPending(null); setOptions([]); setSettings(null); setDraft({}); setPermissions([]); setError(null);
  }, [id]);
  useEffect(() => {
    if (!id) return;
    let active = true;
    const readEpoch = settingsReadEpoch.current;
    void request<Settings>(`${path}/settings`).then(value => {
      if (!active || settingsReadEpoch.current !== readEpoch) return;
      if (settingsRef.current && value.revision < settingsRef.current.revision) return;
      settingsRef.current = value; setSettings(value);
      if (!dirtyRef.current) { draftRef.current = value.runtime_options; setDraft(value.runtime_options); }
    }).catch(cause => { if (active) setError(String(cause)); });
    void request<Permission[]>(`${path}/permissions`).then(value => { if (active) { permissionScope.current = controllerGeneration; setPermissions(value); } })
      .catch(cause => { if (active) setError(String(cause)); });
    return () => { active = false; };
  }, [id, control?.revision, control?.ownership.generation]);
  useEffect(() => {
    if (!id) return;
    let active = true;
    void request<ConversationRunOption[]>(`${path}/options`).then(value => { if (active) setOptions(value); })
      .catch(cause => { if (active) setError(String(cause)); });
    return () => { active = false; };
  }, [id, control?.ownership.generation, control?.ownership.kind, control?.controller.kind === 'starting']);
  useEffect(() => { busyRef.current = false; setBusy(false); }, [id, controllerGeneration]);
  const execution = conversationExecutionState(control);
  useEffect(() => {
    if (interruptPending && (interruptPending.generation !== execution.generation || execution.phase === 'terminal' || interruptPending.turnId !== execution.activeTurnId)) setInterruptPending(null);
  }, [execution.generation, execution.phase, execution.activeTurnId, interruptPending]);
  const saveEdits = async () => {
    if (!id || !settingsRef.current || savingScope.current === settingsEpoch) return;
    savingScope.current = settingsEpoch; setSettingsSaving(true); setSettingsError(null);
    try {
      while (settingsCurrent() && Object.keys(pendingEdits.current).length) {
        const patch = { ...pendingEdits.current }; pendingEdits.current = {};
        try {
          let saved: Settings;
          try { saved = await request<Settings>(`${path}/settings`, 'PATCH', { expected_revision: settingsRef.current!.revision, runtime_options: patch }); }
          catch (cause) {
            // Revision conflicts reconcile the canonical desired settings before
            // retrying only the user's edited fields, never an old whole draft.
            if (!(cause instanceof Error) || cause.message !== 'capability-drift') throw cause;
            const latest = await request<Settings>(`${path}/settings`);
            if (!settingsCurrent()) return;
            settingsRef.current = latest;
            saved = await request<Settings>(`${path}/settings`, 'PATCH', { expected_revision: latest.revision, runtime_options: patch });
          }
          if (!settingsCurrent()) return;
          if (saved.revision >= settingsRef.current!.revision) {
            settingsReadEpoch.current++;
            settingsRef.current = { ...settingsRef.current!, ...saved }; setSettings(settingsRef.current);
          }
          draftRef.current = { ...settingsRef.current!.runtime_options, ...pendingEdits.current };
          setDraft(draftRef.current);
        } catch (cause) {
          if (!settingsCurrent()) return;
          pendingEdits.current = { ...patch, ...pendingEdits.current };
          setSettingsError(cause instanceof Error ? cause.message : String(cause));
          return;
        }
      }
      if (settingsCurrent()) dirtyRef.current = false;
    } finally {
      if (settingsCurrent()) { savingScope.current = null; setSettingsSaving(false); }
    }
  };
  const startSave = () => {
    if (savingScope.current === settingsEpoch) return savingPromise.current ?? Promise.resolve();
    const promise = saveEdits(); savingPromise.current = promise; return promise;
  };
  const flushSettings = async () => {
    await startSave();
    // With no local edits, the server can use its canonical settings even if
    // the initial settings read has not arrived yet.
    return settingsCurrent() && !dirtyRef.current
      && !Object.values(settingsRef.current?.application?.fields ?? {}).some(field => field.state === 'error');
  };
  const edit = <K extends keyof ConversationRuntimeOptions>(key: K, value: ConversationRuntimeOptions[K]) => {
    draftRef.current = { ...draftRef.current, [key]: value };
    pendingEdits.current = { ...pendingEdits.current, [key]: value };
    setDraft(draftRef.current); dirtyRef.current = true; settingsReadEpoch.current++;
    void startSave();
  };
  const perform = async (action: () => Promise<unknown>) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(null);
    try { await action(); return true; } catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (current()) { busyRef.current = false; setBusy(false); } }
  };
  const interrupt = () => void perform(async () => {
    if (!control || !execution.canInterrupt || interruptPending) return;
    setInterruptPending({ generation: control.ownership.generation, turnId: execution.activeTurnId });
    try { await request(`${path}/interrupt`, 'POST', { generation: control.ownership.generation, turn_id: execution.activeTurnId }); }
    catch (cause) { if (current()) setInterruptPending(null); throw cause; }
  });
  const settingsProblems = settings?.application ? Object.entries(settings.application.fields)
    .filter(([, field]) => field.state === 'error').map(([key, field]) => `${key === 'permission_mode' ? 'Permissions' : key === 'effort' ? 'Effort' : 'Model'}: ${field.error}`) : [];
  const retrySettings = () => {
    if (dirtyRef.current) { void startSave(); return; }
    void perform(async () => {
      const value = await request<Settings>(`${path}/settings`, 'PATCH', { expected_revision: settingsRef.current!.revision, runtime_options: {} });
      if (current()) { settingsReadEpoch.current++; settingsRef.current = value; setSettings(value); }
    });
  };
  return { options, execution, interrupt, interruptPending: Boolean(interruptPending), control, settings, draft, settingsSaving, settingsError, settingsProblems, flushSettings, retrySettings, permissions: permissionScope.current === controllerGeneration ? permissions : [], error, busy, path, edit, perform,
    setPermissions: (value: Parameters<typeof setPermissions>[0]) => { if (current()) setPermissions(value); },
    setSettings: (value: Parameters<typeof setSettings>[0]) => { if (current()) setSettings(previous => {
      const next = typeof value === 'function' ? value(previous) : value;
      settingsReadEpoch.current++; settingsRef.current = next; return next;
    }); } };
}

export function ManagedConversationControls({ control }: { control: ConversationControlSnapshot | null }) {
  return <ManagedConversationControlFields state={useManagedConversationControlState(control)} />;
}

export function ManagedConversationControlFields({ state, compact = false, includeActions = true }: { state: ReturnType<typeof useManagedConversationControlState>; compact?: boolean; includeActions?: boolean }) {
  const { control, settings, draft, busy, edit } = state;
  if (!control || !['claude_code', 'codex'].includes(control.provider)) return null;
  const claude = control.provider === 'claude_code';
  const coreFields = <>{state.options.map(option => {
    const value = draft[option.id] ?? '';
    const known = option.choices.some(choice => choice.value === value);
    return <ChoiceDropdown key={option.id} label={option.label}
      prompt={option.id === 'model' ? 'Select model' : option.id === 'effort' ? 'Select effort' : 'Select permissions'}
      value={value} disabled={busy || !settings || !known}
      hint={settings?.application?.fields[option.id]?.timing === 'next-turn' ? 'Applies on the next message'
        : option.id === 'permission_mode' ? 'Applies to subsequent permission checks; pending requests still need a decision' : 'Applies to subsequent provider responses'}
      choices={option.choices.filter(choice => !choice.retained || choice.value === value)}
      onChange={value => edit(option.id, value)} />;
  })}</>;
  if (compact) return coreFields;
  return <div className="session-controls">
    {includeActions && <ManagedConversationControlActions state={state} />}
    <section aria-label="Conversation settings">
      {coreFields}
      {claude && <>
        <label className="session-controls__field">Additional instructions<textarea disabled={busy} value={draft.system_prompt ?? ''} onInput={event => edit('system_prompt', event.currentTarget.value || undefined)} /></label>
        <label className="session-controls__field">Allowed tools<input disabled={busy} value={draft.allowed_tools?.join(', ') ?? ''} placeholder="Ask for each tool" onInput={event => edit('allowed_tools', event.currentTarget.value.split(',').map(value => value.trim()).filter(Boolean))} /></label>
        <label className="session-controls__field">Maximum turns<input disabled={busy} type="number" min="1" value={draft.max_turns ?? ''} onInput={event => edit('max_turns', event.currentTarget.value ? Number(event.currentTarget.value) : undefined)} /></label>
        <label className="session-controls__field">Maximum cost (USD)<input disabled={busy} type="number" min="0.01" step="0.01" value={draft.max_cost_usd ?? ''} onInput={event => edit('max_cost_usd', event.currentTarget.value ? Number(event.currentTarget.value) : undefined)} /></label>
        <fieldset><legend>Load provider settings from</legend>{(['user', 'project', 'local'] as const).map(source => <label><input disabled={busy} type="checkbox" checked={(draft.setting_sources ?? ['user', 'project', 'local']).includes(source)} onChange={event => {
          const sources = new Set<'user' | 'project' | 'local'>(draft.setting_sources ?? ['user', 'project', 'local']); if (event.currentTarget.checked) sources.add(source); else sources.delete(source); edit('setting_sources', [...sources]);
        }} />{source}</label>)}</fieldset>
      </>}
    </section>
    {settings?.usage.length ? <details><summary>Provider usage</summary>{settings.usage.map(usage => <dl key={usage.generation}>{usageFields(usage.snapshot).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value.toLocaleString()}</dd></div>)}</dl>)}</details> : null}
  </div>;
}

function QuestionRequest({ permission, busy, onAnswer }: {
  permission: Permission; busy: boolean; onAnswer: (answers: Record<string, string[]>) => void;
}) {
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const complete = permission.questions!.every(question => answers[question.id]?.length || other[question.id]?.trim());
  return <section className="composer-request" aria-label="Question request">
    {permission.questions!.map(question => <fieldset key={question.id} disabled={busy}>
      <legend>{question.question}</legend>
      <div className="composer-request__choices">{question.options.map(option => <label key={option.label} className="composer-request__choice">
        <input type={question.multi_select ? 'checkbox' : 'radio'} name={`${permission.id}:${question.id}`} checked={answers[question.id]?.includes(option.label) ?? false}
          onInput={event => {
            setOther(current => ({ ...current, [question.id]: '' }));
            setAnswers(current => ({ ...current, [question.id]: question.multi_select
              ? event.currentTarget.checked ? [...(current[question.id] ?? []), option.label] : (current[question.id] ?? []).filter(value => value !== option.label)
              : [option.label] }));
          }} />
        <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
      </label>)}</div>
      {question.allow_other && <input type={question.secret ? 'password' : 'text'} aria-label={`Other answer: ${question.title}`} placeholder="Your answer" value={other[question.id] ?? ''}
        onInput={event => { setOther(current => ({ ...current, [question.id]: event.currentTarget.value })); setAnswers(current => ({ ...current, [question.id]: [] })); }} />}
    </fieldset>)}
    <button type="button" className="btn btn--sm" disabled={busy || !complete} onClick={() => onAnswer(Object.fromEntries(permission.questions!.map(question => [question.id, other[question.id]?.trim() ? [other[question.id].trim()] : answers[question.id]])))}>Submit answers</button>
  </section>;
}

export function ManagedConversationControlActions({ state }: { state: ReturnType<typeof useManagedConversationControlState> }) {
  const { control, error, permissions, busy, path, perform, setPermissions } = state;
  const settingsError = state.settingsError ?? (state.settingsProblems.length ? `Saved; ${state.settingsProblems.join('; ')}` : null);
  if (!control || (!error && !settingsError && !permissions.length)) return null;
  const respond = (permission: Permission, decision: 'allow' | 'deny' | 'answer', answers?: Record<string, string[]>) => void perform(async () => {
    await request(`${path}/permission/${encodeURIComponent(permission.id)}`, 'POST', { generation: control.ownership.generation, decision, ...(answers ? { answers } : {}) });
    setPermissions(current => current.filter(item => item.id !== permission.id));
  });
  return <div className="composer-request-shelf" aria-label="Pending requests">
    {error && <p className="composer-request-shelf__error" role="alert">{error}</p>}
    {settingsError && <section className="composer-request"><p className="composer-request-shelf__error" role="alert">{settingsError}</p>
      <button type="button" onClick={state.retrySettings} disabled={state.settingsSaving || busy}>Retry settings</button></section>}
    {permissions.map(permission => permission.questions?.length
      ? <QuestionRequest key={`${control.ownership.generation}:${permission.id}`} permission={permission} busy={busy || control.ownership.kind !== 'mandible'} onAnswer={answers => respond(permission, 'answer', answers)} />
      : ['AskUserQuestion', 'item/tool/requestUserInput'].includes(permission.tool_name) ? <p key={permission.id} role="alert">This question could not be read. Stop the turn and retry.</p> : <section key={permission.id} className="composer-request" aria-label="Permission request">
        <strong>{permission.title ?? permission.tool_name}</strong>
        <p>Changing permissions affects subsequent checks. This request still needs your decision.</p>
        {permission.description && <p>{permission.description}</p>}
        <details><summary>Requested action</summary><pre>{JSON.stringify(permission.tool_input, null, 2)}</pre></details>
        <div className="composer-request__actions">{(['allow', 'deny'] as const).map(decision => <button key={decision} type="button" className="btn btn--sm" disabled={busy || control.ownership.kind !== 'mandible'} onClick={() => respond(permission, decision)}>{decision === 'allow' ? 'Allow once' : 'Deny'}</button>)}</div>
      </section>)}
  </div>;
}

export function ManagedConversationStopButton({ state }: { state: ReturnType<typeof useManagedConversationControlState> }) {
  if (!state.execution.canInterrupt && !state.interruptPending) return null;
  const stopping = state.interruptPending || state.execution.phase === 'stopping';
  return <button type="button" className="chat-circle-action conv-compose__send conv-compose__stop"
    disabled={state.busy || stopping} title={stopping ? 'Stopping…' : 'Stop turn'} aria-label={stopping ? 'Stopping…' : 'Stop turn'} onClick={state.interrupt}>
    <Icon name="chatStop" size={12} />
  </button>;
}
