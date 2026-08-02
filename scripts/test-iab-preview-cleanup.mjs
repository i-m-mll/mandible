#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(repoRoot, "scripts", "iab-preview.mjs");
const hasLsof = spawnSync("lsof", ["-v"], { stdio: "ignore" }).status === 0;

let tempDir = "";
const heldFileDescriptors = [];

try {
  tempDir = makeFixture();
  const dryRun = runCleanup(tempDir, ["--json"]);
  assert.equal(dryRun.status, "dry-run");
  assert.ok(dryRun.reclaimableBytes > 0);
  assert.equal(entryFor(dryRun, "stale-preview")?.action, "delete-dir");
  const activeDryRun = entryFor(dryRun, "active-preview");
  assert.equal(activeDryRun?.action, "skip-active");
  assert.equal(activeDryRun.openFileInspection.available, hasLsof);
  if (hasLsof) {
    assert.ok(activeDryRun.bytes > 0);
    assert.ok(activeDryRun.openFileInspection.paths.some((entryPath) => {
      return entryPath.endsWith("mandible-20240101-000005.db-wal");
    }));
    assert.equal(activeDryRun.snapshotCleanup.entries.filter((entry) => entry.action === "delete-file").length, 6);
  } else {
    assert.equal(activeDryRun.bytes, 0);
    assert.equal(activeDryRun.snapshotCleanup.entries.filter((entry) => entry.action === "delete-file").length, 0);
  }
  assert.equal(activeDryRun.snapshotCleanup.entries.find((entry) => {
    return entry.path.endsWith("mandible-20240101-000005.db-wal");
  })?.action, "skip");
  assert.equal(entryFor(dryRun, "unknown-preview")?.action, "skip");
  assert.equal(entryFor(dryRun, "mandible-20240101-000000.db")?.action, "delete-file");
  assert.equal(entryFor(dryRun, "mandible-20240101-000001.db")?.action, "skip");
  assert.equal(fs.existsSync(path.join(tempDir, "stale-preview")), true);
  assert.equal(fs.existsSync(path.join(tempDir, "active-preview", "mandible-20240101-000006.db")), true);
  assert.equal(fs.existsSync(path.join(tempDir, "mandible-20240101-000000.db")), true);

  closeHeldFiles();
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
  assert.equal(fs.existsSync(path.join(tempDir, "mandible-20240101-000001.db-wal")), true);
  assert.equal(fs.existsSync(path.join(tempDir, "mandible-20240101-000001.db-shm")), true);
  assert.equal(fs.existsSync(path.join(tempDir, "active-preview", "mandible-20240101-000004.db")), true);
  assert.equal(fs.existsSync(path.join(tempDir, "active-preview", "mandible-20240101-000004.db-wal")), true);
  assert.equal(fs.existsSync(path.join(tempDir, "active-preview", "mandible-20240101-000004.db-shm")), true);
  assert.equal(fs.existsSync(path.join(tempDir, "active-preview", "mandible-20240101-000004.db.manifest.json")), true);
  assert.equal(fs.existsSync(path.join(tempDir, "active-preview", "mandible-20240101-000005.db")), true);
  assert.equal(fs.existsSync(path.join(tempDir, "active-preview", "mandible-20240101-000005.db-wal")), true);
  assert.equal(fs.existsSync(path.join(tempDir, "active-preview", "mandible-20240101-000005.db-shm")), true);
  assert.equal(fs.existsSync(path.join(tempDir, "active-preview", "mandible-20240101-000005.db.manifest.json")), true);
  assert.equal(fs.existsSync(path.join(tempDir, "active-preview", "mandible-20240101-000006.db")), !hasLsof);
  assert.equal(fs.existsSync(path.join(tempDir, "active-preview", "mandible-20240101-000006.db-wal")), !hasLsof);
  assert.equal(fs.existsSync(path.join(tempDir, "active-preview", "mandible-20240101-000006.db-shm")), !hasLsof);
  assert.equal(fs.existsSync(path.join(tempDir, "active-preview", "mandible-20240101-000006.db.manifest.json")), !hasLsof);
  assert.equal(fs.existsSync(path.join(tempDir, "active-preview", "mandible-20240101-000007.db.partial-123")), !hasLsof);
  assert.equal(fs.existsSync(path.join(tempDir, "active-preview", "mandible-20240101-000007.db.manifest.json.partial-123")), !hasLsof);

  console.log("iab-preview cleanup fixture checks passed");
} finally {
  closeHeldFiles();
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
  fs.writeFileSync(`${protectedRootDb}-wal`, "protected wal");
  fs.writeFileSync(`${protectedRootDb}-shm`, "protected shm");
  fs.writeFileSync(`${protectedRootDb}.manifest.json`, "protected manifest");
  const metadataDb = path.join(activeDir, "mandible-20240101-000004.db");
  fs.writeFileSync(metadataDb, "metadata protected");
  fs.writeFileSync(`${metadataDb}-wal`, "metadata protected wal");
  fs.writeFileSync(`${metadataDb}-shm`, "metadata protected shm");
  fs.writeFileSync(`${metadataDb}.manifest.json`, "metadata protected manifest");
  const heldActiveDb = path.join(activeDir, "mandible-20240101-000005.db");
  fs.writeFileSync(heldActiveDb, "held active");
  fs.writeFileSync(`${heldActiveDb}-wal`, "held active wal");
  fs.writeFileSync(`${heldActiveDb}-shm`, "held active shm");
  fs.writeFileSync(`${heldActiveDb}.manifest.json`, "held active manifest");
  heldFileDescriptors.push(fs.openSync(`${heldActiveDb}-wal`, "r"));
  const staleActiveDb = path.join(activeDir, "mandible-20240101-000006.db");
  fs.writeFileSync(staleActiveDb, "stale active");
  fs.writeFileSync(`${staleActiveDb}-wal`, "stale active wal");
  fs.writeFileSync(`${staleActiveDb}-shm`, "stale active shm");
  fs.writeFileSync(`${staleActiveDb}.manifest.json`, "stale active manifest");
  fs.writeFileSync(path.join(activeDir, "mandible-20240101-000007.db.partial-123"), "partial");
  fs.writeFileSync(path.join(activeDir, "mandible-20240101-000007.db.manifest.json.partial-123"), "partial manifest");
  fs.symlinkSync(protectedRootDb, path.join(activeDir, "current.db"));
  fs.writeFileSync(path.join(activeDir, "metadata.json"), JSON.stringify({
    port: 9,
    db: metadataDb,
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

function closeHeldFiles() {
  while (heldFileDescriptors.length > 0) {
    fs.closeSync(heldFileDescriptors.pop());
  }
}
