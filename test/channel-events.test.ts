import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { setDb } from '../src/db.js';
import { AuthQueue } from '../src/auth-queue.js';
import { DOMAIN_EVENTS, parseDomainEvent } from '../src/contracts.js';
import { Router } from '../src/server.js';
import { registerChannelRoutes } from '../src/routes/channel.js';
import { broadcast, SseManager, setSseManager } from '../src/sse.js';
import { createMigratedDb, AUTH_COMMAND_REVIEW } from './helpers/auth-queue-fixtures.js';

const context = { session_id: 'owner', conversation_id: 'conversation', cwd: '/tmp', parent_pid: process.pid, app: 'claude' };
type Rendered = { notifications: Array<{ method: string; params: { content?: string; data?: string; meta?: Record<string, string> } }>; delivered: string[] };

describe('auth channel event boundary', () => {
  it('ignores the real startup reload frame delivered to an auth-only subscriber', async () => {
    const db = createMigratedDb();
    setDb(db);
    const startup = vi.spyOn(process, 'uptime').mockReturnValue(1);
    const manager = new SseManager();
    const frames: string[] = [];
    const req = new EventEmitter();
    const res = Object.assign(new EventEmitter(), { writableLength: 0, writeHead() {}, write(frame: string) { frames.push(frame); return true; }, destroy() {} });
    const router = new Router();
    registerChannelRoutes(router);
    try {
      manager.setStartupCommit({ hash: 'startup-commit', summary: 'Startup', date: '2026-11-01' });
      manager.addClient(req as IncomingMessage, res as unknown as ServerResponse, ['auth:resolved']);
      const emitted = frames.filter(frame => frame.startsWith('data:')).map(frame => JSON.parse(frame.slice(5)));
      expect(emitted).toHaveLength(1);
      expect(emitted[0].type).toBe(DOMAIN_EVENTS.DAEMON_RELOADED);
      const response = await router.invoke({ method: 'POST', url: '/api/channel/render', body: { ...context, event: emitted[0] } });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ notifications: [], delivered: [] });
      const malformed = await router.invoke({ method: 'POST', url: '/api/channel/render', body: {
        ...context, event: { type: DOMAIN_EVENTS.HEARTBEAT, data: { timestamp: 'invalid' } },
      } });
      expect(malformed.status).toBe(400);
    } finally {
      manager.closeAll();
      startup.mockRestore();
      db.close();
    }
  });

  it('renders a real queue resolution over SSE only for its owner and rejects malformed notification input', async () => {
    const db = createMigratedDb();
    const manager = new SseManager();
    setSseManager(manager);
    const frames: string[] = [];
    const req = new EventEmitter();
    const res = Object.assign(new EventEmitter(), { writableLength: 0, writeHead() {}, write(frame: string) { frames.push(frame); return true; }, destroy() {} });
    manager.addClient(req as IncomingMessage, res as unknown as ServerResponse, ['auth:resolved']);
    const queue = new AuthQueue({ db, broadcast, allowExternalEffects: false });
    const router = new Router();
    registerChannelRoutes(router);
    const render = (event: unknown, overrides = {}) => router.invoke({ method: 'POST', url: '/api/channel/render', body: { ...context, ...overrides, event } });
    try {
      db.prepare("INSERT INTO sessions (id, app, cwd, status) VALUES ('owner', 'claude', '/tmp', 'active')").run();
      const request = await queue.submit({ ...AUTH_COMMAND_REVIEW, type: 'commit', command: 'echo unused', title: 'Review channel delivery', target_session_id: 'owner', conversation_id: 'conversation' });
      await queue.reject(request.id, 'Operator declined this change');
      const emitted = frames.filter(frame => frame.startsWith('data:')).map(frame => JSON.parse(frame.slice(5)));
      const catalog = await router.invoke({ method: 'POST', url: '/api/channel/catalog', body: context });
      expect(catalog.status).toBe(200);
      expect(emitted.map(event => event.type)).toEqual((catalog.body as { event_topics: string[] }).event_topics);
      expect(emitted).toHaveLength(1);
      const event = emitted[0];
      expect(parseDomainEvent(event).ok).toBe(true);
      const response = await render(event);
      expect(response.status).toBe(200);
      const result = response.body as Rendered;
      expect(result.delivered).toEqual([request.id]);
      expect(result.notifications).toHaveLength(1);
      expect(result.notifications[0]).toMatchObject({ method: 'notifications/claude/channel', params: { meta: { request_id: request.id, status: 'rejected', outcome: 'rejected', title: request.title } } });
      expect(result.notifications[0].params.content).toContain('Operator declined this change');

      const resumed = (await render(event, { session_id: 'resumed' })).body as Rendered;
      expect(resumed.delivered).toEqual([]);
      expect(resumed.notifications).toMatchObject([{ method: 'notifications/message' }]);
      const other = (await render(event, { session_id: 'other', conversation_id: 'unrelated' })).body as Rendered;
      expect(other).toEqual({ notifications: [], delivered: [] });
      const unscoped = (await render({ ...event, data: { ...event.data, target_session_id: null } })).body as Rendered;
      expect(unscoped.delivered).toEqual([]);
      expect(unscoped.notifications).toMatchObject([{ method: 'notifications/message' }]);
      const unidentified = (await render(event, { session_id: null, conversation_id: null })).body as Rendered;
      expect(unidentified.delivered).toEqual([]);
      expect(unidentified.notifications).toMatchObject([{ method: 'notifications/message' }]);

      const malformed = { type: DOMAIN_EVENTS.AUTH_RESOLVED, data: { ...event.data, status: 'pending', outcome: null } };
      const frameCount = frames.length;
      expect(() => manager.broadcast({ ...malformed, timestamp: '' } as never)).toThrow();
      expect(frames).toHaveLength(frameCount);
      const rejected = await render(malformed);
      expect(rejected.status).toBe(400);
      expect(rejected.body).not.toHaveProperty('notifications');
      expect(rejected.body).not.toHaveProperty('delivered');
      for (const type of ['auth:completed', 'inbox:updated', 'work_unit:assigned', 'work_unit:updated', 'console:inbox:badge']) {
        expect((await render({ ...event, type })).status).toBe(400);
      }
    } finally {
      await queue.dispose();
      manager.closeAll();
      setSseManager(null);
      db.close();
    }
  });
});

