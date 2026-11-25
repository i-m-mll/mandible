import { randomUUID } from "node:crypto";
import { exactAgentRef, hookAgentIdentity, type AmbientProviderIdentity } from "../../ambient-provider-identity.js";
import type { Db } from "../../db.js";
import { observeSessionExecution, SessionExecutionStore } from "../../session-execution.js";
import type { Logger } from "../../types.js";
import { REGISTERED_ROUTE, type NotificationSubjectKind } from "../contract.js";
import type { WakeRouteStore } from "./routes.js";
import type { RegisteredRoute, Result, WakeEnvironment, WakeExecutor, WakeFailureCode, WakeProvider } from "./types.js";

/** The one sentence a wake carries; the message itself is delivered by the woken turn's hooks. */
export const WAKE_TEXT = "Mandible holds a message for this session; it is delivered with this turn.";

/** A wake that has not been answered by a hook call holds further wakes back for this long. */
export const WAKE_HOLD_MS = 60_000;

export type WakeOutcome = "woken" | WakeFailureCode;

/** One attempt as `session_wakes` records it. */
export interface WakeAttempt {
  id: string;
  provider: WakeProvider;
  session_id: string;
  attempted_at: number;
  finished_at: number | null;
  outcome: WakeOutcome | null;
  error: string | null;
  cleared_at: number | null;
}

export interface WakeReconcilerOptions {
  db: Db;
  routes: WakeRouteStore;
  executors: Readonly<Record<WakeProvider, WakeExecutor>>;
  environment: WakeEnvironment;
  /** The owed row kinds that wake an idle session. */
  kinds: readonly NotificationSubjectKind[];
  logger: Logger;
  now?: () => number;
}

/**
 * Keeps one state true: no session that is outside a turn, can be woken and has
 * no wake outstanding holds an undelivered row of a waking kind. It evaluates
 * one session when a row is stored for it, when its execution state changes,
 * and when it registers a new route.
 */
export class WakeReconciler {
  private readonly inFlight = new Set<Promise<void>>();
  private readonly now: () => number;

  constructor(private readonly options: WakeReconcilerOptions) {
    this.now = options.now ?? Date.now;
    // An attempt the previous daemon left running never returned; it holds nothing.
    options.db.prepare(`UPDATE session_wakes SET outcome = 'entry_point_failed', finished_at = ?,
      error = 'the daemon stopped before the attempt returned' WHERE outcome IS NULL`).run(this.now());
  }

  /**
   * Decides synchronously, so two evaluations never both wake, and resolves
   * once the attempt it started (if any) has returned.
   */
  evaluate(provider: WakeProvider, sessionId: string): Promise<void> {
    const attempt = this.decide(provider, sessionId);
    if (!attempt) return Promise.resolve();
    const run = this.attempt(attempt)
      .catch((error) => this.options.logger("error", "session_wake_failed", { provider, error: String(error) }))
      .finally(() => this.inFlight.delete(run));
    this.inFlight.add(run);
    return run;
  }

  /**
   * Follows every execution observation: it answers the session's outstanding
   * wake, an `ended` session loses its route, and a change of state is
   * evaluated. Returns the unsubscribe.
   */
  watchExecution(): () => void {
    return observeSessionExecution((provider, sessionId, result) => {
      this.heard(provider, sessionId);
      if (result.observation?.state.kind === "ended") this.options.routes.drop(provider, sessionId);
      if (result.status === "applied") void this.evaluate(provider, sessionId);
    });
  }

  /**
   * Stores a route the session registered. A changed route is evaluated unless
   * it came with the session's own hook call, which is delivering already.
   */
  register(sessionId: string, route: RegisteredRoute, origin: "hook" | "command"): void {
    if (this.options.routes.register(sessionId, route) && origin === "command") void this.evaluate(route.provider, sessionId);
  }

  /**
   * A route a `mandible` command attached for the session it runs in: the
   * caller's identity names the session, and the route must be its provider's.
   */
  registerFromCommand(identity: AmbientProviderIdentity | null, raw: unknown): Result<void, string> {
    const route = REGISTERED_ROUTE.safeParse(raw);
    if (!route.success) return { ok: false, error: "malformed" };
    if (!identity || identity.provider !== route.data.provider) return { ok: false, error: "not_the_caller_provider" };
    const sessionId = route.data.provider === "claude" ? identity.session_id : identity.agent_id;
    if (!sessionId) return { ok: false, error: "no_session" };
    this.register(sessionId, route.data, "command");
    return { ok: true, value: undefined };
  }

