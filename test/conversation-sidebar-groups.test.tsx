import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as api from '../ui/src/api.js';
import type { CanonicalProject, Conversation, ConversationSidebarGroup } from '../ui/src/api.js';
import { ConversationsView } from '../ui/src/views/conversations.js';
import { normalizeSidebarGroupLimit } from '../ui/src/components/shared/sidebar-group-settings.js';
import { __resetSharedSseForTests } from '../ui/src/sse-shared.js';
import type { ConsoleSession } from '../ui/src/state.js';
import { compareConversationSidebarRows } from '../src/conversations/sidebar-order.js';
import { normalizeChatViewState } from '../ui/src/views/conversation-view-state.js';

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

beforeEach(() => {
  const rows = new Map<string, string>();
  const storage = {
    get length() { return rows.size; },
    clear: () => rows.clear(),
    getItem: (key: string) => rows.get(key) ?? null,
    key: (index: number) => [...rows.keys()][index] ?? null,
    removeItem: (key: string) => rows.delete(key),
    setItem: (key: string, value: string) => rows.set(key, String(value)),
  } as Storage;
  Object.defineProperty(window, 'localStorage', { value: storage, configurable: true });
  vi.spyOn(api, 'listCanonicalProjects').mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
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

const canonicalProjects: CanonicalProject[] = [
  {
    id: 'prj-mandible', project_key: 'mandible', display_name: 'Mandible',
    checkouts: [
      { id: 'checkout-mandible', project_id: 'prj-mandible', work_repo_id: 'mandible', root: '/repos/mandible', name: 'Primary', default_branch: 'main', remote_url: '' },
      { id: 'checkout-mandible-alt', project_id: 'prj-mandible', work_repo_id: 'mandible-alt', root: '/repos/mandible-alt', name: 'Alternate', default_branch: 'main', remote_url: '' },
    ],
  },
  {
    id: 'prj-feedbax', project_key: 'feedbax', display_name: 'Feedbax',
    checkouts: [{ id: 'checkout-feedbax', project_id: 'prj-feedbax', work_repo_id: 'feedbax', root: '/repos/feedbax', name: 'Feedbax', default_branch: 'main', remote_url: '' }],
  },
];

function group(overrides: Partial<ConversationSidebarGroup> & Pick<ConversationSidebarGroup, 'key' | 'kind' | 'label'>): ConversationSidebarGroup {
  return { total: 0, conversations: [], next_cursor: null, ...overrides };
}

function renderView(consoleSessions: ConsoleSession[] = [], onNewSession = vi.fn()): void {
  render(<ConversationsView
    consoleSessions={consoleSessions}
    initialConversationId={null}
    initialSessionId={null}
    sidebarGroupLimit={1}
    onSelectSession={() => undefined}
    onNewSession={onNewSession}
  />);
}

describe('conversation sidebar groups', () => {
  it('normalizes canonical shown-project selections as bounded browser-local additive intent', () => {
    expect(normalizeChatViewState({ shownProjects: [
      { projectId: ' p1 ', checkoutId: ' c1 ' },
      { projectId: 'p1', checkoutId: 'c1' },
      { projectId: 'p1', checkoutId: 'c3' },
      { projectId: '', checkoutId: 'bad' },
      { projectId: 'p2', checkoutId: 'c2' },
    ] })).toMatchObject({
      shownProjects: [
        { projectId: 'p1', checkoutId: 'c3' },
        { projectId: 'p2', checkoutId: 'c2' },
      ],
      pinnedConversationIds: [],
      previewPinOverrides: {},
    });
  });

  it('advances only the requested pinned cursor and leaves the generic Chats cursor independent', async () => {
    const requests: Array<Parameters<typeof api.getConversationSidebar>[0]> = [];
    vi.spyOn(api, 'getConversationSidebar').mockImplementation(async (params) => {
      requests.push(params);
      if (params.group_key === 'opaque:pinned') {
        return { limit: 1, groups: [group({ key: 'opaque:pinned', kind: 'pinned', label: 'Pinned', total: 2, conversations: [pinnedTwo], next_cursor: null })] };
      }
      if (params.group_key === 'opaque:chats') {
        return { limit: 1, groups: [group({ key: 'opaque:chats', kind: 'chats', label: 'Chats', total: 2, conversations: [projectTwo], next_cursor: null })] };
      }
      return { limit: 1, groups: [
        group({ key: 'opaque:pinned', kind: 'pinned', label: 'Pinned', total: 2, conversations: [pinnedOne], next_cursor: 'pin-cursor' }),
        group({ key: 'opaque:chats', kind: 'chats', label: 'Chats', total: 2, conversations: [projectOne], next_cursor: 'chats-cursor' }),
      ] };
    });
    renderView();

    const pinnedHeading = await screen.findByRole('button', { name: /^Pinned/ });
    expect(pinnedHeading.querySelector('.sidebar-group-node__count')).toBeNull();
    expect(pinnedHeading.getAttribute('aria-description')).toBe('2 pinned chats');
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
    expect(within(screen.getByRole('button', { name: /^Chats/ }).closest('section') as HTMLElement)
      .getByRole('button', { name: 'Show more' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Projects' })).toBeNull();
  });

  it('maps agy live sessions to the accessible agy Chat provider dot', async () => {
    vi.spyOn(api, 'getConversationSidebar').mockResolvedValue({ limit: 1, groups: [] });
    vi.spyOn(api, 'listWorkflows').mockResolvedValue([]);
    vi.spyOn(api, 'getSessionIssues').mockResolvedValue([]);
    vi.spyOn(api, 'getSessionPresets').mockResolvedValue([]);
    const agySession: ConsoleSession = {
      id: 'agy-session', label: 'Agy review', agent_type: 'agy', interaction_mode: 'direct',
      pinned: false, status: 'running', is_operator: false, provider_session_id: 'agy-provider',
      command: 'agy', args: [], unread_count: 0, created_at: 1, started_at: 1, stopped_at: null,
      backend_type: 'acp', transport_lane: 'acp',
    };

    renderView([agySession]);
    const row = await screen.findByRole('button', { name: 'Open session Agy review' });
    expect(row.getAttribute('aria-description')).toBe('Provider: agy');
    expect(row.querySelector('.sidebar-item-row__badges')).toBeNull();
    const sharedRow = row.closest('.sidebar-item-row') as HTMLElement;
    expect(sharedRow.classList.contains('sidebar-item-row--selection-agy')).toBe(true);
    expect(within(sharedRow).getByRole('img', { name: 'Provider: agy' })
      .classList.contains('sidebar-item-row__provider-dot--agy')).toBe(true);
  });

  it('creates unscoped and exact-root chats and persists added empty project groups', async () => {
    const scopedProject = { ...projectOne, cwd: '/repos/mandible/packages/ui' };
    vi.mocked(api.listCanonicalProjects).mockResolvedValue(canonicalProjects);
    vi.spyOn(api, 'getConversationSidebar').mockResolvedValue({
      limit: 1,
      groups: [group({ key: 'opaque:chats', kind: 'chats', label: 'Chats', total: 1, conversations: [scopedProject] })],
    });
    vi.spyOn(api, 'getConversation').mockResolvedValue({ ...scopedProject, blocks: [], children: [], parent: null });
    vi.spyOn(api, 'listWorkflows').mockResolvedValue([]);
    vi.spyOn(api, 'getSessionIssues').mockResolvedValue([]);
    vi.spyOn(api, 'getSessionPresets').mockResolvedValue([]);
    const onNewSession = vi.fn();
    renderView([], onNewSession);

    const conversationRow = await screen.findByRole('button', { name: 'Open conversation Project one' });
    const chats = screen.getByRole('button', { name: /^Chats/ });
    expect(chats.closest('section')?.contains(conversationRow)).toBe(true);
    expect(screen.queryByRole('button', { name: 'New chat in Mandible' })).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Search chats' }).closest('.sidebar-search-filter')
      ?.querySelector('.sidebar-search-filter__leading-action')).toBeNull();
    const globalActions = screen.getByRole('region', { name: 'Chat actions' });
    fireEvent.click(within(globalActions).getByRole('button', { name: 'New chat' }));
    fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'Global chat' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create chat' }));
    expect(onNewSession).toHaveBeenLastCalledWith(expect.objectContaining({ label: 'Global chat', cwd: undefined }));

    fireEvent.click(screen.getByRole('button', { name: 'Projects' }));
    expect(screen.queryByRole('combobox', { name: 'Registered project' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add shown project' }));
    expect(within(screen.getByRole('combobox', { name: 'Registered project' })).getByRole('option', { name: 'Mandible — Primary (/repos/mandible)' })).toBeTruthy();
    expect(within(screen.getByRole('combobox', { name: 'Registered project' })).getByRole('option', { name: 'Mandible — Alternate (/repos/mandible-alt)' })).toBeTruthy();
    expect(within(screen.getByRole('combobox', { name: 'Registered project' })).getByRole('option', { name: 'Feedbax' })).toBeTruthy();
    fireEvent.input(screen.getByRole('combobox', { name: 'Registered project' }), { target: { value: 'prj-mandible:checkout-mandible' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.click(await screen.findByRole('button', { name: 'New chat in Mandible' }));
    fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'Scoped chat' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create chat' }));
    expect(onNewSession).toHaveBeenLastCalledWith(expect.objectContaining({ label: 'Scoped chat', cwd: '/repos/mandible' }));

    fireEvent.click(screen.getByRole('button', { name: 'Add shown project' }));
    fireEvent.input(screen.getByRole('combobox', { name: 'Registered project' }), { target: { value: 'prj-mandible:checkout-mandible-alt' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getAllByRole('button', { name: 'New chat in Mandible' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'New chat in Mandible' }));
    fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'Alternate scoped chat' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create chat' }));
    expect(onNewSession).toHaveBeenLastCalledWith(expect.objectContaining({ label: 'Alternate scoped chat', cwd: '/repos/mandible-alt' }));

    fireEvent.click(screen.getByRole('button', { name: 'Add shown project' }));
    fireEvent.input(screen.getByRole('combobox', { name: 'Registered project' }), { target: { value: 'prj-feedbax:checkout-feedbax' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByRole('button', { name: 'New chat in Feedbax' })).toBeTruthy();
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem('mandible.chat.viewState:v1') ?? '{}').shownProjects)
      .toEqual([
        { projectId: 'prj-mandible', checkoutId: 'checkout-mandible-alt' },
        { projectId: 'prj-feedbax', checkoutId: 'checkout-feedbax' },
      ]));
    expect(screen.getAllByRole('button', { name: /^New chat in / }).map((button) => button.getAttribute('aria-label')).sort())
      .toEqual(['New chat in Feedbax', 'New chat in Mandible']);
  });

  it('keeps conversation paths unscoped under Chats without a scanner-repo input surface', async () => {
    vi.mocked(api.listCanonicalProjects).mockResolvedValue(canonicalProjects);
    const unresolved = { ...projectOne, cwd: '/repos/mandible/packages/ui', project_path: '/repos/mandible' };
    vi.spyOn(api, 'getConversationSidebar').mockResolvedValue({
      limit: 1,
      groups: [group({ key: 'opaque:chats', kind: 'chats', label: 'Chats', total: 1, conversations: [unresolved] })],
    });
    renderView();
    const conversationRow = await screen.findByRole('button', { name: 'Open conversation Project one' });
    const chats = screen.getByRole('button', { name: /^Chats/ });
    expect(chats.closest('section')?.contains(conversationRow)).toBe(true);
    expect(screen.queryByRole('button', { name: /^Mandible/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'New chat in Mandible' })).toBeNull();
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

  it('keeps the rendered project prefix stable when a date continuation conflicts with ended time and title', async () => {
    const first = {
      ...projectOne,
      id: 'date-a',
      title: 'Zulu first',
      started_at: '2026-08-18T12:00:00.000Z',
      ended_at: '2026-08-18T12:01:00.000Z',
    };
    const second = {
      ...projectTwo,
      id: 'date-b',
      title: 'Alpha second',
      started_at: '2026-08-18T11:00:00.000Z',
      ended_at: '2026-08-18T13:00:00.000Z',
    };
    vi.spyOn(api, 'getConversationSidebar').mockImplementation(async (params) => (
      params.group_key
        ? { limit: 1, groups: [group({ key: 'opaque:chats', kind: 'chats', label: 'Chats', total: 2, conversations: [second], next_cursor: null })] }
        : { limit: 1, groups: [group({ key: 'opaque:chats', kind: 'chats', label: 'Chats', total: 2, conversations: [first], next_cursor: 'date-cursor' })] }
    ));
    renderView();

    const original = await screen.findByRole('button', { name: 'Open conversation Zulu first' });
    const section = screen.getByRole('button', { name: /^Chats/ }).closest('section') as HTMLElement;
    await waitFor(() => expect(original.getAttribute('aria-current')).toBe('true'));
    const originalHtml = original.outerHTML;
    fireEvent.click(within(section).getByRole('button', { name: 'Show more' }));
    await within(section).findByRole('button', { name: 'Open conversation Alpha second' });

    const rows = within(section).getAllByRole('button', { name: /^Open conversation/ });
    expect(rows.map((row) => row.getAttribute('aria-label'))).toEqual([
      'Open conversation Zulu first',
      'Open conversation Alpha second',
    ]);
    expect(rows[0]).toBe(original);
    expect(rows[0].outerHTML).toBe(originalHtml);
  });

  it('uses id order for block-count ties and refetches only for a true sort-key update', async () => {
    FakeEventSource.instances = [];
    __resetSharedSseForTests(FakeEventSource as unknown as typeof EventSource);
    vi.stubGlobal('EventSource', FakeEventSource);
    const first = { ...projectOne, id: 'block-a', title: 'Zulu first', block_count: 4, started_at: '2026-08-18T14:00:00.000Z' };
    const second = { ...projectTwo, id: 'block-b', title: 'Alpha second', block_count: 4, started_at: '2026-08-18T13:00:00.000Z' };
    expect(compareConversationSidebarRows(first, second, 'block_count')).toBeLessThan(0);
    const getSidebar = vi.spyOn(api, 'getConversationSidebar').mockImplementation(async (params) => (
      params.group_key
        ? { limit: 1, groups: [group({ key: 'opaque:chats', kind: 'chats', label: 'Chats', total: 2, conversations: [second], next_cursor: null })] }
        : { limit: 1, groups: [group({ key: 'opaque:chats', kind: 'chats', label: 'Chats', total: 2, conversations: [first], next_cursor: 'block-cursor' })] }
    ));
    renderView();
    await screen.findByRole('button', { name: 'Open conversation Zulu first' });
    const section = screen.getByRole('button', { name: /^Chats/ }).closest('section') as HTMLElement;
    fireEvent.click(within(section).getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(within(section).getByRole('button', { name: 'Open conversation Alpha second' })).toBeTruthy());
    expect(within(section).getAllByRole('button', { name: /^Open conversation/ }).map((row) => row.getAttribute('aria-label')))
      .toEqual(['Open conversation Zulu first', 'Open conversation Alpha second']);
    expect(getSidebar).toHaveBeenCalledTimes(2);

    FakeEventSource.instances[0].emit({
      type: 'conversation:updated',
      data: { id: first.id, block_count: 4, started_at: '2026-08-18T12:00:00.000Z' },
    });
    await waitFor(() => expect(getSidebar).toHaveBeenCalledTimes(4), { timeout: 1500 });
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
