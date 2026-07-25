// @vitest-environment jsdom

// Desktop-shell operator login (issue 54b5677): keychain-backed enrollment
// after the one-shot bootstrap window has closed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

import {
  AUTOMATIC_ENROLLMENT_SOURCES,
  MANUAL_ENROLLMENT_SOURCES,
  attemptDesktopLogin,
  sanitizeEnrollmentHash,
  type DesktopLoginDeps,
} from "../ui/src/desktop-login.js";
import {
  ensureClientAuthToken,
  getClientAuthSessionState,
  getStoredToken,
  installClientAuthFetch,
  subscribeClientAuthSessionState,
} from "../ui/src/client-auth-token.js";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();

  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

function deps(overrides: Partial<DesktopLoginDeps> = {}): DesktopLoginDeps {
  return {
    enroll: async () => false,
    awaitCredentialFragment: async () => true,
    refreshSession: async () => "unauthenticated",
    ...overrides,
  };
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

describe("desktop enrollment source ordering", () => {
  it("falls back to the keychain when the bootstrap proof is gone", async () => {
    const attempted: string[] = [];
    const outcome = await attemptDesktopLogin(AUTOMATIC_ENROLLMENT_SOURCES, deps({
      enroll: async (source) => {
        attempted.push(source);
        return source === "keychain";
      },
      refreshSession: async () => "enrolled",
    }));
    expect(outcome).toBe("enrolled");
    expect(attempted).toEqual(["bootstrap", "keychain"]);
  });

  it("stops at the first source that produces a session", async () => {
    const attempted: string[] = [];
    const outcome = await attemptDesktopLogin(AUTOMATIC_ENROLLMENT_SOURCES, deps({
      enroll: async (source) => {
        attempted.push(source);
        return true;
      },
      refreshSession: async () => "enrolled",
    }));
    expect(outcome).toBe("enrolled");
    expect(attempted).toEqual(["bootstrap"]);
  });

  it("reports an absent credential as unavailable, not as a failure", async () => {
    const refreshSession = vi.fn(async () => "enrolled" as const);
    const outcome = await attemptDesktopLogin(AUTOMATIC_ENROLLMENT_SOURCES, deps({
      refreshSession,
    }));
    expect(outcome).toBe("unavailable");
    expect(refreshSession).not.toHaveBeenCalled();
  });

  it("keeps trying later sources after a shell error, then reports failure", async () => {
    const errors: string[] = [];
    const attempted: string[] = [];
    const outcome = await attemptDesktopLogin(AUTOMATIC_ENROLLMENT_SOURCES, deps({
      enroll: async (source) => {
        attempted.push(source);
        if (source === "bootstrap") {
          throw new Error("refusing desktop enrollment for a daemon owned by another user");
        }
        return false;
      },
      onError: (message) => errors.push(message),
    }));
    expect(outcome).toBe("failed");
    expect(attempted).toEqual(["bootstrap", "keychain"]);
    expect(errors).toEqual([
      "refusing desktop enrollment for a daemon owned by another user",
    ]);
  });

  it("fails when an injected credential does not produce an operator session", async () => {
    const outcome = await attemptDesktopLogin(MANUAL_ENROLLMENT_SOURCES, deps({
      enroll: async () => true,
      refreshSession: async () => "unauthenticated",
    }));
    expect(outcome).toBe("failed");
  });

  it("retries only the keychain for an explicit login action", async () => {
    const attempted: string[] = [];
    await attemptDesktopLogin(MANUAL_ENROLLMENT_SOURCES, deps({
      enroll: async (source) => {
        attempted.push(source);
        return false;
      },
    }));
    expect(attempted).toEqual(["keychain"]);
  });
});

describe("client-auth session state", () => {
  it("distinguishes no session, a rejected credential, and an unreachable daemon", async () => {
    const states: string[] = [];
    const unsubscribe = subscribeClientAuthSessionState((state) => states.push(state));

    window.fetch = vi.fn(async () => new Response(null, { status: 500 })) as typeof window.fetch;
    await ensureClientAuthToken();
    expect(getClientAuthSessionState()).toBe("unauthenticated");

    window.localStorage.setItem("mandible.client_auth.token", "stale-session");
    await ensureClientAuthToken();
    expect(getClientAuthSessionState()).toBe("unreachable");

    window.fetch = vi.fn(async () => new Response(null, { status: 401 })) as typeof window.fetch;
    await ensureClientAuthToken();
    expect(getClientAuthSessionState()).toBe("unauthenticated");

    window.fetch = vi.fn(async () => new Response(
      JSON.stringify({ token: "dashboard-session" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as typeof window.fetch;
    await ensureClientAuthToken();
    expect(getClientAuthSessionState()).toBe("enrolled");

    unsubscribe();
    expect(states).toEqual(["unreachable", "unauthenticated", "enrolled"]);
  });

  it("reports an adopted fragment credential as enrolled", async () => {
    window.history.replaceState(null, "", "/#/auth?mandible_auth=keychain-operator-token");
    window.fetch = vi.fn(async () => new Response(
      JSON.stringify({ token: "dashboard-session" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as typeof window.fetch;

    await ensureClientAuthToken();
    expect(getClientAuthSessionState()).toBe("enrolled");
    // The credential is stripped and the operator's route survives enrollment.
    expect(window.location.hash).toBe("#/auth");
  });
});

describe("reserved credential parameter", () => {
  it("never forwards a mandible_auth already present in the hash", () => {
    // URLSearchParams.get returns the first value, so a forwarded stale
    // credential would shadow the session the shell injects after it.
    expect(sanitizeEnrollmentHash("#/issues?mandible_auth=stale")).toBe("/issues");
    expect(sanitizeEnrollmentHash("#/issues?repo=mandible&mandible_auth=stale"))
      .toBe("/issues?repo=mandible");
    expect(sanitizeEnrollmentHash("#/issues?repo=mandible")).toBe("/issues?repo=mandible");
    expect(sanitizeEnrollmentHash("#/auth")).toBe("/auth");
    expect(sanitizeEnrollmentHash("")).toBe("");
  });
});

describe("losing a dashboard session mid-session", () => {
  it("marks the surface unauthenticated when a 401 clears the stored token", async () => {
    window.localStorage.setItem("mandible.client_auth.token", "revoked-session");
    const states: string[] = [];
    const unsubscribe = subscribeClientAuthSessionState((state) => states.push(state));
    // Another surface enrolled and rotated this session away: the request 401s
    // and the renewal handshake cannot revive an unknown token.
    window.fetch = vi.fn(async () => new Response(null, { status: 401 })) as typeof window.fetch;
    installClientAuthFetch();

    const response = await window.fetch("/api/write", { method: "POST" });

    expect(response.status).toBe(401);
    expect(getStoredToken()).toBeNull();
    expect(getClientAuthSessionState()).toBe("unauthenticated");
    expect(states).toContain("unauthenticated");
    unsubscribe();
  });
});

describe("desktop shell keychain command", () => {
  it("redeems the keychain credential in Rust and injects only a session", () => {
    const rust = fs.readFileSync(
      path.join(process.cwd(), "src-tauri", "src", "lib.rs"),
      "utf8",
    );
    expect(rust).toContain("fn client_auth_keychain_enroll(");
    expect(rust).toContain("client_auth_keychain_enroll,");
    // Same daemon-ownership gate as the bootstrap path.
    expect(rust).toContain("verify_same_user_daemon(&app)");
    // Same keychain item the CLI falls back to, read through `security`.
    expect(rust).toContain('const KEYCHAIN_OPERATOR_SERVICE: &str = "mandible-operator"');
    expect(rust).toContain('.args(["find-generic-password", "-s", service, "-w"])');
    // Re-entrancy guard, with an explicit-action escape hatch.
    expect(rust).toContain("CLIENT_AUTH_KEYCHAIN_ATTEMPTED.swap(true");
    expect(rust).toContain("&& !force.unwrap_or(false)");
    // The durable credential is exchanged for a bounded session and scrubbed,
    // so only the session reaches the fragment both enrollment paths inject.
    expect(rust).toContain("fn exchange_credential_for_dashboard_session(credential: &[u8])");
    expect(rust).toContain("POST /api/client-auth/handshake HTTP/1.1");
    expect(rust).toContain("Authorization: Bearer ");
    expect(rust).toContain("credential.fill(0);");
    expect(rust).toContain("navigate_to_enrolled_dashboard(&app, &session?, route.as_deref())");
    expect(rust).toContain("navigate_to_enrolled_dashboard(&app, &session?, None)");
    expect(rust).toContain("Result<bool, String>");
    expect(rust).toContain("{separator}mandible_auth={token}");
    expect(rust).toContain("window.location.replace({encoded})");
    // A forwarded credential parameter is refused rather than shadowing.
    expect(rust).toContain('route.to_ascii_lowercase().contains("mandible_auth")');
  });
});
