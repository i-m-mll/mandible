import SqliteDatabase from "../src/sqlite.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrate, type Db } from "../src/db.js";
import { CURRENT_SCHEMA_VERSION } from "../src/db-migrations.js";
import { addProject } from "../src/ledger/project-registry.js";
import { LedgerStore } from "../src/ledger/store.js";
import { SYSTEM_ACTOR } from "./helpers/ledger-fixtures.js";

// Issue 2043af5 — migration v204 moves every session-to-issue link to the
// provider session key, retires the on-demand `codex-<thread>` rows, and makes
// `ledger_session_issue_links` the only link table.

const THREAD = "01a072f2-0e05-7a91-abcd-df4dc6a64e62";
const CLAUDE = "4be0c2a1-6b44-4a43-9d2e-0d6f1c9a7e21";

let db: Db;

/** Put a head database back into the v203 link shape. */
function rewindToV203(): void {
  db.exec(`
    DROP TABLE ledger_session_issue_links;
    CREATE TABLE ledger_session_issue_links (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      issue_id TEXT NOT NULL REFERENCES ledger_issues(id) ON DELETE RESTRICT,
      link_type TEXT NOT NULL DEFAULT 'worked_on',
      source TEXT NOT NULL DEFAULT 'system',
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY (session_id, issue_id, link_type)
    );
    CREATE INDEX idx_ledger_session_issue_issue ON ledger_session_issue_links(issue_id);
    CREATE TABLE session_issues (
      session_id TEXT NOT NULL, issue_id TEXT NOT NULL, repo_id TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, issue_id, repo_id)
    );
    CREATE TABLE session_projects (
      session_id TEXT NOT NULL, repo_id TEXT NOT NULL, repo_name TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, repo_id)
    );
    DROP INDEX idx_conv_declared_parent;
    ALTER TABLE conversations DROP COLUMN parent_session_id;
    ALTER TABLE conversations DROP COLUMN parent_source;
    ALTER TABLE conversations DROP COLUMN opening_lineage;
    ALTER TABLE conversations DROP COLUMN opening_line;
    ALTER TABLE conversations DROP COLUMN agent_created;
    UPDATE meta SET value = '203' WHERE key = 'schema_version';
  `);
}

beforeEach(() => {
  db = new SqliteDatabase(":memory:") as Db;
  migrate(db);
});

afterEach(() => {
  db.close();
});

describe("migration v204 session issue links", () => {
  it("rekeys links, deletes provider projection rows, and carries resolvable legacy links", () => {
    const project = addProject(db, { project_key: "mandible", display_name: "Mandible" });
    const store = new LedgerStore(db);
    const first = store.createIssue({ ...SYSTEM_ACTOR, project_id: project.id, title: "First" });
    const second = store.createIssue({ ...SYSTEM_ACTOR, project_id: project.id, title: "Second" });
    rewindToV203();

    const insertSession = db.prepare(
      "INSERT INTO sessions (id, app, status, agent_type, conversation_id) VALUES (?, ?, 'ended', ?, ?)",
    );
    insertSession.run(`codex-${THREAD}`, "codex", "provider-session", THREAD);
    insertSession.run("wrap-1", "claude", null, CLAUDE);
    insertSession.run("hook-1", "claude", null, null);
    const insertLink = db.prepare(
      "INSERT INTO ledger_session_issue_links (session_id, issue_id, created_at) VALUES (?, ?, 1)",
    );
    insertLink.run(`codex-${THREAD}`, first.id);
    insertLink.run("wrap-1", first.id);
    insertLink.run("hook-1", first.id);
    const insertLegacy = db.prepare(
      "INSERT INTO session_issues (session_id, issue_id, repo_id, created_at) VALUES (?, ?, 'mandible', 2)",
    );
    insertLegacy.run("wrap-1", second.id.slice(0, 7));
    insertLegacy.run("wrap-1", "0000000");

    migrate(db);

    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get())
      .toEqual({ value: String(CURRENT_SCHEMA_VERSION) });
    expect(db.prepare("SELECT session_id, issue_id FROM ledger_session_issue_links ORDER BY session_id, issue_id").all())
      .toEqual([
        { session_id: THREAD, issue_id: first.id },
        { session_id: CLAUDE, issue_id: first.id },
        { session_id: CLAUDE, issue_id: second.id },
        { session_id: "hook-1", issue_id: first.id },
      ].sort((a, b) => a.session_id.localeCompare(b.session_id) || a.issue_id.localeCompare(b.issue_id)));
    expect(db.prepare("SELECT id FROM sessions ORDER BY id").all())
      .toEqual([{ id: "hook-1" }, { id: "wrap-1" }]);
    expect(db.prepare(
      "SELECT name FROM sqlite_master WHERE name IN ('session_issues', 'session_projects')",
    ).all()).toEqual([]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });
});
