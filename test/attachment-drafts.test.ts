// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const annotation = (id: string, ordinal: number) => ({
  kind: 'annotation' as const, id, ordinal, text: `Comment ${id}`,
  target: { url: '/chat', rect: { x: 1, y: 2, width: 3, height: 4 }, viewport: { width: 800, height: 600 } },
});

describe('attachment draft ownership and recovery', () => {
  const entries = new Map<string, string>();
  afterEach(() => vi.useRealTimers());
  beforeEach(() => {
    entries.clear();
    vi.resetModules();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => { entries.set(key, value); },
    });
  });

  it('adopts the historical Console draft once without clearing its source or replacing a current Chat draft', async () => {
    const store = await import('../ui/src/chat/attachmentDrafts');
    entries.set('mandible:console:composer-draft:v1:session', 'Saved Console text');
    expect(store.adoptLegacyConsoleDraft('session','chat').ok).toBe(true);
    expect(store.getConversationDraft('chat').text).toBe('Saved Console text');
    expect(entries.get('mandible:console:composer-draft:v1:session')).toBe('Saved Console text');
    store.setDraftText('chat','Current text');
    expect(store.adoptLegacyConsoleDraft('session','chat').ok).toBe(true);
    expect(store.getConversationDraft('chat').text).toBe('Current text');
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

  it('refuses attachments past the message limit without changing the draft', async () => {
    const store = await import('../ui/src/chat/attachmentDrafts');
    store.addDraftAttachments('chat-a', Array.from({ length: 16 }, (_, i) => annotation(`draft-${i}`, i + 1)));
    expect(store.addDraftAttachments('chat-a', [annotation('extra', 20)]).ok).toBe(false);
    expect(store.getConversationDraft('chat-a').attachments).toHaveLength(16);
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

  it('limits highlights to newly staged IDs and clears them after one second', async () => {
    vi.useFakeTimers();
    const store = await import('../ui/src/chat/attachmentDrafts');
    store.registerWritableChatTarget('chat-a', false);
    store.highlightDraftAttachments('chat-a', ['new']);
    expect([...store.getDraftAttachmentHighlights('chat-a')]).toEqual([]);
    store.activateDraftAttachmentHighlights('chat-a');
    expect([...store.getDraftAttachmentHighlights('chat-a')]).toEqual(['new']);
    expect([...store.getDraftAttachmentHighlights('chat-b')]).toEqual([]);
    vi.advanceTimersByTime(1000);
    expect([...store.getDraftAttachmentHighlights('chat-a')]).toEqual([]);
  });
});
