import { execFileSync } from "node:child_process";
import SqliteDatabase from "../../src/sqlite.ts";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  copyForwardLegacyDb,
  getDefaultDbPath,
  getDbPath,
  getLegacyCacheDbPath,
  openDb,
  type CopyForwardOutcome,
} from "../../src/db.js";
import {
  getLegacyMandibleConfigDirs,
  ensureMandibleClientAuthDir,
  getMandibleConfigDir,
  getMandibleHome,
  getMandibleHomePath,
} from "../../src/platform-paths.js";

// Issue 24f0316 — Mandible state is split by lifetime: durable state under
// ~/.mandible, disposable state under ~/.cache/mandible. These tests pin the
// single helper that owns the durable root, the config fold, and the startup
// copy-forward that relocates an existing ledger database exactly once.
//
// Every case runs against a throwaway HOME, so nothing here can see or touch a
// real ~/.mandible or ~/.cache/mandible.

const SIDECARS = ["-wal", "-shm"] as const;

/**
 * Open a path without arming the copy-forward shim. Seeding the durable path
 * directly would otherwise trip the very relocation the test is setting up.
 */
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

function seedFakeDb(dbPath: string, marker: string): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openExplicitly(dbPath);
  db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)").run(
    "copy_forward_marker",
    marker,
    1,
  );
  db.close();
}

function readMarker(dbPath: string): string | null {
  const db = openExplicitly(dbPath);
  try {
    const row = db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get("copy_forward_marker") as { value: string } | undefined;
    return row?.value ?? null;
  } finally {
    db.close();
  }
}

