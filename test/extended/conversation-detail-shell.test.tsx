import { mockConversationStructureFromWindow, mockManagedSettings, changeNativeSelect } from '../helpers/conversation-ui-transport';
import { establishTestClientAccess } from '../helpers/local-client-access';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ComponentChildren } from 'preact';
import { useCallback, useRef, useState } from 'preact/hooks';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/preact';
import { render } from './notice-test-render';
import { CancelledError } from '@tanstack/preact-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as api from '../../ui/src/api.js';
import type { Conversation, ConversationBlock, ConversationControlSnapshot, ConversationPositionWindow } from '../../ui/src/api.js';
import { DetailPaneShell } from '../../ui/src/components/shared/DetailPaneShell.js';
import { AppShellProvider, type AppRightSidebarDescriptor } from '../../ui/src/app-shell.js';
import { __resetSharedSseForTests } from '../../ui/src/sse-shared.js';
import type { ConsoleSession } from '../../ui/src/state.js';
import {
  ConversationDetail,
  ConversationsView,
  conversationAnchorFromHash,
  conversationAnchorHref,
  conversationLoadFailure,
  scopeConversationRightSidebar,
} from '../../ui/src/views/conversations.js';
import { chatItemIdentityKey } from '../../src/conversation-control/provider-live.js';
import type { ChatItem } from '../../src/parsers/types.js';
import { queryClient } from '../../ui/src/query/client.js';
import { conversationKeys } from '../../ui/src/query/conversationKeys.js';
import type { ConversationTranscriptData } from '../../ui/src/query/conversationData.js';
import { applyConversationSse } from '../../ui/src/query/conversationSse.js';
import { addDraftAttachments, clearAcceptedDraft } from '../../ui/src/chat/attachmentDrafts.js';


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

