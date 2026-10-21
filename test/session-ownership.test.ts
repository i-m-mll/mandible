import SqliteDatabase from "../src/sqlite.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveAmbientProviderIdentity } from "../src/ambient-provider-identity.js";
import { migrate, setDb, type Db } from "../src/db.js";
import { SessionRegistry } from "../src/registry.js";
import { registerWorkUnitRoutes } from "../src/routes/work-units.js";
import { registerSessionRoutes } from "../src/routes/sessions.js";
import { registerUserRoutes } from "../src/routes/users.js";
import { Router } from "../src/server.js";
import { PTYBackend } from "../src/backends/pty-backend.js";
import { SessionManager } from "../src/session-manager.js";
import {
  addBinding,
  createUser,
  getUserBySlug,
  listBindings,
  listUsers,
  setupAgentUsers,
  setupOperator,
} from "../src/users/store.js";

describe("session and work-unit ownership", () => {
  let db: Db;

  beforeEach(() => {
    db = new SqliteDatabase(":memory:");
    migrate(db);
    setDb(db);
  });

  afterEach(() => db.close());

  function owner(table: string, id: string): string | null {
    return (db.prepare(`SELECT owner_user_id FROM ${table} WHERE id = ?`).get(id) as {
      owner_user_id: string | null;
    }).owner_user_id;
  }

  it("deliberately provisions agent users and bindings idempotently", () => {
    const first = setupAgentUsers(db, 1);
    const second = setupAgentUsers(db, 2);

    expect(first.map((user) => user.id)).toEqual(second.map((user) => user.id));
    expect(listUsers(db, { kind: "agent" }).map((user) => user.slug)).toEqual([
      "claude-code",
      "codex",
      "gemini",
    ]);
    expect(listBindings(db, "claude-code").map((binding) =>
      `${binding.binding_type}:${binding.value}`,
    )).toEqual([
      "app_name:claude",
      "app_name:claude-code",
      "provider_session_env:CLAUDE_CODE_SESSION_ID",
      "provider_session_env:CLAUDE_SESSION_ID",
    ]);
  });

  it("exposes deliberate agent provisioning through user setup", async () => {
    const router = new Router();
    registerUserRoutes(router);
    const response = await router.invoke({
      method: "POST",
      url: "/api/users/setup",
      body: { slug: "operator", display_name: "Operator", setup_agents: true },
    });

    expect(response.status).toBe(200);
    expect((response.body as { agents: Array<{ slug: string }> }).agents.map((agent) => agent.slug))
      .toEqual(["claude-code", "codex", "gemini"]);
  });

  it("binds registry, channel, and discovery app registrations and fails conflicts closed", () => {
    setupAgentUsers(db);
    const logger = vi.fn();
    const registry = new SessionRegistry(db, logger);
    const codex = getUserBySlug(db, "codex")!;
    const claude = getUserBySlug(db, "claude-code")!;
    const gemini = getUserBySlug(db, "gemini")!;

    registry.registerSession({ id: "registry-codex", app: "codex" });
    registry.registerSession({ id: "channel-claude", app: "claude" });
    registry.registerSession({ id: "registry-gemini", app: "gemini" });
    expect(owner("sessions", "registry-codex")).toBe(codex.id);
    expect(owner("sessions", "channel-claude")).toBe(claude.id);
    expect(owner("sessions", "registry-gemini")).toBe(gemini.id);

    const worker = createUser(db, {
      slug: "worker-owner",
      kind: "agent",
      display_name: "Worker Owner",
    });
    addBinding(db, worker.id, { binding_type: "app_name", value: "worker" });
    registry.registerSession({ id: "conflict", app: "codex", agent_type: "worker" });
    expect(owner("sessions", "conflict")).toBeNull();
    expect(logger).toHaveBeenCalledWith(
      "warn",
      "session_owner_binding_unresolved",
      expect.objectContaining({ source: "session_registry", status: "conflict" }),
    );
  });

  it("leaves unmatched registrations NULL and logs each signal set once", () => {
    const logger = vi.fn();
    const registry = new SessionRegistry(db, logger);
    registry.registerSession({ id: "unknown-1", app: "unknown-agent" });
    registry.registerSession({ id: "unknown-2", app: "unknown-agent" });

    expect(owner("sessions", "unknown-1")).toBeNull();
    expect(owner("sessions", "unknown-2")).toBeNull();
    expect(logger).toHaveBeenCalledTimes(1);
  });

  it("projects resolved owners on the session list", async () => {
    setupAgentUsers(db);
    const codex = getUserBySlug(db, "codex")!;
    const registry = new SessionRegistry(db);
    registry.registerSession({ id: "owned-session", app: "codex" });
    const router = new Router();
    registerSessionRoutes(router, registry);

    const response = await router.invoke({ method: "GET", url: "/api/sessions" });
    expect(response.status).toBe(200);
    // /api/sessions returns the paginated envelope { sessions, ...meta } (21502ff).
    expect(response.body.sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "owned-session",
        owner_user_id: codex.id,
        owner: { id: codex.id, display_name: codex.display_name, kind: "agent" },
      }),
    ]));
  });

  it("keeps terminal command names separate from agent identity and pins operator ownership", () => {
    setupAgentUsers(db);
    const operator = setupOperator(db, { slug: "operator", display_name: "Operator" });
    const start = vi.spyOn(PTYBackend.prototype, "start").mockImplementation(() => undefined);
    const manager = new SessionManager(db, () => undefined);
    try {
      const consoleSession = manager.create({
        label: "Codex",
        command: "codex",
        backend_type: "pty",
      });
      manager.startOperator();
      const operatorSession = manager.getAll().find((backend) => backend.meta.is_operator)!.meta;

      expect(owner("console_sessions", consoleSession.id)).toBeNull();
      db.prepare("UPDATE console_sessions SET command = 'codex' WHERE id = ?").run(operatorSession.id);
      manager.startOperator();
      expect(manager.operator()!.meta.id).toBe(operatorSession.id);
      expect(owner("console_sessions", operatorSession.id)).toBe(operator.id);
    } finally {
      manager.close();
      start.mockRestore();
    }
  });

  it("pins work-unit ownership independently of mutable provider metadata", async () => {
    setupAgentUsers(db);
    const codex = getUserBySlug(db, "codex")!;
    const router = new Router();
    registerWorkUnitRoutes(router, {} as never, vi.fn());

    const claim = await router.invoke({
      method: "POST",
      url: "/api/work-units/claim",
      ambient_identity: { provider: "codex", provider_session_id: "codex-thread-1" },
      body: { issue_id: "ownership-issue", repo_id: "mandible", branch: "feature/owner" },
    });
    const id = (claim.body as { id: string }).id;
    expect(owner("work_units", id)).toBe(codex.id);

    await router.invoke({
      method: "POST",
      url: "/api/work-units/activate",
      ambient_identity: { provider: "claude", provider_session_id: "replacement-thread" },
      body: { issue_id: "ownership-issue", repo_id: "mandible", branch: "feature/owner" },
    });
    expect(db.prepare(
      "SELECT owner_user_id, provider_session_id FROM work_units WHERE id = ?",
    ).get(id)).toEqual({
      owner_user_id: codex.id,
      provider_session_id: "replacement-thread",
    });
  });

  it("recognizes Codex, Claude, and Gemini ambient provider descriptors", () => {
    expect(resolveAmbientProviderIdentity({ CODEX_THREAD_ID: "codex-1" })).toEqual({
      provider: "codex",
      provider_session_id: "codex-1",
    });
    expect(resolveAmbientProviderIdentity({ CLAUDE_CODE_SESSION_ID: "claude-1" })).toEqual({
      provider: "claude",
      provider_session_id: "claude-1",
    });
    expect(resolveAmbientProviderIdentity({ GEMINI_SESSION_ID: "gemini-1" })).toEqual({
      provider: "gemini",
      provider_session_id: "gemini-1",
    });
    expect(resolveAmbientProviderIdentity({ CODEX_THREAD_ID: "codex-1", CODEX_SESSION_ID: "codex-2" })).toBeNull();
    expect(resolveAmbientProviderIdentity({ CODEX_THREAD_ID: "codex-1", CLAUDE_SESSION_ID: "claude-1" })).toBeNull();
  });
});
