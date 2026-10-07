import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, expect, it, vi } from 'vitest';
const fetcher=vi.hoisted(()=>vi.fn());
vi.mock('../../ui/src/client-auth-token',()=>({browserSessionFetch:fetcher}));
import { ManagedConversationControls, ManagedConversationControlFields, ManagedConversationControlActions, ManagedConversationStopButton, useManagedConversationControlState } from '../../ui/src/chat/ManagedConversationControls';
import type { ConversationControlSnapshot } from '../../ui/src/api';
afterEach(()=>{cleanup();fetcher.mockReset();});
it('autosaves rapid edits in revision order and preserves them through an older refresh', async () => {
 const patches: Record<string, unknown>[] = [];
 let finishFirst!: () => void;
 let revision = 7; let model = 'stored';
 fetcher.mockImplementation(async (path: string, init?: RequestInit) => {
  if (init?.method === 'PATCH') {
   const body = JSON.parse(String(init.body)); patches.push(body);
   if (patches.length === 1) await new Promise<void>(resolve => { finishFirst = resolve; });
   revision++; model = body.runtime_options.model;
  }
  return { ok: true, json: async () => ({ ok: true, value: path.endsWith('/settings')
   ? { revision, runtime_options: { model }, usage: [] }
   : path.endsWith('/options') ? [{ id: 'model', label: 'Model', choices: ['stored', 'first', 'latest'].map(value => ({ value, label: value })) }] : [] }) };
 });
 const control = { conversation_id: 'chat', provider: 'claude_code', revision: 1, controller: { kind: 'ready', since: 1 }, ownership: { kind: 'mandible', generation: 3 }, turn: { kind: 'none' } } as ConversationControlSnapshot;
 const view = render(<ManagedConversationControls control={control}/>);
 await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Model' }).textContent).toBe('stored'));
 fireEvent.click(screen.getByRole('button', { name: 'Model' })); fireEvent.click(screen.getByRole('option', { name: 'first' }));
 await vi.waitFor(() => expect(finishFirst).toBeTypeOf('function'));
 fireEvent.click(screen.getByRole('button', { name: 'Model' })); fireEvent.click(screen.getByRole('option', { name: 'latest' }));
 view.rerender(<ManagedConversationControls control={{ ...control, revision: 2 }}/>);
 expect(screen.getByRole('button', { name: 'Model' }).textContent).toBe('latest');
 finishFirst();
 await vi.waitFor(() => expect(patches).toEqual([
  { expected_revision: 7, runtime_options: { model: 'first' } },
  { expected_revision: 8, runtime_options: { model: 'latest' } },
 ]));
 await vi.waitFor(() => expect({ revision, model }).toEqual({ revision: 9, model: 'latest' }));
 expect(screen.getByRole('button', { name: 'Model' }).textContent).toBe('latest');
 expect(screen.queryByRole('button', { name: 'Save settings' })).toBeNull();
});

it('retains failed autosave choices visibly and retries without a hidden Save action', async () => {
 let fail = true;
 fetcher.mockImplementation(async (path: string, init?: RequestInit) => {
  if (init?.method === 'PATCH' && fail) { fail = false; return { ok: false, json: async () => ({ message: 'Save unavailable' }) }; }
  return { ok: true, json: async () => ({ ok: true, value: path.endsWith('/settings')
   ? { revision: init?.method === 'PATCH' ? 8 : 7, runtime_options: { model: init?.method === 'PATCH' ? 'edited' : 'stored' }, usage: [] }
   : path.endsWith('/options') ? [{ id: 'model', label: 'Model', choices: ['stored', 'edited'].map(value => ({ value, label: value })) }] : [] }) };
 });
 const control = { conversation_id: 'chat', provider: 'codex', revision: 1, controller: { kind: 'ready', since: 1 }, ownership: { kind: 'none', generation: 0 }, turn: { kind: 'none' } } as ConversationControlSnapshot;
 render(<ManagedConversationControls control={control}/>);
 await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Model' }).textContent).toBe('stored'));
 fireEvent.click(screen.getByRole('button', { name: 'Model' })); fireEvent.click(screen.getByRole('option', { name: 'edited' }));
 await vi.waitFor(() => expect(screen.getByText('Save unavailable')).toBeTruthy());
 expect(screen.getByRole('button', { name: 'Model' }).textContent).toBe('edited');
 fireEvent.click(screen.getByRole('button', { name: 'Retry settings' }));
 await vi.waitFor(() => expect(screen.queryByText('Save unavailable')).toBeNull());
 expect(screen.getByRole('button', { name: 'Model' }).textContent).toBe('edited');
});

