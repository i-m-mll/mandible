import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Annotation } from 'agentation';

const note = (id: string): Annotation => ({
  id, comment: `Fix ${id}`, elementPath: 'button', timestamp: 1,
  x: 10, y: 20, element: 'button',
});
describe('Agentation to selected Chat draft', () => {
  const entries = new Map<string, string>();
  beforeEach(() => {
    entries.clear();
    vi.resetModules();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => { entries.set(key, value); },
    });
  });

  it('stages text-only notes in an inactive selected Chat without changing existing draft content', async () => {
    const store = await import('../ui/src/chat/attachmentDrafts');
    const { stageAgentationAnnotations } = await import('../ui/src/annotation/agentationAdapter');
    store.setDraftText('chat-a', 'Existing text');
    store.addDraftAttachments('chat-a', [{ kind: 'file', file: {
      id: 'file-1', name: 'a.txt', media_type: 'text/plain', byte_length: 1, sha256: 'a',
    } }]);
    store.registerWritableChatTarget('chat-a', false);
    expect(store.getWritableChatTarget()).toBeNull();

    expect(stageAgentationAnnotations([note('a'), note('b')], '/timeline', { width: 800, height: 600 }))
      .toEqual({ target: 'chat-a', addedIds: ['a', 'b'] });
    const draft = store.getConversationDraft('chat-a');
    expect(draft.text).toBe('Existing text');
    expect(draft.attachments.map((item) => item.kind)).toEqual(['file', 'annotation', 'annotation']);
    expect(draft.attachments.slice(1)).toMatchObject([
      { id: 'a', text: 'Fix a', target: { url: '/timeline', selector: 'button' } },
      { id: 'b', text: 'Fix b', target: { url: '/timeline', selector: 'button' } },
    ]);
    expect(draft.attachments.slice(1).every((item) => !('screenshot' in item))).toBe(true);
    expect(stageAgentationAnnotations([note('a'), note('b')], '/timeline', { width: 800, height: 600 }))
      .toEqual({ target: 'chat-a', addedIds: [] });
    expect(store.getConversationDraft('chat-a').attachments).toHaveLength(3);
  });

  it('preserves notes and drafts when there is no writable selection or storage fails', async () => {
    const store = await import('../ui/src/chat/attachmentDrafts');
    const { stageAgentationAnnotations } = await import('../ui/src/annotation/agentationAdapter');
    expect(() => stageAgentationAnnotations([note('a')], '/timeline', { width: 800, height: 600 }))
      .toThrow('Select a writable Chat');
    store.registerWritableChatTarget('chat-a', false);
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => { throw new Error('quota'); } });
    expect(() => stageAgentationAnnotations([note('a')], '/timeline', { width: 800, height: 600 }))
      .toThrow('quota');
    expect(store.getConversationDraft('chat-a').attachments).toHaveLength(0);
  });

  it('keeps Agentation element context on each individual draft attachment', async () => {
    const store = await import('../ui/src/chat/attachmentDrafts');
    const { stageAgentationAnnotations } = await import('../ui/src/annotation/agentationAdapter');
    store.registerWritableChatTarget('chat-a', false);
    const detailed: Annotation = {
      ...note('context'), comment: 'Tighten the spacing', element: 'button',
      elementPath: 'main > button.send', selectedText: 'Send', nearbyText: 'Send message',
      sourceFile: 'ui/src/views/conversations.tsx', reactComponents: 'ChatComposer',
      cssClasses: 'send primary', computedStyles: 'padding: 8px; gap: 4px',
    };
    stageAgentationAnnotations([detailed], '/chat', { width: 800, height: 600 });
    expect(store.getConversationDraft('chat-a').attachments[0]).toMatchObject({
      kind: 'annotation', text: 'Tighten the spacing', target: {
        url: '/chat', selector: 'main > button.send', element: 'button',
        selected_text: 'Send', nearby_text: 'Send message',
        source_file: 'ui/src/views/conversations.tsx', react_components: 'ChatComposer',
        css_classes: 'send primary', computed_styles: 'padding: 8px; gap: 4px',
      },
    });
  });
});
