import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SqliteDatabase from "../src/sqlite.js";
import { setDb, type Db } from "../src/db.js";
import { triggerTargetedIngest } from "../src/ingestion.js";
import { Router } from "../src/server.js";
import { registerWorkUnitRoutes } from "../src/routes/work-units.js";
import { addProject } from "../src/ledger/project-registry.js";
import { createLedgerIssue, createMigratedDb } from "./helpers/ledger-fixtures.js";
import { testRuntimeRoot } from "./helpers/runtime-isolation.js";
import { WorkUnitReconciler } from "../src/work-unit-reconciler.js";
import { resolveSessionAlias } from "../src/session-liveness.js";
import { getWorkerAssignments } from "../src/work-unit-worker.js";
import { recoverPendingWorkerAssignments, reconcileWorkerLineageEvidence } from "../src/work-unit-evidence.js";
import { ChildRetentionScheduler, scheduleResolvedWorkerArchive } from "../src/conversations/retention.js";
import { SseManager, setSseManager } from "../src/sse.js";
import { createUser, addCredential } from "../src/users/store.js";
import { PRODUCTION_EFFECTS } from "../src/security/effect-policy.js";

const parent = "01a15eab-0000-7000-8000-000000000001";
const worker = "01a15eab-0000-7000-8000-000000000002";
const replacement = "01a15eab-0000-7000-8000-000000000003";
let db: Db;
let root: string;
let router: Router;
let service: ChildRetentionScheduler | undefined;
let detach: (() => void) | undefined;
let sse: SseManager;
let clock = 1_000_000;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(testRuntimeRoot, "worker-evidence-"));
  db = createMigratedDb({ path: path.join(root, "test.db"), setGlobal: true });
  const project = addProject(db, { project_key: "evidence", display_name: "Evidence" });
  createLedgerIssue(db, { project_id: project.id, alias: "evidence-issue" });
  const agent = createUser(db, { slug: "evidence-agent", kind: "agent", display_name: "Agent" });
  const credential = addCredential(db, agent.id, { type: "api_token", fingerprint: "evidence-agent" });
  router = new Router({ clientAuth: { authenticate: () => ({ user_id: agent.id, slug: agent.slug,
    method: "api_token", source: "in_process", credential_id: credential.id, effect_ceiling: PRODUCTION_EFFECTS }),
    mode: () => "strict", recordUnattributedWrite: () => undefined } });
  registerWorkUnitRoutes(router, {} as never);
  sse = new SseManager(); setSseManager(sse);
});
afterEach(async () => {
  await service?.stop(); service = undefined; detach?.(); detach = undefined;
  setSseManager(null); db.close(); fs.rmSync(root, { recursive: true, force: true }); vi.useRealTimers();
});

