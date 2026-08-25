// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

import {
  clientAuthWebSocketProtocols,
  ensureClientAuthToken,
  getStoredToken,
  installClientAuthFetch,
} from "../../ui/src/client-auth-token.js";
import { SSEClient } from "../../ui/src/sse-client.js";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();

  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

beforeEach(() => {
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: new MemoryStorage(),
  });
});

afterEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
});

describe("dashboard client-auth enrollment", () => {
  it("adopts a same-user fragment credential, strips it, and renews with Authorization", async () => {
    window.history.replaceState(null, "", "/#/issues?repo=mandible&mandible_auth=bootstrap-secret");
    let writeAttempts = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const authorization = new Headers(init?.headers).get("Authorization");
      if (url === "/api/client-auth/handshake") {
        const token = authorization === "Bearer bootstrap-secret"
          ? "dashboard-session"
          : "renewed-dashboard-session";
        return new Response(JSON.stringify({ token }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/write") {
        writeAttempts += 1;
        return new Response(null, {
          status: authorization === "Bearer renewed-dashboard-session" ? 200 : 401,
        });
      }
      return new Response(null, { status: 404 });
    });
    window.fetch = fetchMock as typeof window.fetch;
    installClientAuthFetch();

    await expect(ensureClientAuthToken()).resolves.toBe("dashboard-session");
    expect(getStoredToken()).toBe("dashboard-session");
    expect(window.location.hash).toBe("#/issues?repo=mandible");
    expect(window.location.href).not.toContain("bootstrap-secret");

    const recovered = await window.fetch("/api/write", { method: "POST" });
    expect(recovered.status).toBe(200);
    expect(writeAttempts).toBe(2);
    expect(getStoredToken()).toBe("renewed-dashboard-session");
    expect(clientAuthWebSocketProtocols()).toEqual([
      "mandible",
      "mandible-auth.renewed-dashboard-session",
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/client-auth/handshake",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer dashboard-session",
        }),
      }),
    );
  });

  it("has the Tauri shell request a one-time protected proof and redirect with a fragment", () => {
    const bootstrap = fs.readFileSync(
      path.join(process.cwd(), "src-tauri", "bootstrap", "bootstrap.js"),
      "utf8",
    );
    const rust = fs.readFileSync(
      path.join(process.cwd(), "src-tauri", "src", "lib.rs"),
      "utf8",
    );
    expect(bootstrap).toContain('invoke("client_auth_enroll")');
    expect(bootstrap).toContain('invoke("client_auth_keychain_enroll", { route: "/" })');
    expect(bootstrap.indexOf('invoke("client_auth_keychain_enroll"'))
      .toBeGreaterThan(bootstrap.indexOf('invoke("client_auth_enroll")'));
    expect(bootstrap.indexOf('window.location.replace(`http://127.0.0.1:',
      bootstrap.indexOf('invoke("client_auth_keychain_enroll"')))
      .toBeGreaterThan(bootstrap.indexOf('invoke("client_auth_keychain_enroll"'));
    expect(bootstrap).not.toContain("mandible_auth=");
    expect(rust).toContain("CLIENT_AUTH_BOOTSTRAP_CONSUMED.swap(true");
    expect(rust).toContain("fn enrollment_precheck(app: &AppHandle)");
    expect(rust).toContain("verify_same_user_daemon()");
    expect(rust).toContain("refusing desktop enrollment for a daemon owned by another user");
    expect(rust).not.toContain("let expected_entry = resolve_daemon_entry(app)?");
    expect(rust).toContain("window.location.replace({encoded})");
    // The bootstrap path passes no route, so this still resolves to `#/?mandible_auth=`
    // (see normalize_enrollment_route); the keychain path reuses the same builder.
    expect(rust).toContain("/#{route}{separator}{CREDENTIAL_QUERY_PARAM}={token}");
    expect(rust).toContain('const CREDENTIAL_QUERY_PARAM: &str = "mandible_auth"');
    expect(rust).toContain('join("client-auth")');
    expect(rust).toContain('join("bootstrap-token")');
  });
});

describe("dashboard SSE transport", () => {
  it("uses an authenticated-header-capable POST stream and never a query bearer", async () => {
    window.localStorage.setItem("mandible.client_auth.token", "dashboard-session");
    let requestedUrl = "";
    let requestedInit: RequestInit | undefined;
    const encoder = new TextEncoder();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requestedUrl = String(input);
      requestedInit = init;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"type":"test:event","data":{"ok":true}}\n\n'));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    });
    const client = new SSEClient({ fetchImpl: fetchImpl as typeof fetch });
    const received = new Promise<void>((resolve) => {
      client.on("test:event", () => {
        client.close();
        resolve();
      });
    });

    client.connect();
    await received;
    expect(requestedUrl).toBe("/api/events/subscribe");
    expect(requestedUrl).not.toContain("token=");
    expect(requestedInit?.method).toBe("POST");
  });
});
