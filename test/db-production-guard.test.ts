import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PRODUCTION_DB_PATH,
  assertNotProductionDbUnderTest,
  openDb,
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

  it("refuses even when the production path is reached via a non-canonical form", () => {
    const nonCanonical = path.join(
      os.homedir(),
      ".cache",
      "mandible",
      "..",
      "mandible",
      "mandible.db",
    );
    expect(() => assertNotProductionDbUnderTest(nonCanonical)).toThrow(
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
    expect(() => assertNotProductionDbUnderTest(PRODUCTION_DB_PATH)).not.toThrow();
  });

  // F2 regression: a string compare (path.resolve only) is defeated by a
  // symlink, a hard link, or a relative segment that resolves to the same
  // file. resolvesToProductionDbPath must canonicalize and inode-compare so
  // none of those smuggle the production bytes past the guard. Tested against a
  // synthetic "production" file so the assertions hold with no real DB present.
  describe("path canonicalization (symlink / hard link / alias bypass)", () => {
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

    it("refuses a symlink that resolves to the real production DB (MANDIBLE_DB=/tmp/link scenario)", () => {
      // Exercises the full guard against the real production path, but only when
      // that file exists on this machine. The guard resolves the symlink and
      // refuses without ever opening or writing the database.
      if (!fs.existsSync(PRODUCTION_DB_PATH)) return;
      const link = path.join(tempDir, "link-to-live.db");
      fs.symlinkSync(PRODUCTION_DB_PATH, link);
      expect(() => assertNotProductionDbUnderTest(link)).toThrow(
        /production Mandible database/i,
      );
    });
  });
});
