import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compressContent } from "./compression.js";
const DEFAULT_CACHE_DIR = path.join(os.homedir(), ".cache", "mandible");
const DEFAULT_DB_PATH = path.join(DEFAULT_CACHE_DIR, "mandible.db");
const SCHEMA_VERSION_KEY = "schema_version";
const MIGRATIONS = [
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
            `INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('reaper_enabled', 'true', CAST(strftime('%s','now') * 1000 AS INTEGER))`,
            `INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('reaper_claude_idle_minutes', '30', CAST(strftime('%s','now') * 1000 AS INTEGER))`,
            `INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('reaper_codex_idle_minutes', '45', CAST(strftime('%s','now') * 1000 AS INTEGER))`,
            `INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('reaper_dry_run', 'false', CAST(strftime('%s','now') * 1000 AS INTEGER))`,
            `INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('reaper_cleanup_orphan_mcps', 'true', CAST(strftime('%s','now') * 1000 AS INTEGER))`,
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
        // Bug: 297677f — allow auth requests to declare issue IDs to close on merge,
        // independent of Bug: trailers in commit messages. Enables umbrella issue
        // auto-closure in bigbuild workflows.
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
        statements: [
            `ALTER TABLE conversation_blocks ADD COLUMN dag_uuid TEXT`,
            `ALTER TABLE conversation_blocks ADD COLUMN dag_parent_uuid TEXT`,
            `CREATE INDEX idx_blocks_dag_parent ON conversation_blocks(conversation_id, dag_parent_uuid) WHERE dag_parent_uuid IS NOT NULL`,
        ]
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
         'npm install && npm run build',
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
    }
];
export function getDbPath() {
    return process.env.MANDIBLE_DB ?? DEFAULT_DB_PATH;
}
export function openDb(dbPath = getDbPath()) {
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
            }
            catch {
                // Non-fatal: if copy fails, start fresh
            }
        }
    }
    ensureDir(path.dirname(dbPath));
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    migrate(db);
    return db;
}
export function migrate(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`);
    const currentVersion = getSchemaVersion(db);
    const pending = MIGRATIONS.filter((migration) => migration.version > currentVersion);
    if (pending.length === 0) {
        return;
    }
    const apply = db.transaction(() => {
        for (const migration of pending) {
            for (const statement of migration.statements) {
                db.exec(statement);
            }
            setMeta(db, SCHEMA_VERSION_KEY, String(migration.version));
        }
    });
    apply();
    // Run post-DDL data migrations that require Node.js logic.
    // Bug: e5a945d — batch-compress existing uncompressed content
    if (pending.some((m) => m.version === 19)) {
        compressExistingBlocks(db);
    }
    // Bug: 003179f — backfill correct repo names in session_projects
    if (pending.some((m) => m.version === 24)) {
        backfillProjectRepoNames(db);
    }
    // Bug: 59492fd — v24 used wrong join condition; v25 corrects remaining rows
    if (pending.some((m) => m.version === 25)) {
        backfillProjectRepoNamesV2(db);
    }
    // Bug: ba9687f — backfill issue_ids from commit_message Bug: trailers
    if (pending.some((m) => m.version === 29)) {
        backfillIssueIds(db);
    }
    // Bug: 3aaf10d — strip leading dots from repo names (.dotfiles → dotfiles)
    if (pending.some((m) => m.version === 26)) {
        const rows = db.prepare("SELECT session_id, repo_id, repo_name FROM session_projects WHERE repo_name LIKE '.%' OR repo_id LIKE '.%'").all();
        const update = db.prepare("UPDATE session_projects SET repo_name = ? WHERE session_id = ? AND repo_id = ?");
        for (const row of rows) {
            const fixedName = row.repo_name.replace(/^\.+/, "") || row.repo_name;
            if (fixedName !== row.repo_name) {
                update.run(fixedName, row.session_id, row.repo_id);
            }
        }
    }
}
// --- Singleton accessor for partition code ---
let _db = null;
export function getDb(dbPath) {
    if (!_db) {
        _db = openDb(dbPath);
    }
    return _db;
}
export function setDb(db) {
    _db = db;
}
/**
 * Batch-compress all uncompressed conversation_blocks rows.
 * Runs in batches of 500 to avoid holding a long write-lock.
 * Idempotent: only touches rows where compressed=0.
 * Bug: e5a945d
 */
function compressExistingBlocks(db) {
    const BATCH_SIZE = 500;
    const selectBatch = db.prepare("SELECT id, content FROM conversation_blocks WHERE compressed = 0 LIMIT ?");
    const updateRow = db.prepare("UPDATE conversation_blocks SET content = ?, compressed = 1 WHERE id = ?");
    let totalCompressed = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
        const rows = selectBatch.all(BATCH_SIZE);
        if (rows.length === 0)
            break;
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
/**
 * Backfill session_projects rows where repo_id is a branch/worktree name
 * (e.g. feature__audit-fixes) with the real repo name derived from the
 * session's worktree path (e.g. .../mandible/worktrees/feature__foo -> "mandible").
 * Bug: 003179f
 */
function backfillProjectRepoNames(db) {
    const rows = db.prepare(`SELECT sp.rowid, sp.repo_id, s.worktree
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
       )`).all();
    if (rows.length === 0)
        return;
    const update = db.prepare(`UPDATE session_projects SET repo_id = ?, repo_name = ? WHERE rowid = ?`);
    const run = db.transaction(() => {
        for (const row of rows) {
            const beforeWorktrees = row.worktree.split("/worktrees/")[0];
            const repoName = path.basename(beforeWorktrees);
            if (repoName && repoName !== row.repo_id) {
                update.run(repoName, repoName, row.rowid);
            }
        }
    });
    run();
    console.error(`[db] Backfilled repo names for ${rows.length} session_projects rows`);
}
/**
 * Corrected backfill for session_projects rows where repo_id is still a
 * branch/worktree name. v24 joined on s.worktree but sessions store the repo
 * root in s.cwd (not the worktree path), so v24 matched zero rows.
 * This version joins on s.cwd and derives the repo name via path.basename,
 * stripping leading dots (e.g. ".dotfiles" → "dotfiles").
 * Bug: 59492fd
 */
function backfillProjectRepoNamesV2(db) {
    const rows = db.prepare(`SELECT sp.session_id, sp.repo_id, s.cwd
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
     AND s.cwd IS NOT NULL AND s.cwd != ''`).all();
    if (rows.length === 0)
        return;
    const update = db.prepare(`UPDATE session_projects SET repo_id = ?, repo_name = ? WHERE session_id = ? AND repo_id = ?`);
    const existingTarget = db.prepare(`SELECT 1 FROM session_projects WHERE session_id = ? AND repo_id = ? LIMIT 1`);
    const deleteDuplicate = db.prepare(`DELETE FROM session_projects WHERE session_id = ? AND repo_id = ?`);
    const run = db.transaction(() => {
        for (const row of rows) {
            const baseName = path.basename(row.cwd);
            const repoName = baseName.replace(/^\.+/, '');
            if (!repoName || repoName === row.repo_id)
                continue;
            const targetExists = existingTarget.get(row.session_id, repoName);
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
/**
 * Backfill issue_ids from commit_message Bug: trailers for existing auth requests.
 * Bug: ba9687f — structured issue_ids extracted at submission time; this
 * retroactively populates the column for pre-existing rows.
 */
function backfillIssueIds(db) {
    const rows = db.prepare("SELECT id, commit_message FROM auth_requests WHERE issue_ids IS NULL AND commit_message IS NOT NULL").all();
    if (rows.length === 0)
        return;
    const update = db.prepare("UPDATE auth_requests SET issue_ids = ? WHERE id = ?");
    const regex = /^Bug:\s+(\S+)/gm;
    const run = db.transaction(() => {
        for (const row of rows) {
            const refs = [];
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
function getSchemaVersion(db) {
    const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(SCHEMA_VERSION_KEY);
    if (!row) {
        return 0;
    }
    const version = Number(row.value);
    return Number.isFinite(version) ? version : 0;
}
function setMeta(db, key, value) {
    db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}
function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}
/**
 * Resolve a UUID prefix to a full ID. If the prefix is already a full UUID
 * (36 chars), does an exact match. Otherwise, does a prefix match with LIKE.
 *
 * Returns the resolved full ID, or an error indicating not_found / ambiguous.
 */
export function resolvePrefix(db, table, idColumn, prefix) {
    // Full UUID: exact match (current behavior)
    if (prefix.length >= 36) {
        const row = db
            .prepare(`SELECT ${idColumn} FROM ${table} WHERE ${idColumn} = ?`)
            .get(prefix);
        return row ? { ok: true, id: String(row[idColumn]) } : { ok: false, error: "not_found" };
    }
    // Prefix match: require at least 4 characters to avoid overly broad matches
    if (prefix.length < 4) {
        // Still try exact match for very short strings (unlikely to be a UUID but harmless)
        const row = db
            .prepare(`SELECT ${idColumn} FROM ${table} WHERE ${idColumn} = ?`)
            .get(prefix);
        return row ? { ok: true, id: String(row[idColumn]) } : { ok: false, error: "not_found" };
    }
    // Escape any LIKE wildcards in the prefix
    const escaped = prefix.replace(/%/g, "\\%").replace(/_/g, "\\_");
    const rows = db
        .prepare(`SELECT ${idColumn} FROM ${table} WHERE ${idColumn} LIKE ? ESCAPE '\\' LIMIT 2`)
        .all(`${escaped}%`);
    if (rows.length === 0) {
        return { ok: false, error: "not_found" };
    }
    if (rows.length > 1) {
        // Count the actual number of matches for the error message
        const countRow = db
            .prepare(`SELECT COUNT(*) as cnt FROM ${table} WHERE ${idColumn} LIKE ? ESCAPE '\\'`)
            .get(`${escaped}%`);
        return { ok: false, error: "ambiguous", count: countRow.cnt };
    }
    return { ok: true, id: String(rows[0][idColumn]) };
}
