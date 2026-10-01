import { beforeEach, describe, expect, it, vi } from 'vitest';

const annotation = (id: string, ordinal: number) => ({
  kind: 'annotation' as const, id, ordinal, text: `Comment ${id}`,
  target: { url: '/chat', rect: { x: 1, y: 2, width: 3, height: 4 }, viewport: { width: 800, height: 600 } },
});

describe('attachment draft ownership and recovery', () => {
  const entries = new Map<string, string>();
  beforeEach(() => {
    entries.clear();
    vi.resetModules();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => { entries.set(key, value); },
    });
  });

  it('pastes into the captured writable chat and restores cleared annotations without changing the draft', async () => {
    const store = await import('../ui/src/chat/attachmentDrafts');
    expect(store.setDraftText('chat-a', 'Existing text').ok).toBe(true);
    expect(store.addDraftAttachments('chat-a', [{ kind: 'file', file: { id: 'file-1', name: 'a.txt', media_type: 'text/plain', byte_length: 1, sha256: 'a' } }]).ok).toBe(true);
    expect(store.saveAnnotation(annotation('one', 1)).ok).toBe(true);
    const unregister = store.registerWritableChatTarget('chat-a');
    expect(store.pasteAnnotationsToVisibleChat()).toEqual({ ok: true, value: true });
    unregister();
    expect(store.getConversationDraft('chat-a').text).toBe('Existing text');
    expect(store.getConversationDraft('chat-a').attachments).toHaveLength(2);
    expect(store.getConversationDraft('chat-b').attachments).toHaveLength(0);
    expect(store.saveAnnotation(annotation('two', 2)).ok).toBe(true);
    expect(store.undoClearAnnotations()).toEqual({ ok: true, value: true });
    expect(store.getAttachmentDraftSnapshot().annotations.map((entry) => entry.id)).toEqual(['one', 'two']);
    expect(store.getConversationDraft('chat-a').attachments).toHaveLength(2);
  });

  it('does not clear saved annotations when draft persistence fails', async () => {
    const store = await import('../ui/src/chat/attachmentDrafts');
    expect(store.saveAnnotation(annotation('one', 1)).ok).toBe(true);
    store.registerWritableChatTarget('chat-a');
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => { throw new Error('quota'); } });
    expect(store.pasteAnnotationsToVisibleChat()).toEqual({ ok: false, error: 'quota' });
    expect(store.getAttachmentDraftSnapshot().annotations).toHaveLength(1);
    expect(store.getConversationDraft('chat-a').attachments).toHaveLength(0);
  });

  it('only clears an accepted unchanged draft', async () => {
    const store = await import('../ui/src/chat/attachmentDrafts');
    store.setDraftText('chat-a', 'Original');
    const submitted = structuredClone(store.getConversationDraft('chat-a'));
    store.setDraftText('chat-a', 'New edit');
    store.clearAcceptedDraft('chat-a', submitted);
    expect(store.getConversationDraft('chat-a').text).toBe('New edit');
    store.clearAcceptedDraft('chat-a', store.getConversationDraft('chat-a'));
    expect(store.getConversationDraft('chat-a').text).toBe('');
  });

  it('retains one pending idempotency key across a reload and clears it after acceptance', async () => {
    let store = await import('../ui/src/chat/attachmentDrafts');
    store.setDraftText('chat-a', 'Message');
    const draft = structuredClone(store.getConversationDraft('chat-a'));
    expect(store.savePendingSubmitIntent('chat-a', {
      id: 'stable-key', message: 'Message', draftText: 'Message', attachments: [],
      runtimeOptions: {}, state: 'submitting',
    }).ok).toBe(true);
    vi.resetModules();
    store = await import('../ui/src/chat/attachmentDrafts');
    expect(store.getPendingSubmitIntent('chat-a')).toMatchObject({ id: 'stable-key', state: 'uncertain' });
    expect(store.clearAcceptedDraft('chat-a', draft).ok).toBe(true);
    expect(store.getPendingSubmitIntent('chat-a')).toBeNull();
  });
});
