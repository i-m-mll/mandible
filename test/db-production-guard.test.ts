import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertNotProductionDbUnderTest, openDb, type Db } from "../src/db.js";

// Issue 07edc0d — structural isolation guard. A test-invoked code path once
// opened the real production database (~/.cache/mandible/mandible.db) under the
// vitest runner and executed a schema migration against live data. The guard at
// the DB-open chokepoint must refuse to open the production path under the test
// runner regardless of which helper resolves it, so no future test can repeat
// the leak. These tests run under vitest, so the guard is active here.
describe("production database isolation guard (issue 07edc0d)", () => {
  const PRODUCTION_DB_PATH = path.join(os.homedir(), ".cache", "mandible", "mandible.db");

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
});
