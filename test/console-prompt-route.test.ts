import { describe, expect, it, vi } from "vitest";

import { registerConsoleRoutes } from "../src/routes/console.js";
import type { RouteHandler, RouteRegistrar } from "../src/server.js";

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
  it("rejects caller-selected operator sessions before invoking the spawner", () => {
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
    } as never, res as never);

    expect(manager.create).not.toHaveBeenCalled();
    expect(payloads).toEqual([{ code: 403, payload: { error: "operator_session_reserved" } }]);
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

  it("routes supported cancel requests through the session manager", () => {
    const { server, routes } = makeRegistrar();
    const manager = {
      get: vi.fn(() => ({ meta: { id: "sdk-session" } })),
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
  });

  it("accepts typed SDK thinking-effort option updates", () => {
    const { server, routes } = makeRegistrar();
    const manager = {
      get: vi.fn(() => ({ meta: { id: "sdk-session", backend_type: "sdk" } })),
      updateOptions: vi.fn(() => ({ id: "sdk-session", backend_type: "sdk" })),
    };

    registerConsoleRoutes(server, manager as never);
    const route = routes.find(
      (item) => item.method === "PATCH" && item.path === "/api/console/sessions/:id/options",
    );
    expect(route).toBeDefined();

    const { res, payloads } = makeJsonResponse();
    route?.handler(
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
  });

  it("rejects unsupported provider-specific options on ACP sessions", () => {
    const { server, routes } = makeRegistrar();
    const manager = {
      get: vi.fn(() => ({ meta: { id: "acp-session", backend_type: "acp" } })),
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
    expect(payloads).toEqual([{ code: 400, payload: { error: "unsupported_session_option" } }]);
  });
});
