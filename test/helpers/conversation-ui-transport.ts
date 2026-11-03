import { fireEvent as nativeEvent } from '@testing-library/dom';
import { act } from '@testing-library/preact';
import { vi } from 'vitest';
import { conversationRunOptions } from '../../src/conversation-control/runtime-options';
import * as api from '../../ui/src/api';

/** jsdom has no layout; the engine needs a visible measured viewport. */
export function mockChatViewport(): void {
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800);
}

/** Managed settings are fetched separately from transcript and terminal metadata. */
export function mockManagedSettings(runtime_options: api.ConversationRuntimeOptions = { model: 'gpt-5.6-sol', effort: 'medium', permission_mode: 'agent' }): void {
  let revision = 1;
  vi.stubGlobal('fetch', vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
    if (String(path).endsWith('/control/settings')) {
      if (init?.method === 'PATCH') {
        runtime_options = { ...runtime_options, ...JSON.parse(String(init.body)).runtime_options };
        revision++;
      }
      return new Response(JSON.stringify({ ok: true,
        value: { revision, runtime_options, usage: [] } }), { headers: { 'content-type': 'application/json' } });
    }
    if (String(path).endsWith('/control/options')) return new Response(JSON.stringify({ ok: true, value: conversationRunOptions('codex', [{value: runtime_options.model ?? 'gpt-5.6-sol', label: runtime_options.model ?? 'gpt-5.6-sol'}, {value: 'edited-model', label: 'edited-model'}]) }), { headers: { 'content-type': 'application/json' } });
    if (String(path).endsWith('/control/permissions')) return new Response(JSON.stringify({ ok: true, value: [] }),
      { headers: { 'content-type': 'application/json' } });
    throw new Error(`Unmocked UI request: ${String(path)}`);
  }));
}

/** The Preact test helper rewrites select change to input once any compat vnode renders. */
export function changeNativeSelect(element: HTMLSelectElement, value: string): void {
  act(() => nativeEvent.change(element, { target: { value } }));
}

/** Existing native window fixtures also supply the separate body-free metadata projection. */
export function mockConversationMetadataTransport():void {
  vi.spyOn(api,'getConversationMetadata').mockImplementation(async(id,request)=>{
    const payload=await api.getConversationWindow(id,request);
    return {projection:'metadata',conversation:payload.conversation,children:payload.children,parent:payload.parent,total:payload.total,target:payload.target,source_version_id:payload.source_version_id,position_space_id:payload.position_space_id,publication_revision:payload.publication_revision};
  });
}
