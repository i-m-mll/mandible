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
  router.post("/api/issues/test-write", (req, res) => {
    res.json({ ok: true, body: req.body });
  }, { operation: { id: "fixture:post:/api/issues/test-write", effects: ["ledger:write"], requestSchema: null, reportingCategory: "data-write" }, fileRpc: "deny" });
  router.get("/api/read", (_req, res) => {
    res.json({ ok: true });
  }, { operation: { id: "fixture:get:/api/read", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });


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
    const response = await requestJson("POST", "/api/issues/test-write", { hello: "cli" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, body: { hello: "cli" } });
  });

  it("rejects cross-site writes even when legacy gateway headers are supplied", async () => {
    const response = await requestJson("POST", "/api/issues/test-write", {}, {
      Host: "app.mandible.localhost:19420",
      Origin: "https://app.mandible.localhost:19420",
      "Sec-Fetch-Site": "cross-site",
      "X-Mandible-Legacy-Migration": "complete-v1",
    });
    expect(response).toMatchObject({ status: 403, body: { reason: "cross_site_fetch" } });
  });

  it("allows browser same-origin writes from the daemon origin", async () => {
    const response = await requestJson("POST", "/api/issues/test-write", { hello: "ui" }, {
      Host: "app.mandible.localhost:19420",
      Origin: "https://app.mandible.localhost:19420",
      "Sec-Fetch-Site": "same-origin",
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, body: { hello: "ui" } });
  });

  it("rejects cross-origin browser writes before dispatching the route", async () => {
    const response = await requestJson("POST", "/api/issues/test-write", { hello: "evil" }, {
      Host: "app.mandible.localhost:19420",
      Origin: "https://example.com",
      "Sec-Fetch-Site": "cross-site",
    });

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ error: "forbidden", reason: "cross_site_fetch" });
  });

  it("rejects DNS-rebinding style writes with a non-loopback Host", async () => {
    const response = await requestJson("POST", "/api/issues/test-write", { hello: "evil" }, {
      Host: "example.com:19420",
      Origin: "http://example.com:19420",
    });

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ error: "forbidden", reason: "invalid_host" });
  });

  it("applies the registered browser origin boundary to safe reads", async () => {
    const response = await requestJson("GET", "/api/read", undefined, {
      Host: "app.mandible.localhost:19420",
      Origin: "https://example.com",
      "Sec-Fetch-Site": "cross-site",
    });

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ error: "forbidden", reason: "cross_site_fetch" });
  });

  it("admits only a top-level document navigation from another app origin", async () => {
    const navigation = {
      Host: "app.mandible.localhost:19420",
      "Sec-Fetch-Site": "cross-site",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Dest": "document",
    };
    expect(await requestStatus("GET", "/", navigation)).toBe(200);
    expect((await requestJson("GET", "/api/read", undefined, navigation)).body)
      .toMatchObject({ reason: "cross_site_fetch" });
    expect(await requestStatus("GET", "/", { ...navigation, "Sec-Fetch-Dest": "iframe" })).toBe(403);
    expect(await requestStatus("GET", "/", { ...navigation, Origin: "https://example.com" })).toBe(403);
    expect(await requestStatus("GET", "/", { ...navigation, Host: "example.com:19420" })).toBe(403);
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

function requestStatus(method: string, path: string, headers: Record<string, string>): Promise<number> {
  const { port } = requireServer();
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path, method, headers }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 500));
    });
    req.on("error", reject);
    req.end();
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
