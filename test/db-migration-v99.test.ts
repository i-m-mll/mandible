import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CURRENT_SCHEMA_VERSION, assertMigrationSequence, openDb, type Db } from "../src/db.js";

let tempDir = "";
let db: Db;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-db-v99-"));
  db = openDb(path.join(tempDir, "mandible.db"));
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function columns(table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .map((column) => column.name),
  );
}

function indexNames(table: string): Set<string> {
  return new Set(
    (db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL")
      .all(table) as Array<{ name: string }>)
      .map((row) => row.name),
  );
}

describe("migration v99: workflow ingest state", () => {
  it("creates a workflow artifact mtime cursor table", () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(99);
    expect(() => assertMigrationSequence()).not.toThrow();
    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toMatchObject({
      value: String(CURRENT_SCHEMA_VERSION),
    });

    expect(columns("workflow_ingest_state")).toEqual(new Set([
      "file_path",
      "source_mtime",
      "summary_path",
      "workflow_id",
      "updated_at",
    ]));
    expect(indexNames("workflow_ingest_state")).toContain("idx_workflow_ingest_state_updated");
    expect(indexNames("workflow_ingest_state")).toContain("idx_workflow_ingest_state_summary");
  });
});
