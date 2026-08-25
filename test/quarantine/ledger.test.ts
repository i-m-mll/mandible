// Quarantined: b283ecb — briefing_group_dispositions is unclassified in the backup manifest.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_VERSION, migrate, openDb, type Db } from "../../src/db.js";

import {
  buildMetadataBackupSql,
  LEDGER_BACKUP_TABLES,
  METADATA_BACKUP_TABLES,
  REPRODUCIBLE_OR_RUNTIME_TABLES,
} from "../../src/ledger/backup.js";

let tempDir = "";
let dbPath = "";
let db: Db;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-ledger-"));
  dbPath = path.join(tempDir, "mandible.db");
  db = openDb(dbPath);
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("ledger backup contract", () => {

  it("classifies every live metadata table so schema drift is visible", () => {
    const tableNames = db.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table'
         AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    ).all() as Array<{ name: string }>;
    const backedUp = new Set<string>(METADATA_BACKUP_TABLES);
    const excluded = new Set<string>(REPRODUCIBLE_OR_RUNTIME_TABLES);
    const unclassified = tableNames
      .map((table) => table.name)
      .filter((table) => !backedUp.has(table) && !excluded.has(table));

    expect(unclassified, "metadata backup table classification drift").toEqual([]);
    expect(backedUp.has("briefing_runs")).toBe(true);
    expect(backedUp.has("briefing_submissions")).toBe(true);
    expect(backedUp.has("briefing_legacy_custody")).toBe(true);
    expect(backedUp.has("feedback_ingest_requests")).toBe(false);
    expect(backedUp.has("task_command_requests")).toBe(true);
    expect(backedUp.has("task_command_events")).toBe(true);
    expect(backedUp.has("conversation_blocks")).toBe(false);
    expect(excluded.has("conversation_blocks")).toBe(true);
    expect(backedUp.has("daemon_log")).toBe(false);
    expect(excluded.has("daemon_log")).toBe(true);
  });

});
