import { readFileSync } from 'node:fs';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { QueryClientProvider } from '@tanstack/preact-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as api from '../../ui/src/api.js';
import type {
  CanonicalProject,
  ConversationControlSnapshot,
  ConversationSpawnReceipt,
  ConversationSidebarConversation,
  ConversationSidebarGroup,
  InstanceInfo,
} from '../../ui/src/api.js';
import { ConversationsView, getConversationTitle } from '../../ui/src/views/conversations.js';
import { normalizeSidebarGroupLimit } from '../../ui/src/components/shared/sidebar-group-settings.js';
import { __resetSharedSseForTests } from '../../ui/src/sse-shared.js';
import type { ConsoleSession } from '../../ui/src/state.js';
import { compareConversationSidebarRows } from '../../src/conversations/sidebar-order.js';
import { normalizeChatViewState, reconcileShownProjects } from '../../ui/src/views/conversation-view-state.js';
import { queryClient } from '../../ui/src/query/client.js';
import { applyConversationSse } from '../../ui/src/query/conversationSse.js';

const chatHistoryStylesheet = [
  'ui/src/styles/chat-history.css',
  'ui/src/styles/sidebar-group-node.css',
].map((path) => readFileSync(path, 'utf8')).join('\n');

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
  queryClient.clear();
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
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
  vi.spyOn(api, 'getChatShownProjectsPreference').mockResolvedValue({
    version: 1, key: 'chat_shown_projects', value: [], revision: 0,
  });
  vi.spyOn(api, 'updateChatShownProjectsPreference').mockImplementation(async (value, revision) => ({
    version: 1, key: 'chat_shown_projects', value, revision: revision + 1,
  }));
  vi.spyOn(api, 'getSidebarOrderPreference').mockResolvedValue({
    version: 1, key: 'sidebar_order', value: { pinnedConversationIds: null, briefingTopLevelIds: null }, revision: 0,
  });
  vi.spyOn(api, 'updateSidebarOrderPreference').mockImplementation(async (value, revision) => ({
    version: 1, key: 'sidebar_order', value, revision: revision + 1,
  }));
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  __resetSharedSseForTests();
  vi.unstubAllGlobals();
});

function conversation(id: string, title: string, starred = false): ConversationSidebarConversation {
  return {
    id, source: 'codex', source_path: `/tmp/${id}.jsonl`, title, summary: null,
    started_at: '2026-08-18T12:00:00.000Z', ended_at: null, block_count: 2,
    session_id: `session-${id}`, project_path: null, cwd: null, branch: null,
    model: null, cli_version: null, is_sidechain: false, agent_id: null, starred,
    tags: [], notes: null, parent_conversation_id: null, children_count: 0,
    canonical_project_id: null, canonical_project_key: null,
  };
}

const pinnedOne = conversation('pin-1', 'Pinned one', true);
const pinnedTwo = conversation('pin-2', 'Pinned two', true);
const projectOne = conversation('project-1', 'Project one');
const projectTwo = conversation('project-2', 'Project two');

function spawnReceipt(
  id: string,
  provider: 'codex' | 'claude_code',
  placement: { kind: 'projectless' } | { kind: 'project'; project_id: string; checkout_id: string },
  state: 'starting' | 'ready' = 'starting',
): ConversationSpawnReceipt {
  return {
    schema: 'mandible-conversation-spawn-receipt@3',
    reservation_id: id,
    request: {
      schema: 'mandible-conversation-spawn-request@3',
      idempotency_key: id,
      provider,
      placement,
    },
    state,
    attempt_count: 1,
    native_session_id: state === 'ready' ? `controller-${id}` : null,
    provider_session_id: state === 'ready' ? `provider-${id}` : null,
    provider_receipt: null,
    error: null,
    created_at: 1,
    updated_at: state === 'ready' ? 2 : 1,
  };
}

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

const rejectModePreview: InstanceInfo = {
  role: 'preview',
  operational_mutations: 'reject',
  operational_mutations_overridden: true,
  db_path: '/tmp/mandible-preview.db',
  db_path_source: 'iab-preview-copy',
};

