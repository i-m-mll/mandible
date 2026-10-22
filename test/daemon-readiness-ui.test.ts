// Bug: 645f8a8 — splash/readiness decision rules used by the dashboard mount
// probe and the rebuild poll. The splash must persist while the health fetch
// fails, OR rebuilding === true, OR ready !== true.
import { describe, expect, it } from "vitest";

import {
  daemonEpochChanged,
  daemonCommitChanged,
  daemonIsReady,
  daemonIsReadyAfterEpoch,
  daemonIsWarm,
  daemonNeedsSplash,
  daemonStartupEpoch,
  daemonStartupCommit,
  shouldEnterSplashOnBackgroundProbe,
  shouldEnterSplashOnProbe,
  splashRequiresNewCommit,
  stallEscapeReady,
} from "../ui/src/daemon-readiness";

describe("daemonNeedsSplash", () => {
  it("keeps the splash up when the health fetch failed (null)", () => {
    expect(daemonNeedsSplash(null)).toBe(true);
    expect(daemonNeedsSplash(undefined)).toBe(true);
    expect(daemonIsReady(null)).toBe(false);
  });

  it("keeps the splash up while the daemon is rebuilding, even if ready is true", () => {
    expect(daemonNeedsSplash({ rebuilding: true, ready: true })).toBe(true);
    expect(daemonNeedsSplash({ rebuilding: true })).toBe(true);
    expect(daemonIsReady({ rebuilding: true, ready: true })).toBe(false);
  });

  it("keeps the splash up while the daemon is not ready (ready !== true)", () => {
    expect(daemonNeedsSplash({ ready: false })).toBe(true);
    // Missing readiness (older daemon) is treated as not ready.
    expect(daemonNeedsSplash({})).toBe(true);
    expect(daemonIsReady({ ready: false })).toBe(false);
  });

  it("drops the splash only when ready === true and not rebuilding", () => {
    expect(daemonNeedsSplash({ ready: true })).toBe(false);
    expect(daemonNeedsSplash({ ready: true, rebuilding: false })).toBe(false);
    expect(daemonIsReady({ ready: true })).toBe(true);
  });
});

describe("daemon startup epoch", () => {
  const oldEpoch = "a".repeat(40);
  const newEpoch = "b".repeat(40);

  it("requires a usable changed commit before a rebuild splash releases", () => {
    expect(daemonStartupCommit({ startup_commit: { hash: "unknown" } })).toBeNull();
    expect(daemonStartupEpoch({ startup_epoch: newEpoch })).toBe(newEpoch);
    expect(daemonEpochChanged({ startup_epoch: newEpoch }, oldEpoch)).toBe(true);
    expect(daemonIsReadyAfterEpoch({ ready: true, startup_epoch: oldEpoch }, oldEpoch, true)).toBe(false);
    expect(daemonIsReadyAfterEpoch({ ready: true }, oldEpoch, true)).toBe(false);
    expect(daemonIsReadyAfterEpoch({ ready: true, startup_epoch: newEpoch }, oldEpoch, true)).toBe(true);
    expect(daemonCommitChanged({ startup_commit: { hash: newEpoch } }, oldEpoch)).toBe(true);
  });

  it("preserves ordinary startup behavior when a new epoch is not required", () => {
    expect(daemonIsReadyAfterEpoch({ ready: true }, null, false)).toBe(true);
    expect(daemonIsReadyAfterEpoch({ ready: false }, null, false)).toBe(false);
  });

  it("uses background epoch drift to recover a missed rebuild event", () => {
    expect(shouldEnterSplashOnBackgroundProbe(
      { ready: true, startup_epoch: newEpoch, startup_commit: { hash: oldEpoch } },
      oldEpoch,
    )).toBe(true);
    expect(shouldEnterSplashOnBackgroundProbe(
      { ready: true, startup_epoch: oldEpoch },
      oldEpoch,
    )).toBe(false);
  });

  it("does not require a new commit for an ordinary same-process startup", () => {
    const starting = { ready: false, startup_epoch: oldEpoch, startup_commit: { hash: oldEpoch } };
    expect(shouldEnterSplashOnBackgroundProbe(starting, oldEpoch)).toBe(true);
    expect(daemonEpochChanged(starting, oldEpoch)).toBe(false);
    expect(daemonIsReadyAfterEpoch({ ...starting, ready: true }, oldEpoch, false)).toBe(true);
  });
});

