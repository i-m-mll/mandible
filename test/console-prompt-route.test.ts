import { describe, expect, it, vi } from "vitest";

import { openDb, setDb } from "../src/db.js";
import { registerConsoleRoutes } from "../src/routes/console.js";
import type { RouteHandler, RouteRegistrar } from "../src/server.js";
import { addBinding, createUser, setupOperator } from "../src/users/store.js";

type RegisteredRoute = {
  method: string;
  path: string;
  handler: RouteHandler;
};

function makeRegistrar(): { server: RouteRegistrar; routes: RegisteredRoute[] } {
  const routes: RegisteredRoute[] = [];
  const register = (method: string) => (path: string, handler: RouteHandler) => {
    routes.push({ method, path, handler });
  };
  return {
    routes,
    server: {
      get: register("GET"),
      post: register("POST"),
      patch: register("PATCH"),
      put: register("PUT"),
      delete: register("DELETE"),
    } as unknown as RouteRegistrar,
  };
}

function makeJsonResponse(): {
  res: { status: (code: number) => { json: (payload: unknown) => void }; json: (payload: unknown) => void };
  payloads: Array<{ code: number; payload: unknown }>;
} {
  const payloads: Array<{ code: number; payload: unknown }> = [];
  let currentCode = 200;
  return {
    payloads,
    res: {
      status(code: number) {
        currentCode = code;
        return this;
      },
      json(payload: unknown) {
        payloads.push({ code: currentCode, payload });
      },
    },
  };
}

