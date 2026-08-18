import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as api from '../ui/src/api.js';
import type { Conversation, InstanceInfo } from '../ui/src/api.js';
import { CHAT_VIEW_STATE_KEY } from '../ui/src/views/conversation-view-state.js';
import { ConversationsView } from '../ui/src/views/conversations.js';

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
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const conversation: Conversation = {
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
  attach_state: {
    kind: 'historical',
    reason: 'no-session',
    resumable: false,
    can_fork: false,
    provider_session_id: null,
    checked_at: 1,
  },
};

const existingPinnedConversation: Conversation = {
  ...conversation,
  id: 'conv-existing-pin',
  title: 'Existing pinned conversation',
  session_id: 'session-existing-pin',
  started_at: '2026-08-16T12:00:00.000Z',
  starred: true,
};

const rejectModePreview: InstanceInfo = {
  role: 'preview',
  operational_mutations: 'reject',
  operational_mutations_overridden: true,
  db_path: '/tmp/mandible-preview.db',
  db_path_source: 'iab-preview-copy',
};

describe('conversation sidebar labeled-item rows', () => {
  it('keeps section nodes separate while giving leaf rows direct Pin and secondary overflow actions', async () => {
    vi.spyOn(api, 'getConversations').mockResolvedValue({ conversations: [conversation], total: 1 });
    vi.spyOn(api, 'getConversation').mockResolvedValue({
      ...conversation,
      blocks: [],
      children: [],
      parent: null,
    });
    vi.spyOn(api, 'listWorkflows').mockResolvedValue([]);
    vi.spyOn(api, 'getSessionIssues').mockResolvedValue([]);
    vi.spyOn(api, 'getSessionPresets').mockResolvedValue([]);
    const updateConversation = vi.spyOn(api, 'updateConversation').mockImplementation(async (_id, patch) => ({
      ...conversation,
      ...patch,
    }));
    vi.spyOn(window, 'prompt').mockReturnValue('design, shipped');

    render(
      <ConversationsView
        conversations={[conversation]}
        consoleSessions={[]}
        workRepos={[]}
        initialConversationId={null}
        initialSessionId={null}
        onSelectSession={() => undefined}
        onNewSession={() => undefined}
      />,
    );

    const select = await screen.findByRole('button', {
      name: `Open conversation ${conversation.title}`,
    });
    const row = select.closest('.chat-history-item');
    expect(row?.classList.contains('sidebar-item-row')).toBe(true);
    expect(row?.querySelector('.sidebar-item-row__label')?.textContent).toBe(conversation.title);
    expect(row?.querySelector('.chat-history-item__tags')?.textContent).toBe('design · review');
    expect(screen.getByRole('button', { name: /^Chats/ }).classList.contains('sidebar-item-row')).toBe(false);
    await waitFor(() => expect(select.getAttribute('aria-current')).toBe('true'));

    fireEvent.click(screen.getByRole('button', { name: `Pin ${conversation.title}` }));
    await waitFor(() => expect(updateConversation).toHaveBeenCalledWith('conv-row', { starred: true }));

    fireEvent.click(screen.getByRole('button', { name: `Chat actions for ${conversation.title}` }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit tags' }));
    await waitFor(() => expect(updateConversation).toHaveBeenCalledWith('conv-row', {
      tags: ['design', 'shipped'],
    }));
  });

  it('reconciles Pin and Unpin into visible sections while preserving order, selection, focus, and reload state', async () => {
    let serverRows = [conversation, existingPinnedConversation];
    vi.spyOn(api, 'getConversations').mockImplementation(async () => ({
      conversations: serverRows,
      total: serverRows.length,
    }));
    vi.spyOn(api, 'getConversation').mockImplementation(async (id) => ({
      ...(serverRows.find((row) => row.id === id) ?? conversation),
      blocks: [],
      children: [],
      parent: null,
    }));
    vi.spyOn(api, 'listWorkflows').mockResolvedValue([]);
    vi.spyOn(api, 'getSessionIssues').mockResolvedValue([]);
    vi.spyOn(api, 'getSessionPresets').mockResolvedValue([]);
    const updateConversation = vi.spyOn(api, 'updateConversation').mockImplementation(async (id, patch) => {
      serverRows = serverRows.map((row) => row.id === id ? { ...row, ...patch } : row);
      return serverRows.find((row) => row.id === id)!;
    });
    window.localStorage.setItem(CHAT_VIEW_STATE_KEY, JSON.stringify({
      pinnedConversationIds: [existingPinnedConversation.id],
    }));

    const renderView = () => render(
      <ConversationsView
        conversations={serverRows}
        consoleSessions={[]}
        workRepos={[]}
        initialConversationId={conversation.id}
        initialSessionId={null}
        onSelectSession={() => undefined}
        onNewSession={() => undefined}
      />,
    );

    renderView();
    const selectedRow = await screen.findByRole('button', { name: `Open conversation ${conversation.title}` });
    fireEvent.click(selectedRow);
    await waitFor(() => expect(selectedRow.getAttribute('aria-current')).toBe('true'));
    const pin = screen.getByRole('button', { name: `Pin ${conversation.title}` });
    pin.focus();
    fireEvent.click(pin);

    await waitFor(() => expect(updateConversation).toHaveBeenCalledWith(conversation.id, { starred: true }));
    const unpin = await screen.findByRole('button', { name: `Unpin ${conversation.title}` });
    await waitFor(() => expect(document.activeElement).toBe(unpin));
    expect(screen.getByRole('button', { name: `Open conversation ${conversation.title}` }).getAttribute('aria-current')).toBe('true');
    const pinnedSection = screen.getByRole('button', { name: /^Pinned/ }).closest('.chat-sidebar-section')!;
    expect(within(pinnedSection).getAllByRole('button', { name: /^Open conversation/ }).map((row) => row.getAttribute('aria-label'))).toEqual([
      `Open conversation ${existingPinnedConversation.title}`,
      `Open conversation ${conversation.title}`,
    ]);
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(CHAT_VIEW_STATE_KEY) ?? '{}').pinnedConversationIds).toEqual([
      existingPinnedConversation.id,
      conversation.id,
    ]));

    cleanup();
    renderView();
    const reloadedPinnedSection = screen.getByRole('button', { name: /^Pinned/ }).closest('.chat-sidebar-section')!;
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
    const chatsSection = screen.getByRole('button', { name: /^Chats/ }).closest('.chat-sidebar-section')!;
    expect(within(chatsSection).getByRole('button', { name: `Open conversation ${conversation.title}` })).toBeTruthy();
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(CHAT_VIEW_STATE_KEY) ?? '{}').pinnedConversationIds).toEqual([
      existingPinnedConversation.id,
    ]));
  });

  it('uses persisted browser pin membership without PATCH in explicit reject-mode previews', async () => {
    const serverRows = [conversation, existingPinnedConversation];
    vi.spyOn(api, 'getConversations').mockResolvedValue({ conversations: serverRows, total: serverRows.length });
    vi.spyOn(api, 'getConversation').mockImplementation(async (id) => ({
      ...(serverRows.find((row) => row.id === id) ?? conversation),
      blocks: [],
      children: [],
      parent: null,
    }));
    vi.spyOn(api, 'listWorkflows').mockResolvedValue([]);
    vi.spyOn(api, 'getSessionIssues').mockResolvedValue([]);
    vi.spyOn(api, 'getSessionPresets').mockResolvedValue([]);
    const updateConversation = vi.spyOn(api, 'updateConversation');
    window.localStorage.setItem(CHAT_VIEW_STATE_KEY, JSON.stringify({
      pinnedConversationIds: [existingPinnedConversation.id],
    }));

    const renderPreview = () => render(
      <ConversationsView
        conversations={serverRows}
        consoleSessions={[]}
        workRepos={[]}
        initialConversationId={null}
        initialSessionId={null}
        instance={rejectModePreview}
        onSelectSession={() => undefined}
        onNewSession={() => undefined}
      />,
    );

    renderPreview();
    const targetRow = await screen.findByRole('button', { name: `Open conversation ${conversation.title}` });
    fireEvent.click(targetRow);
    const pin = screen.getByRole('button', { name: `Pin ${conversation.title}` });
    pin.focus();
    fireEvent.click(pin);

    const unpin = await screen.findByRole('button', { name: `Unpin ${conversation.title}` });
    await waitFor(() => expect(document.activeElement).toBe(unpin));
    expect(updateConversation).not.toHaveBeenCalled();
    const pinnedSection = screen.getByRole('button', { name: /^Pinned/ }).closest('.chat-sidebar-section')!;
    expect(within(pinnedSection).getByRole('button', { name: `Open conversation ${conversation.title}` })).toBeTruthy();
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(CHAT_VIEW_STATE_KEY) ?? '{}')).toMatchObject({
      pinnedConversationIds: [existingPinnedConversation.id, conversation.id],
      previewPinOverrides: { [conversation.id]: true },
    }));

    cleanup();
    renderPreview();
    const reloadedPinnedSection = screen.getByRole('button', { name: /^Pinned/ }).closest('.chat-sidebar-section')!;
    expect(within(reloadedPinnedSection).getByRole('button', { name: `Open conversation ${conversation.title}` })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: `Open conversation ${conversation.title}` }));
    const reloadedUnpin = screen.getByRole('button', { name: `Unpin ${conversation.title}` });
    reloadedUnpin.focus();
    fireEvent.click(reloadedUnpin);

    const restoredPin = await screen.findByRole('button', { name: `Pin ${conversation.title}` });
    await waitFor(() => expect(document.activeElement).toBe(restoredPin));
    expect(updateConversation).not.toHaveBeenCalled();
    const chatsSection = screen.getByRole('button', { name: /^Chats/ }).closest('.chat-sidebar-section')!;
    expect(within(chatsSection).getByRole('button', { name: `Open conversation ${conversation.title}` })).toBeTruthy();
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(CHAT_VIEW_STATE_KEY) ?? '{}')).toMatchObject({
      pinnedConversationIds: [existingPinnedConversation.id],
      previewPinOverrides: { [conversation.id]: false },
    }));
  });
});
