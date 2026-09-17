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
const fetchedBlockIds = new Set<string>();
const seenBlockIds = new Set<string>();
let maximumMountedRows = 0;
let navigation: (anchor: ConversationAnchor | null) => void = () => undefined;

const nativeFetch = window.fetch.bind(window);
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  // This source-reader fixture has no browser-session server. Supply only its
  // access boundary; all conversation bytes still traverse the real HTTP route.
  if (url === '/api/client-auth/whoami') {
    return new Response(JSON.stringify({
      authenticated: true,
      session: {
        family_id: 'source-history-family', audience: 'production',
        csrf_token: 'source-history-csrf', effect_ceiling: ['ledger:read'],
      },
    }), { headers: { 'Content-Type': 'application/json' } });
  }
  if (url.includes('/api/conversations')) requests.push(url);
  const response = await nativeFetch(input, init);
  if (url.includes(`/api/conversations/${conversationId}`) && response.ok) {
    void response.clone().json().then((payload: { blocks?: Array<{ id?: string }> }) => {
      for (const block of payload.blocks ?? []) {
        if (block.id) fetchedBlockIds.add(block.id);
      }
    }).catch(() => undefined);
  }
  return response;
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
  for (const element of document.querySelectorAll<HTMLElement>('[data-member-refs]')) {
    for (const blockId of (element.dataset.memberRefs ?? '').split(/\s+/).filter(Boolean)) {
      seenBlockIds.add(blockId);
    }
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
      fetchedBlockIds: [...fetchedBlockIds],
      seenBlockIds: [...seenBlockIds],
      mountedRows: document.querySelectorAll('.stream-renderer__virtual-row').length,
      maximumMountedRows,
      scrollTop: scroll?.scrollTop ?? null,
      scrollHeight: scroll?.scrollHeight ?? null,
      clientHeight: scroll?.clientHeight ?? null,
      focusedBlockId: focused?.dataset.blockId
        ?? focused?.closest<HTMLElement>('[data-block-id]')?.dataset.blockId
        ?? null,
      text: document.getElementById('root')?.textContent ?? '',
    };
  },
};

render(<Fixture />, document.getElementById('root')!);
