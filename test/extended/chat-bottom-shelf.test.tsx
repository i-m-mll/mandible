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
import { ChatEntityLinkBoundary } from '../../ui/src/chat/ChatEntityLinkBoundary';
import {
  chatEntityLinkAction,
  issuePreviewTargetFromAnchor,
  linkifyChatIssueRefs,
  type ChatPreviewTarget,
} from '../../ui/src/chat/chatEntityLinks';
import { useChatBottomShelfPreference } from '../../ui/src/chat/useChatBottomShelfPreference';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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
    host.innerHTML = linkifyChatIssueRefs('<p>See [issue:mandible/5096e37].</p>');
    const anchor = host.querySelector('a')!;
    expect(anchor.textContent).toBe('mandible/5096e37');
    expect(issuePreviewTargetFromAnchor(anchor)).toMatchObject({
      kind: 'issue', ref: '5096e37', repoId: 'mandible', label: 'mandible/5096e37',
    });
  });

  it('previews on plain click and exposes both explicit actions by mouse and keyboard', () => {
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
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open normally' }));
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ ref: '5096e37' }));

    fireEvent.keyDown(link, { key: 'F10', shiftKey: true });
    expect(screen.getByRole('menuitem', { name: 'Preview in footer' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Open normally' })).toBeTruthy();
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
        previewTarget={target}
        onPreferenceChange={setPreference}
        onClearPreview={() => setTarget(null)}
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
});
