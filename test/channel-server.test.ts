// @vitest-environment node
// Bug: 1d652d5 — the MCP channel server: transport and bearer rules, the
// canonical auth submission shape, and replay of results missed while the
// notification stream was down. Daemon responses are mocked through fetch.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { scratchDir } from "./helpers/cli-process.js";

// --- Base URL resolution (issue 70dffb8) ---

describe("channel-server base URL", () => {
  it("defaults to the private socket, honors explicit overrides, and refuses unsupported transports", async () => {
    const { resolveBaseUrl, resolveTransport } = await import("../channel-server/base-url.js");
    expect(resolveBaseUrl({})).toBe("http://localhost");
    expect(resolveBaseUrl({ MANDIBLE_BASE: "   " })).toBe("http://localhost");
    expect(resolveTransport({ MANDIBLE_SOCKET: "/tmp/mandible-preview.sock" })).toEqual({ kind: "socket", socketPath: "/tmp/mandible-preview.sock" });
    // Issue 70dffb8: an explicit base wins over MANDIBLE_PORT.
    expect(resolveBaseUrl({ MANDIBLE_BASE: " http://127.0.0.1:12345/ ", MANDIBLE_PORT: "31337" })).toBe("http://127.0.0.1:12345");
    expect(resolveTransport({ MANDIBLE_BASE: "https://app.mandible.localhost:19420", MANDIBLE_TRANSPORT: "http" }))
      .toEqual({ kind: "http", baseUrl: "https://app.mandible.localhost:19420" });
    expect(() => resolveBaseUrl({ MANDIBLE_BASE: "file:///tmp/spool" })).toThrow();
    expect(() => resolveBaseUrl({ MANDIBLE_BASE: "not a url" })).toThrow();
  });
});

describe("channel-server local socket", () => {
  it("uses the socket and ignores an inherited bearer on ordinary reads", async () => {
    // Directly under the temp dir: a path below the runtime root exceeds the 104-byte socket path limit.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-channel-socket-"));
    const socket = path.join(root, "daemon.sock");
    const routes = path.join(root, "routes.json");
    fs.writeFileSync(routes, fs.readFileSync(path.resolve("cli/local-credential-routes.json")));
    const original = { base: process.env.MANDIBLE_BASE, socket: process.env.MANDIBLE_SOCKET,
      token: process.env.MANDIBLE_TOKEN, routes: process.env.MANDIBLE_LOCAL_CREDENTIAL_ROUTES_FILE };
    const received: Array<{ url?: string; auth?: string; managed?: string }> = [];
    const server = http.createServer((req, res) => {
      received.push({ url: req.url, auth: req.headers.authorization,
        managed: req.headers["x-mandible-managed-client"] as string | undefined });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"continuations":[],"auth_results":[],"open_issues":[],"work_units":[],"work_unit_continuations":[],"total":0}');
    });
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    try {
      process.env.MANDIBLE_BASE = "https://app.mandible.localhost:19420";
      process.env.MANDIBLE_SOCKET = socket;
      process.env.MANDIBLE_TOKEN = "stale-token";
      process.env.MANDIBLE_LOCAL_CREDENTIAL_ROUTES_FILE = routes;
      const { checkInboxGlobal } = await import("../channel-server/client.js");
      await checkInboxGlobal();
      expect(received).toEqual([{ url: "/api/inbox/global", auth: undefined, managed: "1" }]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      for (const [key, value] of Object.entries({ MANDIBLE_BASE: original.base, MANDIBLE_SOCKET: original.socket,
        MANDIBLE_TOKEN: original.token, MANDIBLE_LOCAL_CREDENTIAL_ROUTES_FILE: original.routes })) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// --- Client tests (mocked fetch) ---

describe("channel-server client", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => { process.env.MANDIBLE_BASE = "http://127.0.0.1:29420"; });

  function mockFetch(
    status: number,
    body: unknown,
    options?: { delay?: number },
  ): void {
    globalThis.fetch = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          const res = {
            ok: status >= 200 && status < 300,
            status,
            statusText: status === 200 ? "OK" : "Error",
            json: async () => body,
          };
          if (options?.delay) {
            setTimeout(() => resolve(res), options.delay);
          } else {
            resolve(res);
          }
        }),
    );
  }

  const originalBase = process.env.MANDIBLE_BASE;
  const originalPort = process.env.MANDIBLE_PORT;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.MANDIBLE_TOKEN;
    originalBase === undefined
      ? delete process.env.MANDIBLE_BASE
      : (process.env.MANDIBLE_BASE = originalBase);
    originalPort === undefined
      ? delete process.env.MANDIBLE_PORT
      : (process.env.MANDIBLE_PORT = originalPort);
  });

  // Issue 70dffb8 — the client used to hardcode http://localhost:19420.
  it("sends every request to the resolved base URL with the injected agent token", async () => {
    process.env.MANDIBLE_BASE = "http://127.0.0.1:31337";
    process.env.MANDIBLE_TOKEN = "agent-token";
    mockFetch(200, { continuations: [], auth_results: [], open_issues: [], work_units: [], work_unit_continuations: [], total: 0 });
    const { checkInboxGlobal, channelTransportHeaders } = await import("../channel-server/client.js");
    await checkInboxGlobal();
    const [url, options] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:31337/api/inbox/global");
    expect(options.headers).toMatchObject({ Authorization: "Bearer agent-token" });
    expect(channelTransportHeaders("socket").Authorization).toBeUndefined();
  });

  it("reports daemon failures and an unreachable daemon as MandibleClientError", async () => {
    const { checkInbox, MandibleClientError } = await import("../channel-server/client.js");
    mockFetch(500, { error: "Internal error" });
    await expect(checkInbox()).rejects.toThrow(MandibleClientError);
    await expect(checkInbox()).rejects.toThrow("500");
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(checkInbox()).rejects.toThrow("is the Mandible daemon running?");
  });
});

