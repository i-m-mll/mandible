import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openDb, setDb, migrate, type Db } from '../../src/db.js';
import { ConversationSpawnService } from '../../src/conversation-spawn/service.js';
import { ConversationControlStore } from '../../src/conversation-control/store.js';
import { reconcileConversationIdentities, resolveConversationId } from '../../src/conversations/identity.js';
import { resolveExactConversation } from '../../src/conversations/freshness.js';
import { triggerTargetedIngest, ingestBatchForWorker } from '../../src/ingestion.js';
import { registerConversationRoutes } from '../../src/routes/conversations.js';
import { Router } from '../../src/server.js';

let root: string;
let db: Db;
const shellId = '10000000-0000-4000-8000-000000000001';
const nativeId = '11111111-1111-4111-8111-111111111111';
let transcript: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mandible-chat-identity-'));
  db = openDb(path.join(root, 'test.db'));
  setDb(db);
  transcript = path.join(root, '.claude', 'projects', '-tmp-project', `${nativeId}.jsonl`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, `${JSON.stringify({ uuid: 'u1', type: 'user', sessionId: nativeId,
    timestamp: '2026-10-06T00:00:00Z', cwd: '/tmp/project', message: { role: 'user', content: 'Testing identity' } })}\n`);
});
afterEach(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });

function shell() {
  const service = new ConversationSpawnService(db);
  expect(service.reserve({ schema: 'mandible-conversation-spawn-request@3', provider: 'claude_code',
    idempotency_key: shellId, placement: { kind: 'projectless' } }).ok).toBe(true);
  expect(service.begin(shellId).ok).toBe(true);
  expect(service.assignRuntime(shellId, 1, 'creation-controller').ok).toBe(true);
  expect(service.materializeConversationShell(shellId, 1, '/tmp/project', nativeId).ok).toBe(true);
  expect(service.ready(shellId, 1, 'creation-controller', null, {}).ok).toBe(true);
}

it('ingests into the creation identity even when the historical spawn native field is missing and excludes sidechains', async () => {
  shell();
  await triggerTargetedIngest({ transcriptPath: transcript, now: 1000 });
  expect(db.prepare('SELECT id, title FROM conversations WHERE is_sidechain = 0').all())
    .toEqual([{ id: shellId, title: 'Testing identity' }]);
  const child = path.join(path.dirname(transcript), nativeId, 'subagents', 'agent-child.jsonl');
  fs.mkdirSync(path.dirname(child), { recursive: true });
  fs.writeFileSync(child, `${JSON.stringify({ uuid: 'child-u1', type: 'user', sessionId: nativeId,
    isSidechain: true, timestamp: '2026-10-06T00:00:01Z', message: { role: 'user', content: 'Child task' } })}\n`);
  await triggerTargetedIngest({ transcriptPath: child, now: 2000 });
  await ingestBatchForWorker([transcript], true);
  expect(db.prepare('SELECT id FROM conversations WHERE is_sidechain = 0').all()).toEqual([{ id: shellId }]);
  expect(db.prepare('SELECT id, parent_conversation_id FROM conversations WHERE is_sidechain = 1').get())
    .toMatchObject({ id: expect.not.stringMatching(shellId), parent_conversation_id: shellId });
});

