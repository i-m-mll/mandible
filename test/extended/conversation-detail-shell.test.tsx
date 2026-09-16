import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ComponentChildren } from 'preact';
import { useCallback, useRef, useState } from 'preact/hooks';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as api from '../../ui/src/api.js';
import type { Conversation, ConversationBlock, ConversationControlSnapshot, ConversationPositionWindow } from '../../ui/src/api.js';
import { DetailPaneShell } from '../../ui/src/components/shared/DetailPaneShell.js';
import { AppShellProvider, type AppRightSidebarDescriptor } from '../../ui/src/app-shell.js';
import { __resetSharedSseForTests } from '../../ui/src/sse-shared.js';
import type { ConsoleSession } from '../../ui/src/state.js';
import {
  ConversationsView,
  conversationAnchorFromHash,
  conversationAnchorHref,
  conversationLoadFailure,
  scopeConversationRightSidebar,
} from '../../ui/src/views/conversations.js';
import { chatItemIdentityKey } from '../../src/conversation-control/provider-live.js';
import type { ChatItem } from '../../src/parsers/types.js';
import { queryClient } from '../../ui/src/query/client.js';
import { applyConversationSse } from '../../ui/src/query/conversationSse.js';


vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options = { theme: {} };
    cols = 80;
    rows = 24;
    loadAddon(): void {}
    open(): void {}
    write(): void {}
    writeln(): void {}
    clear(): void {}
    focus(): void {}
    onData(): { dispose: () => void } { return { dispose: () => undefined }; }
    dispose(): void {}
  },
}));

vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit(): void {} dispose(): void {} } }));

beforeEach(() => {
  queryClient.clear();
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
  vi.spyOn(api, 'listCanonicalProjects').mockResolvedValue([]);
  vi.spyOn(api, 'getConversationSidebar').mockResolvedValue({ groups: [], limit: 50 });
  vi.spyOn(api, 'exportConversationBlocks').mockResolvedValue({
    content: '## User\n\nPreserve the whole conversation export.\n\n## Assistant\n\nServer-only unread tail.',
    block_count: 2,
    body_source: 'source',
  });
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
  queryClient.clear();
  __resetSharedSseForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.head.querySelector('[data-test-compact-header-styles]')?.remove();
  window.history.replaceState(null, '', '#/');
});

const conversation: Conversation = {
  id: '01a01639-6146-77c1-8616-6878ae755367',
  source: 'codex',
  source_path: '/tmp/conversation.jsonl',
  title: 'A compact shared-shell conversation title that must truncate',
  summary: null,
  started_at: '2026-08-18T12:00:00.000Z',
  ended_at: null,
  block_count: 0,
  session_id: 'session-detail-shell',
  project_path: null,
  cwd: null,
  branch: null,
  model: 'gpt-5.6-codex',
  cli_version: null,
  is_sidechain: false,
  agent_id: null,
  starred: false,
  tags: [],
  notes: null,
  parent_conversation_id: null,
  children_count: 0,
};

const defaultControl: ConversationControlSnapshot = {
  conversation_id: conversation.id,
  provider: 'codex',
  provider_session_id: conversation.session_id,
  provider_mode: null,
  provider_capabilities: null,
  revision: 0,
  ownership: { kind: 'none', generation: 0 },
  controller: { kind: 'stopped', at: 1 },
  turn: { kind: 'none' },
  capability: {
    kind: 'provider-session-resume',
    revision: 0,
    generation: 0,
    adapter_id: 'codex',
    provider_session_id: conversation.session_id,
  },
  updated_at: 1,
};

function makeTranscriptBlock(overrides: Partial<ConversationBlock> = {}): ConversationBlock {
  const value: ConversationBlock = {
    id: 'block-user-1',
    conversation_id: conversation.id,
    type: 'user_message',
    role: 'user',
    content: 'Preserve the whole conversation export.',
    position: 0,
    timestamp: '2026-08-18T12:01:00.000Z',
    parent_id: null,
    metadata_json: JSON.stringify({
    context_usage: {
      source: 'mirror_exact',
      percent: 42,
      used_tokens: 42_000,
      window_tokens: 100_000,
    },
    }),
    dag_uuid: 'dag-user-1',
    dag_parent_uuid: null,
    ...overrides,
  };
  const metadata = JSON.parse(value.metadata_json || '{}') as Record<string, unknown>;
  const item: ChatItem = {
    type: 'message',
    role: value.role === 'assistant' ? 'assistant' : value.role === 'system' ? 'system' : 'user',
    identity: {
      provider: 'codex',
      session_id: conversation.session_id,
      native_item_id: value.dag_uuid ?? value.id,
      ...(value.role === 'assistant' ? { native_turn_id: value.dag_uuid ?? value.id } : {}),
      source_record_ordinal: value.position,
      source_sub_block_ordinal: 0,
    },
    provenance: { source: 'verified-provider-transcript', provider: 'codex', source_event_type: 'test-message' },
    parts: [{ type: 'text', text: value.content }],
    content_completion: 'complete',
  };
  return { ...value, metadata_json: JSON.stringify({ ...metadata, chat_item: item }) };
}

const transcriptBlock = makeTranscriptBlock();

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

function mockConversationDetail(
  control: ConversationControlSnapshot,
  blocks: ConversationBlock[] = [transcriptBlock],
): Conversation {
  const scopedConversation = { ...conversation, block_count: blocks.length };
  vi.spyOn(api, 'getConversations').mockResolvedValue({ conversations: [scopedConversation], total: 1 });
  vi.spyOn(api, 'getConversationControl').mockResolvedValue(control);
  vi.spyOn(api, 'getConversationWindow').mockResolvedValue({
    conversation: scopedConversation,
    body_source: 'legacy',
    source_version_id: null,
    blocks,
    children: [],
    parent: null,
    revision: blocks.length,
    total: blocks.length,
    target: {
      kind: 'initial',
      requested_value: null,
      position: blocks.at(-1)?.position ?? null,
      block_id: blocks.at(-1)?.id ?? null,
      turn_id: blocks.at(-1)?.id ?? null,
    },
    window: {
      start_position: blocks[0]?.position ?? null,
      end_position: blocks.at(-1)?.position ?? null,
      has_before: false,
      has_after: false,
      after_count: 0,
      limit: 160,
    },
  });
  vi.spyOn(api, 'listWorkflows').mockResolvedValue([]);
  vi.spyOn(api, 'getSessionIssues').mockResolvedValue([]);
  return scopedConversation;
}

function renderConversationDetail(scopedConversation: Conversation, consoleSessions: ConsoleSession[] = []): void {
  render(
    <ConversationsView
      conversations={[scopedConversation]}
      consoleSessions={consoleSessions}
      initialConversationId={scopedConversation.id}
      initialSessionId={null}
      onSelectSession={() => undefined}
      onNewConversation={() => undefined}
    />,
  );
}

