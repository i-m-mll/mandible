import { describe, expect, it, vi } from "vitest";
import {
  DaemonMemoryDiagnostics,
  DEFAULT_MEMORY_WARNING_FRACTION,
  memoryWarningFractionFromEnv,
  type ProcessMemoryValues,
} from "../../src/daemon-memory.js";

function values(rss: number): ProcessMemoryValues {
  return {
    rss,
    heapTotal: rss / 2,
    heapUsed: rss / 4,
    external: rss / 8,
    arrayBuffers: rss / 16,
  };
}

describe("daemon memory diagnostics", () => {
  it("tracks high-water values and logs warning transitions without poll spam", () => {
    let current = values(20);
    const logger = vi.fn();
    const diagnostics = new DaemonMemoryDiagnostics({
      logger,
      warningFraction: 0.5,
      sources: {
        memoryUsage: () => current,
        uptime: () => 12,
        totalMemory: () => 100,
      },
    });

    expect(diagnostics.sample()).toMatchObject({ rss: 20, warning: false, uptime: 12 });
    current = values(60);
    expect(diagnostics.sample()).toMatchObject({ rss: 60, warning: true });
    current = values(55);
    expect(diagnostics.sample()).toMatchObject({ rss: 55, warning: true });
    current = values(44);
    const recovered = diagnostics.sample();

    expect(recovered.warning).toBe(false);
    expect(recovered.highWater).toEqual(values(60));
    expect(logger.mock.calls.map((call) => call[1])).toEqual([
      "daemon_memory_warning",
      "daemon_memory_recovered",
    ]);
  });

  it("returns the last sample from snapshot without collecting a new one", () => {
    let current = values(20);
    let usageCalls = 0;
    const diagnostics = new DaemonMemoryDiagnostics({
      logger: () => undefined,
      warningFraction: 0.5,
      sources: {
        memoryUsage: () => {
          usageCalls += 1;
          return current;
        },
        uptime: () => 7,
        totalMemory: () => 100,
      },
    });

    // Before any sample, snapshot reports an empty seed and reads no source.
    expect(diagnostics.snapshot()).toMatchObject({ rss: 0, warning: false });
    expect(usageCalls).toBe(0);

    diagnostics.sample();
    const callsAfterSample = usageCalls;
    current = values(90);

    // snapshot reflects the prior sample and does not re-read process memory,
    // so a burst of health polls cannot trip the warning transition.
    const snap = diagnostics.snapshot();
    expect(snap).toMatchObject({ rss: 20, warning: false });
    expect(usageCalls).toBe(callsAfterSample);
  });

  it("remains constant-space across a deterministic soak", () => {
    let iteration = 0;
    const diagnostics = new DaemonMemoryDiagnostics({
      logger: () => undefined,
      sources: {
        memoryUsage: () => values((iteration++ % 100) + 1),
        uptime: () => iteration,
        totalMemory: () => 10_000,
      },
    });
    const initialProperties = Object.getOwnPropertyNames(diagnostics).sort();

    for (let index = 0; index < 100_000; index += 1) {
      diagnostics.sample();
    }

    expect(Object.getOwnPropertyNames(diagnostics).sort()).toEqual(initialProperties);
    for (const retained of Object.values(diagnostics)) {
      expect(Array.isArray(retained)).toBe(false);
      expect(retained).not.toBeInstanceOf(Map);
      expect(retained).not.toBeInstanceOf(Set);
    }
    expect(diagnostics.sample().highWater.rss).toBe(100);
  });

  it("uses a safe default for absent or invalid warning thresholds", () => {
    expect(memoryWarningFractionFromEnv({})).toBe(DEFAULT_MEMORY_WARNING_FRACTION);
    expect(memoryWarningFractionFromEnv({ MANDIBLE_MEMORY_WARNING_FRACTION: "0.2" })).toBe(0.2);
    expect(memoryWarningFractionFromEnv({ MANDIBLE_MEMORY_WARNING_FRACTION: "0" }))
      .toBe(DEFAULT_MEMORY_WARNING_FRACTION);
    expect(memoryWarningFractionFromEnv({ MANDIBLE_MEMORY_WARNING_FRACTION: "not-a-number" }))
      .toBe(DEFAULT_MEMORY_WARNING_FRACTION);
  });
});
