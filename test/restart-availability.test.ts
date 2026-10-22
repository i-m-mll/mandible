import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  RESTART_AVAILABILITY_HISTORY_LIMIT,
  RestartAvailabilityStore,
} from "../../src/restart-availability.js";

const roots: string[] = [];

function fixture(nowRef: { value: number }, instanceKey = "http://127.0.0.1:19420") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-restart-availability-"));
  roots.push(root);
  const filePath = path.join(root, "cache", "restart-availability.json");
  return {
    root,
    filePath,
    store: new RestartAvailabilityStore({
      instanceKey,
      filePath,
      now: () => nowRef.value,
    }),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("restart availability receipt", () => {
  it("retains full blocked, exact shutdown, and post-ready warm timings separately", () => {
    const now = { value: 1_000_000 };
    const { store } = fixture(now);

    expect(store.markRebuildStarted("generation-1")).toBe("generation-1");
    expect(store.currentNotice()).toMatchObject({
      phase: "rebuilding",
      request_sent: false,
      sample_count: 0,
    });
    now.value += 7_000; // hook + drain work belongs to the full blocked window.
    expect(store.markShutdownStarted("generation-1")).toBe(true);
    now.value += 3_000; // only this tail is exact shutdown -> ready.
    expect(store.markReady()).toBe("generation-1");

    let record = store.read();
    expect(record?.active).toBeNull();
    expect(record?.blocked_window).toMatchObject({ samples_ms: [10_000], average_ms: 10_000 });
    expect(record?.shutdown_to_ready).toMatchObject({ samples_ms: [3_000], average_ms: 3_000 });
    expect(record?.ready_to_warm).toMatchObject({ samples_ms: [], average_ms: null });
    expect(record?.last_completion).toMatchObject({
      generation_id: "generation-1",
      rebuild_started_at_ms: 1_000_000,
      shutdown_started_at_ms: 1_007_000,
      ready_at_ms: 1_010_000,
    });

    now.value += 2_000;
    expect(store.markWarm("generation-1")).toBe(true);
    record = store.read();
    expect(record?.ready_to_warm).toMatchObject({ samples_ms: [2_000], average_ms: 2_000 });
    expect(record?.last_completion?.warm_at_ms).toBe(1_012_000);
  });

  it("uses full-window history while rebuilding and shutdown-tail history after exact shutdown", () => {
    const now = { value: 2_000_000 };
    const { store } = fixture(now);
    store.markRebuildStarted("sample");
    now.value += 8_000;
    store.markShutdownStarted("sample");
    now.value += 2_000;
    store.markReady();

    now.value += 1_000;
    store.markRebuildStarted("next");
    expect(store.currentNotice()).toMatchObject({
      phase: "rebuilding",
      retry_after_seconds: 10,
      average_seconds: 10,
      sample_count: 1,
    });
    now.value += 4_000;
    store.markShutdownStarted("next");
    expect(store.currentNotice()).toMatchObject({
      phase: "shutdown",
      retry_after_seconds: 2,
      average_seconds: 2,
      sample_count: 1,
    });
    now.value += 2_500;
    expect(store.currentNotice()).toMatchObject({
      phase: "shutdown",
      eta_exceeded_seconds: 1,
    });
  });

  it("bounds history and writes by atomic replacement with restrictive permissions", () => {
    const now = { value: 3_000_000 };
    const { filePath, store } = fixture(now);
    for (let index = 0; index < RESTART_AVAILABILITY_HISTORY_LIMIT + 5; index += 1) {
      const generation = `generation-${index}`;
      store.markRebuildStarted(generation);
      now.value += index + 1;
      store.markShutdownStarted(generation);
      now.value += 1;
      store.markReady();
      now.value += 1;
      store.markWarm(generation);
      now.value += 1;
    }
    const record = store.read();
    expect(record?.blocked_window.sample_count).toBe(RESTART_AVAILABILITY_HISTORY_LIMIT);
    expect(record?.shutdown_to_ready.sample_count).toBe(RESTART_AVAILABILITY_HISTORY_LIMIT);
    expect(record?.ready_to_warm.sample_count).toBe(RESTART_AVAILABILITY_HISTORY_LIMIT);
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(filePath)).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(path.dirname(filePath))).toEqual(["restart-availability.json"]);
  });

  it("ignores stale, malformed, unrelated-instance, partial, and future-version state safely", () => {
    const now = { value: 4_000_000 };
    const { filePath, store } = fixture(now);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "{not-json\n");
    expect(store.read()).toBeNull();
    expect(store.currentNotice()).toBeNull();

    store.markRebuildStarted("stale");
    now.value += 300_001;
    expect(store.currentNotice()).toBeNull();
    expect(store.markReady()).toBeNull();

    const unrelated = new RestartAvailabilityStore({
      instanceKey: "http://127.0.0.1:19421",
      filePath,
      now: () => now.value,
    });
    expect(unrelated.read()).toBeNull();
    expect(unrelated.currentNotice()).toBeNull();

    fs.writeFileSync(filePath, JSON.stringify({ version: 0, instance_key: "old" }));
    expect(store.read()).toBeNull();
    expect(store.markReady()).toBeNull();

    const future = { version: 2, instance_key: "http://127.0.0.1:19420", sentinel: true };
    fs.writeFileSync(filePath, JSON.stringify(future));
    expect(store.markRebuildStarted("do-not-downgrade")).toBeNull();
    expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).toEqual(future);
  });
});
