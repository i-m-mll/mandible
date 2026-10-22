// Splash enter/exit predicates used by the dashboard mount probe and the
// rebuild poll (645f8a8, afaea18). Entering requires an explicit signal; staying
// requires anything short of proven readiness; a stall always has an escape.
import { describe, expect, it } from "vitest";

import {
  daemonCommitChanged,
  daemonEpochChanged,
  daemonIsReadyAfterEpoch,
  daemonNeedsSplash,
  shouldEnterSplashOnBackgroundProbe,
  shouldEnterSplashOnProbe,
  splashRequiresNewCommit,
  stallEscapeReady,
} from "../ui/src/daemon-readiness";

const oldEpoch = "a".repeat(40);
const newEpoch = "b".repeat(40);

describe("daemon splash predicates", () => {
  it("stays up until the daemon is reachable, ready, and not rebuilding", () => {
    const cases: Array<[Parameters<typeof daemonNeedsSplash>[0], boolean]> = [
      [null, true],
      [undefined, true],
      [{ rebuilding: true, ready: true }, true],
      [{ ready: false }, true],
      [{}, true],
      [{ ready: true }, false],
      [{ ready: true, rebuilding: false }, false],
    ];
    for (const [health, expected] of cases) expect(daemonNeedsSplash(health), JSON.stringify(health)).toBe(expected);
  });

  it("enters on a cold-mount probe only for an explicit rebuilding or not-ready signal", () => {
    const cases: Array<[Parameters<typeof shouldEnterSplashOnProbe>[0], boolean]> = [
      // A daemon that cannot serve health did not serve this page either.
      [null, false],
      [undefined, false],
      [{ rebuilding: true }, true],
      [{ ready: false }, true],
      // A 200 that merely omits readiness must not flash the splash.
      [{}, false],
      [[] as unknown as Record<string, never>, false],
      [{ ready: true }, false],
    ];
    for (const [health, expected] of cases) expect(shouldEnterSplashOnProbe(health), JSON.stringify(health)).toBe(expected);
  });

  it("releases an announced rebuild only on a new epoch and recovers a missed rebuild from epoch drift", () => {
    expect(daemonIsReadyAfterEpoch({ ready: true, startup_epoch: oldEpoch }, oldEpoch, true)).toBe(false);
    expect(daemonIsReadyAfterEpoch({ ready: true }, oldEpoch, true)).toBe(false);
    expect(daemonIsReadyAfterEpoch({ ready: true, startup_epoch: newEpoch }, oldEpoch, true)).toBe(true);
    expect(daemonIsReadyAfterEpoch({ ready: true }, null, false)).toBe(true);
    expect(shouldEnterSplashOnBackgroundProbe(
      { ready: true, startup_epoch: newEpoch, startup_commit: { hash: oldEpoch } },
      oldEpoch,
    )).toBe(true);
    expect(shouldEnterSplashOnBackgroundProbe({ ready: true, startup_epoch: oldEpoch }, oldEpoch)).toBe(false);
  });

  it("does not strand a manual restart: bare epoch drift releases without a new commit", () => {
    const requireNewCommit = splashRequiresNewCommit(false);
    const restarted = { ready: true, startup_epoch: newEpoch, startup_commit: { hash: oldEpoch } };
    expect(splashRequiresNewCommit(true)).toBe(true);
    expect(daemonEpochChanged(restarted, oldEpoch)).toBe(true);
    expect(daemonIsReadyAfterEpoch(restarted, oldEpoch, true)).toBe(true);
    expect(requireNewCommit || daemonCommitChanged(restarted, oldEpoch)).toBe(false);
  });

  it("arms the stall escape only for a healthy daemon held past the window", () => {
    const healthy = { ready: true, warm: true, startup_epoch: oldEpoch, startup_commit: { hash: oldEpoch } };
    expect(stallEscapeReady(healthy, 20_000, 15_000)).toBe(true);
    expect(stallEscapeReady(healthy, 5_000, 15_000)).toBe(false);
    expect(stallEscapeReady({ ...healthy, rebuilding: true }, 30_000, 15_000)).toBe(false);
    expect(stallEscapeReady({ ...healthy, warm: false }, 30_000, 15_000)).toBe(false);
    expect(stallEscapeReady({ ...healthy, ready: false }, 30_000, 15_000)).toBe(false);
    expect(stallEscapeReady(null, 30_000, 15_000)).toBe(false);
  });
});
