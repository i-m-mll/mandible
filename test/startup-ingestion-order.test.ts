import { describe, expect, it, vi } from "vitest";

import { startIngestionAfterStartupWorkScan } from "../src/index.js";

describe("startup ingestion ordering", () => {
  it("starts ingestion only after the initial work scan settles, including failure", async () => {
    let resolveScan: (() => void) | undefined;
    const scan = new Promise<void>((resolve) => { resolveScan = resolve; });
    const start = vi.fn();
    const logger = vi.fn();
    startIngestionAfterStartupWorkScan(scan, start, logger);
    expect(start).not.toHaveBeenCalled();

    resolveScan?.();
    await Promise.resolve();
    expect(start).toHaveBeenCalledOnce();

    const failure = new Error("scanner unavailable");
    const failedStart = vi.fn();
    const failedLogger = vi.fn();
    startIngestionAfterStartupWorkScan(Promise.reject(failure), failedStart, failedLogger);
    await Promise.resolve();
    await Promise.resolve();
    expect(failedStart).toHaveBeenCalledOnce();
    expect(failedLogger).toHaveBeenCalledWith("warn", "startup_work_scan_failed", {
      error: String(failure),
    });
  });

  it("does not start ingestion after daemon shutdown cancels the pending scan", async () => {
    let resolveScan: (() => void) | undefined;
    const scan = new Promise<void>((resolve) => { resolveScan = resolve; });
    const start = vi.fn();
    const cancel = startIngestionAfterStartupWorkScan(scan, start, vi.fn());

    cancel();
    resolveScan?.();
    await Promise.resolve();

    expect(start).not.toHaveBeenCalled();
  });
});
