import { fireEvent as nativeEvent } from '@testing-library/dom';
import { act } from '@testing-library/preact';
import { vi } from 'vitest';
import { conversationRunOptions } from '../../src/conversation-control/runtime-options';
import * as api from '../../ui/src/api';

/** Supply the structure half of the same explicit transcript fixture, without a second window read. */
export function mockConversationStructureFromWindow(): void {
  vi.spyOn(api, 'getConversationStructure').mockImplementation(async (id) => {
    const windows = vi.mocked(api.getConversationWindow);
    const index = windows.mock.calls.findLastIndex(([conversationId]) => conversationId === id);
    const result = windows.mock.results[index];
    if (!result || result.type !== 'return') throw new Error(`No transcript fixture for ${id}`);
    const window = await result.value;
    return {
      conversation_id: id, source_version_id: window.source_version_id, total: window.total,
      rows: Array.from({ length: Math.max(window.total, ...window.blocks.map(block => block.position + 1)) }, (_, position) => {
        const block = window.blocks.find(block => block.position === position);
        return { id: block?.id ?? `fixture-${id}-${position}`, position, type: block?.type ?? 'user_message',
          role: block?.role ?? 'user', parent_position: block?.parent_position ?? null, record_offset: null, record_length: 0 };
      }),
    };
  });
}

/** Managed settings are fetched separately from transcript and terminal metadata. */
export function mockManagedSettings(runtime_options: api.ConversationRuntimeOptions = { model: 'gpt-5.6-sol', effort: 'medium', permission_mode: 'agent' }): void {
  vi.stubGlobal('fetch', vi.fn(async (path: RequestInfo | URL) => {
    if (String(path).endsWith('/control/settings')) return new Response(JSON.stringify({ ok: true,
      value: { revision: 1, runtime_options, usage: [] } }), { headers: { 'content-type': 'application/json' } });
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
