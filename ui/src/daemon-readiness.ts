// Bug: 645f8a8 — daemon readiness / rebuild-splash decision logic.
//
// During a Mandible self-merge the daemon exits and is respawned with new
// code. The UI shows a full-page splash and must NOT drop it (and must NOT let
// the user fire auth/dashboard mutations) until the *restarted* daemon reports
// that it is ready for normal mutations — not merely that an HTTP listener is
// alive.
//
// A page can enter this state two ways:
//  1. It was open when the merge happened and received the `mandible:rebuilding`
//     SSE event.
//  2. It was (re)loaded mid-rebuild or mid-startup and missed the event — the
//     mount probe below detects the not-ready daemon from `/api/health`.
//
// This module is intentionally free of UI/runtime dependencies so the decision
// rules can be unit-tested directly.

/** The subset of `/api/health` the splash decision depends on. */
export interface DaemonHealthSnapshot {
  /** Old daemon is shutting down for a self-merge rebuild. */
  rebuilding?: boolean;
  /**
   * Lifecycle-owned readiness. true only once critical startup work is done and
   * normal dashboard mutations are safe. An older daemon may omit this; a
   * missing value is treated as "not ready" so the splash errs on the safe side.
   */
  ready?: boolean;
  instance?: {
    role: 'main' | 'preview' | 'dev' | 'test';
    operational_mutations: 'allow' | 'reject';
    operational_mutations_overridden: boolean;
    db_path: string | null;
    db_path_source: string | null;
    source_db_path?: string | null;
    source_db_path_source?: string | null;
  };
}

/**
 * Whether the rebuild/start splash should remain (equivalently: the daemon is
 * NOT ready for normal use). A `null` snapshot means the health fetch failed —
 * keep the splash up and keep polling.
 *
 * Splash persists while: health fetch fails, OR `rebuilding === true`, OR
 * `ready !== true`.
 */
export function daemonNeedsSplash(health: DaemonHealthSnapshot | null | undefined): boolean {
  if (!health) {
    return true;
  }
  if (health.rebuilding === true) {
    return true;
  }
  return health.ready !== true;
}

/**
 * Inverse of {@link daemonNeedsSplash}: the daemon is ready for normal dashboard
 * mutations. Used to decide when the splash poll may reload the page.
 */
export function daemonIsReady(health: DaemonHealthSnapshot | null | undefined): boolean {
  return !daemonNeedsSplash(health);
}

/**
 * Whether a cold-mount `/api/health` probe should ENTER the splash. This is
 * deliberately stricter than {@link daemonNeedsSplash}: it requires an EXPLICIT
 * POSITIVE not-ready signal from a well-formed health response — `rebuilding ===
 * true` OR `ready === false`.
 *
 * It intentionally does NOT enter on absence of information:
 *  - a failed / indeterminate cold-mount fetch (`null`) — a daemon that cannot
 *    serve health did not serve this page either;
 *  - a 200 response that simply omits `ready` (an older daemon predating this
 *    feature, or any non-health body) — `ready === false` is required, not
 *    merely "not exactly true".
 *
 * This avoids hijacking the UI / flashing the splash on normal cold loads. It
 * still satisfies the "page loaded mid-startup" case because a reachable
 * still-starting daemon answers health 200 with an explicit `ready: false`.
 *
 * Contrast {@link daemonNeedsSplash} (the STAY predicate), which treats `null`
 * and missing readiness as "keep the splash up" once it is ALREADY active, so
 * the splash survives the daemon exit/restart gap during a self-merge. Entering
 * vs. staying are different questions; this predicate answers "enter".
 */
export function shouldEnterSplashOnProbe(health: DaemonHealthSnapshot | null | undefined): boolean {
  if (!health) {
    return false;
  }
  return health.rebuilding === true || health.ready === false;
}
