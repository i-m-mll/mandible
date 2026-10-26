import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setDb, type Db } from "../src/db.js";
import { addSpaceItem, batchWriteOccurrences, createSpace, createSpaceEdge, createSpaceOccurrence,
  deleteSpace, deleteSpaceEdge, deleteSpaceItem, deleteSpaceOccurrence, updateSpace, updateSpaceEdge, updateSpaceItem } from "../src/ledger/spaces.js";
import { createSpaceBlock, deleteSpaceBlock, detachItemFromBlocks, updateSpaceBlock } from "../src/ledger/space-blocks.js";
import { LedgerStore } from "../src/ledger/store.js";
import { withLedgerMutationActor } from "../src/ledger/mutation-history.js";
import { systemAction } from "../src/identity/resolver.js";
import { withRequestOrigin } from "../src/request-origin.js";
import { ClientAuthenticator } from "../src/client-auth/authenticator.js";
import { setupOperator } from "../src/users/store.js";
import { registerSpacesRoutes } from "../src/routes/spaces.js";
import { registerConversationRoutes } from "../src/routes/conversations.js";
import { inlineLedgerReader } from "../src/ledger-reads/index.js";
import { Router } from "../src/server.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";
import { testRuntimeRoot } from "./helpers/runtime-isolation.js";

const codex = { provider: "codex", provider_session_id: "spaces-native-thread" };
const claude = { provider: "claude", provider_session_id: "metadata-native-session" };
let db: Db;
beforeEach(() => { db = migratedMemoryDb(); setDb(db); });
afterEach(() => { vi.restoreAllMocks(); db.close(); });
function history() {
  return (db.prepare("SELECT entity_type,entity_id,event_type,actor_type,actor_user_id,payload_json FROM ledger_events WHERE entity_type IN ('space','space_item','space_occurrence','space_edge','space_block','conversation_metadata') ORDER BY rowid").all() as Array<Record<string, string>>)
    .map(({ payload_json, ...row }) => ({ ...row, payload: JSON.parse(payload_json) }));
}

it("retains origin across authored structure changes and suppresses no-ops, failed writes and outer rollbacks", () => {
  const notifications = vi.spyOn(LedgerStore.prototype, "notifyEvent");
  const space = withRequestOrigin(codex, () => createSpace(db, { title: "Private title" }));
  withRequestOrigin(codex, () => db.transaction(() => {
    const item = addSpaceItem(db, space.id, { ref_type: "issue", ref_id: "opaque-ref", title: "Private item" }).item;
    const a = createSpaceOccurrence(db, space.id, { item_id: item.id, x: 1 });
    const b = createSpaceOccurrence(db, space.id, { x: 2 });
    const edge = createSpaceEdge(db, space.id, { source: a.id, target: b.id });
    const block = createSpaceBlock(db, space.id, { block_type: "reference", item_id: item.id, item_snapshot: { title: "Secret snapshot" } });
    const before = history().length;
    updateSpace(db, space.id, { title: space.title });
    addSpaceItem(db, space.id, { ref_type: "issue", ref_id: "opaque-ref" });
    deleteSpaceBlock(db, space.id, "missing");
    expect(history()).toHaveLength(before);
    expect(notifications).toHaveBeenCalledTimes(1);
    withRequestOrigin(claude, () => {
      updateSpace(db, space.id, { description: "Secret description" });
      updateSpaceItem(db, space.id, item.id, { title: "Revised private item" });
      batchWriteOccurrences(db, space.id, [{ id: a.id, x: 5 }, { id: b.id, x: 7 }]);
      updateSpaceEdge(db, space.id, edge.id, { label: "Secret label" });
      updateSpaceBlock(db, space.id, block.id, { markdown: "Secret body" });
      detachItemFromBlocks(db, space.id, item.id);
    });
    deleteSpaceEdge(db, space.id, edge.id);
    deleteSpaceBlock(db, space.id, block.id);
    deleteSpaceOccurrence(db, space.id, a.id);
    deleteSpaceOccurrence(db, space.id, b.id);
    deleteSpaceItem(db, space.id, item.id);
  })());
  const beforeRollback = history();
  const published = notifications.mock.calls.length;
  expect(() => withRequestOrigin(claude, () => db.transaction(() => {
    createSpaceBlock(db, space.id, { block_type: "paragraph", markdown: "rolled back" });
    throw new Error("abort outer operation");
  })())).toThrow("abort outer operation");
  db.exec("CREATE TRIGGER reject_authored_history BEFORE INSERT ON ledger_events WHEN NEW.entity_type='space_block' BEGIN SELECT RAISE(ABORT,'history unavailable'); END");
  expect(() => createSpaceBlock(db, space.id, { block_type: "paragraph" })).toThrow("history unavailable");
  expect(db.prepare("SELECT id FROM space_blocks").all()).toEqual([]);
  expect(history()).toEqual(beforeRollback);
  expect(notifications).toHaveBeenCalledTimes(published);
  withLedgerMutationActor({ actor_type: "system", attribution: systemAction() }, () => deleteSpace(db, space.id));
  const events = history();
  expect(new Set(events.map(row => row.entity_type))).toEqual(new Set(["space", "space_item", "space_occurrence", "space_edge", "space_block"]));
  expect(events.filter(row => row.event_type.endsWith(".updated")).every(row => JSON.stringify(row.payload.request_origin) === JSON.stringify(claude))).toBe(true);
  expect(events[0].payload.request_origin).toEqual(codex);
  expect(events.at(-1)).toMatchObject({ actor_type: "system", payload: { request_origin: null } });
  expect(JSON.stringify(events)).not.toMatch(/Private|private|Secret|secret|opaque-ref|rolled back/);
  expect(db.prepare("SELECT * FROM ledger_change_log").all()).toEqual([]);
});

