import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  RequestLike,
  ResponseLike,
  RouteHandler,
  RouteOptions,
  RouteRegistrar,
} from "../src/server.js";

class TestRoutes implements RouteRegistrar {
  private readonly handlers = new Map<string, RouteHandler>();

  get(routePath: string, handler: RouteHandler, _options: RouteOptions): void {
    this.handlers.set(`GET ${routePath}`, handler);
  }

  post(routePath: string, handler: RouteHandler, _options: RouteOptions): void {
    this.handlers.set(`POST ${routePath}`, handler);
  }

  put(routePath: string, handler: RouteHandler, _options: RouteOptions): void {
    this.handlers.set(`PUT ${routePath}`, handler);
  }

  patch(routePath: string, handler: RouteHandler, _options: RouteOptions): void {
    this.handlers.set(`PATCH ${routePath}`, handler);
  }

  delete(routePath: string, handler: RouteHandler, _options: RouteOptions): void {
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

function request(query: Record<string, string>): RequestLike {
  return {
    method: "GET",
    url: "/api/system/logs",
    params: {},
    query,
  };
}

function logLine(index: number, message = `entry-${index}`): string {
  return JSON.stringify({
    time: `2026-07-04T00:${String(index).padStart(2, "0")}:00.000Z`,
    level: "info",
    message,
    index,
  });
}

describe("system log routes", () => {
  const originalLogPath = process.env.MANDIBLE_STDERR_LOG_PATH;
  let tempHome = "";

  afterEach(() => {
    if (originalLogPath === undefined) delete process.env.MANDIBLE_STDERR_LOG_PATH;
    else process.env.MANDIBLE_STDERR_LOG_PATH = originalLogPath;
    vi.resetModules();
    if (tempHome) {
      fs.rmSync(tempHome, { recursive: true, force: true });
      tempHome = "";
    }
  });

  async function setupSystemRoutes(lines: string[]) {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-system-logs-home-"));
    vi.resetModules();

    const logDir = path.join(tempHome, ".cache", "mandible");
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, "launchd-stderr.log"), `${lines.join("\n")}\n`, "utf8");
    process.env.MANDIBLE_STDERR_LOG_PATH = path.join(logDir, "launchd-stderr.log");

    const { registerSystemRoutes } = await import("../src/routes/system.js");
    const routes = new TestRoutes();
    registerSystemRoutes(routes, { getRepos: () => [] });
    return routes;
  }

  it("returns the newest entries from the tailed window by default", async () => {
    const routes = await setupSystemRoutes(Array.from({ length: 80 }, (_value, index) => logLine(index + 1)));

    const res = createResponse();
    await routes.handler("GET", "/api/system/logs")(request({ level: "debug", limit: "5" }), res);

    expect(res.statusCode).toBe(200);
    expect(res.payload).toMatchObject({ limit: 5, offset: 0, exists: true });
    expect((res.payload as { entries: Array<{ index: number }> }).entries.map((entry) => entry.index)).toEqual([
      76,
      77,
      78,
      79,
      80,
    ]);
  });

  it("uses offset to page backward from the newest entries", async () => {
    const routes = await setupSystemRoutes(Array.from({ length: 80 }, (_value, index) => logLine(index + 1)));

    const res = createResponse();
    await routes.handler("GET", "/api/system/logs")(request({ level: "debug", limit: "5", offset: "5" }), res);

    expect(res.statusCode).toBe(200);
    expect((res.payload as { entries: Array<{ index: number }> }).entries.map((entry) => entry.index)).toEqual([
      71,
      72,
      73,
      74,
      75,
    ]);
  });

  it("tails through long NDJSON lines without falling back to stale older records", async () => {
    const filePath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "mandible-system-tail-")),
      "launchd-stderr.log",
    );
    try {
      fs.writeFileSync(
        filePath,
        [
          logLine(1),
          logLine(2, "x".repeat(128 * 1024)),
          logLine(3),
          logLine(4),
        ].join("\n") + "\n",
        "utf8",
      );

      const { tailFile } = await import("../src/routes/system.js");
      const rawText = await tailFile(filePath, 3, { chunkBytes: 1024, maxBytes: 512 * 1024 });
      const indexes = rawText.split("\n").map((line) => (JSON.parse(line) as { index: number }).index);

      expect(indexes).toEqual([2, 3, 4]);
    } finally {
      fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
    }
  });
});
