// Bug: 645f8a8 — splash/readiness decision rules used by the dashboard mount
// probe and the rebuild poll. The splash must persist while the health fetch
// fails, OR rebuilding === true, OR ready !== true.
import { describe, expect, it } from "vitest";

import { daemonIsReady, daemonNeedsSplash } from "../ui/src/daemon-readiness";

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