function positionPayload(
  scopedConversation: Conversation,
  blocks: ConversationBlock[],
  options: {
    kind?: 'initial' | 'latest' | 'block';
    hasAfter?: boolean;
    afterCount?: number;
    revision?: number;
  } = {},
): ConversationPositionWindow {
  const target = blocks.at(-1) ?? null;
  const revision = options.revision ?? blocks.length;
  return {
    conversation: { ...scopedConversation, block_count: revision },
    body_source: 'legacy',
    source_version_id: null,
    blocks,
    children: [],
    parent: null,
    revision,
    total: revision,
    target: {
      kind: options.kind ?? 'initial',
      requested_value: options.kind === 'block' ? target?.id ?? null : null,
      position: target?.position ?? null,
      block_id: target?.id ?? null,
      turn_id: target?.id ?? null,
    },
    window: {
      start_position: blocks[0]?.position ?? null,
      end_position: target?.position ?? null,
      has_before: false,
      has_after: options.hasAfter ?? false,
      after_count: options.hasAfter ? (options.afterCount ?? Math.max(1, revision - blocks.length)) : 0,
      limit: 160,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function MountedRightSidebarShell({ children }: { children: ComponentChildren }): JSX.Element {
  const [sidebar, setSidebar] = useState<AppRightSidebarDescriptor | null>(null);
  const ownerRef = useRef<string | null>(null);
  const registerRightSidebar = useCallback((ownerId: string) => {
    ownerRef.current = ownerId;
    return () => {
      if (ownerRef.current === ownerId) ownerRef.current = null;
      setSidebar((current) => current?.id === ownerId ? null : current);
    };
  }, []);
  const updateRightSidebar = useCallback((ownerId: string, next: AppRightSidebarDescriptor) => {
    if (ownerRef.current === ownerId) setSidebar(next);
  }, []);
  return (
    <AppShellProvider value={{ rightSidebar: sidebar, registerRightSidebar, updateRightSidebar, setViewSidebarWidth: () => undefined, active: true }}>
      {children}
      {sidebar?.open && sidebar.kind === 'tabs' ? (
        <aside aria-label={sidebar.ariaLabel}>
          {sidebar.tabs.map((tab) => (
            <button key={tab.id} type="button" role="tab" aria-label={tab.label} title={tab.tooltip} aria-selected={sidebar.activeTab === tab.id} onClick={() => sidebar.onActiveTabChange(tab.id)}>{tab.icon}</button>
          ))}
          {sidebar.tabs.find((tab) => tab.id === sidebar.activeTab)?.content}
        </aside>
      ) : null}
    </AppShellProvider>
  );
}

function MountedConversationsApp({
  onSidebarUpdate,
}: {
  onSidebarUpdate: () => void;
}): JSX.Element {
  const [sidebar, setSidebar] = useState<AppRightSidebarDescriptor | null>(null);
  const ownerRef = useRef<string | null>(null);
  const registerRightSidebar = useCallback((ownerId: string) => {
    ownerRef.current = ownerId;
    return () => {
      if (ownerRef.current === ownerId) ownerRef.current = null;
      setSidebar((current) => current?.id === ownerId ? null : current);
    };
  }, []);
  const updateRightSidebar = useCallback((ownerId: string, next: AppRightSidebarDescriptor) => {
    if (ownerRef.current !== ownerId) return;
    onSidebarUpdate();
    setSidebar((current) => current === next ? current : next);
  }, [onSidebarUpdate]);
  return (
    <AppShellProvider value={{ rightSidebar: sidebar, registerRightSidebar, updateRightSidebar, setViewSidebarWidth: () => undefined, active: true }}>
      <ConversationsView
        consoleSessions={[]}
        initialConversationId={null}
        initialSessionId={null}
        onSelectSession={() => undefined}
        onNewConversation={() => undefined}
      />
      {sidebar?.open && sidebar.kind === 'tabs' ? (
        <aside aria-label={sidebar.ariaLabel}>
          {sidebar.tabs.find((tab) => tab.id === sidebar.activeTab)?.content}
        </aside>
      ) : null}
    </AppShellProvider>
  );
}

describe('compact detail pane shell', () => {
  it('keeps routine sidebar reconciliation silent', async () => {
    const sidebar = deferred<Awaited<ReturnType<typeof api.getConversationSidebar>>>();
    vi.mocked(api.getConversationSidebar).mockReturnValue(sidebar.promise);

    render(
      <ConversationsView
        conversations={[]}
        consoleSessions={[]}
        initialConversationId={null}
        initialSessionId={null}
        onSelectSession={() => undefined}
        onNewConversation={() => undefined}
      />,
    );

    expect(screen.queryByText('Loading…')).toBeNull();
    await act(async () => sidebar.resolve({ groups: [], limit: 50 }));
    expect(await screen.findByText('No chats')).toBeTruthy();
  });

  it('shows the chat placeholder after a successful empty sidebar response', async () => {
    render(
      <ConversationsView
        conversations={[]}
        consoleSessions={[]}
        initialConversationId={null}
        initialSessionId={null}
        onSelectSession={() => undefined}
        onNewConversation={() => undefined}
      />,
    );

    expect(await screen.findByText('No chats')).toBeTruthy();
  });

  it('renders populated unscoped sidebar results instead of an empty-state placeholder', async () => {
    const sidebarConversation = { ...conversation, id: 'sidebar-chat', block_count: 3, title: 'Visible unscoped chat' };
    vi.mocked(api.getConversationSidebar).mockResolvedValue({
      groups: [{ key: 'chats', kind: 'chats', label: 'Chats', total: 1, conversations: [sidebarConversation], next_cursor: null }],
      limit: 50,
    });

    render(
      <ConversationsView
        conversations={[]}
        consoleSessions={[]}
        initialConversationId={null}
        initialSessionId={null}
        onSelectSession={() => undefined}
        onNewConversation={() => undefined}
      />,
    );

    expect(await screen.findByText('Visible unscoped chat')).toBeTruthy();
    expect(screen.queryByText('No chats')).toBeNull();
  });

  it('does not report an empty chat list before the first sidebar request succeeds', async () => {
    vi.mocked(api.getConversationSidebar).mockRejectedValue(new Error('temporary failure'));

    render(
      <ConversationsView
        conversations={[]}
        consoleSessions={[]}
        initialConversationId={null}
        initialSessionId={null}
        onSelectSession={() => undefined}
        onNewConversation={() => undefined}
      />,
    );

    expect(await screen.findByText('Chats could not be refreshed.')).toBeTruthy();
    expect(screen.queryByText('No chats')).toBeNull();
  });

  it('keeps legacy title-authority errors out of header presentation state', () => {
    const missing = conversationLoadFailure(new api.ApiError('raw code', 409, 'provider_metadata_missing'), true);
    expect(missing).toMatchObject({ code: 'provider_metadata_missing', retryable: false });
    expect(missing).not.toHaveProperty('titleAuthorityDegraded');
    expect(missing.message).toContain('Transcript loaded');
    expect(missing.message).toContain('Retrying will not recreate');
    expect(missing.message).not.toContain('raw code');

    const unavailable = conversationLoadFailure(new api.ApiError('temporary', 503, 'provider_metadata_unavailable'), true);
    expect(unavailable).toMatchObject({ code: 'provider_metadata_unavailable', retryable: true });
    expect(unavailable.message).toContain('transcript is unchanged');
  });

  it('synchronously discards another conversation\'s preview and Preview tab', () => {
    const target = {
      kind: 'issue' as const,
      ref: 'old-issue',
      href: '#/issues?issue=old-issue',
      label: 'old-issue',
    };
    const scoped = scopeConversationRightSidebar(
      'conversation-new',
      { conversationId: 'conversation-old', previewTarget: target, tab: 'preview' },
    );
    expect(scoped).toEqual({ conversationId: 'conversation-new', previewTarget: null, tab: 'overview' });
  });

  it('registers Chat tabs and previews issue links without remounting the transcript', async () => {
    const issueBlock = makeTranscriptBlock({ content: 'Inspect [issue:5096e37] here.' });
    const scopedConversation = mockConversationDetail(defaultControl, [issueBlock]);
    vi.spyOn(api, 'resolveAgentSession').mockResolvedValue({ provider: null, provider_session_id: scopedConversation.session_id, truncated: false, matches: [] });
    vi.spyOn(api, 'getSessions').mockResolvedValue([]);
    vi.spyOn(api, 'getLedgerIssueDetailByIssueId').mockImplementation(() => new Promise(() => undefined));
    const { container } = render(
      <MountedRightSidebarShell>
        <ConversationsView
          consoleSessions={[]}
          initialConversationId={scopedConversation.id}
          initialSessionId={null}
          onSelectSession={() => undefined}
          onNewConversation={() => undefined}
        />
      </MountedRightSidebarShell>,
    );
    const overview = await screen.findByRole('tab', { name: 'Session Overview' });
    expect(overview.getAttribute('aria-selected')).toBe('true');
    const activity = screen.getByRole('tab', { name: 'Activity' });
    fireEvent.click(activity);
    expect(await screen.findByText('No subagents or workflow runs.')).toBeTruthy();
    const scroll = container.querySelector<HTMLElement>('.stream-renderer__scroll')!;
    fireEvent.click(await screen.findByRole('link', { name: /5096e37/ }));
    expect((await screen.findByRole('tab', { name: 'Preview' })).getAttribute('aria-selected')).toBe('true');
    expect(container.querySelector('.stream-renderer__scroll')).toBe(scroll);
  });

  it('settles real app-shell registration after selecting a conversation', async () => {
    const scopedConversation = mockConversationDetail(defaultControl, [transcriptBlock]);
    vi.mocked(api.getConversationSidebar).mockResolvedValue({
      groups: [{
        key: 'chats',
        kind: 'chats',
        label: 'Chats',
        total: 1,
        conversations: [scopedConversation],
        next_cursor: null,
      }],
      limit: 50,
    });
    vi.spyOn(api, 'resolveAgentSession').mockResolvedValue({ provider: null, provider_session_id: scopedConversation.session_id, truncated: false, matches: [] });
    vi.spyOn(api, 'getSessions').mockResolvedValue([]);
    const sidebarUpdates = vi.fn();
    render(<MountedConversationsApp onSidebarUpdate={sidebarUpdates} />);

    fireEvent.click(await screen.findByRole('button', {
      name: `Open conversation ${scopedConversation.title}`,
    }));
    expect(await screen.findByRole('heading', { name: scopedConversation.title! })).toBeTruthy();
    await waitFor(() => expect(sidebarUpdates.mock.calls.length).toBeGreaterThan(0));
    const settledUpdateCount = sidebarUpdates.mock.calls.length;
    await new Promise((resolve) => window.setTimeout(resolve, 20));
    expect(sidebarUpdates).toHaveBeenCalledTimes(settledUpdateCount);
    expect(settledUpdateCount).toBeLessThanOrEqual(3);
  });

  it('routes every Chat detail state through one typed frame construction', () => {
    const source = readFileSync(resolve(process.cwd(), 'ui/src/views/conversations.tsx'), 'utf8');
    const states = Array.from(source.matchAll(/<ChatDetailFrame\s+[\s\S]*?state="([^"]+)"/g), (match) => match[1]).sort();
    expect(states).toEqual(['conversation', 'draft', 'error', 'live-session', 'loading', 'no-selection', 'not-found']);
    expect(source).not.toContain('<div className="chat-live-detail">');
    expect(source).not.toContain('return <LoadingSkeleton variant="detail"');

    const css = readFileSync(resolve(process.cwd(), 'ui/src/styles/conversations.css'), 'utf8');
    expect(css).not.toMatch(/\.chat-live-detail__(?:header|title|title-group|actions)\s*\{/);
  });

  it('renders the unselected Chat main area through the canonical compact shell', () => {
    const { container } = render(
      <ConversationsView
        consoleSessions={[]}
        initialConversationId={null}
        initialSessionId={null}
        onSelectSession={() => undefined}
        onNewConversation={() => undefined}
      />,
    );

    const detail = container.querySelector('.chat-history-detail');
    const shell = detail?.querySelector(':scope > .detail-pane-shell--compact');
    const header = shell?.querySelector(':scope > .detail-pane-shell__header');
    const body = shell?.querySelector(':scope > .detail-pane-shell__body');

    expect(shell?.getAttribute('data-app-surface')).toBe('main');
    expect(shell?.classList.contains('chat-detail-frame--no-selection')).toBe(true);
    expect(header?.querySelector('[data-detail-pane-header-variant="compact"]')).toBeTruthy();
    expect(header?.textContent).toBe('Chat');
    expect(body?.textContent).toContain('No chats in this view');
    expect(detail?.querySelector(':scope > .chat-history-detail__empty')).toBeNull();
  });

  it('renders a live session through the same compact Chat detail frame', async () => {
    const session: ConsoleSession = {
      id: 'live-shell-session',
      label: 'Live shell session',
      agent_type: 'codex',
      interaction_mode: 'direct',
      pinned: false,
      status: 'running',
      is_operator: false,
      provider_session_id: null,
      unread_count: 0,
      created_at: 1,
      started_at: 1,
      stopped_at: null,
      backend_type: 'pty',
      transport_lane: 'pty',
    };
    render(
      <ConversationsView
        consoleSessions={[session]}
        initialConversationId={null}
        initialSessionId={session.id}
        onSelectSession={() => undefined}
        onNewConversation={() => undefined}
      />,
    );

    const heading = await screen.findByRole('heading', { name: session.label });
    const shell = heading.closest('.detail-pane-shell');
    expect(shell?.classList.contains('chat-detail-frame--live-session')).toBe(true);
    expect(shell?.querySelector(':scope > .detail-pane-shell__header [data-detail-pane-header-variant="compact"]'))
      .toBeTruthy();
    expect(shell?.querySelector('.detail-pane-header__compact-metadata')).toBeNull();
    expect(shell?.querySelector(':scope > .detail-pane-shell__header')?.textContent).toBe(session.label);
    expect(shell?.querySelector(':scope > .detail-pane-shell__body.chat-live-detail__pane'))
      .toBeTruthy();
  });

  it('keeps the loading state inside the same compact Chat detail frame', async () => {
    vi.spyOn(api, 'getConversationWindow').mockImplementation(() => new Promise(() => undefined));
    vi.spyOn(api, 'getConversationControl').mockResolvedValue(defaultControl);
    vi.spyOn(api, 'getConversationLiveProjection').mockResolvedValue({
      conversation_id: conversation.id,
      provider: 'codex',
      provider_session_id: conversation.session_id,
      revision: 0,
      generation: 0,
      events: [],
    });

    render(
      <ConversationsView
        consoleSessions={[]}
        initialConversationId={conversation.id}
        initialSessionId={null}
        onSelectSession={() => undefined}
        onNewConversation={() => undefined}
      />,
    );

    const loading = await screen.findByLabelText('Loading conversation');
    const shell = loading.closest('.detail-pane-shell');
    expect(shell?.classList.contains('chat-detail-frame--loading')).toBe(true);
    expect(shell?.querySelector(':scope > .detail-pane-shell__header [data-detail-pane-header-variant="compact"]'))
      .toBeTruthy();
  });

  it('renders a missing conversation through the real not-found state', async () => {
    vi.spyOn(api, 'getConversationWindow').mockRejectedValue(new api.ApiError('Conversation not found', 404));
    vi.spyOn(api, 'getConversationControl').mockRejectedValue(new api.ApiError('Conversation not found', 404));
    vi.spyOn(api, 'getConversationLiveProjection').mockRejectedValue(new api.ApiError('Conversation not found', 404));

    render(
      <ConversationsView
        conversations={[]}
        consoleSessions={[]}
        initialConversationId={conversation.id}
        initialSessionId={null}
        onSelectSession={() => undefined}
        onNewConversation={() => undefined}
      />,
    );

    const message = await screen.findByText('Conversation not found.');
    const shell = message.closest('.detail-pane-shell');
    expect(shell?.classList.contains('chat-detail-frame--not-found')).toBe(true);
    expect(shell?.querySelector(':scope > .detail-pane-shell__header [data-detail-pane-header-variant="compact"]'))
      .toBeTruthy();
    expect(shell?.querySelector(':scope > .detail-pane-shell__notice')).toBeNull();
  });

  it('parses exact block and turn anchors from shareable Chat URLs', () => {
    expect(conversationAnchorFromHash('#/console?conversation=conv&block=block-42')).toEqual({ block: 'block-42' });
    expect(conversationAnchorFromHash('#/console?conversation=conv&turn=turn-9')).toEqual({ turn: 'turn-9' });
    expect(conversationAnchorFromHash('#/console?conversation=conv&position=42')).toEqual({ position: 42 });
    expect(conversationAnchorFromHash('#/console?conversation=conv')).toBeNull();
    expect(conversationAnchorHref('conv 1', { block: 'block/42' })).toBe('#/console?conversation=conv+1&block=block%2F42');
  });

  it('keeps the compact header and optional footer outside the scrolling body', () => {
    const { container } = render(
      <DetailPaneShell
        variant="compact"
        header={<span>Compact title</span>}
        footer={{ content: <button type="button">Submit</button> }}
      >
        <p>Scrollable content</p>
      </DetailPaneShell>,
    );

    const shell = container.querySelector('.detail-pane-shell');
    const header = shell?.querySelector(':scope > .detail-pane-shell__header');
    const body = shell?.querySelector(':scope > .detail-pane-shell__body');
    const footer = shell?.querySelector(':scope > .detail-pane-shell__footer');
    expect(shell?.classList.contains('detail-pane-shell--compact')).toBe(true);
    expect(header?.textContent).toContain('Compact title');
    expect(body?.textContent).toContain('Scrollable content');
    expect(footer?.textContent).toContain('Submit');

    const css = readFileSync(resolve(process.cwd(), 'ui/src/styles/detail-pane-shell.css'), 'utf8');
    expect(css).toMatch(/\.detail-pane-shell__footer\s*\{[^}]*flex:\s*none;/s);
    expect(css).toMatch(/\.detail-pane-shell--compact \.detail-pane-shell__header\s*\{[^}]*box-shadow:\s*none;/s);
    expect(css).toMatch(/\.detail-pane-shell--compact \.detail-pane-shell__header-primary\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;[^}]*justify-content:\s*space-between;/s);

    expect(css).toMatch(/\.detail-pane-shell--compact \.detail-pane-shell__title\s*\{[^}]*color:\s*var\(--text-header-title\);[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s);
    expect(css).toMatch(/\.detail-pane-shell--compact \.detail-pane-shell__actions\s*\{[^}]*flex-shrink:\s*0;/s);

    const defaultShell = render(
      <DetailPaneShell header={<span>Default title</span>}>Default body</DetailPaneShell>,
    ).container.querySelector('.detail-pane-shell');
    expect(defaultShell?.classList.contains('detail-pane-shell--compact')).toBe(false);
    expect(defaultShell?.querySelector('.detail-pane-shell__footer')).toBeNull();
  });

  it('anchors source_unavailable Retry outside the body and keeps it disabled while retrying', async () => {
    const sourceUnavailable = 'Conversation source unavailable (source_unavailable).';
    const retry = deferred<ConversationPositionWindow>();
    const scopedConversation = mockConversationDetail(defaultControl);
    vi.mocked(api.getConversationWindow)
      .mockRejectedValueOnce(new api.ApiError(sourceUnavailable, 409, 'source_unavailable'))
      .mockImplementationOnce(() => retry.promise);

    renderConversationDetail(scopedConversation);

    const alert = await screen.findByRole('alert');
    const shell = alert.closest('.detail-pane-shell');
    const boundary = alert.closest('.detail-pane-shell__notice');
    const body = shell?.querySelector(':scope > .detail-pane-shell__body');
    const retryButton = screen.getByRole('button', { name: 'Retry' }) as HTMLButtonElement;
    expect(alert.textContent).toContain(sourceUnavailable);
    expect(shell?.classList.contains('chat-detail-frame--error')).toBe(true);
    expect(alert.classList.contains('detail-pane-notice--compact')).toBe(true);
    expect(boundary?.getAttribute('data-detail-pane-slot')).toBe('notice');
    expect(shell?.querySelector(':scope > .detail-pane-shell__notice')).toBe(boundary);
    expect(body?.contains(alert)).toBe(false);
    expect(retryButton.disabled).toBe(false);

    fireEvent.click(retryButton);
    await waitFor(() => expect(retryButton.disabled).toBe(true));
    expect(screen.getByRole('alert').textContent).toContain(sourceUnavailable);

    retry.resolve(positionPayload(scopedConversation, [transcriptBlock]));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(api.getConversationWindow).toHaveBeenCalledTimes(2);
  });

  it('uses the server-materialized complete transcript for conversation markdown actions', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const scopedConversation = mockConversationDetail(defaultControl, [transcriptBlock]);
    renderConversationDetail(scopedConversation);

    await screen.findByText(transcriptBlock.content);
    fireEvent.click(screen.getByRole('button', { name: 'Conversation actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy markdown' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining('Server-only unread tail')));
    expect(api.exportConversationBlocks).toHaveBeenCalledWith(conversation.id, { format: 'markdown' });
  });

  it('composes Chat detail through the compact shell with a floating composer and no footer', async () => {
    const style = document.createElement('style');
    style.dataset.testCompactHeaderStyles = '';
    style.textContent = readFileSync(resolve(process.cwd(), 'ui/src/styles/detail-pane-shell.css'), 'utf8')
      .replaceAll('var(--app-header-height)', '48px');
    document.head.append(style);

    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn(() => false),
    });
    const open = vi.fn();
    vi.stubGlobal('open', open);
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:conversation-markdown'),
      revokeObjectURL: vi.fn(),
    });
    const scopedConversation = mockConversationDetail(defaultControl);
    renderConversationDetail(scopedConversation);

    await screen.findByRole('heading', { name: conversation.title! });
    const shell = document.querySelector('.conv-detail.detail-pane-shell--compact');
    const header = shell?.querySelector(':scope > .detail-pane-shell__header');
    const body = shell?.querySelector(':scope > .detail-pane-shell__body.conv-detail__body');
    const overlayControl = shell?.querySelector(':scope > .detail-pane-shell__overlay-control');
    const canonicalHeader = header?.querySelector('.detail-pane-header--compact');
    const conversationCss = readFileSync(resolve(process.cwd(), 'ui/src/styles/conversations.css'), 'utf8');
    expect(getComputedStyle(shell!).overflow).toBe('clip');
    expect(shell?.classList.contains('chat-detail-frame--conversation')).toBe(true);
    expect(getComputedStyle(body!).position).toBe('relative');
    expect(shell?.querySelector(':scope > .detail-pane-shell__footer')).toBeNull();
    expect(overlayControl).toBeTruthy();
    expect(canonicalHeader?.getAttribute('data-detail-pane-header-variant')).toBe('compact');
    expect(canonicalHeader?.textContent).not.toContain('Conversation');
    expect(canonicalHeader?.textContent).not.toContain('01a01639');
    expect(canonicalHeader?.textContent).not.toContain(conversation.id);
    expect(canonicalHeader?.querySelector('.detail-pane-header__identity')).toBeNull();
    expect(canonicalHeader?.querySelector('.ledger-copy-ref-button')).toBeNull();
    expect(canonicalHeader?.querySelector('.conv-detail__status')).toBeNull();
    expect(canonicalHeader?.textContent).not.toContain('Codex');
    expect(canonicalHeader?.textContent).not.toContain('Stopped');
    const titleRow = canonicalHeader?.querySelector('.detail-pane-header__title-row');
    const compactMenu = canonicalHeader?.querySelector('.detail-pane-header__menu');
    const main = canonicalHeader?.querySelector(':scope > .detail-pane-header__main');
    expect(titleRow?.querySelector('.detail-pane-header__title')?.nextElementSibling).toBe(compactMenu);
    expect(titleRow?.nextElementSibling).toBeNull();
    expect(getComputedStyle(canonicalHeader!).height).toBe('48px');
    expect(getComputedStyle(main!).height).toBe('100%');
    expect(getComputedStyle(main!).flexDirection).toBe('row');
    expect(getComputedStyle(main!).alignItems).toBe('center');
    expect(canonicalHeader?.querySelector('.detail-pane-header__title')?.getAttribute('title')).toBe(conversation.title);
    expect(compactMenu?.getAttribute('aria-label')).toBe('Conversation detail actions');
    expect(canonicalHeader?.querySelector('.conv-actions__trigger')).toBeTruthy();
    expect(canonicalHeader?.querySelector('.conv-info-button')).toBeNull();
    expect(body?.querySelector('.context-usage')).toBeNull();
    expect(shell?.querySelectorAll('.context-usage')).toHaveLength(1);
    const runtime = overlayControl?.querySelector('.conv-compose__runtime');
    const inlineRunOptions = runtime?.querySelector('.conv-compose__run-options-inline');
    const runtimeActions = runtime?.querySelector('.conv-compose__runtime-actions');
    expect(inlineRunOptions).toBeTruthy();
    expect(runtimeActions?.classList.contains('conv-compose__runtime-actions')).toBe(true);
    const runOptions = await screen.findByRole('button', { name: 'Run options' });
    expect(runtimeActions?.firstElementChild).toBe(runOptions);
    expect(runtimeActions?.children[1]?.classList.contains('context-usage')).toBe(true);
    expect(runtimeActions?.lastElementChild?.classList.contains('conv-compose__send')).toBe(true);
    expect(overlayControl?.querySelector('.conv-compose__hint')).toBeNull();
    const composerInput = screen.getByPlaceholderText('Message...') as HTMLTextAreaElement;
    const submit = screen.getByRole('button', { name: 'Resume' }) as HTMLButtonElement;
    const submitIcon = submit.querySelector('svg');
    expect(composerInput).toBeTruthy();
    expect(submit.disabled).toBe(true);
    expect(submitIcon?.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(submitIcon?.getAttribute('stroke-width')).toBe('1');
    fireEvent.input(composerInput, { target: { value: 'Resume this chat.' } });
    expect(submit.disabled).toBe(false);
    expect(overlayControl?.textContent).not.toContain('Sending will resume this session.');

    fireEvent.click(screen.getByRole('button', { name: 'Conversation actions' }));
    const menu = screen.getByRole('menu');
    expect(menu.querySelectorAll('[role="menuitem"]')).toHaveLength(5);
    expect(screen.queryByRole('menuitem', { name: 'Select messages' })).toBeNull();
    expect(screen.queryByText('Inspect raw blocks')).toBeNull();
    expect(document.querySelector('.conv-blocks')).toBeNull();
    expect(document.querySelector('.block-user-message')).toBeNull();
    expect(document.querySelector('.block-assistant-message')).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: 'View metadata' }));
    expect(screen.getByRole('dialog', { name: 'Conversation metadata' })).toBeTruthy();
    const projectLabel = screen.getByText('Project');
    expect(projectLabel.parentElement?.textContent).toBe('ProjectUnscoped');
    fireEvent.click(screen.getByRole('button', { name: 'Close conversation metadata' }));
    expect(body?.querySelector('.conv-transcript')).toBeTruthy();
    const composer = overlayControl?.querySelector('.conv-compose');
    expect(composer).toBeTruthy();
    const tokensCss = readFileSync(resolve(process.cwd(), 'ui/src/styles/tokens.css'), 'utf8');
    const baseCss = readFileSync(resolve(process.cwd(), 'ui/src/styles/base.css'), 'utf8');
    const messageBlocksCss = readFileSync(resolve(process.cwd(), 'ui/src/styles/message-blocks.css'), 'utf8');
    expect(tokensCss).toContain('--radius-chat-surface: 18px;');
    expect(conversationCss).toMatch(/\.conv-compose\s*\{[^}]*border-radius:\s*var\(--radius-chat-surface\);/s);
    expect(conversationCss).toMatch(/\.conv-compose__run-options-inline\s*\{[^}]*flex:\s*1 1 auto;[^}]*min-width:\s*0;/s);
    expect(conversationCss).toMatch(/\.conv-compose__run-options-inline \.session-controls__field\s*\{[^}]*flex:\s*0 0 auto;[^}]*max-width:\s*min\(240px, 100%\);/s);
    expect(conversationCss).toMatch(/\.conv-compose__run-options-inline \.session-controls__select\s*\{[^}]*width:\s*auto;[^}]*min-width:\s*44px;[^}]*field-sizing:\s*content;/s);
    expect(conversationCss).toMatch(/\.conv-compose__runtime-actions\s*\{[^}]*flex:\s*0 0 auto;[^}]*width:\s*auto;/s);
    expect(conversationCss).toMatch(/\.conv-detail__body \.user-bubble__text :where\(p, li, blockquote, dd\)[^{]*\{[^}]*font-size:\s*var\(--text-lg\);/s);
    expect(conversationCss).toMatch(/\.conv-compose__send\s*\{[^}]*--chat-circle-action-visual-size:\s*25\.5px;[^}]*--chat-circle-action-icon-size:\s*17px;/s);
    expect(baseCss).toMatch(/\.chat-circle-action::before\s*\{[^}]*width:\s*var\(--chat-circle-action-visual-size\);[^}]*height:\s*var\(--chat-circle-action-visual-size\);/s);
    expect(baseCss).toMatch(/\.chat-circle-action > svg\s*\{[^}]*width:\s*var\(--chat-circle-action-icon-size\);[^}]*height:\s*var\(--chat-circle-action-icon-size\);/s);
    expect(conversationCss).not.toContain('@container (max-width: 700px)');
    expect(messageBlocksCss).toMatch(/\.user-bubble__text\s*\{[^}]*border-radius:\s*var\(--radius-chat-surface\);/s);
    expect(overlayControl?.querySelector('.conv-compose__runtime .agent-mark')).toBeNull();
    fireEvent.click(runOptions);
    const runOptionsDialog = screen.getByRole('dialog', { name: 'Run options' });
    const modelSelect = within(runOptionsDialog).getByRole('combobox', { name: 'Model' }) as HTMLSelectElement;
    await waitFor(() => expect(modelSelect.value).toBe(conversation.model));
    expect(modelSelect.title).toBe('Model');
    fireEvent.click(screen.getByRole('button', { name: 'Conversation actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy markdown' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining('Server-only unread tail')));
    expect(api.exportConversationBlocks).toHaveBeenCalledWith(conversation.id, { format: 'markdown' });
    fireEvent.click(screen.getByRole('button', { name: 'Conversation actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open markdown' }));
    await waitFor(() => expect(open).toHaveBeenCalledWith('blob:conversation-markdown', '_blank', 'noopener,noreferrer'));
    fireEvent.click(screen.getByRole('button', { name: 'Conversation actions' }));
    expect(screen.queryByRole('menuitem', { name: 'Message filters' })).toBeNull();
    expect(body?.querySelector('.conv-filter-bar')).toBeNull();
    await waitFor(() => expect(shell?.getAttribute('aria-busy')).toBe('false'));
  });

  it('ends the composer mask before the transcript scrollbar gutter', () => {
    const shellCss = readFileSync(resolve(process.cwd(), 'ui/src/styles/detail-pane-shell.css'), 'utf8');
    const conversationCss = readFileSync(resolve(process.cwd(), 'ui/src/styles/conversations.css'), 'utf8');

    expect(shellCss).toMatch(/\.detail-pane-shell__overlay-control\s*\{[^}]*inset:\s*auto var\(--detail-pane-scrollbar-width, 0px\) 0 0;/s);
    expect(conversationCss).toMatch(/\.detail-pane-shell--overlay-control \.detail-pane-shell__overlay-control\s*\{[^}]*--conversation-composer-inline-margin:\s*18px;/s);
    expect(conversationCss).toMatch(/\.conv-compose\s*\{[^}]*margin:\s*0 var\(--conversation-composer-inline-margin, 18px\) 16px;/s);
    expect(conversationCss).toMatch(/\.detail-pane-shell--overlay-control \.detail-pane-shell__overlay-control::before\s*\{[^}]*top:\s*calc\(50% - 8px\);[^}]*right:\s*var\(--conversation-composer-inline-margin\);[^}]*bottom:\s*0;[^}]*left:\s*0;[^}]*pointer-events:\s*none;/s);
  });

  it('puts every provider-neutral run option in the canonical composer popover', async () => {
    const resizeCallbacks: ResizeObserverCallback[] = [];
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) { resizeCallbacks.push(callback); }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    });
    let modelWidth = 100;
    let modeWidth = 70;
    let runtimeWidth = 380;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function getBounds() {
      if (this.classList.contains('conv-compose__runtime')) return domRect(0, 0, runtimeWidth, 30);
      if (this.classList.contains('session-controls__field')) {
        const label = this.querySelector('select')?.getAttribute('aria-label');
        return domRect(0, 0, label === 'Model' ? modelWidth : label === 'Mode' ? modeWidth : 90, 30);
      }
      if (this.classList.contains('context-usage') || this.classList.contains('conv-compose__send')) {
        return domRect(0, 0, 30, 30);
      }
      return domRect(0, 0, 0, 0);
    });
    const linkedSession: ConsoleSession = {
      id: 'console-codex-1',
      label: 'Codex session',
      agent_type: 'codex',
      interaction_mode: 'direct',
      pinned: false,
      status: 'stopped',
      is_operator: false,
      provider_session_id: conversation.session_id,
      unread_count: 0,
      created_at: 1,
      started_at: 1,
      stopped_at: 2,
      backend_type: 'acp',
      transport_lane: 'acp',
    };
    const runOptions: api.SessionRunOptionsSnapshot = {
      backendType: 'acp',
      command: 'codex',
      phase: 'ready',
      revision: 1,
      options: [
        {
          id: 'model', label: 'Model', category: 'model', kind: 'select', nullable: false, source: 'provider',
          availability: 'available', currentValue: 'gpt-5.6-sol', allowedValues: [{ value: 'gpt-5.6-sol', label: 'gpt-5.6-sol' }],
          enforcement: { status: 'enforced', owner: 'provider', effectiveFrom: 'next_prompt' },
        },
        {
          id: 'reasoning_effort', label: 'Reasoning effort', category: 'thought_level', kind: 'select', nullable: false, source: 'provider',
          availability: 'available', currentValue: 'medium', allowedValues: [{ value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }],
          enforcement: { status: 'enforced', owner: 'provider', effectiveFrom: 'next_prompt' },
        },
        {
          id: 'mode', label: 'Mode', category: 'mode', kind: 'select', nullable: false, source: 'provider',
          availability: 'available', currentValue: 'agent', allowedValues: [{ value: 'read-only', label: 'Read only' }, { value: 'agent', label: 'Agent' }],
          enforcement: { status: 'enforced', owner: 'provider', effectiveFrom: 'next_prompt' },
        },
      ],
    };
    vi.spyOn(api, 'getConsoleSessionUsage').mockResolvedValue([]);
    vi.spyOn(api, 'getConsoleSessionOptions').mockResolvedValue({ runOptions, mandibleControls: { allowedTools: null } });
    vi.spyOn(api, 'updateConsoleSessionOptions').mockResolvedValue({ runOptions });
    const ownedControl: ConversationControlSnapshot = {
      ...defaultControl,
      ownership: {
        kind: 'mandible', generation: 1, controller_instance_id: 'controller-1', adapter_id: 'codex',
        provider_session_id: conversation.session_id, last_authoritative_signal: 2,
      },
    };
    const scopedConversation = mockConversationDetail(ownedControl);
    renderConversationDetail(scopedConversation, [linkedSession]);

    const trigger = await screen.findByRole('button', { name: 'Run options' });
    const runtime = document.querySelector('.conv-compose__runtime');
    const inlineRunOptions = runtime?.querySelector('.conv-compose__run-options-inline');
    const actions = runtime?.querySelector('.conv-compose__runtime-actions');
    await waitFor(() => expect(inlineRunOptions?.querySelectorAll('select')).toHaveLength(3));
    expect(runtime?.classList.contains('conv-compose__runtime--run-options-overflow')).toBe(false);
    expect(inlineRunOptions?.getAttribute('aria-hidden')).toBeNull();
    fireEvent.input(screen.getByRole('combobox', { name: 'Mode' }), { target: { value: 'read-only' } });
    await waitFor(() => expect(runtime?.classList.contains('conv-compose__runtime--run-options-overflow')).toBe(false));
    modeWidth = 230;
    fireEvent.change(screen.getByRole('combobox', { name: 'Mode' }), { target: { value: 'agent' } });
    await waitFor(() => expect(runtime?.classList.contains('conv-compose__runtime--run-options-overflow')).toBe(true));
    modeWidth = 70;
    fireEvent.change(inlineRunOptions?.querySelector('select[aria-label="Mode"]') as HTMLSelectElement, { target: { value: 'read-only' } });
    await waitFor(() => expect(runtime?.classList.contains('conv-compose__runtime--run-options-overflow')).toBe(false));
    modelWidth = 220;
    act(() => resizeCallbacks.forEach((callback) => callback([], {} as ResizeObserver)));
    await waitFor(() => expect(runtime?.classList.contains('conv-compose__runtime--run-options-overflow')).toBe(true));
    expect(inlineRunOptions?.getAttribute('aria-hidden')).toBe('true');
    modelWidth = 100;
    act(() => resizeCallbacks.forEach((callback) => callback([], {} as ResizeObserver)));
    await waitFor(() => expect(runtime?.classList.contains('conv-compose__runtime--run-options-overflow')).toBe(false));
    runtimeWidth = 180;
    act(() => resizeCallbacks.forEach((callback) => callback([], {} as ResizeObserver)));
    await waitFor(() => expect(runtime?.classList.contains('conv-compose__runtime--run-options-overflow')).toBe(true));
    runtimeWidth = 380;
    act(() => resizeCallbacks.forEach((callback) => callback([], {} as ResizeObserver)));
    await waitFor(() => expect(runtime?.classList.contains('conv-compose__runtime--run-options-overflow')).toBe(false));
    expect(actions?.children[0]).toBe(trigger);
    expect(actions?.children[1]?.classList.contains('context-usage')).toBe(true);
    expect(actions?.children[2]?.classList.contains('conv-compose__send')).toBe(true);
    expect(screen.queryByRole('combobox', { name: 'Permission mode' })).toBeNull();
    fireEvent.click(trigger);
    await screen.findByRole('dialog', { name: 'Run options' });
    await waitFor(() => expect(Array.from(
      screen.getByRole('dialog', { name: 'Run options' }).querySelectorAll('select'),
      (select) => select.getAttribute('aria-label'),
    )).toEqual(expect.arrayContaining(['Mode', 'Model', 'Reasoning effort'])));
    const popover = screen.getByRole('dialog', { name: 'Run options' });
    const permission = popover.querySelector<HTMLSelectElement>('select[aria-label="Mode"]')!;
    const effort = popover.querySelector<HTMLSelectElement>('select[aria-label="Reasoning effort"]')!;

    expect(Array.from((permission as HTMLSelectElement).options, (option) => option.value)).toEqual(['read-only', 'agent']);
    expect(Array.from((effort as HTMLSelectElement).options, (option) => option.value)).toEqual(['medium', 'high']);
  });

  it('clamps the Chat header menu and dismisses with Escape, outside click, and focus restoration', async () => {
    vi.stubGlobal('innerWidth', 1024);
    vi.stubGlobal('innerHeight', 768);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function getBounds() {
      if (this.classList.contains('conv-actions__trigger')) return domRect(1004, 730, 20, 22);
      if (this.classList.contains('conv-actions__menu')) return domRect(0, 0, 240, 280);
      return domRect(0, 0, 0, 0);
    });
    const scopedConversation = mockConversationDetail(defaultControl);
    renderConversationDetail(scopedConversation);

    await screen.findByRole('heading', { name: conversation.title! });
    const trigger = screen.getByRole('button', { name: 'Conversation actions' });
    fireEvent.click(trigger);
    const menu = await screen.findByRole('menu');
    await waitFor(() => {
      expect(menu.style.position).toBe('fixed');
      expect(menu.style.left).toBe('776px');
      expect(menu.style.top).toBe('444px');
      expect(menu.style.visibility).toBe('visible');
    });
    expect(menu.classList.contains('app-anchored-menu')).toBe(true);
    expect(menu.getAttribute('popover')).toBe('manual');

    const composer = screen.getByPlaceholderText('Message...');
    composer.focus();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    expect(await screen.findByRole('menu')).toBeTruthy();
    composer.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it('anchors typed control failures outside the transcript and retries only retryable failures', async () => {
    const ownedControl: ConversationControlSnapshot = {
      ...defaultControl,
      ownership: {
        kind: 'mandible', generation: 1, controller_instance_id: 'controller-1', adapter_id: 'codex',
        provider_session_id: conversation.session_id, last_authoritative_signal: 2,
      },
      capability: { kind: 'live-send', revision: 1, generation: 1 },
    };
    const accepted = {
      kind: 'accepted' as const,
      delivery_id: 'delivery-2',
      turn_id: 'turn-2',
      snapshot: ownedControl,
    };
    vi.spyOn(api, 'submitConversationControl')
      .mockRejectedValueOnce(Object.assign(new Error('adapter-failure'), {
        controlError: {
          kind: 'adapter-failure' as const,
          adapter_id: 'codex',
          code: 'startup-failed',
          message: 'The provider process exited before accepting the message.',
          retryable: true,
        },
        snapshot: ownedControl,
      }))
      .mockResolvedValueOnce(accepted);
    const scopedConversation = mockConversationDetail(ownedControl);
    const { container } = render(
      <ConversationsView
        conversations={[scopedConversation]}
        consoleSessions={[]}
        initialConversationId={scopedConversation.id}
        initialSessionId={null}
        onSelectSession={() => undefined}
        onNewConversation={() => undefined}
      />,
    );

    const composer = await screen.findByPlaceholderText('Message...');
    fireEvent.input(composer, { target: { value: 'Keep this draft for retry.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The provider could not complete this action.');
    expect(alert.closest('[data-detail-pane-slot="notice"]')).toBeTruthy();
    expect(container.querySelector('.stream-renderer__scroll')?.contains(alert)).toBe(false);
    expect(screen.getByText('Provider diagnostics').closest('details')?.open).toBe(false);
    expect((composer as HTMLTextAreaElement).value).toBe('Keep this draft for retry.');

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(api.submitConversationControl).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it.each([
    {
      label: 'live',
      control: {
        ...defaultControl,
        revision: 2,
        ownership: { kind: 'mandible', generation: 1, controller_instance_id: 'controller-1', adapter_id: 'codex', provider_session_id: 'provider-live', last_authoritative_signal: 2 },
        controller: { kind: 'running', since: 2 },
        turn: { kind: 'running', turn_id: 'turn-1', since: 2 },
        capability: { kind: 'live-steer', revision: 2, generation: 1 },
      } satisfies ConversationControlSnapshot,
      hasComposer: true,
    },
    {
      label: 'external live',
      control: {
        ...defaultControl,
        revision: 2,
        ownership: { kind: 'external', generation: 1, evidence: { kind: 'registered-process', reference: 'external-live' }, last_authoritative_signal: 2 },
        controller: { kind: 'unknown', since: 2, reason: 'probe-ambiguous' },
        turn: { kind: 'unknown', turn_id: null, since: 2, reason: 'probe-ambiguous' },
        capability: { kind: 'blocked-external', revision: 2, evidence_kind: 'registered-process' },
      } satisfies ConversationControlSnapshot,
      hasComposer: true,
    },
    {
      label: 'stopped',
      control: defaultControl,
      hasComposer: true,
    },
    {
      label: 'historical',
      control: {
        ...defaultControl,
        provider_session_id: null,
        ownership: { kind: 'none', generation: 0 },
        capability: { kind: 'unavailable', revision: 0, reason: 'no-provider-session' },
      } satisfies ConversationControlSnapshot,
      hasComposer: false,
    },
  ])('keeps the provider-neutral header and composer contract in $label state', async ({ control, hasComposer }) => {
    const scopedConversation = mockConversationDetail(control);
    renderConversationDetail(scopedConversation);

    await screen.findByRole('heading', { name: conversation.title! });
    const header = document.querySelector('.detail-pane-header--compact') as HTMLElement;
    expect(header.querySelector('.conv-detail__status')).toBeNull();
    expect(header.querySelector('.detail-pane-header__compact-metadata')).toBeNull();
    for (const forbidden of ['Codex', 'Running', 'External', 'Stopped', 'Unavailable']) {
      expect(header.textContent).not.toContain(forbidden);
    }
    expect(header.querySelector('.detail-pane-header__title')?.nextElementSibling?.classList.contains('detail-pane-header__menu')).toBe(true);
    expect(header.querySelector('.detail-pane-header__topline')).toBeNull();
    expect(header.querySelector('.detail-pane-header__identity')).toBeNull();
    expect(header.querySelector('.conv-info-button')).toBeNull();
    expect(Boolean(document.querySelector('.conv-compose'))).toBe(hasComposer);
    if (control.capability.kind === 'blocked-external') {
      expect(document.querySelectorAll('.conv-compose__hint')).toHaveLength(0);
      expect((screen.getByPlaceholderText('Message...') as HTMLTextAreaElement).disabled).toBe(true);
      expect(document.querySelector('.conv-compose')?.textContent).toContain('Another controller owns this provider session.');
    }
    fireEvent.click(screen.getByRole('button', { name: 'Conversation actions' }));
    expect(screen.getByRole('menuitem', { name: 'View metadata' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Copy markdown' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Open markdown' })).toBeTruthy();
  });

  it('keeps exact-anchor loading last-request-wins', async () => {
    const scopedConversation = mockConversationDetail(defaultControl, []);
    const initial = deferred<ConversationPositionWindow>();
    const exact = deferred<ConversationPositionWindow>();
    vi.mocked(api.getConversationWindow).mockImplementation(async (_id, request) => (
      'block' in request ? exact.promise : initial.promise
    ));
    window.history.replaceState(null, '', `#/console?conversation=${conversation.id}`);
    const props = {
      consoleSessions: [],
      initialConversationId: scopedConversation.id,
      initialSessionId: null,
      onSelectSession: () => undefined,
      onNewConversation: () => undefined,
    };
    const view = render(<ConversationsView {...props} />);
    await waitFor(() => expect(api.getConversationWindow).toHaveBeenCalledTimes(1));

    window.history.replaceState(null, '', `#/console?conversation=${conversation.id}&block=exact-block`);
    view.rerender(<ConversationsView {...props} />);
    await waitFor(() => expect(api.getConversationWindow).toHaveBeenCalledTimes(2));

    const exactBlock = makeTranscriptBlock({ id: 'exact-block', dag_uuid: 'exact-block', content: 'Exact anchor wins', position: 50 });
    exact.resolve(positionPayload(scopedConversation, [exactBlock], { kind: 'block', hasAfter: true, revision: 100 }));
    expect(await screen.findByText('Exact anchor wins')).toBeTruthy();

    initial.resolve(positionPayload(scopedConversation, [makeTranscriptBlock({ content: 'Late initial loses' })], { revision: 100 }));
    await Promise.resolve();
    expect(screen.queryByText('Late initial loses')).toBeNull();
    expect(screen.getByText('Exact anchor wins')).toBeTruthy();
  });

  it('keeps the live transcript mounted while a same-conversation reconciliation is pending', async () => {
    const scopedConversation = mockConversationDetail(defaultControl, [transcriptBlock]);
    const refresh = deferred<ConversationPositionWindow>();
    const appendedBlock = makeTranscriptBlock({
      id: 'block-user-2',
      dag_uuid: 'block-user-2',
      content: 'Live content stays visible',
      position: 1,
    });
    vi.mocked(api.getConversationWindow)
      .mockResolvedValueOnce(positionPayload(scopedConversation, [transcriptBlock]))
      .mockImplementationOnce(() => refresh.promise);

    renderConversationDetail(scopedConversation);
    expect(await screen.findByText(transcriptBlock.content)).toBeTruthy();

    act(() => {
      applyConversationSse(queryClient, 'conversation:updated', {
        id: conversation.id,
        block_count: 2,
        append: { from_position: 1, blocks: [appendedBlock] },
      });
    });
    expect(await screen.findByText('Live content stays visible')).toBeTruthy();

    act(() => {
      applyConversationSse(queryClient, 'conversation:updated', {
        id: conversation.id,
        block_count: 4,
        append: {
          from_position: 3,
          blocks: [makeTranscriptBlock({ id: 'gap-block', dag_uuid: 'gap-block', position: 3, content: appendedBlock.content })],
        },
      });
    });

    await waitFor(() => expect(api.getConversationWindow).toHaveBeenCalledTimes(2));
    expect(screen.getByText('Live content stays visible')).toBeTruthy();
    expect(screen.getByPlaceholderText('Message...')).toBeTruthy();

    await act(async () => refresh.resolve(positionPayload(scopedConversation, [transcriptBlock, appendedBlock])));
    expect(screen.getByText('Live content stays visible')).toBeTruthy();
  });

  it('keeps Codex provisional assistant content until its durable replacement arrives', async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    const sseFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/client-auth/whoami') {
        return new Response(JSON.stringify({ authenticated: true, session: {
          family_id: 'provider-event-test', audience: 'production', csrf_token: 'csrf',
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
    const emit = (data: unknown) => {
      streamController?.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`));
    };

    const scopedConversation = mockConversationDetail(defaultControl, [transcriptBlock]);
    const durable = deferred<ConversationPositionWindow>();
    vi.mocked(api.getConversationWindow)
      .mockResolvedValueOnce(positionPayload(scopedConversation, [transcriptBlock]))
      .mockImplementationOnce(() => durable.promise);
    vi.spyOn(api, 'getConversationLiveProjection').mockResolvedValue({
      conversation_id: conversation.id,
      revision: 0,
      generation: 0,
      events: [],
    });
    renderConversationDetail(scopedConversation);
    expect(await screen.findByText(transcriptBlock.content)).toBeTruthy();
    await waitFor(() => expect(streamController).not.toBeNull());

    const liveAssistant: ChatItem = {
      type: 'message',
      role: 'assistant',
      identity: {
        provider: 'codex',
        session_id: conversation.session_id,
        native_item_id: 'agent-1',
        native_turn_id: 'agent-1',
        source_record_ordinal: 0,
        source_sub_block_ordinal: 0,
      },
      provenance: { source: 'live-provider-event', provider: 'codex', source_event_type: 'agent_message' },
      parts: [{ type: 'text', text: 'Assistant stays continuous' }],
      content_completion: 'streaming',
    };
    const liveIdentity = chatItemIdentityKey(liveAssistant)!;

    act(() => emit({
      type: 'conversation:provider-event',
      data: {
        kind: 'provisional-content',
        conversation_id: conversation.id,
        provider_session_id: conversation.session_id,
        generation: 1,
        sequence: 1,
        observed_at: 1,
        identity: liveIdentity,
        item: liveAssistant,
      },
    }));
    expect(await screen.findByText('Assistant stays continuous')).toBeTruthy();

    act(() => emit({
      type: 'conversation:provider-event',
      data: {
        kind: 'durable-reconciliation',
        conversation_id: conversation.id,
        provider_session_id: conversation.session_id,
        generation: 1,
        sequence: 2,
        observed_at: 2,
        provider_event_id: 'reconcile-1',
        covered_identities: [liveIdentity],
      },
    }));
    await waitFor(() => expect(api.getConversationWindow).toHaveBeenCalledTimes(2));
    expect(screen.getByText('Assistant stays continuous')).toBeTruthy();

    const durableAssistant = makeTranscriptBlock({
      id: 'block-agent-1',
      type: 'assistant_message',
      role: 'assistant',
      content: 'Assistant stays continuous',
      position: 1,
      dag_uuid: 'agent-1',
      metadata_json: JSON.stringify({ provider_message_id: 'agent-1' }),
    });
    await act(async () => durable.resolve(positionPayload(scopedConversation, [transcriptBlock, durableAssistant])));
    await waitFor(() => expect(screen.getAllByText('Assistant stays continuous')).toHaveLength(1));
  });

  it('re-resolves the true end when an append arrives during Jump to latest', async () => {
    const scopedConversation = mockConversationDetail(defaultControl, []);
    const firstLatest = deferred<ConversationPositionWindow>();
    const trueLatest = deferred<ConversationPositionWindow>();
    let latestCalls = 0;
    const middleBlock = makeTranscriptBlock({ id: 'middle', dag_uuid: 'middle', content: 'Middle window', position: 1 });
    vi.mocked(api.getConversationWindow).mockImplementation(async (_id, request) => {
      if ('target' in request && request.target === 'latest') {
        latestCalls += 1;
        return latestCalls === 1 ? firstLatest.promise : trueLatest.promise;
      }
      return positionPayload(scopedConversation, [middleBlock], {
        kind: 'block',
        hasAfter: true,
        afterCount: 1,
        revision: 2,
      });
    });
    window.history.replaceState(null, '', `#/console?conversation=${conversation.id}&block=middle`);
    renderConversationDetail(scopedConversation);
    expect(await screen.findByText('Middle window')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /jump to latest/i })).toBeNull();

    applyConversationSse(queryClient, 'conversation:updated', {
      id: conversation.id,
      block_count: 12,
      append: {
        from_position: 2,
        blocks: Array.from({ length: 10 }, (_, index) => makeTranscriptBlock({
          id: `append-${index + 2}`,
          dag_uuid: `append-${index + 2}`,
          position: index + 2,
          content: `append ${index + 2}`,
        })),
      },
    });

    fireEvent.click(await screen.findByRole('button', { name: /jump to latest/i }));
    await waitFor(() => expect(latestCalls).toBe(1));
    applyConversationSse(queryClient, 'conversation:updated', {
      id: conversation.id,
      block_count: 13,
      append: { from_position: 12, blocks: [makeTranscriptBlock({ id: 'append-12', dag_uuid: 'append-12', position: 12, content: 'append 12' })] },
    });
    firstLatest.resolve(positionPayload(scopedConversation, [makeTranscriptBlock({ id: 'old-tail', dag_uuid: 'old-tail', position: 11, content: 'Old tail' })], { kind: 'latest', revision: 12 }));
    await waitFor(() => expect(latestCalls).toBe(2));
    trueLatest.resolve(positionPayload(scopedConversation, [makeTranscriptBlock({ id: 'true-tail', dag_uuid: 'true-tail', position: 12, content: 'Newest true tail' })], { kind: 'latest', revision: 13 }));
    expect(await screen.findByText('Newest true tail')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /jump to latest/i })).toBeNull();
    expect(window.location.hash).toBe(`#/console?conversation=${conversation.id}`);
  });
});
