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
