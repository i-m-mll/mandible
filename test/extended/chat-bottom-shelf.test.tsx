import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { useState } from 'preact/hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_CHAT_BOTTOM_SHELF_PREFERENCE,
  parseChatBottomShelfPreference,
  type ChatBottomShelfPreference,
} from '../../src/contracts';
import { normalizeUserSettingValue } from '../../src/user-settings';
import * as api from '../../ui/src/api';
import { ChatBottomShelf } from '../../ui/src/chat/ChatBottomShelf';
import {
  chatEntityLinkAction,
  ChatEntityLinkBoundary,
  type ChatPreviewTarget,
} from '../../ui/src/chat/ChatEntityLinkBoundary';
import {
  linkifyResourceRefs,
  previewableResourceFromAnchor,
} from '../../ui/src/resource-refs';
import { useChatBottomShelfPreference } from '../../ui/src/chat/useChatBottomShelfPreference';

function domRect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left, y: top, left, top, right: left + width, bottom: top + height, width, height,
    toJSON: () => ({}),
  } as DOMRect;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '#/');
});

describe('Chat bottom shelf preference contract', () => {
  it('admits only the complete versioned value', () => {
    expect(parseChatBottomShelfPreference(DEFAULT_CHAT_BOTTOM_SHELF_PREFERENCE))
      .toEqual(DEFAULT_CHAT_BOTTOM_SHELF_PREFERENCE);
    expect(parseChatBottomShelfPreference({ version: 1, visible: true, tab: 'preview' }))
      .toBeNull();
    expect(parseChatBottomShelfPreference({
      version: 1,
      visible: true,
      tab: 'preview',
      clickAction: 'navigate',
    })).toBeNull();
    expect(normalizeUserSettingValue(
      'chat_bottom_shelf',
      JSON.stringify(DEFAULT_CHAT_BOTTOM_SHELF_PREFERENCE),
    )).toBe(JSON.stringify(DEFAULT_CHAT_BOTTOM_SHELF_PREFERENCE));
    expect(normalizeUserSettingValue('chat_bottom_shelf', '{"version":2}')).toBeNull();
  });

  it('hydrates from and writes through the authenticated user setting', async () => {
    const stored: ChatBottomShelfPreference = {
      version: 1,
      visible: false,
      tab: 'preview',
      clickAction: 'open',
    };
    vi.spyOn(api, 'getUserChatBottomShelfSetting').mockResolvedValue({
      version: 1, key: 'chat_bottom_shelf', value: stored, revision: 3,
    });
    const update = vi.spyOn(api, 'updateUserChatBottomShelfSetting').mockImplementation(async (value) => ({
      version: 1, key: 'chat_bottom_shelf', value, revision: 4,
    }));

    function Harness(): JSX.Element {
      const [value, setValue, state] = useChatBottomShelfPreference();
      return (
        <button
          type="button"
          disabled={!state.ready}
          onClick={() => setValue((current) => ({ ...current, visible: true }))}
        >
          {value.tab}:{value.clickAction}:{String(value.visible)}
        </button>
      );
    }

    render(<Harness />);
    const button = await screen.findByRole('button', { name: 'preview:open:false' });
    fireEvent.click(button);
    await waitFor(() => expect(update).toHaveBeenCalledWith({ ...stored, visible: true }));
  });
});

