// @vitest-environment node
import { execFileSync } from "node:child_process";
import SqliteDatabase from "../src/sqlite.ts";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  copyForwardLegacyDb,
  getDbPath,
  getDefaultDbPath,
  getLegacyCacheDbPath,
  openDb,
  type CopyForwardOutcome,
} from "../src/db.js";
import {
  ensureMandibleClientAuthDir,
  ensureMandibleConfigEntry,
  ensureMandibleConfigFile,
  getLegacyMandibleConfigDirs,
  getMandibleConfigDir,
  getMandibleConfigPath,
  getMandibleHome,
  getMandibleHomePath,
} from "../src/platform-paths.js";
import { testRuntimeRoot } from "./helpers/runtime-isolation.js";

// Issue 24f0316: durable state lives under ~/.mandible, disposable state under
// ~/.cache/mandible. One helper owns the durable root; config folds into it;
// the startup copy-forward relocates an existing ledger database exactly once
// and refuses anything that could strand or corrupt it. Every case runs against
// a private HOME.

const SIDECARS = ["-wal", "-shm"] as const;
const ENV_KEYS = ["HOME", "MANDIBLE_HOME", "MANDIBLE_DB", "MANDIBLE_CONFIG_DIR", "MANDIBLE_CLIENT_AUTH_DIR"] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
let tempHome = "";

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(testRuntimeRoot, "mandible-home-"));
  process.env.HOME = tempHome;
  for (const key of ENV_KEYS) if (key !== "HOME") delete process.env[key];
});

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tempHome, { recursive: true, force: true });
});

/** Open a path without arming the copy-forward shim the test is setting up. */
function openExplicitly(dbPath: string) {
  const previous = process.env.MANDIBLE_DB;
  process.env.MANDIBLE_DB = dbPath;
  try {
    return openDb(dbPath);
  } finally {
    if (previous === undefined) delete process.env.MANDIBLE_DB;
    else process.env.MANDIBLE_DB = previous;
  }
}

function seedDb(dbPath: string, marker: string): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openExplicitly(dbPath);
  db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('copy_forward_marker', ?, 1)").run(marker);
  db.close();
}

function readMarker(dbPath: string): string | null {
  const db = openExplicitly(dbPath);
  try {
    return (db.prepare("SELECT value FROM settings WHERE key = 'copy_forward_marker'").get() as { value: string } | undefined)?.value ?? null;
  } finally {
    db.close();
  }
}

