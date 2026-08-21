import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { migrate } from "../src/db.js";

describe("migration v148: source-backed conversation payload state", () => {
  it("adds a legacy default without changing existing payload bytes", () => {
    const db = new Database(":memory:");
    migrate(db);
    db.prepare(`
      INSERT INTO conversations (
        id, source, source_path, source_hash, source_mtime, title, started_at,
        block_count, session_id, tags, created_at, updated_at
      ) VALUES ('conv', 'codex', '/tmp/source', 'hash', 1, 'title', 'now', 1,
                'session', '[]', 'now', 'now')
    `).run();
    db.prepare(`
      INSERT INTO conversation_blocks (
        id, conversation_id, type, role, content, position, metadata_json
      ) VALUES ('block', 'conv', 'assistant_message', 'assistant', 'kept', 0, '{"kept":true}')
    `).run();
    db.exec("ALTER TABLE conversation_blocks DROP COLUMN payload_state");
    db.prepare("UPDATE meta SET value = '147' WHERE key = 'schema_version'").run();

    migrate(db);

    expect(db.prepare(`
      SELECT content, metadata_json, payload_state FROM conversation_blocks WHERE id = 'block'
    `).get()).toEqual({ content: "kept", metadata_json: '{"kept":true}', payload_state: "legacy" });
    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get())
      .toEqual({ value: "148" });
    db.close();
  });

  it("converges when the column already exists below the recorded head", () => {
    const db = new Database(":memory:");
    migrate(db);
    db.prepare("UPDATE meta SET value = '147' WHERE key = 'schema_version'").run();
    expect(() => migrate(db)).not.toThrow();
    const columns = db.pragma("table_info(conversation_blocks)") as Array<{ name: string }>;
    expect(columns.filter((column) => column.name === "payload_state")).toHaveLength(1);
    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get())
      .toEqual({ value: "148" });
    db.close();
  });

  it("rejects a replayed column that omits the payload-state CHECK constraint", () => {
    const db = new Database(":memory:");
    migrate(db);
    const canonicalSql = (db.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'conversation_blocks'
    `).get() as { sql: string }).sql;
    const withoutCheck = canonicalSql.replace(
      /\s+CHECK\s*\(\s*payload_state\s+IN\s*\(\s*'legacy'\s*,\s*'source'\s*\)\s*\)/i,
      "",
    );
    expect(withoutCheck).not.toBe(canonicalSql);
    db.exec(`
      ALTER TABLE conversation_blocks RENAME TO conversation_blocks_v148;
      ${withoutCheck};
      INSERT INTO conversation_blocks SELECT * FROM conversation_blocks_v148;
      DROP TABLE conversation_blocks_v148;
    `);
    const column = (db.pragma("table_info(conversation_blocks)") as Array<{
      name: string; type: string; notnull: number; dflt_value: string | null;
    }>).find((entry) => entry.name === "payload_state");
    expect(column).toMatchObject({ type: "TEXT", notnull: 1, dflt_value: "'legacy'" });
    db.prepare("UPDATE meta SET value = '147' WHERE key = 'schema_version'").run();

    expect(() => migrate(db)).toThrow(
      "migration 148 verification: conversation_blocks.payload_state diverges",
    );
    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get())
      .toEqual({ value: "147" });
    db.close();
  });
});
