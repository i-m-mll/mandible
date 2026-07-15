import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CURRENT_SCHEMA_VERSION, migrate, openDb, type Db } from "../src/db.js";

let tempDir = "";
let db: Db;

type ColumnInfo = {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
};

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-db-v103-"));
  db = openDb(path.join(tempDir, "mandible.db"));
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function columns(): Map<string, ColumnInfo> {
  return new Map(
    (db.prepare("PRAGMA table_info(conversation_ingest_state)").all() as ColumnInfo[])
      .map((column) => [column.name, column]),
  );
}

function rewindToV102(): void {
  db.prepare("UPDATE meta SET value = '102' WHERE key = 'schema_version'").run();
}

function dropEmptySourceColumns(): void {
  db.exec("ALTER TABLE conversation_ingest_state DROP COLUMN empty_source_size");
  db.exec("ALTER TABLE conversation_ingest_state DROP COLUMN empty_source_mtime");
}

describe("migration v103: empty conversation ingest state", () => {
  it("adds both fingerprint columns to the v102 schema", () => {
    dropEmptySourceColumns();
    rewindToV102();

    migrate(db);

    expect(columns().get("empty_source_mtime")).toMatchObject({
      type: "REAL",
      notnull: 0,
      dflt_value: null,
    });
    expect(columns().get("empty_source_size")).toMatchObject({
      type: "INTEGER",
      notnull: 0,
      dflt_value: null,
    });
    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toMatchObject({
      value: String(CURRENT_SCHEMA_VERSION),
    });
  });

  it("replays cleanly when current columns already exist", () => {
    rewindToV102();

    expect(() => migrate(db)).not.toThrow();
    expect(() => migrate(db)).not.toThrow();
    expect(columns().has("empty_source_mtime")).toBe(true);
    expect(columns().has("empty_source_size")).toBe(true);
  });

  it("rejects a partially applied one-column schema", () => {
    db.exec("ALTER TABLE conversation_ingest_state DROP COLUMN empty_source_size");
    rewindToV102();

    expect(() => migrate(db)).toThrow(/migration 103 precondition:.*both empty-source columns/i);
    expect(columns().has("empty_source_mtime")).toBe(true);
    expect(columns().has("empty_source_size")).toBe(false);
    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toMatchObject({
      value: "102",
    });
  });

  it("rejects same-named columns with divergent definitions", () => {
    dropEmptySourceColumns();
    db.exec("ALTER TABLE conversation_ingest_state ADD COLUMN empty_source_mtime TEXT");
    db.exec("ALTER TABLE conversation_ingest_state ADD COLUMN empty_source_size INTEGER");
    rewindToV102();

    expect(() => migrate(db)).toThrow(/migration 103 verification:.*empty_source_mtime/i);
    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toMatchObject({
      value: "102",
    });
  });
});
