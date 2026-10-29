// @vitest-environment jsdom
import { establishTestClientAccess } from './helpers/local-client-access';
import { act, cleanup, fireEvent, render, screen, within } from "./helpers/dom.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as api from "../ui/src/api.js";
import { ConversationsView } from "../ui/src/views/conversations.js";
import { queryClient } from '../ui/src/query/client';
import { __resetSharedSseForTests } from '../ui/src/sse-shared';
import { StrictUiFixture, finishUiFixtures, jsonFixture, PENDING_RESPONSE, type FixtureHandler } from './helpers/strict-ui-fixture';
import type { FullTextSearchPending, FullTextSearchTerminal } from '../src/conversations/full-text-search-contract';
import { AppShellProvider, useAppShell } from '../ui/src/app-shell';
import type { ComponentChildren } from 'preact';

vi.mock("@xterm/xterm", () => ({
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

vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit(): void {} dispose(): void {} } }));

let noticeHost: HTMLDivElement;
beforeEach(async () => {
  noticeHost = document.createElement('div');
  document.body.append(noticeHost);
  queryClient.clear();
  window.localStorage.clear();
  await establishTestClientAccess();
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(api, 'getConversationWindow').mockImplementation(() => new Promise(() => {}));
  vi.spyOn(api, 'getConversationStructure').mockImplementation(() => new Promise(() => {}));
  vi.spyOn(api, 'getConversationControl').mockImplementation(() => new Promise(() => {}));
  vi.spyOn(api, 'getConversationLiveProjection').mockImplementation(() => new Promise(() => {}));
  vi.spyOn(api, 'listWorkflows').mockResolvedValue([]);
  vi.spyOn(api, 'getSessionIssues').mockResolvedValue([]);
  vi.spyOn(api, "listCanonicalProjects").mockResolvedValue([]);
  vi.spyOn(api, "getChatShownProjectsPreference").mockResolvedValue({
    version: 1, key: "chat_shown_projects", value: [], revision: 0,
  });
  vi.spyOn(api, "updateChatShownProjectsPreference").mockImplementation(async (value, revision) => ({
    version: 1, key: "chat_shown_projects", value, revision: revision + 1,
  }));
  vi.spyOn(api, "getSidebarOrderPreference").mockResolvedValue({
    version: 1, key: "sidebar_order", value: { pinnedConversationIds: null, briefingTopLevelIds: null }, revision: 0,
  });
  vi.spyOn(api, "updateSidebarOrderPreference").mockImplementation(async (value, revision) => ({
    version: 1, key: "sidebar_order", value, revision: revision + 1,
  }));
});

