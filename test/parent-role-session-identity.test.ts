/**
 * Issue 5b2cdbf — `mandible issue parent-role assume` used to accept any
 * non-empty string as a session id, write it down, and report success. Because
 * the holder-liveness check compared `sessions.status` directly, such a holder
 * was immediately judged dead and the next coordinator took the same umbrella
 * with no override: two coordinators owned one umbrella and both were told the
 * lease had worked.
 *
 * These tests pin the boundary that fixes it — the daemon refuses an id it
 * cannot verify, accepts every registered alias form, and records both
 * identities — plus the invariant that must NOT change: the Codex archive path
 * still refuses to archive a live thread.
 */
import SqliteDatabase from "../src/sqlite.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listCompletedWorkerThreadArchiveCandidates } from "../src/codex-thread-archive.js";
import { migrate, setDb, type Db } from "../src/db.js";
import { addProject } from "../src/ledger/project-registry.js";
import { SessionRegistry } from "../src/registry.js";
import { registerIssueRoutes } from "../src/routes/issues.js";
import { registerSessionRoutes } from "../src/routes/sessions.js";
import { Router } from "../src/server.js";
import { isSessionAliasLive, resolveSessionAlias } from "../src/session-liveness.js";
import type { AuthRequest } from "../src/types.js";
import { createUser, setupOperator } from "../src/users/store.js";
import { authenticatedTestRouter } from "./helpers/authenticated-router.js";

const fakeScanner = {
  getRepos: () => [],
  getRepoById: () => undefined,
  getBranches: () => [],
} as never;

const MANDIBLE_SESSION = "sess-coordinator";
const CONSOLE_SESSION = "console-coordinator";
const PROVIDER_THREAD = "01a04e24-a731-7362-bce3-ff7a63a845e2";
const DESKTOP_TASK = "01a072f2-0e05-7a91-abcd-df4dc6a64e62";

let db: Db;
let router: Router;
let umbrellaId: string;

function seedSession(id: string, status: string, app = "codex"): void {
  db.prepare(
    "INSERT INTO sessions (id, app, status, last_active) VALUES (?, ?, ?, ?)",
  ).run(id, app, status, "2026-08-29T00:00:00Z");
}

function seedConsoleSession(options: {
  id: string;
  status: string;
  command?: string;
  mandibleSessionId?: string | null;
  providerSessionId?: string | null;
}): void {
  db.prepare(
    `INSERT INTO console_sessions
       (id, label, command, status, mandible_session_id, provider_session_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, 1)`,
  ).run(
    options.id,
    options.id,
    options.command ?? "codex",
    options.status,
    options.mandibleSessionId ?? null,
    options.providerSessionId ?? null,
  );
}

function seedCodexConversation(sessionId = DESKTOP_TASK): void {
  db.prepare(`
    INSERT INTO conversations (
      id, source, source_path, source_hash, source_mtime, title,
      started_at, session_id, cwd, branch, updated_at
    ) VALUES (?, 'codex', ?, 'sha', 1, 'Desktop task', ?, ?, '/repo/mandible',
              'feature/d25dc46-codex-task-liveness', ?)
  `).run(
    `conversation-${sessionId}`,
    `/tmp/.codex/sessions/2026/09/05/rollout-${sessionId}.jsonl`,
    "2026-09-05T19:00:00Z",
    sessionId,
    "2026-09-05T19:01:00Z",
  );
}

async function assume(sessionId: string, override = false) {
  return router.invoke({
    method: "POST",
    url: `/api/ledger/issues/${umbrellaId}/parent-role`,
    body: { session_id: sessionId, mechanism: "codex", override },
  });
}

async function parentRoleStatus() {
  const response = await router.invoke({
    method: "GET",
    url: `/api/ledger/issues/${umbrellaId}/parent-role`,
  });
  return response.body as {
    holder: Record<string, unknown> | null;
    live_holder: Record<string, unknown> | null;
  };
}

function holderPayload(body: unknown): Record<string, unknown> {
  const parentRole = (body as { parent_role: { holder: { payload: Record<string, unknown> } } }).parent_role;
  return parentRole.holder.payload;
}

