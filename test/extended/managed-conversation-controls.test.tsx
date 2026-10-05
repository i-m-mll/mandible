import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, expect, it, vi } from 'vitest';
const fetcher=vi.hoisted(()=>vi.fn());
vi.mock('../../ui/src/client-auth-token',()=>({browserSessionFetch:fetcher}));
import { ManagedConversationControls } from '../../ui/src/chat/ManagedConversationControls';
import type { ConversationControlSnapshot } from '../../ui/src/api';
afterEach(()=>{cleanup();fetcher.mockReset();});
it('preserves edited settings across reconciliation and sends generation-scoped decisions',async()=>{
 const calls:{path:string;body:Record<string,unknown>}[]=[];
 fetcher.mockImplementation(async(path:string,init?:RequestInit)=>{
  const body=init?.body?JSON.parse(String(init.body)):{};calls.push({path,body});
  const value=path.endsWith('/settings')?{revision:7,runtime_options:{model:'stored'},usage:[]}:
    path.endsWith('/permissions')?[{id:'permission',tool_name:'Write',tool_input:{path:'file'}}]:undefined;
  return {ok:true,json:async()=>({ok:true,value})};
 });
 const control={conversation_id:'chat',provider:'claude_code',revision:1,ownership:{kind:'mandible',generation:3},turn:{kind:'waiting-permission'}} as ConversationControlSnapshot;
 const view=render(<ManagedConversationControls control={control}/>);
 await vi.waitFor(()=>expect((screen.getByLabelText('Model') as HTMLInputElement).value).toBe('stored'));
 fireEvent.input(screen.getByLabelText('Model'),{target:{value:'edited'}});
 view.rerender(<ManagedConversationControls control={{...control,revision:2}}/>);
 await vi.waitFor(()=>expect(calls.filter(call=>call.path.endsWith('/settings')).length).toBeGreaterThan(1));
 expect((screen.getByLabelText('Model') as HTMLInputElement).value).toBe('edited');
 fireEvent.click(screen.getByRole('button',{name:'Allow once'}));
 await vi.waitFor(()=>expect(calls).toContainEqual({path:'/api/conversations/chat/control/permission/permission',body:{generation:3,decision:'allow'}}));
 await vi.waitFor(()=>expect((screen.getByRole('button',{name:'Save settings'}) as HTMLButtonElement).disabled).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:'Save settings'}));
 await vi.waitFor(()=>expect(calls).toContainEqual({path:'/api/conversations/chat/control/settings',body:{expected_revision:7,runtime_options:{model:'edited'}}}));
});
