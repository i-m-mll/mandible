// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  RESTART_AVAILABILITY_HISTORY_LIMIT,
  RestartAvailabilityStore,
} from "../src/restart-availability.js";
import { testRuntimeRoot } from "./helpers/runtime-isolation.js";

const roots: string[] = [];

function fixture(nowRef: { value: number }, instanceKey = "http://127.0.0.1:19420") {
  const root = fs.mkdtempSync(path.join(testRuntimeRoot, "restart-availability-"));
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
