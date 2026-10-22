import { render } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';

import { AppShellProvider, type AppRightSidebarDescriptor } from '../../../ui/src/app-shell';
import { ConversationDetail } from '../../../ui/src/views/conversations';

const conversationId = 'source-backed-conversation';
const providerSessionId = 'source-backed-session';
const ignoreNavigation = () => undefined;

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
  chatItem('message', 'assistant', 6, 'A source-backed assistant response'),
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
