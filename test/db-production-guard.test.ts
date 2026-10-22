// @vitest-environment node
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testRuntimeRoot } from "./helpers/runtime-isolation.js";

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

// Issue 07edc0d: a test-invoked code path once opened the real production
// database under the test runner and migrated live data. Every DB-open
// chokepoint refuses the production paths under the runner, whatever spelling
// reaches them. cli/production-db-guard.cjs is the same guard for the bash and
// .mjs entry points, so both implementations answer one table.

const cjsGuard = createRequire(import.meta.url)("../cli/production-db-guard.cjs") as {
  PRODUCTION_DB_PATH: string;
  LEGACY_PRODUCTION_DB_PATH: string;
  PRODUCTION_DB_PATHS: string[];
  assertNotProductionDbUnderTest: (dbPath: string) => void;
  resolvesToAnyProductionDbPath: (dbPath: string) => string | null;
};

const implementations = [
  { name: "src/db.ts", assertNotProductionDbUnderTest, resolvesToAnyProductionDbPath },
  { name: "cli/production-db-guard.cjs", ...cjsGuard },
];

let tempDir = "";
beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(testRuntimeRoot, "prod-guard-"));
});
afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("production database isolation guard", () => {
  it("guards the durable, pre-split and operational-log paths in both implementations", () => {
    expect(PRODUCTION_DB_PATH).toMatch(/[/\\]\.mandible[/\\]mandible\.db$/);
    expect(LEGACY_PRODUCTION_DB_PATH).toMatch(/[/\\]\.cache[/\\]mandible[/\\]mandible\.db$/);
    expect(PRODUCTION_DB_PATHS).toEqual([PRODUCTION_DB_PATH, LEGACY_PRODUCTION_DB_PATH, PRODUCTION_OPERATIONAL_LOG_DB_PATH]);
    expect(cjsGuard.PRODUCTION_DB_PATHS).toEqual([...PRODUCTION_DB_PATHS]);
  });

  it.each(implementations)("$name refuses every spelling of a production path and allows a fixture path", (guard) => {
    const refused = [
      ...PRODUCTION_DB_PATHS,
      path.join(os.homedir(), ".cache", "mandible", "..", "mandible", "mandible.db"),
      path.join(os.homedir(), ".mandible", "..", ".mandible", "mandible.db"),
      "~/.mandible/mandible.db",
      "~/.cache/mandible/mandible.db",
    ];
    for (const spelling of refused) {
      expect(() => guard.assertNotProductionDbUnderTest(spelling), spelling).toThrow(/production Mandible database/i);
    }
    expect(() => guard.assertNotProductionDbUnderTest(LEGACY_PRODUCTION_DB_PATH)).toThrow(/\.cache/);
    const fixture = path.join(tempDir, "mandible.db");
    expect(() => guard.assertNotProductionDbUnderTest(fixture)).not.toThrow();
    expect(guard.resolvesToAnyProductionDbPath(fixture)).toBeNull();
  });

  it("trips inside openDb before a handle exists, and lets a fixture path open", () => {
    expect(() => openDb(PRODUCTION_DB_PATH)).toThrow(/production Mandible database/i);
    let db: Db | null = null;
    expect(() => { db = openDb(path.join(tempDir, "mandible.db")); }).not.toThrow();
    (db as Db | null)?.close();
  });

  it("sees through symlinks, hard links and relative segments to the protected file", () => {
    const prod = path.join(tempDir, "prod.db");
    const other = path.join(tempDir, "other.db");
    fs.writeFileSync(prod, "x");
    fs.writeFileSync(other, "y");
    fs.symlinkSync(prod, path.join(tempDir, "symlink.db"));
    fs.linkSync(prod, path.join(tempDir, "hardlink.db"));
    expect(["symlink.db", "hardlink.db", path.join(".", "prod.db"), "other.db"]
      .map((name) => resolvesToProductionDbPath(path.join(tempDir, name), prod)))
      .toEqual([true, true, true, false]);
  });

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
});