// --- mandible_submit_auth command shape (issue 08a5f04) ---

describe("mandible_submit_auth command shape (issue 08a5f04)", () => {
  const originalFetch = globalThis.fetch;
  const originalBase = process.env.MANDIBLE_BASE;

  beforeEach(() => { process.env.MANDIBLE_BASE = "http://127.0.0.1:29420"; });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    originalBase === undefined ? delete process.env.MANDIBLE_BASE : (process.env.MANDIBLE_BASE = originalBase);
  });

  function gitRepo(branches: string[]): string {
    const repo = scratchDir("channel-tool");
    const git = (args: string[]) =>
      execFileSync("git", args, { cwd: repo, encoding: "utf8" });
    git(["init", "-b", branches[0]]);
    git(["config", "user.name", "Channel Tool Test"]);
    git(["config", "user.email", "channel-tool@localhost"]);
    git(["config", "commit.gpgsign", "false"]);
    fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
    git(["add", "."]);
    git(["commit", "-m", "init"]);
    for (const branch of branches.slice(1)) {
      git(["branch", branch]);
    }
    return repo;
  }

  async function invokeSubmitAuth(
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      statusText: "Created",
      json: async () => ({ request_id: "tool-auth-id" }),
    });
    const { registerTools } = await import("../channel-server/tools.js");
    const handlers = new Map<string, (a: Record<string, unknown>) => Promise<unknown>>();
    const mockServer = {
      tool: (
        name: string,
        _description: string,
        _schema: unknown,
        handler: (a: Record<string, unknown>) => Promise<unknown>,
      ) => {
        handlers.set(name, handler);
      },
    };
    // sessionId null — registration/liveness calls are skipped, so the only
    // fetch is the auth submission itself.
    registerTools(mockServer as never, null);
    const handler = handlers.get("mandible_submit_auth");
    if (!handler) throw new Error("mandible_submit_auth not registered");
    await handler(args);
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(call[0])).toContain("/api/auth/v2/request");
    return JSON.parse((call[1] as RequestInit).body as string);
  }

  it("emits the canonical --into form with the detected main base", async () => {
    const repo = gitRepo(["main"]);
    const body = await invokeSubmitAuth({
      branch: "feature/x",
      title: "Merge feature/x",
      cwd: repo,
      message: "Ship x\n\nVerification:\nTests pass.\n",
      verification: "Tests pass.",
    });
    expect(body.command).toBe("mandible auth merge feature/x --into main");
    // Issue 4720024 — the tool always submits a canonical change message.
    expect(body.canonical_message).toBe(true);
    expect(body.commit_message).toBe("Ship x\n\nVerification:\nTests pass.\n");
    expect(body.verification).toBe("Tests pass.");
    expect(body.base_branch).toBe("main");
    expect(body.head_branch).toBe("feature/x");
    expect(body.cwd).toBe(repo);
  });

  it("derives the base like detect_protected_branch, and keeps the legacy shape when it cannot", async () => {
    const develop = await invokeSubmitAuth({ branch: "feature/y", title: "Merge feature/y", cwd: gitRepo(["main", "develop"]) });
    expect(develop.command).toBe("mandible auth merge feature/y --into develop");
    expect(develop.base_branch).toBe("develop");
    const notARepo = scratchDir("channel-plain");
    // The daemon normalizes exactly this legacy shape to the canonical form once it resolves the base.
    const legacy = await invokeSubmitAuth({ branch: "feature/z", title: "Merge feature/z", cwd: notARepo });
    expect(legacy.command).toBe("mandible auth merge feature/z");
    expect(legacy.base_branch).toBeUndefined();
  });
});

// --- SSE reconnect catch-up tests (Bug: 03d6cb0) ---

describe("SSE reconnect catch-up (Bug: 03d6cb0)", () => {
  it("replays a result missed during shutdown once on reconnect", async () => {
    const mod = await import("../channel-server/index.js");
    const sent: Array<{ method?: string; params?: unknown }> = [];
    const delivered: string[] = [];
    let available = false;
    const deps: Parameters<typeof mod.runStartupCatchUp>[0] = {
      sessionId: "reconnect-session", conversationId: "conv-reconnect",
      mcpServer: { notification: async notif => { sent.push(notif); } } as Parameters<typeof mod.runStartupCatchUp>[0]["mcpServer"],
      fetchUndelivered: async (session, conversation) => {
        expect([session, conversation]).toEqual(["reconnect-session", "conv-reconnect"]);
        return available && !delivered.length ? [{ id: "r-missed", head_branch: "feature/self-rebuild", status: "completed",
          exit_code: 0, resolved_at: 1, title: "Merge feature/self-rebuild", target_session_id: "reconnect-session" }] : [];
      },
      markDelivered: async id => { expect(sent).toHaveLength(1); delivered.push(id); },
      log: () => {},
    };
    const onReconnect = () => mod.runStartupCatchUp(deps);
    await onReconnect();
    expect(sent).toEqual([]);
    // The daemon persisted completion while the live stream was disconnected.
    available = true;
    await onReconnect();
    await onReconnect();
    expect(sent).toHaveLength(1);
    expect(delivered).toEqual(["r-missed"]);
    expect(sent[0].params).toMatchObject({ meta: { status: "completed" }, content: expect.stringContaining("feature/self-rebuild") });
  });

});

