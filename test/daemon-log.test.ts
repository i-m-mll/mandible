// @vitest-environment node
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openDb, type Db } from "../src/db.js";
import {
  configureDaemonLogger,
  startDaemonLogRetention,
  stopDaemonLogger,
  flushDaemonLogger,
  pruneDaemonLogs,
  rotateStderrLogSegments,
} from "../src/daemon-log.js";
import { FileRpcTransport } from "../src/file-rpc-transport.js";
import { openOperationalLogStore } from "../src/operational-log-db.js";
import { registerSystemRoutes } from "../src/routes/system.js";
import { Router, createServer, type RouteHandler, type RouteOptions, type RouteRegistrar } from "../src/server.js";
import { SseManager } from "../src/sse.js";
import type { RequestLike, ResponseLike } from "../src/server.js";
import { testRuntimeRoot } from "./helpers/runtime-isolation.js";

let tempDir = "";
let db: Db;
let stderrSpy: ReturnType<typeof vi.spyOn>;
const originalStderrLogPath = process.env.MANDIBLE_STDERR_LOG_PATH;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(testRuntimeRoot, "daemon-log-"));
  process.env.MANDIBLE_STDERR_LOG_PATH = path.join(tempDir, "launchd-stderr.log");
  db = openDb(path.join(tempDir, "mandible.db"));
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  stopDaemonLogger();
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
  it("can mirror logs without mutating a read-only preview database", () => {
    const logger = configureDaemonLogger(db, { persist: false });

    logger("info", "preview_started", { subsystem: "test" });
    flushDaemonLogger();

    expect(db.prepare("SELECT COUNT(*) AS count FROM daemon_log").get()).toEqual({ count: 0 });
    expect(stderrSpy).toHaveBeenCalled();
  });

  it("persists info and above while dropping debug noise", () => {
    const logger = configureDaemonLogger(db);

    logger("debug", "debug_row_dropped", {
      subsystem: "test",
    });
    logger("info", "info_row_kept", {
      subsystem: "test",
      issue_id: "issue-1",
      auth_request_id: "auth-1",
      artifact_id: "artifact-1",
      session_id: "session-1",
      repo_id: "repo-1",
      value: 42,
    });
    logger("warn", "warn_row_kept", { subsystem: "test" });
    logger("error", "error_row_kept", { subsystem: "test" });
    flushDaemonLogger();

    const rows = db
      .prepare("SELECT level, event FROM daemon_log ORDER BY ts, rowid")
      .all() as Array<{ level: string; event: string }>;
    expect(rows).toEqual([
      { level: "info", event: "info_row_kept" },
      { level: "warn", event: "warn_row_kept" },
      { level: "error", event: "error_row_kept" },
    ]);
    const info = db
      .prepare("SELECT * FROM daemon_log WHERE event = 'info_row_kept'")
      .get() as Record<string, unknown>;
    expect(info).toMatchObject({
      issue_id: "issue-1",
      auth_request_id: "auth-1",
      artifact_id: "artifact-1",
      session_id: "session-1",
      repo_id: "repo-1",
    });
    expect(JSON.parse(String(info.fields_json))).toMatchObject({ value: 42 });
  });

  // The daemon does not open this file: its spawner redirected stderr here and
  // holds the only descriptor. Rotating by rename left that descriptor on the
  // moved inode, so the live path stayed empty until restart. Rotation truncates
  // in place, shifts older segments down, and drops the oldest beyond the bound.
  it("rotates the live stderr log under an open append-mode writer and keeps a bounded number of segments", () => {
    const logPath = path.join(tempDir, "launchd-stderr.log");
    const fd = fs.openSync(logPath, "a");
    try {
      for (const segment of ["first", "second", "third"]) {
        fs.writeSync(fd, `${segment}\n`);
        rotateStderrLogSegments({ filePath: logPath, maxBytes: 5, keepSegments: 2 });
      }
      fs.writeSync(fd, "live\n");
      expect([logPath, `${logPath}.1`, `${logPath}.2`].map((file) => fs.readFileSync(file, "utf8")))
        .toEqual(["live\n", "third\n", "second\n"]);
      expect(fs.existsSync(`${logPath}.3`)).toBe(false);
    } finally {
      fs.closeSync(fd);
    }
  });
});

