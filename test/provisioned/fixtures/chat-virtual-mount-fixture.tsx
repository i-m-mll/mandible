import { render } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';

import { AppShellProvider, type AppRightSidebarDescriptor } from '../../../ui/src/app-shell';
import { ConversationDetail } from '../../../ui/src/views/conversations';
import { queryClient } from '../../../ui/src/query/client';
import { conversationKeys } from '../../../ui/src/query/conversationKeys';

const conversationId = 'source-backed-conversation';
const providerSessionId = 'source-backed-session';
const ignoreNavigation = () => undefined;
const overlayViewport = new URLSearchParams(location.search).has('overlay-viewport');

function chatItem(
  type: 'message' | 'activity',
  role: 'user' | 'assistant' | 'system',
  ordinal: number,
  text = '',
) {
  return {
    type,
    role,
    ...(type === 'activity' ? { activity_kind: 'status', status: 'complete' } : {}),
    parts: text ? [{ type: 'text', text }] : [],
    identity: {
      provider: 'codex',
      session_id: providerSessionId,
      source_record_ordinal: ordinal,
      source_sub_block_ordinal: 0,
      native_turn_id: `turn-${ordinal}`,
    },
    provenance: {
      source: 'verified-provider-transcript',
      provider: 'codex',
      source_event_type: 'browser-fixture',
    },
    content_completion: 'complete',
  };
}

const canonicalItems = [
  chatItem('activity', 'system', 0),
  chatItem('message', 'user', 5, 'A source-backed user prompt'),
  chatItem('message', 'assistant', 6, 'A source-backed assistant response'.repeat(overlayViewport ? 200 : 1)),
  chatItem('activity', 'system', 8),
];

const blocks = Array.from({ length: 9 }, (_, position) => {
  const item = position === 0 ? canonicalItems[0]
    : position === 5 ? canonicalItems[1]
      : position === 6 ? canonicalItems[2]
        : position === 8 ? canonicalItems[3]
          : null;
  return {
    id: `block-${position}`,
    conversation_id: conversationId,
    type: item?.type === 'message' ? `${item.role}_message` : item ? 'event' : 'system',
    role: item?.role ?? 'system',
    content: item ? '' : 'hidden provider context '.repeat(position === 4 ? 3_000 : 10),
    position,
    timestamp: `2026-09-14T01:00:0${position}.000Z`,
    parent_id: null,
    dag_uuid: null,
    metadata_json: JSON.stringify(item ? { chat_item: item } : { visibility: 'hidden' }),
  };
});

const conversation = {
  id: conversationId,
  source: 'codex',
  source_path: '/private/source-backed.jsonl',
  source_hash: 'fixture',
  source_mtime: 1,
  title: 'Source-backed browser fixture',
  summary: null,
  started_at: '2026-09-14T01:00:00.000Z',
  ended_at: '2026-09-14T01:00:09.000Z',
  block_count: blocks.length,
  session_id: providerSessionId,
  project_path: null,
  cwd: null,
  branch: null,
  model: 'gpt-test',
  cli_version: null,
  notes: null,
  created_at: '2026-09-14 01:00:00',
  updated_at: '2026-09-14 01:00:09',
  tags: [],
  starred: false,
  archived_at: null,
  parent_conversation_id: null,
  is_sidechain: false,
  agent_id: null,
  children_count: 0,
  external_navigation: null,
};

const positionWindow = {
  conversation,
  body_source: 'source',
  source_version_id: 'fixture-v1',
  children: [],
  parent: null,
  revision: 9,
  total: blocks.length,
  target: {
    kind: 'initial',
    requested_value: null,
    position: blocks.length - 1,
    block_id: blocks.at(-1)!.id,
    turn_id: 'turn-8',
  },
  window: {
    start_position: 0,
    end_position: blocks.length - 1,
    has_before: false,
    has_after: false,
    after_count: 0,
    limit: 20,
  },
  blocks,
};

const structure = {
  conversation_id: conversationId,
  source_version_id: positionWindow.source_version_id,
  total: blocks.length,
  rows: blocks.map((block) => ({
    id: block.id,
    position: block.position,
    type: block.type,
    role: block.role,
    parent_position: null,
    record_offset: null,
    record_length: block.content.length,
  })),
};

Object.defineProperty(window, 'EventSource', { value: undefined, configurable: true });
Object.defineProperty(navigator, 'clipboard', {
  value: { writeText: () => Promise.resolve() },
  configurable: true,
});