beforeEach(async () => {
  await establishTestClientAccess();
  window.localStorage.clear();
  mockConversationStructureFromWindow();
  mockManagedSettings({ model: conversation.model!, effort: 'medium', permission_mode: 'agent' });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(2400);
  vi.stubGlobal('WebSocket', class { static OPEN = 1; readyState = 0; addEventListener(): void {} removeEventListener(): void {} send(): void {} close(): void {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, writable: true, value: () => {} });
  vi.spyOn(HTMLElement.prototype, 'scrollTo').mockImplementation(() => {});
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
    hasBefore?: boolean;
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
      has_before: options.hasBefore ?? false,
      has_after: options.hasAfter ?? false,
      after_count: options.hasAfter ? (options.afterCount ?? Math.max(1, revision - blocks.length)) : 0,
      limit: 160,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
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
    <AppShellProvider value={{ rightSidebar: sidebar, registerRightSidebar, updateRightSidebar, registerInitialRouteLoad: () => undefined, setViewSidebarWidth: () => undefined, active: true }}>
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
    <AppShellProvider value={{ rightSidebar: sidebar, registerRightSidebar, updateRightSidebar, registerInitialRouteLoad: () => undefined, setViewSidebarWidth: () => undefined, active: true }}>
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

  it('does not turn an obsolete transcript request into a visible Chat error', () => {
    expect(conversationLoadFailure(new CancelledError(), true, 'edge-older')).toBeNull();
    expect(conversationLoadFailure(new DOMException('aborted', 'AbortError'), true, 'refresh')).toBeNull();
    expect(conversationLoadFailure(new Error('read failed'), true, 'refresh')).toMatchObject({
      message: 'read failed',
      operation: 'refresh',
    });
  });

  it('keeps a pinned Chat blank until a pending source reparse yields a real window', async () => {
    const pinned = mockConversationDetail(defaultControl, []);
    const readable = makeTranscriptBlock({ id: 'after-reparse', content: 'Recovered pinned message' });
    let attempts = 0;
    vi.mocked(api.getConversationWindow).mockImplementation(async () => {
      if (++attempts === 1) throw new api.ApiError('conversation is being reindexed', 503, 'freshness_pending');
      return positionPayload(pinned, [readable]);
    });
    renderConversationDetail({ ...pinned, starred: true, block_count: 1 });
    expect(screen.queryByText('No messages yet')).toBeNull();
    expect(screen.queryByText('conversation is being reindexed')).toBeNull();
    expect(await screen.findByText('Recovered pinned message', {}, { timeout: 3_000 })).toBeTruthy();
    expect(attempts).toBe(2);
  });

  it('loads the selected Chat after navigating away from a pending reparse and back', async () => {
    const first = mockConversationDetail(defaultControl, []);
    const second = { ...first, id: 'different-chat', title: 'Different chat' };
    const firstBlock = makeTranscriptBlock({ id: 'first-after-return', content: 'First chat returned' });
    const secondBlock = makeTranscriptBlock({ id: 'second-chat', content: 'Second chat opened' });
    let firstAttempts = 0;
    vi.mocked(api.getConversationWindow).mockImplementation(async (id) => {
      if (id === second.id) return positionPayload(second, [secondBlock]);
      if (++firstAttempts === 1) throw new api.ApiError('source pending', 503, 'freshness_pending');
      return positionPayload(first, [firstBlock]);
    });
    const view = (id: string) => (
      <ConversationsView
        conversations={[first, second]}
        consoleSessions={[]}
        initialConversationId={id}
        initialSessionId={null}
        onSelectSession={() => undefined}
        onNewConversation={() => undefined}
      />
    );
    const mounted = render(view(first.id));
    await waitFor(() => expect(firstAttempts).toBe(1));
    expect(screen.queryByText('No messages yet')).toBeNull();
    mounted.rerender(view(second.id));
    expect(await screen.findByText('Second chat opened')).toBeTruthy();
    mounted.rerender(view(first.id));
    expect(await screen.findByText('First chat returned', {}, { timeout: 3_000 })).toBeTruthy();
    expect(screen.queryByText('No messages yet')).toBeNull();
    expect(firstAttempts).toBeGreaterThanOrEqual(2);
  });

  it('keeps the visible transcript while its pending refresh completes', async () => {
    const pinned = mockConversationDetail(defaultControl, [transcriptBlock]);
    const added = makeTranscriptBlock({ id: 'refresh-added', position: 1, content: 'Message after refresh' });
    let attempts = 0;
    vi.mocked(api.getConversationWindow).mockImplementation(async () => {
      if (++attempts === 1) return positionPayload(pinned, [transcriptBlock]);
      if (attempts === 2) throw new api.ApiError('source pending', 503, 'freshness_pending');
      return positionPayload(pinned, [transcriptBlock, added], { revision: 2 });
    });
    renderConversationDetail({ ...pinned, starred: true });
    expect(await screen.findByText(transcriptBlock.content)).toBeTruthy();
    applyConversationSse(queryClient, 'conversation:updated', { id: pinned.id, block_count: 1 });
    await waitFor(() => expect(attempts).toBe(2));
    expect(screen.getByText(transcriptBlock.content)).toBeTruthy();
    expect(screen.queryByText('source pending')).toBeNull();
    expect(screen.queryByText('No messages yet')).toBeNull();
    expect(await screen.findByText('Message after refresh', {}, { timeout: 3_000 })).toBeTruthy();
  });

  it('discards an active window reply when an edge read has advanced the aggregate source', async () => {
    const pinned = mockConversationDetail(defaultControl, []);
    const staleRefresh = deferred<ConversationPositionWindow>();
    const newSourceEdge = deferred<ConversationPositionWindow>();
    const recent = makeTranscriptBlock({ id: 'recent-v1', position: 1, content: 'Recent source v1' });
    const oldReply = makeTranscriptBlock({ id: 'stale-v1', position: 1, content: 'Stale active reply' });
    const newSourceBlock = makeTranscriptBlock({ id: 'older-v2', position: 0, content: 'Older source v2' });
    let initialReads = 0;
    vi.mocked(api.getConversationWindow).mockImplementation(async (_id, request) => {
      if ('position' in request && request.position === 0) return newSourceEdge.promise;
      if (++initialReads === 1) {
        return { ...positionPayload(pinned, [recent], { revision: 2, hasBefore: true }), source_version_id: 'source-v1' };
      }
      return staleRefresh.promise;
    });

    renderConversationDetail(pinned);
    expect(await screen.findByText('Recent source v1')).toBeTruthy();

    await waitFor(() => expect(api.getConversationWindow).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.getConversationWindow).mock.calls[1]?.[1]).toMatchObject({ position: 0 });
    applyConversationSse(queryClient, 'conversation:updated', { id: pinned.id, block_count: 2 });
    await waitFor(() => expect(initialReads).toBe(2));
    await waitFor(() => expect(api.getConversationWindow).toHaveBeenCalledTimes(3));

    await act(async () => newSourceEdge.resolve({
      ...positionPayload(pinned, [newSourceBlock], { kind: 'block', revision: 2, hasAfter: true }),
      source_version_id: 'source-v2',
    }));
    expect(await screen.findByText('Older source v2')).toBeTruthy();

    await act(async () => staleRefresh.resolve({
      ...positionPayload(pinned, [oldReply], { revision: 2, hasBefore: true }),
      source_version_id: 'source-v1',
    }));
    await waitFor(() => {
      const aggregate = queryClient.getQueryData<ConversationTranscriptData>(conversationKeys.aggregate(pinned.id));
      expect(aggregate?.source_version_id).toBe('source-v2');
      expect(aggregate?.blocks.map((block) => block.id)).toEqual(['older-v2']);
    });
  });

  it('keeps the current window visible while an older edge waits for source indexing', async () => {
    const pinned = mockConversationDetail(defaultControl, []);
    const recent = makeTranscriptBlock({ id: 'recent-edge', position: 1, content: 'Recent visible message' });
    const older = makeTranscriptBlock({ id: 'older-edge', position: 0, content: 'Older recovered message' });
    let edgeAttempts = 0;
    vi.mocked(api.getConversationWindow).mockImplementation(async (_id, request) => {
      if ('position' in request && request.position === 0) {
        if (++edgeAttempts === 1) throw new api.ApiError('source pending', 503, 'freshness_pending');
        return positionPayload(pinned, [older], { kind: 'block', revision: 2, hasAfter: true });
      }
      return positionPayload(pinned, [recent], { revision: 2, hasBefore: true });
    });
    renderConversationDetail(pinned);
    expect(await screen.findByText('Recent visible message')).toBeTruthy();
    await waitFor(() => expect(edgeAttempts).toBe(1));
    expect(screen.getByText('Recent visible message')).toBeTruthy();
    expect(screen.queryByText('No messages yet')).toBeNull();
    expect(screen.queryByText('source pending')).toBeNull();
    expect(await screen.findByText('Older recovered message', {}, { timeout: 3_000 })).toBeTruthy();
  });

  it('keeps a new selection\'s real error when an old Jump request is cancelled late', async () => {
    const first = mockConversationDetail(defaultControl, []);
    const second = { ...first, id: 'selected-after-cancel', title: 'Selected after cancellation' };
    const pendingOldJump = deferred<ConversationPositionWindow>();
    const middle = makeTranscriptBlock({ id: 'old-middle', dag_uuid: 'old-middle', content: 'Old middle', position: 1 });
    vi.mocked(api.getConversationWindow).mockImplementation(async (id, request) => {
      if (id === second.id) throw new Error('Current selection failed to load');
      if ('target' in request && request.target === 'latest') return pendingOldJump.promise;
      return positionPayload(first, [middle], { kind: 'block', hasAfter: true, afterCount: 20, revision: 2 });
    });
    const view = (id: string) => (
      <ConversationsView
        consoleSessions={[]}
        initialConversationId={id}
        initialSessionId={null}
        onSelectSession={() => undefined}
        onNewConversation={() => undefined}
      />
    );
    window.history.replaceState(null, '', `#/console?conversation=${first.id}&block=${middle.id}`);
    const mounted = render(view(first.id));
    expect(await screen.findByText('Old middle')).toBeTruthy();
    applyConversationSse(queryClient, 'conversation:updated', {
      id: first.id,
      block_count: 3,
      append: { from_position: 2, blocks: [makeTranscriptBlock({ id: 'old-tail', dag_uuid: 'old-tail', position: 2 })] },
    });
    fireEvent.click(await screen.findByRole('button', { name: /jump to latest/i }));
    mounted.rerender(view(second.id));
    expect(await screen.findByText('Current selection failed to load')).toBeTruthy();
    await act(async () => pendingOldJump.reject(new CancelledError()));
    expect(screen.getByText('Current selection failed to load')).toBeTruthy();
    expect(screen.queryByText('CancelledError')).toBeNull();
  });

  it('does not let an old A request clear a newer A request after A to B to A', async () => {
    const first = mockConversationDetail(defaultControl, []);
    const second = { ...first, id: 'intermediate-selection', title: 'Intermediate selection' };
    const oldJump = deferred<ConversationPositionWindow>();
    const currentJump = deferred<ConversationPositionWindow>();
    const middle = makeTranscriptBlock({ id: 'middle-a', dag_uuid: 'middle-a', content: 'Middle A', position: 1 });
    let jumpCount = 0;
    vi.mocked(api.getConversationWindow).mockImplementation(async (id, request) => {
      if (id === second.id) return positionPayload(second, [middle], { kind: 'block', hasAfter: true, afterCount: 20, revision: 2 });
      if ('target' in request && request.target === 'latest') return (++jumpCount === 1 ? oldJump : currentJump).promise;
      return positionPayload(first, [middle], { kind: 'block', hasAfter: true, afterCount: 20, revision: 2 });
    });
    const view = (id: string) => (
      <ConversationsView
        consoleSessions={[]}
        initialConversationId={id}
        initialSessionId={null}
        onSelectSession={() => undefined}
        onNewConversation={() => undefined}
      />
    );
    window.history.replaceState(null, '', `#/console?conversation=${first.id}&block=${middle.id}`);
    const mounted = render(view(first.id));
    expect(await screen.findByText('Middle A')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: /jump to latest/i }));
    mounted.rerender(view(second.id));
    mounted.rerender(view(first.id));
    fireEvent.click(await screen.findByRole('button', { name: /jump to latest/i }));
    expect(jumpCount).toBe(2);
    expect(screen.getByRole('button', { name: /jump to latest/i }).getAttribute('aria-busy')).toBe('true');
    await act(async () => oldJump.reject(new CancelledError()));
    expect(screen.getByRole('button', { name: /jump to latest/i }).getAttribute('aria-busy')).toBe('true');
    await act(async () => currentJump.reject(new CancelledError()));
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

    const view = render(
      <ConversationsView
        consoleSessions={[]}
        initialConversationId={conversation.id}
        initialSessionId={null}
        onSelectSession={() => undefined}
        onNewConversation={() => undefined}
      />,
    );

    const shell = view.container.querySelector('.chat-detail-frame--loading');
    expect(shell?.classList.contains('chat-detail-frame--loading')).toBe(true);
    expect(screen.queryByText('No messages yet')).toBeNull();
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
    expect(shell?.querySelector(':scope > .detail-pane-shell__notice')?.textContent ?? '').toBe('');
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
    const shell = document.querySelector('.chat-detail-frame--error');
    const boundary = alert.parentElement;
    const body = shell?.querySelector(':scope > .detail-pane-shell__body');
    const retryButton = screen.getByRole('button', { name: 'Retry' }) as HTMLButtonElement;
    expect(alert.textContent).toContain(sourceUnavailable);
    expect(shell?.classList.contains('chat-detail-frame--error')).toBe(true);
    expect(alert.classList.contains('detail-pane-notice--compact')).toBe(true);
    expect(boundary?.id).toBe('app-operational-notices');
    expect(shell?.querySelector('.detail-pane-notice')).toBeNull();
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
    expect(canonicalHeader?.querySelector('.detail-pane-menu-trigger')).toBeTruthy();
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
    expect(screen.getByText(conversation.session_id!)).toBeTruthy();
    const projectLabel = screen.getByText('Project');
    expect(projectLabel.parentElement?.textContent).toBe('ProjectUnscoped');
    fireEvent.click(screen.getByRole('button', { name: 'Close conversation metadata' }));
    expect(body?.querySelector('.conv-transcript')).toBeTruthy();
    const composer = overlayControl?.querySelector('.conv-compose');
    expect(composer).toBeTruthy();
    expect(overlayControl?.querySelector('.conv-compose__runtime .agent-mark')).toBeNull();
    fireEvent.click(runOptions);
    const runOptionsDialog = screen.getByRole('dialog', { name: 'Run options' });
    const modelSelect = within(runOptionsDialog).getByRole('textbox', { name: 'Model' }) as HTMLInputElement;
    await waitFor(() => expect(modelSelect.value).toBe(conversation.model));
    expect(modelSelect.getAttribute('aria-label')).toBe('Model');
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
        const label = this.querySelector('input, select')?.getAttribute('aria-label');
        return domRect(0, 0, label === 'Model' ? modelWidth : label === 'Permissions' ? modeWidth : 90, 30);
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
    await waitFor(() => expect(inlineRunOptions?.querySelectorAll('input, select')).toHaveLength(3));
    expect(runtime?.classList.contains('conv-compose__runtime--run-options-overflow')).toBe(false);
    expect(inlineRunOptions?.getAttribute('aria-hidden')).toBeNull();
    changeNativeSelect(screen.getByRole('combobox', { name: 'Permissions' }) as HTMLSelectElement, 'read-only');
    await waitFor(() => expect(runtime?.classList.contains('conv-compose__runtime--run-options-overflow')).toBe(false));
    modeWidth = 230;
    act(() => resizeCallbacks.forEach((callback) => callback([], {} as ResizeObserver)));
    await waitFor(() => expect(runtime?.classList.contains('conv-compose__runtime--run-options-overflow'), `widths:${modelWidth}:${modeWidth}:${runtimeWidth}`).toBe(true));
    modeWidth = 70;
    act(() => resizeCallbacks.forEach((callback) => callback([], {} as ResizeObserver)));
    changeNativeSelect(inlineRunOptions?.querySelector('select[aria-label="Permissions"]') as HTMLSelectElement, 'read-only');
    await waitFor(() => expect(runtime?.classList.contains('conv-compose__runtime--run-options-overflow')).toBe(false));
    modelWidth = 220;
    act(() => resizeCallbacks.forEach((callback) => callback([], {} as ResizeObserver)));
    await waitFor(() => expect(runtime?.classList.contains('conv-compose__runtime--run-options-overflow'), `widths:${modelWidth}:${modeWidth}:${runtimeWidth}`).toBe(true));
    expect(inlineRunOptions?.getAttribute('aria-hidden')).toBe('true');
    modelWidth = 100;
    act(() => resizeCallbacks.forEach((callback) => callback([], {} as ResizeObserver)));
    await waitFor(() => expect(runtime?.classList.contains('conv-compose__runtime--run-options-overflow')).toBe(false));
    runtimeWidth = 180;
    act(() => resizeCallbacks.forEach((callback) => callback([], {} as ResizeObserver)));
    await waitFor(() => expect(runtime?.classList.contains('conv-compose__runtime--run-options-overflow'), `widths:${modelWidth}:${modeWidth}:${runtimeWidth}`).toBe(true));
    runtimeWidth = 380;
    act(() => resizeCallbacks.forEach((callback) => callback([], {} as ResizeObserver)));
    await waitFor(() => expect(runtime?.classList.contains('conv-compose__runtime--run-options-overflow')).toBe(false));
    expect(actions?.children[0]).toBe(trigger);
    expect(actions?.children[1]?.classList.contains('context-usage')).toBe(true);
    expect(actions?.children[2]?.classList.contains('conv-compose__send')).toBe(true);
    expect(screen.queryByRole('combobox', { name: 'Permission mode' })).toBeNull();
    fireEvent.input(inlineRunOptions?.querySelector('input[aria-label="Model"]') as HTMLInputElement, { target: { value: 'edited-model' } });
    fireEvent.click(trigger);
    await screen.findByRole('dialog', { name: 'Run options' });
    await waitFor(() => expect(Array.from(
      screen.getByRole('dialog', { name: 'Run options' }).querySelectorAll('input, select'),
      (select) => select.getAttribute('aria-label'),
    )).toEqual(expect.arrayContaining(['Permissions', 'Model', 'Thinking effort'])));
    const popover = screen.getByRole('dialog', { name: 'Run options' });
    expect((within(popover).getByRole('textbox', { name: 'Model' }) as HTMLInputElement).value).toBe('edited-model');
    const permission = popover.querySelector<HTMLSelectElement>('select[aria-label="Permissions"]')!;
    const effort = popover.querySelector<HTMLSelectElement>('select[aria-label="Thinking effort"]')!;

    expect(permission.value).toBe('read-only');
    expect(Array.from((permission as HTMLSelectElement).options, (option) => option.value)).toEqual(['', 'read-only', 'agent', 'agent-full-access']);
    expect(Array.from((effort as HTMLSelectElement).options, (option) => option.value)).toEqual(['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
    const submit = vi.spyOn(api, 'submitConversationControl').mockResolvedValue({
      kind: 'accepted', delivery_id: 'settings-delivery', turn_id: 'settings-turn', snapshot: ownedControl,
    });
    fireEvent.input(screen.getByPlaceholderText('Message...'), { target: { value: 'Use these settings.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith(expect.any(Object), 'Use these settings.', undefined,
      { model: 'edited-model', effort: 'medium', permission_mode: 'read-only' }, expect.any(String), []));
  });

  it('surfaces managed settings failures instead of hiding provider controls', async () => {
    const scopedConversation = mockConversationDetail(defaultControl);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'settings_unavailable', message: 'settings service unavailable' }), { status: 503, headers: { 'content-type': 'application/json' } })));

    renderConversationDetail(scopedConversation);

    const notice = await screen.findByRole('alert');
    expect(notice.textContent).toContain('settings service unavailable');
  });

  it('clamps the Chat header menu and dismisses with Escape, outside click, and focus restoration', async () => {
    vi.stubGlobal('innerWidth', 1024);
    vi.stubGlobal('innerHeight', 768);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function getBounds() {
      if (this.classList.contains('detail-pane-menu-trigger')) return domRect(1004, 730, 24, 24);
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
    expect(alert.parentElement?.id).toBe('app-operational-notices');
    expect(container.querySelector('.stream-renderer__scroll')?.contains(alert)).toBe(false);
    expect(screen.getByText('Provider diagnostics').closest('details')?.open).toBe(false);
    expect((composer as HTMLTextAreaElement).value).toBe('Keep this draft for retry.');

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(api.submitConversationControl).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('keeps the draft and attachment composer after provider startup fails', async () => {
    HTMLElement.prototype.scrollTo = vi.fn();
    const draftStorage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => draftStorage.get(key) ?? null,
      setItem: (key: string, value: string) => { draftStorage.set(key, value); },
    });
    const ownedControl: ConversationControlSnapshot = {
      ...defaultControl,
      ownership: {
        kind: 'mandible', generation: 1, controller_instance_id: 'controller-1', adapter_id: 'codex',
        provider_session_id: conversation.session_id, last_authoritative_signal: 2,
      },
      controller: { kind: 'ready', since: 2 },
      capability: { kind: 'live-send', revision: 1, generation: 1 },
    };
    const failedControl: ConversationControlSnapshot = {
      ...ownedControl,
      revision: 2,
      controller: { kind: 'failed', at: 3, error: {
        kind: 'adapter-failure', adapter_id: 'codex', code: 'startup-failed',
        message: 'The provider process exited before accepting the message.', retryable: true,
      } },
      capability: { kind: 'unavailable', revision: 2, reason: 'controller-transition' },
    };
    const attachment = { kind: 'file' as const, file: {
      id: 'startup-failure-file', name: 'context.txt', media_type: 'text/plain', byte_length: 7, sha256: 'sha256-test',
    } };
    vi.spyOn(api, 'submitConversationControl').mockRejectedValue(Object.assign(new Error('startup failed'), {
      controlError: {
        kind: 'adapter-failure' as const, adapter_id: 'codex', code: 'startup-failed',
        message: 'The provider process exited before accepting the message.', retryable: true,
      },
      snapshot: failedControl,
    }));
    const scopedConversation = mockConversationDetail(ownedControl);
    expect(addDraftAttachments(scopedConversation.id, [attachment]).ok).toBe(true);
    try {
      render(<ConversationDetail
        conversationId={scopedConversation.id}
        initialConversation={scopedConversation}
        anchor={null}
        onNavigate={() => undefined}
        consoleSessions={[]}
        sidebarCollapsed={false}
        chatEntityLinkAction={() => undefined}
      />);
      const composer = await screen.findByPlaceholderText('Message...');
      fireEvent.input(composer, { target: { value: 'Keep this draft.' } });
      expect(screen.getByText('context.txt')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));

      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain('The provider could not complete this action.');
      expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
      expect(document.querySelector('.conv-compose__status')).toBeNull();
      expect((screen.getByPlaceholderText('Message...') as HTMLTextAreaElement).value).toBe('Keep this draft.');
      expect((screen.getByPlaceholderText('Message...') as HTMLTextAreaElement).disabled).toBe(false);
      expect(screen.getByText('context.txt')).toBeTruthy();
      expect((screen.getByRole('button', { name: 'Add attachments' }) as HTMLButtonElement).disabled).toBe(false);
      expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
    } finally {
      clearAcceptedDraft(scopedConversation.id, { text: 'Keep this draft.', attachments: [attachment] });
      delete (HTMLElement.prototype as Partial<HTMLElement>).scrollTo;
    }
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
      hasComposer: true,
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
      expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
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
