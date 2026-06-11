import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AuthQueue, AuthQueueError } from "../src/auth-queue.js";
import { AuthAutoApproveManager } from "../src/auth-auto-approve.js";
import { CURRENT_SCHEMA_VERSION, migrate, type Db } from "../src/db.js";
import { getLedgerIssueHead } from "../src/ledger/issue-heads.js";
import { resolveProjectForCheckout } from "../src/ledger/projects.js";
import { LedgerStore } from "../src/ledger/store.js";
import { registerAuthRoutes } from "../src/routes/auth.js";
import { Router } from "../src/server.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createMigratedDb(): Db {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

function createLedgerIssue(db: Db, alias = "act123") {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-auth-actions-repo-"));
  tempDirs.push(repoRoot);
  const project = resolveProjectForCheckout(db, {
    root: repoRoot,
    name: path.basename(repoRoot),
    defaultBranch: "main",
    remoteUrl: "",
  });
  const issue = new LedgerStore(db).createIssue({
    project_id: project.project.id,
    title: "Auth action target",
    body: "Body",
    kind: "feature",
    priority: "normal",
    actor_type: "agent",
    author_display: "Codex",
    aliases: [{ alias_kind: "git_bug_short", alias }],
  });
  return { repoRoot, issue };
}

describe("auth request action schema", () => {
  it("creates auth_request_actions on fresh databases", () => {
    const db = createMigratedDb();
    try {
      expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get())
        .toMatchObject({ value: String(CURRENT_SCHEMA_VERSION) });
      const columns = (db.prepare("PRAGMA table_info(auth_request_actions)").all() as Array<{ name: string }>)
        .map((row) => row.name);
      expect(columns).toEqual([
        "id",
        "auth_request_id",
        "ordinal",
        "kind",
        "target_issue_ref",
        "payload",
        "state",
        "target_digest",
        "staged_at",
        "updated_at",
        "applied_at",
        "outcome_detail",
      ]);
    } finally {
      db.close();
    }
  });

  it("upgrades an existing v75 database with the staged action table", () => {
    const db = new Database(":memory:");
    try {
      db.exec(`
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO meta (key, value) VALUES ('schema_version', '75');
        CREATE TABLE auth_requests (id TEXT PRIMARY KEY);
      `);
      migrate(db);
      expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get())
        .toMatchObject({ value: String(CURRENT_SCHEMA_VERSION) });
      expect(db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'auth_request_actions'",
      ).get()).toBeTruthy();
    } finally {
      db.close();
    }
  });
});

