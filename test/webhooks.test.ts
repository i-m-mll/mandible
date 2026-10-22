/**
 * Tests for webhook ingestion endpoint.
 * Bug: 9f66ad9
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setDb } from "../src/db.js";
import { startDaemon, type DaemonHandle } from "../src/index.js";
import { mintApiToken } from "../src/client-auth/tokens.js";
import { setupOperator } from "../src/users/store.js";

interface TempPaths {
  dir: string;
  dbPath: string;
  pidFilePath: string;
}

let authToken = "";

function createTempPaths(): TempPaths {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-webhook-"));
  return {
    dir,
    dbPath: path.join(dir, "mandible.db"),
    pidFilePath: path.join(dir, "daemon.pid"),
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
      try { server.close(); } catch { /* ignore */ }
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

function postJson(
  port: number,
  urlPath: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: urlPath,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
          Authorization: `Bearer ${authToken}`,
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 500, body: JSON.parse(raw) });
          } catch {
            reject(new Error(`Failed to parse response: ${raw}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.end(data);
  });
}

function getJson(
  port: number,
  urlPath: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: urlPath,
        method: "GET",
        headers: { Authorization: `Bearer ${authToken}` },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 500, body: JSON.parse(raw) });
          } catch {
            reject(new Error(`Failed to parse response: ${raw}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe.sequential("webhook ingestion", () => {
  let temp: TempPaths | null = null;
  let daemon: DaemonHandle | null = null;
  const priorSocket = process.env.MANDIBLE_SOCKET;

  beforeAll(async () => {
    temp = createTempPaths();
    process.env.MANDIBLE_SOCKET = path.join(temp.dir, "api.sock");
    const port = await getAvailablePort();
    if (!port) throw new Error("Could not get available port");
    daemon = await startDaemon({
      port,
      dbPath: temp.dbPath,
      pidFilePath: temp.pidFilePath,
      handleSignals: false,
      clientAuthDir: path.join(temp.dir, "client-auth"),
    });
    const operator = setupOperator(daemon.db, { display_name: "Webhook test operator" });
    const pepper = fs.readFileSync(path.join(temp.dir, "client-auth", "pepper"), "utf8").trim();
    authToken = mintApiToken(daemon.db, pepper, operator.id, { label: "webhook-test" }).token;
  });

  // The per-test backstop clears the database singleton; the shared daemon
  // reinstalls its own for each test.
  beforeEach(() => {
    setDb(daemon!.db);
  });

  afterAll(async () => {
    if (priorSocket === undefined) delete process.env.MANDIBLE_SOCKET;
    else process.env.MANDIBLE_SOCKET = priorSocket;
    if (daemon) {
      await daemon.close();
      daemon = null;
    }
    if (temp) {
      cleanupTemp(temp.dir);
      temp = null;
    }
  });

  it("queues webhook when no target specified", async () => {
    const { status, body } = await postJson(daemon!.port, "/api/webhooks/ingest", {
      source: "github",
      event_type: "pr_review",
      title: "PR #42 approved",
      data: { pr: 42, action: "approved" },
    });
    expect(status).toBe(200);
    expect(body.status).toBe("queued");
    expect(body.delivered_to).toBeNull();
    expect(body.id).toBeDefined();
    expect(typeof body.id).toBe("string");
  });

  it("queues webhook when target_session not found", async () => {
    const { status, body } = await postJson(daemon!.port, "/api/webhooks/ingest", {
      source: "ci",
      event_type: "build_failed",
      target_session: "nonexistent-session-id",
      data: { build: 123 },
    });
    expect(status).toBe(200);
    expect(body.status).toBe("queued");
    expect(body.delivered_to).toBeNull();
  });

  it("dismisses a queued webhook", async () => {
    const { body: ingestBody } = await postJson(
      daemon!.port,
      "/api/webhooks/ingest",
      {
        source: "monitoring",
        event_type: "alert",
        data: { severity: "low" },
      },
    );

    const webhookId = ingestBody.id as string;
    const { status, body } = await postJson(
      daemon!.port,
      `/api/webhooks/${webhookId}/dismiss`,
      {},
    );
    expect(status).toBe(200);
    expect(body.ok).toBe(true);

    const { body: listBody } = await getJson(
      daemon!.port,
      "/api/webhooks?status=pending",
    );
    expect((listBody.events as Array<{ id: string }>).map((event) => event.id)).not.toContain(webhookId);
  });

  it("includes pending webhooks in inbox", async () => {
    await postJson(daemon!.port, "/api/webhooks/ingest", {
      source: "ci",
      event_type: "build_failed",
      title: "Build #99 failed",
      data: {},
      target_branch: "feature/foo",
    });

    const { status, body } = await getJson(daemon!.port, "/api/inbox");
    expect(status).toBe(200);
    const webhooks = body.pending_webhooks as Array<Record<string, unknown>>;
    expect(webhooks).toContainEqual(expect.objectContaining({
      source: "ci",
      event_type: "build_failed",
      title: "Build #99 failed",
    }));
  });

  it("returns 422 when delivering to nonexistent session", async () => {
    const { body: ingestBody } = await postJson(
      daemon!.port,
      "/api/webhooks/ingest",
      { source: "ci", event_type: "test", data: {} },
    );
    const { status, body } = await postJson(
      daemon!.port,
      `/api/webhooks/${ingestBody.id}/deliver`,
      { target_session: "nonexistent" },
    );
    expect(status).toBe(422);
    expect(body.error).toBe("delivery_failed");
  });
});
