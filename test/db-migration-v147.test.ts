import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { BASELINE_SCHEMA_VERSION } from "../src/db-baseline.js";
import { CURRENT_SCHEMA_VERSION, migrate } from "../src/db.js";

const IDENTITY_COLUMNS = ["filesystem_device", "filesystem_inode", "filesystem_ctime_ns"];

describe("migration v147: lossless conversation source filesystem identity", () => {
  it("keeps the fresh baseline and migration head converged", () => {
    const db = new Database(":memory:");
    migrate(db);
    expect(BASELINE_SCHEMA_VERSION).toBe(148);
    expect(CURRENT_SCHEMA_VERSION).toBe(148);
    const columns = db.prepare("PRAGMA table_info(conversation_source_versions)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    for (const name of IDENTITY_COLUMNS) {
      expect(columns.find((column) => column.name === name)).toMatchObject({
        type: "TEXT",
        notnull: 0,
        dflt_value: null,
      });
    }
    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: "148" });
    db.close();
  });

  it("upgrades v146 idempotently without inventing identity for existing versions", () => {
    const db = new Database(":memory:");
    migrate(db);
    db.exec(`
      ALTER TABLE conversation_source_versions DROP COLUMN filesystem_ctime_ns;
      ALTER TABLE conversation_source_versions DROP COLUMN filesystem_inode;
      ALTER TABLE conversation_source_versions DROP COLUMN filesystem_device;
      INSERT INTO conversations (
        id, source, source_path, source_hash, source_mtime, title, started_at,
        session_id, created_at, updated_at, block_count, tags
      ) VALUES (
        'legacy-conversation', 'codex', '/tmp/legacy.jsonl', '${"a".repeat(64)}', 1,
        'Legacy', '2026-08-19T00:00:00Z', 'legacy-session', datetime('now'), datetime('now'), 0, '[]'
      );
      INSERT INTO conversation_sources (
        id, conversation_id, provider, native_session_id, parser_format, parser_version,
        normalization_version, redaction_epoch, availability, custody_state,
        current_version_id, created_at, updated_at
      ) VALUES (
        'legacy-source', 'legacy-conversation', 'codex', 'legacy-session', 'provider-jsonl', '1',
        '1', 0, 'available', 'provider', NULL, 1, 1
      );
      INSERT INTO conversation_source_versions (
        id, source_id, content_sha256, byte_length, file_mtime_ms, generation,
        parser_format, parser_version, normalization_version, redaction_epoch,
        availability, custody_state, verification_json, created_at
      ) VALUES (
        'legacy-version', 'legacy-source', '${"a".repeat(64)}', 1, 1, 'sealed_sha256',
        'provider-jsonl', '1', '1', 0, 'available', 'provider', '{}', 1
      );
      UPDATE conversation_sources SET current_version_id = 'legacy-version' WHERE id = 'legacy-source';
      UPDATE meta SET value = '146' WHERE key = 'schema_version';
    `);

    migrate(db);
    expect(db.prepare(`
      SELECT filesystem_device, filesystem_inode, filesystem_ctime_ns
        FROM conversation_source_versions WHERE id = 'legacy-version'
    `).get()).toEqual({
      filesystem_device: null,
      filesystem_inode: null,
      filesystem_ctime_ns: null,
    });
    db.prepare("UPDATE meta SET value = '146' WHERE key = 'schema_version'").run();
    expect(() => migrate(db)).not.toThrow();
    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: "148" });
    expect(db.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    db.close();
  });
});
