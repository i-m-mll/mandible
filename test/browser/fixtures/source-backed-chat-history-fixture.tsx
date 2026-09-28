import { render } from 'preact';
import { useCallback, useMemo, useRef, useState } from 'preact/hooks';

import { AppShellProvider, type AppRightSidebarDescriptor } from '../../../ui/src/app-shell';
import { queryClient } from '../../../ui/src/query/client';
import { ConversationDetail, type ConversationAnchor } from '../../../ui/src/views/conversations';

declare global {
  interface Window {
    __sourceBackedHistory: {
      navigate: (anchor: ConversationAnchor | null) => void;
      refreshSourceVersion: () => Promise<void>;
      snapshot: () => Record<string, unknown>;
    };
  }
}

const conversationId = 'source-backed-history';
const requests: string[] = [];
const transformedSourceRequests: string[] = [];
const fetchedBlockIds = new Set<string>();
const seenBlockIds = new Set<string>();
let maximumMountedRows = 0;
let refreshedSourceGeneration = 0;
let navigation: (anchor: ConversationAnchor | null) => void = () => undefined;
let refreshActiveConversation: () => Promise<void> = async () => undefined;

const nativeFetch = window.fetch.bind(window);
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
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
  let response = await nativeFetch(input, init);
  const requestPath = new URL(url, window.location.href).pathname;
  if (requestPath === `/api/conversations/${conversationId}`
      && response.ok && refreshedSourceGeneration > 0) {
    transformedSourceRequests.push(url);
    const payload = await response.json() as {
      source_version_id?: string | null;
    };
    payload.source_version_id = `source-refresh-${refreshedSourceGeneration}`;
    response = new Response(JSON.stringify(payload), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
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

function recordMountedBlocks(): void {
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
}

const observer = new MutationObserver(recordMountedBlocks);
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
  refreshActiveConversation = () => queryClient.refetchQueries({
    queryKey: ['chat', 'conversation', conversationId, 'window'],
    type: 'active',
  });
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
  refreshSourceVersion: () => {
    refreshedSourceGeneration += 1;
    return refreshActiveConversation();
  },
  snapshot: () => {
    recordMountedBlocks();
    const scroll = document.querySelector<HTMLElement>('.stream-renderer__scroll');
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const transcript = queryClient.getQueryData<{
      source_version_id?: string | null;
      blocks?: Array<{ id: string }>;
    }>(['chat', 'conversation', conversationId, 'aggregate']);
    const readingAnchor = (() => {
      const entry = Object.entries(window.localStorage).find(([key]) => key.includes('chat-scroll'));
      if (!entry) return null;
      try { return JSON.parse(entry[1]) as Record<string, unknown>; } catch { return null; }
    })();
    return {
      requests: [...requests],
      transformedSourceRequests: [...transformedSourceRequests],
      fetchedBlockIds: [...fetchedBlockIds],
      seenBlockIds: [...seenBlockIds],
      sourceVersionId: transcript?.source_version_id ?? null,
      anchorBlockLoaded: Boolean(readingAnchor?.blockId && transcript?.blocks?.some((block) => (
        block.id === readingAnchor.blockId
      ))),
      mountedRows: document.querySelectorAll('.stream-renderer__virtual-row').length,
      historyRows: document.querySelectorAll('.stream-renderer__history-state').length,
      maximumMountedRows,
      scrollTop: scroll?.scrollTop ?? null,
      scrollHeight: scroll?.scrollHeight ?? null,
      clientHeight: scroll?.clientHeight ?? null,
      readingAnchor,
      focusedBlockId: focused?.dataset.blockId
        ?? focused?.closest<HTMLElement>('[data-block-id]')?.dataset.blockId
        ?? null,
      text: document.getElementById('root')?.textContent ?? '',
    };
  },
};

render(<Fixture />, document.getElementById('root')!);
