import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const candidates = [
  path.join(repoRoot, "node_modules", "typescript", "lib", "tsc.js"),
  path.join(repoRoot, "node_modules", "typescript", "lib", "_tsc.js"),
];

const tscPath = candidates.find((candidate) => existsSync(candidate));

if (!tscPath) {
  console.error("Unable to locate the TypeScript compiler entrypoint.");
  process.exit(1);
}

const child = spawn(process.execPath, ['--smol', '--no-install', tscPath, ...process.argv.slice(2)], {
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
