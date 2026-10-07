import { useEffect, useRef, useState } from 'preact/hooks';
import type { ConversationControlSnapshot, ConversationRuntimeOptions } from '../api';
import type { ManagedPermissionRequest, ConversationRunOption } from '../../../src/conversation-control/types';
import { DisclosureChevronIcon } from '../components/shared/DisclosureChevronIcon';
import { conversationExecutionState } from './conversationControl';
import { browserSessionFetch } from '../client-auth-token';

type Permission = ManagedPermissionRequest;
type Settings = { revision: number; runtime_options: ConversationRuntimeOptions; usage: { generation: number; snapshot: Record<string, unknown> }[] };
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
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const busyRef = useRef(false);
  const id = control?.conversation_id;
  const controllerGeneration = control?.ownership.generation;
  const scopeRef = useRef({ id, controllerGeneration, generation: 0 });
  if (scopeRef.current.id !== id || scopeRef.current.controllerGeneration !== controllerGeneration) scopeRef.current = { id, controllerGeneration, generation: scopeRef.current.generation + 1 };
  const generation = scopeRef.current.generation;
  const current = () => scopeRef.current.generation === generation;
  const path = `/api/conversations/${encodeURIComponent(id ?? '')}/control`;
  useEffect(() => {
    dirtyRef.current = false;
    busyRef.current = false; setBusy(false);
    setInterruptPending(null); setOptions([]); setDirty(false); setSettings(null); setDraft({}); setPermissions([]); setError(null);
  }, [id]);
  useEffect(() => {
    if (!id) return;
    let active = true;
    void request<Settings>(`${path}/settings`).then(value => {
      if (!active) return;
      setSettings(value);
      if (!dirtyRef.current) setDraft(value.runtime_options);
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
  const edit = <K extends keyof ConversationRuntimeOptions>(key: K, value: ConversationRuntimeOptions[K]) => {
    setDraft(current => { const next = { ...current }; if (value === undefined) delete next[key]; else next[key] = value; return next; });
    dirtyRef.current = true; setDirty(true);
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
  return { options, execution, interrupt, interruptPending: Boolean(interruptPending), control, settings, draft, permissions: permissionScope.current === controllerGeneration ? permissions : [], error, busy, dirty, path, edit, perform,
    setPermissions: (value: Parameters<typeof setPermissions>[0]) => { if (current()) setPermissions(value); },
    setSettings: (value: Parameters<typeof setSettings>[0]) => { if (current()) setSettings(value); },
    clearDirty: () => { if (current()) { dirtyRef.current = false; setDirty(false); } } };
}

export function ManagedConversationControls({ control }: { control: ConversationControlSnapshot | null }) {
  return <ManagedConversationControlFields state={useManagedConversationControlState(control)} />;
}

export function ManagedConversationControlFields({ state, compact = false, includeActions = true }: { state: ReturnType<typeof useManagedConversationControlState>; compact?: boolean; includeActions?: boolean }) {
  const { control, settings, draft, busy, dirty, path, edit, perform, setSettings, clearDirty } = state;
  if (!control || !['claude_code', 'codex'].includes(control.provider)) return null;
  const claude = control.provider === 'claude_code';
  const coreFields = <>{state.options.map(option => {
    const value = draft[option.id] ?? '';
    const known = !value || option.choices.some(choice => choice.value === value);
    return <span className="session-controls__field session-controls__choice" key={option.id}>
      <select className="session-controls__select session-controls__select--borderless" disabled={busy || !option.choices.length}
        aria-label={option.label} title={option.label} value={value}
        onInput={event => edit(option.id, event.currentTarget.value || undefined)}>
        <option value="">Provider default</option>
        {!known && <option value={value}>{value}</option>}
        {option.choices.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
      </select>
      <DisclosureChevronIcon expanded />
    </span>;
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
      <p>Changes apply to the next new turn.</p>
      <button type="button" disabled={busy || !dirty || !settings} onClick={() => void perform(async () => {
        const saved = await request<Settings>(`${path}/settings`, 'PATCH', { expected_revision: settings!.revision, runtime_options: draft });
        setSettings(current => ({ ...current!, ...saved })); clearDirty();
      })}>Save settings</button>
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
  if (!control || (!error && !permissions.length)) return null;
  const respond = (permission: Permission, decision: 'allow' | 'deny' | 'answer', answers?: Record<string, string[]>) => void perform(async () => {
    await request(`${path}/permission/${encodeURIComponent(permission.id)}`, 'POST', { generation: control.ownership.generation, decision, ...(answers ? { answers } : {}) });
    setPermissions(current => current.filter(item => item.id !== permission.id));
  });
  return <div className="composer-request-shelf" aria-label="Pending requests">
    {error && <p className="composer-request-shelf__error" role="alert">{error}</p>}
    {permissions.map(permission => permission.questions?.length
      ? <QuestionRequest key={`${control.ownership.generation}:${permission.id}`} permission={permission} busy={busy || control.ownership.kind !== 'mandible'} onAnswer={answers => respond(permission, 'answer', answers)} />
      : ['AskUserQuestion', 'item/tool/requestUserInput'].includes(permission.tool_name) ? <p key={permission.id} role="alert">This question could not be read. Stop the turn and retry.</p> : <section key={permission.id} className="composer-request" aria-label="Permission request">
        <strong>{permission.title ?? permission.tool_name}</strong>
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
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1" /></svg>
  </button>;
}
