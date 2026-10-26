import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createMigratedDb } from "./helpers/ledger-fixtures.js";
import { testRuntimeRoot } from "./helpers/runtime-isolation.js";
import { systemAction } from "../src/identity/resolver.js";
import { setSetting } from "../src/client-auth/settings-kv.js";
import { createUser } from "../src/users/store.js";
import { withRequestOrigin } from "../src/request-origin.js";
import { publishBriefingRun, parseBriefingRunRequest, readBriefing, updateBriefingTitle } from "../src/feedback/briefings.js";
import { mutateLedgerRecord } from "../src/ledger/mutation-history.js";
import { mutateWorkUnit } from "../src/work-unit-history.js";
import { appendAuthLifecycleEvent, listAuthLifecycleEvents } from "../src/auth-lifecycle.js";
import { listAuthRequestActions } from "../src/auth-actions.js";
import { AuthQueue } from "../src/auth-queue.js";
import { AUTH_COMMAND_REVIEW } from "./helpers/auth-queue-fixtures.js";
import type { Db } from "../src/db.js";

const codex = { provider: "codex", provider_session_id: "origin-codex" };
const claude = { provider: "claude", provider_session_id: "origin-claude" };
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function fixture() {
  const db = createMigratedDb({ operator: { slug: "fixture-operator" } });
  cleanups.push(() => db.close());
  const root = fs.mkdtempSync(path.join(testRuntimeRoot, "specialized-origin-"));
  cleanups.push(() => { fs.rmSync(root, { recursive: true, force: true }); });
  setSetting(db, "artifact_root", root);
  const publisher = createUser(db, { slug: "publisher", display_name: "Publisher", kind: "agent" });
  const human = createUser(db, { slug: "reviewer", display_name: "Reviewer", kind: "human" });
  return { db, publisher, human };
}
function runRequest(human: string, key: string) {
  return parseBriefingRunRequest({ schema: "mandible-briefing-run@1", briefing_key: key,
    title: "Report", task_identity: "daily-report", run_id: key, run_key: key,
    responder_user_ids: [human], evidence: { series_ref: "artifact-series:evidence", version: 1, digest: "a".repeat(64) },
    source_health: { source: "fixture", status: "healthy", detail: null, observed_at: 1 },
    document: { markdown: "# Report\n\n:::spec-item{key=\"review\" type=\"verdict\" required=\"true\"}\nReview\n:::\n" }, quiet_reason: null, occurrences: [] });
}
function origins(db: Db, entity: string, id: string) {
  return db.prepare("SELECT payload_json FROM ledger_events WHERE entity_type=? AND entity_id=? ORDER BY rowid")
    .all(entity, id).map((row: { payload_json: string }) => JSON.parse(row.payload_json).request_origin);
}

it("retains separate concurrent publication origins, immutable version origin and later edits", async () => {
  const { db, publisher, human } = fixture();
  const [a, b] = await Promise.all([
    withRequestOrigin(codex, async () => { await Promise.resolve(); return publishBriefingRun(db, runRequest(human.id, "a"), publisher.id); }),
    withRequestOrigin(claude, async () => { await Promise.resolve(); return publishBriefingRun(db, runRequest(human.id, "b"), publisher.id); }),
  ]);
  for (const [receipt, origin] of [[a, codex], [b, claude]] as const) {
    const detail = readBriefing(db, receipt.briefing_id, { actorUserId: human.id, operator: true })!;
    expect(detail.briefing).toMatchObject({ request_origin: origin });
    expect(detail.rounds[0]).toMatchObject({ request_origin: origin });
    const metadata = db.prepare("SELECT metadata_json FROM artifact_version WHERE id=?").get(receipt.artifact_version_id) as { metadata_json: string };
    expect(JSON.parse(metadata.metadata_json).request_origin).toEqual(origin);
  }
  withRequestOrigin(claude, () => updateBriefingTitle(db, a.briefing_id, "Renamed", { userId: human.id, operator: true }));
  withRequestOrigin(null, () => updateBriefingTitle(db, a.briefing_id, "Human edit", { userId: human.id, operator: true }));
  expect(origins(db, "briefing", a.briefing_id)).toEqual([claude, null]);
  const original = db.prepare("SELECT request_origin_json FROM briefings WHERE id=?").get(a.briefing_id) as { request_origin_json: string };
  expect(JSON.parse(original.request_origin_json)).toEqual(codex);
});

