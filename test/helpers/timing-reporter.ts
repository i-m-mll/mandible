/**
 * File inventory, checkout guard, and Vitest diagnostic phases. The runner
 * joins these phases with actual fork lifetimes after shutdown, charges
 * uncovered shared work once, and enforces the timing budgets.
 */
import { writeFileSync } from "node:fs";
import { checkoutState, checkoutViolation } from "../../scripts/test-run-contract.mjs";
import { availableParallelism } from "node:os";

import type { Reporter, TestModule } from "vitest/node";

interface FileTiming {
  name: string;
  occupancyMs: number;
  phases: Record<string, number>;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`;
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
  private checkoutAtStart: ReturnType<typeof checkoutState> = { ok: false, error: "reporter was not initialised" };
  private filtered = false;
  private readonly timing: boolean;

  constructor(options: { timing?: boolean } = {}) {
    this.timing = options.timing ?? false;
  }

  onInit(vitest: { config?: { maxWorkers?: number | string; testNamePattern?: unknown; includeTaskLocation?: boolean; environment?: string } }): void {
    this.startedAt = performance.now();
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
    ];
    if (this.timing) this.timingPacket(testModules, violations);
    if (violations.length > 0) {
      process.stdout.write(`${["  RUN CONTRACT FAILED", ...violations.map((v) => `    - ${v}`), ""].join("\n")}\n`);
      process.exitCode = 1;
    }
  }

  /** Emit diagnostics before the worker pool has necessarily finished shutting down. */
  private timingPacket(testModules: ReadonlyArray<TestModule>, violations: string[]): void {
    const wallMs = performance.now() - this.startedAt;
    const files: FileTiming[] = testModules
      .map((module) => {
        const d = module.diagnostic();
        const phases = {
          environment_ms: d.environmentSetupDuration,
          prepare_ms: d.prepareDuration,
          collect_ms: d.collectDuration,
          setup_ms: d.setupDuration,
          test_ms: d.duration,
        };
        return {
          name: module.moduleId.replace(`${process.cwd()}/`, ""),
          occupancyMs: Object.values(phases).reduce((sum, value) => sum + value, 0),
          phases,
        };
      })
      .sort((a, b) => b.occupancyMs - a.occupancyMs);

    if (files.length === 0) return;

    const sumMs = files.reduce((total, file) => total + file.occupancyMs, 0);
    const lines = [
      "",
      "  Vitest diagnostic phases",
      `    Vitest wall          ${seconds(wallMs)}`,
      `    files                ${files.length}`,
      `    configured slots     ${this.workers}`,
      `    diagnostic sum       ${seconds(sumMs)}`,
      "    Full lifecycle timing follows after worker shutdown.",
      "",
    ];

    const packetPath = process.env.MANDIBLE_TEST_TIMING_PACKET;
    if (packetPath) {
      writeFileSync(packetPath, `${JSON.stringify({
        vitest_wall_ms: wallMs,
        reporter_finished_at_ns: process.hrtime.bigint().toString(),
        workers: this.workers,
        diagnostic_file_sum_ms: sumMs,
        tests: testModules.reduce((sum, module) => sum + [...module.children.allTests()].length, 0),
        phases: files.reduce((total, file) => {
          for (const [phase, ms] of Object.entries(file.phases)) total[phase] = (total[phase] ?? 0) + ms;
          return total;
        }, {} as Record<string, number>),
        files: files.map((f) => ({ file: f.name, absolute_file: `${process.cwd()}/${f.name}`, diagnostic_occupancy_ms: f.occupancyMs, ...f.phases })),
        violations,
      }, null, 2)}\n`);
    }

    process.stdout.write(`${lines.join("\n")}\n`);
  }
}
