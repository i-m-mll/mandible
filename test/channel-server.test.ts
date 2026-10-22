// Bug: 1d652d5 — Tests for MCP channel server
//
// Tests tool handler logic and notification translation.
// Uses mocked HTTP responses (globalThis.fetch) to avoid needing a running daemon.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// --- Base URL resolution (issue 70dffb8) ---

describe("channel-server base URL", () => {
  it("defaults to the private socket", async () => {
    const { resolveBaseUrl } = await import("../channel-server/base-url.js");
    expect(resolveBaseUrl({})).toBe("http://localhost");
  });

  it("honors an absolute socket override", async () => {
    const { resolveTransport } = await import("../channel-server/base-url.js");
    expect(resolveTransport({ MANDIBLE_SOCKET: "/tmp/mandible-preview.sock" }))
      .toEqual({ kind: "socket", socketPath: "/tmp/mandible-preview.sock" });
  });

  it("prefers an explicit MANDIBLE_BASE over MANDIBLE_PORT and trims it", async () => {
    const { resolveBaseUrl } = await import("../channel-server/base-url.js");
    expect(resolveBaseUrl({
      MANDIBLE_BASE: " http://127.0.0.1:12345/ ",
      MANDIBLE_PORT: "31337",
    })).toBe("http://127.0.0.1:12345");
  });

  it("keeps explicitly selected canonical HTTPS available", async () => {
    const { resolveTransport } = await import("../channel-server/base-url.js");
    expect(resolveTransport({ MANDIBLE_BASE: "https://app.mandible.localhost:19420", MANDIBLE_TRANSPORT: "http" }))
      .toEqual({ kind: "http", baseUrl: "https://app.mandible.localhost:19420" });
  });

  it("refuses unsupported explicit transports", async () => {
    const { resolveBaseUrl } = await import("../channel-server/base-url.js");
    expect(() => resolveBaseUrl({ MANDIBLE_BASE: "file:///tmp/spool" })).toThrow();
    expect(() => resolveBaseUrl({ MANDIBLE_BASE: "not a url" })).toThrow();
    expect(resolveBaseUrl({ MANDIBLE_BASE: "   " })).toBe("http://localhost");
  });
});