function rollout(sessionId: string, role = "worker"): string {
  const file = path.join(root, ".codex", "sessions", `${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = sessionId === parent ? "Plan" : `[mandible child parent=codex:${parent} parent-role=coordinator role=${role}]`;
  const records = [
    { type: "session_meta", timestamp: "2026-10-21T09:00:00Z", payload: { id: sessionId, cwd: root } },
    { type: "response_item", timestamp: "2026-10-21T09:00:01Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } },
    { type: "event_msg", timestamp: "2026-10-21T09:00:02Z", payload: { type: "task_complete", turn_id: "turn" } },
  ];
  fs.writeFileSync(file, records.map(row => JSON.stringify(row)).join("\n") + "\n");
  return file;
}
async function ingest(sessionId: string, role = "worker") {
  clock += 100_000;
  await triggerTargetedIngest({ transcriptPath: rollout(sessionId, role), now: clock });
}
async function claim(branch = "feature/evidence", target = worker): Promise<string> {
  const result = await router.invoke({ credential: "owner", method: "POST", url: "/api/work-units/claim",
    ambient_identity: { provider: "codex", provider_session_id: target },
    body: { issue_id: "evidence-issue", repo_id: "evidence", branch, assigned_session_id: target } });
  expect(result.status).toBe(201); return (result.body as { id: string }).id;
}
async function patch(id: string, body: Record<string, unknown>) {
  const result = await router.invoke({ credential: "owner", method: "PATCH", url: `/api/work-units/${id}`,
    ambient_identity: { provider: "codex", provider_session_id: parent }, body: { expected_generation: unit(id).custody_generation, ...body } });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
}
function unit(id: string): Record<string, unknown> { return db.prepare("SELECT * FROM work_units WHERE id=?").get(id) as Record<string, unknown>; }
function events(id: string) { return db.prepare(`SELECT actor_type, actor_id, payload_json FROM ledger_events
  WHERE entity_type='work_unit' AND entity_id=? AND actor_id='worker-assignment-reconciliation'`).all(id) as { actor_type: string; actor_id: string; payload_json: string }[]; }
function evidence(sessionId = worker) {
  const row = db.prepare("SELECT id FROM conversations WHERE source='codex' AND session_id=?").get(sessionId) as { id: string };
  return [{ source: "codex" as const, sessionId, conversationId: row.id }];
}

it.each([
  ["worker-first", true], ["parent-first", true], ["worker-first", false], ["parent-first", false],
] as const)("converges %s with cleanup=%s after coordinator resolution", async (order, cleanup) => {
  const id = await claim();
  if (cleanup) {
    db.prepare("INSERT INTO sessions(id,app,status,conversation_id) VALUES (?,'codex','ended',?)").run(worker, worker);
    await new WorkUnitReconciler(() => undefined, { resolveSession: (database, alias) => resolveSessionAlias(database, alias) }).reconcile();
    expect(unit(id).assigned_session_id).toBeNull();
  }
  await patch(id, { state: "resolved" });
  const first = order === "worker-first" ? worker : parent;
  await ingest(first);
  expect(unit(id).worker_provider).toBeNull();
  await ingest(first === worker ? parent : worker);
  expect(unit(id)).toMatchObject({ worker_provider: "codex", worker_provider_session_id: worker,
    provider_session_id: parent, assigned_session_id: cleanup ? null : worker, state: "resolved" });
  expect(events(id)).toHaveLength(1);
  expect(events(id)[0].actor_type).toBe("system");
  expect(JSON.parse(events(id)[0].payload_json)).toMatchObject({ assignment_target: { kind: "native", session_id: worker },
    evidence: { provider: "codex", session_id: worker, conversation_id: evidence()[0].conversationId } });
  await ingest(worker); await ingest(parent);
  db.close(); db = new SqliteDatabase(path.join(root, "test.db")); setDb(db);
  expect(recoverPendingWorkerAssignments(db)).toBeNull();
  expect(events(id)).toHaveLength(1);
});

it("ignores stale evidence after reassignment and binds only the replacement target", async () => {
  const id = await claim();
  await patch(id, { assigned_session_id: replacement });
  await ingest(parent); await ingest(worker);
  expect(unit(id).worker_provider).toBeNull(); expect(events(id)).toHaveLength(0);
  await ingest(replacement);
  expect(unit(id).worker_provider_session_id).toBe(replacement);
  expect(events(id)).toHaveLength(1);
});

it("converges an explicit unresolved alias when its retained identity and lineage arrive", async () => {
  const result = await router.invoke({ credential: "owner", method: "POST", url: "/api/work-units/claim",
    ambient_identity: { provider: "codex", provider_session_id: parent },
    body: { issue_id: "evidence-issue", repo_id: "evidence", branch: "feature/alias", assigned_session_id: "registered-worker" } });
  expect(result.status).toBe(201);
  const id = (result.body as { id: string }).id;
  expect(JSON.parse(String(unit(id).assignment_target_json))).toEqual({ kind: "alias", session_id: "registered-worker" });
  db.prepare("INSERT INTO sessions(id,app,status,conversation_id) VALUES ('registered-worker','codex','ended',?)").run(worker);
  await ingest(parent); await ingest(worker);
  expect(unit(id)).toMatchObject({ assigned_session_id: "registered-worker", worker_provider: "codex", worker_provider_session_id: worker });
  expect(events(id)).toHaveLength(1);
});

it("publishes only committed binding changes to the existing retention scheduler", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const id = await claim(); await patch(id, { state: "resolved" });
  await ingest(parent); await ingest(worker);
  service = new ChildRetentionScheduler(db, () => undefined, { effectsAllowed: true });
  service.start();
  db.prepare("UPDATE conversation_retention_state SET trigger=NULL,due_at=NULL").run();
  db.prepare("UPDATE work_units SET worker_provider=NULL,worker_provider_session_id=NULL WHERE id=?").run(id);
  const observed: boolean[] = [];
  detach = sse.observeEvents(event => {
    service?.observe(event);
    if (event.type === "ledger:event:created" && (event.data as Record<string, unknown>).entity_id === id) observed.push(db.inTransaction);
  });
  const count = events(id).length;
  expect(() => db.transaction(() => { reconcileWorkerLineageEvidence(db, evidence()); throw new Error("rollback"); })()).toThrow("rollback");
  expect(unit(id).worker_provider).toBeNull(); expect(events(id)).toHaveLength(count); expect(observed).toEqual([]);
  expect(db.prepare("SELECT trigger FROM conversation_retention_state WHERE conversation_id=?").get(evidence()[0].conversationId)).toEqual({ trigger: null });
  db.transaction(() => { reconcileWorkerLineageEvidence(db, evidence()); expect(observed).toEqual([]); })();
  expect(observed).toEqual([false]);
  expect(db.prepare("SELECT trigger FROM conversation_retention_state WHERE conversation_id=?").get(evidence()[0].conversationId)).toEqual({ trigger: "resolved-worker" });
  reconcileWorkerLineageEvidence(db, evidence()); expect(observed).toEqual([false]);
  expect(scheduleResolvedWorkerArchive(db, "codex", worker)).toBe(true);
});

it("recovers pending targets in bounded indexed batches and preserves archive exclusions", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const first = await claim(); const second = await claim("feature/second");
  await patch(first, { state: "resolved" });
  await ingest(parent); await ingest(worker);
  db.prepare("UPDATE work_units SET worker_provider=NULL,worker_provider_session_id=NULL").run();
  const native = vi.fn(async () => ({ status: "archived" as const }));
  service = new ChildRetentionScheduler(db, () => undefined, { effectsAllowed: true, batchSize: 1, nativeArchive: native });
  detach = sse.observeEvents(event => service?.observe(event)); service.start();
  const bound = () => (db.prepare("SELECT count(*) AS n FROM work_units WHERE worker_provider IS NOT NULL").get() as { n: number }).n;
  expect(bound()).toBe(1);
  await vi.runAllTimersAsync(); expect(bound()).toBe(2);
  expect(getWorkerAssignments(db, { provider: "codex", provider_session_id: worker })).toMatchObject({ complete: false, unresolvedUnitIds: [second] });
  expect(scheduleResolvedWorkerArchive(db, "codex", worker)).toBe(false); expect(native).not.toHaveBeenCalled();
  await patch(second, { state: "resolved" });
  expect(scheduleResolvedWorkerArchive(db, "codex", worker)).toBe(true);
  await service.stop(); service = undefined;
  db.prepare("UPDATE work_units SET worker_provider=NULL,worker_provider_session_id=NULL").run();
  service = new ChildRetentionScheduler(db, () => undefined, { effectsAllowed: false, nativeArchive: native }); service.start();
  expect(bound()).toBe(0); expect(native).not.toHaveBeenCalled();
  expect(db.prepare(`EXPLAIN QUERY PLAN SELECT id FROM work_units WHERE assignment_target_json IS NOT NULL
    AND worker_provider IS NULL AND id>? ORDER BY id LIMIT ?`).all("", 1)).toEqual(expect.arrayContaining([
      expect.objectContaining({ detail: expect.stringContaining("idx_work_units_pending_assignment") })]));
});

it("keeps non-worker and ambiguous provider evidence unbound", async () => {
  const id = await claim(); await ingest(parent); await ingest(worker, "coordinator");
  expect(unit(id).worker_provider).toBeNull();
  await ingest(worker);
  expect(unit(id).worker_provider_session_id).toBe(worker);
  db.prepare(`INSERT INTO conversations(id,source,session_id,source_path,source_hash,source_mtime,started_at)
    VALUES ('duplicate','codex',?,'/duplicate','',1,'2026-10-21')`).run(worker);
  reconcileWorkerLineageEvidence(db, evidence());
  expect(unit(id).worker_provider).toBeNull();
});