describe("durable-state root (issue 24f0316)", () => {
  const originalEnv = {
    HOME: process.env.HOME,
    MANDIBLE_HOME: process.env.MANDIBLE_HOME,
    MANDIBLE_DB: process.env.MANDIBLE_DB,
    MANDIBLE_CONFIG_DIR: process.env.MANDIBLE_CONFIG_DIR,
    MANDIBLE_CLIENT_AUTH_DIR: process.env.MANDIBLE_CLIENT_AUTH_DIR,
  };
  let tempHome = "";

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-home-"));
    process.env.HOME = tempHome;
    delete process.env.MANDIBLE_HOME;
    delete process.env.MANDIBLE_DB;
    delete process.env.MANDIBLE_CONFIG_DIR;
    delete process.env.MANDIBLE_CLIENT_AUTH_DIR;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (tempHome) {
      // Restore any mode we tightened so cleanup can always recurse.
      fs.rmSync(tempHome, { recursive: true, force: true });
      tempHome = "";
    }
  });

  describe("getMandibleHome", () => {
    it("defaults to ~/.mandible", () => {
      expect(getMandibleHome()).toBe(path.join(tempHome, ".mandible"));
    });

    it("is overridden wholesale by MANDIBLE_HOME, expanding ~", () => {
      process.env.MANDIBLE_HOME = "~/elsewhere/mandible";
      const expected = path.join(tempHome, "elsewhere", "mandible");
      expect(getMandibleHome()).toBe(expected);
      expect(getMandibleHomePath("backups")).toBe(path.join(expected, "backups"));
      // The override reaches every derived durable path, not just the root.
      expect(getDefaultDbPath()).toBe(path.join(expected, "mandible.db"));
      expect(getMandibleConfigDir()).toBe(path.join(expected, "config"));
    });

    it("re-reads the environment on each call rather than freezing at import", () => {
      const before = getMandibleHome();
      process.env.MANDIBLE_HOME = path.join(tempHome, "late-binding");
      expect(getMandibleHome()).not.toBe(before);
    });

    it("ignores a blank MANDIBLE_HOME", () => {
      process.env.MANDIBLE_HOME = "   ";
      expect(getMandibleHome()).toBe(path.join(tempHome, ".mandible"));
    });
  });

  describe("database path resolution", () => {
    it("puts the ledger database under the durable root, not the cache root", () => {
      expect(getDefaultDbPath()).toBe(path.join(tempHome, ".mandible", "mandible.db"));
      expect(getDbPath()).toBe(getDefaultDbPath());
      expect(getLegacyCacheDbPath()).toBe(
        path.join(tempHome, ".cache", "mandible", "mandible.db"),
      );
    });

    it("still lets MANDIBLE_DB win outright", () => {
      const explicit = path.join(tempHome, "explicit.db");
      process.env.MANDIBLE_DB = explicit;
      expect(getDbPath()).toBe(explicit);
    });
  });

  describe("config fold", () => {
    it("resolves config under the durable root on every platform", () => {
      expect(getMandibleConfigDir()).toBe(path.join(tempHome, ".mandible", "config"));
    });

    it("honors MANDIBLE_CONFIG_DIR ahead of the durable root", () => {
      const explicit = path.join(tempHome, "custom-config");
      process.env.MANDIBLE_CONFIG_DIR = explicit;
      expect(getMandibleConfigDir()).toBe(explicit);
    });

    it("lets an isolated authority override only the client-auth directory", () => {
      const explicit = path.join(tempHome, "preview-authority", "client-auth");
      process.env.MANDIBLE_CLIENT_AUTH_DIR = explicit;
      expect(ensureMandibleClientAuthDir()).toBe(explicit);
      expect(getMandibleConfigDir()).toBe(path.join(tempHome, ".mandible", "config"));
    });

    it("lists the pre-fold config locations without including the new one", () => {
      const legacy = getLegacyMandibleConfigDirs();
      expect(legacy.length).toBeGreaterThan(0);
      expect(legacy).not.toContain(getMandibleConfigDir());
      // Ordering matters: the platform-conventional dir is where the daemon
      // most recently wrote, so it must be consulted before ~/.config.
      expect(legacy[legacy.length - 1]).toBe(path.join(tempHome, ".config", "mandible"));
    });

    it("copies a legacy config file forward and leaves the original in place", async () => {
      const legacyDir = getLegacyMandibleConfigDirs()[0];
      const legacyFile = path.join(legacyDir, "repos.json");
      fs.mkdirSync(legacyDir, { recursive: true });
      fs.writeFileSync(legacyFile, '{"repos":["/repo"]}\n', "utf8");

      const { ensureMandibleConfigFile } = await import("../../src/platform-paths.js");
      const resolved = ensureMandibleConfigFile("repos.json");

      expect(resolved).toBe(path.join(tempHome, ".mandible", "config", "repos.json"));
      expect(fs.readFileSync(resolved, "utf8")).toBe('{"repos":["/repo"]}\n');
      expect(fs.existsSync(legacyFile)).toBe(true);
    });

    it("copies a legacy config directory forward preserving restrictive modes", async () => {
      // client-auth is a directory of secrets: 0700 dir, 0600 files. A copy
      // that widened those modes would be a real regression — secret-store
      // refuses material it finds with broader permissions.
      const legacyDir = getLegacyMandibleConfigDirs()[0];
      const legacyClientAuth = path.join(legacyDir, "client-auth");
      fs.mkdirSync(legacyClientAuth, { recursive: true, mode: 0o700 });
      fs.chmodSync(legacyClientAuth, 0o700);
      fs.writeFileSync(path.join(legacyClientAuth, "pepper"), "secret-pepper", { mode: 0o600 });
      fs.chmodSync(path.join(legacyClientAuth, "pepper"), 0o600);

      const { ensureMandibleConfigEntry } = await import("../../src/platform-paths.js");
      const resolved = ensureMandibleConfigEntry("client-auth");

      expect(resolved).toBe(path.join(tempHome, ".mandible", "config", "client-auth"));
      expect(fs.readFileSync(path.join(resolved, "pepper"), "utf8")).toBe("secret-pepper");
      expect(fs.statSync(resolved).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.join(resolved, "pepper")).mode & 0o777).toBe(0o600);
      expect(fs.existsSync(legacyClientAuth)).toBe(true);
    });

    it("does not re-copy once the durable entry exists", async () => {
      const legacyDir = getLegacyMandibleConfigDirs()[0];
      fs.mkdirSync(legacyDir, { recursive: true });
      fs.writeFileSync(path.join(legacyDir, "repos.json"), "legacy\n", "utf8");
      const target = path.join(tempHome, ".mandible", "config", "repos.json");
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, "current\n", "utf8");

      const { ensureMandibleConfigFile } = await import("../../src/platform-paths.js");
      expect(ensureMandibleConfigFile("repos.json")).toBe(target);
      expect(fs.readFileSync(target, "utf8")).toBe("current\n");
    });

    it("leaves a missing legacy config entry absent", async () => {
      const { ensureMandibleConfigEntry } = await import("../../src/platform-paths.js");
      const target = ensureMandibleConfigEntry("client-auth");
      expect(target).toBe(path.join(tempHome, ".mandible", "config", "client-auth"));
      expect(fs.existsSync(target)).toBe(false);
    });

    it("folds a partial legacy config without inventing missing entries", async () => {
      const legacyDir = getLegacyMandibleConfigDirs()[0];
      fs.mkdirSync(legacyDir, { recursive: true });
      fs.writeFileSync(path.join(legacyDir, "repos.json"), "partial\n", "utf8");

      const { ensureMandibleConfigEntry, ensureMandibleConfigFile } = await import(
        "../../src/platform-paths.js"
      );
      const repos = ensureMandibleConfigFile("repos.json");
      const clientAuth = ensureMandibleConfigEntry("client-auth");

      expect(fs.readFileSync(repos, "utf8")).toBe("partial\n");
      expect(fs.existsSync(clientAuth)).toBe(false);
    });
  });

  describe("startup copy-forward shim", () => {
    let target = "";
    let legacy = "";

    beforeEach(() => {
      target = getDefaultDbPath();
      legacy = getLegacyCacheDbPath();
    });

    function copyForward(
      options: Parameters<typeof copyForwardLegacyDb>[2] = {},
    ): CopyForwardOutcome {
      return copyForwardLegacyDb(target, legacy, { log: () => {}, ...options });
    }

    it("fresh install: no legacy database, so the durable path is used as-is", () => {
      const outcome = copyForward();
      expect(outcome).toMatchObject({ dbPath: target, action: "no-legacy" });
      expect(fs.existsSync(target)).toBe(false);
    });

    it("copies committed frames that exist only in a real non-empty WAL", () => {
      seedFakeDb(legacy, "main-file-value");
      const source = openExplicitly(legacy);
      try {
        source.pragma("wal_autocheckpoint = 0");
        source.pragma("wal_checkpoint(TRUNCATE)");
        source
          .prepare("UPDATE settings SET value = ? WHERE key = ?")
          .run("committed-only-in-wal", "copy_forward_marker");
        expect(fs.statSync(`${legacy}-wal`).size).toBeGreaterThan(0);

        const mainOnly = path.join(tempHome, "main-file-only.db");
        fs.copyFileSync(legacy, mainOnly);
        const mainOnlyDb = new SqliteDatabase(mainOnly, { fileMustExist: true });
        try {
          expect(
            mainOnlyDb
              .prepare("SELECT value FROM settings WHERE key = ?")
              .get("copy_forward_marker")?.value,
          ).toBe("main-file-value");
        } finally {
          mainOnlyDb.close();
        }

        const outcome = copyForward();
        expect(outcome.action).toBe("copied");
        expect(outcome.dbPath).toBe(target);
        expect(readMarker(target)).toBe("committed-only-in-wal");
        expect(outcome.copied).toEqual([target, `${target}-wal`, `${target}-shm`]);
      } finally {
        source.close();
      }

      expect(fs.existsSync(legacy)).toBe(true);
      expect(fs.existsSync(`${legacy}.moved-to-mandible-home`)).toBe(true);
      expect(fs.existsSync(`${target}.copy-forward-in-progress`)).toBe(false);
    });

    it("copies a legacy database that has no sidecars", () => {
      seedFakeDb(legacy, "no-sidecars");
      for (const suffix of SIDECARS) fs.rmSync(legacy + suffix, { force: true });

      expect(copyForward().action).toBe("copied");
      expect(readMarker(target)).toBe("no-sidecars");
    });

    it("both present: the durable database wins and nothing is copied over it", () => {
      seedFakeDb(legacy, "stale-legacy");
      seedFakeDb(target, "current-durable");

      const outcome = copyForward();

      expect(outcome).toMatchObject({ dbPath: target, action: "target-present" });
      expect(readMarker(target)).toBe("current-durable");
    });

    it("refuses an empty durable database while a populated legacy database exists", () => {
      seedFakeDb(legacy, "authoritative-legacy");
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, "");
      const logs: string[] = [];

      const outcome = copyForwardLegacyDb(target, legacy, { log: (line) => logs.push(line) });

      expect(outcome).toMatchObject({ dbPath: legacy, action: "kept-legacy" });
      expect(outcome.reason).toMatch(/invalid-target.*zero bytes/i);
      expect(logs.join("\n")).toMatch(/REFUSING.*zero bytes.*legacy database/i);
      expect(readMarker(legacy)).toBe("authoritative-legacy");
      expect(fs.statSync(target).size).toBe(0);
    });

    it("refuses an unopenable durable database while a populated legacy database exists", () => {
      seedFakeDb(legacy, "authoritative-legacy");
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, "not a sqlite database");

      const outcome = copyForward();

      expect(outcome).toMatchObject({ dbPath: legacy, action: "kept-legacy" });
      expect(outcome.reason).toMatch(/invalid-target.*not openable/i);
      expect(readMarker(legacy)).toBe("authoritative-legacy");
    });

    it("insufficient headroom: keeps using the legacy database and writes nothing", () => {
      seedFakeDb(legacy, "too-big-to-move");

      const outcome = copyForward({ headroomMarginBytes: Number.MAX_SAFE_INTEGER });

      expect(outcome.dbPath).toBe(legacy);
      expect(outcome.action).toBe("kept-legacy");
      expect(outcome.reason).toMatch(/insufficient-space/);
      expect(fs.existsSync(target)).toBe(false);
      expect(fs.existsSync(`${target}.copy-forward-in-progress`)).toBe(false);
      // Falling back must not look like a fresh install: the data is still there.
      expect(readMarker(legacy)).toBe("too-big-to-move");
    });

    it("copy failure: removes the partial copy and keeps using the legacy database", () => {
      seedFakeDb(legacy, "unreadable-sidecar");
      const wal = `${legacy}-wal`;
      fs.writeFileSync(wal, "wal-bytes");
      fs.chmodSync(wal, 0o000);

      let outcome: CopyForwardOutcome;
      try {
        outcome = copyForward();
      } finally {
        fs.chmodSync(wal, 0o600);
      }

      expect(outcome.dbPath).toBe(legacy);
      expect(outcome.action).toBe("kept-legacy");
      expect(outcome.reason).toMatch(/copy-failed/);
      // A half-copied database left behind would be adopted as authoritative on
      // the next start, which is the one outcome worse than not moving at all.
      for (const suffix of ["", ...SIDECARS]) {
        expect(fs.existsSync(target + suffix)).toBe(false);
      }
      expect(fs.existsSync(`${target}.copy-forward-in-progress`)).toBe(false);
    });

    it("stale in-progress marker: discards the unverified copy and starts over", () => {
      seedFakeDb(legacy, "authoritative");
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, "truncated-garbage");
      fs.writeFileSync(`${target}.copy-forward-in-progress`, "interrupted");

      const outcome = copyForward();

      expect(outcome.action).toBe("copied");
      expect(readMarker(target)).toBe("authoritative");
      expect(fs.existsSync(`${target}.copy-forward-in-progress`)).toBe(false);
    });

    it("complete destination plus stale marker is still discarded and recopied", () => {
      seedFakeDb(legacy, "authoritative");
      seedFakeDb(target, "complete-but-uncommitted");
      fs.writeFileSync(`${target}.copy-forward-in-progress`, "interrupted-after-verify");

      const outcome = copyForward();

      expect(outcome.action).toBe("copied");
      expect(readMarker(target)).toBe("authoritative");
      expect(fs.existsSync(`${target}.copy-forward-in-progress`)).toBe(false);
    });

    it("rejects a destination that copied but will not open", () => {
      // Size verification alone is not enough: a byte-identical copy of a
      // corrupt file is still unusable, so the shim opens the result before
      // committing to it.
      fs.mkdirSync(path.dirname(legacy), { recursive: true });
      fs.writeFileSync(legacy, "this is not a sqlite database at all");

      const outcome = copyForward();

      expect(outcome.dbPath).toBe(legacy);
      expect(outcome.action).toBe("kept-legacy");
      expect(fs.existsSync(target)).toBe(false);
    });
  });

  // The daemon is not the only thing that resolves a database path: the bash
  // CLI, the bash-embedded node settings helper, and the standalone .mjs
  // maintenance scripts all do too. They must agree with the daemon, and — the
  // part that actually bites — they must never CREATE a database. An empty file
  // at the durable path would be adopted by the next copy-forward as though it
  // were the relocated ledger, stranding the real one in the cache root.
  describe("non-daemon resolvers", () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

    function shellLiveDbPath(): string {
      return execFileSync(
        "bash",
        ["-c", `source "${path.join(repoRoot, "cli", "api.sh")}"; api_live_db_path`],
        { env: { ...process.env, HOME: tempHome }, encoding: "utf8" },
      ).trim();
    }

    function cjsPaths() {
      const require_ = createRequire(import.meta.url);
      const modulePath = require_.resolve("../../cli/mandible-paths.cjs");
      delete require_.cache[modulePath];
      return require_(modulePath) as {
        mandibleHome: () => string;
        liveDbPath: () => string;
        defaultDbPath: () => string;
        legacyCacheDbPath: () => string;
      };
    }

    it("names the durable path on a fresh install without creating it", () => {
      expect(cjsPaths().liveDbPath()).toBe(getDefaultDbPath());
      expect(shellLiveDbPath()).toBe(getDefaultDbPath());
      expect(fs.existsSync(getDefaultDbPath())).toBe(false);
    });

    it("names the pre-split database until the daemon has copied it forward", () => {
      seedFakeDb(getLegacyCacheDbPath(), "not-yet-relocated");
      expect(cjsPaths().liveDbPath()).toBe(getLegacyCacheDbPath());
      expect(shellLiveDbPath()).toBe(getLegacyCacheDbPath());
    });

    it("prefers the durable database once it exists", () => {
      seedFakeDb(getLegacyCacheDbPath(), "superseded");
      seedFakeDb(getDefaultDbPath(), "relocated");
      expect(cjsPaths().liveDbPath()).toBe(getDefaultDbPath());
      expect(shellLiveDbPath()).toBe(getDefaultDbPath());
    });

    it("keeps reading legacy while the durable copy marker is present", () => {
      seedFakeDb(getLegacyCacheDbPath(), "authoritative-during-copy");
      fs.mkdirSync(path.dirname(getDefaultDbPath()), { recursive: true });
      fs.writeFileSync(getDefaultDbPath(), "partial-copy");
      fs.writeFileSync(`${getDefaultDbPath()}.copy-forward-in-progress`, "copying");

      expect(cjsPaths().liveDbPath()).toBe(getLegacyCacheDbPath());
      expect(shellLiveDbPath()).toBe(getLegacyCacheDbPath());
    });

    it("does not let an empty durable file strand a populated legacy database", () => {
      seedFakeDb(getLegacyCacheDbPath(), "authoritative");
      fs.mkdirSync(path.dirname(getDefaultDbPath()), { recursive: true });
      fs.writeFileSync(getDefaultDbPath(), "");

      expect(cjsPaths().liveDbPath()).toBe(getLegacyCacheDbPath());
      expect(shellLiveDbPath()).toBe(getLegacyCacheDbPath());
    });

    it("lets MANDIBLE_DB win in both implementations", () => {
      const explicit = path.join(tempHome, "explicit.db");
      process.env.MANDIBLE_DB = explicit;
      expect(cjsPaths().liveDbPath()).toBe(explicit);
      expect(shellLiveDbPath()).toBe(explicit);
    });

    it("agrees with the daemon on the durable root and the pre-split path", () => {
      const paths = cjsPaths();
      expect(paths.defaultDbPath()).toBe(getDefaultDbPath());
      expect(paths.legacyCacheDbPath()).toBe(getLegacyCacheDbPath());
      expect(
        execFileSync(
          "bash",
          ["-c", `source "${path.join(repoRoot, "cli", "api.sh")}"; api_default_db_path`],
          { env: { ...process.env, HOME: tempHome }, encoding: "utf8" },
        ).trim(),
      ).toBe(getDefaultDbPath());
    });

    it("normalizes MANDIBLE_HOME identically for spaces, trailing slashes, and tilde", () => {
      const variants = [
        path.join(tempHome, "durable root") + path.sep,
        "~/tilde-root/",
        "~",
      ];
      for (const variant of variants) {
        process.env.MANDIBLE_HOME = variant;
        const expected = getMandibleHome();
        expect(cjsPaths().mandibleHome()).toBe(expected);
        expect(
          execFileSync(
            "bash",
            ["-c", `source "${path.join(repoRoot, "cli", "api.sh")}"; api_mandible_home`],
            { env: { ...process.env, HOME: tempHome }, encoding: "utf8" },
          ).trim(),
        ).toBe(expected);
      }
    });
  });

  describe("openDb integration", () => {
    it("adopts an existing legacy database at the durable path", () => {
      const legacy = getLegacyCacheDbPath();
      seedFakeDb(legacy, "adopted-on-startup");

      const db = openDb();
      try {
        const row = db
          .prepare("SELECT value FROM settings WHERE key = ?")
          .get("copy_forward_marker") as { value: string } | undefined;
        expect(row?.value).toBe("adopted-on-startup");
      } finally {
        db.close();
      }

      expect(fs.existsSync(getDefaultDbPath())).toBe(true);
      expect(fs.existsSync(legacy)).toBe(true);
    });

    it("keeps the populated legacy database authoritative when durable is empty", () => {
      const legacy = getLegacyCacheDbPath();
      seedFakeDb(legacy, "not-stranded");
      fs.mkdirSync(path.dirname(getDefaultDbPath()), { recursive: true });
      fs.writeFileSync(getDefaultDbPath(), "");

      const db = openDb();
      try {
        expect(
          db.prepare("SELECT value FROM settings WHERE key = ?")
            .get("copy_forward_marker")?.value,
        ).toBe("not-stranded");
      } finally {
        db.close();
      }

      expect(fs.statSync(getDefaultDbPath()).size).toBe(0);
      expect(readMarker(legacy)).toBe("not-stranded");
    });

    it("creates a fresh durable database when there is nothing to copy forward", () => {
      const db = openDb();
      db.close();
      expect(fs.existsSync(getDefaultDbPath())).toBe(true);
      expect(fs.existsSync(getLegacyCacheDbPath())).toBe(false);
    });

    it("does not relocate anything when MANDIBLE_DB names an explicit path", () => {
      const legacy = getLegacyCacheDbPath();
      seedFakeDb(legacy, "not-mine-to-move");
      const explicit = path.join(tempHome, "explicit", "mandible.db");
      process.env.MANDIBLE_DB = explicit;

      const db = openDb();
      db.close();

      expect(fs.existsSync(explicit)).toBe(true);
      expect(fs.existsSync(getDefaultDbPath())).toBe(false);
    });
  });
});
