import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openDb, type Db } from "../../src/db.js";
import {
  configureDaemonLogger,
  startDaemonLogRetention,
  stopDaemonLogger,
  daemonStderrLogPath,
  flushDaemonLogger,
  pruneDaemonLogs,
  rotateStderrLogSegments,
  runDaemonLogMaintenance,
} from "../../src/daemon-log.js";
import { FileRpcTransport } from "../../src/file-rpc-transport.js";
import { openOperationalLogStore } from "../../src/operational-log-db.js";
import { registerSystemRoutes } from "../../src/routes/system.js";
import { Router, createServer, type RouteHandler, type RouteOptions, type RouteRegistrar } from "../../src/server.js";
import { SseManager } from "../../src/sse.js";
import type { RequestLike, ResponseLike } from "../../src/server.js";

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

  // The daemon does not open this file: it writes to its own stderr, and its
  // spawner redirected that stderr here and holds the only descriptor. Rotating
  // by rename left that descriptor attached to the moved inode, so every later
  // line landed in a rotated segment and the live path stayed empty until the
  // process restarted. Truncating in place is what keeps the writer attached.
  it("keeps an open append-mode writer on the live path across a rotation", () => {
    const logPath = path.join(tempDir, "launchd-stderr.log");
    const fd = fs.openSync(logPath, "a");

    try {
      fs.writeSync(fd, "before-rotation\n");

      rotateStderrLogSegments({ filePath: logPath, maxBytes: 5, keepSegments: 2 });

      fs.writeSync(fd, "after-rotation\n");

      expect(fs.existsSync(logPath)).toBe(true);
      // O_APPEND recomputes the offset at every write, so the truncated live
      // file receives the post-rotation bytes at offset 0 rather than after a
      // hole the size of the rotated segment.
      expect(fs.readFileSync(logPath, "utf8")).toBe("after-rotation\n");
      expect(fs.readFileSync(`${logPath}.1`, "utf8")).toBe("before-rotation\n");
      expect(fs.readFileSync(`${logPath}.1`, "utf8")).not.toContain("after-rotation");
    } finally {
      fs.closeSync(fd);
    }
  });

  it("shifts segments on each rotation and drops the oldest beyond keepSegments", () => {
    const logPath = path.join(tempDir, "launchd-stderr.log");

    fs.writeFileSync(logPath, "first-segment", "utf8");
    rotateStderrLogSegments({ filePath: logPath, maxBytes: 5, keepSegments: 2 });
    expect(fs.readFileSync(logPath, "utf8")).toBe("");
    expect(fs.readFileSync(`${logPath}.1`, "utf8")).toBe("first-segment");

    fs.writeFileSync(logPath, "second-segment", "utf8");
    rotateStderrLogSegments({ filePath: logPath, maxBytes: 5, keepSegments: 2 });
    expect(fs.readFileSync(`${logPath}.1`, "utf8")).toBe("second-segment");
    expect(fs.readFileSync(`${logPath}.2`, "utf8")).toBe("first-segment");

    fs.writeFileSync(logPath, "third-segment", "utf8");
    rotateStderrLogSegments({ filePath: logPath, maxBytes: 5, keepSegments: 2 });
    expect(fs.readFileSync(`${logPath}.1`, "utf8")).toBe("third-segment");
    expect(fs.readFileSync(`${logPath}.2`, "utf8")).toBe("second-segment");
    expect(fs.existsSync(`${logPath}.3`)).toBe(false);
  });

  it("resolves the stderr log path from the environment or the cache default", () => {
    const defaultPath = path.join(os.homedir(), ".cache", "mandible", "launchd-stderr.log");
    const configured = path.join(tempDir, "preview", "stderr.log");

    process.env.MANDIBLE_STDERR_LOG_PATH = configured;
    expect(daemonStderrLogPath()).toBe(configured);

    expect(daemonStderrLogPath({ MANDIBLE_STDERR_LOG_PATH: "relative/stderr.log" }))
      .toBe(path.resolve("relative/stderr.log"));
    expect(daemonStderrLogPath({ MANDIBLE_STDERR_LOG_PATH: "   " })).toBe(defaultPath);
    expect(daemonStderrLogPath({})).toBe(defaultPath);
  });
});

