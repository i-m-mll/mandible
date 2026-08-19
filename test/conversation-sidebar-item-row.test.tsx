import { readFileSync } from 'node:fs';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as api from '../ui/src/api.js';
import type {
  ConversationSidebarConversation,
  ConversationSidebarGroup,
  InstanceInfo,
} from '../ui/src/api.js';
import { CHAT_VIEW_STATE_KEY } from '../ui/src/views/conversation-view-state.js';
import { ConversationsView } from '../ui/src/views/conversations.js';

const sidebarItemRowStylesheet = readFileSync('ui/src/styles/sidebar-item-row.css', 'utf8');
const chatHistoryStylesheet = readFileSync('ui/src/styles/chat-history.css', 'utf8');

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
  vi.spyOn(api, 'listCanonicalProjects').mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
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
  attach_state: {
    kind: 'historical',
    reason: 'no-session',
    resumable: false,
    can_fork: false,
    provider_session_id: null,
    checked_at: 1,
  },
};

const existingPinnedConversation: ConversationSidebarConversation = {
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

function sidebarResponse(rows: ConversationSidebarConversation[]) {
  const groups: ConversationSidebarGroup[] = [];
  const pinned = rows.filter((row) => row.starred);
  const chats = rows.filter((row) => !row.starred);
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
  it('keeps selected and idle Chat widths full until actual focus reveals the shared overlay', async () => {
    const idleConversation = {
      ...conversation,
      id: 'conv-idle',
      title: 'Idle conversation with a long title',
      session_id: 'session-idle',
      started_at: '2026-08-16T12:00:00.000Z',
      tags: [],
    };
    vi.spyOn(api, 'getConversationSidebar').mockResolvedValue(sidebarResponse([conversation, idleConversation]));
    vi.spyOn(api, 'getConversationWindow').mockImplementation(async (id) => (
      positionWindow(id === idleConversation.id ? idleConversation : conversation)
    ));
    vi.spyOn(api, 'listWorkflows').mockResolvedValue([]);
    vi.spyOn(api, 'getSessionIssues').mockResolvedValue([]);
    vi.spyOn(api, 'getSessionPresets').mockResolvedValue([]);
    render(<ConversationsView consoleSessions={[]} initialConversationId={null} initialSessionId={null} onSelectSession={() => undefined} onNewSession={() => undefined} />);

    const selected = await screen.findByRole('button', { name: `Open conversation ${conversation.title}` });
    const idle = await screen.findByRole('button', { name: `Open conversation ${idleConversation.title}` });
    await waitFor(() => expect(selected.closest('.sidebar-item-row')?.classList.contains('sidebar-item-row--selected')).toBe(true));
    expect(idle.closest('.sidebar-item-row')?.classList.contains('sidebar-item-row--selected')).toBe(false);
    expect(idle.nextElementSibling?.classList.contains('sidebar-item-row__trailing')).toBe(true);
    expect(sidebarItemRowStylesheet).not.toMatch(
      /\.sidebar-item-row--selected \.sidebar-item-row__(?:trailing|provider-dot|actions)/,
    );
    idle.focus();
    expect(document.activeElement).toBe(idle);
    expect(sidebarItemRowStylesheet).toMatch(/\.sidebar-item-row:focus-within \.sidebar-item-row__trailing[^}]*\{[^}]*opacity: 1;/s);
    expect(chatHistoryStylesheet).not.toMatch(/sidebar-item-row__(?:trailing|content|select|label|actions|provider)/);
  });

  it('keeps section nodes separate while giving leaf rows direct Pin and secondary overflow actions', async () => {
    let serverRow = conversation;
    vi.spyOn(api, 'getConversationSidebar').mockImplementation(async () => sidebarResponse([serverRow]));
    vi.spyOn(api, 'getConversationWindow').mockResolvedValue(positionWindow(conversation));
    vi.spyOn(api, 'listWorkflows').mockResolvedValue([]);
    vi.spyOn(api, 'getSessionIssues').mockResolvedValue([]);
    vi.spyOn(api, 'getSessionPresets').mockResolvedValue([]);
    const updateConversation = vi.spyOn(api, 'updateConversation').mockImplementation(async (_id, patch) => {
      serverRow = { ...serverRow, ...patch };
      return serverRow;
    });
    vi.spyOn(window, 'prompt').mockReturnValue('design, shipped');

    render(
      <ConversationsView
        consoleSessions={[]}
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
    expect(select.getAttribute('aria-description')).toBe('Provider: Codex');
    expect(within(row as HTMLElement).getByRole('img', { name: 'Provider: Codex' })
      .classList.contains('sidebar-item-row__provider-dot--codex')).toBe(true);
    const trailing = row?.querySelector('.sidebar-item-row__trailing');
    expect(trailing?.firstElementChild?.classList.contains('sidebar-item-row__provider')).toBe(true);
    expect(trailing?.lastElementChild?.classList.contains('sidebar-item-row__actions')).toBe(true);
    expect(sidebarItemRowStylesheet).not.toMatch(/\.sidebar-item-row--selected \.sidebar-item-row__trailing/);
    expect(sidebarItemRowStylesheet).not.toMatch(/\.sidebar-item-row--selected \.sidebar-item-row__provider-dot/);
    expect(sidebarItemRowStylesheet).toMatch(/\.sidebar-item-row:focus-within \.sidebar-item-row__trailing[^}]*\{[^}]*opacity: 1;/s);
    expect(chatHistoryStylesheet).not.toMatch(/sidebar-item-row__(?:trailing|select|label|actions|provider)/);
    expect(row?.querySelector('.agent-mark')).toBeNull();
    const chatsHeading = screen.getByRole('button', { name: /^Chats/ });
    expect(chatsHeading.classList.contains('sidebar-item-row')).toBe(false);
    expect(chatsHeading.querySelector('.sidebar-group-node__count')).toBeNull();
    expect(chatsHeading.getAttribute('aria-description')).toBe('1 chat');
    await waitFor(() => expect(select.getAttribute('aria-current')).toBe('true'));

    fireEvent.click(screen.getByRole('button', { name: `Pin ${conversation.title}` }));
    await waitFor(() => expect(updateConversation).toHaveBeenCalledWith('conv-row', { starred: true }));
    await screen.findByRole('button', { name: `Unpin ${conversation.title}` });

    fireEvent.click(screen.getByRole('button', { name: `Chat actions for ${conversation.title}` }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit tags' }));
    await waitFor(() => expect(updateConversation).toHaveBeenCalledWith('conv-row', {
      tags: ['design', 'shipped'],
    }));
  });

  it('reconciles Pin and Unpin into visible sections while preserving order, selection, focus, and reload state', async () => {
    let serverRows = [conversation, existingPinnedConversation];
    vi.spyOn(api, 'getConversationSidebar').mockImplementation(async () => sidebarResponse(serverRows));
    vi.spyOn(api, 'getConversationWindow').mockImplementation(async (id) => (
      positionWindow(serverRows.find((row) => row.id === id) ?? conversation)
    ));
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
        consoleSessions={[]}
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
    const pinnedSection = screen.getByRole('button', { name: /^Pinned/ }).closest('section')!;
    const pinnedHeading = within(pinnedSection).getByRole('button', { name: /^Pinned/ });
    expect(pinnedHeading.querySelector('.sidebar-group-node__count')).toBeNull();
    expect(pinnedHeading.getAttribute('aria-description')).toBe('2 pinned chats');
    expect(pinnedSection.querySelector('.chat-history-item__pin')).toBeNull();
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
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(CHAT_VIEW_STATE_KEY) ?? '{}').pinnedConversationIds).toEqual([
      existingPinnedConversation.id,
    ]));
  });

  it('uses persisted browser pin membership without PATCH in explicit reject-mode previews', async () => {
    const serverRows = [conversation, existingPinnedConversation];
    vi.spyOn(api, 'getConversationSidebar').mockResolvedValue(sidebarResponse(serverRows));
    vi.spyOn(api, 'getConversationWindow').mockImplementation(async (id) => (
      positionWindow(serverRows.find((row) => row.id === id) ?? conversation)
    ));
    vi.spyOn(api, 'listWorkflows').mockResolvedValue([]);
    vi.spyOn(api, 'getSessionIssues').mockResolvedValue([]);
    vi.spyOn(api, 'getSessionPresets').mockResolvedValue([]);
    const updateConversation = vi.spyOn(api, 'updateConversation');
    window.localStorage.setItem(CHAT_VIEW_STATE_KEY, JSON.stringify({
      pinnedConversationIds: [existingPinnedConversation.id],
    }));

    const renderPreview = () => render(
      <ConversationsView
        consoleSessions={[]}
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
    const pinnedSection = screen.getByRole('button', { name: /^Pinned/ }).closest('section')!;
    expect(within(pinnedSection).getByRole('button', { name: `Open conversation ${conversation.title}` })).toBeTruthy();
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(CHAT_VIEW_STATE_KEY) ?? '{}')).toMatchObject({
      pinnedConversationIds: [existingPinnedConversation.id, conversation.id],
      previewPinOverrides: { [conversation.id]: true },
    }));

    cleanup();
    renderPreview();
    const reloadedPinnedSection = (await screen.findByRole('button', { name: /^Pinned/ })).closest('section')!;
    expect(within(reloadedPinnedSection).getByRole('button', { name: `Open conversation ${conversation.title}` })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: `Open conversation ${conversation.title}` }));
    const reloadedUnpin = screen.getByRole('button', { name: `Unpin ${conversation.title}` });
    reloadedUnpin.focus();
    fireEvent.click(reloadedUnpin);

    const restoredPin = await screen.findByRole('button', { name: `Pin ${conversation.title}` });
    await waitFor(() => expect(document.activeElement).toBe(restoredPin));
    expect(updateConversation).not.toHaveBeenCalled();
    const chatsSection = screen.getByRole('button', { name: /^Chats/ }).closest('section')!;
    expect(within(chatsSection).getByRole('button', { name: `Open conversation ${conversation.title}` })).toBeTruthy();
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(CHAT_VIEW_STATE_KEY) ?? '{}')).toMatchObject({
      pinnedConversationIds: [existingPinnedConversation.id],
      previewPinOverrides: { [conversation.id]: false },
    }));
  });
});
