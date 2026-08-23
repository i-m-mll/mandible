import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { ConversationSourceStore } from "../src/conversations/source-store.js";
import { CURRENT_CONVERSATION_SOURCE_EPOCHS } from "../src/conversations/source-types.js";
import { BASELINE_SCHEMA_VERSION } from "../src/db-baseline.js";
import { migrate } from "../src/db.js";

describe("migration v140: versioned conversation sources", () => {
  it("installs the additive durable schema and backfills legacy block aliases without deleting bodies", () => {
    const db = new Database(":memory:");
    migrate(db);
    expect(BASELINE_SCHEMA_VERSION).toBe(152);
    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: "152" });
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

  it("backfills a populated v139 database and upgrades its source snapshot", async () => {
    const db = new Database(":memory:");
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-v140-source-"));
    const sourcePath = path.join(
      tempRoot,
      ".codex/sessions/2026/08/17/rollout-legacy.jsonl",
    );
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    const sourceBytes = '{"type":"session_meta"}\n';
    fs.writeFileSync(sourcePath, sourceBytes);
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
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
        timestamp, parent_id, metadata_json, dag_uuid, dag_parent_uuid
      ) VALUES (
        'legacy-block-id', 'legacy-conversation', 'assistant_message', 'assistant',
        'preserved body', 0, 0, '2026-08-17T00:00:01Z', NULL, '{}', 'dag-0', NULL
      ), (
        'legacy-tool-id', 'legacy-conversation', 'tool_use', 'assistant',
        'tool', 0, 1, '2026-08-17T00:00:02Z', NULL, '{}', 'dag-1', 'dag-0'
      ), (
        'legacy-result-id', 'legacy-conversation', 'tool_result', 'user',
        'result', 0, 2, '2026-08-17T00:00:03Z', '1', '{}', 'dag-2', 'dag-1'
      );
    `);
    db.prepare("UPDATE conversations SET source_hash = ? WHERE id = 'legacy-conversation'")
      .run(sourceHash);

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
      content_sha256: sourceHash,
      generation: "legacy_hash",
      availability: "unchecked",
    });

    await new ConversationSourceStore(db).recordConversation({
      conversationId: "legacy-conversation",
      provider: "codex",
      nativeSessionId: "duplicate-session",
      filePath: sourcePath,
      ...CURRENT_CONVERSATION_SOURCE_EPOCHS,
    });
    expect(db.prepare(`
      SELECT v.generation, v.availability
        FROM conversation_sources s
        JOIN conversation_source_versions v ON v.id = s.current_version_id
       WHERE s.conversation_id = 'legacy-conversation'
    `).get()).toEqual({ generation: "sealed_sha256", availability: "available" });
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
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
