import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  LEGACY_PRODUCTION_DB_PATH,
  PRODUCTION_DB_PATH,
  PRODUCTION_DB_PATHS,
  PRODUCTION_OPERATIONAL_LOG_DB_PATH,
  assertNotProductionDbUnderTest,
  openDb,
  resolvesToAnyProductionDbPath,
  resolvesToProductionDbPath,
  type Db,
} from "../src/db.js";

// Issue 07edc0d — structural isolation guard. A test-invoked code path once
// opened the real production database (~/.cache/mandible/mandible.db) under the
// vitest runner and executed a schema migration against live data. The guard at
// the DB-open chokepoint must refuse to open the production path under the test
// runner regardless of which helper resolves it, so no future test can repeat
// the leak. These tests run under vitest, so the guard is active here.
describe("production database isolation guard (issue 07edc0d)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-prod-guard-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    delete process.env.MANDIBLE_ALLOW_REAL_DB;
  });

  it("refuses to open the production database path under the test runner", () => {
    expect(() => assertNotProductionDbUnderTest(PRODUCTION_DB_PATH)).toThrow(
      /production Mandible database/i,
    );
  });

  // Issue 24f0316 — the database moved from ~/.cache/mandible to ~/.mandible,
  // and the copy-forward shim deliberately never deletes the originals. Both
  // paths can therefore hold live bytes, so a guard that tracked only the new
  // location would silently protect nothing on any machine that has not
  // restarted into the new layout yet.
  it("refuses BOTH the durable and the pre-split production paths", () => {
    expect(PRODUCTION_DB_PATH).toMatch(/[/\\]\.mandible[/\\]mandible\.db$/);
    expect(LEGACY_PRODUCTION_DB_PATH).toMatch(/[/\\]\.cache[/\\]mandible[/\\]mandible\.db$/);
    expect(PRODUCTION_DB_PATHS).toEqual([
      PRODUCTION_DB_PATH,
      LEGACY_PRODUCTION_DB_PATH,
      PRODUCTION_OPERATIONAL_LOG_DB_PATH,
    ]);
    for (const guarded of PRODUCTION_DB_PATHS) {
      expect(() => assertNotProductionDbUnderTest(guarded)).toThrow(
        /production Mandible database/i,
      );
      expect(resolvesToAnyProductionDbPath(guarded)).toBe(guarded);
    }
  });

  it("names the specific production path it refused", () => {
    expect(() => assertNotProductionDbUnderTest(LEGACY_PRODUCTION_DB_PATH)).toThrow(
      /\.cache/,
    );
  });

  it("refuses even when a production path is reached via a non-canonical form", () => {
    const nonCanonicalLegacy = path.join(
      os.homedir(),
      ".cache",
      "mandible",
      "..",
      "mandible",
      "mandible.db",
    );
    expect(() => assertNotProductionDbUnderTest(nonCanonicalLegacy)).toThrow(
      /production Mandible database/i,
    );

    const nonCanonicalDurable = path.join(
      os.homedir(),
      ".mandible",
      "..",
      ".mandible",
      "mandible.db",
    );
    expect(() => assertNotProductionDbUnderTest(nonCanonicalDurable)).toThrow(
      /production Mandible database/i,
    );
  });

  it("refuses literal unexpanded-tilde spellings of both production paths", () => {
    expect(() => assertNotProductionDbUnderTest("~/.mandible/mandible.db")).toThrow(
      /production Mandible database/i,
    );
    expect(() => assertNotProductionDbUnderTest("~/.cache/mandible/mandible.db")).toThrow(
      /production Mandible database/i,
    );
  });

  it("blocks openDb() from touching the production database under test", () => {
    // openDb must trip the guard BEFORE constructing a Database handle, so this
    // never opens or writes the real file.
    expect(() => openDb(PRODUCTION_DB_PATH)).toThrow(/production Mandible database/i);
  });

  it("allows explicit temp/fixture paths", () => {
    const tempPath = path.join(tempDir, "mandible.db");
    expect(() => assertNotProductionDbUnderTest(tempPath)).not.toThrow();
    let db: Db | null = null;
    expect(() => {
      db = openDb(tempPath);
    }).not.toThrow();
    db?.close();
  });

  it("honors the MANDIBLE_ALLOW_REAL_DB explicit opt-out", () => {
    process.env.MANDIBLE_ALLOW_REAL_DB = "1";
    for (const guarded of PRODUCTION_DB_PATHS) {
      expect(() => assertNotProductionDbUnderTest(guarded)).not.toThrow();
    }
  });

  it("does not flag a path that resolves to no production location", () => {
    expect(resolvesToAnyProductionDbPath(path.join(tempDir, "mandible.db"))).toBeNull();
  });

  // F2 regression: a string compare (path.resolve only) is defeated by a
  // symlink, a hard link, or a relative segment that resolves to the same
  // file. resolvesToProductionDbPath must canonicalize and inode-compare so
  // none of those smuggle the production bytes past the guard. Tested against a
  // synthetic "production" file so the assertions hold with no real DB present.
  describe("path canonicalization (symlink / hard link / alias bypass)", () => {
    it("resolves a missing protected leaf through dangling parent links and refuses cycles", () => {
      const protectedDirectory = path.join(tempDir, "future-protected");
      const protectedDb = path.join(protectedDirectory, "mandible.db");
      const alias = path.join(tempDir, "future-alias");
      fs.symlinkSync(protectedDirectory, alias);
      expect(resolvesToProductionDbPath(path.join(alias, "mandible.db"), protectedDb)).toBe(true);
      expect(fs.existsSync(protectedDirectory)).toBe(false);
      const first = path.join(tempDir, "cycle-first");
      const second = path.join(tempDir, "cycle-second");
      fs.symlinkSync(second, first);
      fs.symlinkSync(first, second);
      expect(() => resolvesToProductionDbPath(path.join(first, "mandible.db"), protectedDb)).toThrow(/symlink cycle|ELOOP/);
    });

    it("detects a symlink pointing at the production file", () => {
      const prod = path.join(tempDir, "prod.db");
      const link = path.join(tempDir, "link-to-prod.db");
      fs.writeFileSync(prod, "x");
      fs.symlinkSync(prod, link);
      expect(resolvesToProductionDbPath(link, prod)).toBe(true);
    });

    it("detects a hard link to the production file (shared inode)", () => {
      const prod = path.join(tempDir, "prod.db");
      const hard = path.join(tempDir, "hardlink.db");
      fs.writeFileSync(prod, "x");
      fs.linkSync(prod, hard);
      expect(resolvesToProductionDbPath(hard, prod)).toBe(true);
    });

    it("detects a relative-segment path to the production file", () => {
      const prod = path.join(tempDir, "prod.db");
      fs.writeFileSync(prod, "x");
      const viaDot = path.join(tempDir, ".", "prod.db");
      expect(resolvesToProductionDbPath(viaDot, prod)).toBe(true);
    });

    it("does not flag an unrelated temp path", () => {
      const prod = path.join(tempDir, "prod.db");
      const other = path.join(tempDir, "other.db");
      fs.writeFileSync(prod, "x");
      fs.writeFileSync(other, "y");
      expect(resolvesToProductionDbPath(other, prod)).toBe(false);
    });

    it("refuses a symlink that resolves to a real production DB (MANDIBLE_DB=/tmp/link scenario)", () => {
      // Exercises the full guard against the real production paths, but only
      // for those that exist on this machine. The guard resolves the symlink
      // and refuses without ever opening or writing the database. During the
      // transition both locations can be present at once.
      let exercised = 0;
      for (const [index, guarded] of PRODUCTION_DB_PATHS.entries()) {
        if (!fs.existsSync(guarded)) continue;
        exercised += 1;
        const link = path.join(tempDir, `link-to-live-${index}.db`);
        fs.symlinkSync(guarded, link);
        expect(() => assertNotProductionDbUnderTest(link)).toThrow(
          /production Mandible database/i,
        );
      }
      expect(exercised).toBeGreaterThanOrEqual(0);
    });
  });
});