describe("durable root resolution", () => {
  it("derives every durable path from ~/.mandible or a MANDIBLE_HOME override read on each call", () => {
    expect([getMandibleHome(), getDefaultDbPath(), getDbPath(), getMandibleConfigDir(), getLegacyCacheDbPath()]).toEqual([
      path.join(tempHome, ".mandible"),
      path.join(tempHome, ".mandible", "mandible.db"),
      path.join(tempHome, ".mandible", "mandible.db"),
      path.join(tempHome, ".mandible", "config"),
      path.join(tempHome, ".cache", "mandible", "mandible.db"),
    ]);
    process.env.MANDIBLE_HOME = "   ";
    expect(getMandibleHome()).toBe(path.join(tempHome, ".mandible"));
    process.env.MANDIBLE_HOME = "~/elsewhere/mandible";
    const elsewhere = path.join(tempHome, "elsewhere", "mandible");
    expect([getMandibleHome(), getMandibleHomePath("backups"), getDefaultDbPath(), getMandibleConfigDir()]).toEqual([
      elsewhere, path.join(elsewhere, "backups"), path.join(elsewhere, "mandible.db"), path.join(elsewhere, "config"),
    ]);
  });

  it("lets MANDIBLE_DB, MANDIBLE_CONFIG_DIR and MANDIBLE_CLIENT_AUTH_DIR override only their own path", () => {
    process.env.MANDIBLE_DB = path.join(tempHome, "explicit.db");
    process.env.MANDIBLE_CONFIG_DIR = "~/custom-config";
    process.env.MANDIBLE_CLIENT_AUTH_DIR = path.join(tempHome, "preview-authority", "client-auth");
    expect(getDbPath()).toBe(path.join(tempHome, "explicit.db"));
    expect(getMandibleConfigPath("repos.json")).toBe(path.join(tempHome, "custom-config", "repos.json"));
    expect(ensureMandibleClientAuthDir()).toBe(path.join(tempHome, "preview-authority", "client-auth"));
    expect(getDefaultDbPath()).toBe(path.join(tempHome, ".mandible", "mandible.db"));
  });

  it("copies legacy config forward once, preserving restrictive modes and inventing nothing", () => {
    const legacyDirs = getLegacyMandibleConfigDirs();
    expect(legacyDirs).not.toContain(getMandibleConfigDir());
    // The platform-conventional directory is where the daemon last wrote, so it is consulted before ~/.config.
    expect(legacyDirs.at(-1)).toBe(path.join(tempHome, ".config", "mandible"));
    const legacy = legacyDirs[0];
    // client-auth holds secrets: 0700 directory, 0600 files. Widening them would
    // make secret-store refuse the material.
    fs.mkdirSync(path.join(legacy, "client-auth"), { recursive: true });
    fs.chmodSync(path.join(legacy, "client-auth"), 0o700);
    fs.writeFileSync(path.join(legacy, "client-auth", "pepper"), "secret-pepper", { mode: 0o600 });
    fs.writeFileSync(path.join(legacy, "repos.json"), "legacy\n");

    const clientAuth = ensureMandibleConfigEntry("client-auth");
    expect(clientAuth).toBe(path.join(tempHome, ".mandible", "config", "client-auth"));
    expect(fs.readFileSync(path.join(clientAuth, "pepper"), "utf8")).toBe("secret-pepper");
    expect(fs.statSync(clientAuth).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(clientAuth, "pepper")).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(path.join(legacy, "client-auth", "pepper"))).toBe(true);

    const repos = ensureMandibleConfigFile("repos.json");
    fs.writeFileSync(repos, "current\n");
    fs.writeFileSync(path.join(legacy, "repos.json"), "changed legacy\n");
    expect(fs.readFileSync(ensureMandibleConfigFile("repos.json"), "utf8")).toBe("current\n");
    expect(fs.existsSync(ensureMandibleConfigEntry("never-existed"))).toBe(false);
  });
});