it('flush waits for autosave and blocks a saved setting the provider rejected', async () => {
 let finish!: () => void; let flushed: boolean | undefined; let applyError = false;
 fetcher.mockImplementation(async (path: string, init?: RequestInit) => {
  if (init?.method === 'PATCH') await new Promise<void>(resolve => { finish = resolve; });
  return { ok: true, json: async () => ({ ok: true, value: path.endsWith('/settings')
   ? { revision: init?.method === 'PATCH' ? 8 : 7, runtime_options: { model: init?.method === 'PATCH' ? JSON.parse(String(init.body)).runtime_options.model : 'stored' }, usage: [],
       ...(applyError ? { application: { generation: 0, acknowledged_options: { model: 'edited' }, fields: {
         model: { state: 'error', timing: 'next-response', error: 'Model refused' },
         effort: { state: 'acknowledged', timing: 'next-response' }, permission_mode: { state: 'acknowledged', timing: 'current-session' },
       } } } : {}) }
   : path.endsWith('/options') ? [{ id: 'model', label: 'Model', choices: ['stored', 'edited'].map(value => ({ value, label: value })) }] : [] }) };
 });
 function FlushHarness() {
  const state = useManagedConversationControlState({ conversation_id: 'chat', provider: 'codex', revision: 1,
    controller: { kind: 'ready', since: 1 }, ownership: { kind: 'none', generation: 0 }, turn: { kind: 'none' } } as ConversationControlSnapshot);
  return <><ManagedConversationControlActions state={state}/><ManagedConversationControlFields state={state} compact/><button onClick={() => { void state.flushSettings().then(value => { flushed = value; }); }}>Send now</button></>;
 }
 render(<FlushHarness/>);
 await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Model' }).textContent).toBe('stored'));
 fireEvent.click(screen.getByRole('button', { name: 'Model' })); fireEvent.click(screen.getByRole('option', { name: 'edited' }));
 fireEvent.click(screen.getByRole('button', { name: 'Send now' }));
 await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
 expect(flushed).toBeUndefined();
 finish(); await vi.waitFor(() => expect(flushed).toBe(true));
 applyError = true; flushed = undefined;
 fireEvent.click(screen.getByRole('button', { name: 'Model' })); fireEvent.click(screen.getByRole('option', { name: 'stored' }));
 fireEvent.click(screen.getByRole('button', { name: 'Send now' }));
 finish(); await vi.waitFor(() => expect(flushed).toBe(false));
 expect(screen.getByRole('button', { name: 'Model' }).textContent).toBe('stored');
 expect(screen.getByRole('alert').textContent).toContain('Model refused');
});

const runningControl = {
 conversation_id: 'chat', provider: 'codex', revision: 1,
 ownership: { kind: 'mandible', generation: 3 }, controller: { kind: 'running', since: 1 },
 turn: { kind: 'running', turn_id: 'turn', since: 1 }, provider_capabilities: { stop: true },
} as ConversationControlSnapshot;

function ControlsHarness({ control }: { control: ConversationControlSnapshot }) {
 const state = useManagedConversationControlState(control);
 return <><ManagedConversationControlActions state={state}/><ManagedConversationStopButton state={state}/></>;
}

