#!/usr/bin/env bun
// Generate PWA PNG icons from the shared Mandible SVG source.

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = join(__dirname, "icon.svg");
const sizes = [192, 512];

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

const outputDir = mkdtempSync(join(tmpdir(), "mandible-icons-"));

try {
  run(process.execPath, [
    join(__dirname, "..", "node_modules", "@tauri-apps", "cli", "tauri.js"),
    "icon",
    source,
    "-o",
    outputDir,
    ...sizes.flatMap((size) => ["-p", String(size)]),
  ]);

  for (const size of sizes) {
    const output = join(__dirname, `icon-${size}.png`);
    copyFileSync(join(outputDir, `${size}x${size}.png`), output);
    console.log(`wrote ${output}`);
  }
} finally {
  rmSync(outputDir, { recursive: true, force: true });
}
