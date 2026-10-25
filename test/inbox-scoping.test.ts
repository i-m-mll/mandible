/**
 * Scoped auth-result delivery (Bug: 4e32923): the inbox tiers (owner, project
 * after its grace window, global after its grace window), the channel-server
 * filter that delivers only to the owning session, the undelivered route and
 * startup catch-up, the server-evidence checks on auth merge submission, and
 * acknowledgement attribution.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import SqliteDatabase from "../src/sqlite.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { AuthAutoApproveManager } from "../src/auth-auto-approve.js";
import { AuthQueue } from "../src/auth-queue.js";
import { setDb } from "../src/db.js";
import { registerAuthRoutes } from "../src/routes/auth.js";
import { registerInboxRoutes } from "../src/routes/inbox.js";
import type { RequestLike, ResponseLike, RouteHandler, RouteRegistrar } from "../src/server.js";
import { addBinding, addCredential, createUser, setupOperator } from "../src/users/store.js";
import { PRODUCTION_EFFECTS } from "../src/security/effect-policy.js";
import { createLedgerIssue, createLedgerProject, migratedMemoryDb } from "./helpers/ledger-fixtures.js";
import { MERGE_CHANGE_MESSAGE } from "./helpers/auth-delivery-fixtures.js";
import { queryPlan, recordStatements } from "./helpers/statement-recorder.js";

// --- DB helpers ---------------------------------------------------------

let testRequesterUserId = "";
let testRequesterCredentialId = "";

function setupInMemoryDb(): InstanceType<typeof SqliteDatabase> {
  const db = migratedMemoryDb() as unknown as InstanceType<typeof SqliteDatabase>;
  testRequesterUserId = setupOperator(db, {
    slug: "inbox-auth-test",
    display_name: "Inbox Auth Test",
  }).id;
  testRequesterCredentialId = addCredential(db, testRequesterUserId, {
    type: "api_token",
    fingerprint: `inbox-auth-test-${Math.random()}`,
  }).id;
  setDb(db);
  return db;
}

interface AuthRowSeed {
  id: string;
  target_session_id: string | null;
  target_repo_root: string | null;
  delivered_at?: number | null;
  resolved_at: number;
  status?: string;
  exit_code?: number;
  head_branch?: string | null;
  title?: string;
}

function seedAuthRow(db: InstanceType<typeof SqliteDatabase>, seed: AuthRowSeed): void {
  db.prepare(
    `INSERT INTO auth_requests (
      id, session_id, type, command, title, cwd,
      status, created_at, updated_at, expires_at,
      target_session_id, target_repo_root, delivered_at,
      resolved_at, exit_code, head_branch, output, files_changed, additions, deletions
    ) VALUES (
      @id, NULL, 'merge', 'mandible auth merge x', @title, NULL,
      @status, @resolved_at, @resolved_at, @resolved_at,
      @target_session_id, @target_repo_root, @delivered_at,
      @resolved_at, @exit_code, @head_branch, '', 0, 0, 0
    )`
  ).run({
    id: seed.id,
    title: seed.title ?? `Merge ${seed.id}`,
    status: seed.status ?? "completed",
    resolved_at: seed.resolved_at,
    target_session_id: seed.target_session_id,
    target_repo_root: seed.target_repo_root,
    delivered_at: seed.delivered_at ?? null,
    exit_code: seed.exit_code ?? 0,
    head_branch: seed.head_branch ?? null
  });
}

function registerWorkRepo(db: InstanceType<typeof SqliteDatabase>, repoRoot: string): void {
  setDb(db);
  const root = realpathSync(repoRoot);
  const project = createLedgerProject(db, root, {
    name: path.basename(root),
    workRepoId: path.basename(root),
    defaultBranch: "main",
  });
  db.prepare(
    `INSERT OR REPLACE INTO work_repos (id, root, name, default_branch, dir_exists, excluded)
     VALUES (@id, @root, @name, @default_branch, 1, 0)`,
  ).run({
    id: path.basename(root),
    root,
    name: path.basename(root),
    default_branch: "main",
  });
  const issue = createLedgerIssue(db, {
    project_id: project.project.id,
    title: "Inbox auth delivery fixture",
    alias: "abc1234",
  });
  const insertWorkUnit = db.prepare(
    `INSERT INTO work_units
      (id, issue_id, repo_id, branch, kind, state, created_at, activated_at, last_commit_at,
       ledger_issue_id, owner_user_id, owner_credential_id, custody_generation)
     VALUES (?, 'abc1234', ?, ?, 'solo', 'committed', 1, 1, 1, ?, ?, ?, 1)`,
  );
  for (const branch of ["feature/mandible-issue", "feature/large-diff"]) {
    insertWorkUnit.run(`wu-${branch}`, project.project.id, branch, issue.id,
      testRequesterUserId, testRequesterCredentialId);
  }
}

function createAuthMergeFixtureRepo(tempDir: string): string {
  const repoRoot = path.join(tempDir, "repo");
  execFileSync("git", ["init", "-b", "main", repoRoot], { stdio: "ignore" });
  const git = (...args: string[]) => execFileSync(
    "git",
    [
      "-C",
      repoRoot,
      "-c",
      "user.name=Mandible Test",
      "-c",
      "user.email=test@example.invalid",
      ...args,
    ],
    { stdio: "ignore" },
  );
  writeFileSync(path.join(repoRoot, "README.md"), "base\n");
  git("add", "README.md");
  git("commit", "-m", "init");
  git("checkout", "-b", "feature/mandible-issue");
  writeFileSync(path.join(repoRoot, "README.md"), "base\nfeature\n");
  git("add", "README.md");
  git("commit", "-m", "typed trailer\n\nMandible-Issue: abc1234");
  git("checkout", "main");
  return repoRoot;
}

function seedSession(db: InstanceType<typeof SqliteDatabase>, id: string, cwd: string): void {
  db.prepare("INSERT INTO sessions (id, app, cwd, status) VALUES (?, ?, ?, ?)").run(
    id,
    "codex",
    cwd,
    "ended",
  );
}

function setGraceSetting(db: InstanceType<typeof SqliteDatabase>, key: string, days: number): void {
  db.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, String(days), Date.now());
}

// --- Tier query tests ---------------------------------------------------

describe("inbox tier query (auth_results)", () => {
  let db: InstanceType<typeof SqliteDatabase>;

  beforeEach(() => {
    db = setupInMemoryDb();
  });

  afterEach(() => {
    db.close();
  });

  it("tier 2: same-project sibling sees the result after project grace window", async () => {
    seedSession(db, "owner", "/repo/A");
    seedSession(db, "sibling", "/repo/A");
    setGraceSetting(db, "inbox.project_grace_days", 1);
    setGraceSetting(db, "inbox.global_grace_days", 30);
    const now = Date.now();
    seedAuthRow(db, {
      id: "r2",
      target_session_id: "owner",
      target_repo_root: "/repo/A",
      resolved_at: now - 2 * 86_400_000   // 2 days ago, > project grace
    });
    seedAuthRow(db, {
      id: "r2-fresh",
      target_session_id: "owner",
      target_repo_root: "/repo/A",
      resolved_at: now - 60_000           // 1 minute ago, well inside grace
    });

    const inbox = await import("../src/routes/inbox.js");
    const result = callInbox(inbox.registerInboxRoutes, db, { session_id: "sibling" });
    // sibling sees only the aged-out row; the fresh one belongs to the owner only.
    expect(result.auth_results.map((r: { id: string }) => r.id)).toEqual(["r2"]);
    expect(result.auth_results[0].tier).toBe(2);
  });

  it("tier 3: cross-project session sees the result after global grace window", async () => {
    seedSession(db, "owner", "/repo/A");
    seedSession(db, "outsider", "/repo/B");
    setGraceSetting(db, "inbox.project_grace_days", 7);
    setGraceSetting(db, "inbox.global_grace_days", 1);
    const now = Date.now();
    seedAuthRow(db, {
      id: "r3",
      target_session_id: "owner",
      target_repo_root: "/repo/A",
      resolved_at: now - 2 * 86_400_000   // 2 days ago, > global grace
    });
    seedAuthRow(db, {
      id: "r3-fresh",
      target_session_id: "owner",
      target_repo_root: "/repo/A",
      resolved_at: now - 60_000           // still inside global grace
    });

    const inbox = await import("../src/routes/inbox.js");
    const result = callInbox(inbox.registerInboxRoutes, db, { session_id: "outsider" });
    expect(result.auth_results.map((r: { id: string }) => r.id)).toEqual(["r3"]);
    expect(result.auth_results[0].tier).toBe(3);
  });

  it("delivered_at = NOT NULL removes the row from any tier", async () => {
    seedSession(db, "owner", "/repo/A");
    const now = Date.now();
    seedAuthRow(db, {
      id: "delivered",
      target_session_id: "owner",
      target_repo_root: "/repo/A",
      resolved_at: now - 60_000,
      delivered_at: now - 30_000
    });

    const inbox = await import("../src/routes/inbox.js");
    const result = callInbox(inbox.registerInboxRoutes, db, { session_id: "owner" });
    expect(result.auth_results).toHaveLength(0);
  });

});

// --- Delivered endpoint tests -------------------------------------------

// --- Channel-server filter tests ----------------------------------------

interface ChannelEventCapture {
  content: string;
  meta?: Record<string, string>;
}

describe("channel-server auth:resolved filter (Bug: 4e32923)", () => {
  async function getDispatch() {
    return (await import("../channel-server/notifications.js")).dispatchEvent;
  }

  it("delivers auth events via the channel-event sender when target_session_id matches", async () => {
    const dispatchEvent = await getDispatch();
    const notes: Array<{ category: string }> = [];
    const channelEvents: ChannelEventCapture[] = [];
    const delivered: string[] = [];
    dispatchEvent(
      { type: "auth:resolved", data: { request_id: "r-match", target_session_id: "session-A", status: "completed", head_branch: "feature/x", title: "Merge feature/x" }, timestamp: "" },
      "session-A",
      (category, _message) => notes.push({ category }),
      (payload) => channelEvents.push(payload),
      (id) => delivered.push(id),
    );
    // Auth events should NOT use the passive logging path.
    expect(notes).toHaveLength(0);
    expect(channelEvents).toHaveLength(1);
    expect(channelEvents[0].content).toContain("Mandible auth request completed");
    expect(channelEvents[0].content).toContain("feature/x");
    expect(channelEvents[0].meta).toMatchObject({
      source: "mandible",
      event_type: "auth:resolved",
      request_id: "r-match",
      status: "completed",
      head_branch: "feature/x",
      title: "Merge feature/x",
    });
    expect(delivered).toEqual(["r-match"]);
  });

  it("drops events when target_session_id is a different session", async () => {
    const dispatchEvent = await getDispatch();
    const notes: Array<{ category: string }> = [];
    const channelEvents: ChannelEventCapture[] = [];
    const delivered: string[] = [];
    dispatchEvent(
      { type: "auth:resolved", data: { request_id: "r-other", target_session_id: "session-B", status: "completed" }, timestamp: "" },
      "session-A",
      (category, _message) => notes.push({ category }),
      (payload) => channelEvents.push(payload),
      (id) => delivered.push(id),
    );
    expect(notes).toHaveLength(0);
    expect(channelEvents).toHaveLength(0);
    expect(delivered).toHaveLength(0);
  });

  it("legacy (null target_session_id) events use passive logging, not channel delivery (Bug: 210ffa1)", async () => {
    const dispatchEvent = await getDispatch();
    const notes: Array<{ category: string }> = [];
    const channelEvents: ChannelEventCapture[] = [];
    const delivered: string[] = [];
    dispatchEvent(
      { type: "auth:resolved", data: { request_id: "r-legacy", target_session_id: null, status: "completed" }, timestamp: "" },
      "session-A",
      (category, _message) => notes.push({ category }),
      (payload) => channelEvents.push(payload),
      (id) => delivered.push(id),
    );
    // Bug: 210ffa1 — unscoped events downgraded to passive log (no agent wake-up).
    expect(notes).toHaveLength(1);
    expect(notes[0].category).toBe("auth_resolved");
    expect(channelEvents).toHaveLength(0);
    expect(delivered).toHaveLength(0); // legacy rows aren't owned, so no delivery watermark
  });

  // Bug: 66865dd — conversation_id match downgrades to passive log (refines 6d7411b)
  it("uses passive log (not channel event) when conversation_id matches but target_session_id mismatches", async () => {
    const dispatchEvent = await getDispatch();
    const notes: Array<{ category: string; message: string }> = [];
    const channelEvents: ChannelEventCapture[] = [];
    const delivered: string[] = [];
    dispatchEvent(
      { type: "auth:resolved", data: { request_id: "r-conv", target_session_id: "old-session", conversation_id: "conv-123", status: "completed", head_branch: "feature/z", title: "Merge feature/z" }, timestamp: "" },
      "new-session",  // different from target_session_id
      (category, message) => notes.push({ category, message }),
      (payload) => channelEvents.push(payload),
      (id) => delivered.push(id),
      "conv-123",  // matches conversation_id in event
    );
    // Bug: 66865dd — conversation_id match uses passive log, NOT channel event
    expect(channelEvents).toHaveLength(0);
    expect(delivered).toHaveLength(0);  // no markDelivered — leave in inbox for original session
    expect(notes).toHaveLength(1);
    expect(notes[0].category).toBe("auth_resolved");
    expect(notes[0].message).toContain("feature/z");
    expect(notes[0].message).toContain("completed");
    expect(notes[0].message).toContain("Merge feature/z");
  });

  // Bug: 929c6d0 — error_output in channel events

});

// --- Undelivered endpoint + startup catch-up tests ----------------------

describe("GET /api/inbox/undelivered (Bug: 4e32923)", () => {
  let db: InstanceType<typeof SqliteDatabase>;
  let registerInboxRoutes: typeof import("../src/routes/inbox.js")["registerInboxRoutes"];

  beforeEach(async () => {
    db = setupInMemoryDb();
    registerInboxRoutes = (await import("../src/routes/inbox.js")).registerInboxRoutes;
  });

  afterEach(() => {
    db.close();
  });

  function callUndelivered(query: Record<string, string>): {
    status: number;
    body: { undelivered: Array<{ id: string; target_session_id: string | null }> } | { error: string };
  } {
    let handler: ((req: unknown, res: unknown) => void) | undefined;
    const server = {
      get: (path: string, h: (req: unknown, res: unknown) => void) => {
        if (path === "/api/inbox/undelivered") handler = h;
      },
      post: () => {},
    };
    registerInboxRoutes(server, undefined, undefined);
    if (!handler) throw new Error("/api/inbox/undelivered handler not registered");
    let capturedStatus = 0;
    let capturedBody: unknown = null;
    handler({ query }, {
      status: (code: number) => { capturedStatus = code; },
      json: (body: unknown) => { capturedBody = body; },
    });
    return { status: capturedStatus, body: capturedBody as { undelivered: Array<{ id: string; target_session_id: string | null }> } | { error: string } };
  }

  it("returns undelivered rows owned by target_session_id, ordered oldest first", () => {
    seedSession(db, "owner", "/repo/A");
    const now = Date.now();
    seedAuthRow(db, {
      id: "r-new",
      target_session_id: "owner",
      target_repo_root: "/repo/A",
      resolved_at: now - 30_000,
    });
    seedAuthRow(db, {
      id: "r-old",
      target_session_id: "owner",
      target_repo_root: "/repo/A",
      resolved_at: now - 60_000,
    });
    const { status, body } = callUndelivered({ target_session_id: "owner" });
    expect(status).toBe(200);
    const rows = (body as { undelivered: Array<{ id: string }> }).undelivered;
    // ORDER BY resolved_at ASC ⇒ oldest first
    expect(rows.map((r) => r.id)).toEqual(["r-old", "r-new"]);
  });

  it("excludes legacy unscoped rows even when they share the project", () => {
    seedSession(db, "owner", "/repo/A");
    const now = Date.now();
    seedAuthRow(db, {
      id: "r-legacy",
      target_session_id: null,
      target_repo_root: null,
      resolved_at: now - 30_000,
    });
    const { body } = callUndelivered({ target_session_id: "owner" });
    expect((body as { undelivered: Array<unknown> }).undelivered).toEqual([]);
  });

  // Bug: 6d7411b — conversation_id matching in undelivered endpoint
  it("returns rows matching conversation_id even when target_session_id differs", () => {
    seedSession(db, "new-session", "/repo/A");
    const now = Date.now();
    // Auth request submitted under old session, with conversation_id
    seedAuthRow(db, {
      id: "r-conv-match",
      target_session_id: "old-session",
      target_repo_root: "/repo/A",
      resolved_at: now - 30_000,
    });
    // Set conversation_id on the auth request
    db.prepare("UPDATE auth_requests SET conversation_id = ? WHERE id = ?")
      .run("conv-persistent", "r-conv-match");

    const { status, body } = callUndelivered({
      target_session_id: "new-session",
      conversation_id: "conv-persistent",
    });
    expect(status).toBe(200);
    const rows = (body as { undelivered: Array<{ id: string }> }).undelivered;
    expect(rows.map((r) => r.id)).toEqual(["r-conv-match"]);
  });

});

describe("channel-server startup catch-up (Bug: 4e32923)", () => {
  it("fetches undelivered rows, sends channel events, and marks each delivered", async () => {
    const mod = await import("../channel-server/index.js");
    const sent: Array<{ method?: string; params?: unknown }> = [];
    const delivered: string[] = [];
    const mockServer = {
      notification: async (notif: { method?: string; params?: unknown }) => {
        sent.push(notif);
      },
    } as unknown as Parameters<typeof mod.runStartupCatchUp>[0]["mcpServer"];

    await mod.runStartupCatchUp({
      sessionId: "session-A",
      mcpServer: mockServer,
      fetchUndelivered: async (id) => {
        expect(id).toBe("session-A");
        return [
          {
            id: "r1",
            head_branch: "feature/x",
            status: "completed",
            exit_code: 0,
            resolved_at: 1,
            title: "Merge feature/x",
            target_session_id: "session-A",
          },
          {
            id: "r2",
            head_branch: "feature/y",
            status: "rejected",
            exit_code: 1,
            resolved_at: 2,
            title: "Merge feature/y",
            target_session_id: "session-A",
          },
        ];
      },
      markDelivered: async (id) => {
        delivered.push(id);
      },
      log: () => {},
    });

    expect(sent.map((n) => n.method)).toEqual([
      "notifications/claude/channel",
      "notifications/claude/channel",
    ]);
    expect(delivered).toEqual(["r1", "r2"]);
    // The first channel event should encode the branch and status.
    const firstParams = sent[0].params as { content: string; meta: Record<string, string> };
    expect(firstParams.content).toContain("feature/x");
    expect(firstParams.meta.status).toBe("completed");
  });

  // Bug: 6d7411b — startup catch-up passes conversation_id to fetchUndelivered

  it("continues replaying when a single markDelivered call fails", async () => {
    const mod = await import("../channel-server/index.js");
    const sent: unknown[] = [];
    const delivered: string[] = [];
    const logs: string[] = [];
    const mockServer = {
      notification: async (notif: unknown) => {
        sent.push(notif);
      },
    } as unknown as Parameters<typeof mod.runStartupCatchUp>[0]["mcpServer"];

    await mod.runStartupCatchUp({
      sessionId: "session-A",
      mcpServer: mockServer,
      fetchUndelivered: async () => [
        {
          id: "r1",
          head_branch: null,
          status: "completed",
          exit_code: 0,
          resolved_at: 1,
          title: null,
          target_session_id: "session-A",
        },
        {
          id: "r2",
          head_branch: null,
          status: "completed",
          exit_code: 0,
          resolved_at: 2,
          title: null,
          target_session_id: "session-A",
        },
      ],
      markDelivered: async (id) => {
        if (id === "r1") throw new Error("transient");
        delivered.push(id);
      },
      log: (line) => logs.push(line),
    });
    // Both events were sent regardless.
    expect(sent).toHaveLength(2);
    // Only r2 marked delivered (r1 raised); r1 will resurface next start.
    expect(delivered).toEqual(["r2"]);
    expect(logs.join("")).toContain("r1");
  });
});

// --- CLI submission payload test ----------------------------------------

describe("auth route accepts target_session_id / target_repo_root from CLI", () => {


  it("rejects raw auth merge submissions without cwd or target repo context", async () => {
    const db = setupInMemoryDb();
    const queue = new AuthQueue({ db });
    const app = new TestRouteRegistrar();
    registerAuthRoutes(app, queue, new AuthAutoApproveManager({ db }));

    const response = await app.invoke("POST", "/api/auth/request", {
      body: {
        command: "mandible auth merge feature/no-context --into main",
        title: "Null cwd request",
        cwd: null,
        base_branch: "main",
        head_branch: "feature/no-context",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(String((response.body as { error?: string }).error)).toContain(
      "require target_repo_root, repo, or cwd"
    );
    db.close();
  });

  it("rejects auth merge submissions from unregistered sandbox cwd paths", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "mandible-auth-sandbox-"));
    try {
      const db = setupInMemoryDb();
      const queue = new AuthQueue({ db });
      const app = new TestRouteRegistrar();
      registerAuthRoutes(app, queue, new AuthAutoApproveManager({ db }));

      const response = await app.invoke("POST", "/api/auth/request", {
        body: {
          command: "mandible auth merge feature/sandbox --into main",
          title: "Sandbox cwd request",
          cwd: tempDir,
          base_branch: "main",
          head_branch: "feature/sandbox",
        },
      });

      expect(response.statusCode).toBe(400);
      expect(String((response.body as { error?: string }).error)).toContain(
        "Invalid or unregistered 'cwd'"
      );
      db.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("replaces client-provided auth merge review metadata with server evidence", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "mandible-auth-metadata-explicit-"));
    try {
      const repoRoot = createAuthMergeFixtureRepo(tempDir);
      const db = setupInMemoryDb();
      const queue = new AuthQueue({ db });
      registerWorkRepo(db, repoRoot);
      const app = new TestRouteRegistrar();
      registerAuthRoutes(app, queue, new AuthAutoApproveManager({ db }));

      const response = await app.invoke("POST", "/api/auth/request", {
        body: {
          command: "mandible auth merge feature/mandible-issue --into main",
          title: "Explicit metadata request",
          target_repo_root: repoRoot,
          base_branch: "main",
          head_branch: "feature/mandible-issue",
          issue_references: ["abc1234"],
          files_changed: 9,
          additions: 8,
          deletions: 7,
          diff_summary: "client diff",
        },
      });

      expect(response.statusCode).toBe(201);
      const requestId = (response.body as { request_id: string }).request_id;
      const request = (await queue.getRequest(requestId));
      expect(request?.files_changed).toBe(1);
      expect(request?.additions).toBe(1);
      expect(request?.deletions).toBe(0);
      expect(request?.diff_summary).toContain("README.md");
      expect(request?.commit_message).toBe(MERGE_CHANGE_MESSAGE.commit_message);
      db.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects injection-shaped auth merge branch names before git verification", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "mandible-auth-injection-"));
    try {
      const repoRoot = path.join(tempDir, "repo");
      const marker = path.join(tempDir, "injection-ran");
      execFileSync("git", ["init", "-b", "main", repoRoot], { stdio: "ignore" });
      const git = (...args: string[]) => execFileSync(
        "git",
        [
          "-C",
          repoRoot,
          "-c",
          "user.name=Mandible Test",
          "-c",
          "user.email=test@example.invalid",
          ...args,
        ],
        { stdio: "ignore" },
      );
      git("commit", "--allow-empty", "-m", "init");
      git("checkout", "-b", "feature/mandible-issue");
      git("commit", "--allow-empty", "-m", "typed trailer\n\nMandible-Issue: abc1234");
      git("checkout", "main");

      const db = setupInMemoryDb();
      const queue = new AuthQueue({ db });
      registerWorkRepo(db, repoRoot);
      const app = new TestRouteRegistrar();
      registerAuthRoutes(app, queue, new AuthAutoApproveManager({ db }));

      const response = await app.invoke("POST", "/api/auth/request", {
        body: {
          command: "mandible auth merge feature/mandible-issue --into main",
          title: "Injection branch request",
          cwd: repoRoot,
          base_branch: "main",
          head_branch: `feature/mandible-issue; touch ${marker}`,
        },
      });

      expect(response.statusCode).toBe(400);
      expect(String((response.body as { error?: string }).error)).toContain("Invalid 'head_branch'");
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("fails closed when auth merge git verification errors", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "mandible-auth-fail-closed-"));
    try {
      const repoRoot = path.join(tempDir, "repo");
      execFileSync("git", ["init", "-b", "main", repoRoot], { stdio: "ignore" });
      const git = (...args: string[]) => execFileSync(
        "git",
        [
          "-C",
          repoRoot,
          "-c",
          "user.name=Mandible Test",
          "-c",
          "user.email=test@example.invalid",
          ...args,
        ],
        { stdio: "ignore" },
      );
      git("commit", "--allow-empty", "-m", "init");
      git("checkout", "-b", "feature/mandible-issue");
      git("commit", "--allow-empty", "-m", "typed trailer\n\nMandible-Issue: abc1234");

      const db = setupInMemoryDb();
      const queue = new AuthQueue({ db });
      registerWorkRepo(db, repoRoot);
      const app = new TestRouteRegistrar();
      registerAuthRoutes(app, queue, new AuthAutoApproveManager({ db }));

      const response = await app.invoke("POST", "/api/auth/request", {
        body: {
          command: "mandible auth merge feature/mandible-issue --into missing-base",
          title: "Verification error request",
          cwd: repoRoot,
          base_branch: "missing-base",
          head_branch: "feature/mandible-issue",
        },
      });

      expect(response.statusCode).toBe(400);
      expect(String((response.body as { error?: string }).error)).toContain(
        "protected/default branch"
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

});

describe("inbox acknowledgement attribution", () => {
  it("uses a bound user id and preserves an unknown legacy session string", async () => {
    const db = setupInMemoryDb();
    try {
      seedAuthRow(db, { id: "bound-ack", target_session_id: null, target_repo_root: null, resolved_at: 1 });
      seedAuthRow(db, { id: "legacy-ack", target_session_id: null, target_repo_root: null, resolved_at: 2 });
      // A session-bound inbox ack is an agent-session activity: session_claim is
      // deliberately agent-only (issue a64d2de), so the bound owner is an agent,
      // not the human operator.
      const boundAgent = createUser(db, {
        slug: "inbox-bound-agent",
        kind: "agent",
        display_name: "Inbox Bound Agent",
      });
      addBinding(db, boundAgent.slug, {
        binding_type: "provider_session_env",
        value: "bound-ack-session",
      });

      const app = new TestRouteRegistrar();
      registerInboxRoutes(app, {} as never);

      const bound = await app.invoke("POST", "/api/inbox/:type/:id/ack", {
        params: { type: "auth_result", id: "bound-ack" },
        body: { session_id: "bound-ack-session" },
        client_identity: null,
      });
      expect(bound.statusCode).toBe(200);
      expect(db.prepare("SELECT acknowledged_by FROM auth_requests WHERE id = ?").get("bound-ack"))
        .toEqual({ acknowledged_by: boundAgent.id });

      const legacy = await app.invoke("POST", "/api/inbox/:type/:id/ack", {
        params: { type: "auth_result", id: "legacy-ack" },
        body: { session_id: "unbound-legacy-session" },
        client_identity: null,
      });
      expect(legacy.statusCode).toBe(200);
      expect(db.prepare("SELECT acknowledged_by FROM auth_requests WHERE id = ?").get("legacy-ack"))
        .toEqual({ acknowledged_by: "unbound-legacy-session" });

      seedAuthRow(db, { id: "conflict-ack", target_session_id: null, target_repo_root: null, resolved_at: 3 });
      const other = createUser(db, {
        slug: "inbox-conflicting-app",
        kind: "agent",
        display_name: "Inbox Conflicting App",
      });
      addBinding(db, other.slug, { binding_type: "app_name", value: "inbox-conflict-app" });
      db.prepare("INSERT INTO sessions (id, app, status) VALUES (?, ?, 'active')")
        .run("bound-ack-session", "inbox-conflict-app");
      const conflict = await app.invoke("POST", "/api/inbox/:type/:id/ack", {
        params: { type: "auth_result", id: "conflict-ack" },
        body: { session_id: "bound-ack-session" },
        client_identity: null,
      });
      expect(conflict.statusCode).toBe(403);
      expect(db.prepare("SELECT acknowledged_by FROM auth_requests WHERE id = ?").get("conflict-ack"))
        .toEqual({ acknowledged_by: null });
    } finally {
      db.close();
    }
  });
});

// Issue 401f88b — acknowledging rewrites each wide auth request row, so a
// backlog is committed a budgeted slice per event-loop turn.
describe("POST /api/inbox/ack-all", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("acknowledges a backlog across event-loop turns with the same result", async () => {
    const db = setupInMemoryDb();
    try {
      for (let index = 0; index < 20; index += 1) {
        seedAuthRow(db, { id: `resolved-${index}`, target_session_id: null, target_repo_root: null, resolved_at: index + 1 });
      }
      seedAuthRow(db, { id: "still-pending", target_session_id: null, target_repo_root: null, resolved_at: 100, status: "pending" });
      seedAuthRow(db, { id: "acked-earlier", target_session_id: null, target_repo_root: null, resolved_at: 101 });
      db.prepare("UPDATE auth_requests SET acknowledged_by = 'earlier' WHERE id = 'acked-earlier'").run();
      const app = new TestRouteRegistrar();
      registerInboxRoutes(app, {} as never);

      // Every clock read passes a slice's budget, so each commit ends a turn.
      let clock = 0;
      vi.spyOn(performance, "now").mockImplementation(() => (clock += 1_000));
      let finished = false;
      let turnsWhileRunning = 0;
      const countTurn = (): void => {
        if (finished) return;
        turnsWhileRunning += 1;
        setImmediate(countTurn);
      };
      setImmediate(countTurn);
      const { result: response, statements } = await recordStatements(db as never, async () => {
        const result = await app.invoke("POST", "/api/inbox/ack-all");
        finished = true;
        return result;
      });

      expect(response.statusCode).toBe(200);
      expect(turnsWhileRunning).toBeGreaterThanOrEqual(2);
      expect(db.prepare(
        "SELECT id, acknowledged_by FROM auth_requests WHERE id NOT LIKE 'resolved-%' ORDER BY id",
      ).all()).toEqual([
        { id: "acked-earlier", acknowledged_by: "earlier" },
        { id: "still-pending", acknowledged_by: null },
      ]);
      expect(db.prepare(
        "SELECT DISTINCT acknowledged_by FROM auth_requests WHERE id LIKE 'resolved-%'",
      ).all()).toEqual([{ acknowledged_by: testRequesterUserId }]);
      // Finding the backlog reads no auth request beyond the ones it names.
      const authSteps = statements
        .filter((statement) => /\bauth_requests\b/.test(statement.sql))
        .flatMap((statement) => queryPlan(db as never, statement))
        .filter((step) => /\bauth_requests\b/.test(step));
      expect(authSteps.length).toBeGreaterThan(0);
      expect(authSteps.filter((step) =>
        !/USING INDEX (idx_auth_requests_unacknowledged \(status=\?\)|sqlite_autoindex_auth_requests_1 \(id=\?\))$/.test(step)))
        .toEqual([]);
    } finally {
      db.close();
    }
  });
});

class TestRouteRegistrar implements RouteRegistrar {
  private readonly handlers = new Map<string, RouteHandler>();

  get(_path: string, _handler: RouteHandler): void {}

  post(path: string, handler: RouteHandler): void {
    this.handlers.set(`POST ${path}`, handler);
  }

  put(_path: string, _handler: RouteHandler): void {}

  patch(_path: string, _handler: RouteHandler): void {}

  delete(_path: string, _handler: RouteHandler): void {}

  async invoke(
    method: string,
    routePath: string,
    request: {
      body?: unknown;
      params?: Record<string, string>;
      client_identity?: RequestLike["client_identity"];
    } = {}
  ): Promise<TestRouteResponse> {
    const handler = this.handlers.get(`${method} ${routePath}`);
    if (!handler) {
      throw new Error(`missing handler for ${method} ${routePath}`);
    }
    const response = new TestRouteResponse();
    await handler({
      method,
      url: routePath,
      params: request.params ?? {},
      query: {},
      // Issue 4720024 — every merge submission carries a change message.
      body: method === "POST" && routePath === "/api/auth/request"
        ? { ...MERGE_CHANGE_MESSAGE, ...(request.body as Record<string, unknown>) }
        : request.body,
      client_identity: Object.hasOwn(request, "client_identity") ? request.client_identity : {
        user_id: testRequesterUserId,
        slug: "inbox-auth-test",
        method: "api_token",
        credential_id: testRequesterCredentialId,
        source: "in_process",
        effect_ceiling: PRODUCTION_EFFECTS,
      }
    } satisfies RequestLike, response);
    return response;
  }
}

class TestRouteResponse implements ResponseLike {
  statusCode = 200;
  body: unknown;

  status(code: number): ResponseLike {
    this.statusCode = code;
    return this;
  }

  json(payload: unknown): void {
    this.body = payload;
  }
}

// --- Test helpers -------------------------------------------------------

interface MinimalRes {
  status: (code: number) => void;
  json: (body: unknown) => void;
}

function callInbox(
  registerInboxRoutes: (
    server: { get: (path: string, h: (req: unknown, res: unknown) => void) => void;
              post: (path: string, h: (req: unknown, res: unknown) => void) => void; },
    sessionRegistry: unknown,
    sessionManager?: unknown,
    authQueue?: unknown
  ) => void,
  _db: InstanceType<typeof SqliteDatabase>,
  query: Record<string, string>
	): { auth_results: Array<{ id: string; tier: number; action_outcomes?: unknown[] }> } {
  let handler: ((req: unknown, res: unknown) => void) | undefined;
  const server = {
    get: (path: string, h: (req: unknown, res: unknown) => void) => {
      if (path === "/api/inbox") handler = h;
    },
    post: () => {}
  };
  registerInboxRoutes(server, undefined, undefined);
  if (!handler) throw new Error("Inbox route handler was not registered");

  let captured: unknown = null;
  let capturedStatus = 0;
  const res: MinimalRes = {
    status: (code: number) => { capturedStatus = code; },
    json: (body: unknown) => { captured = body; }
  };
  handler({ query }, res);
  if (capturedStatus !== 200) {
    throw new Error(`Inbox returned status ${capturedStatus}: ${JSON.stringify(captured)}`);
  }
  return captured as { auth_results: Array<{ id: string; tier: number }> };
}
