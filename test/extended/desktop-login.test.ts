// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  AUTOMATIC_ENROLLMENT_SOURCES, DesktopLoginRecoveryCoordinator,
  MANUAL_ENROLLMENT_SOURCES, attemptDesktopLogin,
  recoverDesktopLoginAutomatically, type DesktopLoginDeps,
} from "../../ui/src/desktop-login.js";
import { enrollDesktopClientAuth, isDesktopShell, startDesktopDaemon } from "../../ui/src/api.js";
import {
  __resetBrowserSessionForTests,
  browserSessionFetch,
  getClientAuthSessionState,
  initializeBrowserSession,
  subscribeClientAuthSessionState,
} from "../../ui/src/client-auth-token.js";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

beforeEach(() => {
  __resetBrowserSessionForTests();
  Object.defineProperty(window, "localStorage", { configurable: true, value: new MemoryStorage() });
});

function deps(overrides: Partial<DesktopLoginDeps> = {}): DesktopLoginDeps {
  return { enroll: async () => false, refreshSession: async () => "signed-out", ...overrides };
}

describe("desktop recovery episodes", () => {
  it("shares one automatic attempt and rearms only after reset", async () => {
    const coordinator = new DesktopLoginRecoveryCoordinator();
    let resolve!: (outcome: "enrolled") => void;
    const run = () => new Promise<"enrolled">((done) => { resolve = done; });
    const first = coordinator.recover(run);
    expect(coordinator.recover(run)).toBe(first);
    resolve("enrolled");
    await expect(first).resolves.toBe("enrolled");
    coordinator.reset();
    await expect(coordinator.recover(async () => "enrolled")).resolves.toBe("enrolled");
  });

  it("permits manual retry only after automatic recovery could not enroll", async () => {
    const coordinator = new DesktopLoginRecoveryCoordinator();
    const manual = async () => "enrolled" as const;
    await expect(coordinator.retry(manual)).resolves.toBe("unavailable");
    await expect(coordinator.recover(async () => "failed")).resolves.toBe("failed");
    await expect(coordinator.retry(manual)).resolves.toBe("enrolled");
  });
});

describe("desktop enrollment source ordering", () => {
  it("uses only the one-shot bootstrap source automatically", async () => {
    const attempted: string[] = [];
    const outcome = await attemptDesktopLogin(AUTOMATIC_ENROLLMENT_SOURCES, deps({
      enroll: async (source) => { attempted.push(source); return false; },
    }));
    expect(outcome).toBe("unavailable");
    expect(attempted).toEqual(["bootstrap"]);
  });

  it("uses only the keychain source for explicit retry", async () => {
    const attempted: string[] = [];
    await attemptDesktopLogin(MANUAL_ENROLLMENT_SOURCES, deps({
      enroll: async (source) => { attempted.push(source); return true; },
      refreshSession: async () => "enrolled",
    }));
    expect(attempted).toEqual(["keychain"]);
  });

  it("stops after the first source that produces a working session", async () => {
    const attempted: string[] = [];
    const outcome = await attemptDesktopLogin(["bootstrap", "keychain"], deps({
      enroll: async (source) => { attempted.push(source); return true; },
      refreshSession: async () => "enrolled",
    }));
    expect(outcome).toBe("enrolled");
    expect(attempted).toEqual(["bootstrap"]);
  });

  it("continues after a source error when another explicit source remains", async () => {
    const attempted: string[] = [];
    const outcome = await attemptDesktopLogin(["bootstrap", "keychain"], deps({
      enroll: async (source) => {
        attempted.push(source);
        if (source === "bootstrap") throw new Error("bootstrap refused");
        return true;
      },
      refreshSession: async () => "enrolled",
    }));
    expect(outcome).toBe("enrolled");
    expect(attempted).toEqual(["bootstrap", "keychain"]);
  });

  it("fails when enrollment does not produce a browser session", async () => {
    await expect(attemptDesktopLogin(["keychain"], deps({
      enroll: async () => true,
    }))).resolves.toBe("failed");
  });

  it("reports enrollment errors without trying an unauthorized fallback", async () => {
    const errors: string[] = [];
    const outcome = await attemptDesktopLogin(AUTOMATIC_ENROLLMENT_SOURCES, deps({
      enroll: async () => { throw new Error("wrong daemon owner"); },
      onError: (message) => errors.push(message),
    }));
    expect(outcome).toBe("failed");
    expect(errors).toEqual(["wrong daemon owner"]);
  });
});

