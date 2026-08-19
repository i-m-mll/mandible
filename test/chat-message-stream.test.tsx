import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  boundToolResultBlock,
  buildStreamState,
  groupMessagesForDisplay,
  serializeConversationToMarkdown,
} from '../ui/src/chat';
import { ChatSurface } from '../ui/src/chat/ChatSurface';
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
});

describe('chat message stream render model', () => {
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
});
