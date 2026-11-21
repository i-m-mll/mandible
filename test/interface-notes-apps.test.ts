// @vitest-environment node
/**
 * Interface notes of apps other than Mandible: unfiled notes are scoped by app,
 * filing for an app creates its issue in the app's project and states where the
 * notes were made, and the daemon names the app of a loopback dev origin from the
 * checkout its listener runs in, for an origin the operator allowed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { setDb, type Db } from "../src/db.js";
import { MIGRATIONS } from "../src/db-migrations.js";
import { INTERFACE_NOTES_PROJECT_SETTING, type EmbedGrant, type EmbedIdentity, type FileInterfaceNotesResult, type InterfaceNote } from "../src/interface-notes/contract.js";
import { EmbedGrants, PENDING_GRANT_TTL_MS } from "../src/interface-notes/embed-grants.js";
import type { EmbedProcessProbe } from "../src/interface-notes/embed-identity.js";
import { inlineLedgerReader } from "../src/ledger-reads/index.js";
import { resolveProjectForCheckout } from "../src/ledger/projects.js";
import { LedgerStore } from "../src/ledger/store.js";
import { registerInterfaceNoteRoutes } from "../src/routes/interface-notes.js";
import { registerIssueRoutes } from "../src/routes/issues.js";
import type { Router } from "../src/server.js";
import type { IssueRepoSummary } from "../src/types.js";
import { setupOperator } from "../src/users/store.js";
import { authenticatedTestRouter } from "./helpers/authenticated-router.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";

const STUDIO_REMOTE = "git@github.com:example/feedbax.git";

let db: Db;
let root: string;
let router: Router;
/** What the machine shows the daemon: listeners by port, and each directory's checkout and remote. */
let machine: { listeners: Map<number, Array<{ pid: number; cwd: string | null }>>; checkouts: Map<string, { root: string; remote: string }> };

const probe: EmbedProcessProbe = {
  listeners: async (port) => (machine.listeners.get(port) ?? []).map((listener) => listener.pid),
  cwd: async (pid) => [...machine.listeners.values()].flat().find((listener) => listener.pid === pid)?.cwd ?? null,
  checkoutRoot: async (directory) => [...machine.checkouts].find(([dir]) => dir === directory)?.[1].root ?? null,
  originRemote: async (checkout) => [...machine.checkouts.values()].find((entry) => entry.root === checkout)?.remote ?? "",
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-notes-apps-"));
  db = migratedMemoryDb();
  setDb(db);
  const mandibleRoot = path.join(root, "mandible");
  const studioRoot = path.join(root, "feedbax");
  resolveProjectForCheckout(db, { root: mandibleRoot, name: "mandible", workRepoId: "mandible", defaultBranch: "main", remoteUrl: "git@github.com:example/mandible.git" });
  resolveProjectForCheckout(db, { root: studioRoot, name: "feedbax", workRepoId: "feedbax", defaultBranch: "main", remoteUrl: STUDIO_REMOTE });
  db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, 1)").run(INTERFACE_NOTES_PROJECT_SETTING, "mandible");
  const repos = [["mandible", mandibleRoot], ["feedbax", studioRoot]].map(([id, repoRoot]) => ({
    id, name: id, root: repoRoot, exists: true, default_branch: "main", excluded: false, user_modified: false, last_scanned_at: null,
  }));
  router = authenticatedTestRouter(setupOperator(db, { display_name: "Operator" }));
  registerIssueRoutes(router, { getRepos: () => repos, getRepoById: (id: string) => repos.find((repo) => repo.id === id), getBranches: () => [] } as never, undefined, inlineLedgerReader());
  registerInterfaceNoteRoutes(router, db, { kind: "local" }, probe);
  machine = { listeners: new Map(), checkouts: new Map() };
});

afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

async function call<T = unknown>(method: string, url: string, body?: unknown): Promise<{ status: number; body: T }> {
  return await router.invoke({ method, url, body, transport: "http" }) as { status: number; body: T };
}

const EMBED_ORIGIN = "http://localhost:5173";

function input(id: string, app?: string, origin?: string, url = `${origin ?? "http://localhost:3008"}/${id}`) {
  return {
    id, text: `Note ${id}`, pin: { id, comment: `Note ${id}`, x: 1, y: 2 }, ...(app ? { app } : {}), ...(origin ? { origin } : {}),
    target: { url, rect: { x: 0, y: 0, width: 1, height: 1 }, viewport: { width: 800, height: 600 } },
  };
}

async function note(id: string, app?: string): Promise<void> {
  const created = await call("POST", "/api/interface-notes", input(id, app, app ? EMBED_ORIGIN : undefined));
  expect(created.status).toBe(201);
}

