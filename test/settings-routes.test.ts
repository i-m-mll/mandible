import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RequestLike, ResponseLike, RouteHandler, RouteRegistrar } from "../src/server.js";

class TestRoutes implements RouteRegistrar {
  private readonly handlers = new Map<string, RouteHandler>();

  get(routePath: string, handler: RouteHandler): void {
    this.handlers.set(`GET ${routePath}`, handler);
  }

  post(routePath: string, handler: RouteHandler): void {
    this.handlers.set(`POST ${routePath}`, handler);
  }

  put(routePath: string, handler: RouteHandler): void {
    this.handlers.set(`PUT ${routePath}`, handler);
  }

  patch(routePath: string, handler: RouteHandler): void {
    this.handlers.set(`PATCH ${routePath}`, handler);
  }

  delete(routePath: string, handler: RouteHandler): void {
    this.handlers.set(`DELETE ${routePath}`, handler);
  }

  handler(method: string, routePath: string): RouteHandler {
    const handler = this.handlers.get(`${method} ${routePath}`);
    if (!handler) {
      throw new Error(`Missing handler for ${method} ${routePath}`);
    }
    return handler;
  }
}

function createResponse(): ResponseLike & { statusCode: number; payload: unknown } {
  return {
    statusCode: 200,
    payload: undefined,
    status(code: number): ResponseLike {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown): void {
      this.payload = payload;
    },
  };
}

function createSettingsDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  return db;
}

describe("settings routes", () => {
  const originalHome = process.env.HOME;
  let tempHome = "";

  afterEach(() => {
    process.env.HOME = originalHome;
    vi.resetModules();
    if (tempHome) {
      fs.rmSync(tempHome, { recursive: true, force: true });
      tempHome = "";
    }
  });

  it("keeps deprecated reaper settings writable without creating the legacy config", async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-settings-home-"));
    process.env.HOME = tempHome;
    vi.resetModules();

    const db = createSettingsDb();
    const { setDb } = await import("../src/db.js");
    const { registerSettingsRoutes } = await import("../src/routes/settings.js");
    setDb(db);

    const routes = new TestRoutes();
    registerSettingsRoutes(routes);
    const res = createResponse();
    const req: RequestLike = {
      method: "PUT",
      url: "/api/settings/reaper_enabled",
      params: { key: "reaper_enabled" },
      query: {},
      body: { value: "false" },
    };

    await routes.handler("PUT", "/api/settings/:key")(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({
      ok: true,
      key: "reaper_enabled",
      value: "false",
      deprecated: true,
    });
    expect(
      fs.existsSync(path.join(tempHome, ".config", "claude-reaper", "config")),
    ).toBe(false);
    expect(
      db.prepare("SELECT value FROM settings WHERE key = ?").get("reaper_enabled"),
    ).toEqual({ value: "false" });

    db.close();
  });
});
