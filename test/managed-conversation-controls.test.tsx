// @vitest-environment jsdom
import { DEFAULT_MANAGED_CHAT_OPTIONS } from '../src/managed-chat-defaults';
import { ManagedChatDefaults } from '../ui/src/components/settings/ManagedChatDefaults';
import { getManagedChatDefaults, updateManagedChatDefaults } from '../ui/src/api';
vi.mock('../ui/src/api', () => ({ getManagedChatDefaults: vi.fn(), updateManagedChatDefaults: vi.fn() }));
import { act, cleanup, fireEvent, render, screen } from './helpers/dom.js';
import { waitUntilPasses } from './helpers/wait-until.js';
import { useRef, useState } from 'preact/hooks';
import { ChoiceDropdown } from '../ui/src/components/shared/ChoiceDropdown';
import { useAnchoredMenu } from '../ui/src/hooks/useAnchoredMenu';
import { afterEach, expect, it, vi } from 'vitest';
const fetcher=vi.hoisted(()=>vi.fn());
vi.mock('../ui/src/client-auth-token',()=>({browserSessionFetch:fetcher}));
import { ManagedConversationControls, ManagedConversationControlFields, ManagedConversationControlActions, ManagedConversationStopButton, useManagedConversationControlState } from '../ui/src/chat/ManagedConversationControls';
import type { ConversationControlSnapshot } from '../ui/src/api';
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
 await waitUntilPasses(() => expect(screen.getByRole('button', { name: 'Model' }).textContent).toBe('stored'));
 fireEvent.click(screen.getByRole('button', { name: 'Model' })); fireEvent.click(screen.getByRole('option', { name: 'first' }));
 await waitUntilPasses(() => expect(finishFirst).toBeTypeOf('function'));
 fireEvent.click(screen.getByRole('button', { name: 'Model' })); fireEvent.click(screen.getByRole('option', { name: 'latest' }));
 view.rerender(<ManagedConversationControls control={{ ...control, revision: 2 }}/>);
 expect(screen.getByRole('button', { name: 'Model' }).textContent).toBe('latest');
 finishFirst();
 await waitUntilPasses(() => expect(patches).toEqual([
  { expected_revision: 7, runtime_options: { model: 'first' } },
  { expected_revision: 8, runtime_options: { model: 'latest' } },
 ]));
 await waitUntilPasses(() => expect({ revision, model }).toEqual({ revision: 9, model: 'latest' }));
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
 await waitUntilPasses(() => expect(screen.getByRole('button', { name: 'Model' }).textContent).toBe('stored'));
 fireEvent.click(screen.getByRole('button', { name: 'Model' })); fireEvent.click(screen.getByRole('option', { name: 'edited' }));
 await waitUntilPasses(() => expect(screen.getByText('Save unavailable')).toBeTruthy());
 expect(screen.getByRole('button', { name: 'Model' }).textContent).toBe('edited');
 fireEvent.click(screen.getByRole('button', { name: 'Retry settings' }));
 await waitUntilPasses(() => expect(screen.queryByText('Save unavailable')).toBeNull());
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
 await waitUntilPasses(() => expect(screen.getByRole('button', { name: 'Model' }).textContent).toBe('stored'));
 fireEvent.click(screen.getByRole('button', { name: 'Model' })); fireEvent.click(screen.getByRole('option', { name: 'edited' }));
 fireEvent.click(screen.getByRole('button', { name: 'Send now' }));
 await waitUntilPasses(() => expect(finish).toBeTypeOf('function'));
 expect(flushed).toBeUndefined();
 finish(); await waitUntilPasses(() => expect(flushed).toBe(true));
 applyError = true; flushed = undefined;
 fireEvent.click(screen.getByRole('button', { name: 'Model' })); fireEvent.click(screen.getByRole('option', { name: 'stored' }));
 fireEvent.click(screen.getByRole('button', { name: 'Send now' }));
 finish(); await waitUntilPasses(() => expect(flushed).toBe(false));
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
 await waitUntilPasses(() => expect(calls).toEqual([{ generation: 3, turn_id: 'turn' }]));
 expect((screen.getByRole('button', { name: 'Stopping…' }) as HTMLButtonElement).disabled).toBe(true);
 view.rerender(<ControlsHarness control={{ ...runningControl, revision: 2 }}/>);
 expect(screen.getByRole('button', { name: 'Stopping…' })).toBeTruthy();
 view.rerender(<ControlsHarness control={{ ...runningControl, revision: 3, turn: { kind: 'cancelled', turn_id: 'turn', at: 3 } }}/>);
 await waitUntilPasses(() => expect(screen.queryByRole('button', { name: 'Stopping…' })).toBeNull());
});