function group(overrides: Partial<ConversationSidebarGroup> & Pick<ConversationSidebarGroup, 'key' | 'kind' | 'label'>): ConversationSidebarGroup {
  return { total: 0, conversations: [], next_cursor: null, ...overrides };
}

function renderView(
  consoleSessions: ConsoleSession[] = [],
  onNewConversation = vi.fn(),
  instance: InstanceInfo | null = null,
  sidebarGroupLimit = 1,
): void {
  render(
    <QueryClientProvider client={queryClient}>
      <ConversationsView
        consoleSessions={consoleSessions}
        initialConversationId={null}
        initialSessionId={null}
        sidebarGroupLimit={sidebarGroupLimit}
        instance={instance}
        onSelectSession={() => undefined}
        onNewConversation={onNewConversation}
      />
    </QueryClientProvider>,
  );
}

describe('conversation sidebar groups', () => {
  it('never exposes raw provider ids or machine envelopes as conversation titles', () => {
    expect(getConversationTitle(conversation('raw-id', '01a05d81-ba7c-7a63-b593-1e87e2bd8e3d <in'))).toBe('Codex chat');
    expect(getConversationTitle(conversation('envelope', '<codex_delegation>\n<source_thread_id>01a05d81</source_thread_id>'))).toBe('Codex chat');
    expect(getConversationTitle(conversation('normal', 'Feedbax remediation'))).toBe('Feedbax remediation');
  });

  it('retries an unavailable project selection without exposing connectivity state', async () => {
    vi.mocked(api.listCanonicalProjects).mockResolvedValue(canonicalProjects);
    vi.mocked(api.getChatShownProjectsPreference).mockRejectedValue(new Error('offline'));
    vi.spyOn(api, 'getConversationSidebar').mockResolvedValue({ limit: 1, groups: [] });

    renderView();

    const emptyState = await screen.findByText('No projects included');
    expect(emptyState.classList.contains('sidebar-group-node__placeholder')).toBe(true);
    expect(emptyState.textContent).toBe('No projects included');
    expect(emptyState.getAttribute('role')).toBeNull();
    expect(screen.queryByText(/available/i)).toBeNull();
    expect(screen.queryByText(/\d+ available/i)).toBeNull();
    expect(screen.queryByText(/shared host preference/i)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add Project' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Add project' })).toBeTruthy();
    expect(document.querySelector('#chat-projects-body')?.contains(emptyState)).toBe(true);
  });

  it('sends bounded deduplicated full canonical project ids on the wire', async () => {
    const projectIds = Array.from({ length: 502 }, (_, index) => `prj-full-${index}`);
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ limit: 1, groups: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await api.getConversationSidebar({
      limit: 1,
      project_ids: [` ${projectIds[0]} `, projectIds[0], ...projectIds.slice(1)],
    });

    const requestUrl = new URL(String(fetchMock.mock.calls[0][0]), 'http://localhost');
    const sentProjectIds = requestUrl.searchParams.get('project_ids')?.split(',') ?? [];
    expect(sentProjectIds).toHaveLength(500);
    expect(sentProjectIds.slice(0, 2)).toEqual(['prj-full-0', 'prj-full-1']);
    expect(sentProjectIds.at(-1)).toBe('prj-full-499');
  });

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
      lastSelection: null,
    });
  });

  it('normalizes the last durable Chat selection without persisting drafts', () => {
    expect(normalizeChatViewState({
      lastSelection: { type: 'conversation', id: ' conversation-1 ' },
    }).lastSelection).toEqual({ type: 'conversation', id: 'conversation-1' });
    expect(normalizeChatViewState({
      lastSelection: { type: 'draft', id: 'draft-1' },
    }).lastSelection).toBeNull();
  });

  it('preserves selected projects when their checkout identity changes', () => {
    expect(reconcileShownProjects([
      { projectId: 'prj-mandible', checkoutId: 'checkout-retired' },
      { projectId: 'prj-feedbax', checkoutId: 'checkout-feedbax' },
      { projectId: 'prj-removed', checkoutId: 'checkout-removed' },
    ], canonicalProjects)).toEqual([
      { projectId: 'prj-mandible', checkoutId: 'checkout-mandible' },
      { projectId: 'prj-feedbax', checkoutId: 'checkout-feedbax' },
    ]);
  });

  it('drops removed registry selections without requesting or manufacturing their groups', async () => {
    vi.mocked(api.listCanonicalProjects).mockResolvedValue(canonicalProjects);
    window.localStorage.setItem('mandible.chat.viewState:v1', JSON.stringify({
      shownProjects: [{ projectId: 'prj-removed', checkoutId: 'checkout-removed' }],
    }));
    const requests: Array<Parameters<typeof api.getConversationSidebar>[0]> = [];
    vi.spyOn(api, 'getConversationSidebar').mockImplementation(async (params) => {
      requests.push(params);
      return { limit: 1, groups: [] };
    });
    renderView();

    await waitFor(() => expect(api.updateChatShownProjectsPreference).toHaveBeenLastCalledWith([], 1));
    await waitFor(() => expect(requests.length).toBeGreaterThan(0));
    expect(requests.every((request) => !request.project_ids?.includes('prj-removed'))).toBe(true);
    expect(screen.queryByRole('button', { name: /^Removed/ })).toBeNull();
  });

  it('advances only the requested pinned cursor and leaves the generic Chats cursor independent', async () => {
    vi.mocked(api.listCanonicalProjects).mockResolvedValue(canonicalProjects);
    window.localStorage.setItem('mandible.chat.viewState:v1', JSON.stringify({
      shownProjects: [{ projectId: 'prj-mandible', checkoutId: 'checkout-mandible' }],
    }));
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

    await waitFor(() => expect(requests).toContainEqual(expect.objectContaining({
      project_ids: ['prj-mandible'],
    })));

    const pinnedHeading = await screen.findByRole('button', { name: /^Pinned/ });
    expect(pinnedHeading.querySelector('.sidebar-group-node__count')).toBeNull();
    expect(pinnedHeading.getAttribute('aria-description')).toBe('2 pinned chats');
    const pinnedSection = pinnedHeading.closest('section') as HTMLElement;
    const showMore = within(pinnedSection).getByRole('button', { name: 'Show more' });
    expect(showMore.tagName).toBe('BUTTON');
    expect(showMore.tabIndex).toBe(0);
    showMore.focus();
    expect(document.activeElement).toBe(showMore);
    const pinnedBody = document.getElementById(pinnedHeading.getAttribute('aria-controls') ?? '');
    expect(pinnedBody).not.toBeNull();
    expect(within(pinnedBody as HTMLElement).getByRole('button', { name: 'Show more' })).toBe(showMore);
    expect(pinnedBody?.querySelector('.sidebar-group-node__show-more-row')).toBe(showMore.parentElement);

    fireEvent.click(showMore);
    await screen.findByRole('button', { name: 'Open conversation Pinned two' });
    expect(requests.filter((request) => request.group_key)).toEqual([
      expect.objectContaining({
        group_key: 'opaque:pinned', cursor: 'pin-cursor', limit: 1,
        project_ids: ['prj-mandible'],
      }),
    ]);
    expect(screen.getByRole('button', { name: 'Open conversation Project one' })).toBeTruthy();
    expect(within(screen.getByRole('button', { name: /^Chats/ }).closest('section') as HTMLElement)
      .getByRole('button', { name: 'Show more' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Projects' })).toBeTruthy();
  });

  it('preserves accessible agy identity without inventing an unofficial provider mark', async () => {
    vi.spyOn(api, 'getConversationSidebar').mockResolvedValue({ limit: 1, groups: [] });
    vi.spyOn(api, 'listWorkflows').mockResolvedValue([]);
    vi.spyOn(api, 'getSessionIssues').mockResolvedValue([]);
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
    expect([...sharedRow.classList].some((className) => className.startsWith('sidebar-item-row--selection-'))).toBe(false);
    expect(within(sharedRow).queryByRole('img', { name: 'Provider: agy' })).toBeNull();
  });

  it('adds a canonical project and immediately consumes its pre-existing multi-provider server group', async () => {
    const codex = { ...projectOne, title: 'Existing Codex', canonical_project_id: 'prj-mandible', canonical_project_key: 'mandible' };
    const claude = { ...conversation('claude-existing', 'Existing Claude'), source: 'claude_code' as const, canonical_project_id: 'prj-mandible', canonical_project_key: 'mandible' };
    const agy = { ...conversation('agy-existing', 'Existing agy'), source: 'gemini' as const, canonical_project_id: 'prj-mandible', canonical_project_key: 'mandible' };
    vi.mocked(api.listCanonicalProjects).mockResolvedValue(canonicalProjects);
    const requests: Array<Parameters<typeof api.getConversationSidebar>[0]> = [];
    vi.spyOn(api, 'getConversationSidebar').mockImplementation(async (params) => {
      requests.push(params);
      if (params.project_ids?.includes('prj-mandible')) {
        return {
          limit: 1,
          groups: [group({
            key: 'opaque:project:mandible', kind: 'project', label: 'Mandible',
            project_id: 'prj-mandible', project_key: 'mandible', total: 3,
            conversations: [codex, claude, agy],
          })],
        };
      }
      return { limit: 1, groups: [] };
    });
    const createdId = '10000000-0000-4000-8000-000000000001';
    const placement = { kind: 'project' as const, project_id: 'prj-mandible', checkout_id: 'checkout-mandible' };
    const onNewConversation = vi.fn().mockResolvedValue({ conversation_id: createdId, spawn: spawnReceipt(createdId, 'codex', placement) });
    renderView([], onNewConversation, null, 5);

    expect(screen.queryByRole('button', { name: 'New chat in Mandible' })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Add project' }));
    expect(within(screen.getByRole('combobox', { name: 'Registered project' })).getAllByRole('option'))
      .toHaveLength(canonicalProjects.length);
    expect(screen.queryByText(/mandible-alt|worktrees|\/repos\//i)).toBeNull();
    fireEvent.input(screen.getByRole('combobox', { name: 'Registered project' }), { target: { value: 'prj-mandible:checkout-mandible' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    const projectHeading = await screen.findByRole('button', { name: /^Mandible/ });
    const projectSection = projectHeading.closest('section') as HTMLElement;
    const codexRow = within(projectSection).getByRole('button', { name: 'Open conversation Existing Codex' });
    const claudeRow = within(projectSection).getByRole('button', { name: 'Open conversation Existing Claude' });
    const agyRow = within(projectSection).getByRole('button', { name: 'Open conversation Existing agy' });
    expect(within(codexRow.closest('.sidebar-item-row') as HTMLElement)
      .getByRole('img', { name: 'Provider: Codex' }).getAttribute('viewBox')).toBe('0 0 721 721');
    expect(within(claudeRow.closest('.sidebar-item-row') as HTMLElement)
      .getByRole('img', { name: 'Provider: Claude' }).getAttribute('viewBox')).toBe('0 0 92 64');
    expect(agyRow.getAttribute('aria-description')).toBe('Provider: agy');
    expect(within(agyRow.closest('.sidebar-item-row') as HTMLElement)
      .queryByRole('img', { name: 'Provider: agy' })).toBeNull();
    expect(requests).toContainEqual(expect.objectContaining({ project_ids: ['prj-mandible'] }));
    expect(onNewConversation).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByRole('button', { name: 'New chat in Mandible' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Start with Codex (OpenAI)' }));
    expect(onNewConversation).toHaveBeenLastCalledWith(expect.objectContaining({
      provider: 'codex',
      placement: {
        kind: 'project',
        project_id: 'prj-mandible',
        checkout_id: 'checkout-mandible',
      },
    }), expect.any(AbortSignal));
    await waitFor(() => expect(api.updateChatShownProjectsPreference).toHaveBeenLastCalledWith(
      [{ projectId: 'prj-mandible', checkoutId: 'checkout-mandible' }],
      expect.any(Number),
    ));
  });

  it('creates top-level Chat intent only in Chats with explicit projectless placement', async () => {
    vi.mocked(api.listCanonicalProjects).mockResolvedValue(canonicalProjects);
    vi.spyOn(api, 'getConversationSidebar').mockResolvedValue({
      limit: 5,
      groups: [group({ key: 'opaque:chats', kind: 'chats', label: 'Chats' })],
    });
    const createdId = '10000000-0000-4000-8000-000000000002';
    const placement = { kind: 'projectless' as const };
    const onNewConversation = vi.fn().mockResolvedValue({ conversation_id: createdId, spawn: spawnReceipt(createdId, 'claude_code', placement) });
    renderView([], onNewConversation, null, 5);

    fireEvent.click(within(screen.getByRole('region', { name: 'Chat actions' })).getByRole('button', { name: 'New chat' }));
    const chatsSection = screen.getByRole('button', { name: /^Chats/ }).closest('section') as HTMLElement;
    expect(within(chatsSection).getByRole('button', { name: 'Open new chat draft' })).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Start with Claude' }));
    expect(onNewConversation).toHaveBeenLastCalledWith(expect.objectContaining({
      provider: 'claude_code',
      placement: { kind: 'projectless' },
    }), expect.any(AbortSignal));
  });

  it('shows the ordinary conversation composer immediately while provider startup is still being requested', async () => {
    vi.spyOn(api, 'getConversationSidebar').mockResolvedValue({
      limit: 5,
      groups: [group({ key: 'opaque:chats', kind: 'chats', label: 'Chats' })],
    });
    vi.spyOn(api, 'getProviderChat').mockImplementation(() => new Promise(() => undefined));
    const onNewConversation = vi.fn().mockImplementation(() => new Promise(() => undefined));
    renderView([], onNewConversation, null, 5);

    fireEvent.click(within(screen.getByRole('region', { name: 'Chat actions' })).getByRole('button', { name: 'New chat' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Start with Codex (OpenAI)' }));

    expect(await screen.findByPlaceholderText('Message...')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open conversation New Codex chat' }).getAttribute('aria-current')).toBe('true');
    expect(screen.queryByRole('dialog', { name: 'Choose a provider for the new chat' })).toBeNull();
    expect(screen.queryByText('Starting provider…')).toBeNull();
  });

  it.each([
    ['codex', 'projectless', 'click'],
    ['claude_code', 'projectless', 'return'],
    ['codex', 'project', 'return'],
    ['claude_code', 'project', 'click'],
  ] as const)('keeps one accepted %s %s identity through readiness and its immediate first submit', async (provider, placementKind, submitKind) => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    const sseFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/client-auth/whoami') {
        return new Response(JSON.stringify({ authenticated: true, session: {
          family_id: 'spawn-reconcile-test', audience: 'production', csrf_token: 'csrf',
          effect_ceiling: ['ledger:read'],
        } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
          init?.signal?.addEventListener('abort', () => controller.close(), { once: true });
        },
      }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    });
    __resetSharedSseForTests(sseFetch as typeof fetch);
    vi.mocked(api.listCanonicalProjects).mockResolvedValue(canonicalProjects);
    const id = `10000000-0000-4000-8000-0000000000${provider === 'codex' ? '1' : '2'}${placementKind === 'project' ? '1' : '0'}`;
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(id as `${string}-${string}-${string}-${string}-${string}`);
    const placement = placementKind === 'project'
      ? { kind: 'project' as const, project_id: 'prj-mandible', checkout_id: 'checkout-mandible' }
      : { kind: 'projectless' as const };
    if (placementKind === 'project') {
      window.localStorage.setItem('mandible.chat.viewState:v1', JSON.stringify({
        shownProjects: [{ projectId: 'prj-mandible', checkoutId: 'checkout-mandible' }],
      }));
    }
    vi.spyOn(api, 'getConversationSidebar').mockResolvedValue({
      limit: 5,
      groups: [group({
        key: placementKind === 'project' ? 'opaque:project:mandible' : 'opaque:chats',
        kind: placementKind === 'project' ? 'project' : 'chats',
        label: placementKind === 'project' ? 'Mandible' : 'Chats',
        ...(placementKind === 'project' ? { project_id: 'prj-mandible', project_key: 'mandible' } : {}),
      })],
    });
    vi.spyOn(api, 'getProviderChat').mockImplementation(() => new Promise(() => undefined));
    const readyControl: ConversationControlSnapshot = {
      conversation_id: id,
      provider,
      provider_session_id: `provider-${id}`,
      provider_mode: 'app-server-managed',
      provider_capabilities: null,
      revision: 1,
      ownership: {
        kind: 'mandible', generation: 1, controller_instance_id: `controller-${id}`,
        adapter_id: provider, provider_session_id: `provider-${id}`, last_authoritative_signal: 2,
      },
      controller: { kind: 'ready', since: 2 },
      turn: { kind: 'none' },
      capability: { kind: 'live-send', revision: 1, generation: 1 },
      updated_at: 2,
    };
    vi.spyOn(api, 'getConversationControl').mockResolvedValue(readyControl);
    vi.spyOn(api, 'getConversationLiveProjection').mockRejectedValue(new Error('No projection yet'));
    const scopedConversation = {
      ...conversation(id, ''),
      source: provider,
      session_id: `provider-${id}`,
      canonical_project_id: placementKind === 'project' ? 'prj-mandible' : null,
      canonical_project_key: placementKind === 'project' ? 'mandible' : null,
    };
    vi.spyOn(api, 'getConversationWindow').mockResolvedValue({
      conversation: scopedConversation,
      body_source: 'legacy', source_version_id: null, blocks: [], children: [], parent: null, revision: 0, total: 0,
      target: { kind: 'initial', requested_value: null, position: null, block_id: null, turn_id: null },
      window: { start_position: null, end_position: null, has_before: false, has_after: false, after_count: 0, limit: 160 },
    });
    const submit = vi.spyOn(api, 'submitConversationControl').mockResolvedValue({
      kind: 'accepted', delivery_id: `delivery-${id}`, turn_id: `turn-${id}`, snapshot: readyControl,
    });
    const onNewConversation = vi.fn().mockResolvedValue({ conversation_id: id, spawn: spawnReceipt(id, provider, placement) });
    renderView([], onNewConversation, null, 5);

    const newChat = placementKind === 'project'
      ? await screen.findByRole('button', { name: 'New chat in Mandible' })
      : within(screen.getByRole('region', { name: 'Chat actions' })).getByRole('button', { name: 'New chat' });
    fireEvent.click(newChat);
    fireEvent.click(await screen.findByRole('button', { name: provider === 'codex' ? 'Start with Codex (OpenAI)' : 'Start with Claude' }));
    const row = await screen.findByRole('button', { name: provider === 'codex' ? 'Open conversation New Codex chat' : 'Open conversation New Claude chat' });
    expect(row.getAttribute('aria-current')).toBe('true');
    const composer = await screen.findByPlaceholderText('Message...') as HTMLTextAreaElement;
    const transcript = document.querySelector('.conv-transcript');
    expect(transcript).toBeTruthy();
    expect(transcript?.querySelectorAll('[data-chat-event]').length).toBe(0);
    fireEvent.input(composer, { target: { value: 'First message' } });
    if (submitKind === 'return') fireEvent.keyDown(composer, { key: 'Enter' });
    else fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('First message')).toBeTruthy();
    expect(submit).not.toHaveBeenCalled();

    await waitFor(() => expect(streamController).not.toBeNull());
    streamController?.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({
      type: 'conversation-spawn:updated', data: { spawn: spawnReceipt(id, provider, placement, 'ready') },
    })}\n\n`));
    expect(await screen.findByPlaceholderText('Message...')).toBe(composer);
    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({ conversation_id: id }),
      'First message',
      undefined,
      expect.any(Object),
      expect.any(String),
    );
    expect(composer.value).toBe('');
  });

  it('cannot manufacture a project group from a legacy directory label or path', async () => {
    vi.mocked(api.listCanonicalProjects).mockResolvedValue(canonicalProjects);
    const unresolved = {
      ...projectOne,
      title: '-Users-mll-Main-10-Projects-05-Utils-mandible',
      cwd: '/repos/mandible/packages/ui',
      project_path: '/repos/mandible',
      source_path: '/provider/-Users-mll-Main-10-Projects-05-Utils-mandible/project-1.jsonl',
    };
    vi.spyOn(api, 'getConversationSidebar').mockResolvedValue({
      limit: 1,
      groups: [group({ key: 'opaque:chats', kind: 'chats', label: 'Chats', total: 1, conversations: [unresolved] })],
    });
    renderView();
    const conversationRow = await screen.findByRole('button', {
      name: 'Open conversation Users-mll-Main-10-Projects-05-Utils-mandible',
    });
    const chats = screen.getByRole('button', { name: /^Chats/ });
    expect(chats.closest('section')?.contains(conversationRow)).toBe(true);
    expect(screen.queryByRole('button', { name: /^Mandible/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'New chat in Mandible' })).toBeNull();
  });

  it('keeps preview pin overrides local and rehomes unpinned rows to their selected canonical server group', async () => {
    vi.mocked(api.listCanonicalProjects).mockResolvedValue(canonicalProjects);
    window.localStorage.setItem('mandible.chat.viewState:v1', JSON.stringify({
      shownProjects: [{ projectId: 'prj-mandible', checkoutId: 'checkout-mandible' }],
    }));
    const projectConversation = {
      ...projectOne,
      canonical_project_id: 'prj-mandible',
      canonical_project_key: 'mandible',
    };
    vi.spyOn(api, 'getConversationSidebar').mockResolvedValue({
      limit: 1,
      groups: [group({
        key: 'opaque:project:mandible', kind: 'project', label: 'Mandible',
        project_id: 'prj-mandible', project_key: 'mandible', total: 1,
        conversations: [projectConversation],
      })],
    });
    const updateConversation = vi.spyOn(api, 'updateConversation');
    renderView([], vi.fn(), rejectModePreview);

    const projectHeading = await screen.findByRole('button', { name: /^Mandible/ });
    const projectSection = projectHeading.closest('section') as HTMLElement;
    fireEvent.click(within(projectSection).getByRole('button', { name: 'Pin Project one' }));
    const pinnedSection = (await screen.findByRole('button', { name: /^Pinned/ })).closest('section') as HTMLElement;
    expect(within(pinnedSection).getByRole('button', { name: 'Open conversation Project one' })).toBeTruthy();

    fireEvent.click(within(pinnedSection).getByRole('button', { name: 'Unpin Project one' }));
    expect(await within(projectSection).findByRole('button', { name: 'Open conversation Project one' })).toBeTruthy();
    expect(updateConversation).not.toHaveBeenCalled();
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem('mandible.chat.viewState:v1') ?? '{}')).toMatchObject({
      previewPinOverrides: { [projectConversation.id]: false },
    }));
  });

  it('refetches membership-changing SSE updates with the selected canonical project ids intact', async () => {
    FakeEventSource.instances = [];
    __resetSharedSseForTests(FakeEventSource as unknown as typeof EventSource);
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.mocked(api.listCanonicalProjects).mockResolvedValue(canonicalProjects);
    window.localStorage.setItem('mandible.chat.viewState:v1', JSON.stringify({
      shownProjects: [{ projectId: 'prj-mandible', checkoutId: 'checkout-mandible' }],
    }));
    const canonicalRow = {
      ...projectOne,
      canonical_project_id: 'prj-mandible',
      canonical_project_key: 'mandible',
    };
    const requests: Array<Parameters<typeof api.getConversationSidebar>[0]> = [];
    vi.spyOn(api, 'getConversationSidebar').mockImplementation(async (params) => {
      requests.push(params);
      return {
        limit: 1,
        groups: [group({
          key: 'opaque:project:mandible', kind: 'project', label: 'Mandible',
          project_id: 'prj-mandible', project_key: 'mandible', total: 1,
          conversations: [canonicalRow],
        })],
      };
    });
    renderView();
    await screen.findByRole('button', { name: 'Open conversation Project one' });
    await waitFor(() => expect(requests).toContainEqual(expect.objectContaining({
      project_ids: ['prj-mandible'],
    })));
    const priorRequestCount = requests.length;

    applyConversationSse(queryClient, 'conversation:updated', {
      id: canonicalRow.id,
      block_count: canonicalRow.block_count,
      canonical_project_id: null,
    });
    await waitFor(() => expect(requests.length).toBeGreaterThan(priorRequestCount), { timeout: 1600 });
    expect(requests.at(-1)).toEqual(expect.objectContaining({ project_ids: ['prj-mandible'] }));
  });

  it('replays each current per-key target during filter reconciliation without losing selection', async () => {
    vi.useFakeTimers();
    vi.mocked(api.listCanonicalProjects).mockResolvedValue(canonicalProjects);
    window.localStorage.setItem('mandible.chat.viewState:v1', JSON.stringify({
      shownProjects: [{ projectId: 'prj-mandible', checkoutId: 'checkout-mandible' }],
    }));
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
      project_ids: ['prj-mandible'],
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

    applyConversationSse(queryClient, 'conversation:updated', {
      id: pinnedOne.id,
      title: 'Pinned renamed',
      block_count: 3,
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

    applyConversationSse(queryClient, 'conversation:updated', {
      id: first.id,
      block_count: 4,
      started_at: '2026-08-18T12:00:00.000Z',
    });
    await waitFor(() => expect(getSidebar).toHaveBeenCalledTimes(3), { timeout: 1500 });
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

  it('keeps reservation-backed provisional rows in their canonical group through indexed reconciliation', async () => {
    FakeEventSource.instances = [];
    __resetSharedSseForTests(FakeEventSource as unknown as typeof EventSource);
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.mocked(api.listCanonicalProjects).mockResolvedValue(canonicalProjects);
    window.localStorage.setItem('mandible.chat.viewState:v1', JSON.stringify({
      shownProjects: [{ projectId: 'prj-mandible', checkoutId: 'checkout-mandible' }],
    }));
    let indexed = false;
    const indexedConversation = {
      ...conversation('indexed-reserved', 'Reserved chat'),
      session_id: 'provider-reserved',
      canonical_project_id: 'prj-mandible',
      canonical_project_key: 'mandible',
    };
    vi.spyOn(api, 'getConversationSidebar').mockImplementation(async () => ({
      limit: 5,
      groups: [
        group({
          key: 'opaque:project:mandible', kind: 'project', label: 'Mandible',
          project_id: 'prj-mandible', project_key: 'mandible',
          total: indexed ? 1 : 0,
          conversations: indexed ? [indexedConversation] : [],
        }),
        group({ key: 'opaque:chats', kind: 'chats', label: 'Chats' }),
      ],
    }));
    const sessions: ConsoleSession[] = [
      {
        id: 'reservation-scoped', label: 'Reserved chat', agent_type: 'codex', interaction_mode: 'direct',
        pinned: false, status: 'running', is_operator: false, provider_session_id: 'provider-reserved',
        canonical_project_id: 'prj-mandible', canonical_checkout_id: 'checkout-mandible',
        unread_count: 0, created_at: 10, started_at: 10, stopped_at: null,
        backend_type: 'acp', transport_lane: 'acp',
      },
      {
        id: 'reservation-unscoped', label: 'Unscoped chat', agent_type: 'codex', interaction_mode: 'direct',
        pinned: false, status: 'running', is_operator: false, provider_session_id: null,
        canonical_project_id: null, canonical_checkout_id: null,
        unread_count: 0, created_at: 9, started_at: 9, stopped_at: null,
        backend_type: 'acp', transport_lane: 'acp',
      },
    ];
    renderView(sessions, vi.fn(), null, 5);

    const projectSection = (await screen.findByRole('button', { name: /^Mandible/ })).closest('section') as HTMLElement;
    const chatsSection = screen.getByRole('button', { name: /^Chats/ }).closest('section') as HTMLElement;
    const provisionalRow = within(projectSection).getByRole('button', { name: 'Open session Reserved chat' });
    expect(within(chatsSection).getByRole('button', { name: 'Open session Unscoped chat' })).toBeTruthy();
    expect(within(chatsSection).queryByText('Reserved chat')).toBeNull();
    await waitFor(() => expect(provisionalRow.getAttribute('aria-current')).toBe('true'));

    indexed = true;
    applyConversationSse(queryClient, 'conversation:new', { id: indexedConversation.id });

    const indexedRow = await within(projectSection).findByRole(
      'button',
      { name: 'Open conversation Reserved chat' },
      { timeout: 1600 },
    );
    expect(indexedRow).toBe(provisionalRow);
    expect(indexedRow.getAttribute('aria-current')).toBe('true');
    expect(screen.getAllByRole('button', { name: 'Open conversation Reserved chat' })).toHaveLength(1);
    await waitFor(() => expect(window.location.hash).toContain('conversation=indexed-reserved'));
    expect(within(chatsSection).getByRole('button', { name: 'Open session Unscoped chat' })).toBeTruthy();
  });
});
