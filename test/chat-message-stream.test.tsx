// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from './helpers/dom.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { boundToolResultBlock, buildStreamState, conversationBlocksToStreamEvents, groupMessagesForDisplay } from '../ui/src/chat';
import { ChatSurface } from '../ui/src/chat/ChatSurface';
import type { ConversationTranscriptConsumer } from '../ui/src/query/conversationData';
import type { StreamEvent } from '../ui/src/components/stream-renderer/types';
import type { ChatItem } from '../src/parsers/types';

function installBrowserStubs(): void {
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

function user(text: string, id: string): StreamEvent {
  return {
    type: 'user',
    uuid: id,
    session_id: 's1',
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'text', text }] },
  };
}

function assistantText(text: string, id: string): StreamEvent {
  return {
    type: 'assistant',
    uuid: id,
    session_id: 's1',
    parent_tool_use_id: null,
    message: {
      id,
      role: 'assistant',
      content: [{ type: 'text', text }],
      usage: { input_tokens: 1, output_tokens: 2 },
    },
  };
}

function domRect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect;
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
      source_record_ordinal: ordinal, source_sub_block_ordinal: 0,
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
  vi.restoreAllMocks();
  delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
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
    expect(groupMessagesForDisplay(expanded.nodes)[0].id).toBe(groupMessagesForDisplay(bounded.nodes)[0].id);
    const split = buildStreamState([
      ...conversationBlocksToStreamEvents('session', [earlier]),
      { type: 'transcript:boundary' },
      ...conversationBlocksToStreamEvents('session', [middle]),
    ]).nodes.filter(node => node.kind === 'assistant_turn');
    expect(split).toHaveLength(2);
    expect(new Set(split.map(node => node.key)).size).toBe(2);
    expect(split.map(node => node.turn.id)).toEqual(['stable-turn-start', 'stable-turn-start']);
  });

  it('keeps downstream same-speaker row keys stable across prepends and bounds each row', () => {
    const events = Array.from({ length: 25 }, (_, index) => user(`prompt ${index}`, `u${index}`));
    const before = groupMessagesForDisplay(buildStreamState(events).nodes);
    const after = groupMessagesForDisplay(buildStreamState([
      user('older 0', 'older-0'),
      user('older 1', 'older-1'),
      user('older 2', 'older-2'),
      ...events,
    ]).nodes);

    expect(before.every((group) => group.nodes.length <= 12)).toBe(true);
    expect(after.every((group) => group.nodes.length <= 12)).toBe(true);
    expect(after.slice(-2).map((group) => group.id)).toEqual(before.slice(-2).map((group) => group.id));
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

describe('ChatSurface stream behavior', () => {

  it('loads a visible missing range without presenting it as an empty conversation', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(720);
    const transcript: ConversationTranscriptConsumer = {
      conversationId: 'gap-conversation',
      sourceVersionId: 'version-1',
      historyLoading: false,
      total: 10,
      structure: null,
      loadedIntervals: [{ start: 0, end: 2 }, { start: 7, end: 9 }],
      hasOlder: false,
      hasNewer: false,
      unmaterializedAfterCount: 0,
      loadOlder: vi.fn(),
      loadNewer: vi.fn(),
      loadAround: vi.fn(),
    };
    render(<ChatSurface events={[user('prompt', 'u1')]} streaming={false} transcript={transcript} />);

    expect(screen.queryByText('No messages yet')).toBeNull();
    expect(document.querySelector('[data-virtual-kind="history"]')).toBeTruthy();
    await waitFor(() => expect(transcript.loadAround).toHaveBeenCalled());
    const requested = vi.mocked(transcript.loadAround).mock.calls[0][0];
    expect(requested).toBeGreaterThanOrEqual(3);
    expect(requested).toBeLessThanOrEqual(6);
  });

  it('persists a canonical reading anchor instead of a raw scroll offset', () => {
    const view = render(
      <ChatSurface events={[canonicalEvent(canonicalItem({
        type: 'message', role: 'user', parts: [{ type: 'text', text: 'anchored' }], ordinal: 4,
      }), 'persisted-anchor')]} streaming={false} sessionInfo={{ sessionId: 'reading-anchor' }} />,
    );
    const scroll = view.container.querySelector<HTMLElement>('.stream-renderer__scroll')!;
    fireEvent.wheel(scroll);
    fireEvent.scroll(scroll);
    const stored = JSON.parse(localStorage.getItem('mandible:chat-scroll:reading-anchor')!);

    expect(stored).toMatchObject({ version: 1, blockId: 'persisted-anchor' });
    expect(stored).toHaveProperty('itemId');
    expect(stored).toHaveProperty('viewportOffset');
  });

  it('windows large conversations to a bounded DOM row count', () => {
    const events: StreamEvent[] = [];
    for (let i = 0; i < 520; i += 1) {
      events.push(user(`prompt ${i}`, `u${i}`));
      events.push(assistantText(`answer ${i}`, `a${i}`));
    }

    const { container } = render(
      <ChatSurface events={events} streaming={false} sessionInfo={{ sessionId: 'large' }} />,
    );

    expect(groupMessagesForDisplay(buildStreamState(events).nodes).length).toBe(1040);
    expect(container.querySelectorAll('[data-virtual-kind]').length).toBeLessThan(40);
  });

  it('does not restore a stale anchor while the user is scrolling upward', () => {
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function clientHeight() {
      return this.classList.contains('stream-renderer__scroll') ? 500 : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function scrollHeight() {
      if (!this.classList.contains('stream-renderer__scroll')) return 0;
      return Number.parseFloat(this.querySelector<HTMLElement>('.stream-renderer__virtual-canvas')?.style.height ?? '0');
    });
    const scrollTo = vi.fn(function scrollTo(this: HTMLElement, options: ScrollToOptions) {
      this.scrollTop = Number(options.top ?? 0);
      this.dispatchEvent(new Event('scroll'));
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: scrollTo });
    const events = Array.from({ length: 40 }, (_, index) => [
      user(`prompt ${index}`, `u${index}`),
      assistantText(`answer ${index}`, `a${index}`),
    ]).flat();
    const { container, rerender } = render(
      <ChatSurface events={events} streaming={false} sessionInfo={{ sessionId: 'scrolling-anchor' }} />,
    );
    const scroll = container.querySelector<HTMLElement>('.stream-renderer__scroll')!;
    scroll.scrollTop = 2000;
    fireEvent.wheel(scroll, { deltaY: -100 });
    fireEvent.scroll(scroll);
    fireEvent.wheel(scroll, { deltaY: -100 });
    scroll.scrollTop = 1700;
    const previousScrollCalls = scrollTo.mock.calls.length;

    rerender(
      <ChatSurface
        events={[...events, user('new prompt', 'new-u')]}
        streaming={false}
        sessionInfo={{ sessionId: 'scrolling-anchor' }}
      />,
    );

    expect(scroll.scrollTop).toBe(1700);
    expect(scrollTo.mock.calls.length).toBe(previousScrollCalls);
  });

  it('does not jump down when a newly loaded group spanning the viewport is measured', () => {
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function clientHeight() {
      return this.classList.contains('stream-renderer__scroll') ? 500 : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function scrollHeight() {
      if (!this.classList.contains('stream-renderer__scroll')) return 0;
      return Number.parseFloat(this.querySelector<HTMLElement>('.stream-renderer__virtual-canvas')?.style.height ?? '0');
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function getBoundingClientRect() {
      if (this.classList.contains('stream-renderer__virtual-row')) {
        return domRect(0, 0, 600, this.querySelector('[data-block-id="b18"], [data-block-id="b19"]') ? 600 : 150);
      }
      return domRect(0, 0, 600, this.classList.contains('stream-renderer__scroll') ? 500 : 0);
    });
    const scrollTo = vi.fn(function scrollTo(this: HTMLElement, options: ScrollToOptions) {
      this.scrollTop = Number(options.top ?? 0);
      this.dispatchEvent(new Event('scroll'));
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: scrollTo });
    const structure = {
      conversation_id: 'measured-range', source_version_id: 'version-1', total: 30,
      rows: Array.from({ length: 30 }, (_, position) => ({
        id: `b${position}`, position, type: position % 2 ? 'assistant_message' : 'user_message',
        role: position % 2 ? 'assistant' : 'user',
        parent_position: null, record_offset: position * 1000, record_length: 1000,
      })),
    } as const;
    const transcript = (start: number): ConversationTranscriptConsumer => ({
      conversationId: 'measured-range', sourceVersionId: 'version-1', historyLoading: false,
      total: 30, structure, loadedIntervals: [{ start, end: 29 }],
      hasOlder: true, hasNewer: false, unmaterializedAfterCount: 0,
      loadOlder: vi.fn(), loadNewer: vi.fn(), loadAround: vi.fn(),
    });
    const events = (start: number) => Array.from({ length: 30 - start }, (_, index) => {
      const position = start + index;
      return {
        ...canonicalEvent(canonicalItem({
          type: 'message', role: position % 2 ? 'assistant' : 'user',
          parts: [{ type: 'text', text: `message ${position}` }],
          ordinal: position,
        }), `b${position}`),
        source: { blockId: `b${position}`, position },
      };
    });
    const view = render(<ChatSurface events={events(20)} streaming={false} transcript={transcript(20)} />);
    const scroll = view.container.querySelector<HTMLElement>('.stream-renderer__scroll')!;
    scroll.scrollTop = 3600;
    fireEvent.wheel(scroll, { deltaY: -300 });
    scroll.scrollTop = 3300;
    fireEvent.scroll(scroll);
    expect(scroll.scrollTop).toBe(3300);
    view.rerender(<ChatSurface events={events(19)} streaming={false} transcript={transcript(19)} />);

    const loadedRow = view.container.querySelector('[data-block-id="b19"]')?.closest<HTMLElement>('[data-virtual-kind="group"]');
    expect(loadedRow).toBeTruthy();
    const rowStart = Number.parseFloat(loadedRow!.style.transform.split(',')[1]);
    expect(rowStart).toBeLessThan(3300);
    expect(scroll.scrollTop).toBeGreaterThanOrEqual(rowStart);
    expect(scroll.scrollTop).toBeLessThan(rowStart + loadedRow!.getBoundingClientRect().height);
    const readingInset = scroll.scrollTop - rowStart;
    view.rerender(<ChatSurface events={events(18)} streaming={false} transcript={transcript(18)} />);
    const preservedRow = view.container.querySelector('[data-block-id="b19"]')?.closest<HTMLElement>('[data-virtual-kind="group"]')!;
    expect(preservedRow.dataset.virtualKey).toBe(loadedRow!.dataset.virtualKey);
    const preservedStart = Number.parseFloat(preservedRow.style.transform.split(',')[1]);
    expect(scroll.scrollTop - preservedStart).toBeCloseTo(readingInset);
  });

  it('keeps a reading position when an unloaded gap resolves into messages', () => {
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function clientHeight() {
      return this.classList.contains('stream-renderer__scroll') ? 500 : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function scrollHeight() {
      if (!this.classList.contains('stream-renderer__scroll')) return 0;
      return Number.parseFloat(this.querySelector<HTMLElement>('.stream-renderer__virtual-canvas')?.style.height ?? '0');
    });
    const scrollTo = vi.fn(function scrollTo(this: HTMLElement, options: ScrollToOptions) {
      this.scrollTop = Number(options.top ?? 0);
      this.dispatchEvent(new Event('scroll'));
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: scrollTo,
    });
    const total = 1_000;
    const structure = {
      conversation_id: 'gap-anchor', source_version_id: 'version-1', total,
      rows: Array.from({ length: total }, (_, position) => ({
        id: `b${position}`, position, type: 'user_message', role: 'user',
        parent_position: null, record_offset: position * 1000, record_length: 1000,
      })),
    } as const;
    const transcript = (withPage: boolean, withAdjacent = false): ConversationTranscriptConsumer => ({
      conversationId: 'gap-anchor', sourceVersionId: 'version-1', historyLoading: false,
      total, structure,
      loadedIntervals: [
        ...(withAdjacent ? [{ start: 400, end: 409 }] : []),
        ...(withPage ? [{ start: 500, end: 509 }] : []),
        { start: 900, end: 999 },
      ],
      hasOlder: true, hasNewer: false, unmaterializedAfterCount: 0,
      loadOlder: vi.fn(), loadNewer: vi.fn(), loadAround: vi.fn(),
    });
    const events = (withPage: boolean, withAdjacent = false) => [
      ...(withAdjacent ? Array.from({ length: 10 }, (_, index) => 400 + index) : []),
      ...(withPage ? Array.from({ length: 10 }, (_, index) => 500 + index) : []),
      ...Array.from({ length: 100 }, (_, index) => 900 + index),
    ].map((position) => {
      return {
        ...canonicalEvent(canonicalItem({
          type: 'message', role: 'user', parts: [{ type: 'text', text: `message ${position}` }],
          ordinal: position,
        }), `b${position}`),
        source: { blockId: `b${position}`, position },
      };
    });
    const view = render(<ChatSurface events={events(false)} streaming={false} transcript={transcript(false)} />);
    const scroll = view.container.querySelector<HTMLElement>('.stream-renderer__scroll')!;
    scroll.scrollTop = 75_032;
    fireEvent.wheel(scroll, { deltaY: -100 });
    fireEvent.scroll(scroll);
    fireEvent(scroll, new Event('scrollend'));
    const saved = JSON.parse(localStorage.getItem('mandible:chat-scroll:default')!);
    expect(saved.position).toBeGreaterThanOrEqual(500);
    expect(saved.position).toBeLessThanOrEqual(509);
    expect(saved.followingTail).toBe(false);
    expect(saved.viewportOffset).toBeGreaterThan(-200);
    expect(saved.viewportOffset).toBeLessThanOrEqual(0);
    const previousScrollCalls = scrollTo.mock.calls.length;

    view.rerender(<ChatSurface events={events(false, true)} streaming={false} transcript={transcript(false, true)} />);
    expect(scroll.scrollTop).toBeGreaterThan(70_000);
    expect(scroll.scrollTop).toBeLessThan(80_000);
    expect(scrollTo.mock.calls.slice(previousScrollCalls).map(([options]) => options.top)
      .filter((top) => Number(top) > 80_000)).toEqual([]);
    const adjacentScrollCalls = scrollTo.mock.calls.length;

    view.rerender(<ChatSurface events={events(true, true)} streaming={false} transcript={transcript(true, true)} />);

    expect(view.container.querySelector(`[data-block-id="b${saved.position}"]`)).toBeTruthy();
    expect(scrollTo.mock.calls.slice(adjacentScrollCalls).map(([options]) => options.top)
      .filter((top) => Number(top) > 80_000)).toEqual([]);
    expect(scroll.scrollTop).toBeGreaterThan(70_000);
    expect(scroll.scrollTop).toBeLessThan(80_000);
  });

  it('disengages scroll-follow while scrolled up and re-arms at bottom', () => {
    const events = [user('prompt', 'u1'), assistantText('answer', 'a1')];
    const { container, rerender } = render(
      <ChatSurface events={events} streaming sessionInfo={{ sessionId: 'scroll' }} />,
    );
    const scroll = container.querySelector('.stream-renderer__scroll') as HTMLElement;
    Object.defineProperty(scroll, 'clientHeight', { value: 500, configurable: true });
    Object.defineProperty(scroll, 'scrollHeight', { value: 9000, configurable: true });

    fireEvent.wheel(scroll, { deltaY: -100 });
    scroll.scrollTop = 1000;
    fireEvent.scroll(scroll);
    expect(screen.getByRole('button', { name: /jump to latest/i })).toBeTruthy();

    rerender(
      <ChatSurface
        events={[...events, assistantText('new answer', 'a2')]}
        streaming
        sessionInfo={{ sessionId: 'scroll' }}
      />,
    );
    expect(scroll.scrollTop).toBeGreaterThan(900);
    expect(scroll.scrollTop).toBeLessThanOrEqual(1000);

    fireEvent.wheel(scroll, { deltaY: 500 });
    scroll.scrollTop = 8500;
    fireEvent.scroll(scroll);
    expect(screen.queryByRole('button', { name: /jump to latest/i })).toBeNull();

    fireEvent.wheel(scroll, { deltaY: -20 });
    scroll.scrollTop = 8480;
    fireEvent.scroll(scroll);
    rerender(
      <ChatSurface
        events={[...events, assistantText('new answer', 'a2'), assistantText('latest answer', 'a3')]}
        streaming
        sessionInfo={{ sessionId: 'scroll' }}
      />,
    );
    expect(scroll.scrollTop).toBeGreaterThan(8400);
    expect(scroll.scrollTop).toBeLessThanOrEqual(8480);
  });

  it('follows a same-group append only from the true bottom', () => {
    const initial = Array.from({ length: 24 }, (_, index) => user(`entry ${index}`, `entry-${index}`));
    const scrollTo = vi.fn(function scrollTo(this: HTMLElement, options: ScrollToOptions) {
      this.scrollTop = Number(options.top ?? 0);
      this.dispatchEvent(new Event('scroll'));
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: scrollTo });
    const view = render(<ChatSurface events={initial} streaming={false} sessionInfo={{ sessionId: 'append-position' }} />);
    const scroll = view.container.querySelector<HTMLElement>('.stream-renderer__scroll')!;
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 9000 });

    fireEvent.wheel(scroll, { deltaY: -100 });
    scroll.scrollTop = 1000;
    fireEvent.scroll(scroll);
    const readingTop = scroll.scrollTop;
    view.rerender(<ChatSurface events={[...initial, user('new entry', 'entry-24')]}
      streaming={false} sessionInfo={{ sessionId: 'append-position' }} />);
    expect(scroll.scrollTop).toBe(readingTop);

    scroll.scrollTop = 8450;
    fireEvent.scroll(scroll);
    const nearBottomCalls = scrollTo.mock.calls.length;
    view.rerender(<ChatSurface events={[...initial, user('new entry', 'entry-24'), user('near latest', 'entry-25')]}
      streaming={false} sessionInfo={{ sessionId: 'append-position' }} />);
    expect(scrollTo.mock.calls.length).toBe(nearBottomCalls);

    fireEvent.wheel(scroll, { deltaY: 50 });
    scroll.scrollTop = 8500;
    fireEvent.scroll(scroll);
    view.rerender(<ChatSurface events={[...initial, user('new entry', 'entry-24'), user('near latest', 'entry-25'), user('latest', 'entry-26')]}
      streaming={false} sessionInfo={{ sessionId: 'append-position' }} />);
    expect(scrollTo).toHaveBeenCalledWith({ top: 9000, behavior: 'auto' });
  });

  it('does not re-arm tail follow when a content resize moves an earlier reader to the bottom', () => {
    const initial = Array.from({ length: 24 }, (_, index) => user(`entry ${index}`, `entry-${index}`));
    let height = 9000;
    const scrollTo = vi.fn(function scrollTo(this: HTMLElement, options: ScrollToOptions) {
      this.scrollTop = Number(options.top ?? 0);
      this.dispatchEvent(new Event('scroll'));
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: scrollTo });
    const view = render(<ChatSurface events={initial} streaming={false} sessionInfo={{ sessionId: 'resize-reader' }} />);
    const scroll = view.container.querySelector<HTMLElement>('.stream-renderer__scroll')!;
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, get: () => height });

    fireEvent.wheel(scroll, { deltaY: -200 });
    scroll.scrollTop = 1000;
    fireEvent.scroll(scroll);
    height = 1500;
    fireEvent.scroll(scroll);
    expect(JSON.parse(localStorage.getItem('mandible:chat-scroll:resize-reader')!).followingTail).toBe(false);

    view.rerender(<ChatSurface events={[...initial, user('new entry', 'entry-24')]}
      streaming={false} sessionInfo={{ sessionId: 'resize-reader' }} />);
    height = 2000;
    const callsBeforeAppend = scrollTo.mock.calls.length;
    view.rerender(<ChatSurface events={[...initial, user('new entry', 'entry-24'), user('later', 'entry-25')]}
      streaming={false} sessionInfo={{ sessionId: 'resize-reader' }} />);
    expect(scrollTo.mock.calls.slice(callsBeforeAppend)).not.toContainEqual([{ top: 2000, behavior: 'auto' }]);
    expect(JSON.parse(localStorage.getItem('mandible:chat-scroll:resize-reader')!).followingTail).toBe(false);
  });

  it('keeps an explicit latest jump through a paged source refresh', () => {
    let height = 100_000;
    const scrollTo = vi.fn(function scrollTo(this: HTMLElement, options: ScrollToOptions) {
      this.scrollTop = options.behavior === 'smooth'
        ? (this.scrollTop + Number(options.top ?? 0)) / 2
        : Number(options.top ?? 0);
      this.dispatchEvent(new Event('scroll'));
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: scrollTo });
    const transcript = (start: number, total: number): ConversationTranscriptConsumer => ({
      conversationId: 'paged-latest', sourceVersionId: `version-${total}`,
      historyLoading: false, total, structure: null,
      loadedIntervals: [{ start, end: total - 1 }],
      hasOlder: true, hasNewer: false, unmaterializedAfterCount: 0,
      loadOlder: vi.fn(), loadNewer: vi.fn(), loadAround: vi.fn(() => 'busy'),
    });
    const events = (start: number, total: number) => Array.from({ length: total - start }, (_, index) => {
      const position = start + index;
      return { ...canonicalEvent(canonicalItem({
        type: 'message', role: 'user', parts: [{ type: 'text', text: `entry ${position}` }], ordinal: position,
      }), `block-${position}`), source: { blockId: `block-${position}`, position } };
    });
    const view = render(<ChatSurface events={events(990, 1000)} streaming={false}
      transcript={transcript(990, 1000)} sessionInfo={{ sessionId: 'paged-latest' }} />);
    const scroll = view.container.querySelector<HTMLElement>('.stream-renderer__scroll')!;
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, get: () => height });
    scroll.scrollTop = 20_000;
    fireEvent.scroll(scroll);

    view.rerender(<ChatSurface events={events(990, 1000)} streaming={false}
      transcript={transcript(990, 1000)} sessionInfo={{ sessionId: 'paged-latest' }}
      navigationTarget={{ key: 'jump-latest', kind: 'latest', turnId: null, blockId: null, smooth: true }} />);
    expect(scrollTo).toHaveBeenCalledWith({ top: 100_000, behavior: 'auto' });
    view.rerender(<ChatSurface events={events(990, 1000)} streaming={false}
      transcript={transcript(990, 1000)} sessionInfo={{ sessionId: 'paged-latest' }} />);

    height = 140_000;
    view.rerender(<ChatSurface events={events(1190, 1200)} streaming={false}
      transcript={transcript(1190, 1200)} sessionInfo={{ sessionId: 'paged-latest' }} />);
    expect(scrollTo).toHaveBeenCalledWith({ top: 140_000, behavior: 'auto' });
    expect(scroll.scrollTop).toBe(140_000);
    expect(JSON.parse(localStorage.getItem('mandible:chat-scroll:paged-latest')!).followingTail).toBe(true);
  });

  it('does not re-arm tail follow from a correction during an upward wheel gesture', () => {
    const view = render(
      <ChatSurface events={[user('prompt', 'u1')]} streaming sessionInfo={{ sessionId: 'upward-correction' }} />,
    );
    const scroll = view.container.querySelector<HTMLElement>('.stream-renderer__scroll')!;
    Object.defineProperty(scroll, 'clientHeight', { value: 500, configurable: true });
    Object.defineProperty(scroll, 'scrollHeight', { value: 9000, configurable: true });
    scroll.scrollTop = 8500;
    fireEvent.wheel(scroll, { deltaY: -300 });
    scroll.scrollTop = 8200;
    fireEvent.scroll(scroll);
    fireEvent.wheel(scroll, { deltaY: -300 });
    scroll.scrollTop = 8490;
    fireEvent.scroll(scroll);

    const anchor = JSON.parse(localStorage.getItem('mandible:chat-scroll:upward-correction')!);
    expect(anchor.followingTail).toBe(false);
  });

  it('materializes and centers an exact persisted block anchor', async () => {
    const blocks = Array.from({ length: 80 }, (_, index) => ({
      id: `block-${index}`,
      type: 'event' as const,
      content: 'provider-shaped content must not render',
      timestamp: `2026-01-01T00:${String(index % 60).padStart(2, '0')}:00Z`,
      metadata_json: JSON.stringify({
        chat_item: canonicalItem({
          type: 'message',
          role: index % 2 === 0 ? 'user' : 'assistant',
          parts: [{ type: 'text', text: `message ${index}` }],
          ordinal: index,
          ...(index % 2 === 1 ? { turn: `turn-${index}` } : {}),
        }),
      }),
    }));
    blocks.splice(52, 0, { ...blocks[51], id: 'block-51-tool', metadata_json: JSON.stringify({
      chat_item: canonicalItem({ type: 'tool-call', role: 'assistant', phase: 'call', tool_id: 'anchor-tool',
        tool_name: 'Shell', input: { command: 'pwd' }, ordinal: 51, turn: 'turn-51' }),
    }) });
    const scrollIntoView = vi.fn();
    const navigationResult = vi.fn();
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(720);
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(30000);
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: function scrollTo(this: HTMLElement, options: ScrollToOptions) {
        this.scrollTop = Number(options.top ?? 0);
        this.dispatchEvent(new Event('scroll'));
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });

    const view = render(
      <ChatSurface
        events={conversationBlocksToStreamEvents('history-anchor', blocks)}
        streaming={false}
        sessionInfo={{ sessionId: 'block-anchor' }}
        navigationTarget={{ key: 'block-anchor-51', kind: 'block', turnId: null, blockId: 'block-51', smooth: false }}
      />,
    );

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'auto' }));
    const exactBlock = document.querySelector('[data-block-id="block-51"]');
    expect(exactBlock).toBeTruthy();
    expect(document.activeElement).toBe(exactBlock);
    expect(document.querySelectorAll('[data-virtual-kind]').length).toBeLessThan(40);
    view.rerender(<ChatSurface
      events={conversationBlocksToStreamEvents('history-anchor', blocks)} streaming={false}
      sessionInfo={{ sessionId: 'block-anchor' }}
      navigationTarget={{ key: 'native-turn-anchor-51', kind: 'turn', turnId: 'turn-51', blockId: null, smooth: false }}
      onNavigationResult={navigationResult}
    />);
    await waitFor(() => expect(navigationResult).toHaveBeenCalledWith({ key: 'native-turn-anchor-51', status: 'revealed' }));
  });
});
