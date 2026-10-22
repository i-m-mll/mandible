/**
 * The gate's timing packet and checkout watcher (issues 9e40a31, fec6f89).
 *
 * ## What is measured
 *
 * Per-file *occupancy*, not accumulated test duration. A fork is held for the
 * whole of environment setup, harness preparation, module import and collection
 * as well as the tests themselves, and all of it counts against the schedule.
 *
 * ## The bound
 *
 * For indivisible per-file tasks the scheduling lower bound is
 *
 *     max(sum of file occupancies / workers, longest single file)
 *
 * A ratio of wall/(sum/workers) alone is the wrong metric and must not be
 * reintroduced: it reported "3.1x the floor" for a schedule that was within 1%
 * of optimal, because one file was 99% of the wall clock.
 *
 * ## Enforcement
 *
 * Every suite: checkout cleanliness — `git status --porcelain
 * --untracked-files=all` must read the same at the end of the run as at the
 * start, so a test that writes into the repository fails the run — and the
 * inventory rule: a skipped or todo test, or a file that ran no tests, fails
 * the run. A run filtered by name (`-t`) or line marks the tests it leaves out
 * as skipped too, so skips are judged only on unfiltered runs.
 *
 * The gate also gets the timing packet: the relative outlier rule
 * (hardware-independent) always, and with `MANDIBLE_TIMING_GATE=1`, on a
 * controlled machine, the absolute budget: occupancy sum, slowest file, wall.
 *
 * `MANDIBLE_TIMING_JSON=<path>` additionally writes the full packet, every
 * file's occupancy included.
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";

import type { Reporter, TestModule } from "vitest/node";

const WALL_LIMIT_MS = 60_000;
const FILE_LIMIT_MS = 25_000;
const SUM_LIMIT_MS = 600_000;
const OUTLIER_FLOOR_MS = 30_000;
const OUTLIER_RATIO = 2;

interface FileTiming {
  name: string;
  occupancyMs: number;
}

function occupancy(module: TestModule): number {
  const d = module.diagnostic();
  return (
    d.environmentSetupDuration +
    d.prepareDuration +
    d.collectDuration +
    d.setupDuration +
    d.duration
  );
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`;
}

type CheckoutState = { ok: true; entries: string[] } | { ok: false; error: string };

function checkoutState(): CheckoutState {
  const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  if (status.error || status.status !== 0) {
    return { ok: false, error: status.error?.message ?? (status.stderr.trim() || `exit ${status.status}`) };
  }
  return { ok: true, entries: status.stdout.split("\n").filter(Boolean) };
}

function checkoutViolation(before: CheckoutState, after: CheckoutState): string | null {
  if (!before.ok) return `cannot read checkout state at run start: ${before.error}`;
  if (!after.ok) return `cannot read checkout state at run end: ${after.error}`;
  const start = new Set(before.entries);
  const end = new Set(after.entries);
  const changes = [
    ...after.entries.filter((entry) => !start.has(entry)).map((entry) => `+ ${entry}`),
    ...before.entries.filter((entry) => !end.has(entry)).map((entry) => `- ${entry}`),
  ];
  if (changes.length === 0) return null;
  return `the run changed the checkout; tests must write only under their own temp root ` +
    `(testRuntimeRoot in test/helpers/runtime-isolation.ts):\n${changes.map((c) => `        ${c}`).join("\n")}`;
}

function inventoryViolations(testModules: ReadonlyArray<TestModule>, filtered: boolean): string[] {
  return testModules.flatMap((module) => {
    const name = module.moduleId.replace(`${process.cwd()}/`, "");
    const tests = [...module.children.allTests()];
    if (tests.length === 0) return [`${name} ran no tests; delete it or give it one.`];
    if (filtered) return [];
    return tests
      .filter((test) => test.result().state === "skipped")
      .map((test) => `${name} > ${test.fullName} is ${test.options.mode === "todo" ? "todo" : "skipped"}; delete it or fix it.`);
  });
}

export default class RunContractReporter implements Reporter {
  private startedAt = 0;
  private workers = Math.max(1, availableParallelism() - 1);
  private checkoutAtStart: CheckoutState = { ok: false, error: "reporter was not initialised" };
  private filtered = false;
  private readonly timing: boolean;

  constructor(options: { timing?: boolean } = {}) {
    this.timing = options.timing ?? false;
  }

  onInit(vitest: { config?: { maxWorkers?: number | string; testNamePattern?: unknown; includeTaskLocation?: boolean } }): void {
    this.startedAt = Date.now();
    this.checkoutAtStart = checkoutState();
    this.filtered = Boolean(vitest?.config?.testNamePattern) || Boolean(vitest?.config?.includeTaskLocation);
    const configured = vitest?.config?.maxWorkers;
    if (typeof configured === "number" && configured > 0) {
      this.workers = configured;
    }
  }

  onTestRunEnd(testModules: ReadonlyArray<TestModule>): void {
    const violations = [
      ...inventoryViolations(testModules, this.filtered),
      ...[checkoutViolation(this.checkoutAtStart, checkoutState())].filter((v): v is string => v !== null),
      ...(this.timing ? this.timingPacket(testModules) : []),
    ];
    if (violations.length > 0) {
      process.stdout.write(`${["  RUN CONTRACT FAILED", ...violations.map((v) => `    - ${v}`), ""].join("\n")}\n`);
      process.exitCode = 1;
    }
  }

  /** Prints the packet and returns the timing violations. */
  private timingPacket(testModules: ReadonlyArray<TestModule>): string[] {
    const wallMs = Date.now() - this.startedAt;
    const files: FileTiming[] = testModules
      .map((module) => ({
        name: module.moduleId.replace(`${process.cwd()}/`, ""),
        occupancyMs: occupancy(module),
      }))
      .sort((a, b) => b.occupancyMs - a.occupancyMs);

    if (files.length === 0) return [];

    const sumMs = files.reduce((total, file) => total + file.occupancyMs, 0);
    const slowest = files[0]!;
    const second = files[1];
    const throughputFloorMs = sumMs / this.workers;
    const lowerBoundMs = Math.max(throughputFloorMs, slowest.occupancyMs);
    const efficiency = wallMs / lowerBoundMs;

    const lines: string[] = [
      "",
      "  Timing contract",
      `    wall                 ${seconds(wallMs)}`,
      `    files                ${files.length}`,
      `    workers              ${this.workers}`,
      `    sum of occupancies   ${seconds(sumMs)}`,
      `    throughput floor     ${seconds(throughputFloorMs)}  (sum / workers)`,
      `    slowest file         ${seconds(slowest.occupancyMs)}  ${slowest.name}`,
    ];
    if (second) {
      lines.push(`    second slowest       ${seconds(second.occupancyMs)}  ${second.name}`);
    }
    lines.push(
      `    lower bound          ${seconds(lowerBoundMs)}  max(floor, slowest)`,
      `    scheduling ratio     ${efficiency.toFixed(2)}x  (wall / lower bound)`,
      "",
      "    slowest ten:",
      ...files.slice(0, 10).map((f) => `      ${seconds(f.occupancyMs).padStart(8)}  ${f.name}`),
      "",
    );

    const absolute = process.env.MANDIBLE_TIMING_GATE === "1";
    const violations: string[] = [];

    if (
      second &&
      slowest.occupancyMs > OUTLIER_FLOOR_MS &&
      slowest.occupancyMs > OUTLIER_RATIO * second.occupancyMs
    ) {
      violations.push(
        `${slowest.name} is ${seconds(slowest.occupancyMs)}, more than ${OUTLIER_RATIO}x the ` +
          `next file (${seconds(second.occupancyMs)}). Split it: file parallelism cannot ` +
          `divide a single file, so this file alone sets the gate's floor.`,
      );
    }

    if (absolute) {
      if (sumMs > SUM_LIMIT_MS) {
        violations.push(`sum of occupancies ${seconds(sumMs)} exceeds the ${seconds(SUM_LIMIT_MS)} budget.`);
      }
      for (const file of files.filter((f) => f.occupancyMs > FILE_LIMIT_MS)) {
        violations.push(`${file.name} at ${seconds(file.occupancyMs)} exceeds the ${seconds(FILE_LIMIT_MS)} per-file budget.`);
      }
      if (wallMs > WALL_LIMIT_MS) {
        violations.push(`wall ${seconds(wallMs)} exceeds the ${seconds(WALL_LIMIT_MS)} budget.`);
      }
    } else {
      lines.push(
        "    absolute budgets not enforced (set MANDIBLE_TIMING_GATE=1 on a controlled machine)",
        "",
      );
    }

    const packetPath = process.env.MANDIBLE_TIMING_JSON;
    if (packetPath) {
      writeFileSync(packetPath, `${JSON.stringify({
        wall_ms: wallMs,
        workers: this.workers,
        sum_ms: sumMs,
        lower_bound_ms: lowerBoundMs,
        files: files.map((f) => ({ file: f.name, occupancy_ms: Math.round(f.occupancyMs) })),
        violations,
      }, null, 2)}\n`);
    }

    process.stdout.write(`${lines.join("\n")}\n`);
    return violations;
  }
}
