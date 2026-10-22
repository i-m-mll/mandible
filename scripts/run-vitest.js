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
let schemaPreparationMs = 0;
const packetPath = path.join(runtime.env.MANDIBLE_TEST_RUNTIME_ROOT, "timing.json");
runtime.env.MANDIBLE_TEST_TIMING_PACKET = packetPath;
const workerTimingPath = path.join(runtime.env.MANDIBLE_TEST_RUNTIME_ROOT, 'worker-lifecycles.jsonl');
writeFileSync(workerTimingPath, '', { mode: 0o600 });
runtime.env.MANDIBLE_TEST_WORKER_TIMING = workerTimingPath;
const supervisor = new ProcessGroupSupervisor();
let childMs = 0;
let packet;
let lifecycles;
let childSettledAtNs;
try {
  const schemaStartedAt = performance.now();
  execFileSync(runtime.env.MANDIBLE_RUNTIME, [path.join(scriptDir, 'prepare-test-db.ts')], {
    cwd: repoRoot, env: { ...runtime.env, VITEST: 'true' }, stdio: 'inherit', timeout: 15_000,
  });
  schemaPreparationMs = performance.now() - schemaStartedAt;
  preparationMs = performance.now() - preparationStartedAt;
  const childStartedAt = performance.now();
  const child = spawn(runtime.env.MANDIBLE_RUNTIME, [vitestPath, ...process.argv.slice(2)], {
    cwd: repoRoot,
    detached: true,
    env: runtime.env,
    stdio: "inherit",
  });
  supervisor.attach(child);
  const result = await supervisor.settle(child);
  childSettledAtNs = process.hrtime.bigint();
  childMs = performance.now() - childStartedAt;
  process.exitCode = result.code ?? 1;
} finally {
  const cleanupStartedAt = performance.now();
  try {
    await supervisor.close();
    if (existsSync(packetPath)) packet = JSON.parse(readFileSync(packetPath, "utf8"));
    lifecycles = readFileSync(workerTimingPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } finally {
    runtime.close();
  }
  const cleanupMs = performance.now() - cleanupStartedAt;
  const checkoutError = checkoutViolation(checkoutAtStart, checkoutState(repoRoot));
  if (checkoutError) {
    console.error(`RUN CONTRACT FAILED: ${checkoutError}`);
    if (packet && !packet.violations.includes(checkoutError)) packet.violations.push(checkoutError);
    process.exitCode = 1;
  }
  if (packet) {
    const completed = completeTimingPacket(packet, {
      wall_ms: performance.now() - commandStartedAt,
      preparation_ms: preparationMs,
      schema_preparation_ms: schemaPreparationMs,
      child_ms: childMs,
      cleanup_ms: cleanupMs,
      child_overhead_ms: Math.max(0, childMs - packet.vitest_wall_ms),
      reporter_to_settlement_ms: Number(childSettledAtNs - BigInt(packet.reporter_finished_at_ns)) / 1e6,
    }, lifecycles, process.env.MANDIBLE_TIMING_GATE === "1");
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
  } else if (process.env.MANDIBLE_TIMING_GATE === "1" && (process.env.MANDIBLE_TEST_SUITE ?? "gate") === "gate") {
    console.error("RUN CONTRACT FAILED: missing Vitest timing packet; run the gate with its contract reporter enabled.");
    process.exitCode = 1;
  }
}
