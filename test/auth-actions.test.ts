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
