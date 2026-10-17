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
  /** Issue a09b4d2 — an announced rebuild ended without restarting the daemon. */
  rebuild_failure?: { request_id?: string; reason?: string };
  /**
   * Lifecycle-owned readiness. true only once critical startup work is done and
   * normal dashboard mutations are safe. An older daemon may omit this; a
   * missing value is treated as "not ready" so the splash errs on the safe side.
   */
  ready?: boolean;
  /** false while the first deferred startup reconciliation is still running. */
  warm?: boolean;
  startup_epoch?: string;
  startup_commit?: {
    hash?: string;
  };
  instance?: {
    role: 'main' | 'preview' | 'dev' | 'test';
    instance_id: string;
    allowed_effects: string[];
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

/** Return the per-process startup epoch exposed by newer daemons. */
export function daemonStartupEpoch(
  health: DaemonHealthSnapshot | null | undefined,
): string | null {
  return health?.startup_epoch?.trim() || null;
}

/** Return a usable build-version proof, excluding compatibility placeholders. */
export function daemonStartupCommit(
  health: DaemonHealthSnapshot | null | undefined,
): string | null {
  const hash = health?.startup_commit?.hash?.trim();
  return hash && hash !== 'unknown' ? hash : null;
}

/** Whether a health snapshot belongs to a different startup commit. */
export function daemonEpochChanged(
  health: DaemonHealthSnapshot | null | undefined,
  previousEpoch: string | null,
): boolean {
  const currentEpoch = daemonStartupEpoch(health);
  return previousEpoch !== null && currentEpoch !== null && currentEpoch !== previousEpoch;
}

export function daemonCommitChanged(
  health: DaemonHealthSnapshot | null | undefined,
  previousCommit: string | null,
): boolean {
  const currentCommit = daemonStartupCommit(health);
  return previousCommit !== null && currentCommit !== null && currentCommit !== previousCommit;
}

/** A splash may release only after readiness and, when required, a new epoch. */
export function daemonIsReadyAfterEpoch(
  health: DaemonHealthSnapshot | null | undefined,
  previousEpoch: string | null,
  requireNewEpoch: boolean,
): boolean {
  return daemonIsReady(health) && (!requireNewEpoch || daemonEpochChanged(health, previousEpoch));
}

/** Missing warm is treated as warm for compatibility with older daemons. */
export function daemonIsWarm(health: DaemonHealthSnapshot | null | undefined): boolean {
  return health?.warm !== false;
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

/** Catch a missed rebuild event while the normal application shell is visible. */
export function shouldEnterSplashOnBackgroundProbe(
  health: DaemonHealthSnapshot | null | undefined,
  previousEpoch: string | null,
): boolean {
  return shouldEnterSplashOnProbe(health) || daemonEpochChanged(health, previousEpoch);
}

/**
 * Whether releasing the rebuild/start splash should require the daemon's startup
 * *commit* to advance (not merely its per-process epoch).
 *
 * Bug: afaea18 — a *manual* daemon restart (launchctl kickstart/bootout, ops
 * recovery, config reload) changes the per-process epoch but keeps the same
 * commit. Only an *announced rebuild* — the `mandible:rebuilding` SSE event, or
 * a health response that still reports `rebuilding` — legitimately advances the
 * commit. Requiring a new commit for a bare epoch change (as the earlier logic
 * did) strands the page on the epoch-stalled splash forever, because the commit
 * will never change. So the commit requirement is tied to the announced-rebuild
 * signal, never to epoch drift on its own.
 */
export function splashRequiresNewCommit(announcedRebuild: boolean): boolean {
  return announcedRebuild === true;
}

/**
 * Issue a09b4d2 — the reason an announced rebuild will not restart the daemon,
 * or null. Only meaningful while the daemon no longer reports `rebuilding`: the
 * old daemon keeps serving its previous build, so the splash must say the
 * rebuild failed instead of waiting for a new commit that will never come.
 */
export function daemonRebuildFailure(health: DaemonHealthSnapshot | null | undefined): string | null {
  if (!health || health.rebuilding === true || !health.rebuild_failure) return null;
  return health.rebuild_failure.reason?.trim() || 'The rebuild did not complete.';
}

/**
 * Whether a bounded rebuild-splash stall should surface its escape affordance.
 *
 * Bug: afaea18 — a stall must never be permanent (dataful-UX policy: a healthy
 * daemon behind a full-page splash the user cannot exit is a bug). Once the
 * (restarted) daemon is ready and warm and is NOT rebuilding — i.e. it is
 * healthy on the current commit — and has stayed that way for at least
 * `minStallMs`, the splash must offer a "continue anyway" escape that records
 * the current epoch/commit as last-seen and reloads. This covers an announced
 * rebuild that completed without advancing the commit; ordinary ops restarts no
 * longer reach the stall at all (see {@link splashRequiresNewCommit}).
 */
export function stallEscapeReady(
  health: DaemonHealthSnapshot | null | undefined,
  stalledForMs: number,
  minStallMs: number,
): boolean {
  return (
    daemonIsReady(health)
    && daemonIsWarm(health)
    && health?.rebuilding !== true
    && stalledForMs >= minStallMs
  );
}
