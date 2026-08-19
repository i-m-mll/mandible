import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as api from '../ui/src/api.js';
import type { Conversation, ConversationBlock, ConversationAttachState, ConversationPositionWindow } from '../ui/src/api.js';
import { DetailPaneShell } from '../ui/src/components/shared/DetailPaneShell.js';
import {
  ConversationsView,
  conversationAnchorFromHash,
  conversationAnchorHref,
  getConversationHeaderProviderLabel,
} from '../ui/src/views/conversations.js';


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
  vi.spyOn(api, 'listCanonicalProjects').mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
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
  attach_state: {
    kind: 'resumable',
    reason: 'provider-resumable',
    resumable: true,
    can_fork: false,
    provider_session_id: null,
    checked_at: 1,
  },
};

const transcriptBlock: ConversationBlock = {
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
};

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
  attachState: ConversationAttachState,
  blocks: ConversationBlock[] = [transcriptBlock],
): Conversation {
  const scopedConversation = { ...conversation, attach_state: attachState, block_count: blocks.length };
  vi.spyOn(api, 'getConversations').mockResolvedValue({ conversations: [scopedConversation], total: 1 });
  vi.spyOn(api, 'getConversationWindow').mockResolvedValue({
    conversation: scopedConversation,
    body_source: 'legacy',
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
  vi.spyOn(api, 'getSessionPresets').mockResolvedValue([]);
  return scopedConversation;
}

function renderConversationDetail(scopedConversation: Conversation): void {
  render(
    <ConversationsView
      conversations={[scopedConversation]}
      consoleSessions={[]}
      initialConversationId={scopedConversation.id}
      initialSessionId={null}
      onSelectSession={() => undefined}
      onNewSession={() => undefined}
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

describe('compact detail pane shell', () => {
  it('parses exact block and turn anchors from shareable Chat URLs', () => {
    expect(conversationAnchorFromHash('#/console?conversation=conv&block=block-42')).toEqual({ block: 'block-42' });
    expect(conversationAnchorFromHash('#/console?conversation=conv&turn=turn-9')).toEqual({ turn: 'turn-9' });
    expect(conversationAnchorFromHash('#/console?conversation=conv')).toBeNull();
    expect(conversationAnchorHref('conv 1', { block: 'block/42' })).toBe('#/console?conversation=conv+1&block=block%2F42');
  });

  it('uses the compact-header provider presentation contract', () => {
    expect(getConversationHeaderProviderLabel('claude_code')).toBe('Claude');
    expect(getConversationHeaderProviderLabel('codex')).toBe('Codex');
    expect(getConversationHeaderProviderLabel('gemini')).toBe('agy');
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

    expect(css).toMatch(/\.detail-pane-shell--compact \.detail-pane-shell__title\s*\{[^}]*color:\s*var\(--text-muted\);[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s);
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
    const scopedConversation = mockConversationDetail(conversation.attach_state);
    vi.mocked(api.getConversationWindow)
      .mockRejectedValueOnce(new Error(sourceUnavailable))
      .mockImplementationOnce(() => retry.promise);

    renderConversationDetail(scopedConversation);

    const alert = await screen.findByRole('alert');
    const shell = alert.closest('.detail-pane-shell');
    const boundary = alert.closest('.detail-pane-shell__notice');
    const body = shell?.querySelector(':scope > .detail-pane-shell__body');
    const retryButton = screen.getByRole('button', { name: 'Retry' }) as HTMLButtonElement;
    expect(alert.textContent).toContain(sourceUnavailable);
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

  it('composes Chat detail through the compact shell with stable header actions and footer', async () => {
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
    const scopedConversation = mockConversationDetail(conversation.attach_state);
    renderConversationDetail(scopedConversation);

    await screen.findByRole('heading', { name: conversation.title! });
    const shell = document.querySelector('.conv-detail.detail-pane-shell--compact');
    const header = shell?.querySelector(':scope > .detail-pane-shell__header');
    const body = shell?.querySelector(':scope > .detail-pane-shell__body.conv-detail__body');
    const footer = shell?.querySelector(':scope > .detail-pane-shell__footer.conv-detail__footer');
    const canonicalHeader = header?.querySelector('.detail-pane-header--compact');
    expect(canonicalHeader?.getAttribute('data-detail-pane-header-variant')).toBe('compact');
    expect(canonicalHeader?.textContent).not.toContain('Conversation');
    expect(canonicalHeader?.textContent).not.toContain('01a01639');
    expect(canonicalHeader?.textContent).not.toContain(conversation.id);
    expect(canonicalHeader?.querySelector('.detail-pane-header__identity')).toBeNull();
    expect(canonicalHeader?.querySelector('.ledger-copy-ref-button')).toBeNull();
    const status = canonicalHeader?.querySelector('.conv-detail__status');
    expect(status?.querySelector('.conv-detail__provider')?.textContent).toBe('Codex');
    expect(status?.textContent).toContain('Resumable');
    const titleRow = canonicalHeader?.querySelector('.detail-pane-header__title-row');
    const compactMenu = canonicalHeader?.querySelector('.detail-pane-header__menu');
    const metadata = canonicalHeader?.querySelector('.detail-pane-header__compact-metadata');
    const main = canonicalHeader?.querySelector(':scope > .detail-pane-header__main');
    expect(titleRow?.querySelector('.detail-pane-header__title')?.nextElementSibling).toBe(compactMenu);
    expect(titleRow?.nextElementSibling).toBe(metadata);
    expect(metadata?.contains(status ?? null)).toBe(true);
    expect(getComputedStyle(canonicalHeader!).height).toBe('48px');
    expect(getComputedStyle(main!).height).toBe('100%');
    expect(getComputedStyle(main!).flexDirection).toBe('row');
    expect(getComputedStyle(main!).alignItems).toBe('center');
    expect(getComputedStyle(metadata!).marginLeft).toBe('auto');
    expect(canonicalHeader?.querySelector('.detail-pane-header__title')?.getAttribute('title')).toBe(conversation.title);
    expect(compactMenu?.getAttribute('aria-label')).toBe('Conversation detail actions');
    expect(canonicalHeader?.querySelector('.conv-actions__trigger')).toBeTruthy();
    expect(canonicalHeader?.querySelector('.conv-info-button')).toBeNull();
    expect(body?.querySelector('.context-ring')).toBeNull();
    expect(shell?.querySelectorAll('.context-ring')).toHaveLength(1);
    const runtime = footer?.querySelector('.conv-compose__runtime');
    expect(runtime?.firstElementChild).toBe(screen.getByRole('combobox', { name: 'Model' }));
    expect(runtime?.lastElementChild?.classList.contains('conv-compose__runtime-actions')).toBe(true);
    expect(runtime?.lastElementChild?.lastElementChild?.classList.contains('context-ring')).toBe(true);
    expect(footer?.querySelector('.conv-compose__hint')).toBeNull();
    expect(screen.getByPlaceholderText('Message...')).toBeTruthy();
    expect(footer?.textContent).not.toContain('Sending will resume this session.');

    fireEvent.click(screen.getByRole('button', { name: 'Conversation actions' }));
    const menu = screen.getByRole('menu');
    expect(menu.querySelectorAll('[role="menuitem"]')).toHaveLength(7);
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
    expect(footer?.querySelector('.conv-compose')).toBeTruthy();
    expect(footer?.querySelector('.conv-compose__runtime .agent-mark')).toBeNull();
    const modelSelect = screen.getByRole('combobox', { name: 'Model' }) as HTMLSelectElement;
    await waitFor(() => expect(modelSelect.value).toBe(conversation.model));
    expect(modelSelect.title).toBe('Model');
    fireEvent.click(screen.getByRole('button', { name: 'Conversation actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy markdown' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining('## User')));
    fireEvent.click(screen.getByRole('button', { name: 'Conversation actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open markdown' }));
    expect(open).toHaveBeenCalledWith('blob:conversation-markdown', '_blank', 'noopener,noreferrer');
    fireEvent.click(screen.getByRole('button', { name: 'Conversation actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Message filters' }));
    expect(body?.querySelector('.conv-filter-bar')).toBeTruthy();
    await waitFor(() => expect(shell?.getAttribute('aria-busy')).toBe('false'));
  });

  it('clamps the Chat header menu and dismisses with Escape, outside click, and focus restoration', async () => {
    vi.stubGlobal('innerWidth', 1024);
    vi.stubGlobal('innerHeight', 768);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function getBounds() {
      if (this.classList.contains('conv-actions__trigger')) return domRect(1004, 730, 20, 22);
      if (this.classList.contains('conv-actions__menu')) return domRect(0, 0, 240, 280);
      return domRect(0, 0, 0, 0);
    });
    const scopedConversation = mockConversationDetail(conversation.attach_state);
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

    const model = screen.getByRole('combobox', { name: 'Model' });
    model.focus();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    expect(await screen.findByRole('menu')).toBeTruthy();
    model.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it.each([
    {
      label: 'live',
      attachState: {
        kind: 'live-owned',
        reason: 'owned',
        console_session_id: 'console-live',
        resumable: true,
        can_fork: false,
        checked_at: 2,
      } satisfies ConversationAttachState,
      badge: 'Live',
      hasComposer: true,
    },
    {
      label: 'external live',
      attachState: {
        kind: 'live-external',
        reason: 'transcript-recent',
        external_session_id: 'external-live',
        resumable: false,
        can_fork: true,
        checked_at: 2,
      } satisfies ConversationAttachState,
      badge: 'External',
      hasComposer: true,
    },
    {
      label: 'resumable',
      attachState: conversation.attach_state,
      badge: 'Resumable',
      hasComposer: true,
    },
    {
      label: 'historical',
      attachState: {
        kind: 'historical',
        reason: 'complete',
        resumable: false,
        can_fork: false,
        checked_at: 3,
      } satisfies ConversationAttachState,
      badge: 'History',
      hasComposer: false,
    },
  ])('keeps the simplified header and footer contract in $label state', async ({ attachState, badge, hasComposer }) => {
    const scopedConversation = mockConversationDetail(attachState);
    renderConversationDetail(scopedConversation);

    await screen.findByRole('heading', { name: conversation.title! });
    const header = document.querySelector('.detail-pane-header--compact') as HTMLElement;
    const status = header.querySelector('.conv-detail__status');
    expect(status?.textContent).toContain(badge);
    expect(status?.parentElement?.classList.contains('detail-pane-header__compact-metadata')).toBe(true);
    expect(header.querySelector('.detail-pane-header__title')?.nextElementSibling?.classList.contains('detail-pane-header__menu')).toBe(true);
    expect(header.querySelector('.detail-pane-header__topline')).toBeNull();
    expect(header.querySelector('.detail-pane-header__identity')).toBeNull();
    expect(header.querySelector('.conv-info-button')).toBeNull();
    expect(Boolean(document.querySelector('.conv-compose'))).toBe(hasComposer);
    if (attachState.kind === 'live-external') {
      expect(document.querySelectorAll('.conv-compose__hint')).toHaveLength(0);
      expect((screen.getByPlaceholderText('Message...') as HTMLTextAreaElement).disabled).toBe(true);
      expect(document.querySelector('.conv-compose')?.textContent?.match(/Live in your terminal\./g)).toHaveLength(1);
    }
    fireEvent.click(screen.getByRole('button', { name: 'Conversation actions' }));
    expect(screen.getByRole('menuitem', { name: 'View metadata' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Copy markdown' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Open markdown' })).toBeTruthy();
  });

  it('keeps exact-anchor loading last-request-wins', async () => {
    const scopedConversation = mockConversationDetail(conversation.attach_state, []);
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
      onNewSession: () => undefined,
    };
    const view = render(<ConversationsView {...props} />);
    await waitFor(() => expect(api.getConversationWindow).toHaveBeenCalledTimes(1));

    window.history.replaceState(null, '', `#/console?conversation=${conversation.id}&block=exact-block`);
    view.rerender(<ConversationsView {...props} />);
    await waitFor(() => expect(api.getConversationWindow).toHaveBeenCalledTimes(2));

    const exactBlock = { ...transcriptBlock, id: 'exact-block', content: 'Exact anchor wins', position: 50 };
    exact.resolve(positionPayload(scopedConversation, [exactBlock], { kind: 'block', hasAfter: true, revision: 100 }));
    expect(await screen.findByText('Exact anchor wins')).toBeTruthy();

    initial.resolve(positionPayload(scopedConversation, [{ ...transcriptBlock, content: 'Late initial loses' }], { revision: 100 }));
    await Promise.resolve();
    expect(screen.queryByText('Late initial loses')).toBeNull();
    expect(screen.getByText('Exact anchor wins')).toBeTruthy();
  });

  it('re-resolves the true end when an append arrives during Jump to latest', async () => {
    const scopedConversation = mockConversationDetail(conversation.attach_state, []);
    const firstLatest = deferred<ConversationPositionWindow>();
    const trueLatest = deferred<ConversationPositionWindow>();
    let latestCalls = 0;
    const middleBlock = { ...transcriptBlock, id: 'middle', content: 'Middle window', position: 1 };
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

    window.dispatchEvent(new CustomEvent('conversation:sse', {
      detail: {
        type: 'conversation:updated',
        data: {
          id: conversation.id,
          block_count: 12,
          append: {
            from_position: 2,
            blocks: Array.from({ length: 10 }, (_, index) => ({
              ...transcriptBlock,
              id: `append-${index + 2}`,
              position: index + 2,
              content: `append ${index + 2}`,
            })),
          },
        },
      },
    }));

    fireEvent.click(await screen.findByRole('button', { name: /jump to latest/i }));
    await waitFor(() => expect(latestCalls).toBe(1));
    window.dispatchEvent(new CustomEvent('conversation:sse', {
      detail: {
        type: 'conversation:updated',
        data: {
          id: conversation.id,
          block_count: 13,
          append: { from_position: 12, blocks: [{ ...transcriptBlock, id: 'append-12', position: 12, content: 'append 12' }] },
        },
      },
    }));
    firstLatest.resolve(positionPayload(scopedConversation, [{ ...transcriptBlock, id: 'old-tail', position: 11, content: 'Old tail' }], { kind: 'latest', revision: 12 }));
    await waitFor(() => expect(latestCalls).toBe(2));
    trueLatest.resolve(positionPayload(scopedConversation, [{ ...transcriptBlock, id: 'true-tail', position: 12, content: 'Newest true tail' }], { kind: 'latest', revision: 13 }));
    expect(await screen.findByText('Newest true tail')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /jump to latest/i })).toBeNull();
    expect(window.location.hash).toBe(`#/console?conversation=${conversation.id}`);
  });
});