it('repairs an exact historical pair without rekeying transcript material and preserves old routes, pins and newer settings', async () => {
  await triggerTargetedIngest({ transcriptPath: transcript, now: 1000 });
  const canonical = db.prepare('SELECT id FROM conversations').get() as { id: string };
  const material = db.prepare('SELECT id, current_version_id FROM conversation_sources').all();
  shell();
  db.prepare("UPDATE conversations SET starred = 1, tags = '[\"keep\"]', notes = 'Shell note' WHERE id = ?").run(shellId);
  const controls = new ConversationControlStore(db);
  expect(controls.adoptNewController(shellId, 1, 'claude-agent-sdk-v1', 'old-controller', nativeId).ok).toBe(true);
  expect(controls.release(shellId, 1).ok).toBe(true);
  const journal = db.prepare('SELECT * FROM conversation_control_journal').all();
  db.prepare(`INSERT INTO conversation_control_outbox
    (id, conversation_id, generation, turn_id, operation, message, idempotency_key, state, created_at, updated_at)
    VALUES ('delivery', ?, 1, 'turn', 'send', 'Preserve me', 'request', 'delivered', 100, 200)`).run(shellId);
  db.prepare("UPDATE conversations SET tags = '[\"transcript\"]', notes = 'Transcript note' WHERE id = ?").run(canonical.id);
  db.prepare("INSERT INTO conversation_runtime_settings VALUES (?, 1, '{\"model\":\"older\"}', 100)").run(canonical.id);
  db.prepare("INSERT INTO conversation_runtime_settings VALUES (?, 2, '{\"model\":\"newer\"}', 200)").run(shellId);
  migrate(db);
  expect(resolveConversationId(db, shellId)).toBe(canonical.id);
  expect(resolveExactConversation(db, nativeId).canonicalCandidates).toEqual([canonical.id]);
  expect(reconcileConversationIdentities(db)).toBe(0);
  expect(db.prepare('SELECT id, current_version_id FROM conversation_sources').all()).toEqual(material);
  expect(db.prepare('SELECT * FROM conversation_control_journal').all()).toEqual(journal);
  expect(db.prepare('SELECT conversation_id, message, state FROM conversation_control_outbox').get())
    .toEqual({ conversation_id: canonical.id, message: 'Preserve me', state: 'delivered' });
  expect(db.prepare('SELECT starred, tags, notes FROM conversations WHERE id = ?').get(canonical.id))
    .toEqual({ starred: 1, tags: '["transcript","keep"]', notes: 'Transcript note\n\nShell note' });
  expect(db.prepare('SELECT options_json FROM conversation_runtime_settings WHERE conversation_id = ?').get(canonical.id))
    .toEqual({ options_json: '{"model":"newer"}' });
  const proof = JSON.parse((db.prepare('SELECT proof_json FROM conversation_identity_aliases').get() as { proof_json: string }).proof_json);
  expect(proof.shell.id).toBe(shellId);
  expect(proof.collisions.find((row: { table: string }) => row.table === 'conversation_runtime_settings').rows).toHaveLength(2);
  expect(() => db.prepare('DELETE FROM conversation_identity_aliases').run()).toThrow('immutable');
  const router = new Router();
  registerConversationRoutes(router);
  const oldRoute = await router.invoke({ method: 'GET', url: `/api/conversations/${shellId}` });
  expect(oldRoute.body).toMatchObject({ conversation: { id: canonical.id, starred: true }, total: 1 });
  const pins = await router.invoke({ method: 'GET', url: `/api/conversations/sidebar?pinned_ids=${shellId}&exclude_subagents=true` });
  expect(JSON.stringify(pins.body)).toContain(canonical.id);
  const list = await router.invoke({ method: 'GET', url: '/api/conversations?exclude_subagents=true' });
  expect(list.body).toMatchObject({ total: 1 });
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});

it('fails atomically when both proven identities have independently active controllers', async () => {
  await triggerTargetedIngest({ transcriptPath: transcript, now: 1000 });
  const canonical = db.prepare('SELECT id FROM conversations').get() as { id: string };
  shell();
  const controls = new ConversationControlStore(db);
  expect(controls.adoptNewController(shellId, 1, 'claude-agent-sdk-v1', 'controller-a', nativeId).ok).toBe(true);
  expect(controls.adoptNewController(canonical.id, 1, 'claude-agent-sdk-v1', 'controller-b', nativeId).ok).toBe(true);
  expect(() => reconcileConversationIdentities(db)).toThrow('Conflicting active controllers');
  expect(db.prepare('SELECT COUNT(*) AS count FROM conversation_identity_aliases').get()).toEqual({ count: 0 });
  expect(db.prepare('SELECT COUNT(*) AS count FROM conversation_control_state').get()).toEqual({ count: 2 });
});
