import { createUser, addCredential } from '../src/users/store';
import { PRODUCTION_EFFECTS } from '../src/security/effect-policy';
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from './helpers/dom';
import { migratedMemoryDb, createLedgerIssue } from './helpers/ledger-fixtures';
import { setDb } from '../src/db';
import { addProject } from '../src/ledger/project-registry';
import { registerSpacesRoutes } from '../src/routes/spaces';
import { registerWorkUnitRoutes } from '../src/routes/work-units';
import { Router } from '../src/server';
import { SseManager, setSseManager } from '../src/sse';
import { SpaceBoardRenderer } from '../ui/src/views/spaces/SpaceBoard';
import { queryClient } from '../ui/src/query/client';
import { invalidateDashboardApiCacheForEvent, type SpaceFactPacket } from '../ui/src/api';
import { LIVE_REFRESH_MIN_INTERVAL_MS } from '../ui/src/lib/coalesced-refresh';
import type { SessionManager } from '../src/session-manager';

afterEach(() => { cleanup(); queryClient.clear(); setSseManager(null); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('moves a real Board card through claim, resolution, and release from the emitted work-unit envelopes', async () => {
  const db = migratedMemoryDb();
  setDb(db);
  try {
    const project = addProject(db, { project_key: 'board', display_name: 'Board' });
    const issue = createLedgerIssue(db, { project_id: project.id, title: 'Work item' });
    const agent = createUser(db, { slug: 'board-owner', kind: 'agent', display_name: 'Owner' });
    const credential = addCredential(db, agent.id, { type: 'api_token', fingerprint: 'board-owner' });
    const router = new Router({ clientAuth: { authenticate: () => ({ user_id: agent.id, slug: agent.slug,
      method: 'api_token', source: 'in_process', credential_id: credential.id, effect_ceiling: PRODUCTION_EFFECTS }),
      mode: () => 'strict', recordUnattributedWrite: () => undefined } });
    const call = (request: Parameters<Router['invoke']>[0]) => router.invoke({ ...request, credential: 'own' });
    registerSpacesRoutes(router);
    registerWorkUnitRoutes(router, {} as SessionManager);
    const space = await call({ method: 'POST', url: '/api/spaces', body: { title: 'Board', project_id: project.id } });
    const spaceId = (space.body as { space: { id: string } }).space.id;
    const added = await call({ method: 'POST', url: `/api/spaces/${spaceId}/items`, body: { ref_type: 'issue', ref_id: issue.id, title: 'Work card' } });
    const itemId = (added.body as { item: { id: string } }).item.id;
    await call({ method: 'POST', url: `/api/spaces/${spaceId}/occurrences`, body: { renderer: 'board', item_id: itemId } });
    const packet = (await call({ method: 'GET', url: `/api/spaces/${spaceId}` })).body as SpaceFactPacket;
    const fetcher = vi.fn(async (url: string) => {
      expect(url.startsWith('/api/spaces/resolve?')).toBe(true);
      const response = await call({ method: 'GET', url });
      return new Response(JSON.stringify(response.body), { status: response.status });
    });
    vi.stubGlobal('fetch', fetcher);
    render(<SpaceBoardRenderer projectId="sidebar-other" spaceId={spaceId} renderer="board" factPacket={packet} />);
    const location = () => screen.getByText('Work card').closest('[data-occurrence-id]')!.getAttribute('data-column-key');
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText('Resolving issue facts…')).toBeNull());
    expect(location()).toBe('worker_status:none');
    const events: Array<{ type: string; data: unknown }> = [];
    const manager = new SseManager();
    setSseManager(manager);
    manager.observeEvents((event) => { events.push(event); invalidateDashboardApiCacheForEvent(event.type, event.data); });
    vi.useFakeTimers();
    const claim = async (branch: string) => {
      const result = await call({ method: 'POST', url: '/api/work-units/claim', body: { issue_id: issue.id, repo_id: project.id, branch } });
      expect(result.status, JSON.stringify(result.body)).toBe(201);
      return result.body as { id: string; custody_generation: number };
    };
    const settle = async () => act(async () => { await vi.advanceTimersByTimeAsync(LIVE_REFRESH_MIN_INTERVAL_MS + 1); });
    const first = await claim('feature/first');
    await settle();
    expect(location()).toBe('worker_status:in_progress');
    const resolved = await call({ method: 'PATCH', url: `/api/work-units/${first.id}`, body: { state: 'resolved', expected_generation: first.custody_generation } });
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    await settle();
    expect(location()).toBe('worker_status:none');
    const second = await claim('feature/second');
    await settle();
    expect(location()).toBe('worker_status:in_progress');
    const released = await call({ method: 'POST', url: '/api/work-units/release', body: { id: second.id, expected_generation: second.custody_generation } });
    expect(released.status, JSON.stringify(released.body)).toBe(200);
    await settle();
    expect(location()).toBe('worker_status:none');
    const envelopes = events.filter((event) => event.type === 'ledger:event:created' && (event.data as { entity_type?: string }).entity_type === 'work_unit');
    expect(envelopes.length).toBeGreaterThanOrEqual(4);
    expect(envelopes.every((event) => !('issue_id' in (event.data as object)))).toBe(true);
    expect(events.some((event) => event.type.startsWith('ledger:issue:'))).toBe(false);
    expect(db.prepare('SELECT worker_status FROM ledger_issues WHERE id = ?').get(issue.id)).toMatchObject({ worker_status: 'none' });
  } finally { db.close(); }
});
