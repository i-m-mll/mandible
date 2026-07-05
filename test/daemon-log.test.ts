import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openDb, type Db } from "../src/db.js";
import { configureDaemonLogger, rotateStderrLogSegments } from "../src/daemon-log.js";
import { FileRpcTransport } from "../src/file-rpc-transport.js";
import { registerSystemRoutes } from "../src/routes/system.js";
import { Router, createServer, type RouteHandler, type RouteOptions, type RouteRegistrar } from "../src/server.js";
import { SseManager } from "../src/sse.js";
import type { RequestLike, ResponseLike } from "../src/server.js";

let tempDir = "";
let db: Db;
let stderrSpy: ReturnType<typeof vi.spyOn>;
const originalStderrLogPath = process.env.MANDIBLE_STDERR_LOG_PATH;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-daemon-log-"));
  process.env.MANDIBLE_STDERR_LOG_PATH = path.join(tempDir, "launchd-stderr.log");
  db = openDb(path.join(tempDir, "mandible.db"));
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
  db.close();
  if (originalStderrLogPath === undefined) {
    delete process.env.MANDIBLE_STDERR_LOG_PATH;
  } else {
    process.env.MANDIBLE_STDERR_LOG_PATH = originalStderrLogPath;
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

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
    body: undefined,
  };
}

describe("daemon logger", () => {
  it("inserts debug rows into daemon_log even when stderr LOG_LEVEL would hide them", () => {
    const logger = configureDaemonLogger(db);

    logger("debug", "debug_row_kept", {
      subsystem: "test",
      issue_id: "issue-1",
      auth_request_id: "auth-1",
      artifact_id: "artifact-1",
      session_id: "session-1",
      repo_id: "repo-1",
      value: 42,
    });

    const row = db
      .prepare("SELECT * FROM daemon_log WHERE event = ?")
      .get("debug_row_kept") as Record<string, unknown>;
    expect(row).toMatchObject({
      level: "debug",
      event: "debug_row_kept",
      subsystem: "test",
      issue_id: "issue-1",
      auth_request_id: "auth-1",
      artifact_id: "artifact-1",
      session_id: "session-1",
      repo_id: "repo-1",
    });
    expect(JSON.parse(String(row.fields_json))).toMatchObject({ value: 42 });
  });

  it("rotates stderr log segments without truncating the active file in place", () => {
    const logPath = path.join(tempDir, "launchd-stderr.log");
    fs.writeFileSync(logPath, "first-segment", "utf8");

    rotateStderrLogSegments({ filePath: logPath, maxBytes: 5, keepSegments: 2 });

    expect(fs.existsSync(logPath)).toBe(false);
    expect(fs.readFileSync(`${logPath}.1`, "utf8")).toBe("first-segment");

    fs.writeFileSync(logPath, "second-segment", "utf8");
    rotateStderrLogSegments({ filePath: logPath, maxBytes: 5, keepSegments: 2 });

    expect(fs.readFileSync(`${logPath}.1`, "utf8")).toBe("second-segment");
    expect(fs.readFileSync(`${logPath}.2`, "utf8")).toBe("first-segment");
  });
});

describe("request logging", () => {
  it("records file-RPC requests as structured daemon_log rows", async () => {
    const logger = configureDaemonLogger(db);
    const router = new Router({ logger });
    router.get("/api/ledger/issues/:issueId", (req, res) => {
      res.json({ issue_id: req.params.issueId });
    }, { fileRpc: "allow" });
    const transport = new FileRpcTransport({
      router,
      dir: path.join(tempDir, "rpc"),
      logger,
      responseTtlMs: 60_000,
    });
    fs.mkdirSync(transport.dir, { recursive: true });
    fs.writeFileSync(
      path.join(transport.dir, "rpc-1.request.json"),
      JSON.stringify({ id: "rpc-1", method: "GET", path: "/api/ledger/issues/abc123" }),
      "utf8",
    );

    await transport.processOnce();

    const row = db
      .prepare("SELECT * FROM daemon_log WHERE event = 'file_rpc_request'")
      .get() as Record<string, unknown>;
    expect(row).toMatchObject({
      level: "info",
      event: "file_rpc_request",
      subsystem: "file-rpc",
      issue_id: "abc123",
    });
    expect(JSON.parse(String(row.fields_json))).toMatchObject({
      request_id: "rpc-1",
      method: "GET",
      path: "/api/ledger/issues/abc123",
      status: 200,
    });
  });

  it("records HTTP requests after response completion with status and duration", async () => {
    const logger = configureDaemonLogger(db);
    const router = new Router({ logger });
    router.get("/api/ping", (_req, res) => {
      res.json({ ok: true });
    }, { fileRpc: "deny" });
    const server = createServer({
      db,
      sse: new SseManager(),
      logger,
      version: "test",
      router,
      getStartupInfo: () => null,
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        resolve(typeof address === "object" && address ? address.port : 0);
      });
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/api/ping`, (res) => {
          res.resume();
          res.on("end", resolve);
        });
        req.on("error", reject);
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    const row = db
      .prepare("SELECT * FROM daemon_log WHERE event = 'http_request'")
      .get() as Record<string, unknown>;
    expect(row).toMatchObject({
      level: "info",
      event: "http_request",
      subsystem: "http",
    });
    expect(JSON.parse(String(row.fields_json))).toMatchObject({
      method: "GET",
      pathname: "/api/ping",
      status: 200,
      aborted: false,
    });
  });
});

describe("system log route daemon_log source", () => {
  it("returns daemon_log rows when a database is provided", async () => {
    const logger = configureDaemonLogger(db);
    logger("warn", "system_route_row", { subsystem: "test", issue_id: "issue-route" });

    const routes = new TestRoutes();
    registerSystemRoutes(routes, { getRepos: () => [] }, db);
    const res = createResponse();

    await routes.handler("GET", "/api/system/logs")(request({ level: "debug", limit: "10" }), res);

    expect(res.statusCode).toBe(200);
    expect(res.payload).toMatchObject({ source: "daemon_log", total: 1, exists: true });
    expect((res.payload as { entries: Array<Record<string, unknown>> }).entries[0]).toMatchObject({
      event: "system_route_row",
      subsystem: "test",
      issue_id: "issue-route",
    });
  });
});
