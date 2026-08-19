import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as api from '../ui/src/api.js';
import type { Conversation } from '../ui/src/api.js';
import { DetailPaneShell } from '../ui/src/components/shared/DetailPaneShell.js';
import {
  ConversationsView,
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

describe('compact detail pane shell', () => {
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
        footer={<button type="button">Submit</button>}
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

  it('composes Chat detail through the compact shell with stable header actions and footer', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn(() => false),
    });
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

    render(
      <ConversationsView
        conversations={[conversation]}
        consoleSessions={[]}
        initialConversationId={conversation.id}
        initialSessionId={null}
        onSelectSession={() => undefined}
        onNewSession={() => undefined}
      />,
    );

    await screen.findByRole('heading', { name: conversation.title! });
    const shell = document.querySelector('.conv-detail.detail-pane-shell--compact');
    const header = shell?.querySelector(':scope > .detail-pane-shell__header');
    const body = shell?.querySelector(':scope > .detail-pane-shell__body.conv-detail__body');
    const footer = shell?.querySelector(':scope > .detail-pane-shell__footer.conv-detail__footer');
    const canonicalHeader = header?.querySelector('.detail-pane-header--compact');
    expect(canonicalHeader?.getAttribute('data-detail-pane-header-variant')).toBe('compact');
    expect(canonicalHeader?.textContent).toContain('01a01639');
    expect(canonicalHeader?.textContent).not.toContain(conversation.id);
    const status = canonicalHeader?.querySelector('.detail-pane-header__status');
    expect(status?.querySelector('.conv-detail__provider')?.textContent).toBe('Codex');
    expect(status?.textContent).toContain('Resumable');
    expect(canonicalHeader?.querySelector('.detail-pane-header__title')?.getAttribute('title')).toBe(conversation.title);
    expect(canonicalHeader?.querySelector('.detail-pane-header__actions')?.getAttribute('aria-label')).toBe('Conversation detail actions');
    expect(canonicalHeader?.querySelector('.conv-actions__trigger')).toBeTruthy();
    expect(canonicalHeader?.querySelector('.conv-info-button')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Conversation info' }));
    const projectLabel = screen.getByText('Project');
    expect(projectLabel.parentElement?.textContent).toBe('ProjectUnscoped');
    fireEvent.click(screen.getByRole('button', { name: 'Close info' }));
    expect(body?.querySelector('.conv-transcript')).toBeTruthy();
    expect(footer?.querySelector('.conv-compose')).toBeTruthy();
    expect(footer?.querySelector('.conv-compose__runtime .agent-mark')).toBeNull();
    const modelSelect = screen.getByRole('combobox', { name: 'Model' }) as HTMLSelectElement;
    await waitFor(() => expect(modelSelect.value).toBe(conversation.model));
    expect(modelSelect.title).toBe('Model');
    fireEvent.click(screen.getByRole('button', { name: 'Copy full conversation ID' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(conversation.id));
    fireEvent.click(screen.getByRole('button', { name: 'Conversation actions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Message filters' }));
    expect(body?.querySelector('.conv-filter-bar')).toBeTruthy();
    await waitFor(() => expect(shell?.getAttribute('aria-busy')).toBe('false'));
  });
});
