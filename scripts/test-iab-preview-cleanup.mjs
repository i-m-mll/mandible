#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(repoRoot, "scripts", "iab-preview.mjs");

let tempDir = "";

try {
  tempDir = makeFixture();
  const dryRun = runCleanup(tempDir, ["--json"]);
  assert.equal(dryRun.status, "dry-run");
  assert.ok(dryRun.reclaimableBytes > 0);
  assert.equal(entryFor(dryRun, "stale-preview")?.action, "delete-dir");
  assert.equal(entryFor(dryRun, "active-preview")?.action, "skip-active");
  assert.equal(entryFor(dryRun, "unknown-preview")?.action, "skip");
  assert.equal(entryFor(dryRun, "mandible-20240101-000000.db")?.action, "delete-file");
  assert.equal(entryFor(dryRun, "mandible-20240101-000001.db")?.action, "skip");
  assert.equal(fs.existsSync(path.join(tempDir, "stale-preview")), true);
  assert.equal(fs.existsSync(path.join(tempDir, "mandible-20240101-000000.db")), true);

  fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = makeFixture();
  const applied = runCleanup(tempDir, ["--json", "--apply"]);
  assert.equal(applied.status, "applied");
  assert.equal(applied.reclaimedBytes, applied.reclaimableBytes);
  assert.equal(fs.existsSync(path.join(tempDir, "stale-preview")), false);
  assert.equal(fs.existsSync(path.join(tempDir, "mandible-20240101-000000.db")), false);
  assert.equal(fs.existsSync(path.join(tempDir, "active-preview")), true);
  assert.equal(fs.existsSync(path.join(tempDir, "unknown-preview")), true);
  assert.equal(fs.existsSync(path.join(tempDir, "mandible-20240101-000001.db")), true);

  console.log("iab-preview cleanup fixture checks passed");
} finally {
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-iab-preview-cleanup-"));

  const staleDir = path.join(root, "stale-preview");
  fs.mkdirSync(staleDir, { recursive: true });
  const staleDb = path.join(staleDir, "mandible-20240101-000002.db");
  fs.writeFileSync(staleDb, "stale");
  fs.symlinkSync(staleDb, path.join(staleDir, "current.db"));
  fs.writeFileSync(path.join(staleDir, "metadata.json"), JSON.stringify({
    port: 9,
    db: staleDb,
    pidFile: path.join(staleDir, "mandible.pid"),
  }));
  fs.writeFileSync(path.join(staleDir, "mandible.pid"), "999999");

  const activeDir = path.join(root, "active-preview");
  fs.mkdirSync(activeDir, { recursive: true });
  const protectedRootDb = path.join(root, "mandible-20240101-000001.db");
  fs.writeFileSync(protectedRootDb, "protected");
  fs.symlinkSync(protectedRootDb, path.join(activeDir, "current.db"));
  fs.writeFileSync(path.join(activeDir, "metadata.json"), JSON.stringify({
    port: 9,
    db: protectedRootDb,
    pidFile: path.join(activeDir, "mandible.pid"),
  }));
  fs.writeFileSync(path.join(activeDir, "mandible.pid"), String(process.pid));

  const unknownDir = path.join(root, "unknown-preview");
  fs.mkdirSync(unknownDir, { recursive: true });
  fs.writeFileSync(path.join(unknownDir, "mandible-20240101-000003.db"), "unknown");

  fs.writeFileSync(path.join(root, "mandible-20240101-000000.db"), "orphan");
  return root;
}

function runCleanup(previewBaseDir, args) {
  const result = spawnSync(process.execPath, [
    scriptPath,
    "cleanup",
    "--preview-base-dir",
    previewBaseDir,
    ...args,
  ], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function entryFor(result, pathPart) {
  return result.entries.find((entry) => entry.path.includes(pathPart));
}