  /** Any hook call from the session answers its outstanding wake. */
  heard(provider: WakeProvider, sessionId: string): void {
    this.options.db.prepare(`UPDATE session_wakes SET cleared_at = ? WHERE provider = ? AND session_id = ?
      AND outcome = 'woken' AND cleared_at IS NULL`).run(this.now(), provider, sessionId);
  }

  /** Resolves when every attempt started so far has returned. */
  async settled(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight]);
  }

  private decide(provider: WakeProvider, sessionId: string): WakeAttempt | null {
    const { db, kinds } = this.options;
    if (kinds.length === 0) return null;
    const main = exactAgentRef(hookAgentIdentity(provider, sessionId, undefined));
    const owed = db.prepare(`SELECT 1 FROM notifications WHERE delivered_at IS NULL AND recipient_kind = 'session'
      AND subject_kind IN (SELECT value FROM json_each(?1)) AND (
        (subject_kind = 'message' AND responsible_agent_ref = ?2)
        OR (subject_kind <> 'message' AND recipient_provider = ?3 AND recipient_id = ?4)) LIMIT 1`)
      .get(JSON.stringify(kinds), main, provider, sessionId);
    if (!owed) return null;
    if (provider !== "antigravity") {
      const state = new SessionExecutionStore(db).read(provider, sessionId)?.state.kind;
      if (state === undefined || state === "working" || state === "ended") return null;
    }
    const now = this.now();
    const held = db.prepare(`SELECT 1 FROM session_wakes WHERE provider = ? AND session_id = ? AND attempted_at > ?
      AND (outcome IS NULL OR (outcome = 'woken' AND cleared_at IS NULL)) LIMIT 1`).get(provider, sessionId, now - WAKE_HOLD_MS);
    if (held) return null;
    const attempt: WakeAttempt = { id: randomUUID(), provider, session_id: sessionId, attempted_at: now,
      finished_at: null, outcome: null, error: null, cleared_at: null };
    db.prepare("INSERT INTO session_wakes (id, provider, session_id, attempted_at) VALUES (?, ?, ?, ?)")
      .run(attempt.id, provider, sessionId, now);
    return attempt;
  }

  private async attempt(attempt: WakeAttempt): Promise<void> {
    const { db, routes, executors, environment, logger } = this.options;
    const registered = routes.get(attempt.provider, attempt.session_id);
    let outcome: WakeOutcome, error: string | null = null;
    try {
      const result = await executors[attempt.provider](
        { provider: attempt.provider, session_id: attempt.session_id, registered, text: WAKE_TEXT }, environment);
      if (result.ok) outcome = "woken";
      else {
        outcome = result.error.code;
        if ("detail" in result.error) error = result.error.detail;
      }
    } catch (thrown) {
      outcome = "entry_point_failed";
      error = `the executor threw: ${String(thrown)}`;
      logger("error", "wake_executor_threw", { provider: attempt.provider, error: String(thrown) });
    }
    if (registered) error = error?.replaceAll(registered.token, "<token>") ?? null;
    if (outcome === "route_refused") routes.drop(attempt.provider, attempt.session_id);
    db.prepare("UPDATE session_wakes SET outcome = ?, finished_at = ?, error = ? WHERE id = ?")
      .run(outcome, this.now(), error, attempt.id);
    logger("info", "session_wake", { provider: attempt.provider, session_id: attempt.session_id, outcome });
  }
}

/** The session's latest attempt made at or after `since`. */
export function latestWakeAttempt(db: Db, provider: WakeProvider, sessionId: string, since: number): WakeAttempt | null {
  return (db.prepare(`SELECT * FROM session_wakes WHERE provider = ? AND session_id = ? AND attempted_at >= ?
    ORDER BY attempted_at DESC, rowid DESC LIMIT 1`).get(provider, sessionId, since) as WakeAttempt | undefined) ?? null;
}