describe("daemon log batching", () => {
  it("keeps persisted rows off the write path until the batch is flushed", () => {
    const logger = configureDaemonLogger(db);

    logger("info", "queued_row", { subsystem: "test" });
    logger("warn", "queued_warn", { subsystem: "test" });

    const before = db.prepare("SELECT COUNT(*) AS count FROM daemon_log").get() as { count: number };
    expect(before.count).toBe(0);

    flushDaemonLogger();

    const after = db
      .prepare("SELECT event FROM daemon_log ORDER BY ts, rowid")
      .all() as Array<{ event: string }>;
    expect(after).toEqual([{ event: "queued_row" }, { event: "queued_warn" }]);
  });

  it("is a no-op when there is nothing queued", () => {
    configureDaemonLogger(db);
    expect(() => flushDaemonLogger()).not.toThrow();
    flushDaemonLogger();
    const rows = db.prepare("SELECT COUNT(*) AS count FROM daemon_log").get() as { count: number };
    expect(rows.count).toBe(0);
  });

  it("abandons rows still queued against a previous connection on reconfigure", () => {
    const first = configureDaemonLogger(db);
    first("info", "orphaned_row", { subsystem: "test" });
    // Reconfigure to a fresh database without flushing; the stale row is dropped
    // rather than replayed against the wrong (or closed) connection.
    const nextDb = openDb(path.join(tempDir, "mandible-next.db"));
    try {
      const second = configureDaemonLogger(nextDb);
      second("info", "fresh_row", { subsystem: "test" });
      flushDaemonLogger();
      const rows = nextDb
        .prepare("SELECT event FROM daemon_log ORDER BY ts, rowid")
        .all() as Array<{ event: string }>;
      expect(rows).toEqual([{ event: "fresh_row" }]);
    } finally {
      // Restore the shared logger binding for the outer afterEach/db teardown.
      configureDaemonLogger(db);
      nextDb.close();
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

  it.each([undefined, "", "nope", "0", "366"])(
    "falls back to seven days for missing or invalid setting %s",
    async (value) => {
      if (value === undefined) {
        db.prepare("DELETE FROM settings WHERE key = 'log_retention_days'").run();
      } else {
        db.prepare("UPDATE settings SET value = ? WHERE key = 'log_retention_days'").run(value);
      }
      insertLog("expired", now - 8 * dayMs);
      insertLog("kept", now - 6 * dayMs);

      const result = await pruneDaemonLogs(db, { now, yieldMs: 0 });

      expect(result.retentionDays).toBe(7);
      expect(db.prepare("SELECT id FROM daemon_log").all()).toEqual([{ id: "kept" }]);
    },
  );

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

  it("guards blocking vacuum behind explicit acknowledgement", () => {
    expect(() => runDaemonLogMaintenance(db, { vacuum: true })).toThrow(/allowBlockingVacuum/);

    const checkpoint = runDaemonLogMaintenance(db, { checkpoint: true });
    const vacuum = runDaemonLogMaintenance(db, {
      checkpoint: false,
      vacuum: true,
      allowBlockingVacuum: true,
    });

    expect(checkpoint.vacuumed).toBe(false);
    expect(checkpoint.checkpoint).toBeInstanceOf(Array);
    expect(vacuum).toEqual({ checkpoint: null, vacuumed: true });
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

  it("pages older rows with a stable cursor when newer rows arrive", async () => {
    const insert = db.prepare(
      `INSERT INTO daemon_log
       (id, ts, level, event, subsystem, fields_json)
       VALUES (?, ?, 'info', ?, 'test', '{}')`,
    );
    insert.run("a", 1000, "event-a");
    insert.run("b", 1000, "event-b");
    insert.run("c", 2000, "event-c");

    const routes = new TestRoutes();
    registerSystemRoutes(routes, { getRepos: () => [] }, db);
    const newest = createResponse();
    await routes.handler("GET", "/api/system/logs")(request({ level: "debug", limit: "2" }), newest);
    const newestPayload = newest.payload as {
      entries: Array<{ id: string }>;
      older_cursor: string;
      has_older: boolean;
    };
    expect(newestPayload.entries.map((entry) => entry.id)).toEqual(["b", "c"]);
    expect(newestPayload.has_older).toBe(true);

    insert.run("d", 3000, "event-d");
    const older = createResponse();
    await routes.handler("GET", "/api/system/logs")(request({
      level: "debug",
      limit: "2",
      before: newestPayload.older_cursor,
    }), older);

    expect((older.payload as { entries: Array<{ id: string }> }).entries.map((entry) => entry.id)).toEqual(["a"]);
  });

  it("returns daemon_log rows when a database is provided", async () => {
    const logger = configureDaemonLogger(db);
    logger("warn", "system_route_row", { subsystem: "test", issue_id: "issue-route" });
    flushDaemonLogger();

    const routes = new TestRoutes();
    registerSystemRoutes(routes, { getRepos: () => [] }, db);
    const res = createResponse();

    await routes.handler("GET", "/api/system/logs")(request({ level: "debug", limit: "10" }), res);

    expect(res.statusCode).toBe(200);
    expect(res.payload).toMatchObject({ source: "daemon_log", exists: true });
    expect((res.payload as { entries: Array<Record<string, unknown>> }).entries[0]).toMatchObject({
      event: "system_route_row",
      subsystem: "test",
      issue_id: "issue-route",
    });
  });

  it("applies structured filters and returns facets from daemon_log", async () => {
    const logger = configureDaemonLogger(db);
    logger("debug", "reaper_tick", { subsystem: "reconciler", repo_id: "mandible" });
    logger("info", "http_request", { subsystem: "http", pathname: "/api/issues/abc123", status: 200 });
    logger("error", "auth_failure", {
      subsystem: "auth",
      auth_request_id: "auth-1",
      issue_id: "issue-1",
      detail: "needle",
    });
    logger("warn", "auth_warning", { subsystem: "auth", auth_request_id: "auth-2" });
    flushDaemonLogger();

    const routes = new TestRoutes();
    registerSystemRoutes(routes, { getRepos: () => [] }, db);
    const res = createResponse();

    await routes.handler("GET", "/api/system/logs")(request({
      levels: "error,warn",
      subsystem: "auth",
      q: "needle",
      related: "auth:auth-1",
      limit: "10",
    }), res);

    expect(res.statusCode).toBe(200);
    expect(res.payload).toMatchObject({ source: "daemon_log", exists: true });
    const payload = res.payload as {
      entries: Array<Record<string, unknown>>;
      facets: {
        subsystems: Array<{ value: string; count: number }>;
        events: Array<{ value: string; count: number }>;
        entity_refs: Array<{ type: string; value: string; count: number }>;
      };
    };
    expect(payload.entries[0]).toMatchObject({
      level: "error",
      event: "auth_failure",
      auth_request_id: "auth-1",
      issue_id: "issue-1",
    });
    expect(payload.facets.subsystems).toEqual([{ value: "auth", count: 1 }]);
    expect(payload.facets.events).toEqual([{ value: "auth_failure", count: 1 }]);
    expect(payload.facets.entity_refs).toContainEqual({ type: "auth_request", value: "auth-1", count: 1 });
    expect(payload.facets.entity_refs).toContainEqual({ type: "issue", value: "issue-1", count: 1 });
  });
});
