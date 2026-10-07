import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, expect, it, vi } from 'vitest';
const fetcher=vi.hoisted(()=>vi.fn());
vi.mock('../../ui/src/client-auth-token',()=>({browserSessionFetch:fetcher}));
import { ManagedConversationControls, ManagedConversationControlActions, ManagedConversationStopButton, useManagedConversationControlState } from '../../ui/src/chat/ManagedConversationControls';
import type { ConversationControlSnapshot } from '../../ui/src/api';
afterEach(()=>{cleanup();fetcher.mockReset();});
it('preserves edited settings across reconciliation and sends generation-scoped decisions',async()=>{
 const calls:{path:string;body:Record<string,unknown>}[]=[];
 fetcher.mockImplementation(async(path:string,init?:RequestInit)=>{
  const body=init?.body?JSON.parse(String(init.body)):{};calls.push({path,body});
  const value=path.endsWith('/settings')?{revision:7,runtime_options:{model:'stored'},usage:[]}:
    path.endsWith('/options')?[{id:'model',label:'Model',choices:[{value:'stored',label:'stored'},{value:'edited',label:'edited'}]}]:
    path.endsWith('/permissions')?[{id:'permission',tool_name:'Write',tool_input:{path:'file'}}]:undefined;
  return {ok:true,json:async()=>({ok:true,value})};
 });
 const control={conversation_id:'chat',provider:'claude_code',revision:1,controller:{kind:'ready',since:1},ownership:{kind:'mandible',generation:3},turn:{kind:'waiting-permission'}} as ConversationControlSnapshot;
 const view=render(<ManagedConversationControls control={control}/>);
 await vi.waitFor(()=>expect(screen.getByRole('button', { name: 'Model' }).textContent).toBe('stored'));
 fireEvent.click(screen.getByRole('button', { name: 'Model' }));
 fireEvent.click(screen.getByRole('option', { name: 'edited' }));
 await vi.waitFor(()=>expect((screen.getByRole('button',{name:'Save settings'}) as HTMLButtonElement).disabled).toBe(false));
 view.rerender(<ManagedConversationControls control={{...control,revision:2}}/>);
 await vi.waitFor(()=>expect(calls.filter(call=>call.path.endsWith('/settings')).length).toBeGreaterThan(1));
 expect(screen.getByRole('button', { name: 'Model' }).textContent).toBe('edited');
 fireEvent.click(screen.getByRole('button',{name:'Allow once'}));
 await vi.waitFor(()=>expect(calls).toContainEqual({path:'/api/conversations/chat/control/permission/permission',body:{generation:3,decision:'allow'}}));
 await vi.waitFor(()=>expect((screen.getByRole('button',{name:'Save settings'}) as HTMLButtonElement).disabled).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:'Save settings'}));
 await vi.waitFor(()=>expect(calls).toContainEqual({path:'/api/conversations/chat/control/settings',body:{expected_revision:7,runtime_options:{model:'edited'}}}));
});

it('keeps current edits when an earlier save finishes after A to B to A', async () => {
 let finishSave!: (value: unknown) => void;
 fetcher.mockImplementation(async (path: string, init?: RequestInit) => {
  if (init?.method === 'PATCH') return new Promise(resolve => { finishSave = resolve; });
  return { ok: true, json: async () => ({ ok: true, value: path.endsWith('/settings')
   ? { revision: 7, runtime_options: { model: path.includes('/A/') ? 'model-A' : 'model-B' }, usage: [] } : path.endsWith('/options') ? [{id:'model',label:'Model',choices:['model-A','model-B','earlier-edit','current-edit'].map(value=>({value,label:value}))}] : [] }) };
 });
 const control = { conversation_id: 'A', provider: 'codex', revision: 1, controller: {kind:'ready',since:1}, ownership: { kind: 'none', generation: 0 }, turn: { kind: 'none' } } as ConversationControlSnapshot;
 const view = render(<ManagedConversationControls control={control}/>);
 await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Model' }).textContent).toBe('model-A'));
 fireEvent.click(screen.getByRole('button', { name: 'Model' }));
 fireEvent.click(screen.getByRole('option', { name: 'earlier-edit' }));
 await vi.waitFor(()=>expect((screen.getByRole('button',{name:'Save settings'}) as HTMLButtonElement).disabled).toBe(false));
 fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
 await vi.waitFor(() => expect(finishSave).toBeTypeOf('function'));
 view.rerender(<ManagedConversationControls control={{ ...control, conversation_id: 'B' }}/>);
 await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Model' }).textContent).toBe('model-B'));
 view.rerender(<ManagedConversationControls control={control}/>);
 await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Model' }).textContent).toBe('model-A'));
 fireEvent.click(screen.getByRole('button', { name: 'Model' }));
 fireEvent.click(screen.getByRole('option', { name: 'current-edit' }));
 finishSave({ ok: true, json: async () => ({ ok: true, value: { revision: 8, runtime_options: { model: 'earlier-edit' } } }) });
 await vi.waitFor(() => expect((screen.getByRole('button', { name: 'Save settings' }) as HTMLButtonElement).disabled).toBe(false));
 expect(screen.getByRole('button', { name: 'Model' }).textContent).toBe('current-edit');
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
