"use strict";

/** Shared production database refusal used by all SQLite connections and CLI tools. */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Anchor the production path on the REAL system home (os.userInfo().homedir,
// read from the password database) rather than os.homedir(), which honors a
// $HOME override. Tests routinely isolate by pointing HOME (and MANDIBLE_DB) at
// a throwaway temp home; that temp DB is not production and must be allowed,
// while the real user's ~/.cache database stays guarded regardless of $HOME.
function realSystemHomeDir() {
  try {
    const info = os.userInfo();
    if (info && typeof info.homedir === "string" && info.homedir.length > 0) {
      return info.homedir;
    }
  } catch {
    // userInfo can throw on exotic platforms; fall back below.
  }
  return os.homedir();
}

// Issue 24f0316 — the ledger database moved from the disposable cache root to
// the durable root. The copy-forward shim deliberately never deletes the old
// files, so BOTH paths can hold live bytes and both must stay guarded; a guard
// that only knew the new path would silently protect nothing on a machine that
// has not restarted into the new layout yet.
const PRODUCTION_DB_PATH = path.join(realSystemHomeDir(), ".mandible", "mandible.db");
const LEGACY_PRODUCTION_DB_PATH = path.join(
  realSystemHomeDir(),
  ".cache",
  "mandible",
  "mandible.db",
);
const PRODUCTION_OPERATIONAL_LOG_DB_PATH = path.join(
  realSystemHomeDir(),
  ".mandible",
  "operational-logs.db",
);
const PRODUCTION_DB_PATHS = Object.freeze([
  PRODUCTION_DB_PATH,
  LEGACY_PRODUCTION_DB_PATH,
  PRODUCTION_OPERATIONAL_LOG_DB_PATH,
]);

function isUnderTestRunner() {
  return (
    process.env.VITEST === "true" ||
    process.env.VITEST_WORKER_ID !== undefined ||
    process.env.NODE_ENV === "test"
  );
}

// Canonicalize to the real on-disk path so a symlink, relative segment, or
// case-insensitive alias cannot smuggle the production path past a string
// compare. Falls back to a resolved (non-real) path when the file is absent.
function canonicalizePath(target) {
  const expanded =
    target === "~"
      ? realSystemHomeDir()
      : target.startsWith("~/") || target.startsWith("~\\")
        ? path.join(realSystemHomeDir(), target.slice(2))
        : target;
  let probe = path.resolve(expanded);
  const suffix = [];
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    suffix.unshift(path.basename(probe));
    probe = parent;
  }
  try {
    return path.join(fs.realpathSync.native(probe), ...suffix);
  } catch {
    return path.resolve(expanded);
  }
}

// Same-file check by device+inode, catching hard links and case-alias entries
// that resolve to the production bytes even when their path strings differ.
function sameFile(a, b) {
  try {
    const sa = fs.statSync(canonicalizePath(a));
    const sb = fs.statSync(canonicalizePath(b));
    return sa.dev === sb.dev && sa.ino === sb.ino;
  } catch {
    return false;
  }
}

function resolvesToProductionDbPath(dbPath, productionPath = PRODUCTION_DB_PATH) {
  if (canonicalizePath(dbPath) === canonicalizePath(productionPath)) return true;
  return sameFile(dbPath, productionPath);
}

function resolvesToAnyProductionDbPath(dbPath, productionPaths = PRODUCTION_DB_PATHS) {
  for (const productionPath of productionPaths) {
    if (resolvesToProductionDbPath(dbPath, productionPath)) return productionPath;
  }
  return null;
}

function assertNotProductionDbUnderTest(dbPath, productionPaths = PRODUCTION_DB_PATHS) {
  if (process.env.MANDIBLE_ALLOW_REAL_DB === "1") return;
  if (!isUnderTestRunner()) return;
  const matched = resolvesToAnyProductionDbPath(
    dbPath,
    Array.isArray(productionPaths) ? productionPaths : [productionPaths],
  );
  if (matched) {
    throw new Error(
      "Refusing to open the production Mandible database under the test runner: " +
        canonicalizePath(matched) +
        ". Tests must open an explicit temp/fixture path, never the real DB. This guard " +
        "prevents a test or test-invoked tool from writing or migrating live data " +
        "(issue 07edc0d). To deliberately override, set MANDIBLE_ALLOW_REAL_DB=1.",
    );
  }
}

module.exports = {
  PRODUCTION_DB_PATH,
  LEGACY_PRODUCTION_DB_PATH,
  PRODUCTION_OPERATIONAL_LOG_DB_PATH,
  PRODUCTION_DB_PATHS,
  resolvesToProductionDbPath,
  resolvesToAnyProductionDbPath,
  assertNotProductionDbUnderTest,
};