it("keeps authenticated authority independent of native origin for Spaces and conversation metadata", async () => {
  const directory = fs.mkdtempSync(path.join(testRuntimeRoot, "authored-origin-"));
  try {
    const clientAuth = new ClientAuthenticator(db, { secretsDir: directory });
    const user = setupOperator(db, { display_name: "Operator" });
    const token = clientAuth.mintApiToken(user.id).token;
    const router = new Router({ clientAuth });
    registerSpacesRoutes(router);
    registerConversationRoutes(router, inlineLedgerReader());
    db.prepare("INSERT INTO ledger_projects(id,display_name,remote_identity,created_at,updated_at) VALUES('authored-project','Fixture','local:authored',1,1)").run();
    const created = await router.invoke({ method: "POST", url: "/api/spaces", credential: token, ambient_identity: codex, body: { title: "Authored", project_id: "authored-project" } });
    expect(created.status).toBe(201);
    const id = (created.body as { space: { id: string } }).space.id;
    await router.invoke({ method: "PATCH", url: `/api/spaces/${id}`, credential: token, ambient_identity: claude, body: { title: "Edited" } });
    db.prepare("INSERT INTO conversations(id,source,source_path,source_hash,source_mtime,title,session_id,started_at,created_at,updated_at) VALUES('conv-origin','codex','/fixture','hash',1,'Provider title','native-fixture','now','now','now')").run();
    const patch = (body: unknown, origin: typeof codex | null = codex) => router.invoke({ method: "PATCH", url: "/api/conversations/conv-origin", credential: token, ...(origin ? { ambient_identity: origin } : {}), body });
    expect((await patch({ tags_add: ["private tag"], notes: "private note", starred: true, archived: true })).status).toBe(200);
    const changed = history().length;
    await patch({ tags_add: ["private tag"], starred: true, archived: true });
    expect(history()).toHaveLength(changed);
    const failed = await patch({ archived: false, tags: "invalid" });
    expect(failed.status).toBe(400);
    expect(history()).toHaveLength(changed);
    expect(db.prepare("SELECT archived_at FROM conversation_archive_states WHERE conversation_id='conv-origin'").get()).toBeTruthy();
    await patch({ tags: [], notes: null, starred: false, archived: false }, claude);
    await router.invoke({ method: "DELETE", url: `/api/spaces/${id}`, credential: token });
    const events = history();
    expect(events.every(row => row.actor_user_id === user.id)).toBe(true);
    expect(db.prepare("SELECT c.project_id,e.event_type FROM ledger_change_log c JOIN ledger_events e ON e.id=c.event_id ORDER BY c.sequence").all()).toEqual([
      {project_id:"authored-project",event_type:"space.created"},
      {project_id:"authored-project",event_type:"space.updated"},
      {project_id:"authored-project",event_type:"space.deleted"},
    ]);
    expect(events.map(row => row.payload.request_origin)).toEqual([codex, claude, codex, claude, null]);
    expect(events.filter(row => row.entity_type === "conversation_metadata").map(row => row.payload.changed_fields.sort()))
      .toEqual([["archived_at", "notes", "starred", "tags"], ["archived_at", "notes", "starred", "tags"]]);
    expect(JSON.stringify(events)).not.toMatch(/private tag|private note|Provider title/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
