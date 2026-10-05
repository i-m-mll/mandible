import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Router } from "../src/server.js";

describe("HTTP request cancellation", () => {
  let server: http.Server | null = null;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  });

  it("aborts the route signal when the client disconnects before the response", async () => {
    const router = new Router();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let observedAbort!: () => void;
    const aborted = new Promise<void>((resolve) => { observedAbort = resolve; });
    router.post("/wait", async (req) => {
      entered();
      await new Promise<void>((resolve) => {
        req.signal?.addEventListener("abort", () => {
          observedAbort();
          resolve();
        }, { once: true });
      });
    }, { operation: { id: "fixture:post:/wait", effects: ["ledger:write"], requestSchema: null, reportingCategory: "data-write" }, fileRpc: "deny" });
    server = http.createServer((request, response) => { void router.handle(request, response); });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");

    const request = http.request({ method: "POST", host: "127.0.0.1", port: address.port, path: "/wait" });
    request.on("error", () => undefined);
    request.end();
    await started;
    request.destroy();
    await aborted;
    expect(true).toBe(true);
  });
});