const unfiled = async (query = "") =>
  (await call<{ notes: InterfaceNote[] }>("GET", `/api/interface-notes${query}`)).body.notes.map((n) => [n.id, n.app]);

it("lists each app's unfiled notes apart, with Mandible's own the default", async () => {
  await note("own");
  await note("studio", "feedbax:web");
  expect(await unfiled()).toEqual([["own", "mandible"]]);
  expect(await unfiled("?app=mandible")).toEqual([["own", "mandible"]]);
  expect(await unfiled(`?app=${encodeURIComponent("feedbax:web")}`)).toEqual([["studio", "feedbax:web"]]);
  expect((await call("GET", "/api/interface-notes?app=Not%20an%20app")).status).toBe(400);
});

it("records where another app's note was made, and refuses a note whose origin does not match its app or page", async () => {
  const refused = async (body: unknown) => (await call<{ error: string }>("POST", "/api/interface-notes", body)).body.error;
  expect(await refused(input("no-origin", "feedbax:web"))).toBe("invalid_note");
  expect(await refused(input("own-with-origin", undefined, EMBED_ORIGIN))).toBe("invalid_note");
  expect(await refused(input("own-key", "mandible", EMBED_ORIGIN))).toBe("invalid_note");
  expect(await refused(input("elsewhere", "feedbax:web", EMBED_ORIGIN, "https://app.mandible.localhost:19420/issues"))).toBe("invalid_note");
  expect(await refused(input("remote", "feedbax:web", "https://example.com", "https://example.com/x"))).toBe("invalid_note");

  await note("studio", "feedbax:web");
  const filed = await call<FileInterfaceNotesResult>("POST", "/api/interface-notes/file", {
    note_ids: ["studio"], destination: { new_issue: { title: "Studio polish", project: "feedbax" } },
  });
  const body = (db.prepare("SELECT body FROM ledger_comments WHERE id = ?").get(filed.body.comment_id) as { body: string }).body;
  // The provenance line opens the note's block, ahead of any text the page wrote.
  expect(body).toContain(`Made on: ${EMBED_ORIGIN} (feedbax:web), not in Mandible\nAnnotation 1: Note studio`);
});

it("files an app's notes onto a new issue of the app's project, where the notes listing finds it", async () => {
  await note("studio", "feedbax:web");
  const filed = await call<FileInterfaceNotesResult>("POST", "/api/interface-notes/file", {
    note_ids: ["studio"], destination: { new_issue: { title: "Studio polish", project: "feedbax" } },
  });
  expect(filed.status).toBe(201);
  const issue = new LedgerStore(db).getIssue(filed.body.issue_id);
  const projectKey = (id: string) => (db.prepare("SELECT project_key FROM ledger_projects WHERE id = ?").get(id) as { project_key: string }).project_key;
  expect(projectKey(issue.project_id)).toBe("feedbax");

  const listed = async (repo: string) => (await call<IssueRepoSummary[]>("GET", `/api/issues?repo=${repo}&status=open&has_notes=true`)).body
    .flatMap((summary) => summary.issues.map((entry) => entry.title));
  expect(await listed("feedbax")).toEqual(["Studio polish"]);
  expect(await listed("mandible")).toEqual([]);
  // The bridge lists by project id, which matches no repo name, root or key.
  const byProject = async (id: string) => (await call<IssueRepoSummary[]>("GET", `/api/issues?project=${id}&status=open&has_notes=true`)).body
    .flatMap((summary) => summary.issues.map((entry) => entry.title));
  expect(await byProject(issue.project_id)).toEqual(["Studio polish"]);
  expect(await byProject("feedbax")).toEqual([]);
  expect((await call("POST", "/api/interface-notes/file", {
    note_ids: ["studio"], destination: { new_issue: { title: "Elsewhere", project: "no-such-project" } },
  })).body).toMatchObject({ error: "receiving_project_unset" });
});

const identity = (origin: string) => call<EmbedIdentity & { error?: string; grant?: EmbedGrant }>("POST", "/api/interface-notes/embed-identity", { origin });
const grantList = async () => (await call<{ grants: EmbedGrant[] }>("GET", "/api/interface-notes/embed-grants")).body.grants;
const projectId = (key: string) => (db.prepare("SELECT id FROM ledger_projects WHERE project_key = ?").get(key) as { id: string }).id;
const allow = (app: string, project = "feedbax") => call("PUT", "/api/interface-notes/embed-grants", { project: projectId(project), app });
const revoke = (app: string, project = "feedbax") =>
  call("DELETE", `/api/interface-notes/embed-grants?project=${encodeURIComponent(projectId(project))}&app=${encodeURIComponent(app)}`);