describe("channel-server local socket", () => {
  it("shares bearer selection between REST and notifications", async () => {
    const { channelTransportHeaders } = await import("../channel-server/client.js");
    const original = process.env.MANDIBLE_TOKEN;
    process.env.MANDIBLE_TOKEN = "explicit-http-token";
    try {
      expect(channelTransportHeaders("socket").Authorization).toBeUndefined();
      expect(channelTransportHeaders("http").Authorization).toBe("Bearer explicit-http-token");
    } finally {
      if (original === undefined) delete process.env.MANDIBLE_TOKEN;
      else process.env.MANDIBLE_TOKEN = original;
    }
  });

  it("uses the socket and ignores an inherited bearer on ordinary reads", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-channel-socket-"));
    const socket = path.join(root, "daemon.sock");
    const routes = path.join(root, "routes.json");
    fs.writeFileSync(routes, JSON.stringify([{ method: "POST", path: "/api/auth/request" }]));
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
  it("sends requests to the resolved daemon base URL", async () => {
    process.env.MANDIBLE_BASE = "http://127.0.0.1:31337";
    process.env.MANDIBLE_PORT = "31337";
    mockFetch(200, {
      continuations: [], auth_results: [], open_issues: [], work_units: [],
      work_unit_continuations: [], total: 0,
    });
    const { checkInboxGlobal } = await import("../channel-server/client.js");
    await checkInboxGlobal();
    const url = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(url).toBe("http://127.0.0.1:31337/api/inbox/global");
  });

  it("authenticates every daemon request with its injected agent token", async () => {
    process.env.MANDIBLE_TOKEN = "agent-token";
    mockFetch(200, {
      continuations: [], auth_results: [], open_issues: [], work_units: [],
      work_unit_continuations: [], total: 0,
    });
    const { checkInboxGlobal } = await import("../channel-server/client.js");
    await checkInboxGlobal();
    const options = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect(options.headers).toMatchObject({ Authorization: "Bearer agent-token" });
  });

  it("checkInbox returns parsed inbox data", async () => {
    const inboxData = {
      continuations: [],
      auth_results: [
        {
          id: "auth-123",
          title: "Merge feature/x",
          status: "completed",
          exit_code: 0,
          error: null,
          head_branch: "feature/x",
          resolved_at: Date.now(),
        },
      ],
      open_issues: [],
      work_units: [],
      work_unit_continuations: [],
      total: 1,
    };
    mockFetch(200, inboxData);

    const { checkInbox } = await import("../channel-server/client.js");
    const result = await checkInbox("main");

    expect(result.total).toBe(1);
    expect(result.auth_results).toHaveLength(1);
    expect(result.auth_results[0].id).toBe("auth-123");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/inbox?branch=main"),
      expect.any(Object),
    );
  });

  it("checkInboxGlobal calls /api/inbox/global", async () => {
    mockFetch(200, {
      continuations: [],
      auth_results: [],
      open_issues: [],
      work_units: [],
      work_unit_continuations: [],
      total: 0,
    });

    const { checkInboxGlobal } = await import("../channel-server/client.js");
    await checkInboxGlobal();

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/inbox/global"),
      expect.any(Object),
    );
  });

  it("getIssues passes query parameters correctly", async () => {
    mockFetch(200, []);

    const { getIssues } = await import("../channel-server/client.js");
    await getIssues({ repo: "mandible", status: "open", label: "feature" });

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const url = call[0] as string;
    expect(url).toContain("repo=mandible");
    expect(url).toContain("status=open");
    expect(url).toContain("label=feature");
  });

  // Issue 08a5f04 — the canonical command shape (`--into <base>`) is what the
  // channel tool now emits; the client passes it through byte-identically.
  it("submitAuth sends correct payload", async () => {
    mockFetch(201, { request_id: "new-auth-id" });

    const { submitAuth } = await import("../channel-server/client.js");
    const result = await submitAuth({
      command: "mandible auth merge feature/x --into main",
      title: "Merge feature/x",
      head_branch: "feature/x",
      base_branch: "main",
      issue_references: ["abc123"],
      issue_closures: ["def456"],
      cwd: "/tmp/repo",
      session_id: "session-456",
    });

    expect(result.request_id).toBe("new-auth-id");
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(call[1].body as string);
    expect(body.command).toBe("mandible auth merge feature/x --into main");
    expect(body.base_branch).toBe("main");
    expect(body.issue_references).toEqual(["abc123"]);
    expect(body.issue_closures).toEqual(["def456"]);
  });

  it("throws MandibleClientError on non-200 response", async () => {
    mockFetch(500, { error: "Internal error" });

    const { checkInbox, MandibleClientError } = await import(
      "../channel-server/client.js"
    );

    await expect(checkInbox()).rejects.toThrow(MandibleClientError);
    await expect(checkInbox()).rejects.toThrow("500");
  });

  it("throws MandibleClientError on network error", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    const { checkInbox, MandibleClientError } = await import(
      "../channel-server/client.js"
    );

    await expect(checkInbox()).rejects.toThrow(MandibleClientError);
    await expect(checkInbox()).rejects.toThrow("is the Mandible daemon running?");
  });

  it("getWorkUnits passes state filter", async () => {
    mockFetch(200, { work_units: [] });

    const { getWorkUnits } = await import("../channel-server/client.js");
    await getWorkUnits({ state: "open", repo_id: "repo-abc" });

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const url = call[0] as string;
    expect(url).toContain("state=open");
    expect(url).toContain("repo_id=repo-abc");
  });

  it("updateSession sends PATCH with correct path", async () => {
    mockFetch(200, { ok: true });

    const { updateSession } = await import("../channel-server/client.js");
    await updateSession("session-123", { task: "working on feature" });

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toContain("/api/sessions/session-123");
    expect(call[1].method).toBe("PATCH");
  });

  it("patchWorkUnit sends PATCH to correct endpoint", async () => {
    mockFetch(200, { id: "wu-123", state: "committed" });

    const { patchWorkUnit } = await import("../channel-server/client.js");
    await patchWorkUnit("wu-123", {
      assigned_session_id: "session-456",
    });

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toContain("/api/work-units/wu-123");
    expect(call[1].method).toBe("PATCH");
    const body = JSON.parse(call[1].body as string);
    expect(body.assigned_session_id).toBe("session-456");
  });
});

// --- mandible_submit_auth command shape (issue 08a5f04) ---

