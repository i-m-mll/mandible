/**
 * Default-gate timing contract (issue 9e40a31).
 *
 * The gate regressed to 663s and then sat at 102.7s not because any one test
 * was slow but because 139 uniformly expensive tests lived in one file, and
 * Vitest parallelises across files and never within one. Nothing measured that.
 * `test/README.md` asked for readmitted tests to cost under a second and no
 * mechanism checked it.
 *
 * This reporter publishes the numbers that make the failure mode visible, and
 * fails the run on the shape that caused it.
 *
 * ## What is measured
 *
 * Per-file *occupancy*, not accumulated test duration. A fork is held for the
 * whole of environment setup, harness preparation, module import and collection
 * as well as the tests themselves, and all of it counts against the schedule.
 * Using only `diagnostic().duration` understates a file by several seconds.
 *
 * ## The bound
 *
 * For indivisible per-file tasks the scheduling lower bound is
 *
 *     max(sum of file occupancies / workers, longest single file)
 *
 * The longest-file term is the one that matters here: it is why 13 idle-capable
 * workers still produced a 102.7s wall clock, and why the fix was to split the
 * file rather than to add parallelism that already existed. A ratio of
 * wall/(sum/workers) alone is the wrong metric and must not be reintroduced —
 * it reported "3.1x the floor" for a schedule that was within 1% of optimal.
 *
 * ## Enforcement
 *
 * The relative outlier rule is always enforced: it is hardware-independent, so
 * it is safe on the variable `ubuntu-latest` runners CI uses. The absolute
 * wall-clock and slowest-file rules are enforced only when
 * `MANDIBLE_TIMING_GATE=1`, which is for a controlled machine — an absolute
 * 60-second budget is not meaningful on a runner of unknown size.
 */
import { availableParallelism } from "node:os";

import type { Reporter, TestModule } from "vitest/node";

const WALL_LIMIT_MS = 60_000;
const SLOWEST_LIMIT_MS = 45_000;
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

export default class TimingContractReporter implements Reporter {
  private startedAt = 0;
  private workers = Math.max(1, availableParallelism() - 1);

  onInit(vitest: { config?: { maxWorkers?: number | string } }): void {
    this.startedAt = Date.now();
    const configured = vitest?.config?.maxWorkers;
    if (typeof configured === "number" && configured > 0) {
      this.workers = configured;
    }
  }

  onTestRunEnd(testModules: ReadonlyArray<TestModule>): void {
    const wallMs = Date.now() - this.startedAt;
    const files: FileTiming[] = testModules
      .map((module) => ({
        name: module.moduleId.replace(`${process.cwd()}/`, ""),
        occupancyMs: occupancy(module),
      }))
      .sort((a, b) => b.occupancyMs - a.occupancyMs);

    if (files.length === 0) return;

    const sumMs = files.reduce((total, file) => total + file.occupancyMs, 0);
    const slowest = files[0]!;
    const second = files[1];
    const throughputFloorMs = sumMs / this.workers;
    const lowerBoundMs = Math.max(throughputFloorMs, slowest.occupancyMs);
    const efficiency = wallMs / lowerBoundMs;

    const lines: string[] = [
      "",
      "  Timing contract (issue 9e40a31)",
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
      "    slowest five:",
      ...files.slice(0, 5).map((f) => `      ${seconds(f.occupancyMs).padStart(8)}  ${f.name}`),
      "",
    );

    const absolute = process.env.MANDIBLE_TIMING_GATE === "1";
    const violations: string[] = [];

    // Always enforced: hardware-independent, and it is the exact shape that
    // produced the regression — one file dominating a schedule that has room.
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
      if (wallMs > WALL_LIMIT_MS) {
        violations.push(`wall ${seconds(wallMs)} exceeds the ${seconds(WALL_LIMIT_MS)} budget.`);
      }
      if (slowest.occupancyMs > SLOWEST_LIMIT_MS) {
        violations.push(
          `slowest file ${slowest.name} at ${seconds(slowest.occupancyMs)} exceeds the ` +
            `${seconds(SLOWEST_LIMIT_MS)} per-file budget.`,
        );
      }
    } else {
      lines.push(
        "    absolute budgets not enforced (set MANDIBLE_TIMING_GATE=1 on a controlled machine)",
        "",
      );
    }

    if (violations.length > 0) {
      lines.push("  TIMING CONTRACT FAILED", ...violations.map((v) => `    - ${v}`), "");
      process.exitCode = 1;
    }

    process.stdout.write(`${lines.join("\n")}\n`);
  }
}
