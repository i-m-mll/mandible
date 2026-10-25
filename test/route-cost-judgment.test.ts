// @vitest-environment node
import { describe, expect, it } from "vitest";
import { CONFIRMATION_TRIALS, judgeRoute, LOAD_WAIT_MS, trialTurns, waitForLoad, writeReplayPlan } from "../scripts/route-cost-judgment.ts";

const trial = (first: number, warm: number) => [
  { pass: 1, worstTurnMs: first },
  { pass: 2, worstTurnMs: warm },
];

describe("write confirmation replay plan", () => {
  const order = ["assume", "release", "link", "unlink", "claim", "activate", "delivered", "ack", "ack-all", "dismiss"];
  const exercised = ["dismiss", "activate", "claim", "unlink", "link", "release", "assume", "ack-all", "ack"];

  it("replays only exercised earlier writes, in write order rather than catalog order", () => {
    expect(writeReplayPlan(order, exercised, "assume")).toEqual([]);
    expect(writeReplayPlan(order, exercised, "release")).toEqual(["assume"]);
    expect(writeReplayPlan(order, exercised, "unlink")).toEqual(["assume", "release", "link"]);
    expect(writeReplayPlan(order, exercised, "activate")).toEqual(["assume", "release", "link", "unlink", "claim"]);
    expect(writeReplayPlan(order, exercised, "dismiss")).toEqual([
      "assume", "release", "link", "unlink", "claim", "activate", "ack", "ack-all",
    ]);
  });

  it("rejects targets outside the exercised write plan", () => {
    expect(() => writeReplayPlan(order, exercised, "delivered")).toThrow("Not an exercised write");
    expect(() => writeReplayPlan(order, exercised, "read")).toThrow("Not an exercised write");
  });
});

describe("route-cost confirmation", () => {
  it("discards a single first-call or warm spike and retains its readings", () => {
    for (const spike of [trial(186, 35), trial(35, 186)]) {
      const trials = [spike, ...Array.from({ length: CONFIRMATION_TRIALS }, () => trial(35, 11))];
      expect(judgeRoute(trials, 100)).toEqual({ firstCallMs: 35, warmMs: 11, worstMs: 35, overBudget: false });
      expect(trials[0]).toEqual(spike);
    }
  });

  it.each([
    { name: "both call kinds", readings: [trial(140, 120), trial(110, 101), trial(130, 100), trial(125, 115)], first: 110, warm: 100 },
    { name: "cold only", readings: [trial(140, 11), trial(100, 15), trial(125, 20), trial(130, 13)], first: 100, warm: 11 },
    { name: "warm only", readings: [trial(11, 140), trial(15, 100), trial(20, 125), trial(13, 130)], first: 11, warm: 100 },
  ])("fails a consistent offender on $name, including the exact budget", ({ readings, first, warm }) => {
    expect(judgeRoute(readings, 100)).toEqual({ firstCallMs: first, warmMs: warm, worstMs: Math.max(first, warm), overBudget: true });
  });

  it("requires the same call kind across trials", () => {
    expect(judgeRoute([trial(140, 11), trial(11, 140), trial(140, 11), trial(11, 140)], 100).overBudget).toBe(false);
  });

  it("includes the main reading and every confirmation in the verdict", () => {
    expect(judgeRoute([trial(11, 186), trial(140, 11), trial(140, 11), trial(140, 11)], 100).overBudget).toBe(false);
    expect(judgeRoute([trial(186, 11), trial(140, 11), trial(11, 11), trial(140, 11)], 100).overBudget).toBe(false);
  });

  it("uses every request variant and warm pass within a trial", () => {
    const readings = [...trial(11, 15), { pass: 1, worstTurnMs: 120 }, { pass: 3, worstTurnMs: 130 }];
    expect(trialTurns(readings)).toEqual({ firstCallMs: 120, warmMs: 130 });
    expect(judgeRoute([trial(99, 85)], 100).overBudget).toBe(false);
    expect(judgeRoute([[{ pass: 1, worstTurnMs: 100 }]], 100)).toMatchObject({ warmMs: 0, overBudget: true });
  });
});

describe("load wait", () => {
  function clock() {
    let time = 0;
    const waits: number[] = [];
    return { now: () => time, waits, wait: async (ms: number) => { waits.push(ms); time += ms; } };
  }

  it("waits at core count, then starts as soon as load falls below it", async () => {
    const timing = clock();
    const loads = [14, 17, 13];
    const result = await waitForLoad({ cpus: 14, readLoad: () => loads.shift()!, ...timing });
    expect(result).toMatchObject({ start: 14, measurement_start: 13, waited_ms: 10_000 });
    expect(timing.waits).toEqual([5_000, 5_000]);
  });

  it("proceeds after three minutes of sustained overload", async () => {
    const timing = clock();
    await expect(waitForLoad({ cpus: 14, readLoad: () => 17, ...timing })).resolves.toEqual({
      start: 17, measurement_start: 17, waited_ms: LOAD_WAIT_MS, wait_limit_ms: LOAD_WAIT_MS, cpus: 14,
    });
    expect(timing.now()).toBe(180_000);
  });

  it("caps the last poll at the deadline and supports bypassing the wait", async () => {
    const timing = clock();
    await waitForLoad({ cpus: 14, readLoad: () => 17, maxWaitMs: 12_000, ...timing });
    expect(timing.waits).toEqual([5_000, 5_000, 2_000]);
    const bypass = clock();
    await expect(waitForLoad({ cpus: 14, readLoad: () => 17, maxWaitMs: 0, ...bypass })).resolves.toMatchObject({ waited_ms: 0, measurement_start: 17 });
    expect(bypass.waits).toEqual([]);
    const quiet = clock();
    await waitForLoad({ cpus: 14, readLoad: () => 13, ...quiet });
    expect(quiet.waits).toEqual([]);
  });
});
