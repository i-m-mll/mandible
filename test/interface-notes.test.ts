// @vitest-environment node
/**
 * Interface notes at the daemon boundary: filing moves notes onto exactly one
 * comment, the comment's body follows its notes, and agents find the issues.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setDb, type Db } from "../src/db.js";
import { INTERFACE_NOTES_PROJECT_SETTING, type FileInterfaceNotesResult, type InterfaceNote } from "../src/interface-notes/contract.js";
import type { LedgerIssueDetailProjection } from "../src/issue-detail-contract.js";
import { inlineLedgerReader } from "../src/ledger-reads/index.js";
import { resolveProjectForCheckout } from "../src/ledger/projects.js";
import { LedgerStore } from "../src/ledger/store.js";
import { registerInterfaceNoteRoutes } from "../src/routes/interface-notes.js";
import { registerIssueRoutes } from "../src/routes/issues.js";
import type { Router } from "../src/server.js";
import type { IssueRepoSummary } from "../src/types.js";
import { createUser, setupOperator } from "../src/users/store.js";
import { authenticatedTestRouter } from "./helpers/authenticated-router.js";
import { migratedMemoryDb, SYSTEM_ACTOR } from "./helpers/ledger-fixtures.js";

let db: Db;
let root: string;
let router: Router;
let projectId: string;
let clock: number;

function register(target: Router): Router {
  const repo = { id: "notes", name: "notes", root, exists: true, default_branch: "main", excluded: false, user_modified: false, last_scanned_at: null };
  registerIssueRoutes(target, { getRepos: () => [repo], getRepoById: () => repo, getBranches: () => [] } as never, undefined, inlineLedgerReader());
  registerInterfaceNoteRoutes(target, db);
  return target;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  clock = 1_800_000_000_000;
  vi.setSystemTime(clock);
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-interface-notes-"));
  db = migratedMemoryDb();
  setDb(db);
  projectId = resolveProjectForCheckout(db, { root, name: "notes", workRepoId: "notes", defaultBranch: "main" }).project.id;
  router = register(authenticatedTestRouter(setupOperator(db, { display_name: "Operator" })));
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const tick = () => vi.setSystemTime(clock += 1_000);

async function call<T = unknown>(method: string, url: string, body?: unknown): Promise<{ status: number; body: T }> {
  const response = await router.invoke({ method, url, body, transport: "http" });
  return response as { status: number; body: T };
}

async function note(id: string, text: string): Promise<InterfaceNote> {
  tick();
  const created = await call<InterfaceNote>("POST", "/api/interface-notes", {
    id, text, pin: { id, comment: text, x: 10, y: 20, timestamp: 1 },
    target: {
      url: `https://app.mandible.localhost/issues/${id}`, element: "button", selector: `main > button.${id}`,
      rect: { x: 1, y: 2, width: 3, height: 4 }, viewport: { width: 800, height: 600 }, revision: `rev-${id}`,
    },
  });
  expect(created.status).toBe(201);
  return created.body;
}

function issue(title: string): string {
  return new LedgerStore(db).createIssue({ ...SYSTEM_ACTOR, project_id: projectId, title, body: "Body", kind: "bug" }).id;
}

async function file(noteIds: string[], destination: unknown) {
  tick();
  return call<FileInterfaceNotesResult & { error?: string }>("POST", "/api/interface-notes/file", { note_ids: noteIds, destination });
}

async function detail(issueId: string): Promise<LedgerIssueDetailProjection> {
  return (await call<LedgerIssueDetailProjection>("GET", `/api/ledger/issues/${issueId}`)).body;
}

it("files each listed unfiled note onto one comment exactly once", async () => {
  await note("a", "Tighten the gap");
  await note("b", "Wrong colour");
  await note("c", "Missing tooltip");
  expect((await file(["a"], { new_issue: { title: "Interface" } })).body).toEqual({ error: "receiving_project_unset" });
  db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, 1)").run(INTERFACE_NOTES_PROJECT_SETTING, "notes");

  const agent = register(authenticatedTestRouter(createUser(db, { slug: "notes-agent", kind: "agent", display_name: "Agent" })));
  const refused = await agent.invoke({ method: "POST", url: "/api/interface-notes/file", transport: "http",
    body: { note_ids: ["a"], destination: { new_issue: { title: "Interface" } } } });
  expect(refused.status).toBe(403);

  const first = await file(["b", "a"], { new_issue: { title: "Interface polish" } });
  expect(first.status).toBe(201);
  expect(first.body.filed).toEqual(["a", "b"]);
  const created = await detail(first.body.issue_id);
  expect(created).toMatchObject({ title: "Interface polish", body: "", kind: "unknown" });
  expect(created.comments).toHaveLength(1);
  const [comment] = created.comments;
  expect(comment.notes.map((n) => n.id)).toEqual(["a", "b"]);
  expect(comment.body).toMatch(/^Annotation 1: Tighten the gap\nPage URL: https:\/\/app\.mandible\.localhost\/issues\/a\n[\s\S]*Revision: rev-a\n\nAnnotation 2: Wrong colour\n/);
  expect(comment.body).toContain("Location: main > button.b");

  const other = issue("Elsewhere");
  const second = await file(["a", "b", "c"], { issue: other });
  expect(second.body.filed).toEqual(["c"]);
  expect((await file(["a", "c"], { issue: other })).body).toEqual({ error: "nothing_to_file" });
  expect((await call<{ notes: InterfaceNote[] }>("GET", "/api/interface-notes")).body.notes).toEqual([]);
  const owners = db.prepare("SELECT n.id, c.issue_id FROM interface_notes n JOIN ledger_comments c ON c.id = n.comment_id ORDER BY n.id").all();
  expect(owners).toEqual([
    { id: "a", issue_id: first.body.issue_id }, { id: "b", issue_id: first.body.issue_id }, { id: "c", issue_id: other },
  ]);
  expect((await detail(other)).comments.map((c) => c.notes.map((n) => n.id))).toEqual([["c"]]);
});

it("keeps a carrying comment's body generated from its notes", async () => {
  await note("a", "First");
  await note("b", "Second");
  const target = issue("Target");
  const filed = await file(["a", "b"], { issue: target });
  const commentId = filed.body.comment_id;

  const handEdit = await call("PATCH", `/api/ledger/comments/${commentId}`, { body: "Rewritten by hand" });
  expect(handEdit).toMatchObject({ status: 409, body: { error: "comment_body_generated" } });

  tick();
  expect((await call<InterfaceNote>("PATCH", "/api/interface-notes/a", { text: "First, revised" })).body.text).toBe("First, revised");
  const revisions = new LedgerStore(db).listBodyRevisions({ entity_type: "comment_body", entity_id: commentId });
  expect(revisions.map((revision) => revision.reason)).toEqual(["create", "edit"]);
  expect(revisions[1].snapshot_body).toMatch(/^Annotation 1: First, revised\n[\s\S]*\n\nAnnotation 2: Second\n/);

  expect((await call("DELETE", "/api/interface-notes/a")).body).toEqual({ error: "note_filed" });
  expect((await call("DELETE", "/api/interface-notes/a?comment=elsewhere")).body).toEqual({ error: "note_owner_mismatch" });
  expect((await call("DELETE", `/api/interface-notes/a?comment=${commentId}`)).status).toBe(204);
  const remaining = (await detail(target)).comments;
  expect(remaining.map((c) => c.body)).toEqual([expect.stringMatching(/^Annotation 1: Second\n/)]);

  expect((await call("DELETE", `/api/interface-notes/b?comment=${commentId}`)).status).toBe(204);
  expect((await detail(target)).comments).toEqual([]);
  expect(new LedgerStore(db).getComment(commentId).deleted_at).not.toBeNull();
});

it("lists only issues that carry notes, most recently annotated first", async () => {
  const older = issue("Older notes");
  const newer = issue("Newer notes");
  issue("No notes");
  await note("a", "One");
  await note("b", "Two");
  await note("c", "Three");
  await file(["a", "b"], { issue: older });
  await file(["c"], { issue: newer });

  const list = async () => (await call<IssueRepoSummary[]>("GET", "/api/issues?repo=notes&status=open&has_notes=true")).body
    .flatMap((repo) => repo.issues.map((row) => ({ title: row.title, count: row.interface_notes?.count })));
  expect(await list()).toEqual([{ title: "Newer notes", count: 1 }, { title: "Older notes", count: 2 }]);
  tick();
  await call("PATCH", "/api/interface-notes/a", { text: "One, revised" });
  expect(await list()).toEqual([{ title: "Older notes", count: 2 }, { title: "Newer notes", count: 1 }]);
});
