// @vitest-environment node
// Bug: 645f8a8 — daemon readiness gate for self-merge rebuilds (backend).
//
// Verifies the lifecycle-owned readiness flag and that the /api/health endpoint
// reports `ready` from the injected readiness source (not merely "listener
// alive"), independently of the rebuilding flag.
import http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createServer, Router, type ClientAuthGate } from "../src/server.js";
import { SseManager } from "../src/sse.js";
import {
  isDaemonReady,
  isDaemonWarm,
  setDaemonReady,
  setDaemonWarm,
} from "../src/lifecycle.js";
import type { Db } from "../src/db.js";
import type { HealthResponse } from "../src/types.js";

interface TestServer {
  port: number;
  server: http.Server;
}

let testServer: TestServer | null = null;

function startServer(opts: {
  isReady?: () => boolean;
  isWarm?: () => boolean;
  isRebuilding?: () => boolean;
  startupEpoch?: string;
  clientAuth?: ClientAuthGate;
}): Promise<TestServer> {
  const router = new Router();
  const server = createServer({
    db: {} as Db,
    sse: new SseManager(),
    logger: () => undefined,
    version: "test",
    router,
    getStartupInfo: () => null,
    startupEpoch: opts.startupEpoch,
    clientAuth: opts.clientAuth,
    isReady: opts.isReady,
    isWarm: opts.isWarm,
    isRebuilding: opts.isRebuilding,
    getMemoryDiagnostics: () => ({
      rss: 100,
      heapTotal: 80,
      heapUsed: 60,
      external: 20,
      arrayBuffers: 10,
      uptime: 5,
      totalMemory: 1_000,
      rssFraction: 0.1,
      warningThresholdFraction: 0.1,
      warning: true,
      highWater: { rss: 120, heapTotal: 90, heapUsed: 70, external: 30, arrayBuffers: 15 },
    }),
    getEventLoopDiagnostics: () => ({
      p50Ms: 12,
      p95Ms: 125,
      maxMs: 180,
      highWaterMs: 220,
      warning: true,
      backgroundBackoffMs: 100,
    }),
  });
  return listen(server).then((port) => {
    testServer = { port, server };
    return testServer;
  });
}

afterEach(async () => {
  if (testServer) {
    await close(testServer.server);
    testServer = null;
  }
});

describe("lifecycle readiness flags", () => {
  beforeEach(() => {
    setDaemonReady(false);
    setDaemonWarm(false);
  });

  it("tracks warm independently from mutation readiness", () => {
    expect(isDaemonWarm()).toBe(false);
    setDaemonReady(true);
    expect(isDaemonWarm()).toBe(false);
    setDaemonWarm(true);
    expect(isDaemonWarm()).toBe(true);
  });
});

describe("/api/health readiness", () => {
  it("reports ready:false while the daemon is still starting", async () => {
    let ready = false;
    await startServer({ isReady: () => ready });

    const first = await getHealth();
    expect(first.status).toBe("ok");
    expect(first.ready).toBe(false);
    // A starting daemon is not rebuilding — readiness is a distinct signal.
    expect(first.rebuilding).toBeUndefined();
    expect(first.memory).toMatchObject({
      rss: 100,
      heapUsed: 60,
      heapTotal: 80,
      external: 20,
      arrayBuffers: 10,
      uptime: 5,
      warning: true,
      highWater: { rss: 120 },
    });
    expect(first.eventLoop).toMatchObject({
      p95Ms: 125,
      highWaterMs: 220,
      warning: true,
      backgroundBackoffMs: 100,
    });

    // Once critical startup work completes, the same listener reports ready.
    ready = true;
    const second = await getHealth();
    expect(second.ready).toBe(true);
  });

  it("reports both ready and rebuilding independently (old daemon mid self-merge)", async () => {
    // The OLD daemon during a self-merge is ready (it served fine) but
    // rebuilding — the UI must keep the splash up on rebuilding regardless.
    await startServer({ isReady: () => true, isRebuilding: () => true });
    const health = await getHealth();
    expect(health.ready).toBe(true);
    expect(health.rebuilding).toBe(true);
  });

  it("reports warm independently after first-pass startup reconciliation", async () => {
    let warm = false;
    await startServer({ isReady: () => true, isWarm: () => warm });
    expect((await getHealth()).warm).toBe(false);
    warm = true;
    expect((await getHealth()).warm).toBe(true);
  });

  it("exposes a per-start epoch independently of startup commit compatibility", async () => {
    await startServer({ startupEpoch: "daemon-start-2" });
    expect((await getHealth()).startup_epoch).toBe("daemon-start-2");
  });

  it("reports the agent auth mode", async () => {
    await startServer({
      clientAuth: {
        mode: () => "strict",
        credentialDirectory: () => "/tmp/mandible-test-client-auth",
      } as ClientAuthGate,
    });
    expect((await getHealth()).client_auth).toMatchObject({ mode: "strict" });
  });
});

function getHealth(): Promise<HealthResponse> {
  const { port } = requireServer();
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: "/api/health", method: "GET" },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data) as HealthResponse);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function requireServer(): TestServer {
  if (!testServer) {
    throw new Error("test server is not running");
  }
  return testServer;
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const address = server.address();
      if (typeof address !== "object" || !address) {
        reject(new Error("test server did not expose a port"));
        return;
      }
      resolve(address.port);
    });
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
