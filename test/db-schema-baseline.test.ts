import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CURRENT_SCHEMA_VERSION,
  MINIMUM_SUPPORTED_SCHEMA_VERSION,
  UnsupportedSchemaVersionError,
  migrate,
  openDb,
  type Db,
} from "../src/db.js";
import { startDaemon } from "../src/index.js";
import { checkHealth } from "../src/lifecycle.js";
import { schemaVersion } from "./helpers/schema-snapshot.js";

const FLOOR_FIXTURE = fs.readFileSync(
  path.join(process.cwd(), "test", "fixtures", `schema-v${MINIMUM_SUPPORTED_SCHEMA_VERSION}.sql`),
  "utf8",
);

let tempDir = "";

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-schema-baseline-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function createFloorDatabase(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.exec(FLOOR_FIXTURE);
  } finally {
    db.close();
  }
}

/** A database whose recorded version is outside what this build can serve. */
function createDatabaseAtVersion(dbPath: string, version: number): Db {
  createFloorDatabase(dbPath);
  const db = new Database(dbPath);
  db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(version));
  return db;
}

describe.sequential("fresh schema baseline", () => {
  it("creates a healthy database at head", () => {
    const db = openDb(path.join(tempDir, "fresh.db"));
    try {
      expect(schemaVersion(db)).toBe(String(CURRENT_SCHEMA_VERSION));
      expect(db.pragma("foreign_key_check")).toEqual([]);
      expect(db.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    } finally {
      db.close();
    }
  });

  it("boots the daemon against fresh and floor-migrated databases", async () => {
    const cases = [
      { name: "fresh", dbPath: path.join(tempDir, "daemon-fresh.db"), fixture: false },
      { name: "migrated", dbPath: path.join(tempDir, "daemon-migrated.db"), fixture: true },
    ];

    for (const bootCase of cases) {
      if (bootCase.fixture) createFloorDatabase(bootCase.dbPath);
      const daemon = await startDaemon({
        port: 0,
        dbPath: bootCase.dbPath,
        pidFilePath: path.join(tempDir, `${bootCase.name}.pid`),
        handleSignals: false,
      });
      try {
        expect(await checkHealth(daemon.port)).toMatchObject({ status: "ok", ready: true });
        expect(schemaVersion(daemon.db)).toBe(String(CURRENT_SCHEMA_VERSION));
        expect(daemon.db.pragma("foreign_key_check")).toEqual([]);
      } finally {
        await daemon.close();
      }
    }
  });
});

describe.sequential("supported schema version range", () => {
  it("refuses a database below the floor and says what to do about it", () => {
    const belowFloor = MINIMUM_SUPPORTED_SCHEMA_VERSION - 1;
    const dbPath = path.join(tempDir, "old.db");
    const db = createDatabaseAtVersion(dbPath, belowFloor);
    try {
      let thrown: unknown;
      try {
        migrate(db);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(UnsupportedSchemaVersionError);
      const message = (thrown as Error).message;
      // The operator must be able to act on this without reading the source:
      // which version was found, which is required, and what to do next.
      expect(message).toContain(`v${belowFloor}`);
      expect(message).toContain(`v${MINIMUM_SUPPORTED_SCHEMA_VERSION}`);
      expect(message).toContain(dbPath);
      expect(message).toMatch(/older Mandible|move it aside/);
      // A refusal must not have half-migrated the database first.
      expect(schemaVersion(db)).toBe(String(belowFloor));
    } finally {
      db.close();
    }
  });

  it("refuses a database newer than the head this build serves", () => {
    const dbPath = path.join(tempDir, "new.db");
    const db = createDatabaseAtVersion(dbPath, CURRENT_SCHEMA_VERSION + 1);
    try {
      expect(() => migrate(db)).toThrow(UnsupportedSchemaVersionError);
      expect(() => migrate(db)).toThrow(
        new RegExp(`newer than the v${CURRENT_SCHEMA_VERSION} this build serves`),
      );
    } finally {
      db.close();
    }
  });
});
