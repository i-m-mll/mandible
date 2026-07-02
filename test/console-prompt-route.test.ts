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
});