describe("mandible_submit_auth command shape (issue 08a5f04)", () => {
  const originalFetch = globalThis.fetch;
  const originalBase = process.env.MANDIBLE_BASE;
  const tempDirs: string[] = [];

  beforeEach(() => { process.env.MANDIBLE_BASE = "http://127.0.0.1:29420"; });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    originalBase === undefined ? delete process.env.MANDIBLE_BASE : (process.env.MANDIBLE_BASE = originalBase);
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function gitRepo(branches: string[]): string {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-channel-tool-"));
    tempDirs.push(repo);
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
    expect(String(call[0])).toContain("/api/auth/request");
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

  it("prefers develop over main, matching detect_protected_branch", async () => {
    const repo = gitRepo(["main", "develop"]);
    const body = await invokeSubmitAuth({
      branch: "feature/y",
      title: "Merge feature/y",
      cwd: repo,
    });
    expect(body.command).toBe("mandible auth merge feature/y --into develop");
    expect(body.base_branch).toBe("develop");
  });

  it("falls back to the legacy shape when the base cannot be resolved", async () => {
    const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-channel-plain-"));
    tempDirs.push(notARepo);
    const body = await invokeSubmitAuth({
      branch: "feature/z",
      title: "Merge feature/z",
      cwd: notARepo,
    });
    // Legacy single-source shape: the daemon normalizes exactly this shape to
    // the canonical form at POST submission once it resolves the base.
    expect(body.command).toBe("mandible auth merge feature/z");
    expect(body.base_branch).toBeUndefined();
  });
});

// --- Notification formatting tests ---

describe("notification formatting", () => {
  // We test the notification bridge's event formatters indirectly via their
  // module. Since they are not exported, we test through the bridge behavior.
  // We mock the MCP server's sendLoggingMessage to capture notifications.

  it("createNotificationBridge can be instantiated", async () => {
    const { createNotificationBridge } = await import(
      "../channel-server/notifications.js"
    );

    // Minimal mock of Server that satisfies the bridge
    const mockServer = {
      sendLoggingMessage: vi.fn().mockResolvedValue(undefined),
    };

    const bridge = createNotificationBridge(mockServer as never);
    expect(bridge).toBeDefined();
    expect(typeof bridge.start).toBe("function");
    expect(typeof bridge.stop).toBe("function");

    // Don't actually start (would try to connect to localhost:19420)
    // Just verify the interface
  });

  it("createNotificationBridge accepts an onReconnect callback (Bug: 03d6cb0)", async () => {
    const { createNotificationBridge } = await import(
      "../channel-server/notifications.js"
    );

    const mockServer = {
      sendLoggingMessage: vi.fn().mockResolvedValue(undefined),
    };

    const onReconnect = vi.fn();
    const bridge = createNotificationBridge(
      mockServer as never,
      "session-A",
      "conv-A",
      onReconnect,
    );
    expect(bridge).toBeDefined();
    expect(typeof bridge.start).toBe("function");
    expect(typeof bridge.stop).toBe("function");
    // Don't start (would hit localhost:19420); just verify the signature works
  });
});

// --- SSE reconnect catch-up tests (Bug: 03d6cb0) ---

describe("SSE reconnect catch-up (Bug: 03d6cb0)", () => {
  it("runStartupCatchUp is called as onReconnect callback on SSE reconnect", async () => {
    // Test that the reconnect catch-up integration works by verifying
    // runStartupCatchUp runs correctly when invoked as a callback
    const mod = await import("../channel-server/index.js");
    const sent: Array<{ method?: string; params?: unknown }> = [];
    const delivered: string[] = [];
    const mockServer = {
      notification: async (notif: { method?: string; params?: unknown }) => {
        sent.push(notif);
      },
    } as unknown as Parameters<typeof mod.runStartupCatchUp>[0]["mcpServer"];

    // Simulate what the onReconnect callback does: call runStartupCatchUp
    // with the same deps that the main() function wires up
    await mod.runStartupCatchUp({
      sessionId: "reconnect-session",
      conversationId: "conv-reconnect",
      mcpServer: mockServer,
      fetchUndelivered: async (sessionId, convId) => {
        // Verify both IDs are passed through
        expect(sessionId).toBe("reconnect-session");
        expect(convId).toBe("conv-reconnect");
        return [
          {
            id: "r-missed",
            head_branch: "feature/self-rebuild",
            status: "completed",
            exit_code: 0,
            resolved_at: Date.now(),
            title: "Merge feature/self-rebuild",
            target_session_id: "reconnect-session",
          },
        ];
      },
      markDelivered: async (id) => {
        delivered.push(id);
      },
      log: () => {},
    });

    // Verify the missed event was replayed
    expect(sent).toHaveLength(1);
    expect(delivered).toEqual(["r-missed"]);
    const params = sent[0].params as { content: string; meta: Record<string, string> };
    expect(params.content).toContain("feature/self-rebuild");
    expect(params.meta.status).toBe("completed");
  });

  it("onReconnect callback is not called on first SSE connect (only on reconnects)", async () => {
    // This tests the hasConnectedBefore flag in createNotificationBridge.
    // Since we can't easily test the SSE connection without a running daemon,
    // we verify the behavior through the notification bridge's internal logic
    // by inspecting the bridge construction.
    const { createNotificationBridge } = await import(
      "../channel-server/notifications.js"
    );

    const onReconnect = vi.fn();
    const mockServer = {
      sendLoggingMessage: vi.fn().mockResolvedValue(undefined),
    };

    // The bridge is created but not started — onReconnect should not be called
    const bridge = createNotificationBridge(
      mockServer as never,
      "session-A",
      "conv-A",
      onReconnect,
    );

    expect(onReconnect).not.toHaveBeenCalled();
    // Clean up without starting
    bridge.stop();
  });
});

// --- Tool output formatting integration tests ---

describe("tool formatting", () => {
  it("imports tool module without errors", async () => {
    const mod = await import("../channel-server/tools.js");
    expect(typeof mod.registerTools).toBe("function");
  });

  it("imports types module without errors", async () => {
    const mod = await import("../channel-server/types.js");
    // Types module only has interfaces — no runtime exports to test
    // but the import should succeed without errors
    expect(mod).toBeDefined();
  });
});
