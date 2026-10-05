import { describe, expect, it, vi } from "vitest";
import { Router } from "../../src/server.js";
import type { Logger } from "../../src/types.js";

describe("Router error handling", () => {
  it("returns a standard internal error envelope when a handler throws", async () => {
    const logger: Logger = vi.fn();
    const router = new Router({ logger });

    router.get("/api/fails", () => {
      throw new Error("private details");
    }, { fileRpc: "deny", operation: { id: "fixture.failure", effects: [], reportingCategory: null, requestSchema: null } });

    const response = await router.invoke({ method: "GET", url: "/api/fails" });

    expect(response).toEqual({
      status: 500,
      body: { error: "internal_error" },
    });
    expect(logger).toHaveBeenCalledWith(
      "error",
      "route_handler_error",
      expect.objectContaining({
        method: "GET",
        pathname: "/api/fails",
        error: "Error: private details",
      }),
    );
  });
});

describe("Router route policies", () => {
  it("lists file-RPC policy and operational mutation categories from route registration", () => {
    const router = new Router();
    router.post("/api/ledger/issues/:issueId/comments", (_req, res) => res.json({ ok: true }), {
      fileRpc: "allow",
      operation: { id: "fixture.comment", effects: ["ledger:write"], reportingCategory: "ledger", requestSchema: null },
    });
    router.post("/api/auth/check", (_req, res) => res.json({ ok: true }), {
      fileRpc: "allow",
      operation: { id: "fixture.auth-check", effects: ["ledger:read"], reportingCategory: null, requestSchema: null },
    });
    router.get("/api/projects", (_req, res) => res.json({ ok: true }), {
      fileRpc: "allow",
      operation: { id: "fixture.projects", effects: ["ledger:read"], reportingCategory: null, requestSchema: null },
    });

    expect(router.listRoutePolicies()).toEqual([
      {
        method: "POST",
        path: "/api/ledger/issues/:issueId/comments",
        fileRpc: "allow",
        operationId: "fixture.comment", effects: ["ledger:write"], requestSchema: "handler",
        operationalMutationCategory: "ledger",
      },
      {
        method: "POST",
        path: "/api/auth/check",
        fileRpc: "allow",
        operationId: "fixture.auth-check", effects: ["ledger:read"], requestSchema: "handler",
        operationalMutationCategory: null,
      },
      {
        method: "GET",
        path: "/api/projects",
        fileRpc: "allow",
        operationId: "fixture.projects", effects: ["ledger:read"], requestSchema: "handler",
        operationalMutationCategory: null,
      },
    ]);
  });
});