afterEach(() => {
  cleanup();
  noticeHost.remove();
  queryClient.clear();
  __resetSharedSseForTests();
  finishUiFixtures();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const coverage = { eligible: 2, prepared: 2, scanned: 2, matched: 2, failed: 0, complete: true as const };
const events: FixtureHandler = { name: 'idle events', method: 'POST', path: '/api/events/subscribe', respond: () => PENDING_RESPONSE };
const detail: FixtureHandler = { name: 'pending detail reads', method: 'GET', path: /^\/api\/(?!conversations\/sidebar$)/, respond: () => PENDING_RESPONSE };
function row(id: string): api.ConversationSidebarConversation {
  return {
    id, source: 'codex', source_path: `/tmp/${id}.jsonl`, title: id, summary: null,
    started_at: '2026-10-29T12:00:00.000Z', ended_at: null, block_count: 2,
    session_id: `session-${id}`, project_path: null, cwd: null, branch: null,
    model: null, cli_version: null, is_sidechain: false, agent_id: null, starred: false,
    tags: [], notes: null, parent_conversation_id: null, children_count: 0,
    canonical_project_id: null, canonical_project_key: null,
  };
}
function page(ids: string[], cursor: string | null = null, total = ids.length): api.ConversationSidebarResponse {
  return { limit: 1, groups: [{ key: 'chats', kind: 'chats', label: 'Chats', total,
    conversations: ids.map(row), next_cursor: cursor }] };
}
function pending(id = 'search-1'): FullTextSearchPending {
  return { state: 'pending', search_id: id, observer_token: `observer-${id}`, phase: 'scanning',
    progress: { eligible: 2, prepared: 2, scanned: 1, matched: 1 }, retry_after_ms: 500 };
}
function complete(ids: string[], cursor: string | null = null, id = 'search-1', total = cursor ? 2 : ids.length) {
  return { ...page(ids, cursor, total), state: 'complete', search_id: id, snapshot_id: id, coverage };
}
function view(active = true) {
  return <Shell active={active}><ConversationsView consoleSessions={[]} initialConversationId={null} initialSessionId={null}
    sidebarGroupLimit={1} onSelectSession={() => {}} onNewConversation={vi.fn()} /></Shell>;
}
function Shell({ active, children }: { active: boolean; children: ComponentChildren }) {
  const parent = useAppShell();
  return <AppShellProvider value={{ ...parent, active, noticeHost }}>{children}</AppShellProvider>;
}
function sidebar() {
  return within(screen.getByRole('complementary', { name: 'Conversations' }));
}
async function tick(ms = 25) {
  await act(async () => {});
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  await act(async () => {});
}
function search(value: string) {
  fireEvent.input(screen.getByRole('textbox', { name: 'Search chats' }), { target: { value } });
}
function fullText() {
  fireEvent.click(screen.getByRole('button', { name: 'Search and filter options' }));
  fireEvent.click(screen.getByRole('button', { name: 'Full text' }));
}

describe('completed search snapshots in Chat', () => {
  it('keeps completed rows while pending, swaps atomically and concatenates only exact snapshot pages', async () => {
    vi.useFakeTimers();
    let ready = false;
    const fixture = new StrictUiFixture('search snapshot', [events, detail, { method: 'GET', path: '/api/conversations/sidebar',
      name: 'sidebar union', respond: ({ url }) => {
        if (url.searchParams.has('cancel')) return jsonFixture({ released: true });
        if (!url.searchParams.has('search')) return jsonFixture(url.searchParams.has('cursor')
          ? page(['Prior page'], null, 2) : page(['Prior chat'], 'prior-next', 2));
        if (url.searchParams.has('cursor')) {
          expect(url.searchParams.get('search_id')).toBe('search-1');
          expect(url.searchParams.get('snapshot_id')).toBe('search-1');
          expect(url.searchParams.get('cursor')).toBe('exact-next');
          return jsonFixture(complete(['Second match'], null, 'search-1', 2));
        }
        return ready ? jsonFixture(complete(['First match'], 'exact-next')) : jsonFixture(pending(), 202);
      } }]).install();
    render(view());
    await tick();
    expect(sidebar().getByText('Prior chat')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    await tick();
    expect(sidebar().getByText('Prior page')).toBeTruthy();
    const body = document.querySelector('.chat-history-list')!;
    body.scrollTop = 37;
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Chats' }));
    fullText();
    search('needle absent from titles');
    await tick();
    expect(screen.getByRole('button', { name: 'Expand Chats' })).toBeTruthy();
    expect(body.scrollTop).toBe(37);
    fireEvent.click(screen.getByRole('button', { name: 'Expand Chats' }));
    expect(sidebar().getByText('Prior chat')).toBeTruthy();
    expect(sidebar().getByText('Prior page')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('Showing previous results');
    expect(sidebar().queryByText('No chats')).toBeNull();
    expect(sidebar().queryByText('First match')).toBeNull();
    ready = true;
    await tick(525);
    await tick();
    expect(sidebar().queryByText('Prior chat')).toBeNull();
    expect(sidebar().queryByText('Prior page')).toBeNull();
    expect(sidebar().getByText('First match')).toBeTruthy();
    expect(sidebar().getByText('Second match')).toBeTruthy();
    expect(sidebar().getByRole('button', { name: 'Chats' }).getAttribute('aria-description')).toBe('2 chats');
    expect(fixture.requested.some(path => path.includes('cancel=true'))).toBe(true);
  });

  it('does not assert emptiness before the first search completes, including incomplete coverage', async () => {
    vi.useFakeTimers();
    let retry = false;
    new StrictUiFixture('initial pending search', [events, detail, { method: 'GET', path: '/api/conversations/sidebar',
      name: 'sidebar union', respond: ({ url }) => {
        if (url.searchParams.has('cancel')) return jsonFixture({ released: true });
        if (!url.searchParams.has('search')) return PENDING_RESPONSE;
        if (retry) return jsonFixture({ ...complete([]), coverage: { eligible: 0, prepared: 0, scanned: 0, matched: 0, failed: 0, complete: true } });
        if (!url.searchParams.has('search_id')) return jsonFixture(pending(), 202);
        return jsonFixture({ state: 'incomplete', search_id: 'search-1', reason: 'source_unavailable',
          coverage: { ...coverage, failed: 1, complete: false } }, 409);
      } }]).install();
    render(view());
    await tick();
    fullText();
    search('first query');
    await tick();
    expect(sidebar().queryByText('No chats')).toBeNull();
    expect(screen.queryByText('No chats in this view')).toBeNull();
    expect(sidebar().getByRole('status').textContent).toContain('Searching chats');
    await tick(525);
    expect(screen.getByRole('button', { name: 'Retry search' })).toBeTruthy();
    expect(screen.queryByText('No chats in this view')).toBeNull();
    retry = true;
    fireEvent.click(screen.getByRole('button', { name: 'Retry search' }));
    await tick();
    expect(sidebar().getByText('No chats')).toBeTruthy();
  });

  it('keeps rows on incomplete coverage and expired pages, with explicit snapshot retries', async () => {
    vi.useFakeTimers();
    let retry = false;
    let expired = false;
    const terminal = (state: FullTextSearchTerminal['state']): FullTextSearchTerminal => ({
      state, search_id: 'search-1', reason: state === 'incomplete' ? 'source_unavailable' : 'snapshot_expired',
      coverage: { ...coverage, failed: 1, complete: false },
    });
    const fixture = new StrictUiFixture('terminal search', [events, detail, { method: 'GET', path: '/api/conversations/sidebar',
      name: 'sidebar union', respond: ({ url }) => {
        if (url.searchParams.has('cancel')) return jsonFixture({ released: true });
        if (!url.searchParams.has('search')) return jsonFixture(page(['Prior chat']));
        if (url.searchParams.has('cursor')) { expired = true; return jsonFixture(terminal('expired'), 409); }
        return retry ? jsonFixture(complete(['Fresh match'], expired ? null : 'expires', expired ? 'search-2' : 'search-1'))
          : url.searchParams.has('search_id') ? jsonFixture(terminal('incomplete'), 409) : jsonFixture(pending(), 202);
      } }]).install();
    render(view());
    await tick();
    fullText();
    search('needle');
    await tick();
    await tick(525);
    expect(sidebar().getByText('Prior chat')).toBeTruthy();
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Retry search' })).toBeTruthy());
    const requests = fixture.requested.length;
    await tick(10_000);
    expect(fixture.requested).toHaveLength(requests);
    expect(sidebar().queryByText('No chats')).toBeNull();
    retry = true;
    fireEvent.click(screen.getByRole('button', { name: 'Retry search' }));
    await tick();
    expect(sidebar().getByText('Fresh match')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    await tick();
    expect(sidebar().getByText('Fresh match')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh search' }));
    await tick();
    expect(screen.queryByRole('button', { name: 'Refresh search' })).toBeNull();
    expect(sidebar().getByText('Fresh match')).toBeTruthy();
  });

  it('rejects an obsolete completion and releases observers on filter change, deactivation and unmount', async () => {
    vi.useFakeTimers();
    let resolveOld!: (response: Response) => void;
    const releases: string[] = [];
    const fixture = new StrictUiFixture('obsolete search', [events, detail, { method: 'GET', path: '/api/conversations/sidebar',
      name: 'sidebar union', respond: ({ url }) => {
        if (url.searchParams.has('cancel')) { releases.push(url.searchParams.get('search_id')!); return jsonFixture({ released: true }); }
        if (!url.searchParams.has('search')) return jsonFixture(page(['Prior chat']));
        const id = url.searchParams.get('source') ?? url.searchParams.get('search')!;
        if (url.searchParams.get('search_id') === 'old') return new Promise(resolve => { resolveOld = resolve; });
        return jsonFixture(pending(id), 202);
      } }]).install();
    const rendered = render(view());
    await tick();
    fullText();
    search('old');
    await tick(525);
    search('new');
    await tick();
    resolveOld(jsonFixture(complete(['Obsolete match'], null, 'old')));
    await tick();
    expect(sidebar().queryByText('Obsolete match')).toBeNull();
    expect(sidebar().getByText('Prior chat')).toBeTruthy();
    expect(releases).toContain('old');
    fireEvent.click(screen.getByRole('button', { name: 'Claude' }));
    await tick();
    expect(releases).toContain('new');
    rendered.rerender(view(false));
    await tick();
    expect(releases).toContain('claude_code');
    const stoppedCount = fixture.requested.length;
    await tick(5_000);
    expect(fixture.requested).toHaveLength(stoppedCount);
    rendered.rerender(view());
    await tick();
    rendered.unmount();
    await tick();
    const unmountedCount = fixture.requested.length;
    await tick(5_000);
    expect(fixture.requested).toHaveLength(unmountedCount);
  });
});

describe("conversation full-text UI request path", () => {
  it("turns the visible Full text toggle into the list API full_text contract", async () => {
    vi.useFakeTimers();
    const getConversationSidebar = vi.spyOn(api, "getConversationSidebar").mockResolvedValue({ groups: [], limit: 5 });
    render(<ConversationsView
      consoleSessions={[]}
      initialConversationId={null}
      initialSessionId={null}
      onSelectSession={() => {}}
      onNewConversation={() => {}}
    />);

    fireEvent.click(screen.getByRole("button", { name: "Search and filter options" }));
    fireEvent.click(screen.getByRole("button", { name: "Full text" }));
    fireEvent.input(screen.getByRole("textbox", { name: "Search chats" }), {
      target: { value: " body needle " },
    });
    await vi.advanceTimersByTimeAsync(350);

    expect(getConversationSidebar).toHaveBeenLastCalledWith(expect.objectContaining({
      search: "body needle",
      full_text: true,
    }));
  });
});
