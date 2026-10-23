import { DEFAULT_MANAGED_CHAT_OPTIONS } from "../src/managed-chat-defaults.js";
import { readManagedChatDefaults } from "../src/user-settings.js";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { USER_SETTING_EVENTS } from "../src/contracts.js";
import { openDb, type Db } from "../src/db.js";
import { registerUserSettingsRoutes } from "../src/routes/user-settings.js";
import type {
  RequestLike,
  ResolvedClientIdentity,
  ResponseLike,
  RouteHandler,
  RouteRegistrar,
} from "../src/server.js";
import { setSseManager, SseManager } from "../src/sse.js";
import { createUser } from "../src/users/store.js";

class TestRoutes implements RouteRegistrar {
  private readonly handlers = new Map<string, RouteHandler>();
  get(routePath: string, handler: RouteHandler): void { this.handlers.set(`GET ${routePath}`, handler); }
  post(routePath: string, handler: RouteHandler): void { this.handlers.set(`POST ${routePath}`, handler); }
  put(routePath: string, handler: RouteHandler): void { this.handlers.set(`PUT ${routePath}`, handler); }
  patch(routePath: string, handler: RouteHandler): void { this.handlers.set(`PATCH ${routePath}`, handler); }
  delete(routePath: string, handler: RouteHandler): void { this.handlers.set(`DELETE ${routePath}`, handler); }
  handler(method: string, routePath: string): RouteHandler {
    const handler = this.handlers.get(`${method} ${routePath}`);
    if (!handler) throw new Error(`Missing handler for ${method} ${routePath}`);
    return handler;
  }
}

class FakeSseResponse extends EventEmitter {
  destroyed = false;
  writableLength = 0;
  writes: string[] = [];
  writeHead(): void {}
  write(payload: string): boolean { this.writes.push(payload); return true; }
  destroy(): this { this.destroyed = true; this.emit("close"); return this; }
}

function sseRequest(): IncomingMessage {
  return new EventEmitter() as IncomingMessage;
}

function sseResponse(): FakeSseResponse & ServerResponse {
  return new FakeSseResponse() as FakeSseResponse & ServerResponse;
}

function response(): ResponseLike & { statusCode: number; payload: unknown } {
  return {
    statusCode: 200,
    payload: undefined,
    status(code: number): ResponseLike { this.statusCode = code; return this; },
    json(payload: unknown): void { this.payload = payload; },
  };
}

function identity(userId: string, slug: string): ResolvedClientIdentity {
  return {
    user_id: userId,
    slug,
    method: "api_token",
    credential_id: null,
    source: "http_bearer",
  };
}

function request(
  method: "GET" | "PUT",
  user: ResolvedClientIdentity | null,
  value?: unknown,
  key = "app_rail_order",
): RequestLike {
  return {
    method,
    url: `/api/user-settings/${key}`,
    params: { key },
    query: {},
    body: method === "PUT" ? { value } : undefined,
    client_identity: user,
  };
}

async function call(
  routes: TestRoutes,
  method: "GET" | "PUT",
  req: RequestLike,
): Promise<{ statusCode: number; payload: unknown }> {
  const res = response();
  await routes.handler(method, "/api/user-settings/:key")(req, res);
  return { statusCode: res.statusCode, payload: res.payload };
}

const tempRoots: string[] = [];

