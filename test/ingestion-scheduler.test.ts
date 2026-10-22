import { describe, expect, it } from "vitest";

import { BoundedDirtyPathSet, DIRTY_INGEST_BATCH_SIZE } from "../src/ingestion.js";
import { IngestionPriorityQueue } from "../src/ingestion-priority-queue.js";

describe("event-driven ingestion scheduling", () => {

  it("deduplicates dirty paths and drains them in bounded insertion-order batches", () => {
    const dirty = new BoundedDirtyPathSet(4);
    expect(dirty.add("one")).toEqual({ added: true, replacedPath: undefined });
    expect(dirty.add("one")).toEqual({ added: false });
    dirty.add("two");
    dirty.add("three");
    dirty.add("four");
    expect(dirty.add("five")).toEqual({ added: true, replacedPath: "one" });
    expect(dirty.size).toBe(4);
    expect(dirty.take(Math.min(2, DIRTY_INGEST_BATCH_SIZE))).toEqual(["two", "three"]);
    expect(dirty.take(DIRTY_INGEST_BATCH_SIZE)).toEqual(["four", "five"]);
    expect(dirty.size).toBe(0);
  });

  it("removes a queued watcher path when an exact read takes ownership", () => {
    const dirty = new BoundedDirtyPathSet(4);
    dirty.add("selected");
    dirty.add("other");
    expect(dirty.delete("selected")).toBe(true);
    expect(dirty.take(DIRTY_INGEST_BATCH_SIZE)).toEqual(["other"]);
  });
});

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
