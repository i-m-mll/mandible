"use strict";

// Issue 24f0316 — dependency-free path resolution for the standalone .mjs
// maintenance scripts under scripts/, which run outside the TypeScript build
// and so cannot import src/platform-paths.ts or src/db.ts.
//
// Mandible splits its state by lifetime:
//   - `~/.mandible` (MANDIBLE_HOME) is durable: the ledger database and its
//     -wal/-shm sidecars, backups/, config/, artifacts/.
//   - `~/.cache/mandible` stays disposable: previews, agent-rpc, the cowork CLI
//     mirror, logs, daemon.pid.
//
// Scripts that default to a database path MUST use defaultDbPath() rather than
// a literal. The startup copy-forward deliberately leaves the pre-split file at
// `~/.cache/mandible/mandible.db` in place, so a script still carrying the old
// literal would read stale bytes indefinitely and look like it was working.
//
// Keep in sync with src/platform-paths.ts (getMandibleHome) and src/db.ts
// (getDefaultDbPath / getLegacyCacheDbPath).

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function userHome() {
  return process.env.HOME || os.homedir();
}

function expandHome(input) {
  if (input === "~") return userHome();
  if (input.startsWith("~/")) return path.join(userHome(), input.slice(2));
  return input;
}

/** The durable-state root. `MANDIBLE_HOME` overrides it wholesale. */
function mandibleHome() {
  const override = process.env.MANDIBLE_HOME && process.env.MANDIBLE_HOME.trim();
  if (override) return path.resolve(expandHome(override));
  return path.join(userHome(), ".mandible");
}

function mandibleHomePath(...segments) {
  return path.join(mandibleHome(), ...segments);
}

/** The disposable cache root. Never holds authoritative state. */
function mandibleCacheDir() {
  return path.join(userHome(), ".cache", "mandible");
}

function defaultDbPath() {
  return mandibleHomePath("mandible.db");
}

/** Where the database lived before the durable/cache split. */
function legacyCacheDbPath() {
  return path.join(mandibleCacheDir(), "mandible.db");
}

/**
 * The database a non-daemon tool should actually open.
 *
 * Unlike the daemon, these tools must never *create* a database: opening the
 * durable path before the daemon has copied forward would leave an empty file
 * there that the shim would then adopt as authoritative ("target present"),
 * stranding the real ledger. So resolution is existence-based — durable first,
 * then the pre-split location — and only falls back to the durable path when
 * neither exists, which is a genuinely fresh install.
 */
function liveDbPath() {
  if (process.env.MANDIBLE_DB) return path.resolve(expandHome(process.env.MANDIBLE_DB));
  const durable = defaultDbPath();
  if (fs.existsSync(durable)) return durable;
  const legacy = legacyCacheDbPath();
  if (fs.existsSync(legacy)) return legacy;
  return durable;
}

/** Resolve a script's database argument, honoring an explicit override first. */
function resolveDbPath(explicit) {
  if (explicit) return path.resolve(expandHome(explicit));
  return liveDbPath();
}

module.exports = {
  userHome,
  expandHome,
  mandibleHome,
  mandibleHomePath,
  mandibleCacheDir,
  defaultDbPath,
  legacyCacheDbPath,
  liveDbPath,
  resolveDbPath,
};
