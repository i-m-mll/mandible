// @vitest-environment node
/**
 * Interface notes of apps other than Mandible: unfiled notes are scoped by app,
 * filing for an app creates its issue in the app's project, and the daemon
 * names the app of a loopback dev origin from the checkout its listener runs in.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { setDb, type Db } from "../src/db.js";
import { INTERFACE_NOTES_PROJECT_SETTING, type EmbedIdentity, type FileInterfaceNotesResult, type InterfaceNote } from "../src/interface-notes/contract.js";
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
let machine: { listeners: Map<number, Array<{ pid: number; cwd: string }>>; checkouts: Map<string, { root: string; remote: string }> };

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

async function note(id: string, app?: string): Promise<void> {
  const created = await call("POST", "/api/interface-notes", {
    id, text: `Note ${id}`, pin: { id, comment: `Note ${id}`, x: 1, y: 2 }, ...(app ? { app } : {}),
    target: { url: `http://localhost:3008/${id}`, rect: { x: 0, y: 0, width: 1, height: 1 }, viewport: { width: 800, height: 600 } },
  });
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
  expect((await call("POST", "/api/interface-notes/file", {
    note_ids: ["studio"], destination: { new_issue: { title: "Elsewhere", project: "no-such-project" } },
  })).body).toMatchObject({ error: "receiving_project_unset" });
});

it("names the app of a loopback origin from its listener's checkout, a worktree included, and nothing else", async () => {
  const identity = (origin: string) => call<EmbedIdentity & { error?: string }>("GET", `/api/interface-notes/embed-identity?origin=${encodeURIComponent(origin)}`);
  const worktree = path.join(root, "feedbax-worktrees", "studio-notes");
  machine.checkouts.set(path.join(worktree, "web"), { root: worktree, remote: STUDIO_REMOTE });
  machine.checkouts.set(path.join(root, "unregistered"), { root: path.join(root, "unregistered"), remote: "git@github.com:example/other.git" });
  machine.listeners.set(5173, [{ pid: 11, cwd: path.join(worktree, "web") }, { pid: 12, cwd: path.join(worktree, "web") }]);
  machine.listeners.set(5174, [{ pid: 21, cwd: path.join(root, "unregistered") }]);
  machine.listeners.set(5175, [{ pid: 31, cwd: path.join(worktree, "web") }, { pid: 32, cwd: path.join(root, "unregistered") }]);

  const resolved = await identity("http://localhost:5173");
  expect(resolved.status).toBe(200);
  expect(resolved.body).toMatchObject({ app: "feedbax:web", project: { key: "feedbax" } });
  expect((await identity("http://[::1]:5173")).body).toMatchObject({ app: "feedbax:web" });

  expect(await identity("https://example.com:5173")).toMatchObject({ status: 400, body: { error: "origin_not_loopback" } });
  expect(await identity("http://localhost.example.com:5173")).toMatchObject({ status: 400, body: { error: "origin_not_loopback" } });
  expect(await identity("http://localhost:5174")).toMatchObject({ status: 404, body: { error: "origin_not_registered" } });
  expect(await identity("http://localhost:5175")).toMatchObject({ status: 404, body: { error: "origin_not_registered" } });
  expect(await identity("http://localhost:5176")).toMatchObject({ status: 404, body: { error: "origin_not_registered" } });
});