describe("startup copy-forward", () => {
  const copyForward = (options: Parameters<typeof copyForwardLegacyDb>[2] = {}): CopyForwardOutcome =>
    copyForwardLegacyDb(getDefaultDbPath(), getLegacyCacheDbPath(), { log: () => {}, ...options });

  it("copies committed frames that exist only in the legacy WAL and leaves the legacy files in place", () => {
    const legacy = getLegacyCacheDbPath();
    const target = getDefaultDbPath();
    seedDb(legacy, "main-file-value");
    const source = openExplicitly(legacy);
    try {
      source.pragma("wal_autocheckpoint = 0");
      source.pragma("wal_checkpoint(TRUNCATE)");
      source.prepare("UPDATE settings SET value = 'committed-only-in-wal' WHERE key = 'copy_forward_marker'").run();
      expect(fs.statSync(`${legacy}-wal`).size).toBeGreaterThan(0);
      const mainOnly = path.join(tempHome, "main-file-only.db");
      fs.copyFileSync(legacy, mainOnly);
      const mainOnlyDb = new SqliteDatabase(mainOnly, { fileMustExist: true });
      expect(mainOnlyDb.prepare("SELECT value FROM settings WHERE key = 'copy_forward_marker'").get()?.value).toBe("main-file-value");
      mainOnlyDb.close();

      const outcome = copyForward();
      expect(outcome).toMatchObject({ action: "copied", dbPath: target, copied: [target, `${target}-wal`, `${target}-shm`] });
      expect(readMarker(target)).toBe("committed-only-in-wal");
    } finally {
      source.close();
    }
    expect(fs.existsSync(legacy)).toBe(true);
    expect(fs.existsSync(`${legacy}.moved-to-mandible-home`)).toBe(true);
    expect(fs.existsSync(`${target}.copy-forward-in-progress`)).toBe(false);
  });

  it("uses an existing durable database and copies nothing over it", () => {
    seedDb(getLegacyCacheDbPath(), "stale-legacy");
    seedDb(getDefaultDbPath(), "current-durable");
    expect(copyForward()).toMatchObject({ dbPath: getDefaultDbPath(), action: "target-present" });
    expect(readMarker(getDefaultDbPath())).toBe("current-durable");
  });

  it.each([
    {
      refusal: "an empty durable file",
      arrange: () => { seedDb(getLegacyCacheDbPath(), "legacy"); fs.mkdirSync(path.dirname(getDefaultDbPath()), { recursive: true }); fs.writeFileSync(getDefaultDbPath(), ""); },
      reason: /invalid-target.*zero bytes/i,
      targetAfter: "",
    },
    {
      refusal: "an unopenable durable file",
      arrange: () => { seedDb(getLegacyCacheDbPath(), "legacy"); fs.mkdirSync(path.dirname(getDefaultDbPath()), { recursive: true }); fs.writeFileSync(getDefaultDbPath(), "not a sqlite database"); },
      reason: /invalid-target.*not openable/i,
      targetAfter: "not a sqlite database",
    },
    {
      refusal: "too little free space",
      arrange: () => seedDb(getLegacyCacheDbPath(), "legacy"),
      options: { headroomMarginBytes: Number.MAX_SAFE_INTEGER },
      reason: /insufficient-space/,
      targetAfter: null,
    },
    {
      refusal: "an unreadable legacy sidecar",
      arrange: () => { seedDb(getLegacyCacheDbPath(), "legacy"); fs.writeFileSync(`${getLegacyCacheDbPath()}-wal`, "wal-bytes"); fs.chmodSync(`${getLegacyCacheDbPath()}-wal`, 0o000); },
      reason: /copy-failed/,
      targetAfter: null,
    },
    {
      refusal: "a legacy file that copies but will not open",
      arrange: () => { fs.mkdirSync(path.dirname(getLegacyCacheDbPath()), { recursive: true }); fs.writeFileSync(getLegacyCacheDbPath(), "this is not a sqlite database at all"); },
      reason: /./,
      targetAfter: null,
    },
  ])("keeps the legacy database authoritative and leaves no partial copy given $refusal", ({ arrange, options, reason, targetAfter }) => {
    arrange();
    let outcome: CopyForwardOutcome;
    try {
      outcome = copyForward(options);
    } finally {
      if (fs.existsSync(`${getLegacyCacheDbPath()}-wal`)) fs.chmodSync(`${getLegacyCacheDbPath()}-wal`, 0o600);
    }
    expect(outcome).toMatchObject({ dbPath: getLegacyCacheDbPath(), action: "kept-legacy" });
    expect(outcome.reason ?? "").toMatch(reason);
    const target = getDefaultDbPath();
    expect(fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null).toBe(targetAfter);
    for (const suffix of SIDECARS) expect(fs.existsSync(target + suffix)).toBe(false);
    expect(fs.existsSync(`${target}.copy-forward-in-progress`)).toBe(false);
  });

  it("discards a copy an interrupted run left unverified, however complete, and copies again", () => {
    const target = getDefaultDbPath();
    seedDb(getLegacyCacheDbPath(), "authoritative");
    for (const leftover of ["truncated-garbage", "complete-but-uncommitted"]) {
      fs.rmSync(path.dirname(target), { recursive: true, force: true });
      if (leftover === "truncated-garbage") {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, leftover);
      } else {
        seedDb(target, leftover);
      }
      fs.writeFileSync(`${target}.copy-forward-in-progress`, "interrupted");
      expect(copyForward().action).toBe("copied");
      expect(readMarker(target)).toBe("authoritative");
      expect(fs.existsSync(`${target}.copy-forward-in-progress`)).toBe(false);
    }
  });
});

