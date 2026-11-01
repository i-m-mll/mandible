// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from './helpers/dom.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { boundToolResultBlock, buildStreamState, conversationBlocksToStreamEvents } from '../ui/src/chat';
import { ChatSurface } from '../ui/src/chat/ChatSurface';
import { conversationAnchorFromHash, messageLinkUrl } from '../ui/src/chat/messageLinks';
import { __resetAgentPageBindingForTests, adoptAgentSessionBinding } from '../ui/src/agent-page-binding';
import { MessageActions, MessageLinkContext } from '../ui/src/components/shared/MessageActions';
import type { ConversationTranscriptConsumer } from '../ui/src/query/conversationData';
import type { StreamEvent } from '../ui/src/components/stream-renderer/types';
import type { ChatItem } from '../src/parsers/types';

function installBrowserStubs(): void {
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
  if (!HTMLElement.prototype.scrollTo) {
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: function scrollTo(this: HTMLElement, options: ScrollToOptions) {
        this.scrollTop = Number(options.top ?? 0);
        this.dispatchEvent(new Event('scroll'));
      },
    });
  }
  const store = new Map<string, string>();
  const mem: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => {
      store.delete(key);
    },
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
  };

  Object.defineProperty(globalThis, 'localStorage', { value: mem, configurable: true, writable: true });
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    value: { writeText: vi.fn(() => Promise.resolve()) },
    configurable: true,
  });
}

function canonicalItem<T extends ChatItem>(item: Omit<T, 'identity' | 'provenance' | 'content_completion'> & {
  ordinal: number;
  turn?: string;
}): T {
  const { ordinal, turn, ...rest } = item;
  return {
    ...rest,
    identity: {
      provider: 'codex', session_id: 'canonical-session', native_turn_id: turn,
      source_record_ordinal: ordinal, source_sub_block_ordinal: 0, native_item_id: `item-${ordinal}`,
    },
    provenance: { source: 'verified-provider-transcript', provider: 'codex', source_event_type: 'test' },
    content_completion: 'complete',
  } as T;
}

function canonicalEvent(item: ChatItem, blockId: string): StreamEvent {
  return { type: 'chat:item', item, source: { blockId } };
}

function persistedBlock(id: string, item: ChatItem, timestamp?: string) {
  return {
    id,
    type: 'event' as const,
    content: 'provider-shaped content must not render',
    timestamp,
    metadata_json: JSON.stringify({ chat_item: item }),
  };
}

beforeEach(() => {
  installBrowserStubs();
});

afterEach(() => {
  cleanup();
  __resetAgentPageBindingForTests();
  vi.restoreAllMocks();
  delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
});

it.each(['user', 'assistant', 'system'] as const)('copies an exact %s message link after live content gains durable identity', async (role) => {
  window.history.replaceState(null, '', '/preview?instance=copy-test#/console?session=old-session&turn=old-turn&sidebar=hidden');
  adoptAgentSessionBinding('copy-agent');
  const item = canonicalItem({ type: 'message', role, parts: [{ type: 'text', text: 'Live message' }], ordinal: 0 });
  const transcript: ConversationTranscriptConsumer = {
    conversationId: 'copy-conversation', positionSpaceId: 'space', readingContext: new Map(), activeWindow: { start: 0, end: 0 }, protect: () => {}, cancelNavigation: () => {}, command: null, prepareDetails: async () => {}, replaceAround: async () => 'loaded', sourceVersionId: 'copy-source', historyLoading: false,
    total: 1, loadedIntervals: [{ start: 0, end: 0 }], hasOlder: false, hasNewer: false,
    loadOlder: () => 'loaded', loadNewer: () => 'loaded',
    loadAround: () => 'loaded',
  };
  const copyMessageLink = (blockId: string) => { void navigator.clipboard.writeText(messageLinkUrl(window.location.href, transcript.conversationId, blockId)); };
  const view = render(<ChatSurface events={[{ type: 'chat:item', item }]} streaming={true} transcript={transcript} onCopyMessageLink={copyMessageLink} />);
  fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
  expect((screen.getByRole('menuitem', { name: 'Copy link' }) as HTMLButtonElement).disabled).toBe(true);

  view.rerender(<ChatSurface events={[canonicalEvent(item, 'cblk:copy-conversation:42')]} streaming={false} transcript={transcript} onCopyMessageLink={copyMessageLink} />);
  const overflow = screen.getByRole('button', { name: 'More actions' });
  if (overflow.getAttribute('aria-expanded') !== 'true') fireEvent.click(overflow);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Copy link' }));
  await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledOnce());
  const url = new URL(vi.mocked(navigator.clipboard.writeText).mock.calls[0][0]);
  expect(url.origin).toBe(window.location.origin);
  expect(url.pathname).toBe('/preview');
  expect(url.searchParams.get('instance')).toBe('copy-test');
  const params = new URLSearchParams(url.hash.split('?')[1]);
  expect(Object.fromEntries(params)).toEqual({ sidebar: 'hidden', conversation: 'copy-conversation', block: 'cblk:copy-conversation:42', agent_session: 'copy-agent' });
  expect(conversationAnchorFromHash(url.hash)).toEqual({ block: 'cblk:copy-conversation:42' });
});

