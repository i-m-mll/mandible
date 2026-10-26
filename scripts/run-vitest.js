import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ProcessGroupSupervisor } from "./process-group-supervisor.mjs";
import { createTestRuntime } from "./test-runtime-isolation.mjs";
import { checkoutState, checkoutViolation, completeTimingPacket } from "./test-run-contract.mjs";

const commandStartedAt = performance.now();
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const checkoutAtStart = checkoutState(repoRoot);
const candidates = [
  path.join(repoRoot, "node_modules", "vitest", "vitest.mjs"),
  path.join(repoRoot, "node_modules", "vitest", "dist", "cli.js"),
];
const vitestPath = candidates.find((candidate) => existsSync(candidate));
if (!vitestPath) {
  console.error("Unable to locate the Vitest CLI entrypoint.");
  process.exit(1);
}

const preparationStartedAt = performance.now();
const runtime = createTestRuntime();
let preparationMs = 0;
let fixturePreparationMs = 0;
const packetPath = path.join(runtime.env.MANDIBLE_TEST_RUNTIME_ROOT, "timing.json");
runtime.env.MANDIBLE_TEST_TIMING_PACKET = packetPath;
const workerTimingPath = path.join(runtime.env.MANDIBLE_TEST_RUNTIME_ROOT, 'worker-lifecycles.jsonl');
writeFileSync(workerTimingPath, '', { mode: 0o600 });
runtime.env.MANDIBLE_TEST_WORKER_TIMING = workerTimingPath;
const supervisor = new ProcessGroupSupervisor();
const errors = [];
let child;
let capturedChildPid;
let childStartedAt;
let childSettledAtNs;
let childMs = 0;
let packet;
let packetRaw;
let lifecycles = [];
let lifecycleRaw;
let cleanupMs;
try {
  const fixturesStartedAt = performance.now();
  execFileSync(runtime.env.MANDIBLE_RUNTIME, [path.join(scriptDir, 'prepare-test-fixtures.ts')], {
    cwd: repoRoot, env: { ...runtime.env, VITEST: 'true' }, stdio: 'inherit', timeout: 15_000,
  });
  fixturePreparationMs = performance.now() - fixturesStartedAt;
  preparationMs = performance.now() - preparationStartedAt;
  childStartedAt = performance.now();
  child = spawn(runtime.env.MANDIBLE_RUNTIME, [vitestPath, ...process.argv.slice(2)], {
    cwd: repoRoot, detached: true, env: runtime.env, stdio: "inherit",
  });
  capturedChildPid = child.pid;
  supervisor.attach(child);
  const result = await supervisor.settle(child);
  childSettledAtNs = process.hrtime.bigint();
  childMs = performance.now() - childStartedAt;
  process.exitCode = result.code ?? 1;
} catch (error) {
  errors.push(error);
} finally {
  const cleanupStartedAt = performance.now();
  try { await supervisor.close(); } catch (error) { errors.push(error); }
  try {
    if (existsSync(packetPath)) {
      packetRaw = readFileSync(packetPath, "utf8");
      packet = JSON.parse(packetRaw);
    }
  } catch (error) { errors.push(error); }
  try {
    lifecycleRaw = readFileSync(workerTimingPath, 'utf8');
    for (const line of lifecycleRaw.split('\n').filter(Boolean)) {
      try { lifecycles.push(JSON.parse(line)); } catch (error) { errors.push(error); }
    }
  } catch (error) { errors.push(error); }
  try { runtime.close(); } catch (error) { errors.push(error); }
  cleanupMs = performance.now() - cleanupStartedAt;
}

