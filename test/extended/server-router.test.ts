import { describe, expect, it, vi } from "vitest";
import { Router } from "../../src/server.js";
import type { Logger } from "../../src/types.js";

describe("Router error handling", () => {
  it("returns a standard internal error envelope when a handler throws", async () => {
    const logger: Logger = vi.fn();
    const router = new Router({ logger });

    router.get("/api/fails", () => {
      throw new Error("private details");
    }, { fileRpc: "deny" });

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
    });
    router.post("/api/auth/check", (_req, res) => res.json({ ok: true }), {
      fileRpc: "allow",
    });
    router.get("/api/projects", (_req, res) => res.json({ ok: true }), {
      fileRpc: "allow",
    });

    expect(router.listRoutePolicies()).toEqual([
      {
        method: "POST",
        path: "/api/ledger/issues/:issueId/comments",
        fileRpc: "allow",
        operationalMutationCategory: "ledger",
      },
      {
        method: "POST",
        path: "/api/auth/check",
        fileRpc: "allow",
      },
      {
        method: "GET",
        path: "/api/projects",
        fileRpc: "allow",
      },
    ]);
  });
});