it("rolls specialized state and provenance back together and suppresses unchanged writes", () => {
  const { db } = fixture();
  db.exec("CREATE TABLE authored_fixture(id TEXT PRIMARY KEY, body TEXT); INSERT INTO authored_fixture VALUES ('one','before')");
  const snapshot = () => db.prepare("SELECT * FROM authored_fixture WHERE id='one'").get() as Record<string, unknown>;
  expect(() => withRequestOrigin(codex, () => db.transaction(() => {
    mutateLedgerRecord(db, { entity_type: "fixture", entity_id: "one", snapshot }, () => db.exec("UPDATE authored_fixture SET body='after'"));
    throw new Error("rollback");
  })())).toThrow("rollback");
  expect(snapshot().body).toBe("before");
  expect(origins(db, "fixture", "one")).toEqual([]);
  db.exec("BEGIN IMMEDIATE");
  expect(() => mutateLedgerRecord(db, { entity_type: "fixture", entity_id: "one", snapshot },
    () => db.exec("UPDATE authored_fixture SET body='raw outer transaction'"))).toThrow("managed outer SQLite transaction");
  db.exec("COMMIT");
  expect(snapshot().body).toBe("before");
  expect(origins(db, "fixture", "one")).toEqual([]);
  mutateLedgerRecord(db, { entity_type: "fixture", entity_id: "one", snapshot }, () => db.exec("UPDATE authored_fixture SET body='before'"));
  expect(origins(db, "fixture", "one")).toEqual([]);
  withRequestOrigin(codex, () => mutateWorkUnit(db, "unit", () => db.prepare("INSERT INTO work_units(id,issue_id,repo_id,state,kind,created_at) VALUES ('unit','unlinked','fixture','open','solo',1)").run()));
  withRequestOrigin(claude, () => mutateWorkUnit(db, "unit", () => db.prepare("UPDATE work_units SET state='committed' WHERE id='unit'").run()));
  expect(origins(db, "work_unit", "unit")).toEqual([codex, claude]);
  expect(db.prepare("SELECT worker_provider_session_id FROM work_units WHERE id='unit'").get()).toEqual({ worker_provider_session_id: null });
});

it("keeps queued initiating origins durable while recording the system executor independently", async () => {
  const { db } = fixture();
  const queue = new AuthQueue({ db, backgroundMaintenance: false });
  cleanups.push(() => queue.dispose());
  const request = await withRequestOrigin(codex, () => queue.submit({ ...AUTH_COMMAND_REVIEW,
    type: "commit", command: "true", title: "Origin fixture", execution_mode: "remote" }));
  const actor = systemAction();
  withRequestOrigin(claude, () => appendAuthLifecycleEvent(db, { requestId: request.id,
    eventType: "revised", priorStatus: "pending", nextStatus: "pending", occurredAt: 2,
    actor: { user_id: actor.user_id, evidence_method: "system_internal", authority_path: "system" } }));
  const event = listAuthLifecycleEvents(db, request.id).at(-1)!;
  expect(event).toMatchObject({ request_origin: codex, actor_user_id: actor.user_id, authority_path: "system" });
  expect(event.request_origin).not.toEqual(claude);
  expect(listAuthRequestActions(db, request.id)).toEqual([]);
});

it("records the original actor when an authorized mutation retires that actor", () => {
  const { db, publisher } = fixture();
  const input = { entity_type: "user", entity_id: publisher.id,
    attribution: { user_id: publisher.id, evidence_method: "api_token" },
    snapshot: () => db.prepare("SELECT id,status FROM users WHERE id=?").get(publisher.id) as Record<string, unknown> };
  withRequestOrigin(codex, () => mutateLedgerRecord(db, input, () => db.prepare("UPDATE users SET status='retired' WHERE id=?").run(publisher.id)));
  expect(db.prepare("SELECT actor_user_id,evidence_method FROM ledger_events WHERE entity_type='user' AND event_type='user.updated' AND entity_id=?").get(publisher.id))
    .toEqual({ actor_user_id: publisher.id, evidence_method: "api_token" });
  expect(() => mutateLedgerRecord(db, input, () => db.prepare("UPDATE users SET status='active' WHERE id=?").run(publisher.id))).toThrow("not active");
  expect(input.snapshot().status).toBe("retired");
});