it('validates auth resolution semantics independently of the production outcome classifier', () => {
  const data = { request_id: 'request-fixture', status: 'completed', outcome: 'succeeded', exit_code: 0,
    failure_reason: null, error: null, error_output: null, resolved_at: 1, title: 'Review', head_branch: null,
    target_session_id: 'owner', conversation_id: 'conversation' };
  const valid = [data,
    { ...data, status: 'failed', outcome: 'failed', exit_code: 42 },
    { ...data, status: 'needs_rebase', outcome: 'needs_rebase', exit_code: null },
    { ...data, exit_code: null, resolved_at: null },
  ];
  for (const payload of valid) expect(parseDomainEvent({ type: DOMAIN_EVENTS.AUTH_RESOLVED, data: payload }).ok).toBe(true);
  const invalid = [null, {}, { ...data, request_id: '' }, { ...data, status: 'invented' },
    ...['pending', 'approved', 'executing'].map(status => ({ ...data, status, outcome: null })),
    { ...data, status: 'failed', outcome: 'succeeded', exit_code: 42 },
    { ...data, status: 'rejected', outcome: null },
    { ...data, exit_code: 42 },
    { ...data, status: 'failed', outcome: 'failed', exit_code: 0 },
    { ...data, target_session_id: 42 }, { ...data, exit_code: 'failed' }, { ...data, error_output: [] },
  ];
  for (const payload of invalid) expect(parseDomainEvent({ type: DOMAIN_EVENTS.AUTH_RESOLVED, data: payload }).ok).toBe(false);
});