const checkoutAtEnd = checkoutState(repoRoot);
const checkoutError = checkoutViolation(checkoutAtStart, checkoutAtEnd);
if (checkoutError) {
  errors.push(new Error(`RUN CONTRACT FAILED: ${checkoutError}`));
}
if (!packet && process.env.MANDIBLE_TIMING_GATE === "1" && (process.env.MANDIBLE_TEST_SUITE ?? "gate") === "gate") {
  errors.push(new Error("RUN CONTRACT FAILED: missing Vitest timing packet; run the gate with its contract reporter enabled."));
}
if (packet && errors.length === 0) {
  try {
    const completed = completeTimingPacket(packet, {
      wall_ms: performance.now() - commandStartedAt,
      preparation_ms: preparationMs,
      fixture_preparation_ms: fixturePreparationMs,
      child_ms: childMs,
      cleanup_ms: cleanupMs,
      child_overhead_ms: Math.max(0, childMs - packet.vitest_wall_ms),
      reporter_to_settlement_ms: Number(childSettledAtNs - BigInt(packet.reporter_finished_at_ns)) / 1e6,
    }, lifecycles, process.env.MANDIBLE_TIMING_GATE === "1");
    completed.toolchain = runtime.toolchain;
    if (process.env.MANDIBLE_TIMING_JSON) {
      writeFileSync(process.env.MANDIBLE_TIMING_JSON, `${JSON.stringify(completed, null, 2)}\n`);
    }
    console.log(`  Runner wall ${(completed.wall_ms / 1000).toFixed(2)}s; shared command work ${(completed.shared_ms / 1000).toFixed(2)}s; total occupancy ${(completed.sum_ms / 1000).toFixed(2)}s`);
    console.log(`  Worker lifetimes ${(completed.file_sum_ms / 1000).toFixed(2)}s; peak live forks ${completed.peak_live_workers}; configured slots ${completed.workers}`);
    for (const file of completed.files.slice(0, 10)) console.log(`    ${(file.occupancy_ms / 1000).toFixed(2)}s ${file.file}`);
    const addedViolations = completed.violations.slice(packet.violations.length);
    if (addedViolations.length) {
      console.error(`RUN CONTRACT FAILED:\n${addedViolations.map((v) => `  - ${v}`).join("\n")}`);
      process.exitCode = 1;
    }
  } catch (error) { errors.push(error); }
}

function describeError(error) {
  return {
    name: error?.name,
    message: error?.message ?? String(error),
    stack: error?.stack,
    code: error?.code,
    processGroup: error?.processGroup,
    cause: error?.cause ? describeError(error.cause) : undefined,
    errors: error instanceof AggregateError ? error.errors.map(describeError) : undefined,
  };
}

if (errors.length) {
  process.exitCode = 1;
  const diagnosticPath = process.env.MANDIBLE_TIMING_JSON
    ? `${process.env.MANDIBLE_TIMING_JSON}.diagnostic.json`
    : `${runtime.env.MANDIBLE_TEST_RUNTIME_ROOT}.diagnostic.json`;
  try {
    writeFileSync(diagnosticPath, `${JSON.stringify({
      status: 'incomplete',
      runtime_root: runtime.env.MANDIBLE_TEST_RUNTIME_ROOT,
      runner: { pid: process.pid, parent_pid: process.ppid, uid: process.getuid(), runtime: process.execPath },
      child: { captured_pid: capturedChildPid, observed_pid: child?.pid, exit_code: child?.exitCode, signal_code: child?.signalCode },
      command: { cwd: repoRoot, argv: process.argv, runtime: runtime.env.MANDIBLE_RUNTIME, toolchain: runtime.toolchain },
      observed_wall_ms: performance.now() - commandStartedAt,
      child_started_ms: childStartedAt,
      child_settled: childSettledAtNs !== undefined,
      reporter_packet_path: packetPath,
      reporter_packet_raw: packetRaw,
      worker_lifecycle_path: workerTimingPath,
      observed_worker_stop_receipts_raw: lifecycleRaw,
      observed_worker_stop_receipts: lifecycles,
      checkout: { before: checkoutAtStart, after: checkoutAtEnd },
      errors: errors.map(describeError),
    }, null, 2)}\n`, { mode: 0o600 });
    console.error(`RUN DIAGNOSTIC: ${diagnosticPath}`);
  } catch (error) {
    console.error(`Cannot retain run diagnostic ${diagnosticPath}: ${error.message}`);
    errors.push(error);
  }
  throw errors.length === 1 ? errors[0] : new AggregateError(errors, 'Test run or cleanup failed; observed diagnostics retained where writable.');
}
