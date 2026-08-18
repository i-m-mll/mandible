import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as api from '../ui/src/api.js';
import type { Conversation, ConversationSidebarGroup } from '../ui/src/api.js';
import { ConversationsView } from '../ui/src/views/conversations.js';
import { normalizeSidebarGroupLimit } from '../ui/src/components/shared/sidebar-group-settings.js';
import { __resetSharedSseForTests } from '../ui/src/sse-shared.js';
import type { ConsoleSession } from '../ui/src/state.js';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners = new Set<(event: MessageEvent) => void>();
  constructor(public url: string) { FakeEventSource.instances.push(this); }
  addEventListener(type: string, listener: (event: MessageEvent) => void): void { if (type === 'message') this.listeners.add(listener); }
  removeEventListener(): void {}
  close(): void { this.readyState = 2; }
  emit(payload: Record<string, unknown>): void {
    const event = new MessageEvent('message', { data: JSON.stringify(payload) });
    for (const listener of this.listeners) listener(event);
  }
}

vi.mock('@xterm/xterm', () => ({ Terminal: class { options = {}; loadAddon(): void {} open(): void {} write(): void {} writeln(): void {} clear(): void {} focus(): void {} dispose(): void {} } }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit(): void {} dispose(): void {} } }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  __resetSharedSseForTests();
  vi.unstubAllGlobals();
});

function conversation(id: string, title: string, starred = false): Conversation {
  return {
    id, source: 'codex', source_path: `/tmp/${id}.jsonl`, title, summary: null,
    started_at: '2026-08-18T12:00:00.000Z', ended_at: null, block_count: 2,
    session_id: `session-${id}`, project_path: null, cwd: null, branch: null,
    model: null, cli_version: null, is_sidechain: false, agent_id: null, starred,
    tags: [], notes: null, parent_conversation_id: null, children_count: 0,
    attach_state: { kind: 'historical', reason: 'no-session', resumable: false, can_fork: false, provider_session_id: null, checked_at: 1 },
  };
}

const pinnedOne = conversation('pin-1', 'Pinned one', true);
const pinnedTwo = conversation('pin-2', 'Pinned two', true);
const projectOne = conversation('project-1', 'Project one');
const projectTwo = conversation('project-2', 'Project two');

function group(overrides: Partial<ConversationSidebarGroup> & Pick<ConversationSidebarGroup, 'key' | 'kind' | 'label'>): ConversationSidebarGroup {
  return { total: 0, conversations: [], next_cursor: null, ...overrides };
}

function renderView(consoleSessions: ConsoleSession[] = []): void {
  render(<ConversationsView
    consoleSessions={consoleSessions}
    workRepos={[]}
    initialConversationId={null}
    initialSessionId={null}
    sidebarGroupLimit={1}
    onSelectSession={() => undefined}
    onNewSession={() => undefined}
  />);
}

