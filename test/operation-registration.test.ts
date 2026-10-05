// @vitest-environment node
import { describe, expect, it } from "vitest";
import * as z from "zod";
import { Router, type RouteOptions } from "../src/server.js";
import { resolveInstanceInfo } from "../src/instance-policy.js";
import { STANDARD_PREVIEW_EFFECTS } from "../src/security/operation-policy.js";

describe("registered operation boundary", () => {
  it("refuses incomplete registrations instead of inferring a policy from the pathname", () => {
    const router = new Router();
    expect(() => router.post("/api/new", () => {}, { fileRpc: "allow" } as RouteOptions))
      .toThrow("Incomplete operation descriptor");
  });

  it("validates and transforms the body before resolving its effects", async () => {
    let calls = 0;
    const router = new Router({ instance: { ...resolveInstanceInfo({ env: {} }), allowed_effects: STANDARD_PREVIEW_EFFECTS },
      clientAuth: { mode: () => "strict", recordUnattributedWrite: () => {}, authenticate: () => ({
        user_id: "agent", slug: "agent", method: "api_token", credential_id: "credential",
        source: "http_bearer", effect_ceiling: STANDARD_PREVIEW_EFFECTS,
      }) } });
    router.post("/api/new", (_req, res) => { calls++; res.json({ ok: true }); }, {
      operation: { id: "test.transformed-operation", reportingCategory: null,
        requestSchema: z.object({}).transform(() => ({ external: true })),
        effects: ({ body }) => (body as { external: boolean }).external ? ["files:production"] : ["ledger:write"] },
      fileRpc: "allow",
    });
    expect(await router.invoke({ method: "POST", url: "/api/new", body: {}, transport: "http" }))
      .toMatchObject({ status: 403, body: { error: "effect_forbidden", missing_effects: ["files:production"] } });
    expect((await router.invoke({ method: "POST", url: "/api/new", body: null, transport: "http" })).status).toBe(400);
    expect(calls).toBe(0);
  });
});
