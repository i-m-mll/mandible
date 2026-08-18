import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { CURRENT_SCHEMA_VERSION, migrate } from "../src/db.js";

describe("migration v133 feedback collection expiry", () => {
  it("adds recurring expiry without copying ask expiry and makes ask expiry nullable", () => {
    const db = new Database(":memory:");
    try {
      migrate(db);
      db.exec(`
        INSERT INTO users (id, slug, kind, display_name, status, created_at, updated_at)
        VALUES ('agent', 'agent-v132', 'agent', 'Agent', 'active', 1, 1);
        INSERT INTO sessions (id, app, status, owner_user_id)
        VALUES ('session', 'codex', 'active', 'agent');
        INSERT INTO feedback_collections
          (id, kind, interaction_mode, source, expires_at, created_at, tombstoned_at)
        VALUES ('ask', 'bounded_ask', 'explicit_submit', NULL, NULL, 1000, NULL);
        INSERT INTO feedback_ask_sessions
          (collection_id, requester_user_id, requester_session_id, request_key, request_digest,
           responder_user_ids_json, expires_at, retention_expires_at, created_at)
        VALUES ('ask', 'agent', 'session', 'key', 'digest', '[]', 9000, NULL, 1000);
        DROP INDEX idx_feedback_ask_sessions_requester;
        DROP INDEX idx_feedback_ask_sessions_expiry;
        ALTER TABLE feedback_ask_sessions RENAME TO feedback_ask_sessions_v132;
        CREATE TABLE feedback_ask_sessions (
          collection_id TEXT PRIMARY KEY REFERENCES feedback_collections(id) ON DELETE RESTRICT,
          requester_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
          requester_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
          request_key TEXT NOT NULL CHECK(trim(request_key) != ''),
          request_digest TEXT NOT NULL CHECK(trim(request_digest) != ''),
          responder_user_ids_json TEXT NOT NULL
            CHECK(json_valid(responder_user_ids_json)
              AND json_type(responder_user_ids_json) = 'array'),
          expires_at INTEGER NOT NULL,
          retention_expires_at INTEGER,
          created_at INTEGER NOT NULL,
          UNIQUE(requester_user_id, requester_session_id, request_key),
          CHECK(expires_at > created_at),
          CHECK(retention_expires_at IS NULL OR retention_expires_at >= expires_at)
        );
        INSERT INTO feedback_ask_sessions
        SELECT * FROM feedback_ask_sessions_v132;
        DROP TABLE feedback_ask_sessions_v132;
        CREATE INDEX idx_feedback_ask_sessions_requester
          ON feedback_ask_sessions(requester_user_id, requester_session_id, created_at DESC);
        CREATE INDEX idx_feedback_ask_sessions_expiry
          ON feedback_ask_sessions(expires_at);
        DROP INDEX idx_feedback_collections_expiry;
        ALTER TABLE feedback_collections DROP COLUMN expires_at;
        UPDATE meta SET value = '131' WHERE key = 'schema_version';
      `);

      expect(() => migrate(db)).not.toThrow();
      expect(CURRENT_SCHEMA_VERSION).toBe(141);
      expect(db.prepare("SELECT expires_at FROM feedback_collections WHERE id = 'ask'").get())
        .toEqual({ expires_at: null });
      expect(db.prepare("SELECT expires_at FROM feedback_ask_sessions WHERE collection_id = 'ask'").get())
        .toEqual({ expires_at: 9000 });
      const askExpiryColumn = (db.prepare("PRAGMA table_info(feedback_ask_sessions)").all() as
        Array<{ name: string; notnull: number }>).find((column) => column.name === "expires_at");
      expect(askExpiryColumn?.notnull).toBe(0);
      expect(() => db.prepare(
        "UPDATE feedback_ask_sessions SET expires_at = NULL WHERE collection_id = 'ask'",
      ).run()).not.toThrow();
      expect(db.prepare("SELECT expires_at FROM feedback_collections WHERE id = 'ask'").get())
        .toEqual({ expires_at: null });
      expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get())
        .toEqual({ value: "141" });
      expect(db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_feedback_collections_expiry'",
      ).get()).toEqual({ name: "idx_feedback_collections_expiry" });
    } finally {
      db.close();
    }
  });

  it("rebuilds ask sessions despite a pre-existing unrelated foreign key violation", () => {
    // The ask-session rebuild verified the whole database rather than the
    // table it rebuilt, so three orphaned `console_session_usage` rows — left
    // behind before that foreign key was declared, and untouched here — made
    // the daemon unstartable on every restart. See issue 1a6c674.
    const db = new Database(":memory:");
    try {
      migrate(db);
      db.pragma("foreign_keys = OFF");
      db.exec(`
        INSERT INTO console_session_usage (id, console_session_id, recorded_at)
        VALUES ('usage-orphan', 'session-that-no-longer-exists', 10);
        UPDATE meta SET value = '132' WHERE key = 'schema_version';
      `);

      expect(() => migrate(db)).not.toThrow();

      expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get())
        .toEqual({ value: String(CURRENT_SCHEMA_VERSION) });
      // Left exactly as found: not repaired, not deleted, not a reason to refuse
      // to start. Repairing it is the operator's decision, not a migration's.
      expect(db.prepare(
        "SELECT count(*) AS n FROM console_session_usage WHERE id = 'usage-orphan'",
      ).get()).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  });
});
