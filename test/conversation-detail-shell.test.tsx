// @vitest-environment jsdom
import { mockConversationStructureFromWindow, mockManagedSettings } from './helpers/conversation-ui-transport';
import { establishTestClientAccess } from './helpers/local-client-access';
import { act, cleanup, fireEvent, screen, waitFor } from './helpers/dom.js';
import { render } from './helpers/notice-test-render';
import { CancelledError } from '@tanstack/preact-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as api from '../ui/src/api.js';
import { AppShellProvider } from '../ui/src/app-shell.js';
import { CHAT_VIEW_STATE_KEY } from '../ui/src/views/conversation-view-state.js';
import type { Conversation, ConversationBlock, ConversationControlSnapshot, ConversationPositionWindow } from '../ui/src/api.js';
import { __resetSharedSseForTests } from '../ui/src/sse-shared.js';
import type { ConsoleSession } from '../ui/src/state.js';
import { ConversationDetail, ConversationsView, conversationLoadFailure, scopeConversationRightSidebar } from '../ui/src/views/conversations.js';
import { chatItemIdentityKey } from '../src/conversation-control/provider-live.js';
import type { ChatItem } from '../src/parsers/types.js';
import { queryClient } from '../ui/src/query/client.js';
import { conversationKeys } from '../ui/src/query/conversationKeys.js';
import type { ConversationTranscriptData } from '../ui/src/query/conversationData.js';
import { applyConversationSse } from '../ui/src/query/conversationSse.js';
import { addDraftAttachments, clearAcceptedDraft } from '../ui/src/chat/attachmentDrafts.js';

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
  vi.spyOn(api, 'resolveChatRouteTarget').mockImplementation(async (target) => ({ status: 'resolved', selection: target }));
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

