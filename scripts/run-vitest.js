import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ProcessGroupSupervisor } from "./process-group-supervisor.mjs";
import { createTestRuntime } from "./test-runtime-isolation.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const candidates = [
  path.join(repoRoot, "node_modules", "vitest", "vitest.mjs"),
  path.join(repoRoot, "node_modules", "vitest", "dist", "cli.js"),
];

const vitestPath = candidates.find((candidate) => existsSync(candidate));

if (!vitestPath) {
  console.error("Unable to locate the Vitest CLI entrypoint.");
  process.exit(1);
}

const runtime = createTestRuntime();
const supervisor = new ProcessGroupSupervisor();
try {
  const child = spawn(runtime.env.MANDIBLE_RUNTIME, [vitestPath, ...process.argv.slice(2)], {
    cwd: repoRoot,
    detached: true,
    env: runtime.env,
    stdio: "inherit",
  });
  supervisor.attach(child);
  const result = await supervisor.settle(child);
  process.exitCode = result.code ?? 1;
} finally {
  await supervisor.close();
  runtime.close();
}
