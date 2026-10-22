import { describe, expect, it } from "vitest";

import { IngestionPriorityQueue } from "../src/ingestion-priority-queue.js";

describe("ingestion priority queue", () => {
  it("runs an exact ingest at a background reconciliation boundary", async () => {
    const events: string[] = [];
    let releaseBackground!: () => void;
    const backgroundPaused = new Promise<void>((resolve) => { releaseBackground = resolve; });
    let backgroundStarted!: () => void;
    const started = new Promise<void>((resolve) => { backgroundStarted = resolve; });
    const queue = new IngestionPriorityQueue<string>(async (value, cooperate) => {
      events.push(`${value}:start`);
      if (value === "reconcile") {
        backgroundStarted();
        await backgroundPaused;
        await cooperate();
      }
      events.push(`${value}:end`);
    });

    const background = queue.enqueue("reconcile");
    await started;
    const exact = queue.enqueue("exact", true);
    releaseBackground();
    await Promise.all([background, exact]);

    expect(events).toEqual([
      "reconcile:start",
      "exact:start",
      "exact:end",
      "reconcile:end",
    ]);
  });

  it("preserves FIFO order for ordinary ingestion", async () => {
    const events: string[] = [];
    const queue = new IngestionPriorityQueue<string>(async (value) => {
      events.push(value);
    });
    await Promise.all([
      queue.enqueue("first"),
      queue.enqueue("second"),
      queue.enqueue("third"),
    ]);
    expect(events).toEqual(["first", "second", "third"]);
  });
});
