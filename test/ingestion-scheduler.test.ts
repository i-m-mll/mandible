import { describe, expect, it } from "vitest";

import {
  BoundedDirtyPathSet,
  DIRTY_INGEST_BATCH_SIZE,
  RECONCILE_INTERVAL_MS,
} from "../src/ingestion.js";

describe("event-driven ingestion scheduling", () => {
  it("uses an hourly safety sweep rather than a minute-scale primary scan", () => {
    expect(RECONCILE_INTERVAL_MS).toBe(60 * 60_000);
  });

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
