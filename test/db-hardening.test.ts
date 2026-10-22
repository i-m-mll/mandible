// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyColdStartTuning,
  assertMigrationSequence,
  openDb,
  SQLITE_COLD_START_TUNING,
  type Db,
  type Migration,
} from "../src/db.js";
import { testRuntimeRoot } from "./helpers/runtime-isolation.js";

let tempDir = "";

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(testRuntimeRoot, "db-hardening-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("database hardening", () => {
  it("rejects duplicate migration versions before startup mutates the DB", () => {
    const migrations: Migration[] = [
      { version: 1, name: "first", statements: [] },
      { version: 1, name: "duplicate", statements: [] },
    ];

    expect(() => assertMigrationSequence(migrations, 0)).toThrow(/Duplicate migration version 1/);
  });

  it("rejects non-contiguous migration versions", () => {
    const migrations: Migration[] = [
      { version: 1, name: "first", statements: [] },
      { version: 3, name: "gap", statements: [] },
    ];

    expect(() => assertMigrationSequence(migrations, 0)).toThrow(/expected 2, got 3/);
  });

  it("opens every connection with WAL, enforced foreign keys and a busy timeout", () => {
    const db = openDb(path.join(tempDir, "daemon.db"));
    const ingestion = openDb(path.join(tempDir, "ingestion.db"), { busyTimeoutMs: 100 });
    try {
      expect([db, ingestion].map((connection) => ({
        journal: connection.pragma("journal_mode", { simple: true }),
        foreignKeys: connection.pragma("foreign_keys", { simple: true }),
        busyTimeout: connection.pragma("busy_timeout", { simple: true }),
      }))).toEqual([
        { journal: "wal", foreignKeys: 1, busyTimeout: 5000 },
        { journal: "wal", foreignKeys: 1, busyTimeout: 100 },
      ]);
    } finally {
      ingestion.close();
      db.close();
    }
  });

  it("keeps optional tuning failures non-fatal", () => {
    const attempts: string[] = [];
    const db = {
      pragma(source: string) {
        attempts.push(source);
        if (source.startsWith("mmap_size")) throw new Error("unsupported pragma");
        return [];
      },
    } as unknown as Db;

    expect(() => applyColdStartTuning(db)).not.toThrow();
    expect(attempts).toEqual([
      `mmap_size = ${SQLITE_COLD_START_TUNING.mmapSizeBytes}`,
      `cache_size = -${SQLITE_COLD_START_TUNING.cacheSizeKib}`,
      `temp_store = ${SQLITE_COLD_START_TUNING.tempStore}`,
    ]);
  });
});
