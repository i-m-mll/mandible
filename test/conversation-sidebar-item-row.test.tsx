import { mockConversationStructureFromWindow, mockManagedSettings } from './helpers/conversation-ui-transport';
import { establishTestClientAccess } from './helpers/local-client-access';

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as api from '../ui/src/api.js';
import type {
  ConversationSidebarConversation,
  ConversationSidebarGroup,
} from '../ui/src/api.js';
import { CHAT_VIEW_STATE_KEY } from '../ui/src/views/conversation-view-state.js';
import { ConversationsView } from '../ui/src/views/conversations.js';
import { queryClient } from '../ui/src/query/client.js';

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    loadAddon(): void {}
    open(): void {}
    write(): void {}
    writeln(): void {}
    clear(): void {}
    focus(): void {}
    dispose(): void {}
  },
}));

vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit(): void {} dispose(): void {} } }));

beforeEach(async () => {
  await establishTestClientAccess();
  vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} });
  mockConversationStructureFromWindow();
  mockManagedSettings();
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, writable: true, value: () => {} });
  vi.spyOn(HTMLElement.prototype, 'scrollTo').mockImplementation(() => {});
  queryClient.clear();
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
  vi.spyOn(api, 'getConversations').mockResolvedValue({ conversations: [], total: 0 });
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  window.localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const conversation: ConversationSidebarConversation = {
  id: 'conv-row',
  source: 'codex',
  source_path: '/tmp/conversation.jsonl',
  title: 'A deliberately long conversation title for row truncation',
  summary: null,
  started_at: '2026-08-17T12:00:00.000Z',
  ended_at: null,
  block_count: 4,
  session_id: 'session-row',
  project_path: null,
  cwd: null,
  branch: null,
  model: null,
  cli_version: null,
  is_sidechain: false,
  agent_id: null,
  starred: false,
  tags: ['design', 'review'],
  notes: null,
  parent_conversation_id: null,
  children_count: 0,
  canonical_project_id: null,
  canonical_project_key: null,
};

const existingPinnedConversation: ConversationSidebarConversation = {
  ...conversation,
  id: 'conv-existing-pin',
  title: 'Existing pinned conversation',
  session_id: 'session-existing-pin',
  started_at: '2026-08-16T12:00:00.000Z',
  starred: true,
};

function sidebarResponse(rows: ConversationSidebarConversation[], pinnedIds?: string[]) {
  const groups: ConversationSidebarGroup[] = [];
  const pinnedSet = pinnedIds ? new Set(pinnedIds) : null;
  const pinned = rows.filter((row) => pinnedSet ? pinnedSet.has(row.id) : row.starred);
  const chats = rows.filter((row) => pinnedSet ? !pinnedSet.has(row.id) : !row.starred);
  if (pinned.length > 0) {
    groups.push({ key: 'pinned', kind: 'pinned', label: 'Pinned', total: pinned.length, conversations: pinned, next_cursor: null });
  }
  if (chats.length > 0) {
    groups.push({ key: 'chats', kind: 'chats', label: 'Chats', total: chats.length, conversations: chats, next_cursor: null });
  }
  return { groups, limit: 5 };
}

function positionWindow(row: Conversation) {
  return {
    conversation: row,
    body_source: 'legacy' as const,
    source_version_id: null,
    blocks: [],
    children: [],
    parent: null,
    revision: row.block_count,
    total: row.block_count,
    target: { kind: 'initial' as const, requested_value: null, position: null, block_id: null, turn_id: null },
    window: { start_position: null, end_position: null, has_before: false, has_after: false, after_count: 0, limit: 160 },
  };
}

