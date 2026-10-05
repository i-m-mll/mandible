import { useEffect, useRef, useState } from 'preact/hooks';
import type { ConversationControlSnapshot, ConversationRuntimeOptions } from '../api';
import { browserSessionFetch } from '../client-auth-token';

type Permission = { id: string; tool_name: string; title?: string; description?: string; tool_input: unknown };
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
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const busyRef = useRef(false);
  const id = control?.conversation_id;
  const scopeRef = useRef({ id, generation: 0 });
  if (scopeRef.current.id !== id) scopeRef.current = { id, generation: scopeRef.current.generation + 1 };
  const generation = scopeRef.current.generation;
  const current = () => scopeRef.current.generation === generation;
  const path = `/api/conversations/${encodeURIComponent(id ?? '')}/control`;
  useEffect(() => {
    dirtyRef.current = false;
    busyRef.current = false; setBusy(false);
    setDirty(false); setSettings(null); setDraft({}); setPermissions([]); setError(null);
  }, [id]);
  useEffect(() => {
    if (!id) return;
    let active = true;
    void request<Settings>(`${path}/settings`).then(value => {
      if (!active) return;
      setSettings(value);
      if (!dirtyRef.current) setDraft(value.runtime_options);
    }).catch(cause => { if (active) setError(String(cause)); });
    void request<Permission[]>(`${path}/permissions`).then(value => { if (active) setPermissions(value); })
      .catch(cause => { if (active) setError(String(cause)); });
    return () => { active = false; };
  }, [id, control?.revision]);
  const edit = <K extends keyof ConversationRuntimeOptions>(key: K, value: ConversationRuntimeOptions[K]) => {
    setDraft(current => { const next = { ...current }; if (value === undefined) delete next[key]; else next[key] = value; return next; });
    dirtyRef.current = true; setDirty(true);
  };
  const perform = async (action: () => Promise<unknown>) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(null);
    try { await action(); } catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (current()) { busyRef.current = false; setBusy(false); } }
  };
  return { control, settings, draft, permissions, error, busy, dirty, path, edit, perform,
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
  const coreFields = <>
      <label className="session-controls__field">Model<input disabled={busy} aria-label="Model" value={draft.model ?? ''} placeholder="Provider default" onInput={event => edit('model', event.currentTarget.value.trim() || undefined)} /></label>
      <label className="session-controls__field">Thinking effort<select disabled={busy} aria-label="Thinking effort" value={draft.effort ?? ''} onChange={event => edit('effort', event.currentTarget.value || undefined)}>
        <option value="">Provider default</option>{(claude ? ['low', 'medium', 'high', 'xhigh', 'max'] : ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']).map(value => <option value={value}>{value}</option>)}
      </select></label>
      <label className="session-controls__field">Permissions<select disabled={busy} aria-label="Permissions" value={draft.permission_mode ?? ''} onChange={event => edit('permission_mode', event.currentTarget.value as ConversationRuntimeOptions['permission_mode'] || undefined)}>
        <option value="">Provider default</option>{(claude ? ['default', 'acceptEdits', 'bypassPermissions'] : ['read-only', 'agent', 'agent-full-access']).map(value => <option value={value}>{value}</option>)}
      </select></label>
  </>;
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

export function ManagedConversationControlActions({ state }: { state: ReturnType<typeof useManagedConversationControlState> }) {
  const { control, error, permissions, busy, path, perform, setPermissions } = state;
  if (!control) return null;
  const activeTurn = ['running', 'queued', 'waiting-user', 'waiting-permission'].includes(control.turn.kind);
  if (!error && !permissions.length && !(control.ownership.kind === 'mandible' && activeTurn)) return null;
  return <div className="session-controls">
    {error && <p role="alert">{error}</p>}
    {permissions.map(permission => <div key={permission.id} className="session-controls__field">
      <strong>{permission.title ?? permission.tool_name}</strong>
      {permission.description && <p>{permission.description}</p>}
      <details><summary>Requested action</summary><pre>{JSON.stringify(permission.tool_input, null, 2)}</pre></details>
      {(['allow', 'deny'] as const).map(decision => <button type="button" disabled={busy} onClick={() => void perform(async () => {
        await request(`${path}/permission/${encodeURIComponent(permission.id)}`, 'POST', { generation: control.ownership.generation, decision });
        setPermissions(current => current.filter(item => item.id !== permission.id));
      })}>{decision === 'allow' ? 'Allow once' : 'Deny'}</button>)}
    </div>)}
    {control.ownership.kind === 'mandible' && activeTurn && <button type="button" disabled={busy} onClick={() => void perform(() => request(`${path}/interrupt`, 'POST', { generation: control.ownership.generation }))}>Interrupt turn</button>}
  </div>;
}
