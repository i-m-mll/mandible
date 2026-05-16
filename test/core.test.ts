import { afterEach, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, migrate } from "../src/db.js";
import { startDaemon } from "../src/index.js";
import { autoStartDaemon, checkHealth, stopDaemon, waitForHealth } from "../src/lifecycle.js";
import type { SSEEvent } from "../src/types.js";

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

async function readSseEvent(
  res: http.IncomingMessage,
  predicate: (event: SSEEvent) => boolean = () => true,
): Promise<SSEEvent> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    res.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let index = buffer.indexOf("\n\n");
      while (index >= 0) {
        const raw = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const parsed = parseSse(raw);
        if (parsed && predicate(parsed)) {
          resolve(parsed);
          return;
        }
        index = buffer.indexOf("\n\n");
      }
    });
    res.on("error", reject);
    res.on("end", () => reject(new Error("SSE closed before event")));
  });
}

function parseSse(raw: string): SSEEvent | null {
  const lines = raw.split("\n");
  let data: string | null = null;
  for (const line of lines) {
    if (line.startsWith(":")) {
      continue;
    }
    if (line.startsWith("data:")) {
      data = line.slice("data:".length).trim();
    }
  }
  if (!data) {
    return null;
  }
  try {
    return JSON.parse(data) as SSEEvent;
  } catch {
    return null;
  }
}

describe.sequential("mandible daemon", () => {
  let temp: TempPaths | null = null;

  beforeEach(() => {
    temp = createTempPaths();
  });

  afterEach(() => {
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
  });

  it("streams SSE events", async () => {
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

    const sent: SSEEvent = {
      type: "session:registered",
      data: { ok: true },
      timestamp: new Date().toISOString()
    };

    const eventPromise = new Promise<SSEEvent>((resolve, reject) => {
      request.on("response", async (res) => {
        setTimeout(() => {
          daemon.sse.broadcast(sent);
        }, 50);
        try {
          const event = await readSseEvent(res, (candidate) => candidate.type === sent.type);
          resolve(event);
        } catch (error) {
          reject(error);
        }
      });
    });

    request.end();

    const received = await eventPromise;
    expect(received.type).toBe(sent.type);
    expect(received.data).toEqual(sent.data);

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
    expect(names).toContain("ledger_outbox");

    const versionRow = db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;
    expect(versionRow?.value).toBe("55");

    db.close();
  });

  it("keeps migrations idempotent", async () => {
    const db = openDb(temp!.dbPath);
    migrate(db);
    migrate(db);
    const versionRow = db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;
    expect(versionRow?.value).toBe("55");
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

    const drained = await waitForHealth(port, 10_000, 200);
    expect(drained).toBeNull();
  }, 15_000);
});
