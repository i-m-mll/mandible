import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CURRENT_SCHEMA_VERSION, assertMigrationSequence, openDb, type Db } from "../src/db.js";

let tempDir = "";
let db: Db;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-db-v100-"));
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

describe("migration v100: daemon_log", () => {
  it("creates the structured daemon log table and rotation settings", () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(100);
    expect(() => assertMigrationSequence()).not.toThrow();

    expect(columns("daemon_log")).toEqual(new Set([
      "id",
      "ts",
      "level",
      "event",
      "subsystem",
      "fields_json",
      "issue_id",
      "auth_request_id",
      "artifact_id",
      "session_id",
      "repo_id",
    ]));

    const indexes = indexNames("daemon_log");
    expect(indexes).toContain("idx_daemon_log_ts");
    expect(indexes).toContain("idx_daemon_log_facets");
    expect(indexes).toContain("idx_daemon_log_issue");
    expect(indexes).toContain("idx_daemon_log_auth_request");
    expect(indexes).toContain("idx_daemon_log_artifact");
    expect(indexes).toContain("idx_daemon_log_session");
    expect(indexes).toContain("idx_daemon_log_repo");

    const settings = new Map(
      (db
        .prepare("SELECT key, value FROM settings WHERE key LIKE 'stderr_rotation_%'")
        .all() as Array<{ key: string; value: string }>)
        .map((row) => [row.key, row.value]),
    );
    expect(Number(settings.get("stderr_rotation_max_bytes"))).toBeGreaterThan(0);
    expect(Number(settings.get("stderr_rotation_keep_segments"))).toBeGreaterThan(0);
  });
});
