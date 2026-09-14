// @vitest-environment jsdom

// Desktop-shell operator login (issue 54b5677): keychain-backed enrollment
// after the one-shot bootstrap window has closed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { h } from "preact";

import {
  AUTOMATIC_ENROLLMENT_SOURCES,
  DesktopLoginRecoveryCoordinator,
  MANUAL_ENROLLMENT_SOURCES,
  attemptDesktopLogin,
  recoverDesktopLoginAutomatically,
  resetDesktopLoginRecoveryEpisode,
  sanitizeEnrollmentHash,
  type DesktopLoginDeps,
} from "../../ui/src/desktop-login.js";
import { DesktopLoginStatus } from "../../ui/src/components/DesktopLoginStatus.js";
import {
  enrollDesktopClientAuth,
  isDesktopShell,
  startDesktopDaemon,
} from "../../ui/src/api.js";
import {
  ensureClientAuthToken,
  getClientAuthSessionState,
  getStoredToken,
  installClientAuthFetch,
  subscribeClientAuthSessionState,
} from "../../ui/src/client-auth-token.js";

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
  resetDesktopLoginRecoveryEpisode();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: new MemoryStorage(),
  });
});

describe("desktop recovery episodes", () => {
  it("shares one automatic attempt and rearms only after an enrolled episode", async () => {
    const coordinator = new DesktopLoginRecoveryCoordinator();
    let resolve!: (outcome: "enrolled") => void;
    const run = vi.fn(() => new Promise<"enrolled">((done) => { resolve = done; }));

    const first = coordinator.recover(run);
    const concurrent = coordinator.recover(run);
    expect(first).toBe(concurrent);
    expect(run).toHaveBeenCalledTimes(1);
    resolve("enrolled");
    await expect(first).resolves.toBe("enrolled");

    // The same episode remains spent until an authenticated state explicitly
    // closes it; then a later 401 can start exactly one new attempt.
    await coordinator.recover(run);
    expect(run).toHaveBeenCalledTimes(1);
    coordinator.reset();
    await coordinator.recover(async () => "enrolled");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("permits manual retry only after a real automatic failure or absence", async () => {
    const coordinator = new DesktopLoginRecoveryCoordinator();
    const manual = vi.fn(async () => "enrolled" as const);

    await expect(coordinator.retry(manual)).resolves.toBe("unavailable");
    expect(manual).not.toHaveBeenCalled();
    await expect(coordinator.recover(async () => "failed")).resolves.toBe("failed");
    expect(coordinator.canRetryManually()).toBe(true);
    await expect(coordinator.retry(manual)).resolves.toBe("enrolled");
    expect(manual).toHaveBeenCalledTimes(1);
  });
});

afterEach(() => {
  cleanup();
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

describe("desktop shell command bridge", () => {
  // The dashboard is served over HTTP into the webview, where a bare module
  // specifier such as "@tauri-apps/api/core" has no URL to resolve. The shell
  // API must therefore be read off the window globals Tauri installs.
  type TauriTestWindow = typeof window & {
    __TAURI__?: unknown;
    __TAURI_INTERNALS__?: unknown;
  };

  afterEach(() => {
    delete (window as TauriTestWindow).__TAURI__;
    delete (window as TauriTestWindow).__TAURI_INTERNALS__;
  });

  it("invokes shell commands through window.__TAURI__.core", async () => {
    const calls: Array<{ command: string; args: unknown }> = [];
    (window as TauriTestWindow).__TAURI__ = {
      core: {
        invoke: async (command: string, args?: Record<string, unknown>) => {
          calls.push({ command, args });
          return true;
        },
      },
    };

    expect(isDesktopShell()).toBe(true);
    await expect(enrollDesktopClientAuth("keychain", { route: "/issues" })).resolves.toBe(true);
    expect(calls).toEqual([
      { command: "client_auth_keychain_enroll", args: { route: "/issues" } },
    ]);
  });

  it("falls back to the internals bridge the runtime check also accepts", async () => {
    // `withGlobalTauri` publishes `__TAURI__`, but `__TAURI_INTERNALS__` is
    // present either way: a runtime that passes the desktop-shell check must
    // never fail the access path.
    const calls: string[] = [];
    (window as TauriTestWindow).__TAURI_INTERNALS__ = {
      invoke: async (command: string) => {
        calls.push(command);
        return true;
      },
    };

    expect(isDesktopShell()).toBe(true);
    await expect(enrollDesktopClientAuth("bootstrap")).resolves.toBe(true);
    expect(calls).toEqual(["client_auth_enroll"]);
  });

  it("reports a plain browser instead of failing to resolve a module", async () => {
    expect(isDesktopShell()).toBe(false);
    await expect(recoverDesktopLoginAutomatically()).resolves.toBe("unavailable");
    await expect(startDesktopDaemon()).rejects.toThrow(
      "Desktop daemon controls are only available in the Tauri app.",
    );
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
  });

  it("matches the key structurally, as the shell does", () => {
    // Percent-encoded and differently-cased spellings must not slip past the
    // UI and then be refused by the shell.
    expect(sanitizeEnrollmentHash("#/issues?mandible%5Fauth=stale")).toBe("/issues");
    expect(sanitizeEnrollmentHash("#/issues?MANDIBLE_AUTH=stale")).toBe("/issues");
    // Values, paths, and merely similar keys are not grounds for stripping.
    expect(sanitizeEnrollmentHash("#/search?q=mandible_authentication"))
      .toBe("/search?q=mandible_authentication");
    expect(sanitizeEnrollmentHash("#/issues?repo=mandible")).toBe("/issues?repo=mandible");
    expect(sanitizeEnrollmentHash("#/mandible_auth")).toBe("/mandible_auth");
    expect(sanitizeEnrollmentHash("#/auth")).toBe("/auth");
    expect(sanitizeEnrollmentHash("")).toBe("");
  });
});

describe("losing a dashboard session mid-session", () => {
  it("marks the surface unauthenticated without destroying a recoverable token", async () => {
    window.localStorage.setItem("mandible.client_auth.token", "revoked-session");
    const states: string[] = [];
    const unsubscribe = subscribeClientAuthSessionState((state) => states.push(state));
    // Explicit revocation makes the request and renewal fail, but a transient
    // wrong backend must not make the renderer destroy the stored credential.
    window.fetch = vi.fn(async () => new Response(null, { status: 401 })) as typeof window.fetch;
    installClientAuthFetch();

    const response = await window.fetch("/api/write", { method: "POST" });

    expect(response.status).toBe(401);
    expect(getStoredToken()).toBe("revoked-session");
    expect(getClientAuthSessionState()).toBe("unauthenticated");
    expect(states).toContain("unauthenticated");
    unsubscribe();
  });

  it("automatically recovers one time after a mid-session 401 without losing the route", async () => {
    type TauriTestWindow = typeof window & { __TAURI__?: unknown };
    window.history.replaceState(null, "", "/#/timeline?repo=mandible");
    window.localStorage.setItem("mandible.client_auth.token", "working-session");
    window.fetch = vi.fn(async () => new Response(
      JSON.stringify({ token: "working-session-2" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as typeof window.fetch;
    await ensureClientAuthToken();

    const invokes: string[] = [];
    (window as TauriTestWindow).__TAURI__ = {
      core: {
        invoke: async (command: string) => {
          invokes.push(command);
          if (command === "client_auth_keychain_enroll") {
            window.location.hash = "/timeline?repo=mandible&mandible_auth=recovered-session";
            return true;
          }
          return false;
        },
      },
    };
    render(h(DesktopLoginStatus, {}));

    window.fetch = vi.fn(async () => new Response(null, { status: 401 })) as typeof window.fetch;
    await ensureClientAuthToken();
    // Two unauthenticated observations in the same episode still share one
    // automatic recovery attempt.
    await ensureClientAuthToken();

    window.fetch = vi.fn(async () => new Response(
      JSON.stringify({ token: "recovered-session-2" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as typeof window.fetch;

    await waitFor(() => expect(getClientAuthSessionState()).toBe("enrolled"));
    expect(invokes.filter((command) => command === "client_auth_keychain_enroll")).toHaveLength(1);
    expect(window.location.hash).toBe("#/timeline?repo=mandible");
    expect(screen.queryByRole("button", { name: "Log in" })).toBeNull();
    delete (window as TauriTestWindow).__TAURI__;
  });

  it("offers a manual retry only after the automatic keychain attempt fails", async () => {
    type TauriTestWindow = typeof window & { __TAURI__?: unknown };
    window.localStorage.setItem("mandible.client_auth.token", "working-session");
    window.fetch = vi.fn(async () => new Response(
      JSON.stringify({ token: "working-session-2" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as typeof window.fetch;
    await ensureClientAuthToken();

    let keychainAttempts = 0;
    (window as TauriTestWindow).__TAURI__ = {
      core: {
        invoke: async (command: string) => {
          if (command === "client_auth_keychain_enroll") {
            keychainAttempts += 1;
            if (keychainAttempts === 1) throw new Error("login keychain is locked");
            window.location.hash = "/?mandible_auth=recovered-session";
            return true;
          }
          return false;
        },
      },
    };
    render(h(DesktopLoginStatus, { placement: "rail", showRailLabel: false }));
    expect(screen.queryByRole("button", { name: "Log in" })).toBeNull();

    window.fetch = vi.fn(async () => new Response(null, { status: 401 })) as typeof window.fetch;
    await ensureClientAuthToken();
    const retry = await screen.findByRole("button", { name: "Log in" });
    expect(keychainAttempts).toBe(1);
    expect(retry.classList.contains("app-rail__item")).toBe(true);
    expect(retry.querySelector(".app-rail__label")).toBeNull();
    expect(retry.querySelector(".app-rail__tooltip")?.textContent)
      .toBe("Not logged in: login keychain is locked");
    expect(screen.getByRole("status").textContent).toContain("Not logged in");

    window.fetch = vi.fn(async () => new Response(
      JSON.stringify({ token: "recovered-session-2" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as typeof window.fetch;
    fireEvent.click(retry);
    await waitFor(() => expect(getClientAuthSessionState()).toBe("enrolled"));
    expect(keychainAttempts).toBe(2);
    delete (window as TauriTestWindow).__TAURI__;
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
    // Same daemon-ownership gate as the bootstrap path, run as a precheck.
    expect(rust).toContain("|| enrollment_precheck(&app),");
    expect(rust).toContain("verify_same_user_daemon()");
    // Release enrollment must not depend on the checkout that built the app.
    expect(rust).not.toContain("let expected_entry = resolve_daemon_entry(app)?");
    // Same keychain item the CLI falls back to, read through `security`.
    expect(rust).toContain('const KEYCHAIN_OPERATOR_SERVICE: &str = "mandible-operator"');
    expect(rust).toContain('.args(["find-generic-password", "-s", service, "-w"])');
    // Rust bounds concurrent keychain reads without accepting renderer retry
    // policy as an IPC argument. The guard is released after every result so a
    // later unauthenticated episode can recover.
    expect(rust).toContain("CLIENT_AUTH_KEYCHAIN_IN_FLIGHT.swap(true");
    expect(rust).toContain("CLIENT_AUTH_KEYCHAIN_IN_FLIGHT.store(false, Ordering::Release)");
    expect(rust).not.toContain("force: Option<bool>");
    // The durable credential is exchanged for a bounded session and scrubbed,
    // so only the session reaches the fragment both enrollment paths inject.
    expect(rust).toContain("fn exchange_credential_for_dashboard_session(credential: &[u8])");
    expect(rust).toContain("POST /api/client-auth/handshake HTTP/1.1");
    expect(rust).toContain("Authorization: Bearer ");
    expect(rust).toContain("credential.fill(0);");
    expect(rust).toContain("navigate_to_enrolled_dashboard(&app, &token, &route)");
    expect(rust).toContain("Result<bool, String>");
    expect(rust).toContain("{separator}{CREDENTIAL_QUERY_PARAM}={token}");
    expect(rust).toContain("window.location.replace({encoded})");
    // Bytes that could smuggle a header are refused at read time.
    expect(rust).toContain("fn is_credential_material(value: &[u8])");
    expect(rust).toContain("not a valid Mandible token");
    // A forwarded credential parameter is refused structurally, after decoding.
    expect(rust).toContain("percent_decode_ascii(key).eq_ignore_ascii_case(CREDENTIAL_QUERY_PARAM)");
    // The response is bounded and its status line strictly parsed.
    expect(rust).toContain("MAX_HANDSHAKE_RESPONSE_BYTES");
    expect(rust).toContain('strip_prefix("HTTP/1.")');
    expect(rust).toContain("fn declared_content_length(head: &str)");
  });

  it("spends a one-shot bootstrap proof only once the daemon has seen it", () => {
    const rust = fs.readFileSync(
      path.join(process.cwd(), "src-tauri", "src", "lib.rs"),
      "utf8",
    );
    // Ordering: validate, precheck, read, exchange — the file is removed only
    // in the Session and Refused arms, never on an unreachable daemon.
    expect(rust).toContain("fn run_enrollment<P, C, E>(");
    expect(rust).toContain("let route = normalize_enrollment_route(route)?;\n    precheck()?;");
    const bootstrap = rust.slice(
      rust.indexOf("fn client_auth_enroll("),
      rust.indexOf("/// Log the desktop shell in"),
    );
    expect(bootstrap).toContain("|| read_client_auth_bootstrap(&path)");
    expect(bootstrap.match(/discard_spent_proof\(&path\)/g)).toHaveLength(2);
    expect(bootstrap).toContain("CLIENT_AUTH_BOOTSTRAP_CONSUMED.store(false, Ordering::Release)");
    // An undeletable proof would fail every later launch, so say so rather
    // than swallowing the error — without ever naming the file's contents.
    expect(rust).toContain("fn discard_spent_proof(path: &Path)");
    expect(rust).toContain("eprintln!(");
    expect(rust).toContain("until it can be deleted");
  });

  it("allowlists every registered application command for the loopback remote origin", () => {
    const rust = fs.readFileSync(
      path.join(process.cwd(), "src-tauri", "src", "lib.rs"),
      "utf8",
    );
    const permission = fs.readFileSync(
      path.join(process.cwd(), "src-tauri", "permissions", "desktop.toml"),
      "utf8",
    );
    const capability = JSON.parse(fs.readFileSync(
      path.join(process.cwd(), "src-tauri", "capabilities", "default.json"),
      "utf8",
    )) as { remote?: { urls?: string[] }; permissions?: string[] };
    expect(permission).toContain('identifier = "allow-desktop-commands"');
    const registered = rust.match(/generate_handler!\[([\s\S]*?)\]\)/)?.[1]
      .split(",").map((command) => command.trim()).filter(Boolean);
    const permitted = permission.match(/commands\.allow = \[([\s\S]*?)\]/)?.[1]
      .match(/"([^"]+)"/g)?.map((command) => command.slice(1, -1));
    expect(permitted).toEqual(registered);
    expect(capability.remote?.urls).toEqual([
      "http://127.0.0.1:19420",
      "http://localhost:19420",
    ]);
    expect(capability.permissions).toContain("allow-desktop-commands");
  });

  it("requires a successful handshake response to declare its own framing", () => {
    const rust = fs.readFileSync(
      path.join(process.cwd(), "src-tauri", "src", "lib.rs"),
      "utf8",
    );
    // An absent or unparseable Content-Length on a 2xx is untrusted framing,
    // not "no header to check against".
    expect(rust).toContain("enum ContentLength {");
    expect(rust).toContain("ContentLength::Invalid");
    expect(rust).toContain("if !matches!(framing, ContentLength::Declared(_))");
    expect(rust).toContain("unframed enrollment response");
  });
});
