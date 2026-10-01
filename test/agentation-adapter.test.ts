import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Annotation } from 'agentation';

const note = (id: string): Annotation => ({
  id, comment: `Fix ${id}`, elementPath: 'button', timestamp: 1,
  x: 10, y: 20, element: 'button',
});
const attachment = (id: string) => ({
  kind: 'annotation' as const, id, ordinal: 1, text: `Fix ${id}`,
  target: { url: '/chat', rect: { x: 1, y: 2, width: 3, height: 4 }, viewport: { width: 800, height: 600 } },
});

describe('Agentation to Chat staging', () => {
  const entries = new Map<string, string>();
  beforeEach(() => {
    entries.clear();
    vi.resetModules();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => { entries.set(key, value); },
    });
  });

  it('adds one pill per note without duplicating a repeat send in the same draft', async () => {
    const store = await import('../ui/src/chat/attachmentDrafts');
    const { stageAgentationAnnotations } = await import('../ui/src/annotation/agentationAdapter');
    store.registerWritableChatTarget('chat-a');
    const prepare = vi.fn(async (annotation: Annotation) => attachment(annotation.id));
    expect(await stageAgentationAnnotations([note('a'), note('b')], prepare)).toBe(2);
    expect(store.getConversationDraft('chat-a').attachments.map((item) => item.kind === 'annotation' && item.id)).toEqual(['a', 'b']);
    expect(await stageAgentationAnnotations([note('a'), note('b')], prepare)).toBe(0);
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it('keeps both drafts unchanged if the writable chat changes during preparation', async () => {
    const store = await import('../ui/src/chat/attachmentDrafts');
    const { stageAgentationAnnotations } = await import('../ui/src/annotation/agentationAdapter');
    store.registerWritableChatTarget('chat-a');
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const staging = stageAgentationAnnotations([note('a')], async () => {
      await gate;
      return attachment('a');
    });
    store.registerWritableChatTarget('chat-b');
    release?.();
    await expect(staging).rejects.toThrow('writable Chat changed');
    expect(store.getConversationDraft('chat-a').attachments).toHaveLength(0);
    expect(store.getConversationDraft('chat-b').attachments).toHaveLength(0);
  });

  it('captures a screenshot only while the original element still matches its saved bounds', async () => {
    const { matchingSelectionBounds } = await import('../ui/src/annotation/agentationAdapter');
    const button = document.createElement('button');
    button.id = 'target';
    document.body.append(button);
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue({ x: 10, y: 20, left: 10, top: 20, width: 80, height: 30, right: 90, bottom: 50, toJSON: () => ({}) });
    const saved = { ...note('a'), elementPath: '#target', boundingBox: { x: 10, y: 20, width: 80, height: 30 } };
    expect(matchingSelectionBounds(saved)).toEqual({ x: 10, y: 20, width: 80, height: 30 });
    expect(matchingSelectionBounds({ ...saved, boundingBox: { ...saved.boundingBox, x: 40 } })).toBeNull();
    button.remove();
  });
});
