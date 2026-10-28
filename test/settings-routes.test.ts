import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import SqliteDatabase from "../src/sqlite.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RequestLike, ResponseLike, RouteHandler, RouteRegistrar } from "../src/server.js";
import { PRODUCTION_EFFECTS } from "../src/security/effect-policy.js";
import { migrate } from "../src/db.js";
import { setupOperator } from "../src/users/store.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";

function testIdentity(db: SqliteDatabase): NonNullable<RequestLike["client_identity"]> {
  const operator = setupOperator(db, { slug: "settings-test", display_name: "Settings Test" });
  return {
    user_id: operator.id,
    slug: operator.slug,
    method: "api_token",
    credential_id: "settings-test-credential",
    source: "in_process",
    effect_ceiling: PRODUCTION_EFFECTS,
  };
}

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

function createSettingsDb(): SqliteDatabase {
  const db = migratedMemoryDb();
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
    vi.restoreAllMocks();
    vi.resetModules();
    if (tempHome) {
      fs.rmSync(tempHome, { recursive: true, force: true });
      tempHome = "";
    }
  });

  it("persists versioned app rail order across a route-layer restart", async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-rail-order-"));
    const dbPath = path.join(tempHome, "settings.db");
    let db = new SqliteDatabase(dbPath);
    migrate(db);
    const identity = testIdentity(db);
    const { setDb } = await import("../src/db.js");
    const { registerSettingsRoutes } = await import("../src/routes/settings.js");
    setDb(db);

    const value = JSON.stringify({
      version: 1,
      groups: { primary: ["issues", "console"], secondary: ["graph", "work"] },
    });
    const firstRoutes = new TestRoutes();
    registerSettingsRoutes(firstRoutes);
    const put = createResponse();
    await firstRoutes.handler("PUT", "/api/settings/:key")({
      method: "PUT",
      url: "/api/settings/app_rail_order",
      params: { key: "app_rail_order" },
      query: {},
      body: { value },
      client_identity: identity,
    }, put);
    expect(put.statusCode).toBe(200);
    const choice = createResponse();
    await firstRoutes.handler("PUT", "/api/settings/:key")({
      method: "PUT", url: "/api/settings/integrations.setup", params: { key: "integrations.setup" }, query: {},
      body: { value: "skipped" }, client_identity: identity,
    }, choice);
    expect(choice.statusCode).toBe(200);
    db.close();

    db = new SqliteDatabase(dbPath);
    setDb(db);
    const restartedRoutes = new TestRoutes();
    registerSettingsRoutes(restartedRoutes);
    const get = createResponse();
    await restartedRoutes.handler("GET", "/api/settings")({
      method: "GET",
      url: "/api/settings",
      params: {},
      query: {},
      body: undefined,
    }, get);

    expect(get.statusCode).toBe(200);
    expect(get.payload).toMatchObject({ app_rail_order: value, "integrations.setup": "skipped" });
    db.close();
  });

  it("saves preview instruction settings without exporting or writing shared config", async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-settings-preview-"));
    process.env.HOME = tempHome;
    // Bun caches os.homedir independently of later HOME changes.
    vi.spyOn(os, "homedir").mockReturnValue(tempHome);
    const cliLog = path.join(tempHome, "instructions-cli.log");
    const fakeCli = path.join(tempHome, "instructions.sh");
    fs.writeFileSync(fakeCli, "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$MANDIBLE_TEST_CLI_LOG\"\n", "utf8");
    fs.chmodSync(fakeCli, 0o755);
    process.env.MANDIBLE_INSTRUCTIONS_CLI = fakeCli;
    process.env.MANDIBLE_TEST_CLI_LOG = cliLog;
    vi.resetModules();

    const db = createSettingsDb();
    const identity = testIdentity(db);
    const { setDb } = await import("../src/db.js");
    const { registerSettingsRoutes } = await import("../src/routes/settings.js");
    setDb(db);
    const routes = new TestRoutes();
    registerSettingsRoutes(routes, "preview");

    const fresh = createResponse();
    await routes.handler("GET", "/api/settings/instructions-delivery")({ method: "GET", url: "/api/settings/instructions-delivery", params: {}, query: {} }, fresh);
    expect(fresh.payload).toMatchObject({ targets: [], configuredTargets: false });
    const target = path.join(tempHome, "custom", "AGENTS.md");
    const response = createResponse();
    await routes.handler("PUT", "/api/settings/instructions-delivery")({
      method: "PUT",
      url: "/api/settings/instructions-delivery",
      params: {},
      query: {},
      body: {
        targets: [{ path: target, mode: "standalone" }],
        postExport: "bin/compile-agent-instructions",
        cleanupRemovedTargets: true,
      },
      client_identity: identity,
    }, response);

    expect(response.statusCode).toBe(200);
    expect(response.payload).toMatchObject({
      preview_only: true,
      configuration_saved: true,
      targets: [{ path: target, mode: "standalone" }],
      export: { ok: false, stderr: expect.stringContaining("not installed") },
      cleanup: [],
    });
    expect(fs.existsSync(cliLog)).toBe(false);
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(path.join(tempHome, ".config", "dotfiles.conf"))).toBe(false);
    expect(db.prepare("SELECT value FROM settings WHERE key = ?").get("instructions.targets")).toEqual({
      value: JSON.stringify([{ path: target, mode: "standalone" }]),
    });
    const liveRoutes = new TestRoutes();
    registerSettingsRoutes(liveRoutes);
    fs.writeFileSync(fakeCli, "#!/usr/bin/env bash\necho optional-compiler-failed >&2\nexit 7\n");
    const optionalFailure = createResponse();
    await liveRoutes.handler("PUT", "/api/settings/instructions-delivery")({
      method: "PUT", url: "/api/settings/instructions-delivery", params: {}, query: {},
      body: { targets: [], postExport: "private-compiler" }, client_identity: identity,
    }, optionalFailure);
    expect(optionalFailure.statusCode).toBe(200);
    expect(optionalFailure.payload).toMatchObject({ targets: [], postExport: "private-compiler", configuration_saved: true, export: { ok: false, stderr: expect.stringContaining("optional-compiler-failed") } });
    db.close();
  });
});