describe("desktop shell command bridge", () => {
  type TauriTestWindow = typeof window & { __TAURI__?: unknown; __TAURI_INTERNALS__?: unknown };
  afterEach(() => {
    delete (window as TauriTestWindow).__TAURI__;
    delete (window as TauriTestWindow).__TAURI_INTERNALS__;
  });

  it("invokes enrollment through the Tauri command bridge", async () => {
    const calls: Array<{ command: string; args: unknown }> = [];
    (window as TauriTestWindow).__TAURI__ = { core: { invoke: async (command: string, args: unknown) => {
      calls.push({ command, args }); return true;
    } } };
    expect(isDesktopShell()).toBe(true);
    await expect(enrollDesktopClientAuth("keychain")).resolves.toBe(true);
    expect(calls).toEqual([{ command: "client_auth_keychain_enroll", args: { route: null } }]);
  });

  it("reports a plain browser without attempting native recovery", async () => {
    expect(isDesktopShell()).toBe(false);
    await expect(recoverDesktopLoginAutomatically()).resolves.toBe("unavailable");
    await expect(startDesktopDaemon()).rejects.toThrow("Tauri app");
  });

  it("uses the internals bridge accepted by the desktop runtime check", async () => {
    const calls: string[] = [];
    (window as TauriTestWindow).__TAURI_INTERNALS__ = { invoke: async (command: string) => {
      calls.push(command); return true;
    } };
    await expect(enrollDesktopClientAuth("bootstrap")).resolves.toBe(true);
    expect(calls).toEqual(["client_auth_enroll"]);
  });
});

describe("browser-session recovery", () => {
  const enrolled = (csrf = "csrf-1") => new Response(JSON.stringify({ authenticated: true, session: {
    family_id: "family-1", audience: "production", csrf_token: csrf,
    effect_ceiling: ["ledger:read", "ledger:write"],
  } }), { status: 200, headers: { "content-type": "application/json" } });

  it("distinguishes unreachable, rejected, and enrolled session states", async () => {
    const states: string[] = [];
    const unsubscribe = subscribeClientAuthSessionState((state) => states.push(state));
    await expect(initializeBrowserSession(async () => { throw new Error("offline"); })).resolves.toBe("unreachable");
    __resetBrowserSessionForTests();
    await expect(initializeBrowserSession(async () => new Response(JSON.stringify({
      authenticated: false, failure_reason: "wrong_audience",
    }), { status: 401 }))).resolves.toBe("wrong-audience");
    __resetBrowserSessionForTests();
    await expect(initializeBrowserSession(async () => enrolled())).resolves.toBe("enrolled");
    expect(getClientAuthSessionState()).toBe("enrolled");
    unsubscribe();
    expect(states).toContain("unreachable");
  });

  it("retires a legacy fragment and bearer only after a cookie session is confirmed", async () => {
    window.localStorage.setItem("mandible.client_auth.token", "legacy-bearer");
    window.history.replaceState(null, "", "/#/auth?mandible_auth=legacy-bearer&repo=mandible");
    await initializeBrowserSession(async () => enrolled());
    expect(window.localStorage.getItem("mandible.client_auth.token")).toBeNull();
    expect(window.location.hash).toBe("#/auth?repo=mandible");
  });

  it("renews once after a mid-session 401 and retries the original route", async () => {
    await initializeBrowserSession(async () => enrolled());
    const calls: string[] = [];
    let writes = 0;
    const fetchImpl = async (input: RequestInfo | URL) => {
      const url = String(input); calls.push(url);
      if (url === "/api/client-auth/renew") return enrolled("csrf-2");
      writes += 1;
      return new Response(null, { status: writes === 1 ? 401 : 200 });
    };
    const response = await browserSessionFetch("/api/write", { method: "POST" }, fetchImpl);
    expect(response.status).toBe(200);
    expect(calls).toEqual(["/api/write", "/api/client-auth/renew", "/api/write"]);
  });

  it("publishes revoked when renewal proves the session family was revoked", async () => {
    await initializeBrowserSession(async () => enrolled());
    let calls = 0;
    const response = await browserSessionFetch("/api/write", { method: "POST" }, async () => {
      calls += 1;
      return calls === 1 ? new Response(null, { status: 401 })
        : new Response(JSON.stringify({ error: "session_revoked" }), { status: 401 });
    });
    expect(response.status).toBe(401);
    expect(getClientAuthSessionState()).toBe("revoked");
  });
});