window.fetch = ((input: RequestInfo | URL) => {
  const url = String(input);
  if (url === '/api/client-auth/whoami') {
    return Promise.resolve(new Response(JSON.stringify({
      authenticated: true,
      session: {
        family_id: 'chat-mount-family',
        audience: 'production',
        csrf_token: 'chat-mount-csrf',
        effect_ceiling: ['ledger:read', 'ledger:write'],
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
  }
  if (url === `/api/conversations/${conversationId}/structure`) {
    return Promise.resolve(new Response(JSON.stringify(structure), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
  }
  if (url.includes(`/api/conversations/${conversationId}`) && !url.includes('/control')) {
    return Promise.resolve(new Response(JSON.stringify(positionWindow), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
  }
  return Promise.resolve(new Response(JSON.stringify({ error: 'fixture endpoint omitted' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  }));
}) as typeof window.fetch;

function Fixture(): JSX.Element {
  const [rightSidebar, setRightSidebar] = useState<AppRightSidebarDescriptor | null>(null);
  const ownerRef = useRef<string | null>(null);
  const updateCountRef = useRef(0);
  const registerRightSidebar = useCallback((ownerId: string) => {
    ownerRef.current = ownerId;
    return () => {
      if (ownerRef.current !== ownerId) return;
      ownerRef.current = null;
      setRightSidebar((current) => current?.id === ownerId ? null : current);
    };
  }, []);
  const updateRightSidebar = useCallback((ownerId: string, descriptor: AppRightSidebarDescriptor) => {
    if (ownerRef.current !== ownerId) return;
    updateCountRef.current += 1;
    setRightSidebar((current) => current === descriptor ? current : descriptor);
  }, []);
  const shell = useMemo(() => ({
    active: true,
    rightSidebar,
    registerRightSidebar,
    registerInitialRouteLoad: () => undefined,
    updateRightSidebar,
    setViewSidebarWidth: () => undefined,
  }), [registerRightSidebar, rightSidebar, updateRightSidebar]);

  useEffect(() => {
    if (overlayViewport) {
      const nextLayout = () => new Promise<void>((resolve) => window.setTimeout(resolve, 32));
      void (async () => {
        let scroll: HTMLElement | null = null;
        for (let frame = 0; frame < 30 && !scroll; frame += 1) {
          await nextLayout();
          scroll = document.querySelector<HTMLElement>('.stream-renderer__scroll');
        }
        if (!scroll) throw new Error('Transcript did not mount');
        const root = document.getElementById('root')!;
        root.style.height = '24px';
        for (let frame = 0; frame < 8; frame += 1) {
          window.dispatchEvent(new Event('resize'));
          await nextLayout();
        }
        root.style.height = '700px';
        window.dispatchEvent(new Event('resize'));
        await nextLayout();
        scroll.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
        scroll.scrollTop = 100;
        scroll.dispatchEvent(new Event('scroll'));
        await nextLayout();
        const readingPosition = scroll.scrollTop;
        let blankFrames = 0;
        let scrollReplaced = false;
        let maxRestoredHeight = 0;
        let maxRestoredPadding = 0;
        let scrollDrift = 0;
        for (let frame = 0; frame < 12; frame += 1) {
          await queryClient.invalidateQueries({ queryKey: conversationKeys.conversation(conversationId) });
          window.dispatchEvent(new Event('resize'));
          await nextLayout();
          scrollReplaced ||= document.querySelector('.stream-renderer__scroll') !== scroll;
          const viewport = scroll.closest('.detail-pane-shell__body')!.getBoundingClientRect();
          const visibleContent = [...scroll.querySelectorAll('.stream-renderer__virtual-row')].some((row) => {
            const bounds = row.getBoundingClientRect();
            return bounds.bottom > viewport.top && bounds.top < viewport.bottom && Boolean(row.textContent?.trim());
          });
          if (!visibleContent) blankFrames += 1;
          maxRestoredHeight = Math.max(maxRestoredHeight, scroll.getBoundingClientRect().height);
          maxRestoredPadding = Math.max(maxRestoredPadding, parseFloat(getComputedStyle(scroll).paddingBottom));
          scrollDrift = Math.max(scrollDrift, Math.abs(scroll.scrollTop - readingPosition));
        }
        document.body.dataset.overlayResult = btoa(JSON.stringify({ blankFrames, scrollReplaced, maxRestoredHeight, maxRestoredPadding, scrollDrift }));
      })().catch((error) => { document.body.dataset.overlayResult = btoa(JSON.stringify({ error: String(error) })); });
      return;
    }
    const timer = window.setTimeout(() => {
      const rows = document.querySelectorAll('.stream-renderer__virtual-row');
      const hasResponse = document.body.textContent?.includes('A source-backed assistant response') ?? false;
      document.body.dataset.mountStatus = rows.length > 0 && hasResponse ? 'settled' : 'incomplete';
      document.body.dataset.sidebarUpdates = String(updateCountRef.current);
    }, 750);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <AppShellProvider value={shell}>
      <ConversationDetail
        conversationId={conversationId}
        anchor={null}
        onNavigate={ignoreNavigation}
        consoleSessions={[]}
        sidebarCollapsed={false}
        chatEntityLinkAction="preview"
      />
    </AppShellProvider>
  );
}

render(<Fixture />, document.getElementById('root')!);