describe("preview log ownership", () => {
  it("rotates stdout and stderr with configured bounds and preserves production material", () => {
    const preview = path.join(tempDir, "preview"); fs.mkdirSync(preview);
    const stdout = path.join(preview, "stdout.log");
    const stderr = path.join(preview, "stderr.log");
    const production = path.join(tempDir, "production.log");
    fs.writeFileSync(production, "production sentinel");
    fs.writeFileSync(stdout, "preview stdout"); fs.writeFileSync(stderr, "preview stderr");
    db.prepare("INSERT OR REPLACE INTO settings(key,value,updated_at) VALUES('stderr_rotation_max_bytes','4',1),('stderr_rotation_keep_segments','2',1)").run();
    vi.stubEnv("MANDIBLE_INSTANCE_ROLE", "preview"); vi.stubEnv("MANDIBLE_PREVIEW_ROOT", preview);
    vi.stubEnv("MANDIBLE_STDOUT_LOG_PATH", stdout); vi.stubEnv("MANDIBLE_STDERR_LOG_PATH", stderr);
    try {
      configureDaemonLogger(db);
      expect(fs.statSync(stdout).size).toBe(0); expect(fs.statSync(stderr).size).toBe(0);
      expect(fs.readFileSync(`${stdout}.1`, "utf8")).toBe("preview stdout");
      expect(fs.readFileSync(production, "utf8")).toBe("production sentinel");
      fs.symlinkSync(production, `${stdout}.2`);
      fs.writeFileSync(stdout, "new preview stdout");
      expect(() => rotateStderrLogSegments({ filePath: stdout, maxBytes: 4, keepSegments: 2 })).toThrow(/symlink/);
      expect(fs.readFileSync(production, "utf8")).toBe("production sentinel");
    } finally { stopDaemonLogger(); vi.unstubAllEnvs(); }
  });
});

describe("daemon log retention", () => {
  const dayMs = 24 * 60 * 60 * 1_000;
  const now = Date.UTC(2026, 6, 14);

  function insertLog(id: string, ts: number): void {
    db.prepare(
      `INSERT INTO daemon_log (id, ts, level, event, subsystem, fields_json)
       VALUES (?, ?, 'info', 'retention_test', 'test', '{}')`,
    ).run(id, ts);
  }

  it("deletes only expired rows in bounded resumable batches", async () => {
    db.prepare("UPDATE settings SET value = '3' WHERE key = 'log_retention_days'").run();
    for (let index = 0; index < 7; index += 1) {
      insertLog(`old-${index}`, now - 4 * dayMs - index);
    }
    insertLog("cutoff", now - 3 * dayMs);
    insertLog("new", now - dayMs);

    const first = await pruneDaemonLogs(db, { now, batchSize: 2, maxBatches: 2, yieldMs: 0 });
    expect(first).toMatchObject({ retentionDays: 3, deleted: 4, batches: 2, hasMore: true });
    expect(db.prepare("SELECT COUNT(*) AS count FROM daemon_log").get()).toEqual({ count: 5 });

    const second = await pruneDaemonLogs(db, { now, batchSize: 2, maxBatches: 10, yieldMs: 0 });
    expect(second).toMatchObject({ retentionDays: 3, deleted: 3, hasMore: false });
    expect(db.prepare("SELECT id FROM daemon_log ORDER BY id").all()).toEqual([
      { id: "cutoff" },
      { id: "new" },
    ]);
  });

  it("drains an in-flight yielding retention batch before shutdown", async () => {
    vi.useFakeTimers();
    for (let index = 0; index < 3; index++) insertLog(`old-${index}`, now - 8 * dayMs);
    const retention = startDaemonLogRetention(db, () => {}, { now, initialDelayMs: 0, maxBatches: 2, batchSize: 1, yieldMs: 10 });
    try {
      await vi.advanceTimersByTimeAsync(0);
      let drained = false;
      const stopping = retention.stop().then(() => { drained = true; });
      expect(drained).toBe(false);
      await vi.advanceTimersByTimeAsync(10);
      await stopping;
      expect(drained).toBe(true);
      expect(db.prepare("SELECT COUNT(*) AS count FROM daemon_log").get()).toEqual({ count: 1 });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(db.prepare("SELECT COUNT(*) AS count FROM daemon_log").get()).toEqual({ count: 1 });
    } finally { await retention.stop(); vi.useRealTimers(); }
  });

  it("blocks retention when legacy verification cannot be inspected", async () => {
    insertLog("old", now - 8 * dayMs);
    vi.spyOn(db, "pragma").mockImplementation(() => { throw new Error("inspection unavailable"); });
    await expect(pruneDaemonLogs(db, { now })).rejects.toThrow(/verification failed/);
    expect(db.prepare("SELECT id FROM daemon_log").all()).toEqual([{ id: "old" }]);
    vi.restoreAllMocks();
  });
});