describe('Chat entity-link actions', () => {
  it('uses the configured plain action and the platform alternate modifier', () => {
    expect(chatEntityLinkAction('preview', 'mac', { metaKey: false, ctrlKey: false })).toBe('preview');
    expect(chatEntityLinkAction('preview', 'mac', { metaKey: true, ctrlKey: false })).toBe('open');
    expect(chatEntityLinkAction('open', 'mac', { metaKey: true, ctrlKey: false })).toBe('preview');
    expect(chatEntityLinkAction('preview', 'other', { metaKey: false, ctrlKey: true })).toBe('open');
    expect(chatEntityLinkAction('open', 'other', { metaKey: false, ctrlKey: true })).toBe('preview');
  });

  it('routes issue refs through a typed target and makes authored refs actionable', () => {
    const host = document.createElement('div');
    host.innerHTML = linkifyResourceRefs('<p>See [issue:mandible/5096e37].</p>');
    const anchor = host.querySelector('a')!;
    expect(anchor.textContent).toBe('issue:mandible/5096e37');
    expect(previewableResourceFromAnchor(anchor)).toMatchObject({
      kind: 'issue', ref: '5096e37', repoId: 'mandible', label: 'issue:mandible/5096e37',
    });
  });

  it('previews on plain click and exposes clamped explicit actions with Escape focus restoration', async () => {
    vi.stubGlobal('innerWidth', 320);
    vi.stubGlobal('innerHeight', 240);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function bounds() {
      if (this.getAttribute('role') === 'menu') return domRect(0, 0, 180, 120);
      if (this.tagName === 'A') return domRect(286, 206, 26, 26);
      return domRect(0, 0, 0, 0);
    });
    const preview = vi.fn();
    const open = vi.fn();
    render(
      <ChatEntityLinkBoundary defaultAction="preview" onPreview={preview} onOpenNormally={open}>
        <a href="#/issues?repo=mandible&issue=5096e37">5096e37</a>
      </ChatEntityLinkBoundary>,
    );
    const link = screen.getByRole('link');
    fireEvent.click(link);
    expect(preview).toHaveBeenCalledWith(expect.objectContaining({ kind: 'issue', ref: '5096e37' }));

    fireEvent.contextMenu(link, { clientX: 12, clientY: 18 });
    const menu = screen.getByRole('menu');
    await waitFor(() => expect(menu.style.visibility).toBe('visible'));
    expect(menu.classList.contains('app-anchored-menu')).toBe(true);
    expect(Number.parseFloat(menu.style.left) + 180).toBeLessThanOrEqual(312);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open normally' }));
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ ref: '5096e37' }));

    fireEvent.keyDown(link, { key: 'F10', shiftKey: true });
    expect(screen.getByRole('menuitem', { name: 'Preview in footer' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Open normally' })).toBeTruthy();
    screen.getByRole('menuitem', { name: 'Preview in footer' }).focus();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(link);
  });

  it('preserves native issue navigation until authenticated preference hydration succeeds', () => {
    const preview = vi.fn();
    const open = vi.fn();
    const { rerender } = render(
      <ChatEntityLinkBoundary defaultAction={null} onPreview={preview} onOpenNormally={open}>
        <a href="#/issues?repo=mandible&issue=5096e37">5096e37</a>
      </ChatEntityLinkBoundary>,
    );
    const link = screen.getByRole('link');
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    link.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
    const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    link.dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(false);
    expect(preview).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();

    rerender(
      <ChatEntityLinkBoundary defaultAction="preview" onPreview={preview} onOpenNormally={open}>
        <a href="#/issues?repo=mandible&issue=5096e37">5096e37</a>
      </ChatEntityLinkBoundary>,
    );
    fireEvent.click(screen.getByRole('link'));
    expect(preview).toHaveBeenCalledOnce();
  });
});