afterEach(() => {
  setSseManager(null as unknown as SseManager);
  vi.restoreAllMocks();
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("authenticated user settings routes", () => {
  it("isolates users, increments revisions, and never falls back to the global setting", async () => {
    const db = openDb(":memory:");
    try {
      const alice = createUser(db, { slug: "alice", kind: "human", display_name: "Alice" });
      const bob = createUser(db, { slug: "bob", kind: "human", display_name: "Bob" });
      db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('app_rail_order', 'global', 1)").run();
      const routes = new TestRoutes();
      registerUserSettingsRoutes(routes, db);

      expect(await call(routes, "GET", request("GET", identity(alice.id, alice.slug))))
        .toEqual({ statusCode: 200, payload: { version: 1, key: "app_rail_order", value: null, revision: 0 } });

      const manager = new SseManager();
      const emitted = vi.spyOn(manager, "broadcast");
      setSseManager(manager);
      const firstInstance = sseResponse();
      const secondInstance = sseResponse();
      manager.addClient(sseRequest(), firstInstance, ["user-setting:"], identity(alice.id, alice.slug));
      manager.addClient(sseRequest(), secondInstance, ["user-setting:"], identity(alice.id, alice.slug));
      const first = await call(routes, "PUT", request("PUT", identity(alice.id, alice.slug), "alice-v1"));
      expect(first).toEqual({
        statusCode: 200,
        payload: { version: 1, key: "app_rail_order", value: "alice-v1", revision: 1 },
      });
      expect(emitted).toHaveBeenLastCalledWith(expect.objectContaining({
        type: USER_SETTING_EVENTS.updated,
        data: { version: 1, key: "app_rail_order", revision: 1 },
      }));
      for (const instance of [firstInstance, secondInstance]) {
        const event = instance.writes.find((value) => value.startsWith("data: "));
        expect(event).toBeDefined();
        expect(JSON.parse(event!.slice("data: ".length).trim())).toMatchObject({
          type: USER_SETTING_EVENTS.updated,
          data: { version: 1, key: "app_rail_order", revision: 1 },
        });
        expect(event).not.toContain("alice-v1");
        expect(event).not.toContain(alice.id);
      }

      expect(await call(routes, "PUT", request("PUT", identity(alice.id, alice.slug), "alice-v2")))
        .toMatchObject({ payload: { revision: 2, value: "alice-v2" } });
      expect(await call(routes, "PUT", request("PUT", identity(bob.id, bob.slug), "bob-v1")))
        .toMatchObject({ payload: { revision: 1, value: "bob-v1" } });
      expect(await call(routes, "GET", request("GET", identity(alice.id, alice.slug))))
        .toMatchObject({ payload: { value: "alice-v2", revision: 2 } });
      expect(await call(routes, "GET", request("GET", identity(bob.id, bob.slug))))
        .toMatchObject({ payload: { value: "bob-v1", revision: 1 } });
      expect(db.prepare("SELECT value FROM settings WHERE key = 'app_rail_order'").get())
        .toEqual({ value: "global" });
      manager.closeAll();
    } finally {
      db.close();
    }
  });

  it("persists the authenticated user's row across a database restart", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-user-settings-"));
    tempRoots.push(root);
    const dbPath = path.join(root, "mandible.db");
    let db: Db = openDb(dbPath);
    const user = createUser(db, { slug: "restart-user", kind: "human", display_name: "Restart User" });
    let routes = new TestRoutes();
    registerUserSettingsRoutes(routes, db);
    const value = "16";
    await call(routes, "PUT", request("PUT", identity(user.id, user.slug), value, "ui_font_size"));
    db.close();

    db = openDb(dbPath);
    routes = new TestRoutes();
    registerUserSettingsRoutes(routes, db);
    expect(await call(routes, "GET", request("GET", identity(user.id, user.slug), undefined, "ui_font_size")))
      .toMatchObject({
        statusCode: 200,
        payload: { version: 1, key: "ui_font_size", value, revision: 1 },
      });
    db.close();
  });

  it("fails closed for anonymous clients and rejects unknown keys and invalid values", async () => {
    const db = openDb(":memory:");
    try {
      const user = createUser(db, { slug: "known", kind: "human", display_name: "Known" });
      const routes = new TestRoutes();
      registerUserSettingsRoutes(routes, db);
      for (const method of ["GET", "PUT"] as const) {
        expect(await call(routes, method, request(method, null, "value"))).toMatchObject({
          statusCode: 401,
          payload: { code: "authentication_required" },
        });
      }
      expect(await call(routes, "GET", request("GET", identity(user.id, user.slug), undefined, "unknown")))
        .toMatchObject({ statusCode: 404, payload: { code: "user_setting_not_found" } });
      expect(await call(routes, "PUT", request("PUT", identity(user.id, user.slug), 7)))
        .toMatchObject({ statusCode: 400 });
      for (const [key, valid, invalid] of [
        ["ui_font_face", "space-grotesk", "comic-sans"],
        ["detail_font_face", "system-ui", "serif"],
        ["ui_font_size", "14", "21"],
        ["detail_font_size", "12", "9"],
      ] as const) {
        expect(await call(routes, "PUT", request("PUT", identity(user.id, user.slug), valid, key)))
          .toMatchObject({ statusCode: 200, payload: { key, value: valid, revision: 1 } });
        expect(await call(routes, "PUT", request("PUT", identity(user.id, user.slug), invalid, key)))
          .toMatchObject({ statusCode: 400, payload: { code: "invalid_user_setting_value" } });
      }
    } finally {
      db.close();
    }
  });
});

it("validates provider defaults atomically and isolates each user's choices", async () => {
    const db = openDb(":memory:");
    try {
      const alice = createUser(db, { slug: "defaults-alice", kind: "human", display_name: "Alice" });
      const bob = createUser(db, { slug: "defaults-bob", kind: "human", display_name: "Bob" });
      const routes = new TestRoutes();
      registerUserSettingsRoutes(routes, db);
      const chosen = structuredClone(DEFAULT_MANAGED_CHAT_OPTIONS);
      chosen.codex.effort = "high";
      chosen.claude_code.permission_mode = "acceptEdits";
      expect(await call(routes, "PUT", request("PUT", identity(alice.id, alice.slug), JSON.stringify(chosen), "managed_chat_defaults")))
        .toMatchObject({ statusCode: 200, payload: { revision: 1 } });
      expect(readManagedChatDefaults(db, alice.id)).toEqual(chosen);
      expect(readManagedChatDefaults(db, bob.id)).toEqual(DEFAULT_MANAGED_CHAT_OPTIONS);
      chosen.codex.permission_mode = "bypassPermissions";
      expect(await call(routes, "PUT", request("PUT", identity(alice.id, alice.slug), JSON.stringify(chosen), "managed_chat_defaults")))
        .toMatchObject({ statusCode: 400 });
      expect(readManagedChatDefaults(db, alice.id).codex.permission_mode).toBe("agent-full-access");
      expect(await call(routes, "GET", request("GET", identity(alice.id, alice.slug), undefined, "managed_chat_defaults")))
        .toMatchObject({ payload: { revision: 1 } });
    } finally { db.close(); }
  });