describe("request logging", () => {
  it("records file-RPC requests as structured daemon_log rows", async () => {
    const logger = configureDaemonLogger(db);
    const router = new Router({ logger });
    router.get("/api/ledger/issues/:issueId", (req, res) => {
      res.json({ issue_id: req.params.issueId });
    }, { operation: { id: "get:/api/ledger/issues/:issueId", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });
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
    flushDaemonLogger();

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
    }, { operation: { id: "get:/api/ping", effects: [], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });
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
    flushDaemonLogger();

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
  it("preserves filters, facets, and cursor pagination while both stores coexist", async () => {
    const canonicalPath = path.join(tempDir, "mandible.db");
    const opened = openOperationalLogStore(canonicalPath);
    if (!opened) throw new Error("expected operational log store");
    try {
      const insertLegacy = db.prepare(
        `INSERT INTO daemon_log
         (id, ts, level, event, subsystem, fields_json, issue_id)
         VALUES (?, ?, ?, ?, ?, '{}', ?)`,
      );
      const insertPrimary = opened.db.prepare(
        `INSERT INTO daemon_log
         (id, ts, level, event, subsystem, fields_json, issue_id)
         VALUES (?, ?, ?, ?, ?, '{}', ?)`,
      );
      insertLegacy.run("a", 1_000, "warn", "legacy-a", "auth", "issue-1");
      insertLegacy.run("b", 2_000, "error", "duplicate-b", "auth", "issue-1");
      insertPrimary.run("b", 2_000, "error", "duplicate-b", "auth", "issue-1");
      insertPrimary.run("c", 3_000, "warn", "primary-c", "auth", "issue-1");

      const routes = new TestRoutes();
      registerSystemRoutes(routes, { getRepos: () => [] }, opened.db);
      const newest = createResponse();
      await routes.handler("GET", "/api/system/logs")(request({
        levels: "warn,error",
        subsystem: "auth",
        related: "issue:issue-1",
        limit: "2",
      }), newest);
      const payload = newest.payload as {
        entries: Array<{ id: string }>;
        older_cursor: string;
        facets: { entity_refs: Array<{ type: string; value: string; count: number }> };
      };
      expect(payload.entries.map((entry) => entry.id)).toEqual(["b", "c"]);
      expect(payload.facets.entity_refs).toEqual([{ type: "issue", value: "issue-1", count: 3 }]);

      insertPrimary.run("d", 4_000, "warn", "new-d", "auth", "issue-1");
      const older = createResponse();
      await routes.handler("GET", "/api/system/logs")(request({
        levels: "warn,error",
        subsystem: "auth",
        related: "issue:issue-1",
        limit: "2",
        before: payload.older_cursor,
      }), older);
      expect((older.payload as { entries: Array<{ id: string }> }).entries.map((entry) => entry.id)).toEqual(["a"]);
    } finally {
      opened.close();
    }
  });
});