describe("auth request action execution", () => {
  it("applies staged actions once in ordinal order when a merge succeeds", () => {
    const db = createMigratedDb();
    try {
      const { repoRoot, issue } = createLedgerIssue(db, "exec123");
      let now = 10_000;
      const queue = new AuthQueue({ db, now: () => now });
      const request = queue.submit({
        type: "merge",
        command: "mandible auth merge feature/exec --into main",
        title: "Execute staged actions",
        cwd: repoRoot,
        repo: path.basename(repoRoot),
        actions: [
          { kind: "comment_add", target_issue_ref: issue.short_id, payload: { body: "Closeout comment" } },
          { kind: "label_add", target_issue_ref: issue.short_id, payload: { label: "verified" } },
          { kind: "worker_status_set", target_issue_ref: issue.short_id, payload: { value: "done" } },
          { kind: "checkpoint_add", target_issue_ref: issue.short_id, payload: { kind: "handoff", payload: { ok: true } } },
          { kind: "issue_close", target_issue_ref: issue.short_id, payload: { reason_comment: "Merged cleanly" } },
        ],
      });

      now = 11_000;
      queue.setResult(
        request.id,
        0,
        'MANDIBLE_MERGE_RESULT {"merge_sha":"abc123def456","declared_issues":["exec123"],"auto_close_issues":[]}',
      );

      expect(queue.listActions(request.id).map((action) => action.state)).toEqual([
        "applied",
        "applied",
        "applied",
        "applied",
        "applied",
      ]);
      expect(new LedgerStore(db).getIssue(issue.id)).toMatchObject({
        status: "closed",
        resolution: "merged",
        worker_status: "done",
      });
      expect(
        db.prepare("SELECT label FROM ledger_labels WHERE issue_id = ? AND label = 'verified' AND deleted_at IS NULL")
          .get(issue.id),
      ).toEqual({ label: "verified" });
      expect(
        db.prepare("SELECT body FROM ledger_comments WHERE issue_id = ? ORDER BY ordinal").all(issue.id),
      ).toEqual([{ body: "Closeout comment" }, { body: "Merged cleanly" }]);
      expect(
        db.prepare("SELECT kind FROM ledger_issue_checkpoints WHERE issue_id = ?").get(issue.id),
      ).toEqual({ kind: "handoff" });

      now = 12_000;
      const restarted = new AuthQueue({ db, now: () => now });
      try {
        restarted.getRequest(request.id);
        expect(
          db.prepare("SELECT COUNT(*) AS count FROM ledger_comments WHERE issue_id = ?").get(issue.id),
        ).toEqual({ count: 2 });
        expect(
          db.prepare("SELECT COUNT(*) AS count FROM ledger_issue_checkpoints WHERE issue_id = ?").get(issue.id),
        ).toEqual({ count: 1 });
      } finally {
        restarted.dispose();
      }
    } finally {
      db.close();
    }
  });

  it("records failed actions and continues applying remaining staged actions", () => {
    const db = createMigratedDb();
    try {
      const { repoRoot, issue } = createLedgerIssue(db, "fail123");
      const queue = new AuthQueue({ db, now: () => 20_000 });
      const request = queue.submit({
        type: "merge",
        command: "mandible auth merge feature/fail --into main",
        title: "Failure isolation",
        cwd: repoRoot,
        repo: path.basename(repoRoot),
        actions: [
          { kind: "comment_add", target_issue_ref: "missing123", payload: { body: "Will fail" } },
          { kind: "label_add", target_issue_ref: issue.short_id, payload: { label: "still-applied" } },
          { kind: "comment_add", target_issue_ref: issue.short_id, payload: { body: "Vetoed" } },
        ],
      });
      const actions = queue.listActions(request.id);
      db.prepare("UPDATE auth_request_actions SET state = 'vetoed' WHERE id = ?").run(actions[2].id);

      queue.setResult(request.id, 0, "Merge made by recursive.\n");

      const after = queue.listActions(request.id);
      expect(after.map((action) => action.state)).toEqual(["failed", "applied", "vetoed"]);
      expect(after[0].outcome_detail).toContain("could not be resolved");
      expect(
        db.prepare("SELECT label FROM ledger_labels WHERE issue_id = ? AND label = 'still-applied' AND deleted_at IS NULL")
          .get(issue.id),
      ).toEqual({ label: "still-applied" });
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM ledger_comments WHERE issue_id = ?").get(issue.id),
      ).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it("honors issue_close on_stale skip while default stale actions apply with annotation", () => {
    const db = createMigratedDb();
    try {
      const first = createLedgerIssue(db, "stale1");
      const secondIssue = new LedgerStore(db).createIssue({
        project_id: first.issue.project_id,
        title: "Second stale target",
        body: "Body",
        kind: "feature",
        priority: "normal",
        aliases: [{ alias_kind: "git_bug_short", alias: "stale2" }],
      });
      const queue = new AuthQueue({ db, now: () => 30_000 });
      const request = queue.submit({
        type: "merge",
        command: "mandible auth merge feature/stale --into main",
        title: "Stale action handling",
        cwd: first.repoRoot,
        repo: path.basename(first.repoRoot),
        actions: [
          { kind: "issue_close", target_issue_ref: first.issue.short_id, payload: { on_stale: "skip" } },
          { kind: "issue_close", target_issue_ref: secondIssue.short_id, payload: {} },
        ],
      });

      new LedgerStore(db).addComment(first.issue.id, { body: "Moved", source: "mandible" });
      new LedgerStore(db).addComment(secondIssue.id, { body: "Moved", source: "mandible" });
      queue.setResult(request.id, 0, "Merge made by recursive.\n");

      const actions = queue.listActions(request.id);
      expect(actions[0]).toMatchObject({ state: "skipped_stale", applied_at: null });
      expect(actions[0].outcome_detail).toContain("digest moved");
      expect(actions[1]).toMatchObject({ state: "applied" });
      expect(actions[1].outcome_detail).toContain("digest moved");
      expect(new LedgerStore(db).getIssue(first.issue.id).status).toBe("open");
      expect(new LedgerStore(db).getIssue(secondIssue.id).status).toBe("closed");
    } finally {
      db.close();
    }
  });

  it("preserves legacy issue_closures through the unified close executor", () => {
    const db = createMigratedDb();
    try {
      const { repoRoot, issue } = createLedgerIssue(db, "legacy1");
      const queue = new AuthQueue({ db, now: () => 40_000 });
      const request = queue.submit({
        type: "merge",
        command: "mandible auth merge feature/legacy --into main",
        title: "Legacy close",
        cwd: repoRoot,
        repo: path.basename(repoRoot),
        issue_closures: [issue.short_id],
      });

      queue.setResult(request.id, 0, "Merge made by recursive.\n");

      expect(queue.listActions(request.id)).toEqual([]);
      expect(new LedgerStore(db).getIssue(issue.id)).toMatchObject({
        status: "closed",
        resolution: "merged",
      });
    } finally {
      db.close();
    }
  });

  it("creates resolves operational links for staged issue_close actions", () => {
    const db = createMigratedDb();
    try {
      const { repoRoot, issue } = createLedgerIssue(db, "link123");
      const queue = new AuthQueue({ db, now: () => 50_000 });
      const request = queue.submit({
        command: "echo link",
        title: "Link staged close",
        cwd: repoRoot,
        repo: path.basename(repoRoot),
        actions: [{ kind: "issue_close", target_issue_ref: issue.short_id, payload: {} }],
      });

      expect(
        db.prepare(
          `SELECT link_type, metadata_json
           FROM ledger_auth_issue_links
           WHERE auth_request_id = ? AND issue_id = ?`,
        ).get(request.id, issue.id),
      ).toMatchObject({
        link_type: "resolves",
      });
      const metadata = db.prepare(
        "SELECT metadata_json FROM ledger_auth_issue_links WHERE auth_request_id = ? AND issue_id = ?",
      ).get(request.id, issue.id) as { metadata_json: string };
      expect(JSON.parse(metadata.metadata_json).source_fields).toContain("auth_request_actions");
    } finally {
      db.close();
    }
  });
});

describe("auth request action queue persistence", () => {
  it("submits actions with target digests and edits one row without touching siblings", () => {
    const db = createMigratedDb();
    try {
      const { repoRoot, issue } = createLedgerIssue(db);
      const digest = getLedgerIssueHead(db, issue.id).digest;
      let now = 1000;
      const queue = new AuthQueue({ db, now: () => now });

      const request = queue.submit({
        command: "echo staged",
        title: "Staged actions",
        cwd: repoRoot,
        repo: path.basename(repoRoot),
        actions: [
          { kind: "comment_add", target_issue_ref: issue.short_id, payload: { body: "First" } },
          { kind: "label_add", target_issue_ref: issue.short_id, payload: { label: "ready" } },
          { kind: "checkpoint_add", target_issue_ref: issue.short_id, payload: { kind: "handoff", payload: { ok: true } } },
        ],
      });

      const before = queue.listActions(request.id);
      expect(before).toHaveLength(3);
      expect(before.map((action) => action.ordinal)).toEqual([1, 2, 3]);
      expect(before.map((action) => action.target_digest)).toEqual([digest, digest, digest]);

      now = 2000;
      queue.updateAction(request.id, before[1].id, {
        kind: "label_rm",
        target_issue_ref: issue.short_id,
        payload: { label: "ready" },
      });

      const after = queue.listActions(request.id);
      expect(after[0]).toMatchObject({
        id: before[0].id,
        payload: before[0].payload,
        updated_at: before[0].updated_at,
      });
      expect(after[1]).toMatchObject({
        id: before[1].id,
        kind: "label_rm",
        payload: { label: "ready" },
        updated_at: 2000,
      });
      expect(after[2]).toMatchObject({
        id: before[2].id,
        payload: before[2].payload,
        updated_at: before[2].updated_at,
      });
    } finally {
      db.close();
    }
  });

  it("denies CRUD after a request succeeds", () => {
    const db = createMigratedDb();
    try {
      const queue = new AuthQueue({ db });
      const request = queue.submit({
        command: "echo done",
        title: "Done",
        actions: [{ kind: "issue_close", target_issue_ref: "abc123", payload: {} }],
      });
      queue.setResult(request.id, 0, "ok");

      expect(() => queue.addAction(request.id, {
        kind: "label_add",
        target_issue_ref: "abc123",
        payload: { label: "late" },
      })).toThrow(AuthQueueError);
    } finally {
      db.close();
    }
  });
});

describe("auth request action routes", () => {
  it("supports per-action CRUD on pending requests", async () => {
    const db = createMigratedDb();
    try {
      const router = new Router();
      const queue = new AuthQueue({ db });
      registerAuthRoutes(router, queue, new AuthAutoApproveManager({ db }));

      const submit = await router.invoke({
        method: "POST",
        url: "/api/auth/request",
        body: {
          command: "echo route",
          title: "Route staged actions",
          actions: [{ kind: "comment_add", target_issue_ref: "abc123", payload: { body: "One" } }],
        },
      });
      expect(submit.status).toBe(201);
      const requestId = (submit.body as { request_id: string }).request_id;

      const add = await router.invoke({
        method: "POST",
        url: `/api/auth/request/${requestId}/actions`,
        body: { kind: "label_add", target_issue_ref: "abc123", payload: { label: "ready" } },
      });
      expect(add.status).toBe(201);
      const actionId = (add.body as { action: { id: string } }).action.id;

      const edit = await router.invoke({
        method: "PUT",
        url: `/api/auth/request/${requestId}/actions/${actionId}`,
        body: { kind: "label_rm", target_issue_ref: "abc123", payload: { label: "ready" } },
      });
      expect(edit.status).toBe(200);
      expect((edit.body as { action: { kind: string } }).action.kind).toBe("label_rm");

      const list = await router.invoke({
        method: "GET",
        url: `/api/auth/request/${requestId}/actions`,
      });
      expect(list.status).toBe(200);
      expect((list.body as { actions: unknown[] }).actions).toHaveLength(2);

      const rm = await router.invoke({
        method: "DELETE",
        url: `/api/auth/request/${requestId}/actions/${actionId}`,
        body: {},
      });
      expect(rm.status).toBe(200);
    } finally {
      db.close();
    }
  });

  it("allows pending user veto toggles and denies them after completion", async () => {
    const db = createMigratedDb();
    try {
      const router = new Router();
      const queue = new AuthQueue({ db });
      registerAuthRoutes(router, queue, new AuthAutoApproveManager({ db }));

      const request = queue.submit({
        command: "echo route",
        title: "Route veto",
        actions: [{ kind: "comment_add", target_issue_ref: "abc123", payload: { body: "One" } }],
      });
      const action = queue.listActions(request.id)[0];

      const veto = await router.invoke({
        method: "POST",
        url: `/api/auth/request/${request.id}/actions/${action.id}/veto`,
        body: { vetoed: true },
      });
      expect(veto.status).toBe(200);
      expect((veto.body as { action: { state: string } }).action.state).toBe("vetoed");

      const restore = await router.invoke({
        method: "POST",
        url: `/api/auth/request/${request.id}/actions/${action.id}/veto`,
        body: { vetoed: false },
      });
      expect(restore.status).toBe(200);
      expect((restore.body as { action: { state: string } }).action.state).toBe("staged");

      queue.setResult(request.id, 0, "ok");
      const denied = await router.invoke({
        method: "POST",
        url: `/api/auth/request/${request.id}/actions/${action.id}/veto`,
        body: { vetoed: true },
      });
      expect(denied.status).toBe(409);
      expect(denied.body).toMatchObject({ status: "completed" });
    } finally {
      db.close();
    }
  });

  it("rejects invalid action payloads with a clear client error", async () => {
    const db = createMigratedDb();
    try {
      const router = new Router();
      const queue = new AuthQueue({ db });
      registerAuthRoutes(router, queue, new AuthAutoApproveManager({ db }));

      const response = await router.invoke({
        method: "POST",
        url: "/api/auth/request",
        body: {
          command: "echo bad",
          title: "Bad staged action",
          actions: [{ kind: "label_add", target_issue_ref: "abc123", payload: {} }],
        },
      });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ error: "label is required" });
    } finally {
      db.close();
    }
  });
});