it("names the app of an allowed loopback origin from its listener's checkout, a worktree included, and nothing else", async () => {
  const worktree = path.join(root, "feedbax-worktrees", "studio-notes");
  const web = path.join(worktree, "web");
  machine.checkouts.set(web, { root: worktree, remote: STUDIO_REMOTE });
  machine.checkouts.set(path.join(root, "unregistered"), { root: path.join(root, "unregistered"), remote: "git@github.com:example/other.git" });
  machine.listeners.set(5173, [{ pid: 11, cwd: web }, { pid: 12, cwd: web }]);
  machine.listeners.set(5174, [{ pid: 21, cwd: path.join(root, "unregistered") }]);
  machine.listeners.set(5175, [{ pid: 31, cwd: web }, { pid: 32, cwd: path.join(root, "unregistered") }]);
  machine.listeners.set(5177, [{ pid: 51, cwd: web }, { pid: 52, cwd: null }]);

  // Unknown until allowed: the app's request is recorded as pending, once however many names the page asks under.
  expect(await identity(EMBED_ORIGIN)).toMatchObject({ status: 403, body: { error: "origin_not_granted", grant: { origin: EMBED_ORIGIN, directory: web, app: "feedbax:web", state: "pending" } } });
  expect((await identity("http://[::1]:5173")).body).toMatchObject({ error: "origin_not_granted" });
  expect((await grantList()).map((grant) => [grant.app, grant.origin, grant.state])).toEqual([["feedbax:web", "http://[::1]:5173", "pending"]]);

  expect((await allow("feedbax:web")).status).toBe(200);
  const resolved = await identity(EMBED_ORIGIN);
  expect(resolved.status).toBe(200);
  expect(resolved.body).toMatchObject({ app: "feedbax:web", project: { key: "feedbax" } });
  expect((await identity("http://[::1]:5173")).status).toBe(200);
  // Another app on the allowed port asks.
  machine.listeners.set(5173, [{ pid: 13, cwd: worktree }]);
  machine.checkouts.set(worktree, { root: worktree, remote: STUDIO_REMOTE });
  expect(await identity(EMBED_ORIGIN)).toMatchObject({ status: 403, body: { grant: { app: "feedbax:.", state: "pending" } } });
  machine.listeners.set(5173, [{ pid: 11, cwd: web }]);
  expect((await identity(EMBED_ORIGIN)).status).toBe(200);
  expect((await revoke("feedbax:web")).status).toBe(204);
  expect((await identity(EMBED_ORIGIN)).status).toBe(403);

  expect(await identity("https://example.com:5173")).toMatchObject({ status: 400, body: { error: "origin_not_loopback" } });
  expect(await identity("http://localhost.example.com:5173")).toMatchObject({ status: 400, body: { error: "origin_not_loopback" } });
  for (const port of [5174, 5175, 5176, 5177]) {
    expect(await identity(`http://localhost:${port}`)).toMatchObject({ status: 404, body: { error: "origin_not_registered" } });
  }
});

it("covers an allowed app's server in every checkout of its project, on any port, and no other project's", async () => {
  const first = path.join(root, "feedbax-worktrees", "one");
  const second = path.join(root, "feedbax-worktrees", "two");
  for (const checkout of [first, second]) machine.checkouts.set(path.join(checkout, "web"), { root: checkout, remote: STUDIO_REMOTE });
  machine.listeners.set(5173, [{ pid: 11, cwd: path.join(first, "web") }]);
  await identity(EMBED_ORIGIN);
  await allow("feedbax:web");
  machine.listeners.set(6006, [{ pid: 12, cwd: path.join(second, "web") }]);
  expect(await identity("http://127.0.0.1:6006")).toMatchObject({ status: 200, body: { app: "feedbax:web" } });
  // No new request; the row shows the latest page served under the grant.
  expect((await grantList()).map((grant) => [grant.app, grant.origin, grant.directory, grant.state]))
    .toEqual([["feedbax:web", "http://127.0.0.1:6006", path.join(second, "web"), "granted"]]);
  // The same path in another project is that project's app.
  const mandibleRoot = path.join(root, "mandible");
  machine.checkouts.set(path.join(mandibleRoot, "web"), { root: mandibleRoot, remote: "git@github.com:example/mandible.git" });
  machine.listeners.set(6006, [{ pid: 13, cwd: path.join(mandibleRoot, "web") }]);
  expect(await identity("http://127.0.0.1:6006")).toMatchObject({ status: 403, body: { grant: { app: "mandible:web", state: "pending" } } });
});

