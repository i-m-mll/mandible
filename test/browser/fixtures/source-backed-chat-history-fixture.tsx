import { render } from 'preact';
import { useCallback, useMemo, useRef, useState } from 'preact/hooks';

import { AppShellProvider, type AppRightSidebarDescriptor } from '../../../ui/src/app-shell';
import { ConversationDetail, type ConversationAnchor } from '../../../ui/src/views/conversations';

declare global {
  interface Window {
    __sourceBackedHistory: {
      navigate: (anchor: ConversationAnchor | null) => void;
      searchAndNavigate: (needle: string) => Promise<string>;
      snapshot: () => Record<string, unknown>;
    };
  }
}

const conversationId = 'source-backed-history';
const requests: string[] = [];
const seenBlockIds = new Set<string>();
let maximumMountedRows = 0;
let navigation: (anchor: ConversationAnchor | null) => void = () => undefined;

const nativeFetch = window.fetch.bind(window);
window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.includes('/api/conversations')) requests.push(url);
  return nativeFetch(input, init);
}) as typeof window.fetch;

Object.defineProperty(window, 'EventSource', { value: undefined, configurable: true });
Object.defineProperty(navigator, 'clipboard', {
  value: { writeText: () => Promise.resolve() },
  configurable: true,
});

const observer = new MutationObserver(() => {
  for (const element of document.querySelectorAll<HTMLElement>('[data-block-id]')) {
    if (element.dataset.blockId) seenBlockIds.add(element.dataset.blockId);
  }
  maximumMountedRows = Math.max(
    maximumMountedRows,
    document.querySelectorAll('.stream-renderer__virtual-row').length,
  );
});
observer.observe(document.documentElement, { childList: true, subtree: true });

function initialAnchor(): ConversationAnchor | null {
  const query = new URLSearchParams(window.location.search);
  const block = query.get('block');
  const position = query.get('position');
  if (block) return { block };
  if (position && /^\d+$/.test(position)) return { position: Number(position) };
  return null;
}

function Fixture(): JSX.Element {
  const [anchor, setAnchor] = useState<ConversationAnchor | null>(initialAnchor);
  const [rightSidebar, setRightSidebar] = useState<AppRightSidebarDescriptor | null>(null);
  const ownerRef = useRef<string | null>(null);
  navigation = setAnchor;
  const registerRightSidebar = useCallback((ownerId: string) => {
    ownerRef.current = ownerId;
    return () => {
      if (ownerRef.current !== ownerId) return;
      ownerRef.current = null;
      setRightSidebar((current) => current?.id === ownerId ? null : current);
    };
  }, []);
  const updateRightSidebar = useCallback((ownerId: string, descriptor: AppRightSidebarDescriptor) => {
    if (ownerRef.current === ownerId) setRightSidebar((current) => current === descriptor ? current : descriptor);
  }, []);
  const shell = useMemo(() => ({
    active: true,
    rightSidebar,
    registerRightSidebar,
    updateRightSidebar,
    setViewSidebarWidth: () => undefined,
  }), [registerRightSidebar, rightSidebar, updateRightSidebar]);

  return (
    <AppShellProvider value={shell}>
      <ConversationDetail
        conversationId={conversationId}
        anchor={anchor}
        onNavigate={() => undefined}
        consoleSessions={[]}
        sidebarCollapsed={false}
        chatEntityLinkAction="preview"
      />
    </AppShellProvider>
  );
}

window.__sourceBackedHistory = {
  navigate: (anchor) => navigation(anchor),
  searchAndNavigate: async (needle) => {
    const response = await nativeFetch(`/api/conversations/sidebar?search=${encodeURIComponent(needle)}&full_text=true&limit=5`);
    const payload = await response.json() as {
      groups?: Array<{ conversations?: Array<{ id?: string; search_target?: ConversationAnchor }> }>;
    };
    const target = payload.groups?.flatMap((group) => group.conversations ?? [])
      .find((conversation) => conversation.id === conversationId)?.search_target;
    if (!target || !('block' in target)) throw new Error('Full-text search did not return an exact block target.');
    requests.push(`search-target:${target.block}`);
    navigation(target);
    return target.block;
  },
  snapshot: () => {
    const scroll = document.querySelector<HTMLElement>('.stream-renderer__scroll');
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return {
      requests: [...requests],
      seenBlockIds: [...seenBlockIds],
      mountedRows: document.querySelectorAll('.stream-renderer__virtual-row').length,
      maximumMountedRows,
      scrollTop: scroll?.scrollTop ?? null,
      scrollHeight: scroll?.scrollHeight ?? null,
      clientHeight: scroll?.clientHeight ?? null,
      focusedBlockId: focused?.dataset.blockId
        ?? focused?.closest<HTMLElement>('[data-block-id]')?.dataset.blockId
        ?? null,
      text: document.body.textContent ?? '',
    };
  },
};

render(<Fixture />, document.getElementById('root')!);
