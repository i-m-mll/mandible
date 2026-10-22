import { describe, expect, it, vi } from "vitest";
import {
  DaemonMemoryDiagnostics,
  type ProcessMemoryValues,
} from "../src/daemon-memory.js";

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
});
