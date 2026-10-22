import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import SqliteDatabase from "../src/sqlite.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyColdStartTuning,
  assertMigrationSequence,
  openDb,
  SQLITE_COLD_START_TUNING,
  type Db,
  type Migration,
} from "../src/db.js";

let tempDir = "";

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-db-hardening-"));
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

  it("sets a busy timeout on opened SQLite databases", () => {
    const db = openDb(path.join(tempDir, "busy.db"));
    try {
      expect(db.pragma("busy_timeout", { simple: true })).toBe(5000);
    } finally {
      db.close();
    }
  });

  it("applies cold-start tuning to daemon connections", () => {
    const db = openDb(path.join(tempDir, "daemon-tuning.db"));
    try {
      expect(db.pragma("mmap_size", { simple: true })).toBeLessThanOrEqual(
        SQLITE_COLD_START_TUNING.mmapSizeBytes,
      );
      expect(db.pragma("cache_size", { simple: true })).toBe(
        -SQLITE_COLD_START_TUNING.cacheSizeKib,
      );
      expect(db.pragma("temp_store", { simple: true })).toBe(2);
      expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    } finally {
      db.close();
    }
  });

  it("uses the shared tuning path for ingestion connections", () => {
    const db = openDb(path.join(tempDir, "ingestion-tuning.db"), { busyTimeoutMs: 100 });
    try {
      expect(db.pragma("busy_timeout", { simple: true })).toBe(100);
      expect(db.pragma("mmap_size", { simple: true })).toBeLessThanOrEqual(
        SQLITE_COLD_START_TUNING.mmapSizeBytes,
      );
      expect(db.pragma("cache_size", { simple: true })).toBe(
        -SQLITE_COLD_START_TUNING.cacheSizeKib,
      );
      expect(db.pragma("temp_store", { simple: true })).toBe(2);
    } finally {
      db.close();
    }
  });

  it("raises cold-open memory settings from SQLite defaults on a disposable database", () => {
    const dbPath = path.join(tempDir, "cold-open-proxy.db");
    const baseline = new SqliteDatabase(dbPath);
    const before = {
      mmapSizeBytes: baseline.pragma("mmap_size", { simple: true }),
      cacheSizePages: baseline.pragma("cache_size", { simple: true }),
      tempStore: baseline.pragma("temp_store", { simple: true }),
    };
    baseline.close();

    const tuned = openDb(dbPath);
    try {
      const after = {
        mmapSizeBytes: tuned.pragma("mmap_size", { simple: true }),
        cacheSizeKib: tuned.pragma("cache_size", { simple: true }),
        tempStore: tuned.pragma("temp_store", { simple: true }),
      };
      expect(before.mmapSizeBytes).toBe(0);
      expect(before.tempStore).toBe(0);
      expect(Math.abs(before.cacheSizePages as number)).toBeLessThan(
        SQLITE_COLD_START_TUNING.cacheSizeKib,
      );
      expect(after.mmapSizeBytes).toBeGreaterThan(before.mmapSizeBytes);
      expect(after.mmapSizeBytes).toBeLessThanOrEqual(SQLITE_COLD_START_TUNING.mmapSizeBytes);
      expect(after).toMatchObject({
        cacheSizeKib: -SQLITE_COLD_START_TUNING.cacheSizeKib,
        tempStore: 2,
      });
    } finally {
      tuned.close();
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