describe("desktop native origin boundary", () => {
  it("exposes commands only to the exact registered production HTTPS origin", () => {
    const rust = fs.readFileSync(path.join(process.cwd(), "src-tauri", "src", "lib.rs"), "utf8");
    const permission = fs.readFileSync(path.join(process.cwd(), "src-tauri", "permissions", "desktop.toml"), "utf8");
    const capability = JSON.parse(fs.readFileSync(
      path.join(process.cwd(), "src-tauri", "capabilities", "default.json"), "utf8",
    )) as { remote?: { urls?: string[] }; permissions?: string[] };
    const registered = rust.match(/generate_handler!\[([\s\S]*?)\]\)/)?.[1]
      .split(",").map((command) => command.trim()).filter(Boolean);
    const permitted = permission.match(/commands\.allow = \[([\s\S]*?)\]/)?.[1]
      .match(/"([^"]+)"/g)?.map((command) => command.slice(1, -1));
    expect(permitted).toEqual(registered);
    expect(capability.remote?.urls).toEqual(["https://app.mandible.localhost:19420"]);
    expect(rust).toContain("origin == PRODUCTION_ORIGIN");
    expect(capability.permissions).toContain("allow-desktop-commands");
  });

  it("installs the HttpOnly browser session inside native code", () => {
    const rust = fs.readFileSync(path.join(process.cwd(), "src-tauri", "src", "lib.rs"), "utf8");
    expect(rust).toContain("fn install_browser_session(");
    expect(rust).toContain("credential.fill(0);");
    expect(rust).toContain("native enrollment is available only to the registered production origin");
    expect(rust).not.toContain("mandible_auth=");
  });

  it("spends bootstrap proof only after a definitive daemon response", () => {
    const rust = fs.readFileSync(path.join(process.cwd(), "src-tauri", "src", "lib.rs"), "utf8");
    const bootstrap = rust.slice(rust.indexOf("fn client_auth_enroll("), rust.indexOf("/// Log the desktop shell in"));
    expect(bootstrap.match(/discard_spent_proof\(&path\)/g)).toHaveLength(2);
    expect(bootstrap).toContain("Enrollment::Unreachable(message)");
    expect(bootstrap).toContain("CLIENT_AUTH_BOOTSTRAP_CONSUMED.store(false, Ordering::Release)");
  });

  it("requires success plus a parseable session cookie before enrollment succeeds", () => {
    const rust = fs.readFileSync(path.join(process.cwd(), "src-tauri", "src", "lib.rs"), "utf8");
    expect(rust).toContain("if !response.status().is_success()");
    expect(rust).toContain("reqwest::header::SET_COOKIE");
    expect(rust).toContain("__Host-mandible-session=");
    expect(rust).toContain("window.set_cookie(cookie)");
  });
});