beforeEach(async () => {
  db = new SqliteDatabase(":memory:");
  migrate(db);
  setupOperator(db, { display_name: "Parent role identity operator" });
  const coordinator = createUser(db, {
    slug: "parent-role-test-agent",
    kind: "agent",
    display_name: "Parent role test agent",
  });
  setDb(db);
  addProject(db, { project_key: "mandible", display_name: "Mandible" });
  router = authenticatedTestRouter(coordinator);
  const sessionAliasResolver = (database: Db, id: string) => resolveSessionAlias(database, id, {
    readCodexTaskLiveness: (_sourcePath, taskId) => ({
      status: taskId === DESKTOP_TASK ? "live" : "not_live",
    }),
  });
  registerIssueRoutes(router, fakeScanner, { sessionAliasResolver });
  registerSessionRoutes(router, new SessionRegistry(db), fakeScanner);

  const created = await router.invoke({
    method: "POST",
    url: "/api/issues/mandible",
    body: { title: "Umbrella", body: "Umbrella body", project: "mandible", kind: "umbrella" },
  });
  expect(created.status).toBe(200);
  umbrellaId = (created.body as { id: string }).id;
});

afterEach(() => {
  db.close();
});

describe("parent-role assume rejects unverifiable session ids", () => {
  it("refuses an id Mandible has never recorded, and names the id", async () => {
    const response = await assume("01a04e24-not-a-registered-thread");

    expect(response.status).toBe(400);
    const body = response.body as { error: string; supplied_session_id: string };
    expect(body.supplied_session_id).toBe("01a04e24-not-a-registered-thread");
    expect(body.error).toContain("01a04e24-not-a-registered-thread");

    // Nothing was recorded: a refused assume must leave the umbrella holderless
    // rather than plant a holder no check can ever verify.
    expect((await parentRoleStatus()).holder).toBeNull();
  });
});

describe("parent-role assume accepts every registered alias form", () => {
  beforeEach(() => {
    seedSession(MANDIBLE_SESSION, "active");
    seedConsoleSession({
      id: CONSOLE_SESSION,
      status: "running",
      mandibleSessionId: MANDIBLE_SESSION,
      providerSessionId: PROVIDER_THREAD,
    });
  });

  it("accepts a Mandible session id and stores both identities", async () => {
    const response = await assume(MANDIBLE_SESSION);

    expect(response.status).toBe(200);
    expect(holderPayload(response.body)).toMatchObject({
      session_id: MANDIBLE_SESSION,
      resolved_session_id: MANDIBLE_SESSION,
      console_session_id: CONSOLE_SESSION,
      provider: "codex",
      provider_session_id: PROVIDER_THREAD,
      mechanism: "codex",
    });
  });

  it("accepts a console session id", async () => {
    const response = await assume(CONSOLE_SESSION);

    expect(response.status).toBe(200);
    expect(holderPayload(response.body)).toMatchObject({
      session_id: CONSOLE_SESSION,
      resolved_session_id: MANDIBLE_SESSION,
      console_session_id: CONSOLE_SESSION,
      provider_session_id: PROVIDER_THREAD,
    });
  });

  it("accepts a provider thread id and reports the holder live", async () => {
    const response = await assume(PROVIDER_THREAD);

    expect(response.status).toBe(200);
    // The supplied spelling is preserved for existing readers; the resolved
    // identities are added beside it.
    expect(holderPayload(response.body)).toMatchObject({
      session_id: PROVIDER_THREAD,
      resolved_session_id: MANDIBLE_SESSION,
      console_session_id: CONSOLE_SESSION,
      provider_session_id: PROVIDER_THREAD,
    });

    // The regression itself: before consolidation a provider thread id matched
    // no `sessions.id`, so its holder was reported dead the moment it was
    // recorded and the next coordinator could take the umbrella silently.
    const status = await parentRoleStatus();
    expect(status.live_holder).not.toBeNull();
    expect((status.holder?.liveness as { has_live_agent: boolean }).has_live_agent).toBe(true);
    expect(status.holder?.liveness).toMatchObject({
      resolved_session_id: MANDIBLE_SESSION,
      provider_session_id: PROVIDER_THREAD,
      provider: "codex",
    });
  });
});

