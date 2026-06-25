// Bug: 645f8a8 — splash/readiness decision rules used by the dashboard mount
// probe and the rebuild poll. The splash must persist while the health fetch
// fails, OR rebuilding === true, OR ready !== true.
import { describe, expect, it } from "vitest";

import { daemonIsReady, daemonNeedsSplash, shouldEnterSplashOnProbe } from "../ui/src/daemon-readiness";

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