describe("daemonIsWarm", () => {
  it("shows population only for an explicit cold warm tier", () => {
    expect(daemonIsWarm({ warm: false })).toBe(false);
    expect(daemonIsWarm({ warm: true })).toBe(true);
    expect(daemonIsWarm({})).toBe(true);
    expect(daemonIsWarm(null)).toBe(true);
  });
});

// Bug: afaea18 — a manual/ops daemon restart changes the per-process epoch but
// not the startup commit. The splash must not require a new commit for such a
// restart (it would strand the page forever), and even a genuinely stalled
// splash must always offer an escape once the daemon is proven healthy.
describe("splashRequiresNewCommit (afaea18: only announced rebuilds bump commit)", () => {
  const epoch = "a".repeat(40);

  it("requires a new commit only for an announced rebuild", () => {
    expect(splashRequiresNewCommit(true)).toBe(true);
    expect(splashRequiresNewCommit(false)).toBe(false);
  });

  it("does not strand a manual restart: bare epoch drift releases without a new commit", () => {
    const newEpoch = "b".repeat(40);
    // Manual restart caught by the mount probe: epoch drifted, but the daemon
    // is not rebuilding, so no new commit is required. On the same commit the
    // splash must still release once the new epoch is ready.
    const requireNewCommit = splashRequiresNewCommit(false);
    const restarted = { ready: true, startup_epoch: newEpoch, startup_commit: { hash: epoch } };
    expect(daemonEpochChanged(restarted, epoch)).toBe(true);
    expect(daemonIsReadyAfterEpoch(restarted, epoch, true)).toBe(true);
    // Commit is unchanged, but since no new commit is required the reload gate
    // (!requireNewCommit || commitChanged) is satisfied.
    expect(requireNewCommit || daemonCommitChanged(restarted, epoch)).toBe(false);
  });
});

describe("stallEscapeReady (afaea18: a stall can never be permanent)", () => {
  const epoch = "a".repeat(40);
  const healthy = { ready: true, warm: true, startup_epoch: epoch, startup_commit: { hash: epoch } };

  it("arms the escape once a healthy same-commit daemon holds past the window", () => {
    expect(stallEscapeReady(healthy, 20_000, 15_000)).toBe(true);
  });

  it("does not arm before the bounded window elapses", () => {
    expect(stallEscapeReady(healthy, 5_000, 15_000)).toBe(false);
  });

  it("does not arm while the daemon is still rebuilding, cold, or not ready", () => {
    expect(stallEscapeReady({ ...healthy, rebuilding: true }, 30_000, 15_000)).toBe(false);
    expect(stallEscapeReady({ ...healthy, warm: false }, 30_000, 15_000)).toBe(false);
    expect(stallEscapeReady({ ...healthy, ready: false }, 30_000, 15_000)).toBe(false);
    expect(stallEscapeReady(null, 30_000, 15_000)).toBe(false);
  });
});

describe("shouldEnterSplashOnProbe (cold-mount ENTER predicate)", () => {
  it("does NOT enter the splash when the cold-mount probe failed (null)", () => {
    // A daemon that cannot serve health did not serve this page either; the
    // failed probe must not hijack the UI. This is the cold-mount regression
    // guard: differs from daemonNeedsSplash(null) === true (the stay predicate).
    expect(shouldEnterSplashOnProbe(null)).toBe(false);
    expect(shouldEnterSplashOnProbe(undefined)).toBe(false);
  });

  it("enters the splash on a positive rebuilding signal", () => {
    expect(shouldEnterSplashOnProbe({ rebuilding: true })).toBe(true);
    expect(shouldEnterSplashOnProbe({ rebuilding: true, ready: true })).toBe(true);
  });

  it("enters the splash when a reachable daemon reports ready === false (mid-startup)", () => {
    expect(shouldEnterSplashOnProbe({ ready: false })).toBe(true);
  });

  it("does NOT enter on a 200 response that merely omits readiness", () => {
    // An older daemon predating this feature (or any non-health 200 body) must
    // not flash the splash: entering requires an EXPLICIT ready === false, not
    // merely "not exactly true". This is the regression that broke ui.test.ts
    // (its fetch fallback returns `[]` for /api/health).
    expect(shouldEnterSplashOnProbe({})).toBe(false);
    expect(shouldEnterSplashOnProbe([] as unknown as Record<string, never>)).toBe(false);
  });

  it("does NOT enter the splash when a reachable daemon reports ready", () => {
    expect(shouldEnterSplashOnProbe({ ready: true })).toBe(false);
    expect(shouldEnterSplashOnProbe({ ready: true, rebuilding: false })).toBe(false);
  });
});