describe("Codex Desktop provider tasks", () => {
  it("accepts an ingested live task without copying provider task status", async () => {
    seedCodexConversation();

    const response = await assume(DESKTOP_TASK);
    expect(response.status).toBe(200);
    expect(holderPayload(response.body)).toMatchObject({
      session_id: DESKTOP_TASK,
      resolved_session_id: null,
      provider: "codex",
      provider_session_id: DESKTOP_TASK,
    });
    const status = await parentRoleStatus();
    expect(status.live_holder).not.toBeNull();
    expect(status.holder?.liveness).toMatchObject({
      has_live_agent: true,
      agent_status: "active",
      provider: "codex",
      provider_session_id: DESKTOP_TASK,
    });
    expect(db.prepare("SELECT id FROM sessions WHERE conversation_id = ?").get(DESKTOP_TASK))
      .toBeUndefined();
  });

  it("links an ingested provider task under its thread id without creating a session row", async () => {
    seedCodexConversation();

    const response = await router.invoke({
      method: "POST",
      url: `/api/sessions/${DESKTOP_TASK}/issues`,
      body: { issue_id: umbrellaId, repo_id: "mandible" },
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      session_id: DESKTOP_TASK,
      ledger_issue_id: umbrellaId,
    });
    expect(db.prepare("SELECT count(*) AS n FROM sessions").get()).toEqual({ n: 0 });

    const linked = await router.invoke({ method: "GET", url: `/api/sessions/${DESKTOP_TASK}/issues` });
    expect(linked.status).toBe(200);
    expect(linked.body).toMatchObject([{ session_id: DESKTOP_TASK, ledger_issue_id: umbrellaId }]);

    const overview = await router.invoke({
      method: "GET",
      url: `/api/sessions/overview/by-provider?provider=codex&provider_session_id=${DESKTOP_TASK}`,
    });
    expect((overview.body as { linked_issues: { items: Array<{ issue_id: string }> } }).linked_issues.items)
      .toMatchObject([{ issue_id: umbrellaId }]);
  });

  it("keys a wrap session's link on its provider session id and reads it back under either id", async () => {
    const claudeSession = "4be0c2a1-6b44-4a43-9d2e-0d6f1c9a7e21";
    db.prepare(
      "INSERT INTO sessions (id, app, status, conversation_id) VALUES ('wrap-1', 'claude', 'active', ?)",
    ).run(claudeSession);

    const response = await router.invoke({
      method: "POST",
      url: "/api/sessions/wrap-1/issues",
      body: { issue_id: umbrellaId, repo_id: "mandible" },
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ session_id: claudeSession });
    for (const id of ["wrap-1", claudeSession]) {
      const linked = await router.invoke({ method: "GET", url: `/api/sessions/${id}/issues` });
      expect(linked.body).toMatchObject([{ session_id: claudeSession, ledger_issue_id: umbrellaId }]);
    }
  });

  it("returns a typed retryable result before provider ingestion arrives", async () => {
    const notIngested = "01a09999-1111-7222-8333-444455556666";
    const response = await router.invoke({
      method: "POST",
      url: `/api/sessions/${notIngested}/issues`,
      body: { issue_id: umbrellaId, repo_id: "mandible" },
    });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: "provider_session_not_ingested",
      provider_session_id: notIngested,
      retryable: true,
    });
  });
});

describe("parent-role holder identity is the agent, not the spelling of its id", () => {
  beforeEach(() => {
    seedSession(MANDIBLE_SESSION, "active");
    seedConsoleSession({
      id: CONSOLE_SESSION,
      status: "running",
      mandibleSessionId: MANDIBLE_SESSION,
      providerSessionId: PROVIDER_THREAD,
    });
  });

  it("lets the same live agent re-assume under a different alias without an override", async () => {
    expect((await assume(PROVIDER_THREAD)).status).toBe(200);

    const again = await assume(MANDIBLE_SESSION);
    expect(again.status).toBe(200);
  });

  it("still refuses a different live agent without an override", async () => {
    expect((await assume(PROVIDER_THREAD)).status).toBe(200);

    seedSession("sess-other", "active");
    const conflict = await assume("sess-other");
    expect(conflict.status).toBe(409);
    const body = conflict.body as { error: string; live_holder: Record<string, unknown> };
    expect(body.error).toContain("only the operator may displace it");
    // The conflict names the holder, so a coordinator can decide rather than
    // guess (issue 7a97e2c's `- (-)` was unactionable).
    expect(body.live_holder.session_id).toBe(PROVIDER_THREAD);
    expect(body.live_holder.mechanism).toBe("codex");

    const deniedOverride = await assume("sess-other", true);
    expect(deniedOverride.status).toBe(409);
    expect((deniedOverride.body as { error: string }).error).toContain("only the operator");
  });

  it("does not block on a stale holder", async () => {
    seedSession("sess-dead", "ended");
    expect((await assume("sess-dead")).status).toBe(200);
    expect((await parentRoleStatus()).live_holder).toBeNull();

    expect((await assume(MANDIBLE_SESSION)).status).toBe(200);
  });
});

