import { describe, expect, it, vi } from "vitest";
import { Router } from "../src/server.js";
import type { Logger } from "../src/types.js";

describe("Router error handling", () => {
  it("returns a standard internal error envelope when a handler throws", async () => {
    const logger: Logger = vi.fn();
    const router = new Router({ logger });

    router.get("/api/fails", () => {
      throw new Error("private details");
    });

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
