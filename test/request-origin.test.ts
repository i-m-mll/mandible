import { describe, expect, it } from "vitest";
import { Router } from "../src/server.js";
import { currentRequestOrigin, requestOriginJson, withRequestOrigin, withRequestOriginMetadata } from "../src/request-origin.js";

describe("request origin dispatch", () => {
  it("isolates overlapping requests, clears absent origin, and restores serialized queued origin", async () => {
    const router = new Router();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const firstEntered = new Promise<void>((resolve) => { entered = resolve; });
    let queued: string | null = null;
    router.post("/write/:id", async (req, res) => {
      if (req.params.id === "first") {
        queued = requestOriginJson();
        entered();
        await barrier;
      }
      res.json(withRequestOriginMetadata({ request_origin: { provider: "claude", provider_session_id: "forged-payload" } }));
    }, { operation: { id: "origin.write", effects: ["ledger:write"], reportingCategory: "ledger", requestSchema: null }, fileRpc: "allow" });
    const codex = { provider: "codex", provider_session_id: "first-native" };
    const claude = { provider: "claude", provider_session_id: "second-native" };
    const first = router.invoke({ method: "POST", url: "/write/first", ambient_identity: codex });
    await firstEntered;
    try {
      expect((await router.invoke({ method: "POST", url: "/write/second", ambient_identity: claude })).body)
        .toEqual({ request_origin: claude });
      expect((await withRequestOrigin(codex, () => router.invoke({ method: "POST", url: "/write/missing" }))).body)
        .toEqual({ request_origin: null });
      expect((await router.invoke({ method: "POST", url: "/write/invalid", ambient_identity: { provider: "unknown", provider_session_id: "invented" } })).body)
        .toEqual({ request_origin: null });
    } finally { release(); }
    expect((await first).body).toEqual({ request_origin: codex });
    expect(currentRequestOrigin()).toBeNull();
    expect(queued).not.toBeNull();
    expect(await withRequestOrigin(JSON.parse(queued!), async () => {
      await Promise.resolve();
      return currentRequestOrigin();
    })).toEqual(codex);
    expect(currentRequestOrigin()).toBeNull();
  });
});
