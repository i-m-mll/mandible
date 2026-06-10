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
  const originalInstructionsCli = process.env.MANDIBLE_INSTRUCTIONS_CLI;
  const originalCliLog = process.env.MANDIBLE_TEST_CLI_LOG;
  let tempHome = "";

  afterEach(() => {
    process.env.HOME = originalHome;
    if (originalInstructionsCli === undefined) {
      delete process.env.MANDIBLE_INSTRUCTIONS_CLI;
    } else {
      process.env.MANDIBLE_INSTRUCTIONS_CLI = originalInstructionsCli;
    }
    if (originalCliLog === undefined) {
      delete process.env.MANDIBLE_TEST_CLI_LOG;
    } else {
      process.env.MANDIBLE_TEST_CLI_LOG = originalCliLog;
    }
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

  it("returns default instruction targets and applies delivery changes immediately", async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-settings-home-"));
    process.env.HOME = tempHome;
    const cliLog = path.join(tempHome, "instructions-cli.log");
    const fakeCli = path.join(tempHome, "instructions.sh");
    fs.writeFileSync(fakeCli, [
      "#!/usr/bin/env bash",
      "printf '%s\\n' \"$*\" >> \"$MANDIBLE_TEST_CLI_LOG\"",
      "printf 'NODE_BIN=%s\\n' \"$NODE_BIN\" >> \"$MANDIBLE_TEST_CLI_LOG\"",
      "test -x \"$NODE_BIN\"",
    ].join("\n"), "utf8");
    fs.chmodSync(fakeCli, 0o755);
    process.env.MANDIBLE_INSTRUCTIONS_CLI = fakeCli;
    process.env.MANDIBLE_TEST_CLI_LOG = cliLog;
    vi.resetModules();

    const db = createSettingsDb();
    db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)").run(
      "instructions.targets",
      JSON.stringify([{ path: path.join(tempHome, "old.md"), mode: "managed-block" }]),
      1,
    );
    const { setDb } = await import("../src/db.js");
    const { registerSettingsRoutes } = await import("../src/routes/settings.js");
    setDb(db);

    const routes = new TestRoutes();
    registerSettingsRoutes(routes);

    const getRes = createResponse();
    await routes.handler("GET", "/api/settings/instructions-delivery")({
      method: "GET",
      url: "/api/settings/instructions-delivery",
      params: {},
      query: {},
      body: undefined,
    }, getRes);
    expect(getRes.statusCode).toBe(200);
    expect(getRes.payload).toMatchObject({
      targets: [{ path: path.join(tempHome, "old.md"), mode: "managed-block" }],
      configuredTargets: true,
    });

    const nextTarget = path.join(tempHome, "new.md");
    const putRes = createResponse();
    await routes.handler("PUT", "/api/settings/instructions-delivery")({
      method: "PUT",
      url: "/api/settings/instructions-delivery",
      params: {},
      query: {},
      body: {
        targets: [{ path: nextTarget, mode: "standalone" }],
        postExport: "bin/compile-agent-instructions",
        cleanupRemovedTargets: true,
      },
    }, putRes);

    expect(putRes.statusCode).toBe(200);
    expect(db.prepare("SELECT value FROM settings WHERE key = ?").get("instructions.targets")).toEqual({
      value: JSON.stringify([{ path: nextTarget, mode: "standalone" }]),
    });
    expect(db.prepare("SELECT value FROM settings WHERE key = ?").get("instructions.post_export")).toEqual({
      value: "bin/compile-agent-instructions",
    });
    expect(fs.readFileSync(cliLog, "utf8")).toContain(`cleanup --target ${path.join(tempHome, "old.md")} --mode managed-block`);
    expect(fs.readFileSync(cliLog, "utf8")).toContain("install");

    const resetRes = createResponse();
    await routes.handler("PUT", "/api/settings/instructions-delivery")({
      method: "PUT",
      url: "/api/settings/instructions-delivery",
      params: {},
      query: {},
      body: {
        resetToDefaults: true,
        cleanupRemovedTargets: false,
      },
    }, resetRes);
    expect(resetRes.statusCode).toBe(200);
    expect(resetRes.payload).toMatchObject({
      targets: [
        { path: path.join(tempHome, ".claude", "CLAUDE.md"), mode: "managed-block" },
        { path: path.join(tempHome, ".codex", "AGENTS.md"), mode: "managed-block" },
      ],
    });

    db.close();
  });
});
