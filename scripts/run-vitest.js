import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

const child = spawn(process.execPath, [vitestPath, ...process.argv.slice(2)], {
  cwd: repoRoot,
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