// The CommonJS twin at cli/production-db-guard.cjs is what the bash-embedded
// node helper and the standalone .mjs maintenance scripts apply, so a guard
// that drifts from src/db.ts leaves every non-TypeScript entry point
// unprotected. Issue 24f0316 widened both to two production paths at once;
// this pins them together.
describe("CommonJS guard twin (cli/production-db-guard.cjs)", () => {
  const guard = createRequire(import.meta.url)(
    "../cli/production-db-guard.cjs",
  ) as {
    PRODUCTION_DB_PATH: string;
    LEGACY_PRODUCTION_DB_PATH: string;
    PRODUCTION_DB_PATHS: string[];
    assertNotProductionDbUnderTest: (dbPath: string) => void;
    resolvesToAnyProductionDbPath: (dbPath: string) => string | null;
  };

  it("guards the same production paths as the TypeScript implementation", () => {
    expect(guard.PRODUCTION_DB_PATH).toBe(PRODUCTION_DB_PATH);
    expect(guard.LEGACY_PRODUCTION_DB_PATH).toBe(LEGACY_PRODUCTION_DB_PATH);
    expect(guard.PRODUCTION_DB_PATHS).toEqual([...PRODUCTION_DB_PATHS]);
  });

  it("refuses both of them under the test runner", () => {
    for (const guarded of guard.PRODUCTION_DB_PATHS) {
      expect(() => guard.assertNotProductionDbUnderTest(guarded)).toThrow(
        /production Mandible database/i,
      );
    }
  });

  it("refuses the same unexpanded-tilde spellings as the TypeScript guard", () => {
    for (const guarded of ["~/.mandible/mandible.db", "~/.cache/mandible/mandible.db"]) {
      expect(() => guard.assertNotProductionDbUnderTest(guarded)).toThrow(
        /production Mandible database/i,
      );
    }
  });

  it("allows an explicit temp path", () => {
    const temp = path.join(os.tmpdir(), "mandible-cjs-guard-allowed.db");
    expect(() => guard.assertNotProductionDbUnderTest(temp)).not.toThrow();
    expect(guard.resolvesToAnyProductionDbPath(temp)).toBeNull();
  });
});