it.each(['Copy link', 'Fork', 'Resume', 'Info'])('executes %s and closes a menu outside the hover rail', (label) => {
  const callbacks = { 'Copy link': vi.fn(), Fork: vi.fn(), Resume: vi.fn(), Info: vi.fn() };
  const view = render(<MessageLinkContext.Provider value={callbacks['Copy link']}>
    <MessageActions blockId="exact-block" dagUuid="exact-dag" onFork={callbacks.Fork} onResume={callbacks.Resume} onInfo={callbacks.Info} />
  </MessageLinkContext.Provider>);
  fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
  const menu = screen.getByRole('menu');
  expect(view.container.contains(menu)).toBe(false);
  expect(document.body.contains(menu)).toBe(true);
  const item = screen.getByRole('menuitem', { name: label });
  fireEvent.pointerDown(item, { button: 0 });
  fireEvent.mouseDown(item, { button: 0 });
  fireEvent.mouseUp(item, { button: 0 });
  fireEvent.click(item, { button: 0 });
  expect(callbacks[label as keyof typeof callbacks]).toHaveBeenCalledOnce();
  if (label === 'Copy link') expect(callbacks['Copy link']).toHaveBeenCalledWith('exact-block');
  expect(screen.queryByRole('menu')).toBeNull();
  expect(screen.getByRole('button', { name: 'More actions' }).getAttribute('aria-expanded')).toBe('false');
});

it('composes group-scoped primary actions and exact-source overflow in one rail', async () => {
  const copyLink = vi.fn();
  const events = ['first', 'second'].map((text, index) => canonicalEvent(canonicalItem({
    type: 'message', role: 'assistant', parts: [{ type: 'text', text }], ordinal: index, turn: 'shared-turn',
  }), `message-${text}`));
  const view = render(<ChatSurface events={events} streaming={false} onCopyMessageLink={copyLink} />);
  const rail = view.container.querySelector('[data-block-id="message-second"] .message-actions')!;
  const buttons = Array.from(rail.querySelectorAll('button'));
  expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual(['Copy all messages', 'Open turn as markdown', 'More actions']);
  fireEvent.click(buttons[0]);
  await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledOnce());
  const copied = vi.mocked(navigator.clipboard.writeText).mock.calls[0][0];
  expect(copied).toContain('first');
  expect(copied).toContain('second');
  fireEvent.click(buttons[2]);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Copy link' }));
  expect(copyLink).toHaveBeenCalledWith('message-second');
});

describe('chat message stream render model', () => {

  it('preserves the stable logical turn id when a bounded window starts mid-turn', () => {
    const earlier = persistedBlock('earlier-block', canonicalItem({
      type: 'message', role: 'assistant', parts: [{ type: 'text', text: 'earlier' }], ordinal: 0, turn: 'stable-turn-start',
    }));
    const middle = persistedBlock('visible-middle-block', canonicalItem({
      type: 'message', role: 'assistant', parts: [{ type: 'text', text: 'middle' }], ordinal: 1, turn: 'stable-turn-start',
    }));
    const bounded = buildStreamState(conversationBlocksToStreamEvents('session', [middle]));
    const expanded = buildStreamState(conversationBlocksToStreamEvents('session', [earlier, middle]));
    expect(bounded.nodes[0]).toMatchObject({ kind: 'assistant_turn', turn: { id: 'stable-turn-start' } });
    expect(expanded.nodes[0]).toMatchObject({ kind: 'assistant_turn', key: bounded.nodes[0].key, turn: { id: 'stable-turn-start' } });
    const split = buildStreamState([
      ...conversationBlocksToStreamEvents('session', [earlier]),
      { type: 'transcript:boundary' },
      ...conversationBlocksToStreamEvents('session', [middle]),
    ]).nodes.filter(node => node.kind === 'assistant_turn');
    expect(split).toHaveLength(2);
    expect(new Set(split.map(node => node.key)).size).toBe(2);
    expect(split.map(node => node.turn.id)).toEqual(['stable-turn-start', 'stable-turn-start']);
  });

  it('bounds large tool result text before DOM delivery', () => {
    const fullText = `${'x'.repeat(13000)}TAIL-MARKER`;
    const bounded = boundToolResultBlock({
      type: 'tool_result',
      tool_use_id: 'tool-1',
      content: fullText,
    });

    expect(bounded.truncated).toBe(true);
    expect(String(bounded.content)).not.toContain('TAIL-MARKER');
    expect(bounded.fullText).toContain('TAIL-MARKER');
  });
});
