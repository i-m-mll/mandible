// @vitest-environment node
/**
 * A preview copied from the live ledger keeps interface notes in the instance it
 * was copied from: its note routes reach that instance's local socket as the
 * operator, and its toolbar hears that instance's note events.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { PRODUCTION_ORIGIN } from "../src/canonical-origin.js";
import { ClientAuthenticator } from "../src/client-auth/authenticator.js";
import { setDb, type Db } from "../src/db.js";
import type { InterfaceNote, InterfaceNoteChangedPayload } from "../src/interface-notes/contract.js";
import { relaySourceNoteEvents } from "../src/interface-notes/source.js";
import { startLocalApiSocket } from "../src/local-api-socket.js";
import { registerInterfaceNoteRoutes } from "../src/routes/interface-notes.js";
import { PRODUCTION_EFFECTS } from "../src/security/effect-policy.js";
import { createLocalSocketServer, createServer, Router } from "../src/server.js";
import { SseManager, setSseManager } from "../src/sse.js";
import type { InstanceInfo } from "../src/types.js";
import { createUser, getOperator, setupOperator } from "../src/users/store.js";
import { authenticatedTestRouter } from "./helpers/authenticated-router.js";
import { createLedgerIssue, createLedgerProject, migratedFileDb } from "./helpers/ledger-fixtures.js";

let root: string;
let source: Db;
let copy: Db;
let socketPath: string;
let sourceServer: http.Server;
let closeSource: (() => Promise<void>) | null;
let preview: Router;
let stopRelay: () => void;
const events: InterfaceNoteChangedPayload[] = [];

function sourceInstance(): InstanceInfo {
  return { role: "main", instance_id: "production", installation_id: "install-test", public_origin: PRODUCTION_ORIGIN,
    backend_generation: "main-1", allowed_effects: PRODUCTION_EFFECTS, writable_roots: [root], preview_root: null,
    user_preferences_root: path.join(root, "prefs"), db_path: path.join(root, "source.db"), db_path_source: "test",
    source_db_path: null, source_db_path_source: null };
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-notes-source-"));
  source = migratedFileDb(path.join(root, "source.db"));
  setDb(source);
  setupOperator(source, { display_name: "Operator" });
  const sse = new SseManager();
  setSseManager(sse);
  const auth = new ClientAuthenticator(source, { instance: sourceInstance(), secretsDir: path.join(root, "auth"), sessionAuthorityDir: path.join(root, "sessions") });
  const sourceRouter = new Router({ clientAuth: auth, instance: sourceInstance() });
  registerInterfaceNoteRoutes(sourceRouter, source, { kind: "local" });
  const options: Parameters<typeof createServer>[0] = { db: source, sse, logger: () => undefined, version: "test", router: sourceRouter,
    getStartupInfo: () => null, instance: sourceInstance(), clientAuth: auth };
  createServer(options);
  sourceServer = createLocalSocketServer(options);
  socketPath = path.join(root, "private", "production.sock");
  closeSource = await startLocalApiSocket(sourceServer, socketPath);

  copy = migratedFileDb(path.join(root, "copy.db"));
  preview = authenticatedTestRouter(setupOperator(copy, { display_name: "Operator" }));
  registerInterfaceNoteRoutes(preview, copy, { kind: "source", socketPath });
  events.length = 0;
  stopRelay = relaySourceNoteEvents(socketPath, (payload) => events.push(payload), () => undefined);
});

afterEach(async () => {
  stopRelay();
  setSseManager(null);
  await closeSource?.();
  source.close();
  copy.close();
  fs.rmSync(root, { recursive: true, force: true });
});

async function call<T = unknown>(router: Router, method: string, url: string, body?: unknown): Promise<{ status: number; body: T }> {
  return await router.invoke({ method, url, body, transport: "http" }) as { status: number; body: T };
}

function input(id: string, text: string) {
  return {
    id, text, pin: { id, comment: text, x: 10, y: 20 },
    target: { url: `https://preview-0123456789abcdef.mandible.localhost:19421/issues/${id}`, element: "button", selector: "main > button",
      rect: { x: 1, y: 2, width: 3, height: 4 }, viewport: { width: 800, height: 600 }, revision: "preview-build" },
  };
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const sourceNotes = () => source.prepare("SELECT id, text, comment_id FROM interface_notes ORDER BY id").all();
const copyNotes = () => copy.prepare("SELECT id FROM interface_notes").all();

it("writes every note route to the source instance as its operator and nothing to the copy", async () => {
  await until(() => events.length === 1);
  expect(events).toEqual([{ ids: [], issue_id: null }]);

  expect((await call(preview, "POST", "/api/interface-notes", input("a", "Tighten the gap"))).status).toBe(201);
  expect((await call(preview, "POST", "/api/interface-notes", input("b", "Wrong colour"))).status).toBe(201);
  expect((await call(preview, "POST", "/api/interface-notes", input("a", "again"))).body).toEqual({ error: "note_exists" });
  expect((await call(preview, "PATCH", "/api/interface-notes/b", { text: "Wrong border colour" })).status).toBe(200);
  await until(() => events.length === 4);
  expect(events.slice(1).map((event) => event.ids)).toEqual([["a"], ["b"], ["b"]]);

  const listed = await call<{ notes: InterfaceNote[] }>(preview, "GET", "/api/interface-notes");
  expect(listed.body.notes.map((note) => [note.id, note.text, note.target.revision]))
    .toEqual([["a", "Tighten the gap", "preview-build"], ["b", "Wrong border colour", "preview-build"]]);

  const project = createLedgerProject(source, path.join(root, "notes"), { name: "notes", mkdir: true });
  const issue = createLedgerIssue(source, { project_id: project.project.id, title: "Interface", kind: "bug" });
  const filed = await call<{ comment_id: string; filed: string[] }>(preview, "POST", "/api/interface-notes/file", { note_ids: ["a"], destination: { issue: issue.id } });
  expect(filed).toMatchObject({ status: 201, body: { filed: ["a"] } });
  const author = source.prepare("SELECT author_user_id FROM ledger_comments WHERE id = ?").get(filed.body.comment_id) as { author_user_id: string };
  expect(author.author_user_id).toBe(getOperator(source)!.id);
  const onIssue = await call<{ notes: InterfaceNote[] }>(preview, "GET", `/api/interface-notes?issue=${issue.id}`);
  expect(onIssue.body.notes.map((note) => note.id)).toEqual(["a"]);

  expect((await call(preview, "DELETE", "/api/interface-notes/b")).status).toBe(204);
  expect(sourceNotes()).toEqual([{ id: "a", text: "Tighten the gap", comment_id: filed.body.comment_id }]);
  expect(copyNotes()).toEqual([]);
});

it("refuses an agent of the preview before anything reaches the source", async () => {
  const agent = authenticatedTestRouter(createUser(copy, { slug: "preview-agent", kind: "agent", display_name: "Agent" }));
  registerInterfaceNoteRoutes(agent, copy, { kind: "source", socketPath });
  expect((await call(agent, "POST", "/api/interface-notes", input("a", "From an agent"))).status).toBe(403);
  expect((await call(agent, "GET", "/api/interface-notes")).status).toBe(200);
  expect(sourceNotes()).toEqual([]);
});

it("reports an unreachable source so the toolbar keeps the write pending", async () => {
  await closeSource!();
  closeSource = null;
  expect((await call(preview, "POST", "/api/interface-notes", input("a", "Offline"))).body).toMatchObject({ error: "source_unavailable" });
  expect(copyNotes()).toEqual([]);
});
