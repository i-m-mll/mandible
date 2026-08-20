import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  boundToolResultBlock,
  buildStreamState,
  conversationBlocksToStreamEvents,
  groupMessagesForDisplay,
  serializeConversationToMarkdown,
} from '../ui/src/chat';
import { ChatSurface, shouldShowJumpToLatest } from '../ui/src/chat/ChatSurface';
import { MessageActions } from '../ui/src/components/shared/MessageActions';
import type { StreamEvent, ToolResultContentBlock } from '../ui/src/components/stream-renderer/types';

function installBrowserStubs(): void {
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

function result(): StreamEvent {
  return {
    type: 'result',
    subtype: 'success',
    session_id: 's1',
    duration_ms: 0,
    num_turns: 1,
    result: '',
    total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
    is_error: false,
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
    const events = conversationBlocksToStreamEvents('session', [{
      id: 'visible-middle-block',
      type: 'assistant_message',
      content: 'middle',
      metadata_json: '{}',
    }], { leadingAssistantTurnId: 'stable-turn-start' });
    const state = buildStreamState(events);
    expect(state.nodes[0]).toMatchObject({ kind: 'assistant_turn', key: 'stable-turn-start' });
  });

  it('groups consecutive same-speaker nodes before rendering and serializes markdown', () => {
    const state = buildStreamState([
      user('first', 'u1'),
      user('second', 'u2'),
      assistantText('answer one', 'a1'),
      assistantText('answer two', 'a2'),
    ]);

    const groups = groupMessagesForDisplay(state.nodes);
    expect(groups.map((group) => ({ speaker: group.speaker, count: group.nodes.length }))).toEqual([
      { speaker: 'user', count: 2 },
      { speaker: 'assistant', count: 2 },
    ]);
    expect(groups[1].meta.totalTokens).toBe(6);

    expect(serializeConversationToMarkdown(state.nodes)).toContain('## User\n\nfirst');
    expect(serializeConversationToMarkdown(state.nodes)).toContain('## Assistant\n\nanswer two');
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
  it('uses a distance-plus-viewport threshold distinct from the follow threshold', () => {
    expect(shouldShowJumpToLatest(79, 800)).toBe(false);
    expect(shouldShowJumpToLatest(800, 800)).toBe(false);
    expect(shouldShowJumpToLatest(1200, 800)).toBe(false);
    expect(shouldShowJumpToLatest(1201, 800)).toBe(true);
    expect(shouldShowJumpToLatest(1501, 1200)).toBe(true);
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
    expect(container.querySelectorAll('.turn-group').length).toBeLessThan(40);
  });

  it('anchors Chat-only message actions and restores focus on Escape', async () => {
    vi.stubGlobal('innerWidth', 800);
    vi.stubGlobal('innerHeight', 600);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function getBounds() {
      if (this.classList.contains('message-actions__overflow')) return domRect(784, 566, 20, 24);
      if (this.classList.contains('message-actions__overflow-menu')) return domRect(0, 0, 180, 150);
      return domRect(0, 0, 0, 0);
    });
    render(
      <div>
        <button type="button">Outside target</button>
        <MessageActions onFork={vi.fn()} onResume={vi.fn()} onInfo={vi.fn()} dagUuid="dag-1" />
      </div>,
    );

    const trigger = screen.getByRole('button', { name: 'More actions' });
    fireEvent.click(trigger);
    const menu = await screen.findByRole('menu');
    await waitFor(() => {
      expect(menu.style.position).toBe('fixed');
      expect(menu.style.left).toBe('612px');
      expect(menu.style.top).toBe('410px');
      expect(menu.style.visibility).toBe('visible');
    });
    expect(menu.classList.contains('app-anchored-menu')).toBe(true);
    expect(menu.getAttribute('popover')).toBe('manual');
    expect(screen.getAllByRole('menuitem')).toHaveLength(3);

    const outside = screen.getByRole('button', { name: 'Outside target' });
    outside.focus();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    expect(await screen.findByRole('menu')).toBeTruthy();
    outside.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it('disengages scroll-follow while scrolled up and re-arms at bottom', () => {
    const events = [user('prompt', 'u1'), assistantText('answer', 'a1')];
    const { container, rerender } = render(
      <ChatSurface events={events} streaming sessionInfo={{ sessionId: 'scroll' }} />,
    );
    const scroll = container.querySelector('.stream-renderer__scroll') as HTMLElement;
    Object.defineProperty(scroll, 'clientHeight', { value: 500, configurable: true });
    Object.defineProperty(scroll, 'scrollHeight', { value: 9000, configurable: true });

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
    expect(scroll.scrollTop).toBe(1000);

    scroll.scrollTop = 8500;
    fireEvent.scroll(scroll);
    expect(screen.queryByRole('button', { name: /jump to latest/i })).toBeNull();

    scroll.scrollTop = 8480;
    fireEvent.scroll(scroll);
    rerender(
      <ChatSurface
        events={[...events, assistantText('new answer', 'a2'), assistantText('latest answer', 'a3')]}
        streaming
        sessionInfo={{ sessionId: 'scroll' }}
      />,
    );
    expect(scroll.scrollTop).toBe(8480);
  });

  it('does not replay persistent latest navigation after an upward scroll and row measurement', () => {
    const resizeCallbacks: ResizeObserverCallback[] = [];
    let rowHeight = 168;
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }
      observe(): void {}
      disconnect(): void {}
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function getBounds() {
      return this.classList.contains('stream-renderer__virtual-row')
        ? domRect(0, 0, 600, rowHeight)
        : domRect(0, 0, 0, 0);
    });
    const scrollTo = vi.fn(function scrollTo(this: HTMLElement, options: ScrollToOptions) {
      this.scrollTop = Number(options.top ?? 0);
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: scrollTo,
    });
    const events = Array.from({ length: 80 }, (_, index) => [
      user(`prompt ${index}`, `u${index}`),
      assistantText(`answer ${index}`, `a${index}`),
    ]).flat();

    const { container } = render(
      <ChatSurface
        events={events}
        streaming
        sessionInfo={{ sessionId: 'persistent-latest' }}
        navigationTarget={{ key: 'latest-once', kind: 'latest', turnId: null, smooth: true }}
      />,
    );
    const scroll = container.querySelector('.stream-renderer__scroll') as HTMLElement;
    Object.defineProperty(scroll, 'clientHeight', { value: 500, configurable: true });
    Object.defineProperty(scroll, 'scrollHeight', { value: 30000, configurable: true });
    scrollTo.mockClear();

    scroll.scrollTop = 1000;
    fireEvent.scroll(scroll);
    rowHeight = 240;
    act(() => resizeCallbacks.forEach((callback) => callback([], {} as ResizeObserver)));

    // Nine measured rows are wholly above the viewport, so preserving the
    // visible anchor adds their aggregate 9 * 72px growth.
    expect(scroll.scrollTop).toBe(1648);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('preserves the visible virtual anchor across measurement changes and history prepends', () => {
    const observed = new Map<HTMLElement, ResizeObserverCallback>();
    const heights = new Map<HTMLElement, number>();
    vi.stubGlobal('ResizeObserver', class {
      private callback: ResizeObserverCallback;
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
      }
      observe(element: Element): void {
        observed.set(element as HTMLElement, this.callback);
      }
      disconnect(): void {}
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function getBounds() {
      return this.classList.contains('stream-renderer__virtual-row')
        ? domRect(0, 0, 600, heights.get(this) ?? 168)
        : domRect(0, 0, 0, 0);
    });
    const events = Array.from({ length: 40 }, (_, index) => [
      user(`prompt ${index}`, `u${index}`),
      assistantText(`answer ${index}`, `a${index}`),
    ]).flat();
    const { container, rerender } = render(
      <ChatSurface events={events} streaming={false} sessionInfo={{ sessionId: 'stable-anchor' }} />,
    );
    const scroll = container.querySelector('.stream-renderer__scroll') as HTMLElement;
    Object.defineProperty(scroll, 'clientHeight', { value: 500, configurable: true });
    Object.defineProperty(scroll, 'scrollHeight', { value: 20000, configurable: true });
    scroll.scrollTop = 2000;
    fireEvent.scroll(scroll);

    const rowAboveViewport = Array.from(observed.keys()).find((row) => Number.parseInt(row.style.top, 10) < 2000);
    expect(rowAboveViewport).toBeTruthy();
    heights.set(rowAboveViewport!, 268);
    act(() => observed.get(rowAboveViewport!)!([], {} as ResizeObserver));
    expect(scroll.scrollTop).toBe(2100);

    rerender(
      <ChatSurface
        events={[user('older prompt', 'older-u'), assistantText('older answer', 'older-a'), ...events]}
        streaming={false}
        sessionInfo={{ sessionId: 'stable-anchor' }}
      />,
    );
    expect(scroll.scrollTop).toBe(2436);
  });

  it('suppresses one-page local and unmaterialized displacement but exposes a distant tail', () => {
    const events = [user('prompt', 'u1'), assistantText('answer', 'a1')];
    const { container, rerender } = render(
      <ChatSurface events={events} streaming={false} sessionInfo={{ sessionId: 'threshold' }} />,
    );
    const scroll = container.querySelector('.stream-renderer__scroll') as HTMLElement;
    Object.defineProperty(scroll, 'clientHeight', { value: 800, configurable: true });
    Object.defineProperty(scroll, 'scrollHeight', { value: 1800, configurable: true });
    scroll.scrollTop = 200;
    fireEvent.scroll(scroll);
    expect(screen.queryByRole('button', { name: /jump to latest/i })).toBeNull();

    rerender(
      <ChatSurface
        events={events}
        streaming={false}
        unmaterializedAfterCount={4}
        sessionInfo={{ sessionId: 'threshold' }}
      />,
    );
    expect(screen.queryByRole('button', { name: /jump to latest/i })).toBeNull();

    rerender(
      <ChatSurface
        events={events}
        streaming={false}
        unmaterializedAfterCount={10}
        sessionInfo={{ sessionId: 'threshold' }}
      />,
    );
    expect(screen.getByRole('button', { name: /jump to latest/i })).toBeTruthy();
  });

  it('materializes an exact turn before scrolling and honors reduced motion', () => {
    const events: StreamEvent[] = [];
    for (let i = 0; i < 80; i += 1) {
      events.push(user(`prompt ${i}`, `u${i}`));
      events.push(assistantText(`answer ${i}`, `a${i}`));
    }
    const scrollTo = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: scrollTo,
    });
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));

    render(
      <ChatSurface
        events={events}
        streaming={false}
        sessionInfo={{ sessionId: 'anchor' }}
        navigationTarget={{ key: 'anchor-a50', kind: 'turn', turnId: 'a50', smooth: true }}
      />,
    );

    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'auto' }));
    expect(scrollTo.mock.calls.at(-1)?.[0].top).toBeGreaterThan(0);
    expect(document.querySelectorAll('.turn-group').length).toBeLessThan(40);
  });

  it('materializes and centers an exact persisted block anchor', async () => {
    const blocks = Array.from({ length: 80 }, (_, index) => ({
      id: `block-${index}`,
      type: index % 2 === 0 ? 'user_message' as const : 'assistant_message' as const,
      content: `message ${index}`,
      timestamp: `2026-01-01T00:${String(index % 60).padStart(2, '0')}:00Z`,
      metadata_json: '{}',
    }));
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });

    render(
      <ChatSurface
        events={conversationBlocksToStreamEvents('history-anchor', blocks)}
        streaming={false}
        sessionInfo={{ sessionId: 'block-anchor' }}
        navigationTarget={{ key: 'block-anchor-51', kind: 'block', turnId: null, blockId: 'block-51', smooth: false }}
      />,
    );

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'auto' }));
    expect(document.querySelector('[data-block-id="block-51"]')).toBeTruthy();
    expect(document.querySelectorAll('.turn-group').length).toBeLessThan(40);
  });

  it('materializes and centers a far-off matched tool-result anchor', async () => {
    const blocks = Array.from({ length: 80 }, (_, index) => ([
      {
        id: `prompt-${index}`,
        type: 'user_message' as const,
        content: `prompt ${index}`,
        timestamp: `2026-01-01T00:${String(index % 60).padStart(2, '0')}:00Z`,
        metadata_json: '{}',
      },
      {
        id: `tool-${index}`,
        type: 'tool_use' as const,
        content: '{}',
        timestamp: `2026-01-01T01:${String(index % 60).padStart(2, '0')}:00Z`,
        metadata_json: JSON.stringify({ tool_id: `call-${index}`, tool_name: 'Read', tool_input: { path: `${index}.ts` } }),
      },
      {
        id: `result-${index}`,
        type: 'tool_result' as const,
        content: `result ${index}`,
        timestamp: `2026-01-01T02:${String(index % 60).padStart(2, '0')}:00Z`,
        metadata_json: JSON.stringify({ tool_id: `call-${index}` }),
      },
    ])).flat();
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });

    render(
      <ChatSurface
        events={conversationBlocksToStreamEvents('matched-result-anchor', blocks)}
        streaming={false}
        sessionInfo={{ sessionId: 'matched-result-anchor' }}
        navigationTarget={{ key: 'matched-result-60', kind: 'block', turnId: null, blockId: 'result-60', smooth: false }}
      />,
    );

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'auto' }));
    expect(document.querySelector('[data-block-id="result-60"]')).toBeTruthy();
    expect(document.querySelectorAll('.turn-group').length).toBeLessThan(40);
  });

  it('keeps Jump keyboard activation native and delegates true-end loading', () => {
    const jump = vi.fn();
    render(
      <ChatSurface
        events={[user('prompt', 'u1')]}
        streaming={false}
        unmaterializedAfterCount={10}
        onJumpToLatest={jump}
        sessionInfo={{ sessionId: 'jump-keyboard' }}
      />,
    );
    const button = screen.getByRole('button', { name: /jump to latest/i });
    expect(button.getAttribute('type')).toBe('button');
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    expect(jump).toHaveBeenCalledTimes(1);
  });

  it('expands thinking while streaming and collapses it after resolution by default', () => {
    const thinking: StreamEvent = {
      type: 'assistant',
      uuid: 'a1',
      session_id: 's1',
      parent_tool_use_id: null,
      message: {
        id: 'a1',
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'Need to inspect state' }],
      },
    };

    const { rerender } = render(
      <ChatSurface events={[thinking]} streaming sessionInfo={{ sessionId: 'thinking' }} />,
    );
    expect(screen.getByText('Need to inspect state')).toBeTruthy();

    rerender(
      <ChatSurface events={[thinking, result()]} streaming={false} sessionInfo={{ sessionId: 'thinking' }} />,
    );
    expect(screen.queryByText('Need to inspect state')).toBeNull();
  });

  it('keeps full tool output out of the DOM until open-full is requested', () => {
    const fullText = `${'line\n'.repeat(2600)}TAIL-MARKER`;
    const toolResult: ToolResultContentBlock = {
      type: 'tool_result',
      tool_use_id: 'tool-1',
      content: fullText,
    };
    const events: StreamEvent[] = [
      {
        type: 'assistant',
        uuid: 'a1',
        session_id: 's1',
        parent_tool_use_id: null,
        message: {
          id: 'a1',
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'npm test' } }],
        },
      },
      {
        type: 'user',
        uuid: 'tr1',
        session_id: 's1',
        parent_tool_use_id: null,
        message: { role: 'user', content: [toolResult] },
      },
      result(),
    ];

    render(<ChatSurface events={events} streaming={false} sessionInfo={{ sessionId: 'tool' }} />);

    expect(screen.queryByText(/TAIL-MARKER/)).toBeNull();
    fireEvent.click(screen.getByText('Bash'));
    expect(screen.getByRole('button', { name: /open full/i })).toBeTruthy();
    expect(screen.queryByText(/TAIL-MARKER/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /open full/i }));
    expect(screen.getByText(/TAIL-MARKER/)).toBeTruthy();
  });

  it('renders persisted events and unmatched results through canonical selectable nodes', () => {
    const onToggle = vi.fn();
    const events = conversationBlocksToStreamEvents('codex-history', [
      { id: 's1', type: 'system', content: 'System notice', timestamp: '2026-01-02T03:04:05Z', metadata_json: '{}' },
      { id: 'e1', type: 'event', content: 'Stream failed', timestamp: '2026-01-02T03:04:06Z', metadata_json: JSON.stringify({ event_type: 'provider_error', is_error: true }) },
      { id: 'tu1', type: 'tool_use', content: '{}', timestamp: '2026-01-02T03:04:06Z', metadata_json: JSON.stringify({ tool_id: 'paired', tool_name: 'Read', tool_input: { path: 'a.ts' } }) },
      { id: 'tr-paired', type: 'tool_result', content: 'paired output', timestamp: '2026-01-02T03:04:06Z', metadata_json: JSON.stringify({ tool_id: 'paired' }) },
      { id: 'tr1', type: 'tool_result', content: 'No matching request', timestamp: '2026-01-02T03:04:07Z', metadata_json: JSON.stringify({ tool_id: 'missing', is_error: true }) },
    ]);

    render(
      <ChatSurface
        events={events}
        streaming={false}
        sessionInfo={{ sessionId: 'persisted-semantics' }}
        selectMode
        selectedBlockIds={new Set(['e1', 'tr-paired'])}
        onToggleBlockSelect={onToggle}
      />,
    );

    expect(screen.getByText('System notice')).toBeTruthy();
    expect(screen.getByText('Stream failed')).toBeTruthy();
    expect(screen.getByText('Unmatched tool error')).toBeTruthy();
    expect(screen.getByText('provider_error')).toBeTruthy();
    expect(document.querySelector('[data-block-id="tr-paired"]')).toBeTruthy();
    expect(screen.getAllByText(/2026/).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: 'Deselect message' })).toHaveLength(2);
    fireEvent.click(screen.getAllByRole('button', { name: 'Deselect message' })[1]);
    expect(onToggle).toHaveBeenCalledWith('tr-paired', false);
  });
});