// The bash CLI, its embedded node helper and the .mjs maintenance scripts also
// resolve the database. They must agree with the daemon and must never create
// a database: an empty durable file would be adopted by the next copy-forward
// as the relocated ledger and strand the real one.
describe("non-daemon resolvers", () => {
  const repoRoot = process.cwd();
  const shell = (fn: string) => execFileSync("bash", ["-c", `source "${path.join(repoRoot, "cli", "api.sh")}"; ${fn}`], {
    env: { ...process.env, HOME: tempHome }, encoding: "utf8",
  }).trim();
  function cjs() {
    const require_ = createRequire(import.meta.url);
    const modulePath = require_.resolve("../cli/mandible-paths.cjs");
    delete require_.cache[modulePath];
    return require_(modulePath) as { mandibleHome: () => string; liveDbPath: () => string; defaultDbPath: () => string; legacyCacheDbPath: () => string };
  }

  it("names the same live database as the daemon at every relocation stage, without creating one", () => {
    const durable = getDefaultDbPath();
    const legacy = getLegacyCacheDbPath();
    const stages: Array<[string, () => void, string]> = [
      ["fresh install", () => {}, durable],
      ["legacy only", () => seedDb(legacy, "legacy"), legacy],
      ["copy in progress", () => { fs.mkdirSync(path.dirname(durable), { recursive: true }); fs.writeFileSync(durable, "partial"); fs.writeFileSync(`${durable}.copy-forward-in-progress`, "copying"); }, legacy],
      ["empty durable file", () => { fs.rmSync(`${durable}.copy-forward-in-progress`); fs.writeFileSync(durable, ""); }, legacy],
      ["relocated", () => { fs.rmSync(durable); seedDb(durable, "relocated"); }, durable],
      ["explicit MANDIBLE_DB", () => { process.env.MANDIBLE_DB = path.join(tempHome, "explicit.db"); }, path.join(tempHome, "explicit.db")],
    ];
    for (const [stage, arrange, expected] of stages) {
      arrange();
      expect({ stage, cjs: cjs().liveDbPath(), shell: shell("api_live_db_path") }).toEqual({ stage, cjs: expected, shell: expected });
      if (stage === "fresh install") expect(fs.existsSync(durable)).toBe(false);
    }
  });

  it("agrees with the daemon on the durable root, the pre-split path and MANDIBLE_HOME normalization", () => {
    expect([cjs().defaultDbPath(), cjs().legacyCacheDbPath(), shell("api_default_db_path")])
      .toEqual([getDefaultDbPath(), getLegacyCacheDbPath(), getDefaultDbPath()]);
    for (const variant of [path.join(tempHome, "durable root") + path.sep, "~/tilde-root/", "~"]) {
      process.env.MANDIBLE_HOME = variant;
      expect([cjs().mandibleHome(), shell("api_mandible_home")]).toEqual([getMandibleHome(), getMandibleHome()]);
    }
  });
});

describe("openDb relocation", () => {
  it("adopts a legacy database at the durable path, or keeps it authoritative over an empty durable file", () => {
    const legacy = getLegacyCacheDbPath();
    seedDb(legacy, "adopted-on-startup");
    let db = openDb();
    expect(db.prepare("SELECT value FROM settings WHERE key = 'copy_forward_marker'").get()?.value).toBe("adopted-on-startup");
    db.close();
    expect(fs.existsSync(getDefaultDbPath())).toBe(true);
    expect(fs.existsSync(legacy)).toBe(true);

    for (const suffix of ["", ...SIDECARS]) fs.rmSync(getDefaultDbPath() + suffix, { force: true });
    fs.writeFileSync(getDefaultDbPath(), "");
    db = openDb();
    expect(db.prepare("SELECT value FROM settings WHERE key = 'copy_forward_marker'").get()?.value).toBe("adopted-on-startup");
    db.close();
    expect(fs.statSync(getDefaultDbPath()).size).toBe(0);
  });

  it("relocates nothing when MANDIBLE_DB names an explicit path", () => {
    seedDb(getLegacyCacheDbPath(), "not-mine-to-move");
    const explicit = path.join(tempHome, "explicit", "mandible.db");
    process.env.MANDIBLE_DB = explicit;
    openDb().close();
    expect(fs.existsSync(explicit)).toBe(true);
    expect(fs.existsSync(getDefaultDbPath())).toBe(false);
  });
});