describe('conversation sidebar groups', () => {
  it('advances only the requested opaque group cursor and places a semantic Show more after its final leaf', async () => {
    const requests: Array<Parameters<typeof api.getConversationSidebar>[0]> = [];
    vi.spyOn(api, 'getConversationSidebar').mockImplementation(async (params) => {
      requests.push(params);
      if (params.group_key === 'opaque:pinned') {
        return { limit: 1, groups: [group({ key: 'opaque:pinned', kind: 'pinned', label: 'Pinned', total: 2, conversations: [pinnedTwo], next_cursor: null })] };
      }
      if (params.group_key === 'opaque:project') {
        return { limit: 1, groups: [group({ key: 'opaque:project', kind: 'project', label: 'Mandible', total: 2, conversations: [projectTwo], next_cursor: null })] };
      }
      return { limit: 1, groups: [
        group({ key: 'opaque:pinned', kind: 'pinned', label: 'Pinned', total: 2, conversations: [pinnedOne], next_cursor: 'pin-cursor' }),
        group({ key: 'opaque:project', kind: 'project', label: 'Mandible', total: 2, conversations: [projectOne], next_cursor: 'project-cursor' }),
      ] };
    });
    renderView();

    const pinnedHeading = await screen.findByRole('button', { name: /^Pinned/ });
    const pinnedSection = pinnedHeading.closest('section') as HTMLElement;
    const showMore = within(pinnedSection).getByRole('button', { name: 'Show more' });
    expect(showMore.tagName).toBe('BUTTON');
    expect(showMore.tabIndex).toBe(0);
    showMore.focus();
    expect(document.activeElement).toBe(showMore);
    expect(pinnedSection.lastElementChild?.lastElementChild).toBe(showMore.parentElement);

    fireEvent.click(showMore);
    await screen.findByRole('button', { name: 'Open conversation Pinned two' });
    expect(requests.filter((request) => request.group_key)).toEqual([
      expect.objectContaining({ group_key: 'opaque:pinned', cursor: 'pin-cursor', limit: 1 }),
    ]);
    expect(screen.getByRole('button', { name: 'Open conversation Project one' })).toBeTruthy();
    expect(within(screen.getByRole('button', { name: /^Mandible/ }).closest('section') as HTMLElement)
      .getByRole('button', { name: 'Show more' })).toBeTruthy();
  });

  it('replays each current per-key target during filter reconciliation without losing selection', async () => {
    vi.useFakeTimers();
    const request = vi.spyOn(api, 'getConversationSidebar').mockImplementation(async (params) => {
      if (params.group_key === 'opaque:pinned') {
        return { limit: 1, groups: [group({ key: 'opaque:pinned', kind: 'pinned', label: 'Pinned', total: 2, conversations: [pinnedTwo], next_cursor: null })] };
      }
      return { limit: 1, groups: [group({ key: 'opaque:pinned', kind: 'pinned', label: 'Pinned', total: 2, conversations: [pinnedOne], next_cursor: 'pin-cursor' })] };
    });
    renderView();
    await vi.advanceTimersByTimeAsync(350);
    const first = screen.getByRole('button', { name: 'Open conversation Pinned one' });
    await waitFor(() => expect(first.getAttribute('aria-current')).toBe('true'));
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open conversation Pinned two' })).toBeTruthy());
    const heading = screen.getByRole('button', { name: /^Pinned/ });
    fireEvent.click(heading);

    fireEvent.input(screen.getByRole('textbox', { name: 'Search chats' }), { target: { value: 'Pinned' } });
    await vi.advanceTimersByTimeAsync(350);
    await waitFor(() => expect(request).toHaveBeenCalledWith(expect.objectContaining({
      group_key: 'opaque:pinned', cursor: 'pin-cursor', search: 'Pinned', limit: 1,
    })));
    expect(heading.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(heading);
    expect(screen.getByRole('button', { name: 'Open conversation Pinned one' }).getAttribute('aria-current')).toBe('true');
    expect(screen.getByRole('button', { name: 'Open conversation Pinned two' })).toBeTruthy();
  });

  it('uses a strict persisted setting range with a default of five', () => {
    expect(normalizeSidebarGroupLimit(undefined)).toBe(5);
    expect(normalizeSidebarGroupLimit('0')).toBe(1);
    expect(normalizeSidebarGroupLimit('99')).toBe(50);
    expect(normalizeSidebarGroupLimit('5 rows')).toBe(5);
  });

  it('patches a known visible row from SSE without resetting its expanded quota', async () => {
    FakeEventSource.instances = [];
    __resetSharedSseForTests(FakeEventSource as unknown as typeof EventSource);
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.spyOn(api, 'getConversationSidebar').mockImplementation(async (params) => {
      if (params.group_key) {
        return { limit: 1, groups: [group({ key: 'opaque:pinned', kind: 'pinned', label: 'Pinned', total: 2, conversations: [pinnedTwo], next_cursor: null })] };
      }
      return { limit: 1, groups: [group({ key: 'opaque:pinned', kind: 'pinned', label: 'Pinned', total: 2, conversations: [pinnedOne], next_cursor: 'pin-cursor' })] };
    });
    renderView();
    await screen.findByRole('button', { name: 'Open conversation Pinned one' });
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    await screen.findByRole('button', { name: 'Open conversation Pinned two' });

    FakeEventSource.instances[0].emit({
      type: 'conversation:updated',
      data: { id: pinnedOne.id, title: 'Pinned renamed', block_count: 3 },
    });
    await screen.findByRole('button', { name: 'Open conversation Pinned renamed' });
    expect(screen.getByRole('button', { name: 'Open conversation Pinned two' })).toBeTruthy();
  });

  it('deduplicates provider-backed live sessions, preserves sort, and consumes local overflow before another request', async () => {
    vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} });
    const serverConversation = { ...projectOne, session_id: 'provider-backed' };
    const sessions: ConsoleSession[] = [
      {
        id: 'live-backed', label: 'Already indexed', agent_type: 'codex', interaction_mode: 'direct',
        pinned: false, status: 'running', is_operator: false, provider_session_id: 'provider-backed',
        unread_count: 0, created_at: 3, started_at: 3, stopped_at: null,
        backend_type: 'sdk', transport_lane: 'sdk',
      },
      {
        id: 'live-local', label: 'Local live chat', agent_type: 'codex', interaction_mode: 'direct',
        pinned: false, status: 'running', is_operator: false, provider_session_id: null,
        unread_count: 0, created_at: 4, started_at: 4, stopped_at: null,
        backend_type: 'sdk', transport_lane: 'sdk',
      },
    ];
    const getSidebar = vi.spyOn(api, 'getConversationSidebar').mockResolvedValue({
      limit: 1,
      groups: [group({ key: 'opaque:chats', kind: 'chats', label: 'Chats', total: 1, conversations: [serverConversation], next_cursor: null })],
    });
    renderView(sessions);

    await screen.findByRole('button', { name: 'Open conversation Project one' });
    expect(screen.queryByRole('button', { name: 'Open session Local live chat' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open session Already indexed' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    await screen.findByRole('button', { name: 'Open session Local live chat' });
    expect(getSidebar).toHaveBeenCalledTimes(1);
  });
});