describe('conversation sidebar labeled-item rows', () => {
  it('restores the last selected conversation when Chat is reopened without a deep link', async () => {
    const laterConversation = {
      ...conversation,
      id: 'conv-later-selection',
      title: 'The conversation I last viewed',
      session_id: 'session-later-selection',
    };
    const serverRows = [conversation, laterConversation];
    vi.spyOn(api, 'getConversationSidebar').mockResolvedValue(sidebarResponse(serverRows));
    vi.spyOn(api, 'getConversationWindow').mockImplementation(async (id) => (
      positionWindow(serverRows.find((row) => row.id === id) ?? conversation)
    ));
    vi.spyOn(api, 'listWorkflows').mockResolvedValue([]);
    vi.spyOn(api, 'getSessionIssues').mockResolvedValue([]);

    const renderView = () => render(
      <ConversationsView
        consoleSessions={[]}
        initialConversationId={null}
        initialSessionId={null}
        onSelectSession={() => undefined}
        onNewConversation={() => undefined}
      />,
    );

    renderView();
    fireEvent.click(await screen.findByRole('button', { name: `Open conversation ${laterConversation.title}` }));
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(CHAT_VIEW_STATE_KEY) ?? '{}').lastSelection)
      .toEqual({ type: 'conversation', id: laterConversation.id }));

    cleanup();
    renderView();
    await waitFor(() => expect(screen.getByRole('button', { name: `Open conversation ${laterConversation.title}` })
      .getAttribute('aria-current')).toBe('true'));
  });

  it('shows Open externally only from a typed server capability and dispatches the exact conversation', async () => {
    const navigable: ConversationSidebarConversation = {
      ...conversation,
      external_navigation: {
        kind: 'codex-desktop-task',
        provider_session_id: 'existing-codex-task',
        label: 'Open in Codex',
      },
    };
    vi.spyOn(api, 'getConversationSidebar').mockResolvedValue(sidebarResponse([navigable]));
    vi.spyOn(api, 'getConversationWindow').mockResolvedValue(positionWindow(navigable));
    vi.spyOn(api, 'listWorkflows').mockResolvedValue([]);
    vi.spyOn(api, 'getSessionIssues').mockResolvedValue([]);
    const openExternally = vi.spyOn(api, 'openConversationExternally').mockResolvedValue();

    render(
      <ConversationsView
        consoleSessions={[]}
        initialConversationId={null}
        initialSessionId={null}
        onSelectSession={() => undefined}
        onNewConversation={() => undefined}
      />,
    );

    await screen.findByRole('button', { name: `Open conversation ${navigable.title}` });
    fireEvent.click(screen.getByRole('button', { name: `Chat actions for ${navigable.title}` }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open externally' }));
    await waitFor(() => expect(openExternally).toHaveBeenCalledWith(navigable.id));

    cleanup();
    queryClient.clear();
    const unavailable = { ...conversation, id: 'without-capability', external_navigation: undefined };
    vi.mocked(api.getConversationSidebar).mockResolvedValue(sidebarResponse([unavailable]));
    render(
      <ConversationsView
        consoleSessions={[]}
        initialConversationId={null}
        initialSessionId={null}
        onSelectSession={() => undefined}
        onNewConversation={() => undefined}
      />,
    );
    await screen.findByRole('button', { name: `Open conversation ${unavailable.title}` });
    fireEvent.click(screen.getByRole('button', { name: `Chat actions for ${unavailable.title}` }));
    expect(screen.queryByRole('menuitem', { name: 'Open externally' })).toBeNull();
  });

  it('reconciles Pin and Unpin into visible sections while preserving order, selection, focus, and reload state', async () => {
    let serverRows = [conversation, existingPinnedConversation];
    vi.spyOn(api, 'getConversationSidebar').mockImplementation(async (params) => sidebarResponse(serverRows, params.pinned_ids));
    vi.spyOn(api, 'getConversationWindow').mockImplementation(async (id) => (
      positionWindow(serverRows.find((row) => row.id === id) ?? conversation)
    ));
    vi.spyOn(api, 'listWorkflows').mockResolvedValue([]);
    vi.spyOn(api, 'getSessionIssues').mockResolvedValue([]);
    const updateConversation = vi.spyOn(api, 'updateConversation').mockImplementation(async (id, patch) => {
      serverRows = serverRows.map((row) => row.id === id ? { ...row, ...patch } : row);
      return serverRows.find((row) => row.id === id)!;
    });
    vi.mocked(api.getConversations).mockResolvedValue({ conversations: [existingPinnedConversation], total: 1 });
    let savedSidebarOrder = { pinnedConversationIds: null as string[] | null, briefingTopLevelIds: null as string[] | null };
    vi.mocked(api.getSidebarOrderPreference).mockImplementation(async () => ({
      version: 1, key: 'sidebar_order', value: savedSidebarOrder, revision: savedSidebarOrder.pinnedConversationIds ? 1 : 0,
    }));
    vi.mocked(api.updateSidebarOrderPreference).mockImplementation(async (value, revision) => {
      savedSidebarOrder = value;
      return { version: 1, key: 'sidebar_order', value, revision: revision + 1 };
    });
    window.localStorage.setItem(CHAT_VIEW_STATE_KEY, JSON.stringify({
      pinnedConversationIds: [existingPinnedConversation.id],
    }));

    const renderView = () => render(
      <ConversationsView
        consoleSessions={[]}
        initialConversationId={conversation.id}
        initialSessionId={null}
        onSelectSession={() => undefined}
        onNewConversation={() => undefined}
      />,
    );

    renderView();
    const selectedRow = await screen.findByRole('button', { name: `Open conversation ${conversation.title}` });
    fireEvent.click(selectedRow);
    await waitFor(() => expect(selectedRow.getAttribute('aria-current')).toBe('true'));
    const pin = screen.getByRole('button', { name: `Pin ${conversation.title}` });
    pin.focus();
    fireEvent.click(pin);

    await waitFor(() => expect(api.updateSidebarOrderPreference).toHaveBeenCalledWith({
      pinnedConversationIds: [existingPinnedConversation.id, conversation.id], briefingTopLevelIds: null,
    }, 0));
    expect(updateConversation).not.toHaveBeenCalledWith(conversation.id, { starred: true });
    const unpin = await screen.findByRole('button', { name: `Unpin ${conversation.title}` });
    await waitFor(() => expect(document.activeElement).toBe(unpin));
    expect(screen.getByRole('button', { name: `Open conversation ${conversation.title}` }).getAttribute('aria-current')).toBe('true');
    const pinnedSection = screen.getByRole('button', { name: /^Pinned/ }).closest('section')!;
    const pinnedHeading = within(pinnedSection).getByRole('button', { name: /^Pinned/ });
    expect(pinnedHeading.querySelector('.sidebar-group-node__count')).toBeNull();
    expect(pinnedHeading.getAttribute('aria-description')).toBe('2 pinned chats');
    expect(pinnedSection.querySelector('.chat-history-item__pin')).toBeNull();
    expect(within(pinnedSection).getAllByRole('button', { name: /^Open conversation/ }).map((row) => row.getAttribute('aria-label'))).toEqual([
      `Open conversation ${existingPinnedConversation.title}`,
      `Open conversation ${conversation.title}`,
    ]);
    await waitFor(() => expect(savedSidebarOrder.pinnedConversationIds).toEqual([
      existingPinnedConversation.id, conversation.id,
    ]));

    cleanup();
    renderView();
    const reloadedPinnedSection = (await screen.findByRole('button', { name: /^Pinned/ })).closest('section')!;
    expect(within(reloadedPinnedSection).getAllByRole('button', { name: /^Open conversation/ }).map((row) => row.getAttribute('aria-label'))).toEqual([
      `Open conversation ${existingPinnedConversation.title}`,
      `Open conversation ${conversation.title}`,
    ]);

    fireEvent.click(screen.getByRole('button', { name: `Open conversation ${conversation.title}` }));
    const reloadedUnpin = screen.getByRole('button', { name: `Unpin ${conversation.title}` });
    reloadedUnpin.focus();
    fireEvent.click(reloadedUnpin);
    const restoredPin = await screen.findByRole('button', { name: `Pin ${conversation.title}` });
    await waitFor(() => expect(document.activeElement).toBe(restoredPin));
    expect(screen.getByRole('button', { name: `Open conversation ${conversation.title}` }).getAttribute('aria-current')).toBe('true');
    const chatsSection = screen.getByRole('button', { name: /^Chats/ }).closest('section')!;
    expect(within(chatsSection).getByRole('button', { name: `Open conversation ${conversation.title}` })).toBeTruthy();
    await waitFor(() => expect(savedSidebarOrder.pinnedConversationIds).toEqual([
      existingPinnedConversation.id,
    ]));
  });
});