describe("canonical session liveness", () => {
  it("resolves each alias to the same agent and agrees on liveness", () => {
    seedSession(MANDIBLE_SESSION, "idle");
    seedConsoleSession({
      id: CONSOLE_SESSION,
      status: "stopped",
      mandibleSessionId: MANDIBLE_SESSION,
      providerSessionId: PROVIDER_THREAD,
    });

    for (const alias of [MANDIBLE_SESSION, CONSOLE_SESSION, PROVIDER_THREAD]) {
      const resolved = resolveSessionAlias(db, alias);
      expect(resolved).not.toBeNull();
      expect(resolved).toMatchObject({
        supplied_id: alias,
        mandible_session_id: MANDIBLE_SESSION,
        console_session_id: CONSOLE_SESSION,
        provider_session_id: PROVIDER_THREAD,
        has_live_agent: true,
      });
      expect(isSessionAliasLive(db, alias)).toBe(true);
    }

    expect(resolveSessionAlias(db, "never-registered")).toBeNull();
    expect(isSessionAliasLive(db, "never-registered")).toBe(false);
  });

  it("counts a live console session whose Mandible session has ended", () => {
    seedSession(MANDIBLE_SESSION, "ended");
    seedConsoleSession({
      id: CONSOLE_SESSION,
      status: "running",
      mandibleSessionId: MANDIBLE_SESSION,
      providerSessionId: PROVIDER_THREAD,
    });

    expect(isSessionAliasLive(db, PROVIDER_THREAD)).toBe(true);
    expect(resolveSessionAlias(db, PROVIDER_THREAD)?.has_live_agent).toBe(true);
  });

  it("reports a fully stopped agent as resolved but not live", () => {
    seedSession(MANDIBLE_SESSION, "ended");
    seedConsoleSession({
      id: CONSOLE_SESSION,
      status: "stopped",
      mandibleSessionId: MANDIBLE_SESSION,
      providerSessionId: PROVIDER_THREAD,
    });

    const resolved = resolveSessionAlias(db, PROVIDER_THREAD);
    expect(resolved?.mandible_session_id).toBe(MANDIBLE_SESSION);
    expect(resolved?.has_live_agent).toBe(false);
  });
});

/**
 * The archive path is the one place a liveness regression is destructive: a
 * false "not live" archives a Codex thread whose agent is still working. It now
 * calls the shared predicate, so this pins its behaviour through the real entry
 * point rather than through the helper.
 */
describe("Codex archive candidates still exclude live threads", () => {
  function archiveDb(): InstanceType<typeof SqliteDatabase> {
    const archive = new SqliteDatabase(":memory:");
    archive.exec(`
      CREATE TABLE work_units (
        id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL,
        ledger_issue_id TEXT,
        state TEXT NOT NULL,
        assigned_session_id TEXT,
        worker_provider_session_id TEXT,
        auth_request_id TEXT
      );
      CREATE TABLE sessions (id TEXT PRIMARY KEY, status TEXT);
      CREATE TABLE console_sessions (
        id TEXT PRIMARY KEY,
        mandible_session_id TEXT,
        provider_session_id TEXT,
        command TEXT,
        status TEXT
      );
    `);
    archive.prepare(
      `INSERT INTO work_units (id, issue_id, state, worker_provider_session_id, auth_request_id)
       VALUES ('wu-live', 'issue-live', 'resolved', 'thread-live', 'auth-1'),
              ('wu-done', 'issue-done', 'resolved', 'thread-done', 'auth-1')`,
    ).run();
    return archive;
  }

  const request = { id: "auth-1", type: "merge", issues: [], issue_closures: [] } as AuthRequest;

  it("skips a thread whose console session is still running", () => {
    const archive = archiveDb();
    archive.prepare(
      `INSERT INTO console_sessions (id, provider_session_id, command, status)
       VALUES ('cs-live', 'thread-live', 'codex', 'running'),
              ('cs-done', 'thread-done', 'codex', 'stopped')`,
    ).run();

    const candidates = listCompletedWorkerThreadArchiveCandidates(archive as unknown as Db, request);

    expect(candidates.map((candidate) => candidate.provider_session_id)).toEqual(["thread-done"]);
    archive.close();
  });

  it("skips a thread whose linked Mandible session is still active", () => {
    const archive = archiveDb();
    archive.prepare(
      "INSERT INTO sessions (id, status) VALUES ('mandible-live', 'active')",
    ).run();
    archive.prepare(
      `INSERT INTO console_sessions (id, mandible_session_id, provider_session_id, command, status)
       VALUES ('cs-live', 'mandible-live', 'thread-live', 'codex', 'stopped'),
              ('cs-done', NULL, 'thread-done', 'codex', 'stopped')`,
    ).run();

    const candidates = listCompletedWorkerThreadArchiveCandidates(archive as unknown as Db, request);

    expect(candidates.map((candidate) => candidate.provider_session_id)).toEqual(["thread-done"]);
    archive.close();
  });
});
