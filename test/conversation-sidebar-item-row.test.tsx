import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as api from '../ui/src/api.js';
import type { Conversation } from '../ui/src/api.js';
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

afterEach(() => {
  cleanup();
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

describe('conversation sidebar labeled-item rows', () => {
  it('keeps section nodes separate while giving leaf rows direct Pin and secondary overflow actions', async () => {
    vi.spyOn(api, 'getConversationSidebar').mockResolvedValue({
      groups: [{ key: 'chats', kind: 'chats', label: 'Chats', total: 1, conversations: [conversation], next_cursor: null }],
      limit: 5,
    });
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
});
