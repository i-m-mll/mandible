import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compressContent } from "./compression.js";
import { createStableEventId, isSha256Hex } from "./ledger/ids.js";
import { backfillProjectKeys } from "./ledger/project-registry.js";
import { backfillOrphanArtifactSeries } from "./provider-artifacts.js";

export type Db = Database.Database;

const DEFAULT_CACHE_DIR = path.join(os.homedir(), ".cache", "mandible");
const DEFAULT_DB_PATH = path.join(DEFAULT_CACHE_DIR, "mandible.db");
const SCHEMA_VERSION_KEY = "schema_version";

export interface Migration {
  version: number;
  name: string;
  statements: string[];
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "init",
    statements: [
      `CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS sessions (
        id            TEXT PRIMARY KEY,
        app           TEXT NOT NULL,
        parent_id     TEXT REFERENCES sessions(id) ON DELETE CASCADE,
        status        TEXT NOT NULL DEFAULT 'active',
        pid           INTEGER,
        pid_start     TEXT,
        cwd           TEXT,
        branch        TEXT,
        worktree      TEXT,
        task          TEXT,
        terminal      TEXT,
        multiplexer   TEXT,
        nav_session   TEXT,
        nav_tab       TEXT,
        nav_pane_id   TEXT,
        nav_extra     TEXT,
        agent_type    TEXT,
        description   TEXT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        ended_at      TEXT,
        updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE INDEX IF NOT EXISTS sessions_parent_idx ON sessions(parent_id)`,
      `CREATE INDEX IF NOT EXISTS sessions_status_idx ON sessions(status)`,
      `CREATE INDEX IF NOT EXISTS sessions_app_idx ON sessions(app)`,
      `CREATE TABLE IF NOT EXISTS auth_requests (
        id            TEXT PRIMARY KEY,
        session_id    TEXT,
        command       TEXT NOT NULL,
        title         TEXT NOT NULL,
        cwd           TEXT,
        diff_summary  TEXT,
        spec_content  TEXT,
        status        TEXT NOT NULL DEFAULT 'pending',
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        approved_at   INTEGER,
        resolved_at   INTEGER,
        skipped_at    INTEGER,
        expires_at    INTEGER NOT NULL,
        exit_code     INTEGER,
        output        TEXT NOT NULL DEFAULT '',
        error         TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_auth_requests_status_created
        ON auth_requests(status, created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_auth_requests_queue
        ON auth_requests(status, skipped_at, created_at)`,
      `CREATE TABLE IF NOT EXISTS branches (
        repo_root     TEXT NOT NULL,
        branch        TEXT NOT NULL,
        is_current    INTEGER NOT NULL DEFAULT 0,
        is_worktree   INTEGER DEFAULT 0,
        worktree_path TEXT,
        is_dirty      INTEGER DEFAULT 0,
        ahead         INTEGER DEFAULT 0,
        behind        INTEGER DEFAULT 0,
        last_commit_hash    TEXT,
        last_commit_message TEXT,
        last_commit_author  TEXT,
        last_commit_date    TEXT,
        diff_stat     TEXT,
        updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (repo_root, branch)
      )`
    ]
  },
  {
    version: 2,
    name: "session_nav_metadata_status",
    statements: [
      `ALTER TABLE sessions ADD COLUMN nav_metadata_status TEXT NOT NULL DEFAULT 'not_applicable'`,
      `ALTER TABLE sessions ADD COLUMN nav_metadata_attempts INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE sessions ADD COLUMN nav_metadata_last_error TEXT`,
      `ALTER TABLE sessions ADD COLUMN nav_metadata_last_attempt_at TEXT`,
      `ALTER TABLE sessions ADD COLUMN nav_metadata_next_retry_at TEXT`,
      `CREATE INDEX IF NOT EXISTS sessions_nav_metadata_idx
        ON sessions(nav_metadata_status, nav_metadata_next_retry_at)`
    ]
  },
  {
    version: 3,
    name: "auth_request_git_context",
    statements: [
      `ALTER TABLE auth_requests ADD COLUMN repo TEXT`,
      `ALTER TABLE auth_requests ADD COLUMN base_branch TEXT`,
      `ALTER TABLE auth_requests ADD COLUMN head_branch TEXT`,
      `ALTER TABLE auth_requests ADD COLUMN files_changed INTEGER DEFAULT 0`,
      `ALTER TABLE auth_requests ADD COLUMN additions INTEGER DEFAULT 0`,
      `ALTER TABLE auth_requests ADD COLUMN deletions INTEGER DEFAULT 0`,
      `ALTER TABLE auth_requests ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'daemon'`
    ]
  },
  {
    version: 4,
    name: "auth_request_commit_message",
    statements: [
      `ALTER TABLE auth_requests ADD COLUMN commit_message TEXT`
    ]
  },
  {
    version: 5,
    name: "auth_request_execution_tracking",
    statements: [
      `ALTER TABLE auth_requests ADD COLUMN last_executed_at INTEGER`
    ]
  },
  {
    version: 6,
    name: "cleanup_stuck_approved",
    statements: [
      `UPDATE auth_requests SET status = 'dismissed', resolved_at = CAST(strftime('%s','now') * 1000 AS INTEGER), error = 'Cleaned up: stuck in approved state (pre-cwd-fix orphan)' WHERE status = 'approved' AND exit_code IS NULL AND created_at < CAST((strftime('%s','now') - 86400) * 1000 AS INTEGER)`
    ]
  },
  {
    version: 7,
    name: "session_issues",
    statements: [
      `CREATE TABLE IF NOT EXISTS session_issues (
        session_id  TEXT NOT NULL,
        issue_id    TEXT NOT NULL,
        repo_id     TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        PRIMARY KEY (session_id, issue_id, repo_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_session_issues_session
        ON session_issues(session_id)`,
      `CREATE INDEX IF NOT EXISTS idx_session_issues_issue
        ON session_issues(issue_id, repo_id)`,
    ],
  },
  {
    version: 8,
    name: "starred_chats",
    statements: [
      `CREATE TABLE IF NOT EXISTS starred_chats (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        label TEXT NOT NULL,
        notes TEXT,
        transcript_path TEXT,
        cwd TEXT,
        branch TEXT,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_starred_chats_created
        ON starred_chats(created_at)`
    ]
  },
  {
    version: 9,
    name: "session_continuation",
    statements: [
      `ALTER TABLE sessions ADD COLUMN continuation TEXT`,
      `ALTER TABLE sessions ADD COLUMN continuation_acked_by TEXT`
    ]
  },
  {
    version: 10,
    name: "auth_request_acknowledged_by",
    statements: [
      `ALTER TABLE auth_requests ADD COLUMN acknowledged_by TEXT`
    ]
  },
  {
    version: 11,
    name: "settings",
    statements: [
      `CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('protected_branches', 'main,develop', CAST(strftime('%s','now') * 1000 AS INTEGER))`
    ]
  },
  {
    version: 12,
    name: "branch_ahead_behind_default",
    statements: [
      `ALTER TABLE branches ADD COLUMN ahead_default INTEGER DEFAULT 0`,
      `ALTER TABLE branches ADD COLUMN behind_default INTEGER DEFAULT 0`,
      `ALTER TABLE branches ADD COLUMN default_branch TEXT DEFAULT ''`
    ]
  },
  {
    version: 13,
    name: "session_projects",
    statements: [
      `CREATE TABLE IF NOT EXISTS session_projects (
        session_id TEXT NOT NULL,
        repo_id TEXT NOT NULL,
        repo_name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, repo_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_session_projects_session
        ON session_projects(session_id)`
    ]
  },
  {
    version: 14,
    name: "setting_subagent_panes_default",
    statements: [
      `INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('subagent_panes_enabled', 'false', CAST(strftime('%s','now') * 1000 AS INTEGER))`
    ]
  },
  {
    version: 15,
    name: "settings_expansion_defaults",
    statements: [
      `INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('claude_notifications_enabled', 'true', CAST(strftime('%s','now') * 1000 AS INTEGER))`,
      `INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('codex_notifications_enabled', 'true', CAST(strftime('%s','now') * 1000 AS INTEGER))`,
      `INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('notification_sound', 'Blow', CAST(strftime('%s','now') * 1000 AS INTEGER))`,
      `INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('quiet_hours', '', CAST(strftime('%s','now') * 1000 AS INTEGER))`,
      `INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('pretool_hooks_enabled', 'true', CAST(strftime('%s','now') * 1000 AS INTEGER))`,
      `INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('log_retention_days', '7', CAST(strftime('%s','now') * 1000 AS INTEGER))`,
      `INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('theme', 'catppuccin-mocha', CAST(strftime('%s','now') * 1000 AS INTEGER))`,
      `INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('prompt', 'powerlevel10k', CAST(strftime('%s','now') * 1000 AS INTEGER))`,
      `INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('multiplexer', 'both', CAST(strftime('%s','now') * 1000 AS INTEGER))`,
    ]
  },
  {
    version: 16,
    name: "conversations",
    statements: [
      `CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL CHECK(source IN ('claude_code', 'codex', 'gemini')),
        source_path TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        source_mtime INTEGER NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        summary TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        block_count INTEGER NOT NULL DEFAULT 0,
        session_id TEXT NOT NULL,
        project_path TEXT,
        cwd TEXT,
        branch TEXT,
        model TEXT,
        cli_version TEXT,
        starred INTEGER NOT NULL DEFAULT 0,
        label TEXT,
        notes TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE INDEX IF NOT EXISTS idx_conv_source ON conversations(source)`,
      `CREATE INDEX IF NOT EXISTS idx_conv_started ON conversations(started_at)`,
      `CREATE INDEX IF NOT EXISTS idx_conv_starred ON conversations(starred) WHERE starred = 1`,
      `CREATE INDEX IF NOT EXISTS idx_conv_session ON conversations(session_id)`,
      `CREATE INDEX IF NOT EXISTS idx_conv_source_path ON conversations(source_path)`,
      `CREATE TABLE IF NOT EXISTS conversation_blocks (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        position INTEGER NOT NULL,
        timestamp TEXT,
        parent_id TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        dag_uuid TEXT,
        dag_parent_uuid TEXT,
        UNIQUE(conversation_id, position)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_blocks_conv ON conversation_blocks(conversation_id)`,
      `CREATE INDEX IF NOT EXISTS idx_blocks_type ON conversation_blocks(conversation_id, type)`,
      `CREATE INDEX IF NOT EXISTS idx_blocks_parent ON conversation_blocks(parent_id) WHERE parent_id IS NOT NULL`,
      // Migrate starred_chats data into conversations table
      `INSERT OR IGNORE INTO conversations (id, source, source_path, source_hash, source_mtime, title, summary, started_at, session_id, starred, label, notes, created_at, updated_at)
       SELECT 'migrated:' || id, 'claude_code', COALESCE(transcript_path, ''), '', 0,
              COALESCE(label, 'Starred Chat'), notes, created_at, COALESCE(session_id, id),
              1, label, notes, created_at, created_at
       FROM starred_chats`,
    ]
  },
  {
    version: 17,
    name: "setting_auto_close_issues_on_merge",
    statements: [
      `INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('auto_close_issues_on_merge', 'true', CAST(strftime('%s','now') * 1000 AS INTEGER))`
    ]
  },
  {
    version: 18,
    name: "conversation_parent_linkage",
    statements: [
      `ALTER TABLE conversations ADD COLUMN parent_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL`,
      `CREATE INDEX IF NOT EXISTS idx_conv_parent ON conversations(parent_conversation_id) WHERE parent_conversation_id IS NOT NULL`,
      // Backfill: link conversations whose session has a parent session that also has a conversation
      `UPDATE conversations SET parent_conversation_id = (
        SELECT c2.id FROM sessions s1
        JOIN sessions s2 ON s1.parent_id = s2.id
        JOIN conversations c2 ON c2.session_id = s2.id
        WHERE s1.id = conversations.session_id
        LIMIT 1
      ) WHERE parent_conversation_id IS NULL`,
    ]
  },
  {
    version: 19,
    name: "compress_conversation_blocks",
    statements: [
      // Bug: e5a945d — add compressed flag; data migration runs post-DDL
      `ALTER TABLE conversation_blocks ADD COLUMN compressed INTEGER NOT NULL DEFAULT 0`,
    ]
  },
  {
    version: 20,
    name: "session_pinned",
    statements: [
      // Bug: 568eca7 — pin visibility & actions for Agent Registry UI
      `ALTER TABLE sessions ADD COLUMN pinned INTEGER DEFAULT 0`,
    ]
  },
  {
    version: 21,
    name: "console_sessions",
    // Bug: e980dd8 — console tab PTY session management
    statements: [
      `CREATE TABLE IF NOT EXISTS console_sessions (
        id            TEXT PRIMARY KEY,
        label         TEXT NOT NULL,
        command       TEXT NOT NULL,
        args_json     TEXT NOT NULL DEFAULT '[]',
        cwd           TEXT,
        env_json      TEXT NOT NULL DEFAULT '{}',
        cols          INTEGER NOT NULL DEFAULT 120,
        rows          INTEGER NOT NULL DEFAULT 30,
        status        TEXT NOT NULL DEFAULT 'stopped',
        pid           INTEGER,
        exit_code     INTEGER,
        auto_restart  INTEGER NOT NULL DEFAULT 0,
        is_operator   INTEGER NOT NULL DEFAULT 0,
        interaction_mode TEXT NOT NULL DEFAULT 'both',
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        started_at    INTEGER,
        stopped_at    INTEGER
      )`,
      `CREATE INDEX IF NOT EXISTS idx_console_sessions_status
         ON console_sessions(status)`,
      `CREATE INDEX IF NOT EXISTS idx_console_sessions_operator
         ON console_sessions(is_operator) WHERE is_operator = 1`
    ]
  },
  {
    version: 22,
    name: "console_pinned_sessions_setting",
    // Bug: e980dd8 — console tab pinned sessions and operator session settings
    statements: [
      `INSERT OR IGNORE INTO settings (key, value, updated_at)
       VALUES ('console_pinned_sessions', '[]',
               CAST(strftime('%s','now') * 1000 AS INTEGER))`,
      `INSERT OR IGNORE INTO settings (key, value, updated_at)
       VALUES ('console_operator_session_id', '',
               CAST(strftime('%s','now') * 1000 AS INTEGER))`
    ]
  },
  {
    version: 23,
    name: "session_last_active",
    // Bug: e01653d — track real user activity time from JSONL transcript mtime
    statements: [
      `ALTER TABLE sessions ADD COLUMN last_active TEXT`
    ]
  },
  {
    version: 24,
    name: "backfill_session_projects_repo_name",
    // Bug: 003179f — agent-commit stored worktree dir names as repo_id.
    // Data fixup handled in post-DDL Node.js step below (backfillProjectRepoNames).
    statements: []
  },
  {
    version: 25,
    name: "backfill_session_projects_repo_name_v2",
    // Bug: 59492fd — v24 backfill used wrong join (s.worktree LIKE '%/worktrees/%')
    // but sessions store the repo root as cwd, not the worktree path. This v2
    // uses cwd to derive the repo name for rows whose repo_id still looks like a
    // branch name. All logic runs in the post-DDL Node.js step below.
    statements: []
  },
  {
    version: 26,
    name: "fix_session_projects_dotfile_names",
    statements: [],
  },
  {
    version: 27,
    name: "work_repos",
    statements: [
      `CREATE TABLE IF NOT EXISTS work_repos (
        id              TEXT NOT NULL,
        root            TEXT NOT NULL,
        name            TEXT NOT NULL,
        default_branch  TEXT NOT NULL DEFAULT '',
        dir_exists      INTEGER NOT NULL DEFAULT 1,
        excluded        INTEGER NOT NULL DEFAULT 0,
        user_modified   INTEGER NOT NULL DEFAULT 0,
        last_scanned_at TEXT,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (root)
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS work_repos_id_idx ON work_repos(id)`,
      `CREATE INDEX IF NOT EXISTS work_repos_excluded_idx ON work_repos(excluded)`
    ]
  },
  {
    version: 28,
    name: "issue_resolutions",
    // Bug: c934e60 — track which commits resolved which issues
    statements: [
      `CREATE TABLE IF NOT EXISTS issue_resolutions (
        issue_id    TEXT NOT NULL,
        commit_sha  TEXT NOT NULL,
        repo_id     TEXT NOT NULL,
        resolved_at INTEGER NOT NULL,
        PRIMARY KEY (issue_id, commit_sha)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_issue_resolutions_issue
        ON issue_resolutions(issue_id)`
    ]
  },
  {
    version: 29,
    name: "auth_request_metadata_enrichment",
    // Bug: 2bce9cb — post_merge_handoff for session context handoff
    // Bug: ba9687f — structured issue_ids extracted from Bug: trailers
    statements: [
      `ALTER TABLE auth_requests ADD COLUMN post_merge_handoff TEXT`,
      `ALTER TABLE auth_requests ADD COLUMN issue_ids TEXT`
    ]
  },
  {
    version: 30,
    name: "auth_request_depends_on",
    // Bug: 0b83252 — auth request dependency chain support
    statements: [
      `ALTER TABLE auth_requests ADD COLUMN depends_on_id TEXT`
    ]
  },
  {
    version: 31,
    name: "push_history_and_setting",
    // Bug: ea3102a — push/sync feature: history table + default setting
    statements: [
      `CREATE TABLE IF NOT EXISTS push_history (
        id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL,
        repo_root TEXT NOT NULL,
        scope TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('started','completed','failed')),
        result_json TEXT,
        started_at INTEGER NOT NULL,
        completed_at INTEGER
      )`,
      `CREATE INDEX IF NOT EXISTS idx_push_history_repo ON push_history(repo_id)`,
      `CREATE INDEX IF NOT EXISTS idx_push_history_status ON push_history(status)`,
      `INSERT OR IGNORE INTO settings (key, value, updated_at)
       VALUES ('push_same_name_upstream', 'true',
               CAST(strftime('%s','now') * 1000 AS INTEGER))`
    ]
  },
  {
    version: 32,
    name: "console_provider_session_id",
    // Bug: d947752 — persist provider-native conversation ids so live chat,
    // history, and debug terminal can target the same underlying session.
    statements: [
      `ALTER TABLE console_sessions ADD COLUMN provider_session_id TEXT`
    ]
  },
  {
    version: 33,
    name: "auth_requests_closes_issues",
    // Bug: 297677f — legacy close-on-merge issue IDs. New callers should use
    // issue_closures so reference-only auth links remain non-closing.
    statements: [
      `ALTER TABLE auth_requests ADD COLUMN issues TEXT`
    ]
  },
  {
    version: 34,
    name: "console_backend_metadata",
    statements: [
      `ALTER TABLE console_sessions ADD COLUMN backend_type TEXT NOT NULL DEFAULT 'pty'`,
      `ALTER TABLE console_sessions ADD COLUMN allowed_tools TEXT`,
      `ALTER TABLE console_sessions ADD COLUMN mandible_session_id TEXT`
    ]
  },
  {
    version: 35,
    name: "console_session_usage",
    statements: [
      `CREATE TABLE IF NOT EXISTS console_session_usage (
        id                            TEXT PRIMARY KEY,
        console_session_id            TEXT NOT NULL,
        provider_session_id           TEXT,
        recorded_at                   INTEGER NOT NULL,
        input_tokens                  INTEGER NOT NULL DEFAULT 0,
        cache_creation_input_tokens   INTEGER NOT NULL DEFAULT 0,
        cache_read_input_tokens       INTEGER NOT NULL DEFAULT 0,
        output_tokens                 INTEGER NOT NULL DEFAULT 0,
        web_search_requests           INTEGER NOT NULL DEFAULT 0,
        cost_usd                      REAL NOT NULL DEFAULT 0,
        total_cost_usd                REAL NOT NULL DEFAULT 0,
        duration_ms                   INTEGER NOT NULL DEFAULT 0,
        num_turns                     INTEGER NOT NULL DEFAULT 0,
        is_error                      INTEGER NOT NULL DEFAULT 0,
        result_subtype                TEXT,
        usage_json                    TEXT NOT NULL DEFAULT '{}',
        model_usage_json              TEXT NOT NULL DEFAULT '{}',
        errors_json                   TEXT NOT NULL DEFAULT '[]',
        FOREIGN KEY (console_session_id) REFERENCES console_sessions(id) ON DELETE CASCADE
      )`,
      `CREATE INDEX IF NOT EXISTS idx_console_session_usage_session
        ON console_session_usage(console_session_id, recorded_at DESC)`
    ]
  },
  {
    version: 36,
    name: "conversation_blocks_dag_uuid",
    // Bug: 72751b7 — DAG branching: track JSONL uuid/parentUuid on conversation blocks
    // Bug: 2411ee3 — migration 16 already creates these columns on fresh DBs.
    // Existing DBs still need the columns, so Node-side guarded DDL runs below.
    statements: []
  },
  {
    version: 37,
    name: "console_sessions_resume_at_message",
    // Bug: 40f0298 — DAG branching: track which message a resumed console session should start from
    statements: [
      `ALTER TABLE console_sessions ADD COLUMN resume_at_message TEXT`,
    ]
  },
  {
    version: 38,
    name: "work_units",
    // Bug: a247bc3 — work-unit tracking for inbox workqueue
    statements: [
      `CREATE TABLE IF NOT EXISTS work_units (
        id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL,
        repo_id TEXT NOT NULL,
        branch TEXT,
        parent_branch TEXT,
        kind TEXT NOT NULL DEFAULT 'solo',
        state TEXT NOT NULL DEFAULT 'open',
        assigned_session_id TEXT,
        provider TEXT,
        provider_session_id TEXT,
        continuation TEXT,
        continuation_by TEXT,
        continuation_at INTEGER,
        created_at INTEGER NOT NULL,
        activated_at INTEGER,
        last_commit_at INTEGER,
        resolved_at INTEGER,
        auth_request_id TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_work_units_repo_branch ON work_units(repo_id, branch)`,
      `CREATE INDEX IF NOT EXISTS idx_work_units_repo_issue ON work_units(repo_id, issue_id)`,
      `CREATE INDEX IF NOT EXISTS idx_work_units_state ON work_units(state)`,
    ]
  },
  {
    version: 39,
    name: "sessions_branch_index",
    // Bug: 81c9d85 — index sessions by branch for efficient branch-scoped queries
    statements: [
      `CREATE INDEX IF NOT EXISTS sessions_branch_idx ON sessions(branch) WHERE branch IS NOT NULL`,
    ]
  },
  {
    version: 40,
    name: "webhook_events",
    // Bug: 9f66ad9 — webhook ingestion endpoint for external event routing
    statements: [
      `CREATE TABLE IF NOT EXISTS webhook_events (
        id             TEXT PRIMARY KEY,
        source         TEXT NOT NULL,
        event_type     TEXT NOT NULL,
        title          TEXT,
        data_json      TEXT NOT NULL,
        target_session TEXT,
        target_issue   TEXT,
        target_branch  TEXT,
        priority       TEXT NOT NULL DEFAULT 'normal',
        status         TEXT NOT NULL DEFAULT 'pending',
        created_at     INTEGER NOT NULL,
        delivered_at   INTEGER,
        delivered_to   TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_webhook_events_status
        ON webhook_events(status)`,
      `CREATE INDEX IF NOT EXISTS idx_webhook_events_created
        ON webhook_events(created_at DESC)`,
    ]
  },
  {
    version: 41,
    name: "channel_connected_sessions",
    // Bug: 0b454df — track channel-connected sessions (MCP channel server)
    // channel_connected_at: epoch ms when channel server first registered
    // channel_last_tool_call: epoch ms of most recent MCP tool invocation
    statements: [
      `ALTER TABLE sessions ADD COLUMN channel_connected_at INTEGER`,
      `ALTER TABLE sessions ADD COLUMN channel_last_tool_call INTEGER`,
      `CREATE INDEX IF NOT EXISTS sessions_channel_idx
        ON sessions(channel_connected_at) WHERE channel_connected_at IS NOT NULL`,
    ]
  },
  {
    version: 42,
    name: "presets",
    // Bug: 61bee4e — Presets feature: data model for convention presets,
    // node tree, session associations, and proposed diffs.
    statements: [
      `CREATE TABLE IF NOT EXISTS presets (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        source      TEXT NOT NULL DEFAULT 'manual'
                    CHECK(source IN ('manual', 'claude_md_global', 'claude_md_project', 'claude_md_local')),
        source_path TEXT,
        content_hash TEXT NOT NULL DEFAULT '',
        version     INTEGER NOT NULL DEFAULT 1,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS preset_nodes (
        id          TEXT PRIMARY KEY,
        preset_id   TEXT NOT NULL REFERENCES presets(id) ON DELETE CASCADE,
        parent_id   TEXT REFERENCES preset_nodes(id) ON DELETE CASCADE,
        position    INTEGER NOT NULL DEFAULT 0,
        title       TEXT NOT NULL DEFAULT '',
        body        TEXT NOT NULL DEFAULT '',
        level       INTEGER NOT NULL DEFAULT 1,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_preset_nodes_preset ON preset_nodes(preset_id)`,
      `CREATE INDEX IF NOT EXISTS idx_preset_nodes_parent ON preset_nodes(parent_id)`,
      `CREATE TABLE IF NOT EXISTS session_presets (
        session_id      TEXT NOT NULL,
        preset_id       TEXT NOT NULL,
        preset_version  INTEGER NOT NULL DEFAULT 1,
        position        INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (session_id, preset_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_session_presets_session ON session_presets(session_id)`,
      `CREATE TABLE IF NOT EXISTS preset_diffs (
        id          TEXT PRIMARY KEY,
        session_id  TEXT NOT NULL,
        preset_id   TEXT,
        node_id     TEXT,
        diff_type   TEXT NOT NULL CHECK(diff_type IN ('add', 'remove', 'modify')),
        old_content TEXT,
        new_content TEXT,
        status      TEXT NOT NULL DEFAULT 'proposed'
                    CHECK(status IN ('proposed', 'accepted', 'rejected', 'promoted')),
        created_at  INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_preset_diffs_session ON preset_diffs(session_id)`,
    ]
  },
  {
    version: 43,
    name: "convention_setting_links",
    // Bug: 8baedeb — convention-configuration linkage for Presets system
    statements: [
      `CREATE TABLE IF NOT EXISTS convention_setting_links (
        id              TEXT PRIMARY KEY,
        node_id         TEXT NOT NULL REFERENCES preset_nodes(id) ON DELETE CASCADE,
        setting_key     TEXT NOT NULL,
        link_type       TEXT NOT NULL DEFAULT 'references'
                        CHECK(link_type IN ('references', 'requires', 'configures')),
        created_at      INTEGER NOT NULL,
        UNIQUE(node_id, setting_key)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_csl_node ON convention_setting_links(node_id)`,
      `CREATE INDEX IF NOT EXISTS idx_csl_setting ON convention_setting_links(setting_key)`,
    ]
  },
  {
    version: 44,
    name: "convention_setting_links_source",
    // Bug: 8baedeb — distinguish auto-scanned links from manually created ones
    // to prevent scanForSettingLinks from deleting manual links on re-scan.
    statements: [
      `ALTER TABLE convention_setting_links ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'`,
    ]
  },
  {
    version: 45,
    name: "auth_request_type",
    // Bug: dd21c1e — generalize auth queue to support action types beyond merges
    statements: [
      `ALTER TABLE auth_requests ADD COLUMN type TEXT NOT NULL DEFAULT 'merge'`
    ]
  },
  {
    version: 46,
    name: "auth_hooks",
    // Bug: 4afab83 — configurable post-auth-action hooks, replacing hardcoded
    // build/restart logic in auth-merge.sh.
    statements: [
      `CREATE TABLE IF NOT EXISTS auth_hooks (
        id            TEXT PRIMARY KEY,
        repo_pattern  TEXT NOT NULL DEFAULT '*',
        auth_type     TEXT NOT NULL DEFAULT 'merge',
        command       TEXT NOT NULL,
        label         TEXT NOT NULL DEFAULT '',
        enabled       INTEGER NOT NULL DEFAULT 1,
        builtin       INTEGER NOT NULL DEFAULT 0,
        position      INTEGER NOT NULL DEFAULT 0,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_auth_hooks_repo_type
        ON auth_hooks(repo_pattern, auth_type)`,
      // Seed the built-in Mandible post-merge hook
      `INSERT INTO auth_hooks (id, repo_pattern, auth_type, command, label, enabled, builtin, position, created_at, updated_at)
       VALUES (
         'builtin-mandible-rebuild',
         'mandible',
         'merge',
         'npm install --legacy-peer-deps --no-audit --no-fund && npm run build',
         'Rebuild Mandible after merge',
         1,
         1,
         0,
         CAST(strftime('%s','now') * 1000 AS INTEGER),
         CAST(strftime('%s','now') * 1000 AS INTEGER)
       )`
    ]
  },
  {
    version: 47,
    name: "runtime_patches",
    // Bug: cc4688b — Zone 2 mutable runtime: audit table for applied patches
    statements: [
      `CREATE TABLE IF NOT EXISTS runtime_patches (
        id            TEXT PRIMARY KEY,
        fingerprint   TEXT,
        commit_hash   TEXT NOT NULL,
        parent_hash   TEXT,
        diff_summary  TEXT,
        diff_stat     TEXT,
        applied_at    INTEGER NOT NULL,
        reverted_at   INTEGER,
        source        TEXT NOT NULL CHECK(source IN ('agent','known_fix','manual','upstream_update')),
        session_id    TEXT,
        submitted     INTEGER NOT NULL DEFAULT 0,
        submission_url TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_runtime_patches_applied
        ON runtime_patches(applied_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_runtime_patches_source
        ON runtime_patches(source)`,
    ]
  },
  {
    version: 48,
    name: "console_channel_enabled",
    // Bug: b5aba0e — channel-enabled PTY sessions: add channel_enabled flag
    statements: [
      `ALTER TABLE console_sessions ADD COLUMN channel_enabled INTEGER NOT NULL DEFAULT 0`,
    ]
  },
  {
    // Bug: 790433d — Per-prompt parameter snapshots (keyframe/delta model)
    version: 49,
    name: "message_params",
    statements: [
      `CREATE TABLE IF NOT EXISTS message_params (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id      TEXT NOT NULL,
        message_index   INTEGER NOT NULL,
        model           TEXT,
        permission_mode TEXT,
        max_turns       INTEGER,
        max_cost_usd    REAL,
        preset_ids      TEXT,
        allowed_tools   TEXT,
        created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE(session_id, message_index)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_message_params_session
        ON message_params(session_id, message_index DESC)`,
    ]
  },
  {
    // Bug: 4e32923 — scoped auth-result delivery: target session + repo root,
    // and a delivered_at watermark set when the MCP channel server forwards
    // the auth:resolved event to the originating session. Inbox queries use
    // these to drive the three-tier escalation model (owner → project → global).
    // Also seeds the two grace-window settings (project: 7d, global: 30d).
    version: 50,
    name: "auth_request_target_scoping",
    statements: [
      `ALTER TABLE auth_requests ADD COLUMN target_session_id TEXT`,
      `ALTER TABLE auth_requests ADD COLUMN target_repo_root TEXT`,
      `ALTER TABLE auth_requests ADD COLUMN delivered_at INTEGER`,
      `CREATE INDEX IF NOT EXISTS idx_auth_requests_target_session
        ON auth_requests(target_session_id) WHERE target_session_id IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS idx_auth_requests_target_repo
        ON auth_requests(target_repo_root) WHERE target_repo_root IS NOT NULL`,
      `INSERT OR IGNORE INTO settings (key, value, updated_at)
       VALUES ('inbox.project_grace_days', '7',
               CAST(strftime('%s','now') * 1000 AS INTEGER))`,
      `INSERT OR IGNORE INTO settings (key, value, updated_at)
       VALUES ('inbox.global_grace_days', '30',
               CAST(strftime('%s','now') * 1000 AS INTEGER))`
    ]
  },
  {
    // Bug: 6d7411b — conversation_id persistence: Claude Code's
    // CLAUDE_CODE_SESSION_ID persists across resumes (unlike MANDIBLE_SESSION_ID
    // which changes on each channel-server restart). Storing it on both sessions
    // and auth_requests enables delivery matching when the channel session id
    // has changed but the conversation is the same.
    version: 51,
    name: "conversation_id",
    statements: [
      `ALTER TABLE sessions ADD COLUMN conversation_id TEXT`,
      `ALTER TABLE auth_requests ADD COLUMN conversation_id TEXT`,
      `CREATE INDEX IF NOT EXISTS idx_auth_requests_conversation_id
        ON auth_requests(conversation_id) WHERE conversation_id IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS idx_sessions_conversation_id
        ON sessions(conversation_id) WHERE conversation_id IS NOT NULL`
    ]
  },
  {
    version: 52,
    name: "auth_auto_approve_lease",
    statements: [
      `ALTER TABLE auth_requests ADD COLUMN approval_source TEXT NOT NULL DEFAULT 'manual'`,
      `ALTER TABLE auth_requests ADD COLUMN approval_lease_id TEXT`,
      `INSERT OR IGNORE INTO settings (key, value, updated_at)
       VALUES ('auth_auto_approve_duration_minutes', '60',
               CAST(strftime('%s','now') * 1000 AS INTEGER))`,
    ]
  },
  {
    version: 53,
    name: "graph_provider_artifacts",
    // Bug: 50c4afb — provider registry, artifact records, manifest ingest,
    // and a durable graph entity/edge index for provider/provenance nodes.
    statements: [
      `CREATE TABLE IF NOT EXISTS providers (
        id                TEXT PRIMARY KEY,
        display_name      TEXT NOT NULL,
        version           TEXT,
        status            TEXT NOT NULL DEFAULT 'active',
        transport         TEXT NOT NULL DEFAULT 'manifest',
        endpoint          TEXT,
        capabilities_json TEXT NOT NULL DEFAULT '{}',
        actions_json      TEXT NOT NULL DEFAULT '[]',
        source            TEXT NOT NULL DEFAULT 'local',
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL,
        last_seen_at      INTEGER
      )`,
      `CREATE INDEX IF NOT EXISTS idx_providers_status
        ON providers(status)`,
      `CREATE TABLE IF NOT EXISTS artifacts (
        id            TEXT PRIMARY KEY,
        algorithm     TEXT NOT NULL DEFAULT 'sha256',
        content_hash  TEXT NOT NULL,
        uri           TEXT NOT NULL,
        media_type    TEXT,
        role          TEXT,
        size_bytes    INTEGER NOT NULL DEFAULT 0,
        provider_id   TEXT,
        manifest_id   TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        pinned        INTEGER NOT NULL DEFAULT 1,
        created_at    INTEGER NOT NULL,
        UNIQUE(algorithm, content_hash)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_artifacts_provider
        ON artifacts(provider_id)`,
      `CREATE INDEX IF NOT EXISTS idx_artifacts_role
        ON artifacts(role)`,
      `CREATE TABLE IF NOT EXISTS provider_manifests (
        id            TEXT PRIMARY KEY,
        provider_id   TEXT NOT NULL,
        manifest_type TEXT NOT NULL DEFAULT 'provider_manifest',
        version       TEXT,
        content_hash  TEXT NOT NULL,
        artifact_id   TEXT,
        source        TEXT NOT NULL DEFAULT 'ingest',
        content_json  TEXT NOT NULL,
        created_at    INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_provider_manifests_provider
        ON provider_manifests(provider_id, created_at DESC)`,
      `CREATE TABLE IF NOT EXISTS graph_entities (
        id                  TEXT PRIMARY KEY,
        entity_type         TEXT NOT NULL,
        repo_id             TEXT,
        provider_id         TEXT,
        external_id         TEXT,
        title               TEXT NOT NULL,
        status              TEXT,
        labels_json         TEXT NOT NULL DEFAULT '[]',
        summary_json        TEXT NOT NULL DEFAULT '{}',
        detail_ref_json     TEXT NOT NULL DEFAULT '{}',
        action_context_json TEXT NOT NULL DEFAULT '{}',
        visual_json         TEXT NOT NULL DEFAULT '{}',
        created_at          INTEGER,
        updated_at          INTEGER,
        observed_at         INTEGER NOT NULL,
        source              TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_graph_entities_type
        ON graph_entities(entity_type)`,
      `CREATE INDEX IF NOT EXISTS idx_graph_entities_provider
        ON graph_entities(provider_id)`,
      `CREATE INDEX IF NOT EXISTS idx_graph_entities_repo
        ON graph_entities(repo_id)`,
      `CREATE TABLE IF NOT EXISTS graph_edges (
        id            TEXT PRIMARY KEY,
        source_id     TEXT NOT NULL,
        target_id     TEXT NOT NULL,
        edge_type     TEXT NOT NULL,
        edge_class    TEXT NOT NULL DEFAULT 'provenance',
        provenance    TEXT NOT NULL DEFAULT 'system',
        confidence    TEXT NOT NULL DEFAULT 'observed',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at    INTEGER,
        observed_at   INTEGER NOT NULL,
        source        TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_graph_edges_source
        ON graph_edges(source_id)`,
      `CREATE INDEX IF NOT EXISTS idx_graph_edges_target
        ON graph_edges(target_id)`,
      `CREATE INDEX IF NOT EXISTS idx_graph_edges_type
        ON graph_edges(edge_type)`,
      `CREATE INDEX IF NOT EXISTS idx_graph_edges_class
        ON graph_edges(edge_class)`
    ]
  },
  {
    version: 54,
    name: "auth_hook_rebuild_legacy_peer_deps",
    // Bug: 849d318 — plain npm install materializes React peer deps in
    // package-lock.json, leaving the protected checkout dirty after self-merge.
    statements: [
      `UPDATE auth_hooks
       SET command = 'npm install --legacy-peer-deps --no-audit --no-fund && npm run build',
           updated_at = CAST(strftime('%s','now') * 1000 AS INTEGER)
       WHERE id = 'builtin-mandible-rebuild'
         AND command = 'npm install && npm run build'`
    ]
  },
  {
    version: 55,
    name: "ledger_core",
    // Bug: ff6a2bc — canonical Mandible work ledger substrate. This migration
    // is intentionally shadow-only; existing issue routes continue to use the
    // git-bug scanner until later gated cutover work.
    statements: [
      `CREATE TABLE IF NOT EXISTS ledger_projects (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        remote_identity TEXT NOT NULL DEFAULT '',
        upstream_identity TEXT NOT NULL DEFAULT '',
        namespace_policy TEXT NOT NULL DEFAULT 'remote'
          CHECK(namespace_policy IN ('remote','upstream','local')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_projects_remote_identity
        ON ledger_projects(remote_identity)
        WHERE remote_identity != ''`,
      `CREATE TABLE IF NOT EXISTS ledger_project_checkouts (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES ledger_projects(id) ON DELETE RESTRICT,
        work_repo_id TEXT,
        root TEXT NOT NULL,
        name TEXT NOT NULL,
        default_branch TEXT NOT NULL DEFAULT '',
        remote_url TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(root)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_ledger_project_checkouts_project
        ON ledger_project_checkouts(project_id)`,
      `CREATE TABLE IF NOT EXISTS ledger_issues (
        id TEXT PRIMARY KEY,
        short_id TEXT NOT NULL DEFAULT '',
        project_id TEXT NOT NULL REFERENCES ledger_projects(id) ON DELETE RESTRICT,
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK(status IN ('open','closed')),
        resolution TEXT CHECK(resolution IN ('fixed','merged','duplicate','wontfix','invalid','obsolete','unknown') OR resolution IS NULL),
        kind TEXT NOT NULL DEFAULT 'unknown'
          CHECK(kind IN ('bug','feature','umbrella','task','question','maintenance','deferred','unknown')),
        priority TEXT NOT NULL DEFAULT 'unknown'
          CHECK(priority IN ('low','normal','high','urgent','unknown')),
        author_actor_id TEXT,
        author_actor_type TEXT NOT NULL DEFAULT 'external_adapter'
          CHECK(author_actor_type IN ('mandible_user','agent','system','external_adapter')),
        author_display TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'mandible'
          CHECK(source IN ('mandible','git_bug','auth_queue','session','work_unit','import','system')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        closed_at INTEGER,
        deleted_at INTEGER
      )`,
      `CREATE INDEX IF NOT EXISTS idx_ledger_issues_project_status_updated
        ON ledger_issues(project_id, status, updated_at DESC)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_issues_project_short_id
        ON ledger_issues(project_id, short_id)
        WHERE short_id != ''`,
      `CREATE INDEX IF NOT EXISTS idx_ledger_issues_kind
        ON ledger_issues(kind)`,
      `CREATE TABLE IF NOT EXISTS ledger_issue_aliases (
        issue_id TEXT NOT NULL REFERENCES ledger_issues(id) ON DELETE CASCADE,
        alias_kind TEXT NOT NULL,
        project_id TEXT NOT NULL REFERENCES ledger_projects(id) ON DELETE CASCADE,
        alias TEXT NOT NULL,
        external_id TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL,
        is_primary INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (alias_kind, project_id, alias)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_ledger_issue_aliases_issue
        ON ledger_issue_aliases(issue_id)`,
      `CREATE INDEX IF NOT EXISTS idx_ledger_issue_aliases_alias
        ON ledger_issue_aliases(alias)`,
      `CREATE TABLE IF NOT EXISTS ledger_comments (
        id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL REFERENCES ledger_issues(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL DEFAULT 0,
        body TEXT NOT NULL,
        author_actor_id TEXT,
        author_actor_type TEXT NOT NULL
          CHECK(author_actor_type IN ('mandible_user','agent','system','external_adapter')),
        author_display TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL
          CHECK(source IN ('mandible','git_bug','auth_queue','session','work_unit','import','system')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER,
        deleted_at INTEGER
      )`,
      `CREATE INDEX IF NOT EXISTS idx_ledger_comments_issue_created
        ON ledger_comments(issue_id, created_at)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_comments_issue_ordinal
        ON ledger_comments(issue_id, ordinal)
        WHERE ordinal > 0`,
      `CREATE TABLE IF NOT EXISTS ledger_labels (
        issue_id TEXT NOT NULL REFERENCES ledger_issues(id) ON DELETE CASCADE,
        label TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'mandible',
        created_at INTEGER NOT NULL,
        deleted_at INTEGER,
        PRIMARY KEY (issue_id, label)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_ledger_labels_label
        ON ledger_labels(label)`,
      `CREATE TABLE IF NOT EXISTS ledger_issue_relationships (
        id TEXT PRIMARY KEY,
        source_issue_id TEXT NOT NULL REFERENCES ledger_issues(id) ON DELETE CASCADE,
        target_issue_id TEXT NOT NULL REFERENCES ledger_issues(id) ON DELETE CASCADE,
        relationship_type TEXT NOT NULL
          CHECK(relationship_type IN ('parent_child','blocks','duplicate_of','related','references','fixed_by','caused_by','implements','tests')),
        provenance TEXT NOT NULL DEFAULT 'manual'
          CHECK(provenance IN ('manual','imported','derived','system')),
        confidence TEXT NOT NULL DEFAULT 'observed',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER,
        UNIQUE(source_issue_id, target_issue_id, relationship_type)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_ledger_relationships_source
        ON ledger_issue_relationships(source_issue_id)`,
      `CREATE INDEX IF NOT EXISTS idx_ledger_relationships_target
        ON ledger_issue_relationships(target_issue_id)`,
      `CREATE INDEX IF NOT EXISTS idx_ledger_relationships_type
        ON ledger_issue_relationships(relationship_type)`,
      `CREATE TABLE IF NOT EXISTS ledger_issue_relationship_sources (
        id TEXT PRIMARY KEY,
        relationship_id TEXT NOT NULL REFERENCES ledger_issue_relationships(id) ON DELETE CASCADE,
        source_entity_type TEXT NOT NULL CHECK(source_entity_type IN ('issue_body','comment')),
        source_entity_id TEXT NOT NULL,
        source_issue_id TEXT NOT NULL REFERENCES ledger_issues(id) ON DELETE CASCADE,
        target_issue_id TEXT NOT NULL REFERENCES ledger_issues(id) ON DELETE CASCADE,
        relationship_type TEXT NOT NULL
          CHECK(relationship_type IN ('parent_child','blocks','duplicate_of','related','references','fixed_by','caused_by','implements','tests')),
        ref_kind TEXT NOT NULL CHECK(ref_kind IN ('issue','comment')),
        raw_ref TEXT NOT NULL,
        normalized_ref TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER,
        UNIQUE(source_entity_type, source_entity_id, target_issue_id, relationship_type, ref_kind, normalized_ref)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_ledger_relationship_sources_relationship
        ON ledger_issue_relationship_sources(relationship_id)`,
      `CREATE INDEX IF NOT EXISTS idx_ledger_relationship_sources_source
        ON ledger_issue_relationship_sources(source_entity_type, source_entity_id)`,
      `CREATE INDEX IF NOT EXISTS idx_ledger_relationship_sources_target
        ON ledger_issue_relationship_sources(target_issue_id)`,
      `CREATE TABLE IF NOT EXISTS ledger_relationship_edges (
        id TEXT PRIMARY KEY,
        source_entity_type TEXT NOT NULL CHECK(source_entity_type IN ('issue','comment')),
        source_entity_id TEXT NOT NULL,
        source_project_id TEXT NOT NULL REFERENCES ledger_projects(id) ON DELETE RESTRICT,
        source_issue_id TEXT NOT NULL REFERENCES ledger_issues(id) ON DELETE CASCADE,
        target_entity_type TEXT NOT NULL CHECK(target_entity_type IN ('issue','comment')),
        target_entity_id TEXT NOT NULL,
        target_project_id TEXT NOT NULL REFERENCES ledger_projects(id) ON DELETE RESTRICT,
        target_issue_id TEXT NOT NULL REFERENCES ledger_issues(id) ON DELETE CASCADE,
        link_type TEXT NOT NULL
          CHECK(link_type IN ('parent_child','blocks','duplicate_of','related','references','fixed_by','caused_by','implements','tests')),
        provenance TEXT NOT NULL DEFAULT 'manual'
          CHECK(provenance IN ('manual','imported','derived','system')),
        note TEXT,
        action_id TEXT NOT NULL,
        actor_id TEXT,
        actor_type TEXT NOT NULL
          CHECK(actor_type IN ('mandible_user','agent','system','external_adapter')),
        source TEXT NOT NULL
          CHECK(source IN ('mandible','git_bug','auth_queue','session','work_unit','import','system')),
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER,
        UNIQUE(source_entity_type, source_entity_id, target_entity_type, target_entity_id, link_type)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_ledger_relationship_edges_source
        ON ledger_relationship_edges(source_entity_type, source_entity_id, deleted_at)`,
      `CREATE INDEX IF NOT EXISTS idx_ledger_relationship_edges_source_issue
        ON ledger_relationship_edges(source_issue_id, deleted_at)`,
      `CREATE INDEX IF NOT EXISTS idx_ledger_relationship_edges_target
        ON ledger_relationship_edges(target_entity_type, target_entity_id, deleted_at)`,
      `CREATE INDEX IF NOT EXISTS idx_ledger_relationship_edges_target_issue
        ON ledger_relationship_edges(target_issue_id, deleted_at)`,
      `CREATE INDEX IF NOT EXISTS idx_ledger_relationship_edges_action
        ON ledger_relationship_edges(action_id)`,
      `CREATE TABLE IF NOT EXISTS ledger_events (
        id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        actor_id TEXT,
        actor_type TEXT NOT NULL
          CHECK(actor_type IN ('mandible_user','agent','system','external_adapter')),
        source TEXT NOT NULL
          CHECK(source IN ('mandible','git_bug','auth_queue','session','work_unit','import','system')),
        payload_json TEXT NOT NULL DEFAULT '{}',
        occurred_at INTEGER NOT NULL,
        observed_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_ledger_events_entity
        ON ledger_events(entity_type, entity_id, occurred_at)`,
      `CREATE INDEX IF NOT EXISTS idx_ledger_events_occurred
        ON ledger_events(occurred_at DESC)`,
      `CREATE TABLE IF NOT EXISTS ledger_outbox (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL REFERENCES ledger_events(id) ON DELETE CASCADE,
        adapter TEXT NOT NULL,
        project_id TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL
          CHECK(status IN ('pending','processing','applied','failed','conflicted','skipped')),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        available_at INTEGER NOT NULL,
        last_attempt_at INTEGER,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(event_id, adapter)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_ledger_outbox_adapter_status
        ON ledger_outbox(adapter, status, available_at)`,
      `CREATE INDEX IF NOT EXISTS idx_ledger_outbox_project
        ON ledger_outbox(project_id)`,
      `CREATE TABLE IF NOT EXISTS ledger_external_refs (
        id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        adapter TEXT NOT NULL,
        project_id TEXT NOT NULL DEFAULT '',
        external_id TEXT NOT NULL,
        external_kind TEXT NOT NULL,
        remote_version TEXT NOT NULL DEFAULT '',
        remote_hash TEXT NOT NULL DEFAULT '',
        last_imported_at INTEGER,
        last_exported_at INTEGER,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(adapter, project_id, external_kind, external_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_ledger_external_refs_entity
        ON ledger_external_refs(entity_type, entity_id)`,
      `CREATE TABLE IF NOT EXISTS ledger_conflicts (
        id TEXT PRIMARY KEY,
        adapter TEXT NOT NULL,
        project_id TEXT NOT NULL DEFAULT '',
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        field TEXT NOT NULL,
        local_value_json TEXT NOT NULL,
        remote_value_json TEXT NOT NULL,
        base_value_json TEXT NOT NULL DEFAULT 'null',
        status TEXT NOT NULL CHECK(status IN ('open','resolved','dismissed')),
        resolution TEXT,
        created_at INTEGER NOT NULL,
        resolved_at INTEGER
      )`,
      `CREATE INDEX IF NOT EXISTS idx_ledger_conflicts_status
        ON ledger_conflicts(status, adapter, project_id)`,
      `CREATE INDEX IF NOT EXISTS idx_ledger_conflicts_entity
        ON ledger_conflicts(entity_type, entity_id)`
    ]
  },
  {
    version: 56,
    name: "ledger_sync_jobs",
    // Bug: aac782a — adapter sync status/retry records. Normal ledger reads
    // and writes must not depend on git-bug lock availability.
    statements: [
      `CREATE TABLE IF NOT EXISTS ledger_sync_jobs (
        id TEXT PRIMARY KEY,
        adapter TEXT NOT NULL,
        project_id TEXT NOT NULL DEFAULT '',
        checkout_id TEXT,
        root TEXT NOT NULL DEFAULT '',
        direction TEXT NOT NULL CHECK(direction IN ('import','export','full')),
        status TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed','retryable','conflicted')),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_retry_at INTEGER,
        started_at INTEGER,
        finished_at INTEGER,
        last_error TEXT,
        stats_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_ledger_sync_jobs_adapter_status
        ON ledger_sync_jobs(adapter, status, next_retry_at)`,
      `CREATE INDEX IF NOT EXISTS idx_ledger_sync_jobs_project
        ON ledger_sync_jobs(project_id, checkout_id, updated_at DESC)`
    ]
  },
  {
    version: 57,
    name: "ledger_migration_gate",
    // Bug: 59d527a — migration/read-cutover gates and shadow reconciliation.
    statements: [
      `CREATE TABLE IF NOT EXISTS settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `INSERT OR IGNORE INTO settings (key, value, updated_at)
        VALUES ('ledger.issues.read_mode', 'scanner', CAST(strftime('%s','now') * 1000 AS INTEGER))`,
      `INSERT OR IGNORE INTO settings (key, value, updated_at)
        VALUES ('ledger.issues.write_mode', 'git_bug', CAST(strftime('%s','now') * 1000 AS INTEGER))`,
      `INSERT OR IGNORE INTO settings (key, value, updated_at)
        VALUES ('ledger.issues.shadow_report_enabled', 'true', CAST(strftime('%s','now') * 1000 AS INTEGER))`,
      `INSERT OR IGNORE INTO settings (key, value, updated_at)
        VALUES ('ledger.issues.fallback_on_ledger_error', 'true', CAST(strftime('%s','now') * 1000 AS INTEGER))`,
      `CREATE TABLE IF NOT EXISTS ledger_reconciliation_reports (
        id TEXT PRIMARY KEY,
        read_mode TEXT NOT NULL CHECK(read_mode IN ('scanner','shadow','ledger')),
        status TEXT NOT NULL CHECK(status IN ('running','clean','mismatch','failed')),
        scanner_issue_count INTEGER NOT NULL DEFAULT 0,
        ledger_issue_count INTEGER NOT NULL DEFAULT 0,
        scanner_open_count INTEGER NOT NULL DEFAULT 0,
        ledger_open_count INTEGER NOT NULL DEFAULT 0,
        scanner_closed_count INTEGER NOT NULL DEFAULT 0,
        ledger_closed_count INTEGER NOT NULL DEFAULT 0,
        mismatch_count INTEGER NOT NULL DEFAULT 0,
        summary_json TEXT NOT NULL DEFAULT '{}',
        error TEXT,
        started_at INTEGER NOT NULL,
        finished_at INTEGER
      )`,
      `CREATE INDEX IF NOT EXISTS idx_ledger_reconciliation_reports_status
        ON ledger_reconciliation_reports(status, finished_at DESC)`,
      `CREATE TABLE IF NOT EXISTS ledger_reconciliation_mismatches (
        id TEXT PRIMARY KEY,
        report_id TEXT NOT NULL REFERENCES ledger_reconciliation_reports(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL DEFAULT '',
        repo_id TEXT NOT NULL DEFAULT '',
        issue_ref TEXT NOT NULL DEFAULT '',
        mismatch_type TEXT NOT NULL,
        scanner_value_json TEXT NOT NULL DEFAULT 'null',
        ledger_value_json TEXT NOT NULL DEFAULT 'null',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_ledger_reconciliation_mismatches_report
        ON ledger_reconciliation_mismatches(report_id, mismatch_type)`,
      `CREATE INDEX IF NOT EXISTS idx_ledger_reconciliation_mismatches_issue
        ON ledger_reconciliation_mismatches(repo_id, issue_ref)`
    ]
  },
  {
    version: 58,
    name: "ledger_operational_links",
    // Bug: e8c1d43 — canonical issue links for work units, sessions, auth, and commits.
    statements: [
      `CREATE TABLE IF NOT EXISTS ledger_work_unit_issue_links (
        work_unit_id TEXT NOT NULL REFERENCES work_units(id) ON DELETE CASCADE,
        issue_id TEXT NOT NULL REFERENCES ledger_issues(id) ON DELETE RESTRICT,
        link_type TEXT NOT NULL DEFAULT 'work_unit_tracks',
        source TEXT NOT NULL DEFAULT 'system',
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY (work_unit_id, issue_id, link_type)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_ledger_work_unit_issue_issue
        ON ledger_work_unit_issue_links(issue_id)`,
      `CREATE TABLE IF NOT EXISTS ledger_session_issue_links (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        issue_id TEXT NOT NULL REFERENCES ledger_issues(id) ON DELETE RESTRICT,
        link_type TEXT NOT NULL DEFAULT 'worked_on',
        source TEXT NOT NULL DEFAULT 'system',
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY (session_id, issue_id, link_type)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_ledger_session_issue_issue
        ON ledger_session_issue_links(issue_id)`,
      `CREATE TABLE IF NOT EXISTS ledger_auth_issue_links (
        auth_request_id TEXT NOT NULL REFERENCES auth_requests(id) ON DELETE CASCADE,
        issue_id TEXT NOT NULL REFERENCES ledger_issues(id) ON DELETE RESTRICT,
        link_type TEXT NOT NULL DEFAULT 'references',
        source TEXT NOT NULL DEFAULT 'auth_queue',
        created_at INTEGER NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY (auth_request_id, issue_id, link_type)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_ledger_auth_issue_issue
        ON ledger_auth_issue_links(issue_id)`,
      `CREATE TABLE IF NOT EXISTS ledger_commit_issue_links (
        commit_sha TEXT NOT NULL,
        project_id TEXT NOT NULL REFERENCES ledger_projects(id) ON DELETE RESTRICT,
        issue_id TEXT NOT NULL REFERENCES ledger_issues(id) ON DELETE RESTRICT,
        link_type TEXT NOT NULL DEFAULT 'fixed_by',
        source TEXT NOT NULL DEFAULT 'auth_queue',
        created_at INTEGER NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY (commit_sha, issue_id, link_type)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_ledger_commit_issue_issue
        ON ledger_commit_issue_links(issue_id)`,
      `CREATE TABLE IF NOT EXISTS ledger_operational_link_reports (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK(status IN ('clean','incomplete','failed')),
        resolved_count INTEGER NOT NULL DEFAULT 0,
        unresolved_count INTEGER NOT NULL DEFAULT 0,
        ambiguous_count INTEGER NOT NULL DEFAULT 0,
        source_counts_json TEXT NOT NULL DEFAULT '{}',
        error TEXT,
        started_at INTEGER NOT NULL,
        finished_at INTEGER
      )`,
      `CREATE INDEX IF NOT EXISTS idx_ledger_operational_link_reports_status
        ON ledger_operational_link_reports(status, finished_at DESC)`,
      `CREATE TABLE IF NOT EXISTS ledger_operational_link_mismatches (
        id TEXT PRIMARY KEY,
        report_id TEXT NOT NULL REFERENCES ledger_operational_link_reports(id) ON DELETE CASCADE,
        source_table TEXT NOT NULL,
        source_id TEXT NOT NULL,
        repo_id TEXT NOT NULL DEFAULT '',
        issue_ref TEXT NOT NULL DEFAULT '',
        mismatch_type TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_ledger_operational_link_mismatches_report
        ON ledger_operational_link_mismatches(report_id, source_table, mismatch_type)`
    ]
  },
  {
    version: 59,
    name: "auth_hook_commit_built_dist",
    // Bug: b1308c6 — the built-in self-merge hook must not leave generated
    // dist output dirty in the protected checkout. The script rebuilds and
    // commits dist/ui-dist when source changes require it.
    statements: [
      `CREATE TABLE IF NOT EXISTS auth_hooks (
        id            TEXT PRIMARY KEY,
        repo_pattern  TEXT NOT NULL DEFAULT '*',
        auth_type     TEXT NOT NULL DEFAULT 'merge',
        command       TEXT NOT NULL,
        label         TEXT NOT NULL DEFAULT '',
        enabled       INTEGER NOT NULL DEFAULT 1,
        builtin       INTEGER NOT NULL DEFAULT 0,
        position      INTEGER NOT NULL DEFAULT 0,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
      )`,
      `UPDATE auth_hooks
       SET command = 'bash cli/post-merge-build-dist.sh',
           label = 'Build and commit Mandible dist after merge',
           updated_at = CAST(strftime('%s','now') * 1000 AS INTEGER)
       WHERE id = 'builtin-mandible-rebuild'`
    ]
  },
  {
    version: 60,
    name: "auth_request_issue_relationship_kinds",
    // Bug: 7b83c1f — distinguish reference-only issue links from close-on-merge links.
    statements: [
      `CREATE TABLE IF NOT EXISTS auth_requests (
        id            TEXT PRIMARY KEY,
        session_id    TEXT,
        command       TEXT NOT NULL,
        title         TEXT NOT NULL,
        cwd           TEXT,
        diff_summary  TEXT,
        spec_content  TEXT,
        status        TEXT NOT NULL DEFAULT 'pending',
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        approved_at   INTEGER,
        resolved_at   INTEGER,
        skipped_at    INTEGER,
        expires_at    INTEGER NOT NULL,
        exit_code     INTEGER,
        output        TEXT NOT NULL DEFAULT '',
        error         TEXT
      )`,
      `ALTER TABLE auth_requests ADD COLUMN issue_references TEXT`,
      `ALTER TABLE auth_requests ADD COLUMN issue_closures TEXT`
    ]
  },
  {
    version: 61,
    name: "ledger_hash_id_support",
    // Bug: 871f32e — SHA-256 issue/comment IDs with cached Git-style short
    // prefixes and append-only per-issue comment ordinals.
    statements: []
  },
  {
    version: 62,
    name: "ledger_event_hash_id_support",
    // Bug: 614f8ee — SHA-256 event IDs and first-class issue lifecycle events.
    statements: []
  },
  {
    version: 63,
    name: "preapproval_artifact_rebuild",
    // Bug: 03abda9 — generated Mandible artifacts should be rebuilt before
    // approval, not committed by a protected-branch post-merge hook.
    statements: [
      `INSERT OR IGNORE INTO settings (key, value, updated_at)
       VALUES ('auth_rebuild_artifacts_on_approval', 'false', CAST(strftime('%s','now') * 1000 AS INTEGER))`,
      `UPDATE auth_hooks
       SET enabled = 0,
           label = 'Deprecated: post-merge artifact commit disabled',
           updated_at = CAST(strftime('%s','now') * 1000 AS INTEGER)
       WHERE id = 'builtin-mandible-rebuild'
         AND command = 'bash cli/post-merge-build-dist.sh'`
    ]
  },
  {
    version: 64,
    name: "untrack_local_build_artifacts",
    // Bug: 6947631 — build artifacts are local runtime output, not reviewed
    // source. Re-enable the self-merge hook as build-only and remove the
    // pre-approval artifact setting introduced by version 62.
    statements: [
      `DELETE FROM settings WHERE key = 'auth_rebuild_artifacts_on_approval'`,
      `UPDATE auth_hooks
       SET enabled = 1,
           label = 'Build Mandible locally after merge',
           updated_at = CAST(strftime('%s','now') * 1000 AS INTEGER)
       WHERE id = 'builtin-mandible-rebuild'
         AND command = 'bash cli/post-merge-build-dist.sh'`
    ]
  },
  {
    version: 65,
    name: "ledger_issue_relationship_sources",
    // Bug: b45f19b — retain source provenance for text-derived references
    // without making comment nodes part of the graph contract.
    statements: [
      `CREATE TABLE IF NOT EXISTS ledger_issue_relationship_sources (
        id TEXT PRIMARY KEY,
        relationship_id TEXT NOT NULL REFERENCES ledger_issue_relationships(id) ON DELETE CASCADE,
        source_entity_type TEXT NOT NULL CHECK(source_entity_type IN ('issue_body','comment')),
        source_entity_id TEXT NOT NULL,
        source_issue_id TEXT NOT NULL REFERENCES ledger_issues(id) ON DELETE CASCADE,
        target_issue_id TEXT NOT NULL REFERENCES ledger_issues(id) ON DELETE CASCADE,
        relationship_type TEXT NOT NULL
          CHECK(relationship_type IN ('parent_child','blocks','duplicate_of','related','references','fixed_by','caused_by','implements','tests')),
        ref_kind TEXT NOT NULL CHECK(ref_kind IN ('issue','comment')),
        raw_ref TEXT NOT NULL,
        normalized_ref TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER,
        UNIQUE(source_entity_type, source_entity_id, target_issue_id, relationship_type, ref_kind, normalized_ref)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_ledger_relationship_sources_relationship
        ON ledger_issue_relationship_sources(relationship_id)`,
      `CREATE INDEX IF NOT EXISTS idx_ledger_relationship_sources_source
        ON ledger_issue_relationship_sources(source_entity_type, source_entity_id)`,
      `CREATE INDEX IF NOT EXISTS idx_ledger_relationship_sources_target
        ON ledger_issue_relationship_sources(target_issue_id)`
    ]
  },
  {
    version: 66,
    name: "artifact_reference_custody",
    // Bug: e16807c — artifacts/documents may be links, copies, managed CAS
    // content, or external/provider-owned references whose source home differs
    // from the issue repo that mentions them.
    // Guarded DDL below handles fresh DBs, older DBs, and tests that rewind
    // schema_version on an already-current database.
    statements: []
  },
  {
    version: 67,
    name: "artifact_aliases_and_links",
    // Bug: e16807c — artifact rows remain content/custody identity records;
    // aliases and links carry URI locators and contextual references.
    statements: [
      `CREATE TABLE IF NOT EXISTS artifact_aliases (
        id                TEXT PRIMARY KEY,
        artifact_id       TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
        scheme            TEXT NOT NULL,
        alias             TEXT NOT NULL,
        normalized_ref    TEXT NOT NULL,
        locator_json      TEXT NOT NULL DEFAULT '{}',
        resolution_status TEXT NOT NULL DEFAULT 'resolved'
          CHECK(resolution_status IN ('resolved','unresolved','ambiguous','unsupported')),
        source            TEXT NOT NULL DEFAULT 'artifact_registry',
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_artifact_aliases_scheme_ref
        ON artifact_aliases(scheme, normalized_ref)`,
      `CREATE INDEX IF NOT EXISTS idx_artifact_aliases_artifact
        ON artifact_aliases(artifact_id)
        WHERE artifact_id IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS idx_artifact_aliases_status
        ON artifact_aliases(resolution_status, scheme)`,
      `CREATE TABLE IF NOT EXISTS artifact_links (
        id            TEXT PRIMARY KEY,
        artifact_id   TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
        entity_type   TEXT NOT NULL,
        entity_id     TEXT NOT NULL,
        link_type     TEXT NOT NULL DEFAULT 'references',
        role          TEXT,
        repo_id       TEXT,
        provider_id   TEXT,
        source        TEXT NOT NULL DEFAULT 'artifact_registry',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_artifact_links_artifact
        ON artifact_links(artifact_id, link_type)`,
      `CREATE INDEX IF NOT EXISTS idx_artifact_links_entity
        ON artifact_links(entity_type, entity_id)`,
      `CREATE INDEX IF NOT EXISTS idx_artifact_links_repo
        ON artifact_links(repo_id)
        WHERE repo_id IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS idx_artifact_links_provider
        ON artifact_links(provider_id)
        WHERE provider_id IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS idx_artifact_links_role
        ON artifact_links(role)
        WHERE role IS NOT NULL`
    ]
  },
  {
    version: 68,
    name: "knowledge_backrefs",
    // Bug: c9531c — keep HumbleB KG ids as typed external references from
    // artifacts/documents; Mandible does not own document chunks, entities, or claims.
    statements: [
      `CREATE TABLE IF NOT EXISTS knowledge_backrefs (
        id            TEXT PRIMARY KEY,
        source_type   TEXT NOT NULL CHECK(source_type IN ('artifact','document')),
        source_id     TEXT NOT NULL,
        provider_id   TEXT NOT NULL DEFAULT 'humbleb',
        ref_type      TEXT NOT NULL CHECK(ref_type IN ('document','entity','claim')),
        external_id   TEXT NOT NULL,
        external_ref  TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'returned'
          CHECK(status IN ('offered','indexed','returned')),
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        UNIQUE(source_type, source_id, provider_id, ref_type, external_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_knowledge_backrefs_source
        ON knowledge_backrefs(source_type, source_id)`,
      `CREATE INDEX IF NOT EXISTS idx_knowledge_backrefs_provider
        ON knowledge_backrefs(provider_id, ref_type)`,
      `CREATE INDEX IF NOT EXISTS idx_knowledge_backrefs_external_ref
        ON knowledge_backrefs(external_ref)`
    ]
  },
  {
    version: 69,
    name: "ledger_body_revisions",
    statements: [
      `CREATE TABLE IF NOT EXISTS ledger_body_revisions (
        id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL CHECK(entity_type IN ('issue_body','comment_body')),
        entity_id TEXT NOT NULL,
        issue_id TEXT NOT NULL REFERENCES ledger_issues(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES ledger_projects(id) ON DELETE RESTRICT,
        revision_no INTEGER NOT NULL,
        event_id TEXT UNIQUE REFERENCES ledger_events(id) ON DELETE SET NULL,
        actor_id TEXT,
        actor_type TEXT NOT NULL CHECK(actor_type IN ('mandible_user','agent','system','external_adapter')),
        source TEXT NOT NULL CHECK(source IN ('mandible','git_bug','auth_queue','session','work_unit','import','system')),
        reason TEXT NOT NULL DEFAULT 'edit'
          CHECK(reason IN ('create','edit','import_snapshot','external_update','normalize','migration_snapshot','restore')),
        occurred_at INTEGER NOT NULL,
        observed_at INTEGER NOT NULL,
        base_revision_id TEXT REFERENCES ledger_body_revisions(id) ON DELETE SET NULL,
        base_hash TEXT,
        new_hash TEXT NOT NULL,
        snapshot_body TEXT NOT NULL,
        patch_format TEXT,
        patch_text TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        redacted_at INTEGER,
        redacted_by_actor_id TEXT,
        redaction_reason TEXT,
        UNIQUE(entity_type, entity_id, revision_no)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_ledger_body_revisions_entity
        ON ledger_body_revisions(entity_type, entity_id, revision_no)`,
      `CREATE INDEX IF NOT EXISTS idx_ledger_body_revisions_issue
        ON ledger_body_revisions(issue_id, occurred_at)`,
      `CREATE INDEX IF NOT EXISTS idx_ledger_body_revisions_event
        ON ledger_body_revisions(event_id)
        WHERE event_id IS NOT NULL`
    ]
  },
  {
    version: 70,
    name: "remove_legacy_issue_ref_kinds",
    statements: []
  },
  {
    version: 71,
    name: "issue_coordination_fields",
    statements: [
      `CREATE TABLE IF NOT EXISTS issue_branches (
        issue_id TEXT NOT NULL REFERENCES ledger_issues(id) ON DELETE CASCADE,
        branch TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'primary'
          CHECK(role IN ('primary','superseded')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (issue_id, branch)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_issue_branches_branch
        ON issue_branches(branch)`,
      `CREATE INDEX IF NOT EXISTS idx_issue_branches_role
        ON issue_branches(role)`
    ]
  },
  {
    version: 72,
    name: "issue_checkpoints",
    statements: [
      `CREATE TABLE IF NOT EXISTS ledger_issue_checkpoints (
        id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL REFERENCES ledger_issues(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        author_actor_id TEXT,
        author_actor_type TEXT NOT NULL CHECK(author_actor_type IN ('mandible_user','agent','system','external_adapter')),
        author_display TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL CHECK(source IN ('mandible','git_bug','auth_queue','session','work_unit','import','system')),
        created_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_ledger_issue_checkpoints_issue_kind_created
        ON ledger_issue_checkpoints(issue_id, kind, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_ledger_issue_checkpoints_issue_created
        ON ledger_issue_checkpoints(issue_id, created_at DESC)`
    ]
  },
  {
    version: 73,
    name: "self_merge_hook_instruction_refresh_label",
    statements: [
      `CREATE TABLE IF NOT EXISTS auth_hooks (
        id            TEXT PRIMARY KEY,
        repo_pattern  TEXT NOT NULL DEFAULT '*',
        auth_type     TEXT NOT NULL DEFAULT 'merge',
        command       TEXT NOT NULL,
        label         TEXT NOT NULL DEFAULT '',
        enabled       INTEGER NOT NULL DEFAULT 1,
        builtin       INTEGER NOT NULL DEFAULT 0,
        position      INTEGER NOT NULL DEFAULT 0,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
      )`,
      `UPDATE auth_hooks
       SET label = 'Build Mandible and install instructions after merge',
           updated_at = CAST(strftime('%s','now') * 1000 AS INTEGER)
       WHERE id = 'builtin-mandible-rebuild'
         AND command = 'bash cli/post-merge-build-dist.sh'`
    ]
  },
  {
    version: 74,
    name: "conversation_integer_timestamps",
    // Guarded DDL/backfill runs post-migration so synthetic older test DBs that
    // omit conversation tables and rewinded current DBs both remain valid.
    statements: []
  },
  {
    version: 75,
    name: "structured_relationship_edges",
    statements: [
      `CREATE TABLE IF NOT EXISTS ledger_relationship_edges (
        id TEXT PRIMARY KEY,
        source_entity_type TEXT NOT NULL CHECK(source_entity_type IN ('issue','comment')),
        source_entity_id TEXT NOT NULL,
        source_project_id TEXT NOT NULL REFERENCES ledger_projects(id) ON DELETE RESTRICT,
        source_issue_id TEXT NOT NULL REFERENCES ledger_issues(id) ON DELETE CASCADE,
        target_entity_type TEXT NOT NULL CHECK(target_entity_type IN ('issue','comment')),
        target_entity_id TEXT NOT NULL,
        target_project_id TEXT NOT NULL REFERENCES ledger_projects(id) ON DELETE RESTRICT,
        target_issue_id TEXT NOT NULL REFERENCES ledger_issues(id) ON DELETE CASCADE,
        link_type TEXT NOT NULL
          CHECK(link_type IN ('parent_child','blocks','duplicate_of','related','references','fixed_by','caused_by','implements','tests')),
        provenance TEXT NOT NULL DEFAULT 'manual'
          CHECK(provenance IN ('manual','imported','derived','system')),
        note TEXT,
        action_id TEXT NOT NULL,
        actor_id TEXT,
        actor_type TEXT NOT NULL
          CHECK(actor_type IN ('mandible_user','agent','system','external_adapter')),
        source TEXT NOT NULL
          CHECK(source IN ('mandible','git_bug','auth_queue','session','work_unit','import','system')),
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER,
        UNIQUE(source_entity_type, source_entity_id, target_entity_type, target_entity_id, link_type)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_ledger_relationship_edges_source
        ON ledger_relationship_edges(source_entity_type, source_entity_id, deleted_at)`,
      `CREATE INDEX IF NOT EXISTS idx_ledger_relationship_edges_source_issue
        ON ledger_relationship_edges(source_issue_id, deleted_at)`,
      `CREATE INDEX IF NOT EXISTS idx_ledger_relationship_edges_target
        ON ledger_relationship_edges(target_entity_type, target_entity_id, deleted_at)`,
      `CREATE INDEX IF NOT EXISTS idx_ledger_relationship_edges_target_issue
        ON ledger_relationship_edges(target_issue_id, deleted_at)`,
      `CREATE INDEX IF NOT EXISTS idx_ledger_relationship_edges_action
        ON ledger_relationship_edges(action_id)`
    ]
  },
  {
    version: 76,
    name: "auth_request_actions",
    statements: [
      `CREATE TABLE IF NOT EXISTS auth_requests (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        type TEXT NOT NULL DEFAULT 'merge',
        command TEXT NOT NULL,
        title TEXT NOT NULL,
        cwd TEXT,
        diff_summary TEXT,
        commit_message TEXT,
        spec_content TEXT,
        repo TEXT,
        base_branch TEXT,
        head_branch TEXT,
        files_changed INTEGER DEFAULT 0,
        additions INTEGER DEFAULT 0,
        deletions INTEGER DEFAULT 0,
        post_merge_handoff TEXT,
        issue_references TEXT,
        issue_closures TEXT,
        issue_ids TEXT,
        issues TEXT,
        depends_on_id TEXT,
        execution_mode TEXT NOT NULL DEFAULT 'daemon',
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_executed_at INTEGER,
        approved_at INTEGER,
        resolved_at INTEGER,
        skipped_at INTEGER,
        expires_at INTEGER NOT NULL,
        exit_code INTEGER,
        output TEXT NOT NULL DEFAULT '',
        error TEXT,
        acknowledged_by TEXT,
        target_session_id TEXT,
        target_repo_root TEXT,
        delivered_at INTEGER,
        conversation_id TEXT,
        approval_source TEXT NOT NULL DEFAULT 'manual',
        approval_lease_id TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_auth_requests_status_created
        ON auth_requests(status, created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_auth_requests_queue
        ON auth_requests(status, skipped_at, created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_auth_requests_target_session
        ON auth_requests(target_session_id) WHERE target_session_id IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS idx_auth_requests_target_repo
        ON auth_requests(target_repo_root) WHERE target_repo_root IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS idx_auth_requests_conversation_id
        ON auth_requests(conversation_id) WHERE conversation_id IS NOT NULL`,
      `CREATE TABLE IF NOT EXISTS auth_request_actions (
        id TEXT PRIMARY KEY,
        auth_request_id TEXT NOT NULL REFERENCES auth_requests(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('comment_add','issue_close','worker_status_set','label_add','label_rm','checkpoint_add','link_add')),
        target_issue_ref TEXT NOT NULL,
        payload TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'staged' CHECK(state IN ('staged','applied','failed','vetoed')),
        target_digest TEXT,
        staged_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        applied_at INTEGER,
        outcome_detail TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_auth_request_actions_request_ordinal
        ON auth_request_actions(auth_request_id, ordinal)`,
      `CREATE INDEX IF NOT EXISTS idx_auth_request_actions_state
        ON auth_request_actions(state, auth_request_id)`
    ]
  },
  {
    version: 77,
    name: "auth_request_actions_skipped_stale_state",
    statements: [
      `CREATE TABLE IF NOT EXISTS auth_request_actions_v77 (
        id TEXT PRIMARY KEY,
        auth_request_id TEXT NOT NULL REFERENCES auth_requests(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('comment_add','issue_close','worker_status_set','label_add','label_rm','checkpoint_add','link_add')),
        target_issue_ref TEXT NOT NULL,
        payload TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'staged' CHECK(state IN ('staged','applied','failed','vetoed','skipped_stale')),
        target_digest TEXT,
        staged_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        applied_at INTEGER,
        outcome_detail TEXT
      )`,
      `INSERT OR IGNORE INTO auth_request_actions_v77 (
        id, auth_request_id, ordinal, kind, target_issue_ref, payload,
        state, target_digest, staged_at, updated_at, applied_at, outcome_detail
      )
      SELECT
        id, auth_request_id, ordinal, kind, target_issue_ref, payload,
        state, target_digest, staged_at, updated_at, applied_at, outcome_detail
      FROM auth_request_actions`,
      `DROP TABLE auth_request_actions`,
      `ALTER TABLE auth_request_actions_v77 RENAME TO auth_request_actions`,
      `CREATE INDEX IF NOT EXISTS idx_auth_request_actions_request_ordinal
        ON auth_request_actions(auth_request_id, ordinal)`,
      `CREATE INDEX IF NOT EXISTS idx_auth_request_actions_state
        ON auth_request_actions(state, auth_request_id)`
    ]
  },
  {
    version: 78,
    name: "dotfiles_agent_instruction_hook",
    // Bug: 64a1f7d — dotfiles merges must refresh compiled agent
    // instructions and repair the home-visible Claude/Codex symlinks.
    statements: [
      `CREATE TABLE IF NOT EXISTS auth_hooks (
        id            TEXT PRIMARY KEY,
        repo_pattern  TEXT NOT NULL DEFAULT '*',
        auth_type     TEXT NOT NULL DEFAULT 'merge',
        command       TEXT NOT NULL,
        label         TEXT NOT NULL DEFAULT '',
        enabled       INTEGER NOT NULL DEFAULT 1,
        builtin       INTEGER NOT NULL DEFAULT 0,
        position      INTEGER NOT NULL DEFAULT 0,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
      )`,
      `INSERT INTO auth_hooks (id, repo_pattern, auth_type, command, label, enabled, builtin, position, created_at, updated_at)
       VALUES (
         'builtin-dotfiles-agent-instructions',
         '.dotfiles',
         'merge',
         'if [[ -x bin/agent-instruction-symlink-doctor ]]; then bash bin/agent-instruction-symlink-doctor; elif [[ -x bin/compile-agent-instructions ]]; then bash bin/compile-agent-instructions; else echo "dotfiles agent instruction hook missing repair script" >&2; exit 1; fi',
         'Compile agent instructions and repair home symlinks',
         1,
         1,
         0,
         CAST(strftime('%s','now') * 1000 AS INTEGER),
         CAST(strftime('%s','now') * 1000 AS INTEGER)
       )
       ON CONFLICT(id) DO UPDATE SET
         repo_pattern = excluded.repo_pattern,
         auth_type = excluded.auth_type,
         command = excluded.command,
         label = excluded.label,
         enabled = excluded.enabled,
         builtin = excluded.builtin,
         position = excluded.position,
         updated_at = excluded.updated_at`,
      `INSERT INTO auth_hooks (id, repo_pattern, auth_type, command, label, enabled, builtin, position, created_at, updated_at)
       VALUES (
         'builtin-dotfiles-agent-instructions-nodot',
         'dotfiles',
         'merge',
         'if [[ -x bin/agent-instruction-symlink-doctor ]]; then bash bin/agent-instruction-symlink-doctor; elif [[ -x bin/compile-agent-instructions ]]; then bash bin/compile-agent-instructions; else echo "dotfiles agent instruction hook missing repair script" >&2; exit 1; fi',
         'Compile agent instructions and repair home symlinks',
         1,
         1,
         0,
         CAST(strftime('%s','now') * 1000 AS INTEGER),
         CAST(strftime('%s','now') * 1000 AS INTEGER)
       )
       ON CONFLICT(id) DO UPDATE SET
         repo_pattern = excluded.repo_pattern,
         auth_type = excluded.auth_type,
         command = excluded.command,
         label = excluded.label,
         enabled = excluded.enabled,
         builtin = excluded.builtin,
         position = excluded.position,
         updated_at = excluded.updated_at`
    ]
  },
  {
    version: 79,
    name: "auth_request_merge_finalizer_identity",
    statements: [
      `UPDATE auth_requests
       SET merge_finalized_at = COALESCE(resolved_at, updated_at, created_at)
       WHERE type = 'merge'
         AND status = 'completed'
         AND exit_code = 0
         AND merge_finalized_at IS NULL`
    ]
  },
  {
    version: 80,
    name: "work_unit_assigned_session_normalization",
    // Some legacy migration tests start from partial schemas that do not yet
    // include work_units. Guard this with a post-migration helper instead of
    // unconditional DDL/DML.
    statements: []
  },
  {
    version: 81,
    name: "work_unit_provider_identity",
    // Bug: 353a3b7 — ambient provider identity for externally dispatched worker archiving.
    // Guarded below for partial legacy schemas.
    statements: []
  },
  {
    version: 82,
    name: "setting_app_theme_default",
    // Issue: cb307ed — App UI theme is separate from shell/dotfiles theme.
    statements: [
      `INSERT OR IGNORE INTO settings (key, value, updated_at)
       VALUES ('app_theme', 'system', CAST(strftime('%s','now') * 1000 AS INTEGER))`
    ]
  },
  {
    version: 83,
    name: "spaces_core",
    // Issue: b395083 (umbrella de56ffa) — Spaces P1' core schema: the "core four"
    // tables for the authored organizing surface, per docs/spaces/UMBRELLA-PLAN.md §3.
    // FIRST link of the serial migration chain (C1 → C11 space_blocks → C13a
    // space_exports); space_blocks/space_exports are intentionally NOT here.
    //
    // Relationship-semantics bright line (UMBRELLA-PLAN §4): these authored edge
    // systems are DISTINCT from the ledger/artifact relationship systems and must
    // never be silently merged:
    //   - ledger_issue_relationships / ledger_relationship_edges → operational/
    //     semantic issue relationships (9 fixed link_type values, issue/comment
    //     endpoints).
    //   - artifact_links → artifact custody/context links.
    //   - space_items / space_occurrences → authored organizing membership +
    //     presentation.
    //   - space_edges → authored local/rhetorical canvas edges (FREE labels,
    //     unlike the fixed ledger link_type set).
    // A space_edge becomes a ledger relationship ONLY via an explicit "promote to
    // ledger relationship" action (writes a ledger_relationship_edges row) — never
    // silent mirroring. Space membership is canonical in space_items and is NOT
    // duplicated into artifact_links.
    //
    // ON DELETE choice — RESTRICT on spaces.project_id is deliberate (matches
    // ledger_issues). Spaces are precious authored state; deleting a project must
    // NOT silently delete its Spaces. Do NOT assume CASCADE here by analogy with
    // lighter project-local tables. The space-INTERNAL cascade (spaces → items /
    // occurrences / edges) is ON DELETE CASCADE: deleting a Space tears down its
    // own contents, which is the intended cleanup.
    //
    // project_id NULLABILITY — `project_id` is NULLABLE (issue 812df41, v86): a
    // top-level / global Space has NO owning project (project_id IS NULL). Existing
    // DBs get this via the v86 rebuild; fresh DBs get it directly from this DDL so
    // the two paths converge on the same schema. RESTRICT still applies to non-NULL
    // project edges.
    //
    // Inline UNIQUE(...) and composite FKs are intentional (review B2/B3/B4): the
    // metadata backup (src/ledger/backup.ts) emits table DDL + rows only and NO
    // standalone CREATE INDEX DDL, so a uniqueness rule that lived only as an
    // external CREATE UNIQUE INDEX would be LOST on backup/restore. Every
    // composite-FK target and membership-uniqueness rule is therefore an inline
    // table-level UNIQUE; only non-unique performance indexes stay as separate
    // CREATE INDEX statements.
    statements: [
      `CREATE TABLE IF NOT EXISTS spaces (
        id               TEXT PRIMARY KEY,
        project_id       TEXT REFERENCES ledger_projects(id) ON DELETE RESTRICT,
        title            TEXT NOT NULL,
        default_renderer TEXT NOT NULL DEFAULT 'canvas'
                           CHECK(default_renderer IN ('canvas','document','board','collection')),
        description      TEXT,
        metadata_json    TEXT NOT NULL DEFAULT '{}'
                           CHECK(json_valid(metadata_json) AND json_type(metadata_json)='object'),
        created_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_spaces_project_updated
        ON spaces(project_id, updated_at DESC)`,
      `CREATE TABLE IF NOT EXISTS space_items (
        id            TEXT NOT NULL,
        space_id      TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
        ref_type      TEXT NOT NULL
                        CHECK(ref_type IN ('issue','comment','artifact','external_ref','space')),
        ref_id        TEXT NOT NULL CHECK(ref_id != ''),
        ref_uri       TEXT,
        title         TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}'
                        CHECK(json_valid(metadata_json) AND json_type(metadata_json)='object'),
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        PRIMARY KEY (id),
        UNIQUE (space_id, id),
        UNIQUE (space_id, ref_type, ref_id),
        CHECK (ref_type != 'external_ref' OR ref_uri IS NOT NULL)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_space_items_lookup
        ON space_items(space_id, ref_type, ref_id)`,
      `CREATE INDEX IF NOT EXISTS idx_space_items_by_ref
        ON space_items(ref_type, ref_id, space_id)`,
      `CREATE TABLE IF NOT EXISTS space_occurrences (
        id            TEXT NOT NULL,
        space_id      TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
        item_id       TEXT,
        renderer      TEXT NOT NULL DEFAULT 'canvas'
                        CHECK(renderer IN ('canvas','board','collection')),
        parent_id     TEXT,
        x             REAL,
        y             REAL,
        width         REAL,
        height        REAL,
        z_index       INTEGER,
        sort_key      TEXT,
        section_id    TEXT,
        note          TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}'
                        CHECK(json_valid(metadata_json) AND json_type(metadata_json)='object'),
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        PRIMARY KEY (id),
        UNIQUE (space_id, id),
        FOREIGN KEY (space_id, item_id)
          REFERENCES space_items(space_id, id) ON DELETE CASCADE,
        FOREIGN KEY (space_id, parent_id)
          REFERENCES space_occurrences(space_id, id) ON DELETE CASCADE
      )`,
      `CREATE INDEX IF NOT EXISTS idx_space_occurrences_render
        ON space_occurrences(space_id, renderer, sort_key)`,
      `CREATE INDEX IF NOT EXISTS idx_space_occurrences_item
        ON space_occurrences(space_id, item_id) WHERE item_id IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS idx_space_occurrences_tree
        ON space_occurrences(space_id, parent_id, sort_key)`,
      `CREATE TABLE IF NOT EXISTS space_edges (
        id            TEXT PRIMARY KEY,
        space_id      TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
        source        TEXT NOT NULL,
        target        TEXT NOT NULL,
        label         TEXT,
        style         TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}'
                        CHECK(json_valid(metadata_json) AND json_type(metadata_json)='object'),
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        FOREIGN KEY (space_id, source)
          REFERENCES space_occurrences(space_id, id) ON DELETE CASCADE,
        FOREIGN KEY (space_id, target)
          REFERENCES space_occurrences(space_id, id) ON DELETE CASCADE
      )`,
      `CREATE INDEX IF NOT EXISTS idx_space_edges_source ON space_edges(space_id, source)`,
      `CREATE INDEX IF NOT EXISTS idx_space_edges_target ON space_edges(space_id, target)`
    ]
  },
  {
    version: 84,
    name: "space_blocks",
    // Issue: d2a8e77 (umbrella de56ffa) — Spaces document/canvas blocks, per
    // docs/spaces/UMBRELLA-PLAN.md §3.5. SECOND link of the serial migration
    // chain (C1 spaces_core → C11 space_blocks → C13a space_exports); this table
    // is intentionally separate from the core-four migration.
    //
    // The block tree is the storage backing for the `spaces-doc.v1` document
    // serialization (C12, src/spaces/serialize.ts): the round-tripped columns
    // (id, parent_id, sort_key, block_type, item_id, markdown) are exactly the
    // C12 DocBlock fields, and `block_type` is kept in lockstep with the C12
    // BLOCK_TYPES list. Do NOT diverge the CHECK set from that list.
    //
    // FK / cascade semantics (review-frozen):
    //   - space_id → spaces(id) ON DELETE CASCADE: deleting a Space tears down
    //     its blocks (same as the core-four space-internal cascade).
    //   - (space_id, parent_id) → space_blocks(space_id, id) ON DELETE CASCADE:
    //     a self-referential block tree, scoped to one Space so cross-space
    //     parent refs are impossible. Parent-CYCLE rejection is enforced in the
    //     route/helper layer (SQLite FKs cannot detect cycles).
    //   - (space_id, item_id) → space_items(space_id, id) ON DELETE RESTRICT:
    //     an item embedded in a block CANNOT be silently deleted. The detach/
    //     degrade operation (drop item_id, preserve item_snapshot_json as a
    //     placeholder) is the only way to remove the embed; see src/ledger/
    //     space-blocks.ts.
    //
    // Snapshot invariant (review2 + codex [Blocker], precedent at the work_units
    // trigger guards above): assigning an item_id REQUIRES a non-null
    // item_snapshot_json so a placeholder always survives the item's deletion.
    // The CHECK(item_id IS NULL OR item_snapshot_json IS NOT NULL) enforces this
    // at the DB level — the Round-3 DDL only validated the snapshot WHEN present,
    // which let item_id be assigned with no snapshot at all.
    //
    // Inline UNIQUE(space_id, id) + composite FKs are intentional (same rationale
    // as the core four): the metadata backup (src/ledger/backup.ts) emits table
    // DDL + rows only and NO standalone CREATE INDEX DDL, so a uniqueness rule
    // that lived only as an external CREATE UNIQUE INDEX would be LOST on
    // backup/restore. Only the non-unique tree-walk performance index stays as a
    // separate CREATE INDEX statement.
    statements: [
      `CREATE TABLE IF NOT EXISTS space_blocks (
        id                 TEXT NOT NULL,
        space_id           TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
        parent_id          TEXT,
        block_type         TEXT NOT NULL
                             CHECK(block_type IN (
                               'heading','paragraph','reference','artifact_embed',
                               'issue_embed','comment_embed','todo'
                             )),
        item_id            TEXT,
        item_snapshot_json TEXT
                             CHECK(item_snapshot_json IS NULL
                               OR (json_valid(item_snapshot_json)
                                   AND json_type(item_snapshot_json)='object')),
        sort_key           TEXT NOT NULL,
        markdown           TEXT NOT NULL DEFAULT '',
        metadata_json      TEXT NOT NULL DEFAULT '{}'
                             CHECK(json_valid(metadata_json) AND json_type(metadata_json)='object'),
        created_at         INTEGER NOT NULL,
        updated_at         INTEGER NOT NULL,
        PRIMARY KEY (id),
        UNIQUE (space_id, id),
        CHECK (item_id IS NULL OR item_snapshot_json IS NOT NULL),
        FOREIGN KEY (space_id, parent_id)
          REFERENCES space_blocks(space_id, id) ON DELETE CASCADE,
        FOREIGN KEY (space_id, item_id)
          REFERENCES space_items(space_id, id) ON DELETE RESTRICT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_space_blocks_tree
        ON space_blocks(space_id, parent_id, sort_key)`,
      `CREATE INDEX IF NOT EXISTS idx_space_blocks_item
        ON space_blocks(space_id, item_id) WHERE item_id IS NOT NULL`
    ]
  },
  {
    version: 85,
    name: "space_exports",
    // Issue: 9041bb3 (umbrella de56ffa) — Spaces document-custody tracking table,
    // per docs/spaces/DOCUMENT-CUSTODY-DESIGN.md §2.1. THIRD link of the serial
    // migration chain (C1 spaces_core → C11 space_blocks → C13a space_exports);
    // this table is intentionally separate from the core-four and blocks migrations.
    //
    // This is the MUTABLE tracking record for a document exported to a repo: the
    // immutable bytes live in `artifacts` rows (last_export / pre_export snapshot),
    // while this row carries the authority (mandible|repo) and drift status
    // (clean|stale|repo_changed|worktree_dirty|conflict). No export/commit backend
    // (C13b), drift detection (C13c), or UI (C13d) ships here — schema + backup only.
    //
    // Repo identity (Round-4 fix, review2 + codex [Blocker]): repo_id references
    // `ledger_project_checkouts.id` (src/db.ts:1014-1024) — a project-scoped,
    // BACKED-UP identity carrying root/name/default_branch/remote_url — NOT
    // `work_repos.id`, which is in REPRODUCIBLE_OR_RUNTIME_TABLES and excluded from
    // backup (src/ledger/backup.ts:70-90). Keying tracking rows to a non-backed-up
    // table would orphan them on restore even though the space_exports row survives.
    //
    // Identity is an INLINE table-level UNIQUE(repo_id, branch, path), NOT an
    // external CREATE UNIQUE INDEX: the metadata backup emits table DDL + INSERTs
    // and NO standalone CREATE INDEX DDL (src/ledger/backup.ts:153,172), so an
    // external unique index would be LOST on backup/restore, silently allowing
    // duplicate tracking rows. Inline UNIQUE survives restore (UMBRELLA-PLAN §3
    // inline-UNIQUE rule, review B3). Only the non-unique perf indexes below stay as
    // separate CREATE INDEX statements.
    statements: [
      `CREATE TABLE IF NOT EXISTS space_exports (
        id                              TEXT PRIMARY KEY,
        space_id                        TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
        repo_id                         TEXT NOT NULL REFERENCES ledger_project_checkouts(id) ON DELETE RESTRICT,
        branch                          TEXT NOT NULL,
        path                            TEXT NOT NULL,
        authority                       TEXT NOT NULL DEFAULT 'mandible'
                                          CHECK(authority IN ('mandible','repo')),
        status                          TEXT NOT NULL DEFAULT 'clean'
                                          CHECK(status IN ('clean','stale','repo_changed','worktree_dirty','conflict')),
        last_export_artifact_id         TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
        pre_export_snapshot_artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
        last_export_commit              TEXT,
        last_export_blob_sha            TEXT,
        last_export_content_sha256      TEXT,
        last_seen_commit                TEXT,
        last_seen_content_sha256        TEXT,
        created_at                      INTEGER NOT NULL,
        updated_at                      INTEGER NOT NULL,
        UNIQUE (repo_id, branch, path)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_space_exports_space
        ON space_exports(space_id)`,
      `CREATE INDEX IF NOT EXISTS idx_space_exports_repo
        ON space_exports(repo_id, branch, path)`
    ]
  },
  {
    version: 86,
    name: "spaces_nullable_project_id",
    // Issue: 812df41 (umbrella de56ffa) — top-level / global Spaces. The C1
    // spaces_core migration declared `spaces.project_id TEXT NOT NULL` so every
    // Space was owned by exactly one project. A top-level Space has NO owning
    // project, so `project_id` must become nullable (NULL = top-level). At-most-
    // one owning project is preserved; cross-project membership is at the item
    // level (space_items is ref-based and project-agnostic), NOT a project M:N.
    //
    // SQLite cannot drop a NOT NULL constraint in place, so the column change is a
    // full table rebuild. Because `spaces` is the parent of FIVE child tables
    // (space_items / space_occurrences / space_edges / space_blocks /
    // space_exports), the rebuild (DROP + RENAME) must run with foreign_keys OFF
    // and a foreign_key_check afterward — which cannot happen inside the migration
    // transaction (PRAGMA foreign_keys is a no-op inside a transaction). The rebuild
    // therefore lives in the `makeSpacesProjectIdNullable` post-migration helper
    // (same mechanism as the v70 ledger_issue_relationship_sources rebuild), gated
    // on the live NOT NULL state so fresh DBs (whose spaces_core already emits the
    // nullable DDL below for new installs) skip it.
    //
    // The rebuilt DDL preserves every spaces_core invariant verbatim EXCEPT the
    // NOT NULL on project_id: the default_renderer CHECK, the object-only
    // metadata_json json_valid CHECK, and the deliberate ON DELETE RESTRICT (a
    // project with Spaces still cannot be silently deleted; a top-level Space has
    // no project edge at all). The performance index idx_spaces_project_updated is
    // recreated. `spaces` stays in METADATA_BACKUP_TABLES (src/ledger/backup.ts):
    // no inline UNIQUE changes, so the backup round-trip is unaffected.
    statements: []
  },
  {
    version: 87,
    name: "ledger_project_key",
    // Issue: 3d85f43 (umbrella ce690eb) — canonical project registry. Adds a
    // stable, human-meaningful `project_key` slug to ledger_projects, distinct
    // from both the free-text `display_name` and the path-derived WorkScanner
    // `work_repo_id`. This is ADDITIVE ONLY: a new column referenced by no
    // foreign key, plus a partial UNIQUE index — no FK column is touched and no
    // row moves, so there is no foreign-key risk. Existing rows get '' here and
    // are backfilled to a deterministic, collision-free key by the idempotent
    // `backfillProjectKeys` post-migration step below (gated on rows still
    // missing a key, so fresh DBs and re-runs are no-ops). Destructive
    // normalization (merging duplicate/mis-keyed projects) is intentionally NOT
    // done here — it lives behind the explicit, guarded `mandible project
    // repair` command (project-registry.ts), which pre-checks short-id/alias
    // collisions and runs PRAGMA foreign_key_check. The ADD COLUMN is performed
    // by the `ensureLedgerProjectKeyColumn` helper gated on this version (so a
    // re-run from an older schema_version, as some migration tests do, is
    // idempotent — `ALTER TABLE ADD COLUMN` cannot be IF NOT EXISTS). The helper
    // also creates the partial UNIQUE index and short-circuits when
    // ledger_projects does not exist (partial legacy DBs that start above the
    // ledger_core migration never create it), so no DDL references a missing
    // table.
    statements: []
  },
  {
    version: 88,
    name: "artifact_versioning",
    // Issue: f7a994e (umbrella ce690eb) — logical artifact identity (series) +
    // version rows over the immutable `artifacts` content rows. ADDITIVE ONLY:
    // two brand-new tables, no FK column on `artifacts` is touched and the
    // `UNIQUE(algorithm, content_hash)` immutability of `artifacts` is intact.
    // `artifact_series` is the stable logical identity (UNIQUE series_key is the
    // "same logical artifact" dedupe anchor). `artifact_versions` pins immutable
    // `artifacts.id` rows under a series (ON DELETE RESTRICT keeps content rows
    // from being orphaned out from under a version); deterministic version ids
    // (PRIMARY KEY) make re-records idempotent, and UNIQUE(series_id, version_no)
    // keeps the per-series sequence well-formed. CREATE TABLE IF NOT EXISTS so
    // fresh DBs (which replay this migration) and existing DBs converge; both
    // tables join METADATA_BACKUP_TABLES (src/ledger/backup.ts) so their rows and
    // inline UNIQUE/FK/CHECK constraints survive a backup round-trip.
    statements: [
      `CREATE TABLE IF NOT EXISTS artifact_series (
        id                TEXT PRIMARY KEY,
        series_key        TEXT NOT NULL,
        source_kind       TEXT NOT NULL DEFAULT 'managed'
          CHECK(source_kind IN ('tracked_repo','local_only','managed','mixed')),
        title             TEXT,
        repo_id           TEXT,
        logical_name      TEXT,
        latest_version_id TEXT,
        version_count     INTEGER NOT NULL DEFAULT 0,
        metadata_json     TEXT NOT NULL DEFAULT '{}',
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL,
        UNIQUE(series_key)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_artifact_series_kind
        ON artifact_series(source_kind)`,
      `CREATE INDEX IF NOT EXISTS idx_artifact_series_repo
        ON artifact_series(repo_id)
        WHERE repo_id IS NOT NULL`,
      `CREATE TABLE IF NOT EXISTS artifact_versions (
        id            TEXT PRIMARY KEY,
        series_id     TEXT NOT NULL REFERENCES artifact_series(id) ON DELETE CASCADE,
        artifact_id   TEXT NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
        version_no    INTEGER NOT NULL,
        source_kind   TEXT NOT NULL
          CHECK(source_kind IN ('tracked_repo','local_only','managed')),
        content_hash  TEXT NOT NULL,
        commit_sha    TEXT,
        repo_path     TEXT,
        observed_path TEXT,
        custody_mode  TEXT,
        label         TEXT,
        note          TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at    INTEGER NOT NULL,
        UNIQUE(series_id, version_no)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_artifact_versions_series
        ON artifact_versions(series_id, version_no DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_artifact_versions_artifact
        ON artifact_versions(artifact_id)`,
      `CREATE INDEX IF NOT EXISTS idx_artifact_versions_hash
        ON artifact_versions(content_hash)`
    ]
  },
  {
    version: 89,
    name: "artifact_link_typed_series",
    // Issue: c154a27 (umbrella 639a848) — lane 1 of "series IS the artifact +
    // dual-typed links". ADDITIVE ONLY: three new columns on `artifact_links`
    // plus a deterministic 1-version series for every series-less artifact. No FK
    // column is touched, no `artifact_links` row is retargeted (every pre-existing
    // row inherits link_kind = 'pinned' via the column DEFAULT and keeps its exact
    // artifact_id), and the `artifacts` UNIQUE(algorithm, content_hash)
    // immutability is intact. `link_kind` distinguishes a PINNED link (to one
    // immutable artifact version — the default) from a LIVING link (tracking a
    // series head); `series_id` is a SOFT reference to artifact_series.id with NO
    // foreign key (a link may name a series that is minted by a later lane, which
    // owns the resolver/link-write lifecycle); `series_ref` carries the
    // human-resolvable series ref. The columns are added by the idempotent
    // `ensureArtifactLinkSeriesColumns` helper gated on this version (ALTER TABLE
    // ADD COLUMN cannot be IF NOT EXISTS, so a schema-rewind re-run — as some
    // migration tests do — must be a no-op), which also creates
    // idx_artifact_links_kind and the partial idx_artifact_links_series.
    // `verifyArtifactLinkSeriesSchema` asserts the live DDL on the real apply path
    // and fails loudly on a divergent pre-existing column set. The orphan-artifact
    // backfill (`backfillOrphanArtifactSeries`) runs as ONE immediate transaction
    // OUTSIDE apply() in the post-migration step below, gated by
    // `hasOrphanArtifacts` so fresh DBs and re-runs are no-ops. `artifact_links`
    // already joins METADATA_BACKUP_TABLES; backup.ts now also emits each backed-up
    // table's secondary indexes so the two new indexes survive a backup restore.
    statements: []
  },
  {
    version: 90,
    name: "space_items_link_space_refs",
    // Issue: 8059130 (umbrella de56ffa) — allow a canvas Space to contain nodes
    // linking to other typed Spaces. The durable model is the existing
    // space_items membership table with ref_type='space', preserving the
    // UNIQUE(space_id, ref_type, ref_id) idempotency contract and the
    // space_occurrences presentation layer. SQLite cannot alter a CHECK in place,
    // so existing DBs rebuild space_items in a post-migration helper; fresh DBs
    // get the expanded CHECK directly from spaces_core above.
    statements: []
  }
];

export function assertMigrationSequence(migrations: readonly Migration[] = MIGRATIONS): void {
  const seen = new Map<number, string>();
  const versions = migrations.map((migration) => migration.version);
  for (const migration of migrations) {
    const previous = seen.get(migration.version);
    if (previous) {
      throw new Error(
        `Duplicate migration version ${migration.version}: ${previous}, ${migration.name}`,
      );
    }
    seen.set(migration.version, migration.name);
  }
  const sorted = [...versions].sort((a, b) => a - b);
  for (let index = 0; index < sorted.length; index += 1) {
    const expected = index + 1;
    if (sorted[index] !== expected) {
      throw new Error(`Migration versions must be contiguous: expected ${expected}, got ${sorted[index]}`);
    }
  }
}

assertMigrationSequence();

export const CURRENT_SCHEMA_VERSION = MIGRATIONS.at(-1)?.version ?? 0;

export function getDbPath(): string {
  return process.env.MANDIBLE_DB ?? DEFAULT_DB_PATH;
}

export function openDb(dbPath: string = getDbPath()): Db {
  // Bug: 727a44b — one-time migration from control-plane to mandible cache dir.
  // If the mandible DB doesn't exist yet but the old control-plane DB does, copy it.
  const shouldAttemptLegacyCopy = !process.env.MANDIBLE_DB && dbPath === DEFAULT_DB_PATH;
  if (!fs.existsSync(dbPath) && shouldAttemptLegacyCopy) {
    const oldPath = path.join(os.homedir(), ".cache", "control-plane", "control-plane.db");
    if (fs.existsSync(oldPath)) {
      ensureDir(path.dirname(dbPath));
      try {
        fs.copyFileSync(oldPath, dbPath);
        // Also copy WAL/SHM if present (preserves in-progress transactions)
        for (const ext of ["-wal", "-shm"]) {
          if (fs.existsSync(oldPath + ext)) {
            fs.copyFileSync(oldPath + ext, dbPath + ext);
          }
        }
      } catch {
        // Non-fatal: if copy fails, start fresh
      }
    }
  }

  ensureDir(path.dirname(dbPath));
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}

export function migrate(db: Db): void {
  assertMigrationSequence();
  db.exec(
    `CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`
  );

  const currentVersion = getSchemaVersion(db);
  const pending = MIGRATIONS.filter((migration) => migration.version > currentVersion);

  if (pending.length > 0) {
    const apply = db.transaction(() => {
      for (const migration of pending) {
        if (migration.version === 71) {
          ensureIssueCoordinationColumns(db);
        }
        if (migration.version === 76) {
          ensureAuthRequestActionPrerequisites(db);
        }
        if (migration.version === 79) {
          ensureAuthRequestMergeFinalizerColumns(db);
        }
        if (migration.version === 87) {
          ensureLedgerProjectKeyColumn(db);
        }
        if (migration.version === 89) {
          ensureArtifactLinkSeriesColumns(db);
        }
        for (const statement of migration.statements) {
          db.exec(statement);
        }
        setMeta(db, SCHEMA_VERSION_KEY, String(migration.version));
      }
    });

    apply();
  }

  // Issue f7a994e (migration 88): the new artifact_series / artifact_versions
  // tables use CREATE TABLE IF NOT EXISTS (idempotent for fresh DBs and
  // schema-rewind re-runs), but IF NOT EXISTS would silently accept a
  // pre-existing divergent table lacking the intended UNIQUE/FK/CHECK
  // constraints while still advancing the schema version. assertMigrationSequence
  // only checks numbering, so verify the live DDL here and fail loudly if a
  // table exists without its expected columns, UNIQUE indexes, and FKs.
  if (pending.some((migration) => migration.version === 88)) {
    verifyArtifactVersioningSchema(db);
  }

  // Issue c154a27 (migration 89): the typed-link columns are added via guarded
  // ALTER TABLE ADD COLUMN, which silently accepts a divergent pre-existing
  // column (e.g. a link_kind added without its CHECK/DEFAULT). Verify the live
  // DDL on the real apply path and fail loudly on drift.
  if (pending.some((migration) => migration.version === 89)) {
    verifyArtifactLinkSeriesSchema(db);
  }

  // Run post-DDL data migrations that require Node.js logic.
  // Bug: e5a945d — batch-compress existing uncompressed content
  if (shouldRunPostMigration(db, "v19_compress_existing_blocks", pending, 19, () =>
    hasUncompressedConversationBlocks(db)
  )) {
    runPostMigration(db, "v19_compress_existing_blocks", () => compressExistingBlocks(db));
  }
  // Bug: 003179f — backfill correct repo names in session_projects
  if (shouldRunPostMigration(db, "v24_backfill_project_repo_names", pending, 24, () =>
    hasLegacySessionProjectWorktreeRepoIds(db)
  )) {
    runPostMigration(db, "v24_backfill_project_repo_names", () => backfillProjectRepoNames(db));
  }
  // Bug: 59492fd — v24 used wrong join condition; v25 corrects remaining rows
  if (shouldRunPostMigration(db, "v25_backfill_project_repo_names_v2", pending, 25, () =>
    hasLegacySessionProjectCwdRepoIds(db)
  )) {
    runPostMigration(db, "v25_backfill_project_repo_names_v2", () => backfillProjectRepoNamesV2(db));
  }
  // Bug: ba9687f — backfill issue_ids from commit_message Bug: trailers
  if (shouldRunPostMigration(db, "v29_backfill_issue_ids", pending, 29, () =>
    hasIssueIdBackfillWork(db)
  )) {
    runPostMigration(db, "v29_backfill_issue_ids", () => backfillIssueIds(db));
  }
  // Bug: 2411ee3 — make migration 36 safe for both fresh DBs and existing DBs.
  if (shouldRunPostMigration(db, "v36_ensure_conversation_block_dag_columns", pending, 36, () =>
    needsConversationBlockDagColumns(db)
  )) {
    runPostMigration(db, "v36_ensure_conversation_block_dag_columns", () => {
      ensureConversationBlockDagColumns(db);
    });
  }
  // Bug: e8c1d43 — link existing work_units to canonical ledger issues.
  if (shouldRunPostMigration(db, "v58_ensure_work_unit_ledger_issue_column", pending, 58, () =>
    needsWorkUnitLedgerIssueColumn(db)
  )) {
    runPostMigration(db, "v58_ensure_work_unit_ledger_issue_column", () => {
      ensureWorkUnitLedgerIssueColumn(db);
    });
  }
  if (shouldRunPostMigration(db, "v80_ensure_work_unit_assigned_session_normalization", pending, 80, () =>
    needsWorkUnitAssignedSessionNormalization(db)
  )) {
    runPostMigration(db, "v80_ensure_work_unit_assigned_session_normalization", () => {
      ensureWorkUnitAssignedSessionNormalization(db);
    });
  }
  if (shouldRunPostMigration(db, "v81_ensure_work_unit_provider_identity", pending, 81, () =>
    needsWorkUnitProviderIdentity(db)
  )) {
    runPostMigration(db, "v81_ensure_work_unit_provider_identity", () => {
      ensureWorkUnitProviderIdentity(db);
    });
  }
  // Bug: 871f32e — add hash-ID display/ordinal columns safely on both fresh
  // and upgraded databases.
  if (shouldRunPostMigration(db, "v61_ensure_ledger_hash_id_columns", pending, 61, () =>
    needsLedgerHashIdColumns(db)
  )) {
    runPostMigration(db, "v61_ensure_ledger_hash_id_columns", () => {
      ensureLedgerHashIdColumns(db);
    });
  }
  if (shouldRunPostMigration(db, "v62_migrate_ledger_event_hash_ids", pending, 62, () =>
    hasLegacyLedgerEventIds(db)
  )) {
    runPostMigration(db, "v62_migrate_ledger_event_hash_ids", () => migrateLedgerEventHashIds(db));
  }
  if (shouldRunPostMigration(db, "v66_ensure_artifact_custody_columns", pending, 66, () =>
    needsArtifactCustodyColumns(db)
  )) {
    runPostMigration(db, "v66_ensure_artifact_custody_columns", () => {
      ensureArtifactCustodyColumns(db);
    });
  }
  if (shouldRunPostMigration(db, "v69_backfill_ledger_body_revisions", pending, 69, () =>
    needsLedgerBodyRevisionBackfill(db)
  )) {
    runPostMigration(db, "v69_backfill_ledger_body_revisions", () => {
      backfillLedgerBodyRevisions(db);
    });
  }
  if (shouldRunPostMigration(
    db,
    "v70_remove_legacy_issue_relationship_source_kinds",
    pending,
    70,
    () => hasLegacyIssueRelationshipSourceKinds(db),
  )) {
    runPostMigration(db, "v70_remove_legacy_issue_relationship_source_kinds", () => {
      removeLegacyIssueRelationshipSourceKinds(db);
    });
  }
  if (shouldRunPostMigration(db, "v74_ensure_conversation_integer_timestamps", pending, 74, () =>
    needsConversationIntegerTimestampWork(db)
  )) {
    runPostMigration(db, "v74_ensure_conversation_integer_timestamps", () => {
      ensureConversationIntegerTimestampColumns(db);
    });
  }
  // Issue: 812df41 — make spaces.project_id nullable (top-level Spaces). Runs as a
  // FK-safe table rebuild (foreign_keys OFF, own transaction, foreign_key_check)
  // because spaces is the parent of five child tables.
  if (shouldRunPostMigration(db, "v86_spaces_nullable_project_id", pending, 86, () =>
    hasNonNullableSpacesProjectId(db)
  )) {
    runPostMigration(db, "v86_spaces_nullable_project_id", () => {
      makeSpacesProjectIdNullable(db);
    });
  }
  // Issue: 3d85f43 — backfill deterministic, collision-free project_key slugs
  // for any ledger_projects row still missing one. Idempotent (gated on rows
  // with project_key = ''), so fresh DBs and re-runs are no-ops.
  if (shouldRunPostMigration(db, "v87_backfill_project_keys", pending, 87, () =>
    hasProjectsMissingKeys(db)
  )) {
    runPostMigration(db, "v87_backfill_project_keys", () => {
      backfillProjectKeys(db);
    });
  }
  // Issue c154a27 (migration 89): wrap every series-less artifact into a
  // deterministic 1-version series so "the series IS the artifact" holds for
  // every pre-existing content row. The backfill AND its post-condition verifier
  // run inside ONE immediate transaction OUTSIDE apply() (the nested
  // appendArtifactVersion runs inline because db.inTransaction is true), so a
  // verify failure ROLLS BACK every backfill write — no committed half-state.
  // The gate is marked complete only by runPostMigration AFTER that transaction
  // commits, so a rolled-back run re-runs on the next startup. Idempotent: gated
  // on hasOrphanArtifacts and on deterministic series/version ids, so fresh DBs
  // and re-runs are no-ops.
  if (shouldRunPostMigration(db, "v89_backfill_orphan_artifact_series", pending, 89, () =>
    hasOrphanArtifacts(db)
  )) {
    runPostMigration(db, "v89_backfill_orphan_artifact_series", () => {
      const before = artifactRowCount(db);
      db.transaction(() => {
        backfillOrphanArtifactSeries(db);
        verifyEveryArtifactHasSeries(db, before);
      }).immediate();
    });
  }
  // Issue 8059130 (migration 90): expand space_items.ref_type to include
  // typed Space links. This is a CHECK-constraint table rebuild, gated on the
  // live DDL so fresh DBs and re-runs are no-ops.
  if (shouldRunPostMigration(db, "v90_space_items_link_space_refs", pending, 90, () =>
    needsSpaceItemsSpaceRefType(db)
  )) {
    runPostMigration(db, "v90_space_items_link_space_refs", () => {
      rebuildSpaceItemsWithSpaceRefType(db);
    });
  }
  // Bug: 3aaf10d — strip leading dots from repo names (.dotfiles → dotfiles)
  if (pending.some((m) => m.version === 26)) {
    const rows = db.prepare(
      "SELECT session_id, repo_id, repo_name FROM session_projects WHERE repo_name LIKE '.%' OR repo_id LIKE '.%'"
    ).all() as Array<{ session_id: string; repo_id: string; repo_name: string }>;

    const update = db.prepare(
      "UPDATE session_projects SET repo_name = ? WHERE session_id = ? AND repo_id = ?"
    );

    for (const row of rows) {
      const fixedName = row.repo_name.replace(/^\.+/, "") || row.repo_name;
      if (fixedName !== row.repo_name) {
        update.run(fixedName, row.session_id, row.repo_id);
      }
    }
  }
}

// --- Singleton accessor for partition code ---

let _db: Db | null = null;

export function getDb(dbPath?: string): Db {
  if (!_db) {
    _db = openDb(dbPath);
  }
  return _db;
}

export function setDb(db: Db): void {
  _db = db;
}

/**
 * Batch-compress all uncompressed conversation_blocks rows.
 * Runs in batches of 500 to avoid holding a long write-lock.
 * Idempotent: only touches rows where compressed=0.
 * Bug: e5a945d
 */
function compressExistingBlocks(db: Db): void {
  const BATCH_SIZE = 500;
  const selectBatch = db.prepare(
    "SELECT id, content FROM conversation_blocks WHERE compressed = 0 LIMIT ?"
  );
  const updateRow = db.prepare(
    "UPDATE conversation_blocks SET content = ?, compressed = 1 WHERE id = ?"
  );

  let totalCompressed = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const rows = selectBatch.all(BATCH_SIZE) as Array<{ id: string; content: string }>;
    if (rows.length === 0) break;

    const batchUpdate = db.transaction(() => {
      for (const row of rows) {
        const compressed = compressContent(row.content);
        updateRow.run(compressed, row.id);
      }
    });

    batchUpdate();
    totalCompressed += rows.length;
  }

  if (totalCompressed > 0) {
    // Log to stderr so daemon startup shows the migration result
    console.error(`[db] Compressed ${totalCompressed} conversation blocks`);
  }
}

function hasUncompressedConversationBlocks(db: Db): boolean {
  if (!tableExists(db, "conversation_blocks")) return false;
  const names = tableColumnNames(db, "conversation_blocks");
  if (!names.has("id") || !names.has("content") || !names.has("compressed")) return false;
  const row = db.prepare("SELECT 1 FROM conversation_blocks WHERE compressed = 0 LIMIT 1").get();
  return Boolean(row);
}

function ensureConversationBlockDagColumns(db: Db): void {
  if (!tableExists(db, "conversation_blocks")) return;
  const columns = db
    .prepare("PRAGMA table_info(conversation_blocks)")
    .all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));

  if (!names.has("dag_uuid")) {
    db.exec("ALTER TABLE conversation_blocks ADD COLUMN dag_uuid TEXT");
  }
  if (!names.has("dag_parent_uuid")) {
    db.exec("ALTER TABLE conversation_blocks ADD COLUMN dag_parent_uuid TEXT");
  }
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_blocks_dag_parent
      ON conversation_blocks(conversation_id, dag_parent_uuid)
      WHERE dag_parent_uuid IS NOT NULL`
  );
}

function needsConversationBlockDagColumns(db: Db): boolean {
  if (!tableExists(db, "conversation_blocks")) return false;
  const names = tableColumnNames(db, "conversation_blocks");
  return !names.has("dag_uuid")
    || !names.has("dag_parent_uuid")
    || !indexExists(db, "idx_blocks_dag_parent");
}

function ensureConversationIntegerTimestampColumns(db: Db): void {
  if (tableExists(db, "conversations")) {
    const names = tableColumnNames(db, "conversations");
    if (!names.has("started_at_ms")) {
      db.exec("ALTER TABLE conversations ADD COLUMN started_at_ms INTEGER");
    }
    if (!names.has("ended_at_ms")) {
      db.exec("ALTER TABLE conversations ADD COLUMN ended_at_ms INTEGER");
    }
    if (!names.has("created_at_ms")) {
      db.exec("ALTER TABLE conversations ADD COLUMN created_at_ms INTEGER");
    }
    if (!names.has("updated_at_ms")) {
      db.exec("ALTER TABLE conversations ADD COLUMN updated_at_ms INTEGER");
    }
    db.exec(
      `UPDATE conversations
       SET started_at_ms = CASE
             WHEN started_at NOT GLOB '*[^0-9]*' THEN CAST(started_at AS INTEGER)
             ELSE CAST(strftime('%s', started_at) * 1000 AS INTEGER)
           END
       WHERE started_at_ms IS NULL AND started_at IS NOT NULL AND started_at != ''`,
    );
    db.exec(
      `UPDATE conversations
       SET ended_at_ms = CASE
             WHEN ended_at NOT GLOB '*[^0-9]*' THEN CAST(ended_at AS INTEGER)
             ELSE CAST(strftime('%s', ended_at) * 1000 AS INTEGER)
           END
       WHERE ended_at_ms IS NULL AND ended_at IS NOT NULL AND ended_at != ''`,
    );
    db.exec(
      `UPDATE conversations
       SET created_at_ms = CASE
             WHEN created_at NOT GLOB '*[^0-9]*' THEN CAST(created_at AS INTEGER)
             ELSE CAST(strftime('%s', created_at) * 1000 AS INTEGER)
           END
       WHERE created_at_ms IS NULL AND created_at IS NOT NULL AND created_at != ''`,
    );
    db.exec(
      `UPDATE conversations
       SET updated_at_ms = CASE
             WHEN updated_at NOT GLOB '*[^0-9]*' THEN CAST(updated_at AS INTEGER)
             ELSE CAST(strftime('%s', updated_at) * 1000 AS INTEGER)
           END
       WHERE updated_at_ms IS NULL AND updated_at IS NOT NULL AND updated_at != ''`,
    );
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_conv_started_ms
        ON conversations(started_at_ms) WHERE started_at_ms IS NOT NULL`,
    );
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_conv_ended_ms
        ON conversations(ended_at_ms) WHERE ended_at_ms IS NOT NULL`,
    );
  }

  if (tableExists(db, "conversation_blocks")) {
    const names = tableColumnNames(db, "conversation_blocks");
    if (!names.has("timestamp_ms")) {
      db.exec("ALTER TABLE conversation_blocks ADD COLUMN timestamp_ms INTEGER");
    }
    db.exec(
      `UPDATE conversation_blocks
       SET timestamp_ms = CASE
             WHEN timestamp NOT GLOB '*[^0-9]*' THEN CAST(timestamp AS INTEGER)
             ELSE CAST(strftime('%s', timestamp) * 1000 AS INTEGER)
           END
       WHERE timestamp_ms IS NULL AND timestamp IS NOT NULL AND timestamp != ''`,
    );
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_blocks_timestamp_ms
        ON conversation_blocks(timestamp_ms) WHERE timestamp_ms IS NOT NULL`,
    );
  }
}

function needsConversationIntegerTimestampWork(db: Db): boolean {
  if (tableExists(db, "conversations")) {
    const names = tableColumnNames(db, "conversations");
    if (
      !names.has("started_at_ms")
      || !names.has("ended_at_ms")
      || !names.has("created_at_ms")
      || !names.has("updated_at_ms")
      || !indexExists(db, "idx_conv_started_ms")
      || !indexExists(db, "idx_conv_ended_ms")
    ) {
      return true;
    }
    const row = db.prepare(
      `SELECT 1 FROM conversations
       WHERE (started_at_ms IS NULL AND started_at IS NOT NULL AND started_at != '')
          OR (ended_at_ms IS NULL AND ended_at IS NOT NULL AND ended_at != '')
          OR (created_at_ms IS NULL AND created_at IS NOT NULL AND created_at != '')
          OR (updated_at_ms IS NULL AND updated_at IS NOT NULL AND updated_at != '')
       LIMIT 1`,
    ).get();
    if (row) return true;
  }

  if (tableExists(db, "conversation_blocks")) {
    const names = tableColumnNames(db, "conversation_blocks");
    if (!names.has("timestamp_ms") || !indexExists(db, "idx_blocks_timestamp_ms")) {
      return true;
    }
    const row = db.prepare(
      `SELECT 1 FROM conversation_blocks
       WHERE timestamp_ms IS NULL AND timestamp IS NOT NULL AND timestamp != ''
       LIMIT 1`,
    ).get();
    if (row) return true;
  }

  return false;
}

function ensureWorkUnitLedgerIssueColumn(db: Db): void {
  const table = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'work_units'")
    .get();
  if (!table) return;

  const columns = db
    .prepare("PRAGMA table_info(work_units)")
    .all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));

  if (!names.has("ledger_issue_id")) {
    db.exec("ALTER TABLE work_units ADD COLUMN ledger_issue_id TEXT REFERENCES ledger_issues(id)");
  }
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_work_units_ledger_issue
      ON work_units(ledger_issue_id) WHERE ledger_issue_id IS NOT NULL`
  );
}

function needsWorkUnitLedgerIssueColumn(db: Db): boolean {
  if (!tableExists(db, "work_units")) return false;
  const names = tableColumnNames(db, "work_units");
  return !names.has("ledger_issue_id") || !indexExists(db, "idx_work_units_ledger_issue");
}

function ensureWorkUnitAssignedSessionNormalization(db: Db): void {
  if (!tableExists(db, "work_units")) return;
  db.exec(
    `UPDATE work_units
     SET assigned_session_id = NULL
     WHERE assigned_session_id IS NOT NULL
       AND trim(assigned_session_id) = ''`
  );
  db.exec(
    `CREATE TRIGGER IF NOT EXISTS trg_work_units_assigned_session_insert_normalize
     AFTER INSERT ON work_units
     WHEN NEW.assigned_session_id IS NOT NULL AND trim(NEW.assigned_session_id) = ''
     BEGIN
       UPDATE work_units SET assigned_session_id = NULL WHERE id = NEW.id;
     END`
  );
  db.exec(
    `CREATE TRIGGER IF NOT EXISTS trg_work_units_assigned_session_update_normalize
     AFTER UPDATE OF assigned_session_id ON work_units
     WHEN NEW.assigned_session_id IS NOT NULL AND trim(NEW.assigned_session_id) = ''
     BEGIN
       UPDATE work_units SET assigned_session_id = NULL WHERE id = NEW.id;
     END`
  );
}

function needsWorkUnitAssignedSessionNormalization(db: Db): boolean {
  if (!tableExists(db, "work_units")) return false;
  const emptyRow = db.prepare(
    `SELECT 1 FROM work_units
     WHERE assigned_session_id IS NOT NULL
       AND trim(assigned_session_id) = ''
     LIMIT 1`
  ).get();
  return Boolean(emptyRow) ||
    !triggerExists(db, "trg_work_units_assigned_session_insert_normalize") ||
    !triggerExists(db, "trg_work_units_assigned_session_update_normalize");
}

function ensureWorkUnitProviderIdentity(db: Db): void {
  if (!tableExists(db, "work_units")) return;
  const names = tableColumnNames(db, "work_units");
  if (!names.has("provider")) {
    db.exec("ALTER TABLE work_units ADD COLUMN provider TEXT");
  }
  if (!names.has("provider_session_id")) {
    db.exec("ALTER TABLE work_units ADD COLUMN provider_session_id TEXT");
  }
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_work_units_provider_session
      ON work_units(provider, provider_session_id)
      WHERE provider IS NOT NULL AND provider_session_id IS NOT NULL`
  );
}

function needsWorkUnitProviderIdentity(db: Db): boolean {
  if (!tableExists(db, "work_units")) return false;
  const names = tableColumnNames(db, "work_units");
  return !names.has("provider") ||
    !names.has("provider_session_id") ||
    !indexExists(db, "idx_work_units_provider_session");
}

function ensureLedgerHashIdColumns(db: Db): void {
  const issueTable = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ledger_issues'")
    .get();
  if (issueTable) {
    const columns = db
      .prepare("PRAGMA table_info(ledger_issues)")
      .all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    if (!names.has("short_id")) {
      db.exec("ALTER TABLE ledger_issues ADD COLUMN short_id TEXT NOT NULL DEFAULT ''");
    }
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_issues_project_short_id
        ON ledger_issues(project_id, short_id)
        WHERE short_id != ''`
    );
  }

  const commentTable = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ledger_comments'")
    .get();
  if (commentTable) {
    const columns = db
      .prepare("PRAGMA table_info(ledger_comments)")
      .all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    if (!names.has("ordinal")) {
      db.exec("ALTER TABLE ledger_comments ADD COLUMN ordinal INTEGER NOT NULL DEFAULT 0");
    }
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_comments_issue_ordinal
        ON ledger_comments(issue_id, ordinal)
        WHERE ordinal > 0`
    );
  }
}

function needsLedgerHashIdColumns(db: Db): boolean {
  if (tableExists(db, "ledger_issues")) {
    const names = tableColumnNames(db, "ledger_issues");
    if (!names.has("short_id") || !indexExists(db, "idx_ledger_issues_project_short_id")) {
      return true;
    }
  }
  if (tableExists(db, "ledger_comments")) {
    const names = tableColumnNames(db, "ledger_comments");
    if (!names.has("ordinal") || !indexExists(db, "idx_ledger_comments_issue_ordinal")) {
      return true;
    }
  }
  return false;
}

function ensureArtifactCustodyColumns(db: Db): void {
  const table = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'artifacts'")
    .get();
  if (!table) {
    db.exec(
      `CREATE TABLE IF NOT EXISTS artifacts (
        id                 TEXT PRIMARY KEY,
        algorithm          TEXT NOT NULL DEFAULT 'sha256',
        content_hash       TEXT NOT NULL,
        uri                TEXT NOT NULL,
        media_type         TEXT,
        role               TEXT,
        size_bytes         INTEGER NOT NULL DEFAULT 0,
        provider_id        TEXT,
        manifest_id        TEXT,
        metadata_json      TEXT NOT NULL DEFAULT '{}',
        pinned             INTEGER NOT NULL DEFAULT 1,
        custody_mode       TEXT NOT NULL DEFAULT 'managed'
          CHECK(custody_mode IN ('link','copy','managed','external')),
        home_repo_id       TEXT,
        repo_locator_json  TEXT NOT NULL DEFAULT '{}',
        availability       TEXT NOT NULL DEFAULT 'unchecked'
          CHECK(availability IN ('present','missing','stale','unchecked','remote_only','pinned')),
        retention_json     TEXT NOT NULL DEFAULT '{}',
        reference_json     TEXT NOT NULL DEFAULT '{}',
        created_at         INTEGER NOT NULL,
        UNIQUE(algorithm, content_hash)
      )`
    );
  }

  const columns = db
    .prepare("PRAGMA table_info(artifacts)")
    .all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));

  if (!names.has("custody_mode")) {
    db.exec(
      `ALTER TABLE artifacts ADD COLUMN custody_mode TEXT NOT NULL DEFAULT 'managed'
        CHECK(custody_mode IN ('link','copy','managed','external'))`
    );
  }
  if (!names.has("home_repo_id")) {
    db.exec("ALTER TABLE artifacts ADD COLUMN home_repo_id TEXT");
  }
  if (!names.has("repo_locator_json")) {
    db.exec("ALTER TABLE artifacts ADD COLUMN repo_locator_json TEXT NOT NULL DEFAULT '{}'");
  }
  if (!names.has("availability")) {
    db.exec(
      `ALTER TABLE artifacts ADD COLUMN availability TEXT NOT NULL DEFAULT 'unchecked'
        CHECK(availability IN ('present','missing','stale','unchecked','remote_only','pinned'))`
    );
  }
  if (!names.has("retention_json")) {
    db.exec("ALTER TABLE artifacts ADD COLUMN retention_json TEXT NOT NULL DEFAULT '{}'");
  }
  if (!names.has("reference_json")) {
    db.exec("ALTER TABLE artifacts ADD COLUMN reference_json TEXT NOT NULL DEFAULT '{}'");
  }

  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_artifacts_provider
      ON artifacts(provider_id)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_artifacts_role
      ON artifacts(role)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_artifacts_home_repo
      ON artifacts(home_repo_id)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_artifacts_custody
      ON artifacts(custody_mode, availability)`
  );
}

function needsArtifactCustodyColumns(db: Db): boolean {
  if (!tableExists(db, "artifacts")) return true;
  const names = tableColumnNames(db, "artifacts");
  return !names.has("custody_mode")
    || !names.has("home_repo_id")
    || !names.has("repo_locator_json")
    || !names.has("availability")
    || !names.has("retention_json")
    || !names.has("reference_json")
    || !indexExists(db, "idx_artifacts_provider")
    || !indexExists(db, "idx_artifacts_role")
    || !indexExists(db, "idx_artifacts_home_repo")
    || !indexExists(db, "idx_artifacts_custody");
}

function backfillLedgerBodyRevisions(db: Db): void {
  const table = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ledger_body_revisions'")
    .get();
  if (!table) return;

  const now = Date.now();
  const metadataJson = JSON.stringify({
    historical_completeness: "current_only",
    synthetic: true,
  });
  const insert = db.prepare(
    `INSERT OR IGNORE INTO ledger_body_revisions (
      id, entity_type, entity_id, issue_id, project_id, revision_no, event_id,
      actor_id, actor_type, source, reason, occurred_at, observed_at,
      base_revision_id, base_hash, new_hash, snapshot_body, patch_format,
      patch_text, metadata_json, redacted_at, redacted_by_actor_id, redaction_reason
    ) VALUES (
      @id, @entity_type, @entity_id, @issue_id, @project_id, 1, NULL,
      @actor_id, @actor_type, @source, 'migration_snapshot', @occurred_at, @observed_at,
      NULL, NULL, @new_hash, @snapshot_body, NULL, NULL, @metadata_json, NULL, NULL, NULL
    )`,
  );

  const issues = db.prepare(
    `SELECT id, project_id, body, author_actor_id, author_actor_type, source, created_at
     FROM ledger_issues
     WHERE deleted_at IS NULL`,
  ).all() as Array<{
    id: string;
    project_id: string;
    body: string;
    author_actor_id: string | null;
    author_actor_type: string;
    source: string;
    created_at: number;
  }>;
  const comments = db.prepare(
    `SELECT c.id, c.issue_id, i.project_id, c.body, c.author_actor_id,
            c.author_actor_type, c.source, c.created_at
     FROM ledger_comments c
     JOIN ledger_issues i ON i.id = c.issue_id
     WHERE c.deleted_at IS NULL`,
  ).all() as Array<{
    id: string;
    issue_id: string;
    project_id: string;
    body: string;
    author_actor_id: string | null;
    author_actor_type: string;
    source: string;
    created_at: number;
  }>;

  const run = db.transaction(() => {
    for (const issue of issues) {
      const body = issue.body ?? "";
      insert.run({
        id: stableMigrationRevisionId("issue_body", issue.id),
        entity_type: "issue_body",
        entity_id: issue.id,
        issue_id: issue.id,
        project_id: issue.project_id,
        actor_id: issue.author_actor_id,
        actor_type: issue.author_actor_type || "external_adapter",
        source: issue.source || "import",
        occurred_at: issue.created_at || now,
        observed_at: now,
        new_hash: bodyHash(body),
        snapshot_body: body,
        metadata_json: metadataJson,
      });
    }
    for (const comment of comments) {
      const body = comment.body ?? "";
      insert.run({
        id: stableMigrationRevisionId("comment_body", comment.id),
        entity_type: "comment_body",
        entity_id: comment.id,
        issue_id: comment.issue_id,
        project_id: comment.project_id,
        actor_id: comment.author_actor_id,
        actor_type: comment.author_actor_type || "external_adapter",
        source: comment.source || "import",
        occurred_at: comment.created_at || now,
        observed_at: now,
        new_hash: bodyHash(body),
        snapshot_body: body,
        metadata_json: metadataJson,
      });
    }
  });
  run();
}

function needsLedgerBodyRevisionBackfill(db: Db): boolean {
  if (!tableExists(db, "ledger_body_revisions")) return false;
  if (tableExists(db, "ledger_issues")) {
    const names = tableColumnNames(db, "ledger_issues");
    if (names.has("id") && names.has("deleted_at")) {
      const issues = db.prepare(
        `SELECT id FROM ledger_issues
         WHERE deleted_at IS NULL`,
      ).all() as Array<{ id: string }>;
      const revision = db.prepare(
        "SELECT 1 FROM ledger_body_revisions WHERE id = ? LIMIT 1",
      );
      for (const issue of issues) {
        if (!revision.get(stableMigrationRevisionId("issue_body", issue.id))) {
          return true;
        }
      }
    }
  }
  if (tableExists(db, "ledger_comments")) {
    const names = tableColumnNames(db, "ledger_comments");
    if (names.has("id") && names.has("deleted_at")) {
      const comments = db.prepare(
        `SELECT id FROM ledger_comments
         WHERE deleted_at IS NULL`,
      ).all() as Array<{ id: string }>;
      const revision = db.prepare(
        "SELECT 1 FROM ledger_body_revisions WHERE id = ? LIMIT 1",
      );
      for (const comment of comments) {
        if (!revision.get(stableMigrationRevisionId("comment_body", comment.id))) {
          return true;
        }
      }
    }
  }
  return false;
}

function stableMigrationRevisionId(entityType: string, entityId: string): string {
  const hash = createHash("sha256")
    .update(`mandible.body_revision.migration.v1:${entityType}:${entityId}`)
    .digest("hex");
  return `rev_${hash.slice(0, 10)}_${hash.slice(10, 30)}`;
}

function bodyHash(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

function removeLegacyIssueRelationshipSourceKinds(db: Db): void {
  const table = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ledger_issue_relationship_sources'")
    .get();
  if (!table) return;

  const previousForeignKeys = db.pragma("foreign_keys", { simple: true }) as number;
  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      db.exec("DROP TABLE IF EXISTS ledger_issue_relationship_sources_old_refkind");
      db.exec("ALTER TABLE ledger_issue_relationship_sources RENAME TO ledger_issue_relationship_sources_old_refkind");
      db.exec(
        `CREATE TABLE ledger_issue_relationship_sources (
          id TEXT PRIMARY KEY,
          relationship_id TEXT NOT NULL REFERENCES ledger_issue_relationships(id) ON DELETE CASCADE,
          source_entity_type TEXT NOT NULL CHECK(source_entity_type IN ('issue_body','comment')),
          source_entity_id TEXT NOT NULL,
          source_issue_id TEXT NOT NULL REFERENCES ledger_issues(id) ON DELETE CASCADE,
          target_issue_id TEXT NOT NULL REFERENCES ledger_issues(id) ON DELETE CASCADE,
          relationship_type TEXT NOT NULL
            CHECK(relationship_type IN ('parent_child','blocks','duplicate_of','related','references','fixed_by','caused_by','implements','tests')),
          ref_kind TEXT NOT NULL CHECK(ref_kind IN ('issue','comment')),
          raw_ref TEXT NOT NULL,
          normalized_ref TEXT NOT NULL,
          metadata_json TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          deleted_at INTEGER,
          UNIQUE(source_entity_type, source_entity_id, target_issue_id, relationship_type, ref_kind, normalized_ref)
        )`,
      );
      db.exec(
        `INSERT INTO ledger_issue_relationship_sources (
          id, relationship_id, source_entity_type, source_entity_id,
          source_issue_id, target_issue_id, relationship_type, ref_kind,
          raw_ref, normalized_ref, metadata_json, created_at, updated_at, deleted_at
        )
        SELECT
          id, relationship_id, source_entity_type, source_entity_id,
          source_issue_id, target_issue_id, relationship_type, ref_kind,
          raw_ref, normalized_ref, metadata_json, created_at, updated_at, deleted_at
        FROM ledger_issue_relationship_sources_old_refkind
        WHERE ref_kind IN ('issue','comment')`,
      );
      db.exec("DROP TABLE ledger_issue_relationship_sources_old_refkind");
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_ledger_relationship_sources_relationship
          ON ledger_issue_relationship_sources(relationship_id)`,
      );
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_ledger_relationship_sources_source
          ON ledger_issue_relationship_sources(source_entity_type, source_entity_id)`,
      );
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_ledger_relationship_sources_target
          ON ledger_issue_relationship_sources(target_issue_id)`,
      );
    })();
  } finally {
    if (previousForeignKeys) {
      db.pragma("foreign_keys = ON");
    }
  }

  const violations = db.prepare("PRAGMA foreign_key_check").all();
  if (violations.length > 0) {
    throw new Error(`Legacy issue ref-kind migration left ${violations.length} foreign key violations`);
  }
}

function hasLegacyIssueRelationshipSourceKinds(db: Db): boolean {
  const table = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ledger_issue_relationship_sources'")
    .get();
  if (!table) return false;
  const row = db
    .prepare(
      "SELECT 1 FROM ledger_issue_relationship_sources WHERE ref_kind NOT IN ('issue','comment') LIMIT 1",
    )
    .get();
  return Boolean(row);
}

/**
 * Issue 812df41 — true when the live `spaces` table still has a NOT NULL
 * `project_id` (the pre-v86 spaces_core shape). Fresh DBs created from the updated
 * spaces_core DDL already emit a nullable column, so this is false for them and the
 * rebuild is skipped. Absent table → false (a partial-schema test fixture).
 */
function hasNonNullableSpacesProjectId(db: Db): boolean {
  const table = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'spaces'")
    .get();
  if (!table) return false;
  const columns = db.prepare("PRAGMA table_info(spaces)").all() as Array<{
    name: string;
    notnull: number;
  }>;
  const projectId = columns.find((column) => column.name === "project_id");
  return Boolean(projectId && projectId.notnull === 1);
}

/**
 * Issue 812df41 — rebuild `spaces` with a NULLABLE `project_id` (top-level /
 * global Spaces). SQLite cannot drop a NOT NULL in place, so this is a full
 * DROP + RENAME rebuild. `spaces` is the parent of five child tables, so the
 * rebuild runs with foreign_keys OFF inside its own transaction and verifies
 * with a foreign_key_check afterward — the same FK-safe mechanism the v70
 * ledger_issue_relationship_sources rebuild uses. Every spaces_core invariant is
 * preserved verbatim except the NOT NULL: default_renderer CHECK, object-only
 * metadata_json json_valid CHECK, ON DELETE RESTRICT on project_id, and the
 * idx_spaces_project_updated performance index.
 */
function makeSpacesProjectIdNullable(db: Db): void {
  if (!hasNonNullableSpacesProjectId(db)) return;

  const previousForeignKeys = db.pragma("foreign_keys", { simple: true }) as number;
  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      db.exec("DROP TABLE IF EXISTS spaces_v86");
      db.exec(
        `CREATE TABLE spaces_v86 (
          id               TEXT PRIMARY KEY,
          project_id       TEXT REFERENCES ledger_projects(id) ON DELETE RESTRICT,
          title            TEXT NOT NULL,
          default_renderer TEXT NOT NULL DEFAULT 'canvas'
                             CHECK(default_renderer IN ('canvas','document','board','collection')),
          description      TEXT,
          metadata_json    TEXT NOT NULL DEFAULT '{}'
                             CHECK(json_valid(metadata_json) AND json_type(metadata_json)='object'),
          created_at       INTEGER NOT NULL,
          updated_at       INTEGER NOT NULL
        )`,
      );
      db.exec(
        `INSERT INTO spaces_v86 (
          id, project_id, title, default_renderer, description,
          metadata_json, created_at, updated_at
        )
        SELECT
          id, project_id, title, default_renderer, description,
          metadata_json, created_at, updated_at
        FROM spaces`,
      );
      db.exec("DROP TABLE spaces");
      db.exec("ALTER TABLE spaces_v86 RENAME TO spaces");
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_spaces_project_updated
          ON spaces(project_id, updated_at DESC)`,
      );
    })();
  } finally {
    if (previousForeignKeys) {
      db.pragma("foreign_keys = ON");
    }
  }

  const violations = db.prepare("PRAGMA foreign_key_check").all();
  if (violations.length > 0) {
    throw new Error(
      `spaces nullable project_id migration left ${violations.length} foreign key violations`,
    );
  }
}

/**
 * Issue 8059130 — true when `space_items.ref_type` still has the pre-v90 CHECK
 * set that excludes typed Space links. Fresh DBs created from the updated
 * spaces_core DDL already include 'space', so this returns false for them.
 */
function needsSpaceItemsSpaceRefType(db: Db): boolean {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'space_items'")
    .get() as { sql: string } | undefined;
  if (!row) return false;
  return !row.sql.includes("'space'");
}

/**
 * Issue 8059130 — rebuild `space_items` with `ref_type='space'` accepted by the
 * inline CHECK. This preserves every other spaces_core invariant, including the
 * inline UNIQUE constraints required by metadata backup/restore and the
 * external_ref ref_uri CHECK. Child tables reference (space_id, id), so the
 * rebuild follows the FK-safe foreign_keys OFF + foreign_key_check pattern used
 * by the v86 spaces rebuild.
 */
function rebuildSpaceItemsWithSpaceRefType(db: Db): void {
  if (!needsSpaceItemsSpaceRefType(db)) return;

  const previousForeignKeys = db.pragma("foreign_keys", { simple: true }) as number;
  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      db.exec("DROP TABLE IF EXISTS space_items_v90");
      db.exec(
        `CREATE TABLE space_items_v90 (
          id            TEXT NOT NULL,
          space_id      TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
          ref_type      TEXT NOT NULL
                          CHECK(ref_type IN ('issue','comment','artifact','external_ref','space')),
          ref_id        TEXT NOT NULL CHECK(ref_id != ''),
          ref_uri       TEXT,
          title         TEXT,
          metadata_json TEXT NOT NULL DEFAULT '{}'
                          CHECK(json_valid(metadata_json) AND json_type(metadata_json)='object'),
          created_at    INTEGER NOT NULL,
          updated_at    INTEGER NOT NULL,
          PRIMARY KEY (id),
          UNIQUE (space_id, id),
          UNIQUE (space_id, ref_type, ref_id),
          CHECK (ref_type != 'external_ref' OR ref_uri IS NOT NULL)
        )`,
      );
      db.exec(
        `INSERT INTO space_items_v90 (
          id, space_id, ref_type, ref_id, ref_uri, title,
          metadata_json, created_at, updated_at
        )
        SELECT
          id, space_id, ref_type, ref_id, ref_uri, title,
          metadata_json, created_at, updated_at
        FROM space_items`,
      );
      db.exec("DROP TABLE space_items");
      db.exec("ALTER TABLE space_items_v90 RENAME TO space_items");
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_space_items_lookup
          ON space_items(space_id, ref_type, ref_id)`,
      );
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_space_items_by_ref
          ON space_items(ref_type, ref_id, space_id)`,
      );
    })();
  } finally {
    if (previousForeignKeys) {
      db.pragma("foreign_keys = ON");
    }
  }

  const violations = db.prepare("PRAGMA foreign_key_check").all();
  if (violations.length > 0) {
    throw new Error(
      `space_items linked-space migration left ${violations.length} foreign key violations`,
    );
  }
}

function migrateLedgerEventHashIds(db: Db): void {
  const table = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ledger_events'")
    .get();
  if (!table) return;

  const rows = db.prepare(
    `SELECT id, entity_type, entity_id, event_type, actor_id, actor_type,
            source, payload_json, occurred_at, observed_at
       FROM ledger_events
      ORDER BY occurred_at, observed_at, id`,
  ).all() as Array<{
    id: string;
    entity_type: string;
    entity_id: string;
    event_type: string;
    actor_id: string | null;
    actor_type: string;
    source: string;
    payload_json: string;
    occurred_at: number;
    observed_at: number;
  }>;
  if (rows.length === 0) return;

  const updates = rows.map((row) => {
    const payload = parseJsonRecord(row.payload_json);
    const eventType = migratedEventType(row.event_type, payload);
    const legacyEventId = isSha256Hex(row.id) ? null : row.id;
    const nextPayload = legacyEventId && !("legacy_event_id" in payload)
      ? { ...payload, legacy_event_id: legacyEventId }
      : payload;
    const nextId = createStableEventId({
      entity_type: row.entity_type,
      entity_id: row.entity_id,
      event_type: eventType,
      actor_id: row.actor_id,
      actor_type: row.actor_type,
      source: row.source,
      payload: nextPayload,
      occurred_at: row.occurred_at,
      observed_at: row.observed_at,
      occurrence: legacyEventId ?? `migration:${row.id}`,
    });
    return {
      oldId: row.id,
      nextId,
      eventType,
      payloadJson: JSON.stringify(nextPayload),
    };
  });

  const seen = new Set<string>();
  for (const update of updates) {
    if (seen.has(update.nextId)) {
      throw new Error(`Ledger event ID migration collision for ${update.oldId}`);
    }
    seen.add(update.nextId);
  }

  const previousForeignKeys = db.pragma("foreign_keys", { simple: true }) as number;
  db.pragma("foreign_keys = OFF");
  try {
    const run = db.transaction(() => {
      const updateEvent = db.prepare(
        "UPDATE ledger_events SET id = ?, event_type = ?, payload_json = ? WHERE id = ?",
      );
      const updateOutbox = db.prepare("UPDATE ledger_outbox SET event_id = ? WHERE event_id = ?");
      const hasBodyRevisions = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ledger_body_revisions'")
        .get();
      const updateBodyRevision = hasBodyRevisions
        ? db.prepare("UPDATE ledger_body_revisions SET event_id = ? WHERE event_id = ?")
        : null;
      for (const update of updates) {
        updateEvent.run(update.nextId, update.eventType, update.payloadJson, update.oldId);
        updateOutbox.run(update.nextId, update.oldId);
        updateBodyRevision?.run(update.nextId, update.oldId);
      }
    });
    run();
  } finally {
    if (previousForeignKeys) {
      db.pragma("foreign_keys = ON");
    }
  }

  const violations = db.prepare("PRAGMA foreign_key_check").all();
  if (violations.length > 0) {
    throw new Error(`Ledger event ID migration left ${violations.length} foreign key violations`);
  }
}

function hasLegacyLedgerEventIds(db: Db): boolean {
  const table = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ledger_events'")
    .get();
  if (!table) return false;
  const rows = db.prepare("SELECT id FROM ledger_events").all() as Array<{ id: string }>;
  return rows.some((row) => !isSha256Hex(row.id));
}

function migratedEventType(eventType: string, payload: Record<string, unknown>): string {
  if (eventType !== "issue.updated") return eventType;
  const patch = payload.patch;
  const fields = patch && typeof patch === "object" && !Array.isArray(patch)
    ? patch as Record<string, unknown>
    : payload;
  if (fields.status === "closed") return "issue.closed";
  if (fields.status === "open") return "issue.reopened";
  return eventType;
}

function parseJsonRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Preserve unreadable payloads as opaque data instead of blocking schema migration.
  }
  return { legacy_payload_json: value };
}

/**
 * Backfill session_projects rows where repo_id is a branch/worktree name
 * (e.g. feature__audit-fixes) with the real repo name derived from the
 * session's worktree path (e.g. .../mandible/worktrees/feature__foo -> "mandible").
 * Bug: 003179f
 */
function backfillProjectRepoNames(db: Db): void {
  if (!tableExists(db, "session_projects") || !tableExists(db, "sessions")) return;
  const rows = db.prepare(
    `SELECT sp.rowid, sp.session_id, sp.repo_id, s.worktree
     FROM session_projects sp
     JOIN sessions s ON sp.session_id = s.id
     WHERE s.worktree IS NOT NULL
       AND s.worktree LIKE '%/worktrees/%'
       AND (
         sp.repo_id LIKE 'feature__%' OR sp.repo_id LIKE 'feature/%'
         OR sp.repo_id LIKE 'fix__%'    OR sp.repo_id LIKE 'fix/%'
         OR sp.repo_id LIKE 'bugfix__%' OR sp.repo_id LIKE 'bugfix/%'
         OR sp.repo_id LIKE 'chore__%'  OR sp.repo_id LIKE 'chore/%'
         OR sp.repo_id LIKE 'integrate__%' OR sp.repo_id LIKE 'integrate/%'
       )`
  ).all() as { rowid: number; session_id: string; repo_id: string; worktree: string }[];

  if (rows.length === 0) return;

  const update = db.prepare(
    `UPDATE session_projects SET repo_id = ?, repo_name = ? WHERE rowid = ?`
  );
  const existingTarget = db.prepare(
    `SELECT 1 FROM session_projects WHERE session_id = ? AND repo_id = ? LIMIT 1`
  );
  const deleteDuplicate = db.prepare(
    `DELETE FROM session_projects WHERE rowid = ?`
  );

  const run = db.transaction(() => {
    for (const row of rows) {
      const beforeWorktrees = row.worktree.split("/worktrees/")[0];
      const repoName = path.basename(beforeWorktrees);
      if (repoName && repoName !== row.repo_id) {
        const targetExists = existingTarget.get(row.session_id, repoName) as { 1: number } | undefined;
        if (targetExists) {
          deleteDuplicate.run(row.rowid);
          continue;
        }
        update.run(repoName, repoName, row.rowid);
      }
    }
  });

  run();
  console.error(`[db] Backfilled repo names for ${rows.length} session_projects rows`);
}

function hasLegacySessionProjectWorktreeRepoIds(db: Db): boolean {
  if (!tableExists(db, "session_projects") || !tableExists(db, "sessions")) return false;
  const sessionProjectNames = tableColumnNames(db, "session_projects");
  const sessionNames = tableColumnNames(db, "sessions");
  if (!sessionProjectNames.has("repo_id") || !sessionNames.has("worktree")) return false;
  const row = db.prepare(
    `SELECT 1
     FROM session_projects sp
     JOIN sessions s ON sp.session_id = s.id
     WHERE s.worktree IS NOT NULL
       AND s.worktree LIKE '%/worktrees/%'
       AND (
         sp.repo_id LIKE 'feature__%' OR sp.repo_id LIKE 'feature/%'
         OR sp.repo_id LIKE 'fix__%'    OR sp.repo_id LIKE 'fix/%'
         OR sp.repo_id LIKE 'bugfix__%' OR sp.repo_id LIKE 'bugfix/%'
         OR sp.repo_id LIKE 'chore__%'  OR sp.repo_id LIKE 'chore/%'
         OR sp.repo_id LIKE 'integrate__%' OR sp.repo_id LIKE 'integrate/%'
       )
     LIMIT 1`,
  ).get();
  return Boolean(row);
}

/**
 * Corrected backfill for session_projects rows where repo_id is still a
 * branch/worktree name. v24 joined on s.worktree but sessions store the repo
 * root in s.cwd (not the worktree path), so v24 matched zero rows.
 * This version joins on s.cwd and derives the repo name via path.basename,
 * stripping leading dots (e.g. ".dotfiles" → "dotfiles").
 * Bug: 59492fd
 */
function backfillProjectRepoNamesV2(db: Db): void {
  if (!tableExists(db, "session_projects") || !tableExists(db, "sessions")) return;
  const rows = db.prepare(
    `SELECT sp.session_id, sp.repo_id, s.cwd
     FROM session_projects sp
     JOIN sessions s ON sp.session_id = s.id
     WHERE (
       sp.repo_id LIKE 'feature__%'
       OR sp.repo_id LIKE 'fix__%'
       OR sp.repo_id LIKE 'bugfix__%'
       OR sp.repo_id LIKE 'hotfix__%'
       OR sp.repo_id LIKE 'chore__%'
       OR sp.repo_id LIKE 'release__%'
       OR sp.repo_id LIKE 'feature/%'
       OR sp.repo_id IN ('main', 'master', 'develop')
     )
     AND s.cwd IS NOT NULL AND s.cwd != ''`
  ).all() as { session_id: string; repo_id: string; cwd: string }[];

  if (rows.length === 0) return;

  const update = db.prepare(
    `UPDATE session_projects SET repo_id = ?, repo_name = ? WHERE session_id = ? AND repo_id = ?`
  );
  const existingTarget = db.prepare(
    `SELECT 1 FROM session_projects WHERE session_id = ? AND repo_id = ? LIMIT 1`
  );
  const deleteDuplicate = db.prepare(
    `DELETE FROM session_projects WHERE session_id = ? AND repo_id = ?`
  );

  const run = db.transaction(() => {
    for (const row of rows) {
      const baseName = path.basename(row.cwd);
      const repoName = baseName.replace(/^\.+/, '');
      if (!repoName || repoName === row.repo_id) continue;
      const targetExists = existingTarget.get(row.session_id, repoName) as { 1: number } | undefined;
      if (targetExists) {
        deleteDuplicate.run(row.session_id, row.repo_id);
        continue;
      }
      update.run(repoName, repoName, row.session_id, row.repo_id);
    }
  });

  run();
  console.error(`[db] v25: backfilled repo names for ${rows.length} session_projects rows`);
}

function hasLegacySessionProjectCwdRepoIds(db: Db): boolean {
  if (!tableExists(db, "session_projects") || !tableExists(db, "sessions")) return false;
  const sessionProjectNames = tableColumnNames(db, "session_projects");
  const sessionNames = tableColumnNames(db, "sessions");
  if (!sessionProjectNames.has("repo_id") || !sessionNames.has("cwd")) return false;
  const row = db.prepare(
    `SELECT 1
     FROM session_projects sp
     JOIN sessions s ON sp.session_id = s.id
     WHERE (
       sp.repo_id LIKE 'feature__%'
       OR sp.repo_id LIKE 'fix__%'
       OR sp.repo_id LIKE 'bugfix__%'
       OR sp.repo_id LIKE 'hotfix__%'
       OR sp.repo_id LIKE 'chore__%'
       OR sp.repo_id LIKE 'release__%'
       OR sp.repo_id LIKE 'feature/%'
       OR sp.repo_id IN ('main', 'master', 'develop')
     )
     AND s.cwd IS NOT NULL AND s.cwd != ''
     LIMIT 1`,
  ).get();
  return Boolean(row);
}

/**
 * Backfill issue_ids from commit_message Bug: trailers for existing auth requests.
 * Bug: ba9687f — structured issue_ids extracted at submission time; this
 * retroactively populates the column for pre-existing rows.
 */
function backfillIssueIds(db: Db): void {
  if (!tableExists(db, "auth_requests")) return;
  const columns = db.prepare("PRAGMA table_info(auth_requests)").all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  if (!names.has("id") || !names.has("commit_message") || !names.has("issue_ids")) return;
  const rows = db.prepare(
    "SELECT id, commit_message FROM auth_requests WHERE issue_ids IS NULL AND commit_message IS NOT NULL"
  ).all() as Array<{ id: string; commit_message: string }>;

  if (rows.length === 0) return;

  const update = db.prepare(
    "UPDATE auth_requests SET issue_ids = ? WHERE id = ?"
  );

  const regex = /^Bug:\s+(\S+)/gm;
  const run = db.transaction(() => {
    for (const row of rows) {
      const refs: string[] = [];
      let m;
      regex.lastIndex = 0;
      while ((m = regex.exec(row.commit_message)) !== null) {
        refs.push(m[1]);
      }
      if (refs.length > 0) {
        update.run(JSON.stringify(refs), row.id);
      }
    }
  });

  run();
  const filled = rows.filter((r) => {
    regex.lastIndex = 0;
    return regex.test(r.commit_message);
  }).length;
  if (filled > 0) {
    console.error(`[db] Backfilled issue_ids for ${filled} auth_requests rows`);
  }
}

function hasIssueIdBackfillWork(db: Db): boolean {
  if (!tableExists(db, "auth_requests")) return false;
  const names = tableColumnNames(db, "auth_requests");
  if (!names.has("commit_message") || !names.has("issue_ids")) return false;
  const row = db.prepare(
    `SELECT 1 FROM auth_requests
     WHERE issue_ids IS NULL
       AND commit_message IS NOT NULL
       AND commit_message LIKE '%Bug:%'
     LIMIT 1`,
  ).get();
  return Boolean(row);
}

function getSchemaVersion(db: Db): number {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(SCHEMA_VERSION_KEY) as
    | { value: string }
    | undefined;
  if (!row) {
    return 0;
  }
  const version = Number(row.value);
  return Number.isFinite(version) ? version : 0;
}

function shouldRunPostMigration(
  db: Db,
  name: string,
  pending: readonly Migration[],
  version: number,
  hasIncompleteWork: () => boolean,
): boolean {
  if (pending.some((migration) => migration.version === version)) {
    return true;
  }
  const key = postMigrationKey(name);
  if (getMeta(db, key) === "done") {
    return false;
  }
  if (!hasIncompleteWork()) {
    setMeta(db, key, "done");
    return false;
  }
  return true;
}

function runPostMigration(db: Db, name: string, run: () => void): void {
  run();
  setMeta(db, postMigrationKey(name), "done");
}

function postMigrationKey(name: string): string {
  return `post_migration.${name}.complete`;
}

function getMeta(db: Db, key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function setMeta(db: Db, key: string, value: string): void {
  db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, value);
}

// Validate that the migration-88 artifact versioning tables carry their intended
// constraints. Guards against a pre-existing divergent table that CREATE TABLE
// IF NOT EXISTS would silently accept. Throws (failing the migration) on drift.
function verifyArtifactVersioningSchema(db: Db): void {
  const hasUniqueIndexOver = (table: string, expected: string[]): boolean => {
    const indexes = db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string; unique: number }>;
    return indexes.some((index) => {
      if (!index.unique) return false;
      const cols = (db.prepare(`PRAGMA index_info(${index.name})`).all() as Array<{ name: string }>)
        .map((info) => info.name);
      return cols.length === expected.length && expected.every((col, i) => cols[i] === col);
    });
  };
  const requireTable = (table: string, columns: string[]): void => {
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) as { sql: string | null } | undefined;
    if (!row) {
      throw new Error(`migration 88 verification: table ${table} is missing after migration`);
    }
    const present = new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name),
    );
    for (const column of columns) {
      if (!present.has(column)) {
        throw new Error(`migration 88 verification: table ${table} is missing expected column '${column}' (divergent pre-existing table?)`);
      }
    }
    // The source_kind CHECK is the only constraint not reflected by PRAGMA
    // table_info/index_list/foreign_key_list, so assert it from the stored DDL.
    if (!/CHECK\s*\(\s*source_kind\s+IN/i.test(row.sql ?? "")) {
      throw new Error(`migration 88 verification: table ${table} is missing its CHECK(source_kind IN ...) constraint (divergent pre-existing table?)`);
    }
  };

  requireTable("artifact_series", [
    "id", "series_key", "source_kind", "title", "repo_id", "logical_name",
    "latest_version_id", "version_count", "metadata_json", "created_at", "updated_at",
  ]);
  requireTable("artifact_versions", [
    "id", "series_id", "artifact_id", "version_no", "source_kind", "content_hash",
    "commit_sha", "repo_path", "observed_path", "custody_mode", "label", "note",
    "metadata_json", "created_at",
  ]);

  if (!hasUniqueIndexOver("artifact_series", ["series_key"])) {
    throw new Error("migration 88 verification: artifact_series is missing its UNIQUE(series_key) constraint");
  }
  if (!hasUniqueIndexOver("artifact_versions", ["series_id", "version_no"])) {
    throw new Error("migration 88 verification: artifact_versions is missing its UNIQUE(series_id, version_no) constraint");
  }

  const fks = db.prepare("PRAGMA foreign_key_list(artifact_versions)").all() as Array<{ table: string }>;
  const fkTargets = new Set(fks.map((fk) => fk.table));
  if (!fkTargets.has("artifact_series")) {
    throw new Error("migration 88 verification: artifact_versions is missing its foreign key to artifact_series");
  }
  if (!fkTargets.has("artifacts")) {
    throw new Error("migration 88 verification: artifact_versions is missing its foreign key to artifacts");
  }
}

// Migration 89 (issue c154a27): add the typed-link columns to artifact_links.
// ALTER TABLE ADD COLUMN cannot be IF NOT EXISTS, so each add is guarded on the
// live column set (mirrors ensureArtifactCustodyColumns) — a schema-rewind
// re-run is a no-op. Also (re)creates the two new indexes (CREATE INDEX IF NOT
// EXISTS is idempotent). Short-circuits when artifact_links does not exist (a
// partial legacy DB that starts above the v67 migration never creates it), so no
// DDL references a missing table.
function ensureArtifactLinkSeriesColumns(db: Db): void {
  if (!tableExists(db, "artifact_links")) return;
  const names = tableColumnNames(db, "artifact_links");
  if (!names.has("link_kind")) {
    db.exec(
      `ALTER TABLE artifact_links ADD COLUMN link_kind TEXT NOT NULL DEFAULT 'pinned'
        CHECK(link_kind IN ('pinned','living'))`,
    );
  }
  if (!names.has("series_id")) {
    db.exec("ALTER TABLE artifact_links ADD COLUMN series_id TEXT");
  }
  if (!names.has("series_ref")) {
    db.exec("ALTER TABLE artifact_links ADD COLUMN series_ref TEXT");
  }
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_artifact_links_kind
      ON artifact_links(link_kind)`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_artifact_links_series
      ON artifact_links(series_id)
      WHERE series_id IS NOT NULL`,
  );
}

// Gate for the migration-89 orphan-series backfill. An orphan is an `artifacts`
// content row with no `artifact_versions` row pinning it under a series.
function hasOrphanArtifacts(db: Db): boolean {
  if (!tableExists(db, "artifacts")) return false;
  if (!tableExists(db, "artifact_series") || !tableExists(db, "artifact_versions")) return false;
  const row = db
    .prepare(
      `SELECT 1 FROM artifacts
        WHERE id NOT IN (SELECT artifact_id FROM artifact_versions)
        LIMIT 1`,
    )
    .get();
  return Boolean(row);
}

function artifactRowCount(db: Db): number {
  if (!tableExists(db, "artifacts")) return 0;
  return (db.prepare("SELECT COUNT(*) AS n FROM artifacts").get() as { n: number }).n;
}

// Validate the migration-89 typed-link columns + indexes on the real apply path.
// Mirrors verifyArtifactVersioningSchema: because the columns are added via a
// guarded ALTER ADD COLUMN, a divergent pre-existing column (e.g. a link_kind
// added without its CHECK/DEFAULT) would be silently accepted; assert the live
// DDL and fail loudly on drift.
function verifyArtifactLinkSeriesSchema(db: Db): void {
  // Partial legacy DBs that start above the v67 migration never create
  // artifact_links; ensureArtifactLinkSeriesColumns short-circuits the same way,
  // so there is nothing to verify (no divergence is possible without the table).
  if (!tableExists(db, "artifact_links")) return;
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'artifact_links'")
    .get() as { sql: string | null } | undefined;
  if (!row) {
    throw new Error("migration 89 verification: table artifact_links is missing after migration");
  }
  const columns = db.prepare("PRAGMA table_info(artifact_links)").all() as Array<{
    name: string;
    notnull: number;
    dflt_value: string | null;
  }>;
  const byName = new Map(columns.map((column) => [column.name, column]));
  for (const column of ["link_kind", "series_id", "series_ref"]) {
    if (!byName.has(column)) {
      throw new Error(
        `migration 89 verification: artifact_links is missing expected column '${column}' (divergent pre-existing table?)`,
      );
    }
  }
  const linkKind = byName.get("link_kind")!;
  if (!linkKind.notnull) {
    throw new Error("migration 89 verification: artifact_links.link_kind must be NOT NULL");
  }
  if (!/'pinned'/.test(linkKind.dflt_value ?? "")) {
    throw new Error(
      `migration 89 verification: artifact_links.link_kind must DEFAULT 'pinned' (got ${String(linkKind.dflt_value)})`,
    );
  }
  if (byName.get("series_id")!.notnull) {
    throw new Error(
      "migration 89 verification: artifact_links.series_id must be nullable (soft reference)",
    );
  }
  if (byName.get("series_ref")!.notnull) {
    throw new Error("migration 89 verification: artifact_links.series_ref must be nullable");
  }
  // The link_kind CHECK is not reflected by PRAGMA table_info; assert the FULL
  // contract from the DDL: the IN-list must be exactly {'pinned','living'} so
  // both are accepted and any unknown value is rejected. A bare "CHECK exists"
  // test would pass a divergent constraint that, e.g., dropped 'living'.
  const checkMatch = /CHECK\s*\(\s*link_kind\s+IN\s*\(([^)]*)\)\s*\)/i.exec(row.sql ?? "");
  if (!checkMatch) {
    throw new Error(
      "migration 89 verification: artifact_links is missing its CHECK(link_kind IN (...)) constraint (divergent pre-existing table?)",
    );
  }
  const allowedLinkKinds = new Set(
    [...checkMatch[1].matchAll(/'([^']*)'/g)].map((literal) => literal[1]),
  );
  if (allowedLinkKinds.size !== 2 || !allowedLinkKinds.has("pinned") || !allowedLinkKinds.has("living")) {
    throw new Error(
      `migration 89 verification: artifact_links.link_kind CHECK must allow exactly {'pinned','living'} (got {${[...allowedLinkKinds]
        .map((value) => `'${value}'`)
        .join(",")}})`,
    );
  }
  // series_id is a SOFT reference: there must be NO foreign key from
  // artifact_links into artifact_series.
  const fks = db.prepare("PRAGMA foreign_key_list(artifact_links)").all() as Array<{
    table: string;
    from: string;
  }>;
  if (fks.some((fk) => fk.from === "series_id" || fk.table === "artifact_series")) {
    throw new Error(
      "migration 89 verification: artifact_links.series_id must be a soft reference with NO foreign key",
    );
  }
  // Index verification asserts the indexed COLUMN and partiality from the stored
  // DDL, not just the index name: CREATE INDEX IF NOT EXISTS would silently keep
  // a wrong same-named pre-existing index.
  const indexSql = (name: string): string => {
    const indexRow = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get(name) as { sql: string | null } | undefined;
    if (!indexRow?.sql) {
      throw new Error(`migration 89 verification: index ${name} is missing`);
    }
    return indexRow.sql;
  };
  if (!/\(\s*link_kind\s*\)/i.test(indexSql("idx_artifact_links_kind"))) {
    throw new Error("migration 89 verification: idx_artifact_links_kind must index link_kind");
  }
  const seriesIndexSql = indexSql("idx_artifact_links_series");
  if (!/\(\s*series_id\s*\)/i.test(seriesIndexSql)) {
    throw new Error("migration 89 verification: idx_artifact_links_series must index series_id");
  }
  if (!/WHERE\s+series_id\s+IS\s+NOT\s+NULL/i.test(seriesIndexSql)) {
    throw new Error(
      "migration 89 verification: idx_artifact_links_series must be the partial index WHERE series_id IS NOT NULL",
    );
  }
}

// Migration-89 data verifier: after the orphan backfill, assert the REAL
// post-condition based on artifact_versions MEMBERSHIP — every artifacts.id
// appears in artifact_versions.artifact_id (orphans = 0) and the artifacts row
// count is unchanged (the backfill never inserts/deletes content rows). It must
// NOT assert anything about series whose series_key happens to equal an artifact
// id: v88 allows an explicit series_key input, so a legitimate pre-existing
// multi-version series can carry such a key, and a `version_count == 1`
// assumption there would false-fail. Runs inside the backfill's immediate
// transaction, so a throw rolls every backfill write back.
function verifyEveryArtifactHasSeries(db: Db, expectedArtifactCount: number): void {
  if (!tableExists(db, "artifacts")) return;
  const orphans = (db
    .prepare(
      `SELECT COUNT(*) AS n FROM artifacts
        WHERE id NOT IN (SELECT artifact_id FROM artifact_versions)`,
    )
    .get() as { n: number }).n;
  if (orphans !== 0) {
    throw new Error(
      `migration 89 verification: ${orphans} artifact(s) still have no version row after the orphan backfill`,
    );
  }
  const after = artifactRowCount(db);
  if (after !== expectedArtifactCount) {
    throw new Error(
      `migration 89 verification: artifacts row count changed during backfill (${expectedArtifactCount} -> ${after}); the backfill must not touch artifacts rows`,
    );
  }
}

function ensureLedgerProjectKeyColumn(db: Db): void {
  const hasTable = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ledger_projects'")
    .get();
  if (!hasTable) return;
  const columns = db.prepare("PRAGMA table_info(ledger_projects)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "project_key")) {
    db.exec(`ALTER TABLE ledger_projects ADD COLUMN project_key TEXT NOT NULL DEFAULT ''`);
  }
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_projects_project_key
      ON ledger_projects(project_key)
      WHERE project_key != ''`,
  );
}

function hasProjectsMissingKeys(db: Db): boolean {
  const hasTable = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ledger_projects'")
    .get();
  if (!hasTable) return false;
  const columns = db.prepare("PRAGMA table_info(ledger_projects)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "project_key")) return false;
  const row = db
    .prepare("SELECT 1 FROM ledger_projects WHERE project_key = '' LIMIT 1")
    .get();
  return Boolean(row);
}

function ensureIssueCoordinationColumns(db: Db): void {
  const columns = db.prepare("PRAGMA table_info(ledger_issues)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "worker_status")) {
    db.exec(
      `ALTER TABLE ledger_issues ADD COLUMN worker_status TEXT NOT NULL DEFAULT 'none'
        CHECK(worker_status IN ('none','in_progress','done','blocked','pivot-needed'))`,
    );
  }
}

function ensureAuthRequestActionPrerequisites(db: Db): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS auth_requests (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      type TEXT NOT NULL DEFAULT 'merge',
      command TEXT NOT NULL,
      title TEXT NOT NULL,
      cwd TEXT,
      diff_summary TEXT,
      commit_message TEXT,
      spec_content TEXT,
      repo TEXT,
      base_branch TEXT,
      head_branch TEXT,
      files_changed INTEGER DEFAULT 0,
      additions INTEGER DEFAULT 0,
      deletions INTEGER DEFAULT 0,
      post_merge_handoff TEXT,
      issue_references TEXT,
      issue_closures TEXT,
      issue_ids TEXT,
      issues TEXT,
      depends_on_id TEXT,
      execution_mode TEXT NOT NULL DEFAULT 'daemon',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_executed_at INTEGER,
      approved_at INTEGER,
      resolved_at INTEGER,
      skipped_at INTEGER,
      expires_at INTEGER NOT NULL,
      exit_code INTEGER,
      output TEXT NOT NULL DEFAULT '',
      error TEXT,
      acknowledged_by TEXT,
      target_session_id TEXT,
      target_repo_root TEXT,
      delivered_at INTEGER,
      conversation_id TEXT,
      approval_source TEXT NOT NULL DEFAULT 'manual',
      approval_lease_id TEXT
    )`,
  );

  const columns = tableColumnNames(db, "auth_requests");
  const missingColumns: Array<[string, string]> = [
    ["session_id", "TEXT"],
    ["type", "TEXT NOT NULL DEFAULT 'merge'"],
    ["command", "TEXT NOT NULL DEFAULT ''"],
    ["title", "TEXT NOT NULL DEFAULT ''"],
    ["cwd", "TEXT"],
    ["diff_summary", "TEXT"],
    ["commit_message", "TEXT"],
    ["spec_content", "TEXT"],
    ["repo", "TEXT"],
    ["base_branch", "TEXT"],
    ["head_branch", "TEXT"],
    ["files_changed", "INTEGER DEFAULT 0"],
    ["additions", "INTEGER DEFAULT 0"],
    ["deletions", "INTEGER DEFAULT 0"],
    ["post_merge_handoff", "TEXT"],
    ["issue_references", "TEXT"],
    ["issue_closures", "TEXT"],
    ["issue_ids", "TEXT"],
    ["issues", "TEXT"],
    ["depends_on_id", "TEXT"],
    ["execution_mode", "TEXT NOT NULL DEFAULT 'daemon'"],
    ["status", "TEXT NOT NULL DEFAULT 'pending'"],
    ["created_at", "INTEGER NOT NULL DEFAULT 0"],
    ["updated_at", "INTEGER NOT NULL DEFAULT 0"],
    ["last_executed_at", "INTEGER"],
    ["approved_at", "INTEGER"],
    ["resolved_at", "INTEGER"],
    ["skipped_at", "INTEGER"],
    ["expires_at", "INTEGER NOT NULL DEFAULT 0"],
    ["exit_code", "INTEGER"],
    ["output", "TEXT NOT NULL DEFAULT ''"],
    ["error", "TEXT"],
    ["acknowledged_by", "TEXT"],
    ["target_session_id", "TEXT"],
    ["target_repo_root", "TEXT"],
    ["delivered_at", "INTEGER"],
    ["conversation_id", "TEXT"],
    ["approval_source", "TEXT NOT NULL DEFAULT 'manual'"],
    ["approval_lease_id", "TEXT"],
  ];
  for (const [name, definition] of missingColumns) {
    if (!columns.has(name)) {
      db.exec(`ALTER TABLE auth_requests ADD COLUMN ${name} ${definition}`);
    }
  }
}

function ensureAuthRequestMergeFinalizerColumns(db: Db): void {
  if (!tableExists(db, "auth_requests")) return;
  const columns = tableColumnNames(db, "auth_requests");
  if (!columns.has("merge_head_sha")) {
    db.exec("ALTER TABLE auth_requests ADD COLUMN merge_head_sha TEXT");
  }
  if (!columns.has("merge_finalized_at")) {
    db.exec("ALTER TABLE auth_requests ADD COLUMN merge_finalized_at INTEGER");
  }
}

function tableExists(db: Db, table: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  return Boolean(row);
}

function tableColumnNames(db: Db, table: string): Set<string> {
  const allowed = new Set([
    "artifacts",
    "artifact_links",
    "auth_requests",
    "conversation_blocks",
    "conversations",
    "ledger_comments",
    "ledger_issues",
    "session_projects",
    "sessions",
    "work_units",
  ]);
  if (!allowed.has(table)) {
    throw new Error(`Unsupported table_info identifier: ${table}`);
  }
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(columns.map((column) => column.name));
}

function indexExists(db: Db, index: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?")
    .get(index);
  return Boolean(row);
}

function triggerExists(db: Db, trigger: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?")
    .get(trigger);
  return Boolean(row);
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// Bug: caa157e — UUID prefix matching for CLI operations
export type PrefixResult =
  | { ok: true; id: string }
  | { ok: false; error: "not_found" }
  | { ok: false; error: "ambiguous"; count: number };

const PREFIX_IDENTIFIER_ALLOWLIST = new Set(["auth_requests.id", "sessions.id"]);

function requirePrefixIdentifier(table: string, idColumn: string): void {
  const key = `${table}.${idColumn}`;
  if (!PREFIX_IDENTIFIER_ALLOWLIST.has(key)) {
    throw new Error(`Unsupported prefix lookup identifier: ${key}`);
  }
}

/**
 * Resolve a UUID prefix to a full ID. If the prefix is already a full UUID
 * (36 chars), does an exact match. Otherwise, does a prefix match with LIKE.
 *
 * Returns the resolved full ID, or an error indicating not_found / ambiguous.
 */
export function resolvePrefix(
  db: Db,
  table: string,
  idColumn: string,
  prefix: string,
): PrefixResult {
  requirePrefixIdentifier(table, idColumn);
  // Full UUID: exact match (current behavior)
  if (prefix.length >= 36) {
    const row = db
      .prepare(`SELECT ${idColumn} FROM ${table} WHERE ${idColumn} = ?`)
      .get(prefix) as Record<string, unknown> | undefined;
    return row ? { ok: true, id: String(row[idColumn]) } : { ok: false, error: "not_found" };
  }

  // Prefix match: require at least 4 characters to avoid overly broad matches
  if (prefix.length < 4) {
    // Still try exact match for very short strings (unlikely to be a UUID but harmless)
    const row = db
      .prepare(`SELECT ${idColumn} FROM ${table} WHERE ${idColumn} = ?`)
      .get(prefix) as Record<string, unknown> | undefined;
    return row ? { ok: true, id: String(row[idColumn]) } : { ok: false, error: "not_found" };
  }

  // Escape any LIKE wildcards in the prefix
  const escaped = prefix.replace(/%/g, "\\%").replace(/_/g, "\\_");
  const rows = db
    .prepare(
      `SELECT ${idColumn} FROM ${table} WHERE ${idColumn} LIKE ? ESCAPE '\\' LIMIT 2`
    )
    .all(`${escaped}%`) as Record<string, unknown>[];

  if (rows.length === 0) {
    return { ok: false, error: "not_found" };
  }
  if (rows.length > 1) {
    // Count the actual number of matches for the error message
    const countRow = db
      .prepare(
        `SELECT COUNT(*) as cnt FROM ${table} WHERE ${idColumn} LIKE ? ESCAPE '\\'`
      )
      .get(`${escaped}%`) as { cnt: number };
    return { ok: false, error: "ambiguous", count: countRow.cnt };
  }
  return { ok: true, id: String(rows[0][idColumn]) };
}