describe("console prompt route", () => {
  it("returns static run-option capabilities without route-side model knowledge", () => {
    const { server, routes } = makeRegistrar();
    const snapshot = { backendType: "acp", command: "provider", phase: "declared", revision: 0, options: [] };
    const manager = { describeRunOptions: vi.fn(() => snapshot) };
    registerConsoleRoutes(server, manager as never);
    const route = routes.find((item) => item.method === "GET" && item.path === "/api/console/run-options");
    const { res, payloads } = makeJsonResponse();
    route?.handler({ params: {}, query: { backend_type: "acp", command: "provider" } } as never, res as never);
    expect(manager.describeRunOptions).toHaveBeenCalledWith("acp", "provider");
    expect(payloads).toEqual([{ code: 200, payload: { runOptions: snapshot } }]);
  });

  it("rejects caller-selected operator sessions before invoking the spawner", () => {
    const db = openDb(":memory:");
    setDb(db);
    const operator = setupOperator(db, { display_name: "Operator" });
    const { server, routes } = makeRegistrar();
    const manager = { create: vi.fn(), start: vi.fn(), get: vi.fn() };
    registerConsoleRoutes(server, manager as never);
    const route = routes.find(
      (item) => item.method === "POST" && item.path === "/api/console/sessions",
    );
    const { res, payloads } = makeJsonResponse();

    route?.handler({
      params: {},
      body: { label: "Fake Operator", command: "bash", is_operator: true },
      client_identity: {
        user_id: operator.id,
        slug: operator.slug,
        method: "api_token",
        credential_id: "credential-operator",
        source: "http_bearer",
      },
    } as never, res as never);

    expect(manager.create).not.toHaveBeenCalled();
    expect(payloads).toEqual([{ code: 403, payload: { error: "operator_session_reserved" } }]);
    db.close();
  });

  it("does not route composer prompts to non-owned or external sessions", () => {
    const { server, routes } = makeRegistrar();
    const manager = {
      get: vi.fn(() => undefined),
      sendPrompt: vi.fn(),
    };

    registerConsoleRoutes(server, manager as never);
    const route = routes.find(
      (item) => item.method === "POST" && item.path === "/api/console/sessions/:id/prompt",
    );
    expect(route).toBeDefined();

    const { res, payloads } = makeJsonResponse();
    route?.handler({ params: { id: "external-session" }, body: { prompt: "hello" } } as never, res as never);

    expect(manager.get).toHaveBeenCalledWith("external-session");
    expect(manager.sendPrompt).not.toHaveBeenCalled();
    expect(payloads).toEqual([{ code: 404, payload: { error: "not_found" } }]);
  });

  it("does not let an ordinary token identity drive the operator backend", () => {
    const db = openDb(":memory:");
    setDb(db);
    const operator = setupOperator(db, { display_name: "Operator" });
    const agent = createUser(db, {
      slug: "agent-console",
      kind: "agent",
      display_name: "Agent Console",
    });
    const { server, routes } = makeRegistrar();
    const manager = {
      get: vi.fn(() => ({ meta: { id: "operator", is_operator: true } })),
      getAll: vi.fn(() => [
        { meta: { id: "stale-legacy-operator", is_operator: true } },
        { meta: { id: "operator", is_operator: true } },
      ]),
      sendPrompt: vi.fn(),
    };
    registerConsoleRoutes(server, manager as never);
    const route = routes.find(
      (item) => item.method === "POST" && item.path === "/api/console/sessions/:id/prompt",
    );

    const denied = makeJsonResponse();
    route?.handler({
      params: { id: "operator" },
      body: { prompt: "bypass" },
      client_identity: {
        user_id: agent.id,
        slug: agent.slug,
        method: "api_token",
        credential_id: "credential-agent",
        source: "http_bearer",
      },
    } as never, denied.res as never);
    expect(manager.sendPrompt).not.toHaveBeenCalled();
    expect(denied.payloads).toEqual([{
      code: 403,
      payload: expect.objectContaining({ code: "operator_required" }),
    }]);

    const listRoute = routes.find(
      (item) => item.method === "GET" && item.path === "/api/console/sessions",
    );
    const hidden = makeJsonResponse();
    listRoute?.handler({
      params: {},
      client_identity: {
        user_id: agent.id,
        slug: agent.slug,
        method: "api_token",
        credential_id: "credential-agent",
        source: "http_bearer",
      },
    } as never, hidden.res as never);
    expect(hidden.payloads).toEqual([{ code: 200, payload: { sessions: [] } }]);

    db.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    ).run("console_operator_session_id", "operator", Date.now());
    db.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    ).run("console_pinned_sessions", JSON.stringify(["operator", "regular"]), Date.now());
    const pinnedRoute = routes.find(
      (item) => item.method === "PUT" && item.path === "/api/console/pinned",
    );
    const pinned = makeJsonResponse();
    pinnedRoute?.handler({
      params: {},
      body: { ids: ["regular-next"] },
      client_identity: {
        user_id: agent.id,
        slug: agent.slug,
        method: "api_token",
        credential_id: "credential-agent",
        source: "http_bearer",
      },
    } as never, pinned.res as never);
    expect(pinned.payloads).toEqual([{
      code: 200,
      payload: { ids: ["regular-next"] },
    }]);
    expect(JSON.parse(db.prepare(
      "SELECT value FROM settings WHERE key = 'console_pinned_sessions'",
    ).pluck().get() as string)).toEqual(["regular-next", "operator"]);

    const allowed = makeJsonResponse();
    route?.handler({
      params: { id: "operator" },
      body: { prompt: "approved" },
      client_identity: {
        user_id: operator.id,
        slug: operator.slug,
        method: "api_token",
        credential_id: "credential-operator",
        source: "http_bearer",
      },
    } as never, allowed.res as never);
    expect(manager.sendPrompt).toHaveBeenCalledWith("operator", "approved");
    expect(allowed.payloads).toEqual([{ code: 202, payload: { ok: true } }]);
    db.close();
  });

  it("protects app-bound non-operator sessions from arbitrary callers", () => {
    const db = openDb(":memory:");
    setDb(db);
    const operator = setupOperator(db, { display_name: "Operator" });
    const owner = createUser(db, {
      slug: "claude-owner",
      kind: "agent",
      display_name: "Claude Owner",
    });
    addBinding(db, owner.id, { binding_type: "app_name", value: "claude" });
    const caller = createUser(db, {
      slug: "ordinary-caller",
      kind: "agent",
      display_name: "Ordinary Caller",
    });
    const backend = {
      meta: {
        id: "agent-session",
        command: "claude",
        is_operator: false,
        status: "stopped",
      },
      clear: vi.fn(),
    };
    const manager = {
      get: vi.fn(() => backend),
      getAll: vi.fn(() => [backend]),
      isCredentialBearing: vi.fn(() => true),
      sendPrompt: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    };
    const { server, routes } = makeRegistrar();
    registerConsoleRoutes(server, manager as never);
    const ordinaryIdentity = {
      user_id: caller.id,
      slug: caller.slug,
      method: "api_token",
      credential_id: "credential-caller",
      source: "http_bearer",
    };
    const operatorIdentity = {
      user_id: operator.id,
      slug: operator.slug,
      method: "api_token",
      credential_id: "credential-operator",
      source: "http_bearer",
    };

    const list = makeJsonResponse();
    routes.find((item) => item.method === "GET" && item.path === "/api/console/sessions")
      ?.handler({ params: {}, client_identity: ordinaryIdentity } as never, list.res as never);
    expect(list.payloads).toEqual([{ code: 200, payload: { sessions: [] } }]);

    const anonymous = makeJsonResponse();
    routes.find((item) => (
      item.method === "POST" && item.path === "/api/console/sessions/:id/prompt"
    ))?.handler({
      params: { id: "agent-session" },
      body: { prompt: "anonymous drive" },
    } as never, anonymous.res as never);
    expect(anonymous.payloads).toEqual([{
      code: 401,
      payload: expect.objectContaining({ code: "authentication_required" }),
    }]);

    for (const suffix of ["prompt", "start", "restart"]) {
      const response = makeJsonResponse();
      routes.find((item) => (
        item.method === "POST" && item.path === `/api/console/sessions/:id/${suffix}`
      ))?.handler({
        params: { id: "agent-session" },
        body: suffix === "prompt" ? { prompt: "drive credentials" } : {},
        client_identity: ordinaryIdentity,
      } as never, response.res as never);
      expect(response.payloads).toEqual([{
        code: 403,
        payload: expect.objectContaining({ code: "operator_required" }),
      }]);
    }
    expect(manager.sendPrompt).not.toHaveBeenCalled();
    expect(manager.start).not.toHaveBeenCalled();
    expect(manager.stop).not.toHaveBeenCalled();

    const allowed = makeJsonResponse();
    routes.find((item) => (
      item.method === "POST" && item.path === "/api/console/sessions/:id/prompt"
    ))?.handler({
      params: { id: "agent-session" },
      body: { prompt: "operator approved" },
      client_identity: operatorIdentity,
    } as never, allowed.res as never);
    expect(allowed.payloads).toEqual([{ code: 202, payload: { ok: true } }]);
    expect(manager.sendPrompt).toHaveBeenCalledWith("agent-session", "operator approved");
    db.close();
  });

  it("routes supported cancel requests through the session manager", () => {
    const db = openDb(":memory:");
    setDb(db);
    const { server, routes } = makeRegistrar();
    const manager = {
      get: vi.fn(() => ({
        meta: { id: "sdk-session", command: "unbound-sdk", is_operator: false },
      })),
      cancelPrompt: vi.fn(() => true),
    };

    registerConsoleRoutes(server, manager as never);
    const route = routes.find(
      (item) => item.method === "POST" && item.path === "/api/console/sessions/:id/cancel",
    );
    expect(route).toBeDefined();

    const { res, payloads } = makeJsonResponse();
    route?.handler({ params: { id: "sdk-session" }, body: {} } as never, res as never);

    expect(manager.get).toHaveBeenCalledWith("sdk-session");
    expect(manager.cancelPrompt).toHaveBeenCalledWith("sdk-session");
    expect(payloads).toEqual([{ code: 202, payload: { ok: true } }]);
    db.close();
  });

  it("accepts typed SDK thinking-effort option updates", async () => {
    const db = openDb(":memory:");
    setDb(db);
    const { server, routes } = makeRegistrar();
    const manager = {
      get: vi.fn(() => ({
        meta: {
          id: "sdk-session",
          command: "unbound-sdk",
          is_operator: false,
          backend_type: "sdk",
        },
      })),
      updateOptions: vi.fn(() => ({ id: "sdk-session", backend_type: "sdk" })),
    };

    registerConsoleRoutes(server, manager as never);
    const route = routes.find(
      (item) => item.method === "PATCH" && item.path === "/api/console/sessions/:id/options",
    );
    expect(route).toBeDefined();

    const { res, payloads } = makeJsonResponse();
    await route?.handler(
      { params: { id: "sdk-session" }, body: { thinkingEffort: "high", maxTurns: 3 } } as never,
      res as never,
    );

    expect(manager.updateOptions).toHaveBeenCalledWith("sdk-session", {
      thinkingEffort: "high",
      maxTurns: 3,
    });
    expect(payloads).toEqual([{
      code: 200,
      payload: { session: { id: "sdk-session", backend_type: "sdk" } },
    }]);
    db.close();
  });

  it("rejects SDK xhigh because the installed capability does not advertise it", async () => {
    const db = openDb(":memory:"); setDb(db);
    const { server, routes } = makeRegistrar();
    const manager = { get: vi.fn(() => ({ meta: { id: "sdk-session", command: "provider", is_operator: false, backend_type: "sdk" } })), updateOptions: vi.fn() };
    registerConsoleRoutes(server, manager as never);
    const route = routes.find((item) => item.method === "PATCH" && item.path === "/api/console/sessions/:id/options");
    const { res, payloads } = makeJsonResponse();
    await route?.handler({ params: { id: "sdk-session" }, body: { thinkingEffort: "xhigh" } } as never, res as never);
    expect(manager.updateOptions).not.toHaveBeenCalled();
    expect(payloads).toEqual([{ code: 422, payload: expect.objectContaining({
      error: "unavailable_session_option_value", option: "thinking_effort",
    }) }]);
    db.close();
  });

  it("rejects unsupported provider-specific options on ACP sessions", () => {
    const db = openDb(":memory:");
    setDb(db);
    const { server, routes } = makeRegistrar();
    const manager = {
      get: vi.fn(() => ({
        meta: {
          id: "acp-session",
          command: "unbound-acp",
          is_operator: false,
          backend_type: "acp",
        },
      })),
      updateOptions: vi.fn(),
    };

    registerConsoleRoutes(server, manager as never);
    const route = routes.find(
      (item) => item.method === "PATCH" && item.path === "/api/console/sessions/:id/options",
    );
    expect(route).toBeDefined();

    const { res, payloads } = makeJsonResponse();
    route?.handler(
      { params: { id: "acp-session" }, body: { thinkingEffort: "high" } } as never,
      res as never,
    );

    expect(manager.updateOptions).not.toHaveBeenCalled();
    expect(payloads).toEqual([{ code: 400, payload: expect.objectContaining({
      error: "unsupported_session_option",
      code: "unsupported_option",
      option: "thinking_effort",
      requestKey: "thinkingEffort",
      backend: { type: "acp", command: "unbound-acp" },
    }) }]);
    db.close();
  });

});