function mockConversationDetail(
  control: ConversationControlSnapshot,
  blocks: ConversationBlock[] = [transcriptBlock],
  overrides: Partial<Conversation> = {},
): Conversation {
  const scopedConversation = { ...conversation, ...overrides, block_count: blocks.length };
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

describe('compact detail pane shell', () => {

  it('keeps the selected transcript and reading cache while archiving and restoring', async () => {
    const selected = mockConversationDetail(defaultControl, [transcriptBlock]);
    const archive = vi.spyOn(api, 'updateConversationArchive').mockImplementation(async (id, archived) => ({
      id, archived_at: archived ? 42 : null,
      retention_native_status: archived ? 'deferred' as const : null,
      retention_native_reason: archived ? 'desktop_writer_owned' : null,
    }));
    renderConversationDetail(selected);
    await screen.findByText(transcriptBlock.content);
    const aggregate = queryClient.getQueryData<ConversationTranscriptData>(conversationKeys.aggregate(selected.id))!;
    fireEvent.click(screen.getByRole('button', { name: 'Conversation actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Archive' }));
    await screen.findByRole('button', { name: 'Restore' });
    expect(screen.getByText(transcriptBlock.content)).toBeTruthy();
    expect(queryClient.getQueryData<ConversationTranscriptData>(conversationKeys.aggregate(selected.id))?.blocks).toBe(aggregate.blocks);
    act(() => applyConversationSse(queryClient, 'conversation:updated', {
      id: selected.id, retention_native_status: 'failed', retention_native_reason: 'native archive unavailable',
    }));
    expect(queryClient.getQueryData<ConversationTranscriptData>(conversationKeys.aggregate(selected.id))?.conversation.archived_at).toBe(42);
    expect(queryClient.getQueryData<ConversationTranscriptData>(conversationKeys.aggregate(selected.id))?.conversation.retention_native_status).toBe('failed');
    act(() => applyConversationSse(queryClient, 'conversation:updated', {
      id: selected.id, retention_native_status: 'archived', retention_native_reason: null,
    }));
    await waitFor(() => expect(queryClient.getQueryData<ConversationTranscriptData>(conversationKeys.aggregate(selected.id))?.conversation.retention_native_status).toBe('archived'));
    const restore = screen.getByRole('button', { name: 'Restore' });
    await waitFor(() => expect((restore as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(restore);
    await waitFor(() => expect(archive).toHaveBeenLastCalledWith(selected.id, false));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Restore' })).toBeNull());
    expect(screen.getByText(transcriptBlock.content)).toBeTruthy();
  });

  it('does not turn an obsolete transcript request into a visible Chat error', () => {
    expect(conversationLoadFailure(new CancelledError(), true, 'edge-older')).toBeNull();
    expect(conversationLoadFailure(new DOMException('aborted', 'AbortError'), true, 'refresh')).toBeNull();
    expect(conversationLoadFailure(new Error('read failed'), true, 'refresh')).toMatchObject({
      message: 'read failed',
      operation: 'refresh',
    });
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
    mounted.rerender(view(second.id));
    expect(await screen.findByText('Second chat opened')).toBeTruthy();
    mounted.rerender(view(first.id));
    expect(await screen.findByText('First chat returned')).toBeTruthy();
    expect(firstAttempts).toBeGreaterThanOrEqual(2);
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

      await screen.findByRole('alert');
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

  it('renders no composer for a read-only child transcript', async () => {
    const child = mockConversationDetail({
      ...defaultControl,
      capability: { kind: 'unavailable', revision: 0, reason: 'subagent' },
    }, [transcriptBlock], { is_sidechain: true });
    renderConversationDetail(child);

    await screen.findByRole('heading', { name: conversation.title! });
    expect(screen.queryByPlaceholderText('Message...')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
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

describe('Chat route intent', () => {
  function setupRouteHistory() {
    mockConversationDetail(defaultControl);
    vi.mocked(api.getConversationWindow).mockImplementation(async (id) => positionPayload(
      { ...conversation, id, title: `Chat ${id}` },
      [makeTranscriptBlock({ id: `${id}-block`, conversation_id: id, content: `Transcript ${id}` })],
    ));
    const view = (conversationRef: string | null, sessionRef: string | null = null, routeParams?: Record<string, string>) => (
      <ConversationsView consoleSessions={[]} initialConversationId={conversationRef} initialSessionId={sessionRef} routeParams={routeParams}
        onSelectSession={() => undefined} onNewConversation={async () => { throw new Error('unused'); }} />
    );
    return view;
  }

  it.each((['session', 'conversation'] as const).flatMap((type) => (
    [{ block: 'B-block' }, { turn: 'B-block' }, { position: 0 }].map((anchor) => ({ type, anchor }))
  )))('replaces saved A synchronously with pending B absent from the console list and retains %j', async ({ type, anchor }) => {
    const view = setupRouteHistory();
    const pending = deferred<api.ChatRouteResolution>();
    const mounted = render(view('A'));
    await screen.findByText('Transcript A');
    vi.mocked(api.resolveChatRouteTarget).mockReturnValue(pending.promise);
    window.history.replaceState(null, '', `#/console?${type}=B-ref&${new URLSearchParams(Object.fromEntries(Object.entries(anchor).map(([key, value]) => [key, String(value)])))}&sidebar=hidden&context=keep`);
    mounted.rerender(type === 'session' ? view(null, 'B-ref') : view('B-ref'));
    expect(screen.queryByText('Transcript A')).toBeNull();
    expect(api.getConversationWindow).not.toHaveBeenCalledWith('B-ref', expect.anything());
    await act(async () => { pending.resolve({ status: 'resolved', selection: { type: 'conversation', id: 'B' } }); });
    await screen.findByText('Transcript B');
    expect(api.getConversationWindow).toHaveBeenCalledWith('B', expect.objectContaining(anchor));
    expect(api.getConversationControl).toHaveBeenCalledWith('B');
    expect(queryClient.getQueryData(conversationKeys.aggregate('B'))).toBeTruthy();
    expect(queryClient.getQueryData(conversationKeys.aggregate('B-ref'))).toBeUndefined();
    expect(window.location.hash).toContain(`${type}=B-ref`);
    expect(window.location.hash).toContain('context=keep');
  });

  it.each(['not_found', 'ambiguous', 'error'] as const)('keeps unrelated saved content hidden on %s', async (status) => {
    const view = setupRouteHistory();
    const resolution = deferred<api.ChatRouteResolution>();
    const mounted = render(view('A'));
    await screen.findByText('Transcript A');
    vi.mocked(api.resolveChatRouteTarget).mockReturnValue(resolution.promise);
    mounted.rerender(view(null, 'unavailable-target'));
    expect(screen.queryByText('Transcript A')).toBeNull();
    await act(async () => {
      if (status === 'error') resolution.reject(new Error('offline'));
      else resolution.resolve({ status });
    });
    expect(screen.queryByText('Transcript A')).toBeNull();
  });

  it('rejects B after a newer C intent and keeps C during same-target refetch and query-context changes', async () => {
    const view = setupRouteHistory();
    const b = deferred<api.ChatRouteResolution>();
    const refresh = deferred<api.ChatRouteResolution>();
    vi.mocked(api.resolveChatRouteTarget).mockImplementation(async (target) => target.id === 'B' ? b.promise
      : { status: 'resolved', selection: { type: 'conversation', id: 'C' } });
    const mounted = render(view(null, 'B'));
    mounted.rerender(view(null, 'C'));
    await screen.findByText('Transcript C');
    await act(async () => { b.resolve({ status: 'resolved', selection: { type: 'conversation', id: 'B' } }); });
    expect(screen.queryByText('Transcript B')).toBeNull();
    vi.mocked(api.resolveChatRouteTarget).mockReturnValue(refresh.promise);
    await act(async () => { void queryClient.invalidateQueries({ queryKey: conversationKeys.routeTarget({ type: 'session', id: 'C' }) }); });
    window.history.replaceState(null, '', '#/console?context=changed&session=C&sidebar=hidden');
    mounted.rerender(view(null, 'C'));
    expect(screen.getByText('Transcript C')).toBeTruthy();
    await act(async () => { refresh.resolve({ status: 'resolved', selection: { type: 'conversation', id: 'C' } }); });
    expect(screen.getByText('Transcript C')).toBeTruthy();
  });

  it.each(['row', 'filter'])('cancels pending session resolution on a deliberate %s choice and retains query context', async (action) => {
    const view = setupRouteHistory();
    const pending = deferred<api.ChatRouteResolution>();
    vi.mocked(api.resolveChatRouteTarget).mockReturnValue(pending.promise);
    vi.mocked(api.getConversationSidebar).mockResolvedValue({ limit: 50, groups: [{
      key: 'chats', kind: 'chats', label: 'Chats', total: 1, next_cursor: null,
      conversations: [{ ...conversation, id: 'A', title: 'Chat A', block_count: 1, canonical_project_id: null, canonical_project_key: null }],
    }] });
    window.history.replaceState(null, '', '#/console?session=B&turn=old&agent_session=agent&sidebar=hidden&context=keep');
    let mounted = render(view(null, 'B'));
    const row = await screen.findByRole('button', { name: 'Open conversation Chat A' });
    if (action === 'row') fireEvent.click(row);
    else fireEvent.input(screen.getByRole('textbox', { name: 'Search chats' }), { target: { value: 'Chat A' } });
    await screen.findByText('Transcript A');
    await act(async () => { pending.resolve({ status: 'resolved', selection: { type: 'conversation', id: 'B' } }); });
    expect(screen.queryByText('Transcript B')).toBeNull();
    const params = new URLSearchParams(window.location.hash.split('?')[1]);
    if (action === 'row') {
      expect(Object.fromEntries(params)).toEqual({ conversation: 'A', agent_session: 'agent', sidebar: 'hidden', context: 'keep' });
    } else {
      expect(Object.fromEntries(params)).toEqual({ agent_session: 'agent', sidebar: 'hidden', context: 'keep' });
      await waitFor(() => expect(JSON.parse(window.localStorage.getItem(CHAT_VIEW_STATE_KEY) ?? '{}').lastSelection)
        .toEqual({ type: 'conversation', id: 'A' }));
      const lookupsBeforeRefresh = vi.mocked(api.resolveChatRouteTarget).mock.calls.length;
      mounted.unmount();
      queryClient.clear();
      mounted = render(view(params.get('conversation'), params.get('session')));
      await screen.findByText('Transcript A');
      expect(api.resolveChatRouteTarget).toHaveBeenCalledTimes(lookupsBeforeRefresh);
    }
    vi.mocked(api.resolveChatRouteTarget).mockImplementation(async (target) => ({ status: 'resolved', selection: { type: 'conversation', id: target.id } }));
    window.history.replaceState(null, '', '#/console?session=C');
    mounted.rerender(view(null, 'C'));
    await screen.findByText('Transcript C');
    window.history.replaceState(null, '', '#/console?session=B&turn=old');
    mounted.rerender(view(null, 'B'));
    await screen.findByText('Transcript B');
  });

  it.each(['pending', 'cancelled'] as const)('ignores other tabs while Chat intent is %s', async (state) => {
    const view = setupRouteHistory();
    const pending = deferred<api.ChatRouteResolution>();
    vi.mocked(api.resolveChatRouteTarget).mockReturnValue(pending.promise);
    vi.mocked(api.getConversationSidebar).mockResolvedValue({ limit: 50, groups: [{
      key: 'chats', kind: 'chats', label: 'Chats', total: 1, next_cursor: null,
      conversations: [{ ...conversation, id: 'A', title: 'Chat A', block_count: 1, canonical_project_id: null, canonical_project_key: null }],
    }] });
    const routeParams = { session: 'B', turn: 'B-block', sidebar: 'hidden', context: 'chat-context' };
    const scoped = (active: boolean) => <AppShellProvider value={{ active,
      rightSidebar: null, registerRightSidebar: () => () => undefined, updateRightSidebar: () => undefined,
      registerInitialRouteLoad: () => undefined, setViewSidebarWidth: () => undefined,
    }}>{view(null, 'B', routeParams)}</AppShellProvider>;
    window.history.replaceState(null, '', '#/console?session=B&turn=B-block&sidebar=hidden&context=chat-context');
    const mounted = render(scoped(true));
    if (state === 'cancelled') {
      fireEvent.click(await screen.findByRole('button', { name: 'Open conversation Chat A' }));
      await screen.findByText('Transcript A');
    }
    window.history.replaceState(null, '', '#/issues?issue=another&block=foreign-block&context=issues-context');
    mounted.rerender(scoped(false));
    await act(async () => { pending.resolve({ status: 'resolved', selection: { type: 'conversation', id: 'B' } }); });
    if (state === 'cancelled') {
      expect(screen.getByText('Transcript A')).toBeTruthy();
      expect(screen.queryByText('Transcript B')).toBeNull();
    }
    expect(api.getConversationWindow).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ block: 'foreign-block' }));
    expect(window.location.hash).toBe('#/issues?issue=another&block=foreign-block&context=issues-context');
    if (state === 'pending') {
      expect(api.getConversationWindow).not.toHaveBeenCalledWith('B', expect.anything());
      window.history.replaceState(null, '', '#/console?session=B&turn=B-block&sidebar=hidden&context=chat-context');
      mounted.rerender(scoped(true));
      await screen.findByText('Transcript B');
      expect(api.getConversationWindow).toHaveBeenCalledWith('B', expect.objectContaining({ turn: 'B-block' }));
    }
  });

});

describe('open transcript liveness follows the active view', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('fetches nothing while hidden and refetches once on activation, keeping scroll and rows', async () => {
    const blocks = [
      makeTranscriptBlock({ id: 'live-0', position: 0, content: 'Earlier turn' }),
      makeTranscriptBlock({ id: 'live-1', position: 1, content: 'Latest turn' }),
    ];
    const live = mockConversationDetail(defaultControl, blocks);
    vi.useFakeTimers();
    const view = (active: boolean) => (
      <AppShellProvider value={{
        rightSidebar: null,
        registerRightSidebar: () => () => undefined,
        updateRightSidebar: () => undefined,
        registerInitialRouteLoad: () => undefined,
        setViewSidebarWidth: () => undefined,
        active,
      }}>
        <ConversationsView
          conversations={[live]}
          consoleSessions={[]}
          initialConversationId={live.id}
          initialSessionId={null}
          onSelectSession={() => undefined}
          onNewConversation={() => undefined}
        />
      </AppShellProvider>
    );
    const mounted = render(view(true));
    for (let step = 0; step < 10; step += 1) await act(() => vi.advanceTimersByTimeAsync(100));
    const row = screen.getByText(/Earlier turn/);
    const scroll = mounted.container.querySelector('.stream-renderer__scroll') as HTMLElement;
    scroll.scrollTop = 700;
    fireEvent.scroll(scroll);
    const windowReads = () => vi.mocked(api.getConversationWindow).mock.calls.length;
    const before = windowReads();

    const grown = [
      ...blocks,
      makeTranscriptBlock({ id: 'live-2', position: 2, content: 'Hidden reply' }),
      makeTranscriptBlock({ id: 'live-3', position: 3, content: 'Hidden follow-up' }),
    ];
    vi.mocked(api.getConversationWindow).mockResolvedValue(positionPayload({ ...live, block_count: 4 }, grown));

    mounted.rerender(view(false));
    for (let second = 0; second < 600; second += 1) {
      applyConversationSse(queryClient, 'conversation:updated', second % 2 === 0
        ? { id: live.id, block_count: 4 }
        : { id: live.id, block_count: 4, append: { from_position: 3, blocks: [grown[3]] } });
      await act(() => vi.advanceTimersByTimeAsync(1_000));
    }
    expect(windowReads()).toBe(before);

    mounted.rerender(view(true));
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(windowReads()).toBe(before + 1);
    expect(screen.getByText(/Earlier turn/)).toBe(row);
    expect(scroll.scrollTop).toBe(700);
    expect(screen.getByText(/Hidden follow-up/)).toBeTruthy();
  });
});
