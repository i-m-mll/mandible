import { expect, it, vi } from "vitest";
import type { Db } from "../src/db.js";
import { resolveInstanceInfo } from "../src/instance-policy.js";
import { createServer, Router } from "../src/server.js";
import { SseManager } from "../src/sse.js";

it.each([{ effects: [] }, { effects: ["ledger:read", "ledger:write"] }])("does not expose turn sampling in production with effects $effects", async ({ effects }) => {
  const instance = resolveInstanceInfo({ env: { MANDIBLE_INSTANCE_ROLE: "main", MANDIBLE_ALLOWED_EFFECTS: JSON.stringify(effects) } });
  const router = new Router({ instance });
  const readEventLoopTurnMs = vi.fn(() => 1);
  createServer({ db: {} as Db, sse: new SseManager(), logger: () => undefined,
    version: "test", router, instance, getStartupInfo: () => null, readEventLoopTurnMs });

  expect((await router.invoke({ method: "POST", url: "/api/diagnostics/event-loop-turn" })).status).toBe(404);
});

it("serves turn sampling in previews", async () => {
  const instance = { ...resolveInstanceInfo({ env: { MANDIBLE_INSTANCE_ROLE: "main" } }), role: "preview" as const };
  const router = new Router({ instance });
  createServer({ db: {} as Db, sse: new SseManager(), logger: () => undefined,
    version: "test", router, instance, getStartupInfo: () => null, readEventLoopTurnMs: () => 1 });
  const response = await router.invoke({ method: "POST", url: "/api/diagnostics/event-loop-turn" });
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ max_turn_ms: 1 });
});