it("never names Mandible's own app for a page, even one served from the root of a Mandible checkout", async () => {
  const mandibleRoot = path.join(root, "mandible");
  machine.checkouts.set(mandibleRoot, { root: mandibleRoot, remote: "git@github.com:example/mandible.git" });
  machine.listeners.set(5180, [{ pid: 61, cwd: mandibleRoot }]);
  const asked = await identity("http://localhost:5180");
  expect(asked.body.grant?.app).toBe("mandible:.");
  await allow("mandible:.", "mandible");
  const granted = await identity("http://localhost:5180");
  expect(granted.body.app).toBe("mandible:.");
  expect(await unfiled(`?app=${encodeURIComponent("mandible:.")}`)).toEqual([]);
});

it("accepts the bridge's writes only while the note's app is granted", async () => {
  const web = path.join(root, "feedbax", "web");
  machine.checkouts.set(web, { root: path.join(root, "feedbax"), remote: STUDIO_REMOTE });
  machine.listeners.set(5173, [{ pid: 11, cwd: web }]);
  await identity(EMBED_ORIGIN);
  await allow("feedbax:web");
  const scoped = (route: string) => `${route}${route.includes("?") ? "&" : "?"}embed_origin=${encodeURIComponent(EMBED_ORIGIN)}`;
  const status = async (method: string, route: string, body?: unknown) => (await call(method, scoped(route), body)).status;

  expect(await status("POST", "/api/interface-notes", input("a", "feedbax:web", EMBED_ORIGIN))).toBe(201);
  expect(await status("POST", "/api/interface-notes", input("b", "feedbax:web", EMBED_ORIGIN))).toBe(201);
  // Another app's notes, or a note claiming another origin than the page's, are refused.
  expect(await status("POST", "/api/interface-notes", input("other", "feedbax:desktop", EMBED_ORIGIN))).toBe(403);
  expect(await status("POST", "/api/interface-notes", input("port", "feedbax:web", "http://localhost:5199"))).toBe(403);
  await note("own");
  expect(await status("PATCH", "/api/interface-notes/own", { text: "Changed" })).toBe(403);
  expect(await status("PATCH", "/api/interface-notes/a", { text: "Changed" })).toBe(200);

  expect((await revoke("feedbax:web")).status).toBe(204);
  // A page still open after the revocation can write nothing more.
  expect(await status("PATCH", "/api/interface-notes/a", { text: "Again" })).toBe(403);
  expect(await status("DELETE", "/api/interface-notes/b")).toBe(403);
  expect(await status("POST", "/api/interface-notes/file", { note_ids: ["a"], destination: { new_issue: { title: "T", project: "feedbax" } } })).toBe(403);
  // Mandible's own interface still manages the notes.
  expect((await call("DELETE", "/api/interface-notes/b")).status).toBe(204);
});

it("keeps an unanswered request for a week, and an allowed app for good", async () => {
  const grants = new EmbedGrants(db, probe);
  const [web, desktop] = ["web", "desktop"].map((name) => path.join(root, "feedbax", name));
  for (const dir of [web, desktop]) machine.checkouts.set(dir, { root: path.join(root, "feedbax"), remote: STUDIO_REMOTE });
  machine.listeners.set(5173, [{ pid: 11, cwd: web }]);
  machine.listeners.set(5174, [{ pid: 12, cwd: desktop }]);
  await grants.access("http://localhost:5173", 0);
  await grants.access("http://localhost:5174", 0);
  grants.allow({ project_id: projectId("feedbax"), app: "feedbax:web" });
  expect(grants.list(PENDING_GRANT_TTL_MS + 1).map((grant) => grant.app)).toEqual(["feedbax:web"]);
});

it("moves grants by origin and directory to one per app, a granted row winning", () => {
  const statements = (version: number) => MIGRATIONS.find((migration) => migration.version === version)!.statements as readonly string[];
  db.exec("DROP TABLE interface_note_embed_grants");
  db.exec(statements(244).find((sql) => sql.includes("CREATE TABLE interface_note_embed_grants"))!);
  const insert = db.prepare("INSERT INTO interface_note_embed_grants (origin, directory, app, project_id, state, requested_at, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const feedbax = projectId("feedbax");
  insert.run("http://localhost:3095", "/w/one/web", "feedbax:web", feedbax, "granted", 1, 2);
  insert.run("http://localhost:4000", "/w/two/web", "feedbax:web", feedbax, "pending", 5, null);
  insert.run("http://localhost:4001", "/w/two/desktop", "feedbax:desktop", feedbax, "pending", 6, null);
  for (const sql of statements(245)) db.exec(sql);
  expect(db.prepare("SELECT app, state, origin, directory, decided_at FROM interface_note_embed_grants ORDER BY app").all()).toEqual([
    { app: "feedbax:desktop", state: "pending", origin: "http://localhost:4001", directory: "/w/two/desktop", decided_at: null },
    { app: "feedbax:web", state: "granted", origin: "http://localhost:3095", directory: "/w/one/web", decided_at: 2 },
  ]);
});