it('shows interrupt failure and retains the active Stop affordance', async () => {
 fetcher.mockImplementation(async (path: string) => ({ ok: !path.endsWith('/interrupt'), json: async () => path.endsWith('/interrupt')
  ? { ok: false, message: 'Interrupt refused' }
  : { ok: true, value: path.endsWith('/settings') ? { revision: 0, runtime_options: {}, usage: [] } : [] } }));
 render(<ControlsHarness control={runningControl}/>);
 fireEvent.click(screen.getByRole('button', { name: 'Stop turn' }));
 await waitUntilPasses(() => expect(screen.getByRole('alert').textContent).toBe('Interrupt refused'));
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
 await waitUntilPasses(() => expect(screen.getByRole('button', { name: 'Submit answers' })).toBeTruthy());
 expect((screen.getByRole('button', { name: 'Submit answers' }) as HTMLButtonElement).disabled).toBe(true);
 fireEvent.click(screen.getByLabelText('B'));
 fireEvent.click(screen.getByRole('button', { name: 'Submit answers' }));
 await waitUntilPasses(() => expect(calls).toEqual([{ path: '/api/conversations/chat/control/permission/question', body: { generation: 3, decision: 'answer', answers: { choice: ['B'] } } }]));
 expect(screen.getByRole('button', { name: 'Allow once' })).toBeTruthy();
 await waitUntilPasses(() => expect(screen.queryByRole('button', { name: 'Submit answers' })).toBeNull());
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

const choices = ['Low', 'Medium', 'High'].map(label => ({ value: label.toLowerCase(), label }));

it('navigates choices, selects with the keyboard, and restores focus without changing the accessible name', () => {
  const change = vi.fn();
  render(<ChoiceDropdown label="Thinking effort" prompt="Select effort" value="medium" choices={choices} onChange={change} />);
  const trigger = screen.getByRole('button', { name: 'Thinking effort' });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  expect(trigger.textContent).toBe('Select effort');
  expect(document.activeElement).toBe(screen.getByRole('option', { name: 'Medium' }));
  expect(screen.getByRole('option', { name: 'Medium' }).getAttribute('aria-selected')).toBe('true');
  fireEvent.keyDown(document.activeElement!, { key: 'End' });
  expect(document.activeElement).toBe(screen.getByRole('option', { name: 'High' }));
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
  expect(document.activeElement).toBe(screen.getByRole('option', { name: 'Low' }));
  fireEvent.keyDown(document.activeElement!, { key: 'm' });
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
  fireEvent.keyDown(document.activeElement!, { key: ' ' });
  expect(change).toHaveBeenCalledExactlyOnceWith('low');
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it('dismisses without selection on Escape, outside pointer, and focus departure; disabled choices stay closed', async () => {
  const change = vi.fn();
  const view = render(<><ChoiceDropdown label="Model" prompt="Select model" value="medium" choices={choices} onChange={change} /><button>Outside</button></>);
  const trigger = screen.getByRole('button', { name: 'Model' });
  fireEvent.click(trigger);
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(document.activeElement).toBe(trigger);
  expect(trigger.textContent).toBe('Medium');
  fireEvent.click(trigger);
  screen.getByRole('button', { name: 'Outside' }).dispatchEvent(new Event('pointerdown', { bubbles: true }));
  await waitUntilPasses(() => expect(screen.queryByRole('listbox')).toBeNull());
  fireEvent.click(trigger);
  screen.getByRole('button', { name: 'Outside' }).focus();
  await waitUntilPasses(() => expect(screen.queryByRole('listbox')).toBeNull());
  expect(change).not.toHaveBeenCalled();
  view.rerender(<ChoiceDropdown label="Model" prompt="Select model" value="medium" choices={choices} disabled onChange={change} />);
  expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
});

function NestedMenu() {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const style = useAnchoredMenu({ open, anchorRef, menuRef, onDismiss: () => setOpen(false) });
  return <><button ref={anchorRef} onClick={() => setOpen(true)}>Run options</button>{open && <div ref={menuRef} role="dialog" popover="manual" className="app-anchored-menu" style={style}>
    <ChoiceDropdown label="Model" prompt="Select model" value="medium" choices={choices} onChange={() => {}} />
  </div>}</>;
}

it('closes the nested dropdown before the containing run-options menu on Escape', () => {
  render(<NestedMenu />);
  fireEvent.click(screen.getByRole('button', { name: 'Run options' }));
  const trigger = screen.getByRole('button', { name: 'Model' });
  fireEvent.click(trigger);
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(screen.getByRole('dialog')).toBeTruthy();
  expect(document.activeElement).toBe(trigger);
  fireEvent.keyDown(trigger, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Run options' }));
});

it('saves independent provider choices and exposes a failed save without losing the draft', async () => {
  vi.mocked(getManagedChatDefaults).mockResolvedValue(structuredClone(DEFAULT_MANAGED_CHAT_OPTIONS));
  vi.mocked(updateManagedChatDefaults).mockRejectedValueOnce(new Error('Save unavailable')).mockImplementationOnce(async value => value);
  render(<ManagedChatDefaults canSave />);
  const effort = await screen.findByLabelText('Codex Thinking effort');
  fireEvent.change(effort, { target: { value: 'high' } });
  const save = screen.getByRole('button', { name: 'Save chat defaults' });
  fireEvent.click(save);
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Error: Save unavailable');
  expect((screen.getByLabelText('Codex Thinking effort') as HTMLSelectElement).value).toBe('high');
  fireEvent.click(save);
  await waitUntilPasses(() => expect((save as HTMLButtonElement).disabled).toBe(true));
  expect(updateManagedChatDefaults).toHaveBeenLastCalledWith({
    claude_code: DEFAULT_MANAGED_CHAT_OPTIONS.claude_code,
    codex: { ...DEFAULT_MANAGED_CHAT_OPTIONS.codex, effort: 'high' },
  });
});

it('keeps current autosave edits when an earlier save finishes after A to B to A', async () => {
 const completions: Array<() => void> = [];
 fetcher.mockImplementation(async (path: string, init?: RequestInit) => {
  const model = init?.method === 'PATCH' ? JSON.parse(String(init.body)).runtime_options.model
   : path.includes('/A/') ? 'model-A' : 'model-B';
  if (init?.method === 'PATCH') await new Promise<void>(resolve => completions.push(resolve));
  return { ok: true, json: async () => ({ ok: true, value: path.endsWith('/settings')
   ? { revision: init?.method === 'PATCH' ? 8 : 7, runtime_options: { model }, usage: [] }
   : path.endsWith('/options') ? [{ id: 'model', label: 'Model', choices: ['model-A', 'model-B', 'earlier-edit', 'current-edit'].map(value => ({ value, label: value })) }] : [] }) };
 });
 const control = { conversation_id: 'A', provider: 'codex', revision: 1, ownership: { kind: 'none', generation: 0 }, turn: { kind: 'none' }, controller: { kind: 'stopped', at: 1 } } as ConversationControlSnapshot;
 let saving = false;
 function RaceHarness({ control }: { control: ConversationControlSnapshot }) {
  const state = useManagedConversationControlState(control); saving = state.settingsSaving;
  return <ManagedConversationControlFields state={state}/>;
 }
 const view = render(<RaceHarness control={control}/>);
 await waitUntilPasses(() => expect(screen.getByRole('button', { name: 'Model' }).textContent).toBe('model-A'));
 fireEvent.click(screen.getByRole('button', { name: 'Model' })); fireEvent.click(screen.getByRole('option', { name: 'earlier-edit' }));
 await waitUntilPasses(() => expect(completions).toHaveLength(1));
 view.rerender(<RaceHarness control={{ ...control, conversation_id: 'B' }}/>);
 await waitUntilPasses(() => expect(screen.getByRole('button', { name: 'Model' }).textContent).toBe('model-B'));
 view.rerender(<RaceHarness control={control}/>);
 await waitUntilPasses(() => expect(screen.getByRole('button', { name: 'Model' }).textContent).toBe('model-A'));
 fireEvent.click(screen.getByRole('button', { name: 'Model' })); fireEvent.click(screen.getByRole('option', { name: 'current-edit' }));
 await waitUntilPasses(() => expect(completions).toHaveLength(2));
 await act(async () => completions[0]());
 expect(saving).toBe(true);
 expect(screen.getByRole('button', { name: 'Model' }).textContent).toBe('current-edit');
 await act(async () => completions[1]());
 await waitUntilPasses(() => expect(saving).toBe(false));
 expect(screen.getByRole('button', { name: 'Model' }).textContent).toBe('current-edit');
});
