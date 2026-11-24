/**
 * Wake routes: how Mandible starts a turn on an idle agent session so that the
 * turn's own hooks deliver what is owed to it. A wake carries no message
 * content; delivery and `delivered_at` stay the notices hook's.
 *
 * Each provider contributes one executor. The core (route store, reconciler,
 * wake record) depends only on this file.
 */

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

/**
 * A route a session registered from inside itself, because the provider hands
 * the address and token only to processes it starts. Codex and the
 * Antigravity App need none: their routes are derived at wake time.
 */
export type RegisteredRoute =
  | { provider: "claude"; socket: string; token: string }
  | { provider: "antigravity"; address: string; token: string };

export type WakeProvider = "claude" | "codex" | "antigravity";

export interface WakeTarget {
  provider: WakeProvider;
  /** Claude session id, Codex thread id, or Antigravity conversation id. */
  session_id: string;
  /** The route the session last registered, if any. */
  registered: RegisteredRoute | null;
  /** The fixed sentence that starts the turn. */
  text: string;
}

export type WakeFailure =
  | { code: "no_route" }
  /** The route's address refused the connection; the core drops the registered route. */
  | { code: "route_refused"; detail: string }
  /** The provider's app is not running; a wake never launches it. */
  | { code: "provider_not_running"; detail: string }
  /** The Codex thread does not live in the desktop app. */
  | { code: "not_app_thread"; detail: string }
  | { code: "entry_point_failed"; detail: string };

export type WakeFailureCode = WakeFailure["code"];

/** Paths and binaries an executor touches, so tests replace them with fakes. */
export interface WakeEnvironment {
  home: string;
  /**
   * Runs a child process with `env` added to the daemon's environment and
   * `stdin` written then closed; resolves when it exits, with code null when it
   * timed out (and was killed) or could not start. Never rejects.
   */
  run(command: string, args: readonly string[], options: { stdin?: string; env?: Record<string, string>; timeout_ms: number }):
    Promise<{ code: number | null; stdout: string; stderr: string }>;
  /** Whether a process with this pid is alive. */
  alive(pid: number): boolean;
}

export type WakeExecutor = (target: WakeTarget, environment: WakeEnvironment) => Promise<Result<void, WakeFailure>>;
