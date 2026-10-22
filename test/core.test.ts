import { afterEach, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import SqliteDatabase from "../src/sqlite.ts";
import { fileURLToPath } from "node:url";
import { CURRENT_SCHEMA_VERSION, openDb, migrate } from "../src/db.js";
import { startDaemon } from "../src/index.js";
import { autoStartDaemon, checkHealth, stopDaemon, waitForHealth } from "../src/lifecycle.js";

interface TempPaths {
  dir: string;
  dbPath: string;
  pidFilePath: string;
}

function createTempPaths(): TempPaths {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-"));
  return {
    dir,
    dbPath: path.join(dir, "mandible.db"),
    pidFilePath: path.join(dir, "daemon.pid")
  };
}

function cleanupTemp(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

async function getAvailablePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer();
    const finalize = (port: number) => {
      resolve(port);
      try {
        server.close();
      } catch {
        // ignore
      }
    };
    server.once("error", () => finalize(0));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "object" && address) {
        finalize(address.port);
      } else {
        finalize(0);
      }
    });
  });
}

async function waitForNoHealth(
  port: number,
  timeoutMs: number = 3000,
  intervalMs: number = 200,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const health = await checkHealth(port);
    if (!health) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

describe.sequential("mandible daemon", () => {
  let temp: TempPaths | null = null;
  const priorSessionAuthorityDir = process.env.MANDIBLE_LOCAL_SESSION_AUTHORITY_DIR;
const priorSocket = process.env.MANDIBLE_SOCKET;

  beforeEach(() => {
    temp = createTempPaths();
    process.env.MANDIBLE_LOCAL_SESSION_AUTHORITY_DIR = path.join(temp.dir, "local-sessions");
    process.env.MANDIBLE_SOCKET = path.join(temp.dir, "api.sock");
  });

  afterEach(() => {
    if (priorSocket === undefined) delete process.env.MANDIBLE_SOCKET;
    else process.env.MANDIBLE_SOCKET = priorSocket;
    if (priorSessionAuthorityDir === undefined) delete process.env.MANDIBLE_LOCAL_SESSION_AUTHORITY_DIR;
    else process.env.MANDIBLE_LOCAL_SESSION_AUTHORITY_DIR = priorSessionAuthorityDir;
    if (temp) {
      cleanupTemp(temp.dir);
      temp = null;
    }
  });

  it("starts server and responds to health", async () => {
    const port = await getAvailablePort();
    if (!port) {
      return;
    }
    const daemon = await startDaemon({
      port,
      dbPath: temp!.dbPath,
      pidFilePath: temp!.pidFilePath,
      handleSignals: false
    });

    const health = await checkHealth(daemon.port);
    expect(health?.status).toBe("ok");

    await daemon.close();

    const canonical = new SqliteDatabase(temp!.dbPath, { readonly: true });
    const operational = new SqliteDatabase(
      path.join(temp!.dir, "mandible.operational-logs.db"),
      { readonly: true },
    );
    try {
      expect(canonical.prepare("SELECT COUNT(*) AS count FROM daemon_log").get()).toEqual({ count: 0 });
      expect(Number((operational.prepare("SELECT COUNT(*) AS count FROM daemon_log").get() as { count: number }).count))
        .toBeGreaterThan(0);
    } finally {
      operational.close();
      canonical.close();
    }
  });

  it("does not expose the retired anonymous GET SSE endpoint", async () => {
    const port = await getAvailablePort();
    if (!port) {
      return;
    }
    const daemon = await startDaemon({
      port,
      dbPath: temp!.dbPath,
      pidFilePath: temp!.pidFilePath,
      handleSignals: false
    });

    const request = http.request({
      hostname: "127.0.0.1",
      port: daemon.port,
      path: "/api/events",
      method: "GET"
    });

    const response = new Promise<number>((resolve, reject) => {
      request.on("response", (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 500));
      });
      request.on("error", reject);
    });

    request.end();

    expect(await response).toBe(404);

    await daemon.close();
  });

  it("runs migrations on fresh database", async () => {
    const db = openDb(temp!.dbPath);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((row) => row.name);

    expect(names).toContain("meta");
    expect(names).toContain("sessions");
    expect(names).toContain("auth_requests");
    expect(names).toContain("branches");
    expect(names).toContain("ledger_issues");
    expect(names).toContain("ledger_events");
    expect(names).toContain("ledger_comments");

    const versionRow = db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;
    expect(versionRow?.value).toBe(String(CURRENT_SCHEMA_VERSION));

    db.close();
  });

  it("keeps migrations idempotent", async () => {
    const db = openDb(temp!.dbPath);
    migrate(db);
    migrate(db);
    const versionRow = db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;
    expect(versionRow?.value).toBe(String(CURRENT_SCHEMA_VERSION));
    db.close();
  });

  it("creates and removes pid file on lifecycle", async () => {
    const port = await getAvailablePort();
    if (!port) {
      return;
    }
    const daemon = await startDaemon({
      port,
      dbPath: temp!.dbPath,
      pidFilePath: temp!.pidFilePath,
      handleSignals: false
    });

    expect(fs.existsSync(temp!.pidFilePath)).toBe(true);
    const content = fs.readFileSync(temp!.pidFilePath, "utf8").trim();
    expect(Number(content)).toBe(process.pid);

    await daemon.close();
    expect(fs.existsSync(temp!.pidFilePath)).toBe(false);
  });

  it("auto-starts daemon and waits for health", async () => {
    const port = await getAvailablePort();
    if (!port) {
      return;
    }
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const rootDir = path.resolve(currentDir, "..");
    const entryPath = path.join(rootDir, "dist", "index.js");

    await autoStartDaemon({
      port,
      dbPath: temp!.dbPath,
      pidFilePath: temp!.pidFilePath,
      entryPath
    });

    const health = await waitForHealth(port, 10_000, 200);
    expect(health?.status).toBe("ok");

    const stopped = stopDaemon(temp!.pidFilePath);
    expect(stopped).toBe(true);

    const drained = await waitForNoHealth(port, 10_000, 200);
    expect(drained).toBe(true);
  }, 15_000);
});
