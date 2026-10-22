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
import { autoStartDaemon, checkHealth, stopDaemon } from "../src/lifecycle.js";
import { waitUntil } from "./helpers/wait-until.js";

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
    const daemon = await startDaemon({
      port: 0,
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
    const daemon = await startDaemon({
      port: 0,
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
    const daemon = await startDaemon({
      port: 0,
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
    expect(port).toBeGreaterThan(0);
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const rootDir = path.resolve(currentDir, "..");
    // Bun runs the source entry directly, so this boundary needs no prior build.
    const entryPath = path.join(rootDir, "src", "index.ts");

    await autoStartDaemon({
      port,
      dbPath: temp!.dbPath,
      pidFilePath: temp!.pidFilePath,
      entryPath
    });

    expect((await waitUntil(() => checkHealth(port), "the auto-started daemon to answer health")).status).toBe("ok");
    expect(stopDaemon(temp!.pidFilePath)).toBe(true);
    await waitUntil(async () => (await checkHealth(port)) === null, "the stopped daemon to stop answering health");
  });
});
