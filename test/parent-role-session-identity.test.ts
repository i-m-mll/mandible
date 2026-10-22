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
 * identities. The liveness rule itself is in session-liveness.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setDb, type Db } from "../src/db.js";
import { addProject } from "../src/ledger/project-registry.js";
import { SessionRegistry } from "../src/registry.js";
import { registerIssueRoutes } from "../src/routes/issues.js";
import { registerSessionRoutes } from "../src/routes/sessions.js";
import { Router } from "../src/server.js";
import { resolveSessionAlias } from "../src/session-liveness.js";
import { createUser, setupOperator } from "../src/users/store.js";
import { authenticatedTestRouter } from "./helpers/authenticated-router.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";

const fakeScanner = {
  getRepos: () => [],
  getRepoById: () => undefined,
  getBranches: () => [],
} as never;

const MANDIBLE_SESSION = "sess-coordinator";
const CONSOLE_SESSION = "console-coordinator";
const PROVIDER_THREAD = "01a04e24-a731-7362-bce3-ff7a63a845e2";
const DESKTOP_TASK = "01a072f2-0e05-7a91-abcd-df4dc6a64e62";
const OUTAGE_TASK = "01a072f2-0e05-7a91-abcd-df4dc6a64e63";

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

/** `caller` is the calling agent's own session, as its ambient provider identity. */
async function assume(sessionId: string, override = false, caller?: string) {
  return router.invoke({
    method: "POST",
    url: `/api/ledger/issues/${umbrellaId}/parent-role`,
    body: { session_id: sessionId, mechanism: "codex", override },
    ambient_identity: caller ? { provider: "codex", provider_session_id: caller } : undefined,
  });
}

async function release(caller: string) {
  return router.invoke({
    method: "DELETE",
    url: `/api/ledger/issues/${umbrellaId}/parent-role`,
    ambient_identity: { provider: "codex", provider_session_id: caller },
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
  db = migratedMemoryDb();
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
      status: taskId === DESKTOP_TASK ? "live" : taskId === OUTAGE_TASK ? "unavailable" : "not_live",
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
    expect((status.holder?.liveness as { state: string }).state).toBe("live");
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
      state: "live",
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
      url: `/api/sessions/${DESKTOP_TASK}/overview`,
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
    const body = conflict.body as { error: string; blocking_holder: Record<string, unknown> };
    expect(body.error).toContain("only the operator can displace it");
    // The conflict names the holder, so a coordinator can decide rather than
    // guess (issue 7a97e2c's `- (-)` was unactionable).
    expect(body.blocking_holder.session_id).toBe(PROVIDER_THREAD);
    expect(body.blocking_holder.mechanism).toBe("codex");

    const deniedOverride = await assume("sess-other", true, "sess-other");
    expect(deniedOverride.status).toBe(409);
    expect((deniedOverride.body as { error: string }).error).toContain("only for the operator");
  });

  it("lets the live holder hand the role to a successor from its own session", async () => {
    expect((await assume(PROVIDER_THREAD)).status).toBe(200);
    seedSession("sess-successor", "active");

    const handoff = await assume("sess-successor", false, PROVIDER_THREAD);
    expect(handoff.status).toBe(200);
    // The predecessor stays live but no longer holds the role.
    expect((await parentRoleStatus()).live_holder).toMatchObject({ session_id: "sess-successor" });
    expect((await assume(MANDIBLE_SESSION, false, PROVIDER_THREAD)).status).toBe(409);
  });

  it("lets only the holder release the role", async () => {
    expect((await assume(PROVIDER_THREAD)).status).toBe(200);
    seedSession("sess-other", "active");

    expect((await release("sess-other")).status).toBe(409);
    expect((await parentRoleStatus()).holder).toMatchObject({ session_id: PROVIDER_THREAD });

    const released = await release(PROVIDER_THREAD);
    expect(released.status).toBe(200);
    expect((await parentRoleStatus()).holder).toBeNull();
    expect((await assume("sess-other")).status).toBe(200);
  });

  it("does not block on a stale holder", async () => {
    seedSession("sess-dead", "ended");
    expect((await assume("sess-dead")).status).toBe(200);
    expect((await parentRoleStatus()).live_holder).toBeNull();

    expect((await assume(MANDIBLE_SESSION)).status).toBe(200);
  });

  it("blocks on a holder whose lock check cannot complete, as on a live one", async () => {
    seedCodexConversation(OUTAGE_TASK);
    expect((await assume(OUTAGE_TASK)).status).toBe(200);
    const status = await parentRoleStatus();
    expect(status.live_holder).toBeNull();
    expect(status.holder).toMatchObject({ session_id: OUTAGE_TASK, liveness: { state: "unknown" } });

    seedSession("sess-other", "active");
    const conflict = await assume("sess-other");
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({
      blocking_holder: { session_id: OUTAGE_TASK, liveness: { state: "unknown" } },
    });
  });
});