describe('Chat shelf tabs', () => {
  function ShelfHarness({
    initial,
    initialTarget = null,
  }: {
    initial: ChatBottomShelfPreference;
    initialTarget?: ChatPreviewTarget | null;
  }): JSX.Element {
    const [preference, setPreference] = useState(initial);
    const [target, setTarget] = useState(initialTarget);
    return (
      <ChatBottomShelf
        preference={preference}
        preferenceReady
        preferenceError={null}
        providerSessionId={null}
        conversationId="conversation-1"
        previewTarget={target}
        onPreferenceChange={setPreference}
        onClearPreview={() => {
          setTarget(null);
          setPreference((current) => ({ ...current, tab: 'overview' }));
        }}
      />
    );
  }

  it('selects Session Overview by default and renders the exact empty Preview state', () => {
    render(<ShelfHarness initial={{ ...DEFAULT_CHAT_BOTTOM_SHELF_PREFERENCE }} />);
    expect(screen.getByRole('tab', { name: 'Session Overview' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('tab', { name: 'Preview' }));
    expect(screen.getByText('Nothing selected for preview.')).toBeTruthy();
  });

  it('uses canonical issue detail and returns to Session Overview after clear', async () => {
    vi.spyOn(api, 'getLedgerIssueDetailByRef').mockImplementation(() => new Promise(() => undefined));
    const target: ChatPreviewTarget = {
      kind: 'issue', ref: '5096e37', repoId: 'mandible', href: '#/issues?repo=mandible&issue=5096e37', label: '5096e37',
    };
    render(<ShelfHarness
      initial={{ ...DEFAULT_CHAT_BOTTOM_SHELF_PREFERENCE, tab: 'preview' }}
      initialTarget={target}
    />);
    expect(await screen.findByLabelText('Loading issue detail')).toBeTruthy();
    expect(api.getLedgerIssueDetailByRef).toHaveBeenCalledWith('mandible', '5096e37');
    fireEvent.click(screen.getByRole('button', { name: 'Clear preview' }));
    expect(screen.getByRole('tab', { name: 'Session Overview' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByText('Nothing selected for preview.')).toBeNull();
  });

  it('applies the same two-action boundary to issue links inside embedded Session Overview', async () => {
    vi.spyOn(api, 'getSessions').mockResolvedValue([]);
    vi.spyOn(api, 'resolveAgentSession').mockResolvedValue({
      provider: null,
      provider_session_id: 'provider-session-1',
      truncated: false,
      matches: [{
        matched_ref: 'provider-session-1',
        provider: 'codex',
        mandible_session_id: null,
        console_session_id: null,
        conversation_id: 'conversation-1',
        sources: ['conversations'],
      }],
    });
    vi.spyOn(api, 'getProviderScopedOverview').mockResolvedValue({
      as_of: 1,
      binding: { kind: 'provider-scoped', provider: 'codex', provider_session_id: 'provider-session-1' },
      session: { available: false, reason: 'not registered' },
      children: { available: false, reason: 'not registered', items: [], truncated: false, depth_limit: 5, count_limit: 200 },
      linked_issues: {
        available: true,
        source: 'work_units',
        note: 'derived',
        items: [{
          issue_id: '5096e37', short_id: '5096e37', title: 'Chat bottom shelf', status: 'open',
          worker_status: 'in_progress', kind: 'feature', work_unit_ids: ['work-1'],
        }],
      },
      work_units: { available: true, includes_descendants: false, matched_provider_aliases: [], items: [] },
      conversations: { available: true, limit: 20, items: [] },
    });
    const preview = vi.fn();
    render(
      <ChatEntityLinkBoundary defaultAction="preview" onPreview={preview}>
        <ChatBottomShelf
          preference={{ ...DEFAULT_CHAT_BOTTOM_SHELF_PREFERENCE }}
          preferenceReady
          preferenceError={null}
          providerSessionId="provider-session-1"
          conversationId="conversation-1"
          previewTarget={null}
          onPreferenceChange={() => undefined}
          onClearPreview={() => undefined}
        />
      </ChatEntityLinkBoundary>,
    );
    const issueLink = await screen.findByRole('link', { name: '5096e37' });
    fireEvent.click(issueLink);
    expect(preview).toHaveBeenCalledWith(expect.objectContaining({ kind: 'issue', ref: '5096e37' }));
  });

  it('remounts embedded Session Overview when conversation identity changes', async () => {
    vi.spyOn(api, 'getSessions').mockResolvedValue([]);
    vi.spyOn(api, 'resolveAgentSession').mockImplementation(async (providerSessionId) => ({
      provider: null,
      provider_session_id: providerSessionId,
      truncated: false,
      matches: providerSessionId === 'provider-old' ? [{
        matched_ref: providerSessionId,
        provider: 'codex',
        mandible_session_id: 'mandible-old',
        console_session_id: null,
        conversation_id: 'conversation-old',
        sources: ['sessions', 'conversations'],
      }] : [],
    }));
    vi.spyOn(api, 'getSessionOverview').mockResolvedValue({
      as_of: 1,
      session: { id: 'mandible-old', status: 'active', app: 'codex', created_at: 1 },
      children: { available: true, items: [], truncated: false, depth_limit: 5, count_limit: 200 },
      linked_issues: { available: true, source: 'ledger_session_issue_links', items: [] },
      work_units: { available: true, includes_descendants: true, matched_provider_aliases: [], items: [] },
      conversations: { available: true, limit: 20, items: [] },
    });
    const shelf = (conversationId: string, providerSessionId: string) => (
      <ChatBottomShelf
        preference={{ ...DEFAULT_CHAT_BOTTOM_SHELF_PREFERENCE }}
        preferenceReady
        preferenceError={null}
        providerSessionId={providerSessionId}
        conversationId={conversationId}
        previewTarget={null}
        onPreferenceChange={() => undefined}
        onClearPreview={() => undefined}
      />
    );
    const { rerender } = render(shelf('conversation-old', 'provider-old'));
    expect(await screen.findByText(/Bound to agent session/)).toBeTruthy();

    rerender(shelf('conversation-new', 'provider-new'));
    expect(screen.queryByText(/Bound to agent session/)).toBeNull();
    expect(await screen.findByText(/No Mandible session matches agent session/)).toBeTruthy();
  });
});
