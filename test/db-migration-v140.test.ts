import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { BASELINE_SCHEMA_VERSION } from "../src/db-baseline.js";
import { migrate } from "../src/db.js";

describe("migration v140: versioned conversation sources", () => {
  it("installs the additive durable schema and backfills legacy block aliases without deleting bodies", () => {
    const db = new Database(":memory:");
    migrate(db);
    expect(BASELINE_SCHEMA_VERSION).toBe(140);
    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: "140" });
    for (const table of [
      "conversation_sources",
      "conversation_source_aliases",
      "conversation_source_versions",
      "conversation_normalization_checkpoints",
      "conversation_structural_blocks",
      "conversation_block_aliases",
    ]) {
      expect(db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table)).toEqual({ present: 1 });
    }
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    db.close();
  });

  it("backfills a populated v139 database while preserving the legacy body", () => {
    const db = new Database(":memory:");
    migrate(db);
    db.exec(`
      DROP TABLE conversation_block_aliases;
      DROP TABLE conversation_structural_blocks;
      DROP TABLE conversation_normalization_checkpoints;
      DROP TABLE conversation_source_versions;
      DROP TABLE conversation_source_aliases;
      DROP TABLE conversation_sources;
      UPDATE meta SET value = '139' WHERE key = 'schema_version';
      INSERT INTO conversations (
        id, source, source_path, source_hash, source_mtime, title, started_at,
        block_count, session_id, tags, created_at, updated_at
      ) VALUES (
        'legacy-conversation', 'codex', '/tmp/legacy.jsonl', 'append:10:tail', 10,
        'Legacy', '2026-08-17T00:00:00Z', 1, 'duplicate-session', '[]',
        datetime('now'), datetime('now')
      );
      INSERT INTO conversation_blocks (
        id, conversation_id, type, role, content, compressed, position,
        timestamp, parent_id, metadata_json
      ) VALUES (
        'legacy-block-id', 'legacy-conversation', 'assistant_message', 'assistant',
        'preserved body', 0, 0, '2026-08-17T00:00:01Z', NULL, '{}'
      );
    `);

    migrate(db);

    expect(db.prepare("SELECT content FROM conversation_blocks WHERE id = 'legacy-block-id'").get())
      .toEqual({ content: "preserved body" });
    expect(db.prepare(`
      SELECT a.alias, b.conversation_id, b.status, b.source_version_id
        FROM conversation_block_aliases a
        JOIN conversation_structural_blocks b ON b.id = a.block_id
       WHERE a.alias = 'legacy-block-id'
    `).get()).toEqual({
      alias: "legacy-block-id",
      conversation_id: "legacy-conversation",
      status: "current",
      source_version_id: null,
    });
    expect(db.prepare(`
      SELECT content_sha256, generation, availability
        FROM conversation_source_versions
       WHERE source_id = 'legacy-source:legacy-conversation'
    `).get()).toEqual({
      content_sha256: "append:10:tail",
      generation: "legacy_hash",
      availability: "unchecked",
    });
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });

  it("fails closed on a rewound but divergent source schema", () => {
    const db = new Database(":memory:");
    migrate(db);
    db.exec(`
      DROP INDEX idx_conversation_structural_blocks_version;
      UPDATE meta SET value = '139' WHERE key = 'schema_version';
    `);
    expect(() => migrate(db)).toThrow(
      "migration 140 precondition: required index idx_conversation_structural_blocks_version is missing",
    );
    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: "139" });
    db.close();
  });
});