it('keeps Stop pending through acceptance until the exact turn acknowledges a terminal outcome', async () => {
 const calls: unknown[] = [];
 fetcher.mockImplementation(async (path: string, init?: RequestInit) => {
  if (init?.method === 'POST') calls.push(JSON.parse(String(init.body)));
  return { ok: true, json: async () => ({ ok: true, value: path.endsWith('/settings') ? { revision: 0, runtime_options: {}, usage: [] } : [] }) };
 });
 const view = render(<ControlsHarness control={runningControl}/>);
 fireEvent.click(screen.getByRole('button', { name: 'Stop turn' }));
 await vi.waitFor(() => expect(calls).toEqual([{ generation: 3, turn_id: 'turn' }]));
 expect((screen.getByRole('button', { name: 'Stopping…' }) as HTMLButtonElement).disabled).toBe(true);
 view.rerender(<ControlsHarness control={{ ...runningControl, revision: 2 }}/>);
 expect(screen.getByRole('button', { name: 'Stopping…' })).toBeTruthy();
 view.rerender(<ControlsHarness control={{ ...runningControl, revision: 3, turn: { kind: 'cancelled', turn_id: 'turn', at: 3 } }}/>);
 await vi.waitFor(() => expect(screen.queryByRole('button', { name: 'Stopping…' })).toBeNull());
});

it('shows interrupt failure and retains the active Stop affordance', async () => {
 fetcher.mockImplementation(async (path: string) => ({ ok: !path.endsWith('/interrupt'), json: async () => path.endsWith('/interrupt')
  ? { ok: false, message: 'Interrupt refused' }
  : { ok: true, value: path.endsWith('/settings') ? { revision: 0, runtime_options: {}, usage: [] } : [] } }));
 render(<ControlsHarness control={runningControl}/>);
 fireEvent.click(screen.getByRole('button', { name: 'Stop turn' }));
 await vi.waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Interrupt refused'));
 expect((screen.getByRole('button', { name: 'Stop turn' }) as HTMLButtonElement).disabled).toBe(false);
});

it('requires explicit question choices and preserves other requests when answering', async () => {
 const calls: { path: string; body: unknown }[] = [];
 const requests = [{ id: 'question', tool_name: 'item/tool/requestUserInput', questions: [{ id: 'choice', title: 'Choice', question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }], multi_select: false, allow_other: false, secret: false }] }, { id: 'approval', tool_name: 'Write', tool_input: { path: 'example' } }];
 fetcher.mockImplementation(async (path: string, init?: RequestInit) => {
  if (init?.method === 'POST') calls.push({ path, body: JSON.parse(String(init.body)) });
  return { ok: true, json: async () => ({ ok: true, value: path.endsWith('/permissions') ? requests : path.endsWith('/settings') ? { revision: 0, runtime_options: {}, usage: [] } : [] }) };
 });
 render(<ControlsHarness control={runningControl}/>);
 await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Submit answers' })).toBeTruthy());
 expect((screen.getByRole('button', { name: 'Submit answers' }) as HTMLButtonElement).disabled).toBe(true);
 fireEvent.click(screen.getByLabelText('B'));
 fireEvent.click(screen.getByRole('button', { name: 'Submit answers' }));
 await vi.waitFor(() => expect(calls).toEqual([{ path: '/api/conversations/chat/control/permission/question', body: { generation: 3, decision: 'answer', answers: { choice: ['B'] } } }]));
 expect(screen.getByRole('button', { name: 'Allow once' })).toBeTruthy();
 await vi.waitFor(() => expect(screen.queryByRole('button', { name: 'Submit answers' })).toBeNull());
});

it('shows disabled Select prompts until effective values have descriptor choices, without a provider-default reset', async () => {
 fetcher.mockImplementation(async (path: string) => ({ ok: true, json: async () => ({ ok: true, value: path.endsWith('/settings')
  ? { revision: 0, runtime_options: { model: 'unavailable-model' }, usage: [] }
  : path.endsWith('/options') ? [
   { id: 'model', label: 'Model', choices: [{ value: 'available-model', label: 'Available model' }] },
   { id: 'effort', label: 'Thinking effort', choices: [{ value: 'high', label: 'High' }] },
   { id: 'permission_mode', label: 'Permissions', choices: [{ value: 'agent', label: 'Agent' }] },
  ] : [] }) }));
 render(<ManagedConversationControls control={runningControl} />);
 for (const [label, prompt] of [['Model', 'Select model'], ['Thinking effort', 'Select effort'], ['Permissions', 'Select permissions']]) {
  const trigger = await screen.findByRole('button', { name: label });
  expect(trigger.textContent).toBe(prompt);
  expect((trigger as HTMLButtonElement).disabled).toBe(true);
 }
 expect(screen.queryByText('Provider default')).toBeNull();
});
