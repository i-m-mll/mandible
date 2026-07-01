import http from "node:http";
import net from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attachWebSocketUpgrade, createServer, Router } from "../src/server.js";
import { SseManager } from "../src/sse.js";
import type { Db } from "../src/db.js";

interface TestServer {
  port: number;
  server: http.Server;
}

let testServer: TestServer | null = null;

beforeEach(async () => {
  const router = new Router();
  router.post("/api/write", (req, res) => {
    res.json({ ok: true, body: req.body });
  }, { fileRpc: "deny" });
  router.get("/api/read", (_req, res) => {
    res.json({ ok: true });
  }, { fileRpc: "deny" });

  const server = createServer({
    db: {} as Db,
    sse: new SseManager(),
    logger: () => undefined,
    version: "test",
    router,
    getStartupInfo: () => null,
  });
  attachWebSocketUpgrade(server, (_req, socket) => {
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
    );
    socket.destroy();
  });
  const port = await listen(server);
  testServer = { port, server };
});

afterEach(async () => {
  if (testServer) {
    await close(testServer.server);
    testServer = null;
  }
});

describe("daemon write boundary", () => {
  it("allows local non-browser writes without Origin or Fetch Metadata headers", async () => {
    const response = await requestJson("POST", "/api/write", { hello: "cli" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, body: { hello: "cli" } });
  });

  it("allows browser same-origin writes from the daemon origin", async () => {
    const { port } = requireServer();
    const response = await requestJson("POST", "/api/write", { hello: "ui" }, {
      Origin: `http://127.0.0.1:${port}`,
      "Sec-Fetch-Site": "same-origin",
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, body: { hello: "ui" } });
  });

  it("rejects cross-origin browser writes before dispatching the route", async () => {
    const response = await requestJson("POST", "/api/write", { hello: "evil" }, {
      Origin: "https://example.com",
      "Sec-Fetch-Site": "cross-site",
    });

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ error: "forbidden", reason: "cross_site_fetch" });
  });

  it("rejects DNS-rebinding style writes with a non-loopback Host", async () => {
    const response = await requestJson("POST", "/api/write", { hello: "evil" }, {
      Host: "example.com:19420",
      Origin: "http://example.com:19420",
    });

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ error: "forbidden", reason: "invalid_host" });
  });

  it("does not apply the write boundary to safe reads", async () => {
    const response = await requestJson("GET", "/api/read", undefined, {
      Origin: "https://example.com",
      "Sec-Fetch-Site": "cross-site",
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
  });

  it("rejects cross-origin browser WebSocket upgrades", async () => {
    const response = await requestUpgrade("/terminal/session-1", {
      Origin: "https://example.com",
      "Sec-Fetch-Site": "cross-site",
    });

    expect(response).toContain("HTTP/1.1 403 Forbidden");
  });
});

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
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function requestJson(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  const { port } = requireServer();
  const data = body === undefined ? "" : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          ...(data
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(data).toString(),
              }
            : {}),
          ...headers,
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          try {
            resolve({
              status: res.statusCode ?? 500,
              body: raw ? JSON.parse(raw) : null,
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("error", reject);
    req.end(data);
  });
}

function requestUpgrade(path: string, headers: Record<string, string>): Promise<string> {
  const { port } = requireServer();
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port }, () => {
      const lines = [
        `GET ${path} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
        "",
        "",
      ];
      socket.write(lines.join("\r\n"));
    });
    let raw = "";
    socket.on("data", (chunk) => {
      raw += chunk.toString("utf8");
    });
    socket.on("end", () => resolve(raw));
    socket.on("close", () => resolve(raw));
    socket.on("error", reject);
  });
}
