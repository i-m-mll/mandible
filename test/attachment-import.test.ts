import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('Chat attachment imports', () => {
  const entries = new Map<string, string>();
  beforeEach(() => {
    entries.clear();
    vi.resetModules();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => { entries.set(key, value); },
    });
  });

  it('appends repeated batches to the captured chat after a failed send', async () => {
    const drafts = await import('../ui/src/chat/attachmentDrafts');
    const { importAttachmentBatch } = await import('../ui/src/chat/attachmentImport');
    drafts.setDraftText('first', 'Keep this text');
    drafts.savePendingSubmitIntent('first', {
      id: 'failed-send', message: 'Keep this text', draftText: 'Keep this text',
      attachments: [], runtimeOptions: {}, state: 'failed',
    });
    const first = new File(['hello'], 'one.md', { type: 'text/markdown' });
    const second = new File(['image'], 'two.png', { type: 'image/png' });
    let releaseUpload!: () => void;
    const paused = new Promise<void>((resolve) => { releaseUpload = resolve; });
    const upload = vi.fn(async (file: File) => {
      if (file === second) await paused;
      return { id: file.name, name: file.name, media_type: file.type, byte_length: file.size, sha256: file.name };
    });
    await importAttachmentBatch('first', [first], upload);
    const secondImport = importAttachmentBatch('first', [second], upload);
    drafts.setDraftText('other', 'Other chat');
    releaseUpload();
    await secondImport;

    expect(drafts.getConversationDraft('first')).toMatchObject({
      text: 'Keep this text', attachments: [
        { kind: 'file', file: { name: 'one.md' } },
        { kind: 'image', file: { name: 'two.png' } },
      ],
    });
    expect(drafts.getConversationDraft('other')).toEqual({ text: 'Other chat', attachments: [] });
    expect(drafts.getPendingSubmitIntent('first')?.id).toBe('failed-send');
  });

  it('adds a multi-file drop only after every upload succeeds', async () => {
    const drafts = await import('../ui/src/chat/attachmentDrafts');
    const { importAttachmentBatch } = await import('../ui/src/chat/attachmentImport');
    const files = [new File(['a'], 'a.txt'), new File(['b'], 'b.txt')];
    await expect(importAttachmentBatch('first', files, async (file) => {
      if (file === files[1]) throw new Error('Upload failed');
      return { id: file.name, name: file.name, media_type: 'text/plain', byte_length: file.size, sha256: file.name };
    })).rejects.toThrow('Upload failed');
    expect(drafts.getConversationDraft('first').attachments).toEqual([]);
  });
});
