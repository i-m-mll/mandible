import { createHash } from "node:crypto";
import path from "node:path";
import { compressContent } from "./compression.js";
import { getDaemonLogger } from "./daemon-log.js";
import { BASELINE_SCHEMA_VERSION, createFreshSchemaBaseline } from "./db-baseline.js";
import { tableExists } from "./db-introspection.js";
import type { Db } from "./db.js";
import { encodeRecurringRevisionContent } from "./feedback/store.js";
import { createStableEventId, isSha256Hex } from "./ledger/ids.js";
import { backfillProjectKeys } from "./ledger/project-registry.js";
import { backfillOrphanArtifactSeries } from "./provider-artifacts.js";

const SCHEMA_VERSION_KEY = "schema_version";
const dbLog = getDaemonLogger();

export interface Migration {
  version: number;
  name: string;
  statements: string[];
}

export const MIGRATIONS: readonly Migration[] = [
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
    // is intentionally shadow-only; existing issue routes continued to use the
    // compatibility scanner until later gated cutover work.
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
    // and writes must not depend on compatibility-adapter lock availability.
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
                        CHECK(ref_type IN ('issue','comment','artifact','external_ref','space','finding')),
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
  },
  {
    version: 91,
    name: "artifact_identity_project_associations",
    // Issue: 2dc97b8 — expand the artifact model to the project-canonical
    // identity contract without switching runtime code yet. The legacy tables
    // stay in place because current provider/runtime and space_exports still
    // reference them. New tables are parent-before-child: artifact_blob owns
    // project-blind bytes, artifact owns logical identity, artifact_version pins
    // one blob under one artifact, and project_artifact_associations records
    // explicit project memory only. artifact.latest_version_id is deliberately a
    // soft denormalized cache to avoid an artifact <-> artifact_version FK cycle.
    statements: [
      `CREATE TABLE IF NOT EXISTS artifact_blob (
        id             TEXT PRIMARY KEY,
        algorithm      TEXT NOT NULL DEFAULT 'sha256',
        content_hash   TEXT NOT NULL,
        storage_uri    TEXT,
        media_type     TEXT,
        role           TEXT,
        size_bytes     INTEGER NOT NULL DEFAULT 0,
        provider_id    TEXT,
        manifest_id    TEXT,
        metadata_json  TEXT NOT NULL DEFAULT '{}',
        custody_mode   TEXT NOT NULL DEFAULT 'managed'
          CHECK(custody_mode IN ('link','copy','managed','external')),
        availability   TEXT NOT NULL DEFAULT 'unchecked'
          CHECK(availability IN ('present','missing','stale','unchecked','remote_only','pinned')),
        retention_json TEXT NOT NULL DEFAULT '{}',
        reference_json TEXT NOT NULL DEFAULT '{}',
        created_at     INTEGER NOT NULL,
        UNIQUE(algorithm, content_hash)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_artifact_blob_provider
        ON artifact_blob(provider_id)
        WHERE provider_id IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS idx_artifact_blob_role
        ON artifact_blob(role)
        WHERE role IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS idx_artifact_blob_custody
        ON artifact_blob(custody_mode, availability)`,
      `CREATE TABLE IF NOT EXISTS artifact (
        id                TEXT PRIMARY KEY,
        identity_key      TEXT NOT NULL,
        source_kind       TEXT NOT NULL DEFAULT 'managed'
          CHECK(source_kind IN ('tracked_repo','local_only','managed','external','mixed')),
        title             TEXT,
        source_project_id TEXT REFERENCES ledger_projects(id) ON DELETE RESTRICT,
        source_repo_id    TEXT,
        logical_name      TEXT,
        source_path       TEXT,
        latest_version_id TEXT,
        version_count     INTEGER NOT NULL DEFAULT 0,
        metadata_json     TEXT NOT NULL DEFAULT '{}',
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL,
        UNIQUE(identity_key)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_artifact_source_kind
        ON artifact(source_kind)`,
      `CREATE INDEX IF NOT EXISTS idx_artifact_source_project
        ON artifact(source_project_id)
        WHERE source_project_id IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS idx_artifact_source_repo
        ON artifact(source_repo_id)
        WHERE source_repo_id IS NOT NULL`,
      `CREATE TABLE IF NOT EXISTS artifact_version (
        id                  TEXT PRIMARY KEY,
        artifact_id         TEXT NOT NULL REFERENCES artifact(id) ON DELETE CASCADE,
        version_no          INTEGER NOT NULL,
        blob_id             TEXT NOT NULL REFERENCES artifact_blob(id) ON DELETE RESTRICT,
        source_kind         TEXT NOT NULL
          CHECK(source_kind IN ('tracked_repo','local_only','managed','external')),
        content_hash        TEXT NOT NULL,
        source_project_id   TEXT REFERENCES ledger_projects(id) ON DELETE RESTRICT,
        source_repo_id      TEXT,
        repo_path           TEXT,
        commit_sha          TEXT,
        observed_path       TEXT,
        source_locator_json TEXT NOT NULL DEFAULT '{}',
        custody_mode        TEXT
          CHECK(custody_mode IS NULL OR custody_mode IN ('link','copy','managed','external')),
        label               TEXT,
        note                TEXT,
        metadata_json       TEXT NOT NULL DEFAULT '{}',
        created_at          INTEGER NOT NULL,
        UNIQUE(artifact_id, version_no)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_artifact_version_artifact
        ON artifact_version(artifact_id, version_no DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_artifact_version_blob
        ON artifact_version(blob_id)`,
      `CREATE INDEX IF NOT EXISTS idx_artifact_version_hash
        ON artifact_version(content_hash)`,
      `CREATE INDEX IF NOT EXISTS idx_artifact_version_source_project
        ON artifact_version(source_project_id)
        WHERE source_project_id IS NOT NULL`,
      `CREATE TABLE IF NOT EXISTS project_artifact_associations (
        id               TEXT PRIMARY KEY,
        project_id       TEXT NOT NULL REFERENCES ledger_projects(id) ON DELETE RESTRICT,
        target_type      TEXT NOT NULL CHECK(target_type IN ('artifact','artifact_version')),
        target_id        TEXT NOT NULL,
        association_kind TEXT NOT NULL DEFAULT 'associated'
          CHECK(association_kind IN ('associated','canonical')),
        role             TEXT NOT NULL DEFAULT '',
        title            TEXT,
        description      TEXT,
        rank             INTEGER,
        status           TEXT NOT NULL DEFAULT 'active'
          CHECK(status IN ('active','superseded','archived')),
        source           TEXT NOT NULL DEFAULT 'user'
          CHECK(source IN ('user','agent_explicit','space_rule','migration','system')),
        source_ref_type  TEXT,
        source_ref_id    TEXT,
        metadata_json    TEXT NOT NULL DEFAULT '{}',
        created_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL,
        UNIQUE(project_id, target_type, target_id, role)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_project_artifact_assoc_project
        ON project_artifact_associations(project_id, association_kind, status)`,
      `CREATE INDEX IF NOT EXISTS idx_project_artifact_assoc_target
        ON project_artifact_associations(target_type, target_id)`,
      `CREATE INDEX IF NOT EXISTS idx_project_artifact_assoc_source
        ON project_artifact_associations(source_ref_type, source_ref_id)
        WHERE source_ref_type IS NOT NULL AND source_ref_id IS NOT NULL`
    ]
  },
  {
    version: 92,
    name: "auth_merge_preflight_reuse_metadata",
    // Issue: aea35e5 — record the submit-time target head and queue fingerprint
    // used by the merge simulation so approve can skip the shell-side merge-tree
    // re-check only when the target and queued context are unchanged.
    statements: []
  },
  {
    version: 93,
    name: "console_transport_lane",
    // Issue: 71ca935 — persist the user-selected transport lane separately
    // from backend_type so UI badges and downstream chat controls have a
    // stable contract while legacy backend launch semantics stay intact.
    statements: []
  },
  {
    version: 94,
    name: "message_params_thinking_effort",
    // Issue: 3da19be — include SDK reasoning effort in the existing
    // per-message parameter keyframes.
    statements: []
  },
  {
    version: 95,
    name: "claude_statusline_telemetry",
    // Issue: ad10160 — persist the latest Claude Code statusline telemetry
    // pushed by the no-network statusline hook bridge.
    statements: [
      `CREATE TABLE IF NOT EXISTS console_session_telemetry (
        telemetry_key TEXT PRIMARY KEY,
        console_session_id TEXT REFERENCES console_sessions(id) ON DELETE CASCADE,
        provider_session_id TEXT,
        transcript_path TEXT,
        model TEXT,
        context_used_percentage REAL,
        context_window_size INTEGER,
        context_input_tokens INTEGER,
        context_output_tokens INTEGER,
        context_cache_creation_input_tokens INTEGER,
        context_cache_read_input_tokens INTEGER,
        rate_limit_five_hour_used_percentage REAL,
        rate_limit_five_hour_resets_at TEXT,
        rate_limit_seven_day_used_percentage REAL,
        rate_limit_seven_day_resets_at TEXT,
        raw_payload_json TEXT NOT NULL,
        received_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_console_session_telemetry_console
        ON console_session_telemetry(console_session_id)
        WHERE console_session_id IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS idx_console_session_telemetry_provider
        ON console_session_telemetry(provider_session_id)
        WHERE provider_session_id IS NOT NULL`
    ]
  },
  {
    version: 96,
    name: "conversation_sidechain_metadata",
    // Issue: 84fcd4a — mark provider child/sidechain transcripts without
    // depending on live sessions rows.
    statements: []
  },
  {
    version: 97,
    name: "conversation_ingest_append_state",
    // Issue: f894229 — durable append cursors for incremental transcript ingestion.
    statements: [
      `CREATE TABLE IF NOT EXISTS conversation_ingest_state (
        file_path TEXT PRIMARY KEY,
        byte_offset INTEGER NOT NULL DEFAULT 0,
        line_count INTEGER NOT NULL DEFAULT 0,
        tail_hash TEXT NOT NULL DEFAULT '',
        partial_line TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_conversation_ingest_state_updated
        ON conversation_ingest_state(updated_at)`
    ]
  },
  {
    version: 98,
    name: "workflow_run_browser",
    // Issue: e909c99 — persist read-only Claude Code workflow summaries from
    // file artifacts. Runs are keyed by summary_path so reruns from different
    // sessions remain distinct; worker transcript links are nullable because
    // transcript JSONL ingestion can lag behind the workflow summary watcher.
    statements: [
      `CREATE TABLE IF NOT EXISTS workflow_runs (
        id                TEXT PRIMARY KEY,
        provider          TEXT NOT NULL DEFAULT 'claude_code'
          CHECK(provider IN ('claude_code')),
        provider_run_id   TEXT NOT NULL,
        session_id        TEXT NOT NULL,
        project_path      TEXT,
        summary_path      TEXT NOT NULL UNIQUE,
        summary_mtime     REAL NOT NULL DEFAULT 0,
        summary_hash      TEXT NOT NULL DEFAULT '',
        workflow_name     TEXT NOT NULL,
        status            TEXT NOT NULL
          CHECK(status IN ('pending','running','completed','failed','warning')),
        started_at        INTEGER,
        updated_at        INTEGER,
        completed_at      INTEGER,
        duration_ms       INTEGER,
        total_tokens      INTEGER,
        total_tool_calls  INTEGER,
        agent_count       INTEGER NOT NULL DEFAULT 0,
        completed_workers INTEGER NOT NULL DEFAULT 0,
        total_workers     INTEGER NOT NULL DEFAULT 0,
        format_version    TEXT NOT NULL,
        script_path       TEXT,
        warnings_json     TEXT NOT NULL DEFAULT '[]',
        created_at        INTEGER NOT NULL,
        ingested_at       INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_workflow_runs_session
        ON workflow_runs(session_id, updated_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_workflow_runs_status
        ON workflow_runs(status, updated_at DESC)`,
      `CREATE TABLE IF NOT EXISTS workflow_phases (
        id              TEXT PRIMARY KEY,
        workflow_id     TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
        phase_index     INTEGER NOT NULL,
        title           TEXT NOT NULL,
        status          TEXT NOT NULL
          CHECK(status IN ('pending','running','completed','failed','warning')),
        worker_count    INTEGER NOT NULL DEFAULT 0,
        completed_count INTEGER NOT NULL DEFAULT 0,
        UNIQUE(workflow_id, phase_index)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_workflow_phases_run
        ON workflow_phases(workflow_id, phase_index)`,
      `CREATE TABLE IF NOT EXISTS workflow_workers (
        id                TEXT PRIMARY KEY,
        workflow_id       TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
        phase_id          TEXT REFERENCES workflow_phases(id) ON DELETE SET NULL,
        worker_index      INTEGER NOT NULL,
        agent_id          TEXT,
        label             TEXT NOT NULL,
        status            TEXT NOT NULL
          CHECK(status IN ('pending','running','completed','failed','warning')),
        model             TEXT,
        queued_at         INTEGER,
        started_at        INTEGER,
        last_progress_at  INTEGER,
        completed_at      INTEGER,
        duration_ms       INTEGER,
        tokens            INTEGER,
        tool_calls        INTEGER,
        last_tool_name    TEXT,
        last_tool_summary TEXT,
        prompt_preview    TEXT,
        result_preview    TEXT,
        transcript_path   TEXT,
        conversation_id   TEXT REFERENCES conversations(id) ON DELETE SET NULL,
        warnings_json     TEXT NOT NULL DEFAULT '[]',
        UNIQUE(workflow_id, agent_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_workflow_workers_run
        ON workflow_workers(workflow_id, worker_index)`,
      `CREATE INDEX IF NOT EXISTS idx_workflow_workers_phase
        ON workflow_workers(phase_id, worker_index)`,
      `CREATE INDEX IF NOT EXISTS idx_workflow_workers_conversation
        ON workflow_workers(conversation_id)
        WHERE conversation_id IS NOT NULL`
    ]
  },
  {
    version: 99,
    name: "workflow_ingest_state",
    // Issue: 326d1f2 — workflow summary and journal files are not conversations,
    // so reconcile needs a separate mtime cursor for unchanged workflow artifacts.
    statements: [
      `CREATE TABLE IF NOT EXISTS workflow_ingest_state (
        file_path TEXT PRIMARY KEY,
        source_mtime REAL NOT NULL DEFAULT 0,
        summary_path TEXT NOT NULL,
        workflow_id TEXT,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_workflow_ingest_state_updated
        ON workflow_ingest_state(updated_at)`,
      `CREATE INDEX IF NOT EXISTS idx_workflow_ingest_state_summary
        ON workflow_ingest_state(summary_path)`
    ]
  },
  {
    version: 100,
    name: "daemon_log",
    // Issue: be88a0f — inclusive structured daemon log. Levels are metadata;
    // insertion is never gated by LOG_LEVEL. Stderr rotation remains a separate
    // bootstrap/failure sink concern.
    statements: [
      `CREATE TABLE IF NOT EXISTS daemon_log (
        id              TEXT PRIMARY KEY,
        ts              INTEGER NOT NULL,
        level           TEXT NOT NULL CHECK(level IN ('debug','info','warn','error')),
        event           TEXT NOT NULL,
        subsystem       TEXT NOT NULL DEFAULT 'daemon',
        fields_json     TEXT NOT NULL DEFAULT '{}',
        issue_id        TEXT,
        auth_request_id TEXT,
        artifact_id     TEXT,
        session_id      TEXT,
        repo_id         TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_daemon_log_ts
        ON daemon_log(ts DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_daemon_log_facets
        ON daemon_log(subsystem, level, event, ts DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_daemon_log_issue
        ON daemon_log(issue_id, ts DESC)
        WHERE issue_id IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS idx_daemon_log_auth_request
        ON daemon_log(auth_request_id, ts DESC)
        WHERE auth_request_id IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS idx_daemon_log_artifact
        ON daemon_log(artifact_id, ts DESC)
        WHERE artifact_id IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS idx_daemon_log_session
        ON daemon_log(session_id, ts DESC)
        WHERE session_id IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS idx_daemon_log_repo
        ON daemon_log(repo_id, ts DESC)
        WHERE repo_id IS NOT NULL`,
      `INSERT OR IGNORE INTO settings (key, value, updated_at)
       VALUES ('stderr_rotation_max_bytes', '16777216', CAST(strftime('%s','now') * 1000 AS INTEGER))`,
      `INSERT OR IGNORE INTO settings (key, value, updated_at)
       VALUES ('stderr_rotation_keep_segments', '5', CAST(strftime('%s','now') * 1000 AS INTEGER))`
    ]
  },
  {
    version: 101,
    name: "artifact_markdown_drafts",
    // Issue: 8ad5b95 — server-side artifact edit drafts and parent-version
    // pointers for immutable versions minted from drafts. Drafts are one active
    // row per artifact series, explicitly pinned to a base version. Publishing
    // snapshots edited text through the existing artifact version write path,
    // then removes the draft. `parent_version_id` is additive and nullable so
    // historical versions remain valid.
    statements: [
      `CREATE TABLE IF NOT EXISTS artifact_drafts (
        id              TEXT PRIMARY KEY,
        series_id       TEXT NOT NULL REFERENCES artifact_series(id) ON DELETE CASCADE,
        base_version_id TEXT NOT NULL REFERENCES artifact_versions(id) ON DELETE RESTRICT,
        content         TEXT NOT NULL,
        media_type      TEXT,
        label           TEXT,
        note            TEXT,
        metadata_json   TEXT NOT NULL DEFAULT '{}',
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL,
        UNIQUE(series_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_artifact_drafts_base
        ON artifact_drafts(base_version_id)`,
      `CREATE INDEX IF NOT EXISTS idx_artifact_versions_parent
        ON artifact_versions(parent_version_id)
        WHERE parent_version_id IS NOT NULL`
    ]
  },
  {
    version: 102,
    name: "session_instruction_artifacts",
    // Issue: 2181ffd — session instruction attachments now pin artifact
    // versions. Legacy preset ids are kept only as migration provenance.
    statements: [
      `CREATE TABLE IF NOT EXISTS session_instruction_artifacts (
        session_id          TEXT NOT NULL,
        artifact_series_id  TEXT NOT NULL REFERENCES artifact_series(id) ON DELETE CASCADE,
        artifact_version_id TEXT NOT NULL REFERENCES artifact_versions(id) ON DELETE RESTRICT,
        legacy_preset_id    TEXT,
        position            INTEGER NOT NULL DEFAULT 0,
        created_at          INTEGER NOT NULL,
        updated_at          INTEGER NOT NULL,
        PRIMARY KEY (session_id, artifact_series_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_session_instruction_artifacts_session
        ON session_instruction_artifacts(session_id, position)`,
      `CREATE INDEX IF NOT EXISTS idx_session_instruction_artifacts_version
        ON session_instruction_artifacts(artifact_version_id)`
    ]
  },
  {
    version: 103,
    name: "conversation_empty_ingest_state",
    // Issue: 861c26c — remember source fingerprints that parsed empty so
    // reconcile and watcher paths do not repeatedly parse unchanged files.
    // The guarded helper makes schema-rewind migration replays idempotent while
    // rejecting partially applied or otherwise divergent column definitions.
    statements: []
  },
  {
    version: 104,
    name: "artifact_canonical_targets",
    // Issue: 9ceb090 — canonical artifact identity, version, and blob rows are
    // authoritative for new links, aliases, session attachments, and drafts.
    // SQLite cannot relax the legacy foreign keys in place, so the four tables
    // are rebuilt together by the marker-gated post migration below.
    statements: []
  },
  {
    version: 105,
    name: "space_export_canonical_artifacts",
    // Issue: 9ceb090 — Spaces export tracking stores canonical blob targets.
    // The historical artifact ids remain nullable read-compatibility provenance.
    statements: []
  },
  {
    version: 106,
    name: "trash_entries",
    // Issues 5cb1eb3 / 50d4a6b — durable custody records for reversible
    // local branch/worktree removal. Snapshot identity is immutable; lifecycle
    // columns record restore and GC outcomes without rewriting custody facts.
    statements: [
      `CREATE TABLE IF NOT EXISTS trash_entries (
        id               TEXT PRIMARY KEY,
        project_id       TEXT NOT NULL REFERENCES ledger_projects(id) ON DELETE RESTRICT,
        checkout_id      TEXT NOT NULL REFERENCES ledger_project_checkouts(id) ON DELETE RESTRICT,
        repo_root        TEXT NOT NULL,
        branch           TEXT NOT NULL,
        issue_refs_json  TEXT NOT NULL DEFAULT '[]'
                           CHECK(json_valid(issue_refs_json) AND json_type(issue_refs_json)='array'),
        reason           TEXT NOT NULL
                           CHECK(reason IN ('superseded','merged','abandoned','manual')),
        actor            TEXT NOT NULL,
        snapshot_ref     TEXT NOT NULL UNIQUE,
        snapshot_oid     TEXT NOT NULL,
        original_oid     TEXT NOT NULL,
        retention_policy TEXT NOT NULL DEFAULT 'trash-retention.v1',
        retention_days   INTEGER NOT NULL CHECK(retention_days BETWEEN 1 AND 3650),
        state            TEXT NOT NULL DEFAULT 'active'
                           CHECK(state IN (
                             'active','remove_failed','restored','expired',
                             'restore_failed','gc_pending','gc_failed'
                           )),
        created_at       INTEGER NOT NULL,
        expires_at       INTEGER NOT NULL,
        restored_at      INTEGER,
        expired_at       INTEGER,
        last_error       TEXT,
        outcome_json     TEXT NOT NULL DEFAULT '{}'
                           CHECK(json_valid(outcome_json) AND json_type(outcome_json)='object')
      )`,
      `CREATE INDEX IF NOT EXISTS idx_trash_entries_project_created
         ON trash_entries(project_id, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_trash_entries_expiry
         ON trash_entries(state, expires_at)`,
      `CREATE INDEX IF NOT EXISTS idx_trash_entries_branch
         ON trash_entries(project_id, branch, created_at DESC)`
    ]
  },
  {
    version: 107,
    name: "user_registry_core",
    // Umbrella 8e2e8b2 / issue e89c2b0 — foundation tables for the user system:
    // identities, immutable credentials, claimed bindings, verified attribution
    // evidence, and delegated-signing leases. Only the `system` user is seeded
    // (fixed sentinel id, created_at=0 so fresh-baseline and migrated DBs agree
    // byte-for-byte). The local human operator is created only by
    // `mandible user setup`; migrations never prompt. Credentials are immutable:
    // revoke + add, never mutate a fingerprint. Credential `type` is an
    // app-validated vocabulary, not a DB CHECK enum, so new types need no table
    // rebuild. No private key material is ever stored here.
    statements: [
      `CREATE TABLE IF NOT EXISTS users (
        id            TEXT PRIMARY KEY,
        slug          TEXT NOT NULL UNIQUE,
        kind          TEXT NOT NULL
                        CHECK(kind IN ('human','agent','system','external')),
        display_name  TEXT NOT NULL,
        email         TEXT,
        status        TEXT NOT NULL DEFAULT 'active'
                        CHECK(status IN ('active','retired')),
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
                        CHECK(json_valid(metadata_json) AND json_type(metadata_json)='object')
      )`,
      `CREATE TABLE IF NOT EXISTS user_credentials (
        id              TEXT PRIMARY KEY,
        user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        type            TEXT NOT NULL,
        fingerprint     TEXT NOT NULL,
        public_material TEXT,
        label           TEXT,
        status          TEXT NOT NULL DEFAULT 'active'
                          CHECK(status IN ('active','revoked')),
        created_at      INTEGER NOT NULL,
        revoked_at      INTEGER,
        metadata_json   TEXT NOT NULL DEFAULT '{}'
                          CHECK(json_valid(metadata_json) AND json_type(metadata_json)='object')
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_user_credentials_active_fingerprint
        ON user_credentials(fingerprint) WHERE status = 'active'`,
      `CREATE INDEX IF NOT EXISTS idx_user_credentials_user
        ON user_credentials(user_id)`,
      `CREATE TABLE IF NOT EXISTS delegated_signing_leases (
        id            TEXT PRIMARY KEY,
        credential_id TEXT NOT NULL REFERENCES user_credentials(id) ON DELETE RESTRICT,
        owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        minted_at     INTEGER NOT NULL,
        expires_at    INTEGER NOT NULL,
        mint_method   TEXT NOT NULL
                        CHECK(mint_method IN ('fresh_presence','reused_lease'))
      )`,
      `CREATE INDEX IF NOT EXISTS idx_delegated_signing_leases_credential
        ON delegated_signing_leases(credential_id)`,
      `CREATE INDEX IF NOT EXISTS idx_delegated_signing_leases_owner
        ON delegated_signing_leases(owner_user_id)`,
      `CREATE TABLE IF NOT EXISTS attribution_evidence (
        id              TEXT PRIMARY KEY,
        evidence_method TEXT NOT NULL,
        credential_id   TEXT REFERENCES user_credentials(id) ON DELETE SET NULL,
        lease_id        TEXT REFERENCES delegated_signing_leases(id) ON DELETE SET NULL,
        verified_at     INTEGER NOT NULL,
        details_json    TEXT NOT NULL DEFAULT '{}'
                          CHECK(json_valid(details_json) AND json_type(details_json)='object')
      )`,
      `CREATE INDEX IF NOT EXISTS idx_attribution_evidence_credential
        ON attribution_evidence(credential_id) WHERE credential_id IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS idx_attribution_evidence_lease
        ON attribution_evidence(lease_id) WHERE lease_id IS NOT NULL`,
      `CREATE TABLE IF NOT EXISTS user_bindings (
        id           TEXT PRIMARY KEY,
        user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        binding_type TEXT NOT NULL
                       CHECK(binding_type IN ('app_name','provider_session_env','process_pattern','git_author_email','external_author')),
        value        TEXT NOT NULL,
        scope        TEXT,
        status       TEXT NOT NULL DEFAULT 'active'
                       CHECK(status IN ('active','inactive')),
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_user_bindings_user
        ON user_bindings(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_user_bindings_lookup
        ON user_bindings(binding_type, value)`,
      `INSERT OR IGNORE INTO users (
        id, slug, kind, display_name, email, status, created_at, updated_at, metadata_json
      ) VALUES (
        '00000000000000000000000000', 'system', 'system', 'System', NULL, 'active', 0, 0, '{}'
      )`
    ]
  },
  {
    version: 108,
    name: "ledger_user_attribution_columns",
    // Umbrella 8e2e8b2 / issue 92813cc — parallel, nullable user-attribution
    // columns on ledger write tables. The legacy actor_id/actor_type/
    // author_display columns are immutable provenance (hashed into stable
    // event/issue/comment ids) and are untouched here; these columns carry the
    // resolved user principal alongside them. NULL means legacy/unresolved.
    // FK to users(id) makes the parallel identity fail-closed: a non-null value
    // must name a real user. evidence_id optionally points at a verified
    // attribution_evidence row. The ALTER ADD COLUMN work is applied by the
    // guarded ensureLedgerUserAttributionColumns() hook, which also creates the
    // partial indexes (IF NOT EXISTS) only for tables that exist. Keeping the
    // index creation inside the hook lets a synthetic partial-schema upgrade
    // (e.g. an auth-only fixture DB with no ledger_* tables) migrate cleanly.
    //
    // Also enforce at most one ACTIVE user_bindings row per (binding_type,
    // value, scope) so a binding value resolves to a single user (used by shadow
    // import minting and session-binding resolution). SQLite treats NULLs as
    // distinct in unique indexes, so scope IS NULL needs its own partial index.
    statements: [
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_user_bindings_active_scoped
        ON user_bindings(binding_type, value, scope)
        WHERE status = 'active' AND scope IS NOT NULL`,
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_user_bindings_active_unscoped
        ON user_bindings(binding_type, value)
        WHERE status = 'active' AND scope IS NULL`
    ]
  },
  {
    version: 109,
    name: "auth_request_user_attribution",
    // Umbrella 8e2e8b2 / issue 6349203 — durable requester, approver, and
    // execution-evidence attribution for auth requests. Columns remain nullable
    // so legacy rows are preserved byte-for-byte; every new transport write is
    // populated and validated by AuthQueue/route boundaries.
    // Guarded by ensureAuthRequestUserAttributionColumns() so schema-rewind
    // tests and interrupted upgrades can safely re-enter v109.
    statements: []
  },
  {
    version: 110,
    name: "session_work_unit_ownership",
    // Umbrella 8e2e8b2 / issue e552606 — immutable, nullable user ownership
    // captured when sessions, console sessions, and work units are registered.
    // Legacy rows stay NULL; migrations never infer or create a user.
    statements: []
  },
  {
    version: 111,
    name: "user_groups_project_permissions",
    // Umbrella 8e2e8b2 / issue a0379a3 — opt-in project restrictions and
    // explicit user/group grants. Existing projects remain unrestricted and
    // the only migration seed is the system-owned agents group; users are
    // enrolled deliberately by the user provisioning path.
    statements: [
      `CREATE TABLE IF NOT EXISTS user_groups (
        id           TEXT PRIMARY KEY,
        slug         TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        kind         TEXT NOT NULL DEFAULT 'custom'
                       CHECK(kind IN ('system','custom')),
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS user_group_members (
        group_id  TEXT NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
        user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (group_id, user_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_user_group_members_user
        ON user_group_members(user_id, group_id)`,
      `CREATE TABLE IF NOT EXISTS permission_grants (
        id            TEXT PRIMARY KEY,
        subject_type  TEXT NOT NULL CHECK(subject_type IN ('user','group')),
        subject_id    TEXT NOT NULL,
        resource_type TEXT NOT NULL CHECK(resource_type IN ('project','global')),
        resource_id   TEXT REFERENCES ledger_projects(id) ON DELETE CASCADE,
        permission    TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        CHECK (
          (resource_type = 'project' AND resource_id IS NOT NULL
            AND permission IN ('read','write','admin')) OR
          (resource_type = 'global' AND resource_id IS NULL
            AND permission IN ('approve_auth','spawn_console','change_settings','backup','open_path'))
        )
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_permission_grants_project
        ON permission_grants(subject_type, subject_id, resource_id, permission)
        WHERE resource_type = 'project'`,
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_permission_grants_global
        ON permission_grants(subject_type, subject_id, permission)
        WHERE resource_type = 'global'`,
      `CREATE INDEX IF NOT EXISTS idx_permission_grants_subject
        ON permission_grants(subject_type, subject_id)`,
      `CREATE INDEX IF NOT EXISTS idx_permission_grants_resource
        ON permission_grants(resource_type, resource_id)`,
      `INSERT OR IGNORE INTO user_groups (
        id, slug, display_name, kind, created_at, updated_at
      ) VALUES (
        '00000000000000000000000001', 'agents', 'Agents', 'system', 0, 0
      )`
    ]
  },
  {
    // Integration reconciliation (umbrella c16807e): renumbered to 112 atop
    // main's user-system migrations 107-111.
    version: 112,
    name: "branch_upstream_cache",
    // Issue 651e820 — persist per-branch upstream tracking info during scans so
    // GET /api/work/repos/:id/branches serves it from the DB instead of spawning
    // `git rev-parse @{upstream}` per branch on every request. The columns are
    // added by the guarded post-migration below so a schema-rewind replay against
    // a baseline that already carries them is idempotent.
    statements: []
  },
  {
    // Integration reconciliation (umbrella c16807e): renumbered to 113 atop
    // main's user-system migrations 107-111 (branch_upstream_cache took 112).
    version: 113,
    name: "work_unit_merge_scan_retirement",
    // Issue 93d978e — reversible tombstone excluding stale abandoned work units
    // from merge-side ancestry scans. Nullable ms-epoch marker; the row, its
    // state, and its provenance survive. Clearing it re-admits the row. The
    // additive column is added by a guarded hook (ensureWorkUnitMergeScanRetirementColumn)
    // so re-migration over a DB that already has the column is idempotent,
    // matching the pattern used for the v106 branch-reaping columns.
    statements: []
  },
  {
    // Integration reconciliation (umbrella c16807e): renumbered to 114 atop
    // main's user-system migrations 107-111 (work_unit retirement took 113).
    version: 114,
    name: "auth_request_merge_finalizer_state",
    // Issue 75f52ac — per-step durable state for the background finalizer queue.
    // Nullable JSON column recording each Stage 3 finalizer step's state,
    // attempts, and last error so a daemon restart mid-finalizer resumes the
    // remaining steps instead of losing or double-applying work. The additive
    // column is added by a guarded hook (ensureAuthRequestMergeFinalizerStateColumn)
    // so re-migration over a DB that already has the column is idempotent,
    // matching the v106/v107 additive-column pattern.
    statements: []
  },
  {
    version: 115,
    name: "clear_local_default_ledger_misattribution",
    // Issue a64d2de — corrective data migration. Tokenless compat-mode ledger
    // writes were stamped with the operator's user id and
    // evidence_method='local_default', misattributing agent-performed actions to
    // the operator in the dashboard. The write-path fix now stores NULL for such
    // writes; this migration retroactively clears the operator misattribution on
    // existing rows. It nulls ONLY the parallel user-attribution columns
    // (author_user_id/actor_user_id, evidence_method, evidence_id) and ONLY on
    // rows whose evidence_method is exactly 'local_default', across ledger_issues,
    // ledger_comments, ledger_issue_checkpoints, ledger_events,
    // ledger_relationship_edges, and ledger_body_revisions. Rows carrying
    // session_claim, api_token, credential_signature, system_internal, or
    // external_import evidence are untouched, as are the frozen legacy
    // actor_id/actor_type/author_display provenance columns (which restore the
    // generic 'Mandible' display via the read-projection fallback). Applied by
    // the guarded clearLocalDefaultLedgerAttribution() hook so a partial-schema
    // or schema-rewind replay is safe; the UPDATE is naturally idempotent
    // because a second run finds no 'local_default' rows left.
    //
    // Deliberate lossiness: a historical 'local_default' stamp is an
    // indistinguishable guess — the pre-fix code attributed the operator to
    // EVERY tokenless write regardless of who actually acted, so these rows are
    // majority-misattributed and carry no signal worth preserving. Clearing them
    // to the honest legacy 'Mandible' display is strictly more truthful than
    // keeping a confident-but-wrong operator id. This is a one-way data change;
    // an operator DB backup precedes the protected-branch merge, so the original
    // bytes remain recoverable if ever needed.
    statements: []
  },
  {
    version: 116,
    name: "session_identity_mismatch_flag",
    // Issue 499c148 — record when a session's authenticated client user and its
    // binding-resolved user disagree. Two nullable additive columns on sessions:
    // identity_mismatch_at (ms epoch of the most recent disagreeing
    // registration, NULL when consistent or never checked) and
    // identity_mismatch_json (the structured detail shown in warnings and the
    // dashboard). This is surfacing state only — no write path consults it for
    // authorization, and the auth-request requester gate is unchanged. Added by
    // the guarded ensureSessionIdentityMismatchColumns() hook so a replay over a
    // DB that already carries the columns is idempotent, matching the
    // v106/v107/v114 additive-column pattern.
    statements: []
  },
  {
    version: 117,
    name: "clear_residual_local_default_ledger_misattribution",
    // Issue be2ab49 — one-shot corrective follow-up to migration 115.
    //
    // Integration renumbering: this entry was authored as migration 116 on its
    // feature branch and moved to 117 on integration. Issue 499c148's
    // session_identity_mismatch_flag migration had already executed against the
    // live production database as version 116, so that number is taken there;
    // keeping this sweep at 116 would make the live DB skip it forever.
    //
    // Deployment-history rationale: migration 115 (evidence class 'local_default'
    // clearing) was executed prematurely against the live production database by
    // a test-invoked code path on an unmerged feature branch (issue 07edc0d),
    // consuming schema_version 115. The still-running old daemon then kept writing
    // NEW rows stamped evidence_method='local_default' from 17:53Z until the
    // post-merge restart at 00:29:16Z. Because the version was already at 115, the
    // post-merge restart skipped migration 115 and never cleared those residual
    // rows, leaving them misattributed to the operator. This migration clears the
    // residual window.
    //
    // Scope: it nulls the SAME parallel user-attribution columns as v115
    // (author_user_id/actor_user_id, evidence_method, evidence_id) on
    // evidence_method='local_default' rows, but adds two guards so it touches
    // only THIS deployment's residue (see clearResidualLocalDefaultLedgerAttribution
    // for the full detail):
    //   - the attribution user column must equal this deployment's operator id
    //     (verified: all 424 residual rows carry it, no other id appears
    //     pre-cutoff), so a restored backup or a different install at v115 is a
    //     no-op even if it has its own local_default rows; and
    //   - the row's attribution-write timestamp must be strictly before the
    //     v115-merge cutoff (08bcc7c, "2026-07-23 20:29:16 -0400"). Edges use
    //     COALESCE(updated_at, created_at) because relinks overwrite attribution
    //     in place while preserving created_at; the other five tables set
    //     attribution once at creation.
    // Empirically zero local_default rows exist at or after the cutoff, so the
    // boundary strands nothing legitimate. Frozen legacy actor_id/actor_type/
    // author_display provenance columns are untouched (the read-projection
    // restores the generic 'Mandible' display).
    //
    // One-shot: this targets a specific historical residue on the live DB. On a
    // fresh database the fresh-baseline path applies and this migration never
    // runs; on any DB with no matching residual rows the UPDATE is a no-op. It is
    // naturally idempotent (a second run finds nothing to clear).
    statements: []
  },
  {
    version: 118,
    name: "canonical_project_repo_ids",
    // Issue 13b071e — a numbered, path-derived WorkScanner id leaked through
    // Feedbax project APIs even after canonical project_key was introduced.
    // Canonicalize that checkout and its current operational references, then
    // align the affected WorkScanner roots. The outward projection fix is
    // generic; this data rewrite is intentionally limited to the user-approved
    // Feedbax correction. Immutable ledger bodies/events and daemon logs remain
    // historical evidence and are not rewritten.
    statements: []
  },
  {
    version: 119,
    name: "auth_request_merge_candidate_tree",
    // Issue 8d12c96 — persist the exact submit-time merge-tree candidate. The
    // queue also keeps this tree reachable through a request-scoped private Git
    // ref while the request is live, so ordinary object pruning cannot discard
    // the candidate before approval.
    statements: []
  },
  {
    version: 120,
    name: "briefing_review_candidates",
    // Umbrella 99b74d6 / issue ce22a3a — the briefing review store. A candidate
    // is one reviewable finding within a source; a revision is one
    // (candidate, evidence_hash) pair; an occurrence is one sighting of a
    // revision in one ingest batch. Review state is DERIVED from the append-only
    // decision_events stream (no mutable status column): a candidate is pending
    // iff its current revision's last decision event is absent or `undo`.
    // `briefing_batches` is the ingestion idempotency ledger — a replayed
    // batch_key writes nothing and returns the original result.
    statements: [
      `CREATE TABLE IF NOT EXISTS review_candidates (
        id                  TEXT PRIMARY KEY,
        source              TEXT NOT NULL,
        candidate_key       TEXT NOT NULL,
        current_revision_id TEXT,
        created_at          INTEGER NOT NULL,
        UNIQUE(source, candidate_key)
      )`,
      `CREATE TABLE IF NOT EXISTS candidate_revisions (
        id                TEXT PRIMARY KEY,
        candidate_id      TEXT NOT NULL REFERENCES review_candidates(id) ON DELETE CASCADE,
        title             TEXT NOT NULL,
        why_notable       TEXT,
        refs_json         TEXT NOT NULL DEFAULT '[]'
                            CHECK(json_valid(refs_json) AND json_type(refs_json)='array'),
        source_ref        TEXT,
        evidence_hash     TEXT NOT NULL,
        evidence_kind     TEXT NOT NULL
                            CHECK(evidence_kind IN ('snapshot-item','finding-only')),
        captured_at       TEXT,
        run_id            TEXT,
        digest_series_ref TEXT,
        digest_version    INTEGER,
        rank              INTEGER,
        batch_key         TEXT NOT NULL,
        ingested_at       INTEGER NOT NULL,
        UNIQUE(candidate_id, evidence_hash)
      )`,
      `CREATE TABLE IF NOT EXISTS candidate_occurrences (
        id             TEXT PRIMARY KEY,
        revision_id    TEXT NOT NULL REFERENCES candidate_revisions(id) ON DELETE CASCADE,
        digest_version INTEGER,
        batch_key      TEXT NOT NULL,
        seen_at        INTEGER NOT NULL,
        UNIQUE(revision_id, batch_key)
      )`,
      `CREATE TABLE IF NOT EXISTS decision_events (
        id            TEXT PRIMARY KEY,
        candidate_id  TEXT NOT NULL REFERENCES review_candidates(id) ON DELETE CASCADE,
        revision_id   TEXT NOT NULL REFERENCES candidate_revisions(id) ON DELETE CASCADE,
        action        TEXT NOT NULL CHECK(action IN ('keep','dismiss','undo','expire')),
        actor_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
        comment_id    TEXT,
        created_at    INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS candidate_comments (
        id            TEXT PRIMARY KEY,
        candidate_id  TEXT NOT NULL REFERENCES review_candidates(id) ON DELETE CASCADE,
        revision_id   TEXT NOT NULL REFERENCES candidate_revisions(id) ON DELETE CASCADE,
        body          TEXT NOT NULL,
        actor_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
        created_at    INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS briefing_batches (
        batch_key         TEXT PRIMARY KEY,
        task_identity     TEXT NOT NULL,
        run_id            TEXT,
        digest_series_ref TEXT,
        digest_version    INTEGER,
        item_count        INTEGER NOT NULL DEFAULT 0,
        received_at       INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_review_candidates_source
         ON review_candidates(source, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_candidate_revisions_candidate
         ON candidate_revisions(candidate_id, ingested_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_candidate_revisions_batch
         ON candidate_revisions(batch_key)`,
      `CREATE INDEX IF NOT EXISTS idx_candidate_occurrences_revision
         ON candidate_occurrences(revision_id, seen_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_candidate_occurrences_batch
         ON candidate_occurrences(batch_key)`,
      `CREATE INDEX IF NOT EXISTS idx_decision_events_revision
         ON decision_events(revision_id, created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_decision_events_candidate
         ON decision_events(candidate_id, created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_candidate_comments_candidate
         ON candidate_comments(candidate_id, created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_briefing_batches_task
         ON briefing_batches(task_identity, digest_version)`
    ]
  },
  {
    version: 121,
    name: "space_items_finding_refs",
    // Umbrella 99b74d6 (contract §6 / §7 amendment) — a Space may reference a
    // briefing finding, so `space_items.ref_type` must admit 'finding'. SQLite
    // cannot alter a CHECK in place, so existing databases rebuild the table in
    // the gated post-migration helper below (same shape as v90's 'space'
    // expansion). Fresh databases and full replays get the expanded CHECK
    // directly from the spaces_core DDL above, so the rebuild is a no-op there.
    statements: []
  },
  {
    version: 122,
    name: "agent_dispatch_events",
    // Umbrella 99b74d6 / issue ce83a84 — the handling-event ledger for
    // human-initiated agent dispatch. One row is one dispatch attempt. The row
    // is written BEFORE the external session is spawned (status `dispatching`)
    // and settles exactly once into `dispatched` or `failed`, so a daemon that
    // dies mid-spawn leaves an honest unsettled row rather than a silent gap.
    // Rows are never deleted or re-purposed: this table IS the audit chain
    // comment -> handling event -> session handle.
    //
    // A finding dispatch carries candidate/revision/comment ids (the comment is
    // the immutable owner instruction, stored first); an issue dispatch carries
    // the ledger issue id. `instruction` keeps the verbatim human task text on
    // the event so the audit record does not depend on the prompt file
    // surviving on disk.
    statements: [
      `CREATE TABLE IF NOT EXISTS agent_dispatch_events (
        id             TEXT PRIMARY KEY,
        subject_kind   TEXT NOT NULL CHECK(subject_kind IN ('finding','issue')),
        candidate_id   TEXT REFERENCES review_candidates(id) ON DELETE CASCADE,
        revision_id    TEXT REFERENCES candidate_revisions(id) ON DELETE CASCADE,
        comment_id     TEXT REFERENCES candidate_comments(id) ON DELETE SET NULL,
        issue_id       TEXT,
        actor_user_id  TEXT REFERENCES users(id) ON DELETE RESTRICT,
        provider       TEXT NOT NULL DEFAULT 'claude',
        instruction    TEXT NOT NULL,
        cwd            TEXT NOT NULL,
        prompt_path    TEXT,
        prompt_sha256  TEXT,
        status         TEXT NOT NULL
                         CHECK(status IN ('dispatching','dispatched','failed')),
        session_handle TEXT,
        session_id     TEXT,
        attach_command TEXT,
        error          TEXT,
        created_at     INTEGER NOT NULL,
        settled_at     INTEGER
      )`,
      `CREATE INDEX IF NOT EXISTS idx_agent_dispatch_events_candidate
         ON agent_dispatch_events(candidate_id, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_agent_dispatch_events_issue
         ON agent_dispatch_events(issue_id, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_agent_dispatch_events_comment
         ON agent_dispatch_events(comment_id)`
    ]
  },
  {
    version: 123,
    name: "auth_request_canonical_change_message",
    // Issue 7d64d8f — the canonical change message binding. `commit_message`
    // already existed as free-form review text; this column records the
    // SHA-256 of the canonical bytes of an *agent-authored* change message.
    // Its presence is the discriminator: a request with a digest carries a
    // canonical message that cli/auth-merge.sh must use verbatim as the merge
    // commit message, and a request without one keeps the legacy
    // `git fmt-merge-msg` behaviour.
    //
    // Applied through a guarded helper rather than a bare ALTER because this
    // repo's migration fixtures deliberately rewind schema_version and replay
    // over databases that already carry later columns; a bare ALTER fails those
    // replays with "duplicate column name". Unlike a plain existence check, the
    // helper verifies the existing column's exact declared shape and throws on
    // divergence, so a replay can never silently accept a different column.
    statements: []
  },
  {
    version: 124,
    name: "task_inventory_generations",
    // Issue 0bc2279 — executor task inventory receipts. Append-only: one row is
    // one atomic generation exactly as an authenticated executor posted it,
    // with the principal that posted it and a content digest over the canonical
    // payload. There is no per-task table and no mutable task state: the Tasks
    // view is a PROJECTION of the latest generation per executor, so a replayed
    // or reordered post can never leave the view holding halves of two
    // different observations. `(executor_name, digest)` is UNIQUE, which is the
    // idempotency mechanism — re-posting the same canonical generation for one
    // executor is refused by the index and answered with the original receipt,
    // without letting a synthetic cross-executor collision suppress a receipt.
    statements: [
      `CREATE TABLE IF NOT EXISTS task_inventory_generations (
        id                TEXT PRIMARY KEY,
        digest            TEXT NOT NULL,
        schema_id         TEXT NOT NULL,
        executor_name     TEXT NOT NULL,
        executor_version  TEXT NOT NULL,
        capabilities_json TEXT NOT NULL DEFAULT '[]'
                            CHECK(json_valid(capabilities_json)
                              AND json_type(capabilities_json)='array'),
        observed_at       INTEGER NOT NULL,
        task_count        INTEGER NOT NULL DEFAULT 0,
        payload_json      TEXT NOT NULL CHECK(json_valid(payload_json)),
        posted_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        created_at        INTEGER NOT NULL,
        UNIQUE(executor_name, digest)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_task_inventory_generations_executor
         ON task_inventory_generations(executor_name, observed_at DESC, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_task_inventory_generations_received
         ON task_inventory_generations(created_at DESC)`
    ]
  },
  {
    version: 125,
    name: "feedback_schema_foundation",
    statements: [
      `CREATE TABLE IF NOT EXISTS feedback_collections (
        id                TEXT PRIMARY KEY,
        kind              TEXT NOT NULL
                          CHECK(kind IN ('recurring_feed','bounded_ask')),
        interaction_mode  TEXT NOT NULL
                          CHECK(interaction_mode IN ('immediate_per_item','explicit_submit')),
        source            TEXT,
        created_at        INTEGER NOT NULL,
        tombstoned_at     INTEGER,
        CHECK (
          (kind = 'recurring_feed'
            AND interaction_mode = 'immediate_per_item'
            AND source IS NOT NULL
            AND trim(source) != '')
          OR
          (kind = 'bounded_ask'
            AND interaction_mode = 'explicit_submit'
            AND source IS NULL)
        )
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_feedback_collections_recurring_source
        ON feedback_collections(kind, source)
        WHERE kind = 'recurring_feed'`,
      `CREATE INDEX IF NOT EXISTS idx_feedback_collections_kind_created
        ON feedback_collections(kind, created_at DESC)`,
      `CREATE TABLE IF NOT EXISTS feedback_recurring_profiles (
        collection_id       TEXT PRIMARY KEY
                            REFERENCES feedback_collections(id) ON DELETE RESTRICT,
        source_namespace    TEXT NOT NULL CHECK(trim(source_namespace) != ''),
        item_expiry_ms      INTEGER NOT NULL CHECK(item_expiry_ms > 0),
        created_at          INTEGER NOT NULL,
        updated_at          INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS feedback_ask_sessions (
        collection_id             TEXT PRIMARY KEY
                                  REFERENCES feedback_collections(id) ON DELETE RESTRICT,
        requester_user_id         TEXT NOT NULL
                                  REFERENCES users(id) ON DELETE RESTRICT,
        requester_session_id      TEXT NOT NULL
                                  REFERENCES sessions(id) ON DELETE RESTRICT,
        request_key               TEXT NOT NULL CHECK(trim(request_key) != ''),
        request_digest            TEXT NOT NULL CHECK(trim(request_digest) != ''),
        responder_user_ids_json   TEXT NOT NULL
                                  CHECK(json_valid(responder_user_ids_json)
                                    AND json_type(responder_user_ids_json) = 'array'),
        expires_at                INTEGER NOT NULL,
        retention_expires_at      INTEGER,
        created_at                INTEGER NOT NULL,
        UNIQUE(requester_user_id, requester_session_id, request_key),
        CHECK(expires_at > created_at),
        CHECK(retention_expires_at IS NULL OR retention_expires_at >= expires_at)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_feedback_ask_sessions_requester
        ON feedback_ask_sessions(requester_user_id, requester_session_id, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_feedback_ask_sessions_expiry
        ON feedback_ask_sessions(expires_at)`,
      `CREATE TABLE IF NOT EXISTS feedback_publications (
        id                  TEXT PRIMARY KEY,
        collection_id       TEXT NOT NULL
                            REFERENCES feedback_collections(id) ON DELETE RESTRICT,
        publication_key     TEXT NOT NULL CHECK(trim(publication_key) != ''),
        publisher_user_id   TEXT REFERENCES users(id) ON DELETE RESTRICT,
        task_identity       TEXT NOT NULL CHECK(trim(task_identity) != ''),
        run_id              TEXT,
        digest_series_ref   TEXT,
        digest_version      INTEGER,
        item_count          INTEGER NOT NULL DEFAULT 0 CHECK(item_count >= 0),
        received_at         INTEGER NOT NULL,
        UNIQUE(collection_id, publication_key)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_feedback_publications_collection
        ON feedback_publications(collection_id, received_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_feedback_publications_task_digest
        ON feedback_publications(task_identity, digest_version)`,
      `CREATE TABLE IF NOT EXISTS feedback_items (
        id                   TEXT PRIMARY KEY,
        collection_id        TEXT NOT NULL
                             REFERENCES feedback_collections(id) ON DELETE RESTRICT,
        parent_item_id       TEXT REFERENCES feedback_items(id) ON DELETE RESTRICT,
        item_kind            TEXT NOT NULL CHECK(item_kind IN ('item','group')),
        identity_mode        TEXT NOT NULL
                             CHECK(identity_mode IN ('publisher_dedup','opaque')),
        external_key         TEXT,
        client_item_key      TEXT,
        current_revision_id  TEXT
                             REFERENCES feedback_item_revisions(id) ON DELETE RESTRICT,
        created_at           INTEGER NOT NULL,
        tombstoned_at        INTEGER,
        CHECK(parent_item_id IS NULL OR parent_item_id != id),
        CHECK(
          (identity_mode = 'publisher_dedup'
            AND external_key IS NOT NULL
            AND trim(external_key) != '')
          OR
          (identity_mode = 'opaque' AND external_key IS NULL)
        )
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_feedback_items_publisher_identity
        ON feedback_items(collection_id, external_key)
        WHERE identity_mode = 'publisher_dedup'`,
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_feedback_items_client_key
        ON feedback_items(collection_id, client_item_key)
        WHERE client_item_key IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS idx_feedback_items_collection
        ON feedback_items(collection_id, created_at, id)`,
      `CREATE INDEX IF NOT EXISTS idx_feedback_items_parent
        ON feedback_items(parent_item_id)
        WHERE parent_item_id IS NOT NULL`,
      `CREATE TABLE IF NOT EXISTS feedback_item_revisions (
        id                TEXT PRIMARY KEY,
        item_id           TEXT NOT NULL
                          REFERENCES feedback_items(id) ON DELETE RESTRICT,
        ordinal           INTEGER NOT NULL CHECK(ordinal > 0),
        title             TEXT NOT NULL,
        prompt            TEXT NOT NULL,
        description       TEXT,
        response_type     TEXT
                          CHECK(response_type IS NULL OR response_type IN (
                            'verdict','free_text','single_choice','multi_choice'
                          )),
        required          INTEGER NOT NULL DEFAULT 0 CHECK(required IN (0,1)),
        content_json      TEXT NOT NULL DEFAULT '{}'
                          CHECK(json_valid(content_json)
                            AND json_type(content_json) = 'object'),
        evidence_digest   TEXT,
        publication_id    TEXT
                          REFERENCES feedback_publications(id) ON DELETE RESTRICT,
        position          INTEGER NOT NULL DEFAULT 0 CHECK(position >= 0),
        created_at        INTEGER NOT NULL,
        UNIQUE(item_id, ordinal)
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_feedback_item_revisions_evidence
        ON feedback_item_revisions(item_id, evidence_digest)
        WHERE evidence_digest IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS idx_feedback_item_revisions_item
        ON feedback_item_revisions(item_id, ordinal DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_feedback_item_revisions_publication
        ON feedback_item_revisions(publication_id)
        WHERE publication_id IS NOT NULL`,
      `CREATE TABLE IF NOT EXISTS feedback_item_options (
        revision_id   TEXT NOT NULL
                      REFERENCES feedback_item_revisions(id) ON DELETE RESTRICT,
        option_key    TEXT NOT NULL CHECK(trim(option_key) != ''),
        label         TEXT NOT NULL,
        description   TEXT,
        position      INTEGER NOT NULL CHECK(position >= 0),
        PRIMARY KEY(revision_id, option_key),
        UNIQUE(revision_id, position)
      )`,
      `CREATE TABLE IF NOT EXISTS feedback_publication_items (
        id                TEXT PRIMARY KEY,
        publication_id    TEXT NOT NULL
                          REFERENCES feedback_publications(id) ON DELETE RESTRICT,
        item_revision_id  TEXT NOT NULL
                          REFERENCES feedback_item_revisions(id) ON DELETE RESTRICT,
        position          INTEGER CHECK(position IS NULL OR position >= 0),
        seen_at           INTEGER NOT NULL,
        UNIQUE(publication_id, item_revision_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_feedback_publication_items_revision
        ON feedback_publication_items(item_revision_id, seen_at DESC)`,
      `CREATE TABLE IF NOT EXISTS feedback_collection_events (
        id                 TEXT PRIMARY KEY,
        collection_id      TEXT NOT NULL
                           REFERENCES feedback_collections(id) ON DELETE RESTRICT,
        operation          TEXT NOT NULL
                           CHECK(operation IN (
                             'opened','submitted','expired','cancelled','closed'
                           )),
        previous_event_id  TEXT
                           REFERENCES feedback_collection_events(id) ON DELETE RESTRICT,
        actor_user_id      TEXT REFERENCES users(id) ON DELETE RESTRICT,
        metadata_json      TEXT NOT NULL DEFAULT '{}'
                           CHECK(json_valid(metadata_json)
                             AND json_type(metadata_json) = 'object'),
        created_at         INTEGER NOT NULL
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_feedback_collection_event_successor
        ON feedback_collection_events(collection_id, previous_event_id)
        WHERE previous_event_id IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS idx_feedback_collection_events_head
        ON feedback_collection_events(collection_id, created_at DESC)`,
      `CREATE TABLE IF NOT EXISTS feedback_item_events (
        id                TEXT PRIMARY KEY,
        item_id           TEXT NOT NULL
                          REFERENCES feedback_items(id) ON DELETE RESTRICT,
        item_revision_id  TEXT NOT NULL
                          REFERENCES feedback_item_revisions(id) ON DELETE RESTRICT,
        operation         TEXT NOT NULL CHECK(operation IN ('expired')),
        actor_user_id     TEXT REFERENCES users(id) ON DELETE RESTRICT,
        created_at        INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_feedback_item_events_revision
        ON feedback_item_events(item_revision_id, created_at DESC)`,
      `CREATE TABLE IF NOT EXISTS feedback_response_events (
        id                 TEXT PRIMARY KEY,
        collection_id      TEXT NOT NULL
                           REFERENCES feedback_collections(id) ON DELETE RESTRICT,
        item_id            TEXT NOT NULL
                           REFERENCES feedback_items(id) ON DELETE RESTRICT,
        item_revision_id   TEXT NOT NULL
                           REFERENCES feedback_item_revisions(id) ON DELETE RESTRICT,
        operation          TEXT NOT NULL CHECK(operation IN ('set','retract')),
        value_json         TEXT,
        retracts_event_id  TEXT
                           REFERENCES feedback_response_events(id) ON DELETE RESTRICT,
        actor_user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        created_at         INTEGER NOT NULL,
        CHECK(
          (operation = 'set'
            AND value_json IS NOT NULL
            AND json_valid(value_json)
            AND json_type(value_json) = 'object'
            AND retracts_event_id IS NULL)
          OR
          (operation = 'retract'
            AND value_json IS NULL
            AND retracts_event_id IS NOT NULL)
        )
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_feedback_response_retraction
        ON feedback_response_events(retracts_event_id)
        WHERE operation = 'retract'`,
      `CREATE INDEX IF NOT EXISTS idx_feedback_response_events_revision
        ON feedback_response_events(item_revision_id, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_feedback_response_events_collection_actor
        ON feedback_response_events(collection_id, actor_user_id, created_at DESC)`,
      `CREATE TABLE IF NOT EXISTS feedback_submissions (
        id                         TEXT PRIMARY KEY,
        collection_id              TEXT NOT NULL
                                   REFERENCES feedback_collections(id) ON DELETE RESTRICT,
        ordinal                    INTEGER NOT NULL CHECK(ordinal > 0),
        supersedes_submission_id   TEXT
                                   REFERENCES feedback_submissions(id) ON DELETE RESTRICT,
        lifecycle_event_id         TEXT NOT NULL UNIQUE
                                   REFERENCES feedback_collection_events(id) ON DELETE RESTRICT,
        actor_user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        created_at                 INTEGER NOT NULL,
        UNIQUE(collection_id, ordinal)
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_feedback_submission_superseded_once
        ON feedback_submissions(supersedes_submission_id)
        WHERE supersedes_submission_id IS NOT NULL`,
      `CREATE TABLE IF NOT EXISTS feedback_submission_answers (
        submission_id      TEXT NOT NULL
                           REFERENCES feedback_submissions(id) ON DELETE RESTRICT,
        item_id            TEXT NOT NULL
                           REFERENCES feedback_items(id) ON DELETE RESTRICT,
        item_revision_id   TEXT NOT NULL
                           REFERENCES feedback_item_revisions(id) ON DELETE RESTRICT,
        response_event_id  TEXT NOT NULL
                           REFERENCES feedback_response_events(id) ON DELETE RESTRICT,
        position           INTEGER NOT NULL DEFAULT 0 CHECK(position >= 0),
        PRIMARY KEY(submission_id, item_id),
        UNIQUE(submission_id, response_event_id)
      )`,
      `CREATE TABLE IF NOT EXISTS feedback_comments (
        id                TEXT PRIMARY KEY,
        collection_id     TEXT NOT NULL
                          REFERENCES feedback_collections(id) ON DELETE RESTRICT,
        item_id           TEXT NOT NULL
                          REFERENCES feedback_items(id) ON DELETE RESTRICT,
        item_revision_id  TEXT NOT NULL
                          REFERENCES feedback_item_revisions(id) ON DELETE RESTRICT,
        body              TEXT NOT NULL CHECK(trim(body) != ''),
        actor_user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        created_at        INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_feedback_comments_item
        ON feedback_comments(item_id, created_at)`
    ]
  },
  {
    version: 126,
    name: "feedback_recurring_cutover",
    // The destructive work runs in the guarded migration helper, outside the
    // generic transaction, so PRAGMA foreign_keys=OFF takes effect first.
    statements: [],
  },
  {
    version: 127,
    name: "briefing_ingest_v2_replay_identity",
    statements: [
      `CREATE TABLE IF NOT EXISTS feedback_ingest_requests (
        id                 TEXT PRIMARY KEY,
        publisher_user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        task_identity      TEXT NOT NULL CHECK(trim(task_identity) != ''),
        batch_key          TEXT NOT NULL CHECK(trim(batch_key) != ''),
        request_digest     TEXT NOT NULL
                           CHECK(length(request_digest) = 64
                             AND request_digest NOT GLOB '*[^0-9a-f]*'),
        schema_id          TEXT NOT NULL
                           CHECK(schema_id IN ('briefing-ingest@1','briefing-ingest@2')),
        result_json        TEXT NOT NULL DEFAULT '{}'
                           CHECK(json_valid(result_json)
                             AND json_type(result_json) = 'object'),
        received_at        INTEGER NOT NULL,
        UNIQUE(publisher_user_id, task_identity, batch_key)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_feedback_ingest_requests_received
        ON feedback_ingest_requests(received_at DESC)`,
    ],
  },
  {
    version: 128,
    name: "task_disable_command_protocol",
    // Issue 548bd73 — immutable operator-authored disable requests and
    // append-only executor receipts. Lifecycle is derived from events; no
    // expiry or mutable state column exists by design.
    statements: [
      `CREATE TABLE IF NOT EXISTS task_command_requests (
        id                   TEXT PRIMARY KEY,
        schema_id            TEXT NOT NULL CHECK(schema_id = 'task-command@1'),
        request_key          TEXT NOT NULL CHECK(trim(request_key) != ''),
        request_digest       TEXT NOT NULL
                             CHECK(length(request_digest) = 64
                               AND request_digest NOT GLOB '*[^0-9a-f]*'),
        executor_name        TEXT NOT NULL CHECK(trim(executor_name) != ''),
        task_id              TEXT NOT NULL CHECK(trim(task_id) != ''),
        verb                 TEXT NOT NULL CHECK(verb = 'disable'),
        payload_json         TEXT NOT NULL DEFAULT '{}'
                             CHECK(json_valid(payload_json)
                               AND json_type(payload_json) = 'object'
                               AND payload_json = '{}'),
        requested_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        requested_at         INTEGER NOT NULL,
        UNIQUE(requested_by_user_id, request_key)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_task_command_requests_target
        ON task_command_requests(executor_name, task_id, requested_at DESC)`,
      `CREATE TABLE IF NOT EXISTS task_command_events (
        id            TEXT PRIMARY KEY,
        command_id    TEXT NOT NULL
                      REFERENCES task_command_requests(id) ON DELETE RESTRICT,
        event_digest  TEXT NOT NULL
                      CHECK(length(event_digest) = 64
                        AND event_digest NOT GLOB '*[^0-9a-f]*'),
        event_type    TEXT NOT NULL
                      CHECK(event_type IN ('accepted','applied','rejected','cancelled')),
        payload_json  TEXT NOT NULL DEFAULT '{}'
                      CHECK(json_valid(payload_json)
                        AND json_type(payload_json) = 'object'),
        no_op         INTEGER CHECK(no_op IS NULL OR no_op IN (0,1)),
        rejection_reason TEXT CHECK(rejection_reason IS NULL OR rejection_reason IN (
                           'unknown_task','unsupported_verb','invalid_payload',
                           'stale_target','policy_refused','unknown'
                         )),
        actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        created_at    INTEGER NOT NULL,
        UNIQUE(command_id, event_digest),
        CHECK (
          (event_type IN ('accepted','cancelled')
            AND no_op IS NULL AND rejection_reason IS NULL)
          OR (event_type = 'applied' AND no_op IS NOT NULL AND rejection_reason IS NULL)
          OR (event_type = 'rejected' AND no_op IS NULL AND rejection_reason IS NOT NULL)
        )
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_task_command_events_accepted
        ON task_command_events(command_id) WHERE event_type = 'accepted'`,
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_task_command_events_terminal
        ON task_command_events(command_id)
        WHERE event_type IN ('applied','rejected','cancelled')`,
      `CREATE INDEX IF NOT EXISTS idx_task_command_events_command
        ON task_command_events(command_id, created_at, id)`,
    ],
  },
  {
    version: 129,
    name: "auth_request_merge_succeeded_facts",
    // Issue 3df7357 — one retained success fact per merge auth request. This is
    // deliberately separate from auth_request.completed ledger events: those
    // remain per linked issue, while this row survives auth-request deletion and
    // is the stable input for aggregate predicates such as recorded merge count.
    statements: [
      `CREATE TABLE IF NOT EXISTS auth_request_merge_succeeded_facts (
        auth_request_id   TEXT PRIMARY KEY,
        project_id        TEXT NOT NULL REFERENCES ledger_projects(id) ON DELETE RESTRICT,
        base_branch       TEXT NOT NULL,
        completed_at      INTEGER NOT NULL,
        canonical_message INTEGER NOT NULL CHECK(canonical_message IN (0,1)),
        recorded_at       INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_auth_merge_succeeded_project
        ON auth_request_merge_succeeded_facts(
          project_id, base_branch, canonical_message, completed_at, auth_request_id
      )`,
    ],
  },
  {
    version: 130,
    name: "managed_reminder_core",
    // Issue e257e5c — immutable one-shot reminder revisions, bounded inbox
    // occurrences, attributable idempotent creation, and append-only audit.
    statements: [
      `CREATE TABLE IF NOT EXISTS managed_tasks (
        id                 TEXT PRIMARY KEY,
        project_id         TEXT NOT NULL REFERENCES ledger_projects(id) ON DELETE RESTRICT,
        kind               TEXT NOT NULL CHECK(kind = 'mandible-reminder'),
        lifecycle          TEXT NOT NULL CHECK(lifecycle IN ('armed','completed','cancelled')),
        active_revision_id TEXT NOT NULL
                           REFERENCES managed_task_revisions(id) ON DELETE RESTRICT
                           DEFERRABLE INITIALLY DEFERRED,
        created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        created_at         INTEGER NOT NULL,
        updated_at         INTEGER NOT NULL,
        completed_at       INTEGER,
        cancelled_at       INTEGER,
        CHECK (
          (lifecycle = 'armed' AND completed_at IS NULL AND cancelled_at IS NULL) OR
          (lifecycle = 'completed' AND completed_at IS NOT NULL AND cancelled_at IS NULL) OR
          (lifecycle = 'cancelled' AND completed_at IS NULL AND cancelled_at IS NOT NULL)
        )
      )`,
      `CREATE INDEX IF NOT EXISTS idx_managed_tasks_reconcile
        ON managed_tasks(lifecycle, created_at, id)`,
      `CREATE INDEX IF NOT EXISTS idx_managed_tasks_project
        ON managed_tasks(project_id, created_at DESC, id DESC)`,
      `CREATE TABLE IF NOT EXISTS managed_task_revisions (
        id                 TEXT PRIMARY KEY,
        task_id            TEXT NOT NULL REFERENCES managed_tasks(id) ON DELETE RESTRICT,
        revision_no        INTEGER NOT NULL CHECK(revision_no = 1),
        schema_id          TEXT NOT NULL CHECK(schema_id = 'mandible-reminder@1'),
        payload_json       TEXT NOT NULL CHECK(
                             json_valid(payload_json)
                             AND json_type(payload_json) = 'object'
                             AND json_extract(payload_json, '$.schema') = 'mandible-reminder@1'
                             AND json_extract(payload_json, '$.effect.kind') = 'inbox_occurrence'
                           ),
        payload_digest     TEXT NOT NULL CHECK(
                             length(payload_digest) = 64
                             AND payload_digest NOT GLOB '*[^0-9a-f]*'
                           ),
        created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        created_at         INTEGER NOT NULL,
        UNIQUE(task_id),
        UNIQUE(task_id, id),
        UNIQUE(task_id, revision_no)
      )`,
      `CREATE TRIGGER IF NOT EXISTS trg_managed_task_revision_matches_task
        AFTER INSERT ON managed_task_revisions
        WHEN (SELECT active_revision_id FROM managed_tasks WHERE id = NEW.task_id) != NEW.id
        BEGIN SELECT RAISE(ABORT, 'managed task active revision mismatch'); END`,
      `CREATE TRIGGER IF NOT EXISTS trg_managed_task_active_revision_immutable
        BEFORE UPDATE OF active_revision_id ON managed_tasks
        BEGIN SELECT RAISE(ABORT, 'managed task active revision is immutable'); END`,
      `CREATE TRIGGER IF NOT EXISTS trg_managed_task_revisions_immutable_update
        BEFORE UPDATE ON managed_task_revisions
        BEGIN SELECT RAISE(ABORT, 'managed task revisions are immutable'); END`,
      `CREATE TRIGGER IF NOT EXISTS trg_managed_task_revisions_immutable_delete
        BEFORE DELETE ON managed_task_revisions
        BEGIN SELECT RAISE(ABORT, 'managed task revisions are immutable'); END`,
      `CREATE TABLE IF NOT EXISTS managed_task_create_requests (
        id                 TEXT PRIMARY KEY,
        created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        idempotency_key    TEXT NOT NULL CHECK(trim(idempotency_key) != ''),
        request_digest     TEXT NOT NULL CHECK(
                             length(request_digest) = 64
                             AND request_digest NOT GLOB '*[^0-9a-f]*'
                           ),
        task_id            TEXT NOT NULL REFERENCES managed_tasks(id) ON DELETE RESTRICT,
        result_json        TEXT NOT NULL CHECK(
                             json_valid(result_json) AND json_type(result_json) = 'object'
                           ),
        created_at         INTEGER NOT NULL,
        UNIQUE(created_by_user_id, idempotency_key),
        UNIQUE(task_id)
      )`,
      `CREATE TABLE IF NOT EXISTS managed_task_occurrences (
        id                        TEXT PRIMARY KEY,
        task_id                   TEXT NOT NULL REFERENCES managed_tasks(id) ON DELETE RESTRICT,
        revision_id               TEXT NOT NULL,
        occurrence_key            TEXT NOT NULL CHECK(trim(occurrence_key) != ''),
        kind                      TEXT NOT NULL CHECK(kind = 'inbox_occurrence'),
        payload_json              TEXT NOT NULL CHECK(
                                    json_valid(payload_json) AND json_type(payload_json) = 'object'
                                  ),
        triggering_evidence_json TEXT NOT NULL CHECK(
                                    json_valid(triggering_evidence_json)
                                    AND json_type(triggering_evidence_json) = 'object'
                                  ),
        created_by_user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        fired_by_user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        created_at                INTEGER NOT NULL,
        UNIQUE(task_id, revision_id, occurrence_key),
        FOREIGN KEY(task_id, revision_id)
          REFERENCES managed_task_revisions(task_id, id) ON DELETE RESTRICT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_managed_task_occurrences_created
        ON managed_task_occurrences(created_at DESC, id DESC)`,
      `CREATE TABLE IF NOT EXISTS managed_task_events (
        id              TEXT PRIMARY KEY,
        task_id         TEXT NOT NULL REFERENCES managed_tasks(id) ON DELETE RESTRICT,
        revision_id     TEXT NOT NULL,
        project_id      TEXT NOT NULL REFERENCES ledger_projects(id) ON DELETE RESTRICT,
        event_type      TEXT NOT NULL CHECK(event_type IN ('created','completed','cancelled')),
        actor_user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        evidence_method TEXT NOT NULL CHECK(evidence_method IN ('api_token','ephemeral','system_internal')),
        payload_json    TEXT NOT NULL DEFAULT '{}' CHECK(
                          json_valid(payload_json) AND json_type(payload_json) = 'object'
                        ),
        occurred_at     INTEGER NOT NULL,
        FOREIGN KEY(task_id, revision_id)
          REFERENCES managed_task_revisions(task_id, id) ON DELETE RESTRICT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_managed_task_events_task
        ON managed_task_events(task_id, occurred_at, id)`,
    ],
  },
  {
    version: 131,
    name: "managed_reminder_occurrence_acknowledgement",
    // Issue c94c6d0 — Inbox acknowledgement dismisses a projected occurrence
    // without deleting or rewriting the durable delivery record.
    statements: [
      `CREATE INDEX IF NOT EXISTS idx_managed_task_occurrences_inbox
        ON managed_task_occurrences(acknowledged_at, created_at DESC, id DESC)`,
    ],
  },
  {
    version: 132,
    name: "feedback_collection_expiry",
    // Issue 5d54f61 — recurring-feed expiry belongs to the collection row;
    // bounded-ask expiry remains owned by feedback_ask_sessions. The guarded
    // hook also makes ask expiry nullable so both kinds can be un-expired.
    statements: [],
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

function applySchemaMigrations(db: Db, migrations: readonly Migration[]): void {
  if (migrations.length === 0) return;
  db.transaction(() => {
    for (const migration of migrations) {
      if (migration.version === 71) {
        ensureIssueCoordinationColumns(db);
      }
      if (migration.version === 76) {
        ensureAuthRequestActionPrerequisites(db);
      }
      if (migration.version === 79) {
        ensureAuthRequestMergeFinalizerColumns(db);
      }
      if (migration.version === 132) {
        ensureFeedbackCollectionExpiryColumn(db);
      }
      if (migration.version === 87) {
        ensureLedgerProjectKeyColumn(db);
      }
      if (migration.version === 89) {
        ensureArtifactLinkSeriesColumns(db);
      }
      if (migration.version === 91) {
        ensureArtifactLinkTargetColumns(db);
      }
      if (migration.version === 92) {
        ensureAuthRequestPreflightReuseColumns(db);
      }
      if (migration.version === 93) {
        ensureConsoleTransportLaneColumn(db);
      }
      if (migration.version === 94) {
        ensureMessageParamsThinkingEffortColumn(db);
      }
      if (migration.version === 95) {
        ensureConversationSidechainColumns(db);
      }
      if (migration.version === 101) {
        ensureArtifactVersionParentColumn(db);
      }
      if (migration.version === 103) {
        ensureConversationEmptyIngestColumns(db);
      }
      if (migration.version === 106) {
        ensureBranchReapingKnowledgeColumns(db);
      }
      if (migration.version === 108) {
        ensureLedgerUserAttributionColumns(db);
      }
      if (migration.version === 109) {
        ensureAuthRequestUserAttributionColumns(db);
      }
      if (migration.version === 110) {
        ensureSessionOwnershipColumns(db);
      }
      if (migration.version === 111) {
        ensureProjectRestrictionColumn(db);
      }
      if (migration.version === 112) {
        ensureBranchUpstreamColumns(db);
      }
      if (migration.version === 113) {
        ensureWorkUnitMergeScanRetirementColumn(db);
      }
      if (migration.version === 114) {
        ensureAuthRequestMergeFinalizerStateColumn(db);
      }
      if (migration.version === 115) {
        clearLocalDefaultLedgerAttribution(db);
      }
      if (migration.version === 116) {
        ensureSessionIdentityMismatchColumns(db);
      }
      if (migration.version === 117) {
        clearResidualLocalDefaultLedgerAttribution(db);
      }
      if (migration.version === 118) {
        canonicalizeProjectRepoIds(db);
      }
      if (migration.version === 119) {
        ensureAuthRequestAtomicMergeColumns(db);
      }
      if (migration.version === 123) {
        ensureAuthRequestCanonicalChangeMessageColumn(db);
      }
      if (migration.version === 125) {
        ensureAskCreateGlobalCapability(db);
      }
      if (migration.version === 131) {
        ensureManagedReminderOccurrenceAcknowledgementColumns(db);
      }
      for (const statement of migration.statements) {
        db.exec(statement);
      }
      if (migration.version === 103) {
        verifyConversationEmptyIngestSchema(db);
      }
      if (migration.version === 127) {
        ensureBriefingIngestRequestColumn(db);
      }
      setMeta(db, SCHEMA_VERSION_KEY, String(migration.version));
    }
  })();
}

export function migrate(db: Db): void {
  assertMigrationSequence();
  if (isFreshDatabase(db)) {
    if (BASELINE_SCHEMA_VERSION !== CURRENT_SCHEMA_VERSION) {
      throw new Error(
        `Fresh schema baseline v${BASELINE_SCHEMA_VERSION} does not match migration head v${CURRENT_SCHEMA_VERSION}`,
      );
    }
    createFreshSchemaBaseline(db, CURRENT_SCHEMA_VERSION);
    return;
  }

  db.exec(
    `CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`
  );

  const currentVersion = getSchemaVersion(db);
  const pending = MIGRATIONS.filter((migration) => migration.version > currentVersion);
  // Migration 105 depends on Node post-migrations through v104. Apply only the
  // earlier SQL/hooks now; later migrations remain pending until v105 commits.
  const beforeV105 = pending.filter((migration) => migration.version < 105);
  const afterV105 = pending.filter((migration) => migration.version > 105 && migration.version < 126);
  const afterV126 = pending.filter((migration) => migration.version > 126);
  applySchemaMigrations(db, beforeV105);

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

  // Issue 2dc97b8 (migration 91): new artifact identity tables plus additive
  // artifact_links target columns are created with IF NOT EXISTS / guarded ALTER.
  // Verify the live contract so divergent pre-existing tables or same-named
  // indexes fail before any backfill writes.
  if (pending.some((migration) => migration.version === 91)) {
    verifyArtifactIdentitySchema(db);
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
  if (shouldRunPostMigration(db, "v95_backfill_conversation_sidechains", pending, 95, () =>
    needsConversationSidechainWork(db)
  )) {
    runPostMigration(db, "v95_backfill_conversation_sidechains", () => {
      ensureConversationSidechainColumns(db);
      backfillConversationSidechains(db);
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
  // Issue 2dc97b8 (migration 91): backfill the new artifact identity tables from
  // the legacy names, and repair artifact_links target columns where the legacy
  // link has an unambiguous series/version target. This does not infer project
  // associations from source repo identity, issue links, comments, bundles, or
  // Spaces; project_artifact_associations remains empty unless explicit legacy
  // association rows are added by a future migration.
  if (
    tableExists(db, "ledger_projects") &&
    shouldRunPostMigration(db, "v91_backfill_artifact_identity", pending, 91, () =>
      hasArtifactIdentityBackfillWork(db)
    )
  ) {
    runPostMigration(db, "v91_backfill_artifact_identity", () => {
      db.transaction(() => {
        backfillArtifactIdentityTables(db);
        backfillArtifactLinkTargets(db);
        verifyArtifactIdentityBackfill(db);
      }).immediate();
    });
  }
  if (shouldRunPostMigration(
    db,
    "v104_artifact_canonical_targets",
    pending,
    104,
    () => needsArtifactCanonicalTargetMigration(db),
  )) {
    runPostMigration(db, "v104_artifact_canonical_targets", () => {
      rebuildArtifactCanonicalTargets(db);
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
  // Issue 9ceb090 (migration 105): space_exports legacy artifact references
  // can only be mapped after all existing post-DDL work, including v91's
  // deterministic artifact_blob backfill and v104's canonical-target rebuild.
  // Add the columns, backfill and verify, and record both completion facts in
  // one transaction so a failure leaves schema version 104 and no partial v105
  // schema/data/marker behind.
  if (
    pending.some((migration) => migration.version === 105) ||
    getMeta(db, postMigrationKey("v105_space_export_canonical_artifacts")) !== "done"
  ) {
    db.transaction(() => {
      migrateSpaceExportCanonicalArtifacts(db);
      setMeta(db, postMigrationKey("v105_space_export_canonical_artifacts"), "done");
      setMeta(db, SCHEMA_VERSION_KEY, String(Math.max(getSchemaVersion(db), 105)));
    }).immediate();
  }
  // Preserve global ordering across the dependency boundary: no migration
  // newer than v105 may execute until every older post-DDL migration and v105
  // itself have completed successfully.
  applySchemaMigrations(db, afterV105);

  if (pending.some((migration) => migration.version === 126)) {
    migrateFeedbackRecurringCutover(db);
  }
  applySchemaMigrations(db, afterV126);

  // v132 was exercised by development daemons before release. Converge those
  // head-version databases too: remove any duplicated bounded-ask expiry and
  // restore nullable ask-session expiry without stacking a new migration.
  if (tableExists(db, "feedback_collections") && tableExists(db, "feedback_ask_sessions")) {
    ensureFeedbackCollectionExpiryColumn(db);
  }

  const v129AuthMergeSucceededPostMigration = "v129_backfill_auth_merge_succeeded_facts";
  if (
    tableExists(db, "ledger_projects") &&
    tableExists(db, "ledger_project_checkouts") &&
    shouldRunPostMigration(
      db,
      v129AuthMergeSucceededPostMigration,
      pending,
      129,
      () => hasAuthMergeSucceededFactBackfillWork(db),
    )
  ) {
    const deferredAuthRequestIds = backfillAuthMergeSucceededFacts(db);
    if (deferredAuthRequestIds.length === 0) {
      completeAuthMergeSucceededFactBackfill(db, v129AuthMergeSucceededPostMigration);
    }
  }
  // A running daemon can fill deferred facts through the auth finalizer sweep
  // after their projects are registered. On the next startup, the generic gate
  // then observes no incomplete work, writes the completion marker itself, and
  // returns false without entering the backfill's empty-deferred cleanup path.
  // Converge that production state, and any already-complete replay, here.
  cleanupCompletedAuthMergeSucceededFactBackfill(db, v129AuthMergeSucceededPostMigration);

  // Integration reconciliation (umbrella c16807e): the additive-column hooks for
  // v112 (branches.has_upstream/upstream), v113 (work_units.merge_scan_retired_at),
  // and v114 (auth_requests.merge_finalizer_state) were renumbered during
  // integration atop main's user-system migrations 107-111. A database that
  // previously ran an intermediate feature-branch daemon may already have
  // recorded v107-v109 under DIFFERENT meanings, so those
  // exact migrations are no longer in `pending` and their per-version hooks never
  // fire — leaving the renumbered columns permanently absent. All three hooks are
  // guarded and idempotent, so converge the full column set whenever a column is
  // actually missing.
  //
  // Failure-safe gating: keyed on LIVE schema inspection, NOT the recorded
  // version. applySchemaMigrations above already committed the head version, so a
  // version gate that missed here (e.g. a hook threw and its ALTER rolled back)
  // would never re-fire on a later open. The hooks run un-transacted so each
  // column that is successfully added persists independently; any hook that
  // throws leaves its column absent, and the next open re-detects it and retries.
  // This runs AFTER applySchemaMigrations(afterV105) so a normal low-version
  // replay (whose per-version hooks already added the columns in canonical order)
  // is a no-op here and only a DB actually missing the columns is repaired.
  if (needsRenumberedColumnConvergence(db)) {
    ensureBranchUpstreamColumns(db);
    ensureWorkUnitMergeScanRetirementColumn(db);
    ensureAuthRequestMergeFinalizerStateColumn(db);
  }

  // Issue ce22a3a / umbrella 99b74d6 (migration 121): admit finding refs in
  // space_items.ref_type. SQLite cannot alter a CHECK in place, so this follows
  // the v90 gated-rebuild pattern; it runs after applySchemaMigrations(afterV105)
  // so the v121 DDL version is already recorded, and it is a no-op once the live
  // CHECK lists 'finding'.
  if (shouldRunPostMigration(db, "v121_space_items_finding_refs", pending, 121, () =>
    needsSpaceItemsFindingRefType(db)
  )) {
    runPostMigration(db, "v121_space_items_finding_refs", () => {
      rebuildSpaceItemsWithFindingRefType(db);
    });
  }
}

function hasAuthMergeSucceededFactBackfillWork(db: Db): boolean {
  // Historical partial-schema fixtures can legitimately lack the ledger
  // substrate. A normal supported replay has ledger_projects before v129.
  if (
    !tableExists(db, "auth_request_merge_succeeded_facts") ||
    !tableExists(db, "ledger_projects") ||
    !tableExists(db, "ledger_project_checkouts")
  ) return false;
  return db.prepare(
    `SELECT 1
       FROM auth_requests a
      WHERE a.type = 'merge'
        AND a.status = 'completed'
        AND a.exit_code = 0
        AND NOT EXISTS (
          SELECT 1 FROM auth_request_merge_succeeded_facts f
           WHERE f.auth_request_id = a.id
        )
      LIMIT 1`,
  ).get() != null;
}

const V129_AUTH_MERGE_SUCCEEDED_DEFERRED_KEY =
  "post_migration.v129_backfill_auth_merge_succeeded_facts.deferred_auth_request_ids";

function completeAuthMergeSucceededFactBackfill(db: Db, name: string): void {
  db.transaction(() => {
    db.prepare("DELETE FROM meta WHERE key = ?").run(V129_AUTH_MERGE_SUCCEEDED_DEFERRED_KEY);
    setMeta(db, postMigrationKey(name), "done");
  }).immediate();
}

function cleanupCompletedAuthMergeSucceededFactBackfill(db: Db, name: string): void {
  if (getMeta(db, postMigrationKey(name)) !== "done") return;
  db.prepare("DELETE FROM meta WHERE key = ?").run(V129_AUTH_MERGE_SUCCEEDED_DEFERRED_KEY);
}

function backfillAuthMergeSucceededFacts(db: Db): string[] {
  const rows = db.prepare(
    `SELECT id, repo, cwd, target_repo_root, base_branch, resolved_at,
            updated_at, commit_message_digest
       FROM auth_requests
      WHERE type = 'merge' AND status = 'completed' AND exit_code = 0
      ORDER BY resolved_at, id`,
  ).all() as Array<{
    id: string;
    repo: string | null;
    cwd: string | null;
    target_repo_root: string | null;
    base_branch: string | null;
    resolved_at: number | null;
    updated_at: number;
    commit_message_digest: string | null;
  }>;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO auth_request_merge_succeeded_facts (
       auth_request_id, project_id, base_branch, completed_at,
       canonical_message, recorded_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const deferredAuthRequestIds: string[] = [];
  const run = db.transaction(() => {
    for (const row of rows) {
      const projectId = resolveAuthRequestProjectId(db, [
        row.target_repo_root,
        row.cwd,
        row.repo,
      ]);
      if (!projectId) {
        // Historical successful requests can belong to legitimate repositories
        // that were never registered as canonical projects. Preserve the
        // request, record the deferred fact explicitly, and retry on a later
        // startup instead of inventing project identity or bricking replay.
        deferredAuthRequestIds.push(row.id);
        continue;
      }
      const completedAt = row.resolved_at ?? row.updated_at;
      insert.run(
        row.id,
        projectId,
        row.base_branch ?? "",
        completedAt,
        row.commit_message_digest == null ? 0 : 1,
        completedAt,
      );
    }
    if (deferredAuthRequestIds.length > 0) {
      setMeta(db, V129_AUTH_MERGE_SUCCEEDED_DEFERRED_KEY, JSON.stringify(deferredAuthRequestIds));
    } else {
      db.prepare("DELETE FROM meta WHERE key = ?").run(V129_AUTH_MERGE_SUCCEEDED_DEFERRED_KEY);
    }
  });
  run.immediate();
  return deferredAuthRequestIds;
}

function resolveAuthRequestProjectId(db: Db, refs: Array<string | null>): string | null {
  for (const ref of refs) {
    const trimmed = ref?.trim();
    if (!trimmed) continue;
    const ids = new Set<string>();
    const checkoutRows = db.prepare(
      `SELECT project_id FROM ledger_project_checkouts
        WHERE root = ? OR work_repo_id = ? OR name = ? OR project_id = ?`,
    ).all(trimmed, trimmed, trimmed, trimmed) as Array<{ project_id: string }>;
    for (const row of checkoutRows) ids.add(row.project_id);
    const projectRows = db.prepare(
      `SELECT id FROM ledger_projects
        WHERE id = ? OR lower(project_key) = lower(?) OR display_name = ?
           OR remote_identity = ? OR upstream_identity = ?`,
    ).all(trimmed, trimmed, trimmed, trimmed, trimmed) as Array<{ id: string }>;
    for (const row of projectRows) ids.add(row.id);
    if (tableExists(db, "work_repos")) {
      const roots = db.prepare(
        `SELECT root FROM work_repos WHERE id = ? OR name = ? OR root = ?`,
      ).all(trimmed, trimmed, trimmed) as Array<{ root: string }>;
      for (const root of roots) {
        const mapped = db.prepare(
          `SELECT project_id FROM ledger_project_checkouts WHERE root = ?`,
        ).all(root.root) as Array<{ project_id: string }>;
        for (const row of mapped) ids.add(row.project_id);
      }
    }
    if (ids.size === 1) return [...ids][0]!;
    if (ids.size > 1) return null;
  }
  return null;
}

function ensureAskCreateGlobalCapability(db: Db): void {
  const definition = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'permission_grants'",
  ).get() as { sql: string | null } | undefined;
  if (!definition?.sql) {
    throw new Error("Migration v125 requires permission_grants to exist");
  }
  if (definition.sql.includes("'ask.create'")) return;
  // Partial legacy fixtures and interrupted historical databases can record a
  // post-v55 schema version while still lacking the ledger substrate. SQLite
  // cannot safely rebuild a table whose foreign key target is absent. A valid
  // pre-ledger upgrade applies v55 before reaching this hook; inconsistent
  // partial schemas retain their v111 grant table and indexes without crashing.
  if (!tableExists(db, "ledger_projects")) return;

  db.exec(`
    ALTER TABLE permission_grants RENAME TO permission_grants_v124;
    CREATE TABLE permission_grants (
      id            TEXT PRIMARY KEY,
      subject_type  TEXT NOT NULL CHECK(subject_type IN ('user','group')),
      subject_id    TEXT NOT NULL,
      resource_type TEXT NOT NULL CHECK(resource_type IN ('project','global')),
      resource_id   TEXT REFERENCES ledger_projects(id) ON DELETE CASCADE,
      permission    TEXT NOT NULL,
      created_at    INTEGER NOT NULL,
      CHECK (
        (resource_type = 'project' AND resource_id IS NOT NULL
          AND permission IN ('read','write','admin')) OR
        (resource_type = 'global' AND resource_id IS NULL
          AND permission IN (
            'approve_auth','spawn_console','change_settings','backup','open_path','ask.create'
          ))
      )
    );
    INSERT INTO permission_grants (
      id, subject_type, subject_id, resource_type, resource_id, permission, created_at
    )
    SELECT id, subject_type, subject_id, resource_type, resource_id, permission, created_at
      FROM permission_grants_v124;
    DROP TABLE permission_grants_v124;
    CREATE UNIQUE INDEX uq_permission_grants_project
      ON permission_grants(subject_type, subject_id, resource_id, permission)
      WHERE resource_type = 'project';
    CREATE UNIQUE INDEX uq_permission_grants_global
      ON permission_grants(subject_type, subject_id, permission)
      WHERE resource_type = 'global';
    CREATE INDEX idx_permission_grants_subject
      ON permission_grants(subject_type, subject_id);
    CREATE INDEX idx_permission_grants_resource
      ON permission_grants(resource_type, resource_id);
  `);
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
    dbLog("info", "db_conversation_blocks_compressed", {
      subsystem: "db",
      compressed_count: totalCompressed,
    });
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

function parseClaudeSubagentSourcePath(sourcePath: string | null): { parentSessionId: string; agentId: string } | null {
  if (!sourcePath) return null;
  const normalized = sourcePath.replace(/\\/g, "/");
  const match = normalized.match(/\/([^/]+)\/subagents\/agent-([^/]+)\.jsonl$/);
  if (!match) return null;
  return {
    parentSessionId: match[1],
    agentId: match[2],
  };
}

function ensureConversationSidechainColumns(db: Db): void {
  if (!tableExists(db, "conversations")) return;
  const names = tableColumnNames(db, "conversations");
  if (!names.has("is_sidechain")) {
    db.exec("ALTER TABLE conversations ADD COLUMN is_sidechain INTEGER NOT NULL DEFAULT 0");
  }
  if (!names.has("agent_id")) {
    db.exec("ALTER TABLE conversations ADD COLUMN agent_id TEXT");
  }
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_conv_sidechain_parent
      ON conversations(parent_conversation_id, is_sidechain)
      WHERE is_sidechain = 1`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_conv_agent
      ON conversations(agent_id)
      WHERE agent_id IS NOT NULL`
  );
}

function backfillConversationSidechains(db: Db): void {
  if (!tableExists(db, "conversations")) return;
  ensureConversationSidechainColumns(db);

  const rows = db.prepare(
    `SELECT id, source_path
     FROM conversations
     WHERE source = 'claude_code'
       AND LOWER(source_path) LIKE '%/subagents/agent-%.jsonl'`
  ).all() as Array<{ id: string; source_path: string }>;
  if (rows.length === 0) return;

  const findParent = db.prepare(
    `SELECT id
     FROM conversations
     WHERE session_id = ?
       AND id != ?
       AND LOWER(source_path) NOT LIKE '%/subagents/agent-%.jsonl'
     ORDER BY started_at ASC, created_at ASC
     LIMIT 1`
  );
  const update = db.prepare(
    `UPDATE conversations
     SET is_sidechain = 1,
         agent_id = COALESCE(NULLIF(agent_id, ''), ?),
         parent_conversation_id = COALESCE(parent_conversation_id, ?)
     WHERE id = ?`
  );

  const apply = db.transaction(() => {
    for (const row of rows) {
      const parsed = parseClaudeSubagentSourcePath(row.source_path);
      if (!parsed) continue;
      const parent = findParent.get(parsed.parentSessionId, row.id) as { id: string } | undefined;
      update.run(parsed.agentId, parent?.id ?? null, row.id);
    }
  });
  apply();
}

function needsConversationSidechainWork(db: Db): boolean {
  if (!tableExists(db, "conversations")) return false;
  const names = tableColumnNames(db, "conversations");
  if (
    !names.has("is_sidechain")
    || !names.has("agent_id")
    || !indexExists(db, "idx_conv_sidechain_parent")
    || !indexExists(db, "idx_conv_agent")
  ) {
    return true;
  }
  const row = db.prepare(
    `SELECT id, source_path, parent_conversation_id, is_sidechain, agent_id
     FROM conversations
     WHERE source = 'claude_code'
       AND LOWER(source_path) LIKE '%/subagents/agent-%.jsonl'
       AND (is_sidechain != 1 OR agent_id IS NULL OR agent_id = '' OR parent_conversation_id IS NULL)`
  ).all() as Array<{
    id: string;
    source_path: string;
    parent_conversation_id: string | null;
    is_sidechain: number;
    agent_id: string | null;
  }>;
  if (row.length === 0) return false;
  const parentExists = db.prepare(
    `SELECT 1
     FROM conversations
     WHERE session_id = ?
       AND id != ?
       AND LOWER(source_path) NOT LIKE '%/subagents/agent-%.jsonl'
     LIMIT 1`
  );
  return row.some((candidate) => {
    if (candidate.is_sidechain !== 1 || !candidate.agent_id) {
      return true;
    }
    if (!candidate.parent_conversation_id) {
      const parsed = parseClaudeSubagentSourcePath(candidate.source_path);
      return !parsed || Boolean(parentExists.get(parsed.parentSessionId, candidate.id));
    }
    return true;
  });
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

/**
 * Umbrella 99b74d6 — true when `space_items.ref_type` still excludes briefing
 * finding refs. Fresh databases built from the updated baseline DDL already
 * include 'finding', so this returns false for them and the v121 post-migration
 * records itself as complete without touching the table.
 */
function needsSpaceItemsFindingRefType(db: Db): boolean {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'space_items'")
    .get() as { sql: string } | undefined;
  if (!row) return false;
  return !row.sql.includes("'finding'");
}

/**
 * Umbrella 99b74d6 — rebuild `space_items` with `ref_type='finding'` accepted by
 * the inline CHECK. Every other invariant is preserved verbatim: the inline
 * UNIQUE constraints metadata backup/restore depends on, the non-empty ref_id
 * CHECK, and the external_ref ref_uri CHECK. Child tables reference
 * (space_id, id), so this uses the same FK-safe foreign_keys OFF +
 * foreign_key_check pattern as the v90 rebuild.
 */
function rebuildSpaceItemsWithFindingRefType(db: Db): void {
  if (!needsSpaceItemsFindingRefType(db)) return;

  const previousForeignKeys = db.pragma("foreign_keys", { simple: true }) as number;
  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      db.exec("DROP TABLE IF EXISTS space_items_v121");
      db.exec(
        `CREATE TABLE space_items_v121 (
          id            TEXT NOT NULL,
          space_id      TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
          ref_type      TEXT NOT NULL
                          CHECK(ref_type IN ('issue','comment','artifact','external_ref','space','finding')),
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
        `INSERT INTO space_items_v121 (
          id, space_id, ref_type, ref_id, ref_uri, title,
          metadata_json, created_at, updated_at
        )
        SELECT
          id, space_id, ref_type, ref_id, ref_uri, title,
          metadata_json, created_at, updated_at
        FROM space_items`,
      );
      db.exec("DROP TABLE space_items");
      db.exec("ALTER TABLE space_items_v121 RENAME TO space_items");
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
      `space_items finding-ref migration left ${violations.length} foreign key violations`,
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
  dbLog("info", "db_session_project_repo_names_backfilled", {
    subsystem: "db",
    row_count: rows.length,
  });
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
  dbLog("info", "db_session_project_repo_names_backfilled_v25", {
    subsystem: "db",
    row_count: rows.length,
  });
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
    dbLog("info", "db_auth_request_issue_ids_backfilled", {
      subsystem: "db",
      row_count: filled,
    });
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

function canonicalizeProjectRepoIds(db: Db): void {
  if (
    !tableExists(db, "ledger_projects") ||
    !tableExists(db, "ledger_project_checkouts")
  ) {
    return;
  }

  const rows = db.prepare(
    `SELECT c.root, c.work_repo_id, p.project_key
     FROM ledger_project_checkouts c
     JOIN ledger_projects p ON p.id = c.project_id
     WHERE c.work_repo_id IS NOT NULL
       AND c.work_repo_id != ''
       AND p.project_key IS NOT NULL
       AND p.project_key != ''
       AND p.project_key = 'feedbax'
       AND c.work_repo_id != p.project_key`,
  ).all() as Array<{
    root: string;
    work_repo_id: string;
    project_key: string;
  }>;

  const numbered = rows.filter((row) => /^\d+-/.test(row.work_repo_id));
  const canonicalByLegacy = new Map<string, string>();
  for (const row of numbered) {
    const existing = canonicalByLegacy.get(row.work_repo_id);
    if (existing && existing !== row.project_key) {
      throw new Error(
        `Cannot canonicalize ambiguous checkout repo id ${row.work_repo_id}: ` +
          `${existing} and ${row.project_key}`,
      );
    }
    canonicalByLegacy.set(row.work_repo_id, row.project_key);
  }

  const columnExists = (table: string, column: string): boolean => Boolean(
    db.prepare(
      "SELECT 1 FROM pragma_table_info(?) WHERE name = ? LIMIT 1",
    ).get(table, column),
  );
  const updateExactColumn = (table: string, column: string, legacy: string, canonical: string): void => {
    if (!tableExists(db, table) || !columnExists(table, column)) return;
    db.prepare(`UPDATE "${table}" SET "${column}" = ? WHERE "${column}" = ?`)
      .run(canonical, legacy);
  };

  const numberedRoots = new Set(numbered.map((row) => row.root));
  const canonicalTargets = new Set(canonicalByLegacy.values());
  for (const [legacy, canonical] of canonicalByLegacy) {
    // These columns carry current project/repository identity. Snapshot text,
    // issue bodies, event payloads, and logs are intentionally excluded.
    for (const [table, column] of [
      ["artifact", "source_repo_id"],
      ["artifact_links", "repo_id"],
      ["artifact_series", "repo_id"],
      ["artifact_version", "source_repo_id"],
      ["artifacts", "home_repo_id"],
      ["auth_requests", "repo"],
      ["graph_entities", "repo_id"],
      ["issue_resolutions", "repo_id"],
      ["push_history", "repo_id"],
      ["work_units", "repo_id"],
    ] as const) {
      updateExactColumn(table, column, legacy, canonical);
    }

    if (tableExists(db, "session_issues")) {
      db.prepare(
        `INSERT INTO session_issues (session_id, issue_id, repo_id, created_at)
         SELECT session_id, issue_id, ?, created_at
         FROM session_issues
         WHERE repo_id = ?
         ON CONFLICT(session_id, issue_id, repo_id) DO UPDATE SET
           created_at = MIN(session_issues.created_at, excluded.created_at)`,
      ).run(canonical, legacy);
      db.prepare("DELETE FROM session_issues WHERE repo_id = ?").run(legacy);
    }

    if (tableExists(db, "session_projects")) {
      db.prepare(
        `INSERT INTO session_projects (session_id, repo_id, repo_name, created_at)
         SELECT session_id, ?,
                CASE WHEN repo_name = ? THEN ? ELSE repo_name END,
                created_at
         FROM session_projects
         WHERE repo_id = ?
         ON CONFLICT(session_id, repo_id) DO UPDATE SET
           created_at = MIN(session_projects.created_at, excluded.created_at),
           repo_name = CASE
             WHEN session_projects.repo_name = '' OR session_projects.repo_name = ?
               THEN excluded.repo_name
             ELSE session_projects.repo_name
           END`,
      ).run(canonical, legacy, canonical, legacy, legacy);
      db.prepare("DELETE FROM session_projects WHERE repo_id = ?").run(legacy);
    }

    db.prepare(
      `UPDATE ledger_project_checkouts
       SET work_repo_id = ?, updated_at = MAX(updated_at, ?)
       WHERE work_repo_id = ?`,
    ).run(canonical, Date.now(), legacy);
  }

  // WorkScanner identity is rooted in work_repos, while the registry is rooted
  // in ledger_project_checkouts. Align only the numbered checkout roots and any
  // exact-root row currently holding one of their canonical target ids. The
  // latter relocates a collision holder (for example a development checkout)
  // to its own registered checkout id before the canonical id is assigned.
  if (tableExists(db, "work_repos")) {
    const scannerRows = db.prepare(
      `SELECT wr.root, wr.id,
              COALESCE(NULLIF(c.work_repo_id, ''), NULLIF(p.project_key, ''), wr.id) AS target_id
       FROM work_repos wr
       LEFT JOIN ledger_project_checkouts c ON c.root = wr.root
       LEFT JOIN ledger_projects p ON p.id = c.project_id`,
    ).all() as Array<{ root: string; id: string; target_id: string }>;
    const plans = scannerRows.filter((row) =>
      row.id !== row.target_id &&
      (numberedRoots.has(row.root) || canonicalTargets.has(row.id))
    );
    const planByRoot = new Map(plans.map((plan) => [plan.root, plan.target_id]));
    const plannedTargetOwner = new Map<string, string>();
    for (const plan of plans) {
      const owner = plannedTargetOwner.get(plan.target_id);
      if (owner && owner !== plan.root) {
        throw new Error(
          `Cannot canonicalize checkout repo ids: ${owner} and ${plan.root} ` +
            `would both use ${plan.target_id}`,
        );
      }
      plannedTargetOwner.set(plan.target_id, plan.root);
    }
    for (const row of scannerRows) {
      if (planByRoot.has(row.root)) continue;
      const plannedOwner = plannedTargetOwner.get(row.id);
      if (plannedOwner) {
        throw new Error(
          `Cannot canonicalize checkout repo id ${row.id}: ` +
            `${row.root} already owns the target needed by ${plannedOwner}`,
        );
      }
    }

    const occupiedIds = new Set(scannerRows.map((row) => row.id));
    const temporaryIds = new Map<string, string>();
    for (const [index, plan] of plans.entries()) {
      let temporary = `__mandible_v118_${index}__`;
      while (occupiedIds.has(temporary)) temporary += "_";
      occupiedIds.add(temporary);
      temporaryIds.set(plan.root, temporary);
      db.prepare(
        "UPDATE work_repos SET id = ?, updated_at = datetime('now') WHERE root = ?",
      ).run(temporary, plan.root);
    }
    for (const plan of plans) {
      db.prepare(
        "UPDATE work_repos SET id = ?, updated_at = datetime('now') WHERE root = ? AND id = ?",
      ).run(plan.target_id, plan.root, temporaryIds.get(plan.root));
    }
  }
}

const V126_LEGACY_TABLES = [
  "review_candidates",
  "candidate_revisions",
  "candidate_occurrences",
  "decision_events",
  "candidate_comments",
  "briefing_batches",
] as const;

const V126_FEEDBACK_TABLES = [
  "feedback_collections",
  "feedback_recurring_profiles",
  "feedback_ask_sessions",
  "feedback_publications",
  "feedback_items",
  "feedback_item_revisions",
  "feedback_item_options",
  "feedback_publication_items",
  "feedback_collection_events",
  "feedback_item_events",
  "feedback_response_events",
  "feedback_submissions",
  "feedback_submission_answers",
  "feedback_comments",
] as const;

const V126_FK_CHECK_TABLES = [
  ...V126_LEGACY_TABLES,
  "agent_dispatch_events",
  ...V126_FEEDBACK_TABLES,
] as const;

function v126StableId(kind: string, ...parts: string[]): string {
  const digest = createHash("sha256")
    .update(["mandible.feedback.v126", kind, ...parts].join("\u0000"))
    .digest("hex");
  return `feedback-${kind}-${digest}`;
}

function assertV126Checks(db: Db, phase: string): void {
  const violations: Array<{ table: (typeof V126_FK_CHECK_TABLES)[number] }> = [];
  for (const table of V126_FK_CHECK_TABLES) {
    if (!tableExists(db, table)) continue;
    const tableViolations = db.prepare(`PRAGMA foreign_key_check("${table}")`).all();
    for (const _violation of tableViolations) violations.push({ table });
  }
  if (violations.length > 0) {
    const tables = [...new Set(violations.map((violation) => violation.table))];
    throw new Error(
      `migration 126 ${phase}: ${violations.length} cutover-scoped foreign key ` +
      `violation(s) in ${tables.join(", ")}`,
    );
  }
  const integrity = db.pragma("integrity_check") as Array<{ integrity_check: string }>;
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
    throw new Error(`migration 126 ${phase}: integrity_check failed`);
  }
}

function assertV126AgentDispatchSchema(db: Db): void {
  if (!tableExists(db, "agent_dispatch_events")) {
    throw new Error("migration 126 precondition: agent_dispatch_events is missing");
  }
  const fks = db.pragma("foreign_key_list(agent_dispatch_events)") as Array<{
    from: string;
    table: string;
    on_delete: string;
  }>;
  const expected = new Map([
    ["candidate_id", "feedback_items"],
    ["revision_id", "feedback_item_revisions"],
    ["comment_id", "feedback_comments"],
  ]);
  for (const [column, parent] of expected) {
    const fk = fks.find((entry) => entry.from === column);
    if (!fk || fk.table !== parent || fk.on_delete.toUpperCase() !== "RESTRICT") {
      throw new Error(
        `migration 126 verification: agent_dispatch_events.${column} does not ` +
        `reference ${parent}(id) ON DELETE RESTRICT`,
      );
    }
  }
}

function migrateFeedbackRecurringCutover(db: Db): void {
  if (db.inTransaction) {
    throw new Error("migration 126 precondition: cutover cannot start inside a transaction");
  }
  const legacyPresence = V126_LEGACY_TABLES.map((name) => tableExists(db, name));
  const legacyCount = legacyPresence.filter(Boolean).length;
  if (legacyCount !== 0 && legacyCount !== V126_LEGACY_TABLES.length) {
    const present = V126_LEGACY_TABLES.filter((_, index) => legacyPresence[index]);
    throw new Error(
      `migration 126 precondition: partial legacy Briefing schema (${present.join(", ")})`,
    );
  }
  for (const table of V126_FEEDBACK_TABLES) {
    if (!tableExists(db, table)) {
      throw new Error(`migration 126 precondition: ${table} is missing`);
    }
  }

  // Replay after only the marker was rewound: verify the already-cut-over live
  // schema and restore the marker without recreating or rewriting anything.
  if (legacyCount === 0) {
    assertV126AgentDispatchSchema(db);
    assertV126Checks(db, "replay verification");
    db.transaction(() => setMeta(db, SCHEMA_VERSION_KEY, "126")).immediate();
    return;
  }

  const previousForeignKeys = db.pragma("foreign_keys", { simple: true }) as number;
  try {
    if (!previousForeignKeys) db.pragma("foreign_keys = ON");
    assertV126Checks(db, "preflight");

    // C1a did not write feedback rows. Refuse to merge two independent stores:
    // doing so could collide identities or silently duplicate human judgments.
    for (const table of V126_FEEDBACK_TABLES) {
      const count = (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      if (count !== 0) {
        throw new Error(`migration 126 precondition: ${table} is not empty`);
      }
    }

    const invalid = (sql: string): number =>
      (db.prepare(sql).get() as { n: number }).n;
    const validations: Array<[string, string]> = [
      ["candidate source/key is blank", `SELECT COUNT(*) AS n FROM review_candidates
        WHERE trim(source) = '' OR trim(candidate_key) = ''`],
      ["candidate current revision is missing or belongs to another candidate", `
        SELECT COUNT(*) AS n FROM review_candidates c
         WHERE c.current_revision_id IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM candidate_revisions r
            WHERE r.id = c.current_revision_id AND r.candidate_id = c.id)`],
      ["revision JSON/evidence fields are invalid", `SELECT COUNT(*) AS n FROM candidate_revisions
        WHERE trim(evidence_hash) = '' OR trim(title) = ''
           OR NOT json_valid(refs_json) OR json_type(refs_json) != 'array'`],
      ["revision batch is missing", `SELECT COUNT(*) AS n FROM candidate_revisions r
        WHERE NOT EXISTS (SELECT 1 FROM briefing_batches b WHERE b.batch_key = r.batch_key)`],
      ["revision has no occurrence in its originating batch", `SELECT COUNT(*) AS n
        FROM candidate_revisions r WHERE NOT EXISTS (
          SELECT 1 FROM candidate_occurrences o
           WHERE o.revision_id = r.id AND o.batch_key = r.batch_key)`],
      ["occurrence batch is missing", `SELECT COUNT(*) AS n FROM candidate_occurrences o
        WHERE NOT EXISTS (SELECT 1 FROM briefing_batches b WHERE b.batch_key = o.batch_key)`],
      ["empty legacy batch cannot be source-scoped", `SELECT COUNT(*) AS n FROM briefing_batches b
        WHERE NOT EXISTS (SELECT 1 FROM candidate_occurrences o WHERE o.batch_key = b.batch_key)`],
      ["decision candidate/revision relationship is invalid", `SELECT COUNT(*) AS n
        FROM decision_events d WHERE NOT EXISTS (
          SELECT 1 FROM candidate_revisions r
           WHERE r.id = d.revision_id AND r.candidate_id = d.candidate_id)`],
      ["human decision actor is missing", `SELECT COUNT(*) AS n FROM decision_events
        WHERE action IN ('keep','dismiss','undo') AND actor_user_id IS NULL`],
      ["comment cannot satisfy strict feedback constraints", `SELECT COUNT(*) AS n
        FROM candidate_comments c WHERE actor_user_id IS NULL OR trim(body) = '' OR NOT EXISTS (
          SELECT 1 FROM candidate_revisions r
           WHERE r.id = c.revision_id AND r.candidate_id = c.candidate_id)`],
      ["decision comment_id cannot be represented", `SELECT COUNT(*) AS n FROM decision_events
        WHERE comment_id IS NOT NULL`],
      ["finding dispatch link is incomplete", `SELECT COUNT(*) AS n FROM agent_dispatch_events e
        WHERE e.subject_kind = 'finding' AND (
          e.candidate_id IS NULL OR e.revision_id IS NULL OR e.comment_id IS NULL
          OR NOT EXISTS (SELECT 1 FROM review_candidates c WHERE c.id = e.candidate_id)
          OR NOT EXISTS (SELECT 1 FROM candidate_revisions r
               WHERE r.id = e.revision_id AND r.candidate_id = e.candidate_id)
          OR NOT EXISTS (SELECT 1 FROM candidate_comments c
               WHERE c.id = e.comment_id AND c.candidate_id = e.candidate_id
                 AND c.revision_id = e.revision_id))`],
    ];
    for (const [description, sql] of validations) {
      const count = invalid(sql);
      if (count > 0) {
        throw new Error(`migration 126 precondition: ${count} row(s): ${description}`);
      }
    }

    const legacyCounts = Object.fromEntries(
      V126_LEGACY_TABLES.map((table) => [
        table,
        (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
      ]),
    ) as Record<(typeof V126_LEGACY_TABLES)[number], number>;
    const dispatchCount = (db.prepare(
      "SELECT COUNT(*) AS n FROM agent_dispatch_events",
    ).get() as { n: number }).n;

    db.pragma("foreign_keys = OFF");
    db.transaction(() => {
      const expiryRaw = (db.prepare(
        "SELECT value FROM settings WHERE key = 'briefing.expiry_ms'",
      ).get() as { value: string } | undefined)?.value;
      const parsedExpiry = expiryRaw === undefined ? Number.NaN : Number(expiryRaw);
      const expiryMs = Number.isFinite(parsedExpiry) && parsedExpiry > 0
        ? parsedExpiry
        : 14 * 24 * 60 * 60 * 1_000;

      const sourceRows = db.prepare(
        `SELECT source, MIN(created_at) AS created_at
           FROM review_candidates GROUP BY source ORDER BY source`,
      ).all() as Array<{ source: string; created_at: number }>;
      const collectionIds = new Map<string, string>();
      for (const source of sourceRows) {
        const collectionId = v126StableId("collection", source.source);
        collectionIds.set(source.source, collectionId);
        db.prepare(
          `INSERT INTO feedback_collections
             (id, kind, interaction_mode, source, created_at, tombstoned_at)
           VALUES (?, 'recurring_feed', 'immediate_per_item', ?, ?, NULL)`,
        ).run(collectionId, source.source, source.created_at);
        db.prepare(
          `INSERT INTO feedback_recurring_profiles
             (collection_id, source_namespace, item_expiry_ms, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(collectionId, source.source, expiryMs, source.created_at, source.created_at);
        db.prepare(
          `INSERT INTO feedback_collection_events
             (id, collection_id, operation, previous_event_id, actor_user_id,
              metadata_json, created_at)
           VALUES (?, ?, 'opened', NULL, NULL, '{}', ?)`,
        ).run(v126StableId("opened", source.source), collectionId, source.created_at);
      }

      const publicationRows = db.prepare(
        `SELECT DISTINCT b.batch_key, b.task_identity, b.run_id, b.digest_series_ref,
                b.digest_version, b.item_count, b.received_at, c.source
           FROM briefing_batches b
           JOIN candidate_occurrences o ON o.batch_key = b.batch_key
           JOIN candidate_revisions r ON r.id = o.revision_id
           JOIN review_candidates c ON c.id = r.candidate_id
          ORDER BY b.received_at, b.rowid, c.source`,
      ).all() as Array<{
        batch_key: string;
        task_identity: string;
        run_id: string | null;
        digest_series_ref: string | null;
        digest_version: number | null;
        item_count: number;
        received_at: number;
        source: string;
      }>;
      const publicationIds = new Map<string, string>();
      for (const publication of publicationRows) {
        const collectionId = collectionIds.get(publication.source);
        if (!collectionId) throw new Error("migration 126 copy: missing collection");
        const mapKey = `${publication.batch_key}\u0000${publication.source}`;
        const publicationId = v126StableId(
          "publication", publication.batch_key, publication.source,
        );
        publicationIds.set(mapKey, publicationId);
        db.prepare(
          `INSERT INTO feedback_publications (
             id, collection_id, publication_key, publisher_user_id, task_identity,
             run_id, digest_series_ref, digest_version, item_count, received_at
           ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
        ).run(
          publicationId,
          collectionId,
          publication.batch_key,
          publication.task_identity,
          publication.run_id,
          publication.digest_series_ref,
          publication.digest_version,
          publication.item_count,
          publication.received_at,
        );
      }

      const candidates = db.prepare(
        "SELECT * FROM review_candidates ORDER BY created_at, rowid",
      ).all() as Array<{
        id: string;
        source: string;
        candidate_key: string;
        current_revision_id: string | null;
        created_at: number;
      }>;
      for (const candidate of candidates) {
        const collectionId = collectionIds.get(candidate.source);
        if (!collectionId) throw new Error("migration 126 copy: missing candidate collection");
        db.prepare(
          `INSERT INTO feedback_items (
             id, collection_id, parent_item_id, item_kind, identity_mode, external_key,
             client_item_key, current_revision_id, created_at, tombstoned_at
           ) VALUES (?, ?, NULL, 'item', 'publisher_dedup', ?, NULL, NULL, ?, NULL)`,
        ).run(candidate.id, collectionId, candidate.candidate_key, candidate.created_at);
      }

      const revisions = db.prepare(
        `SELECT r.*, c.source
           FROM candidate_revisions r JOIN review_candidates c ON c.id = r.candidate_id
          ORDER BY r.candidate_id, r.ingested_at, r.rowid`,
      ).all() as Array<{
        id: string;
        candidate_id: string;
        title: string;
        why_notable: string | null;
        refs_json: string;
        source_ref: string | null;
        evidence_hash: string;
        evidence_kind: "snapshot-item" | "finding-only";
        captured_at: string | null;
        rank: number | null;
        batch_key: string;
        ingested_at: number;
        source: string;
      }>;
      const ordinals = new Map<string, number>();
      for (const revision of revisions) {
        const ordinal = (ordinals.get(revision.candidate_id) ?? 0) + 1;
        ordinals.set(revision.candidate_id, ordinal);
        const publicationId = publicationIds.get(`${revision.batch_key}\u0000${revision.source}`);
        if (!publicationId) throw new Error("migration 126 copy: missing revision publication");
        db.prepare(
          `INSERT INTO feedback_item_revisions (
             id, item_id, ordinal, title, prompt, description, response_type, required,
             content_json, evidence_digest, publication_id, position, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'verdict', 0, ?, ?, ?, ?, ?)`,
        ).run(
          revision.id,
          revision.candidate_id,
          ordinal,
          revision.title,
          revision.title,
          revision.why_notable,
          encodeRecurringRevisionContent({
            why_notable: revision.why_notable,
            refs: JSON.parse(revision.refs_json) as string[],
            source_ref: revision.source_ref,
            evidence_kind: revision.evidence_kind,
            captured_at: revision.captured_at,
            rank: revision.rank,
          }),
          revision.evidence_hash,
          publicationId,
          Math.max(0, revision.rank ?? 0),
          revision.ingested_at,
        );
      }
      for (const candidate of candidates) {
        if (candidate.current_revision_id) {
          db.prepare("UPDATE feedback_items SET current_revision_id = ? WHERE id = ?")
            .run(candidate.current_revision_id, candidate.id);
        }
      }

      const occurrences = db.prepare(
        `SELECT o.*, c.source, r.rank
           FROM candidate_occurrences o
           JOIN candidate_revisions r ON r.id = o.revision_id
           JOIN review_candidates c ON c.id = r.candidate_id
          ORDER BY o.seen_at, o.rowid`,
      ).all() as Array<{
        id: string;
        revision_id: string;
        batch_key: string;
        seen_at: number;
        source: string;
        rank: number | null;
      }>;
      for (const occurrence of occurrences) {
        const publicationId = publicationIds.get(`${occurrence.batch_key}\u0000${occurrence.source}`);
        if (!publicationId) throw new Error("migration 126 copy: missing occurrence publication");
        db.prepare(
          `INSERT INTO feedback_publication_items
             (id, publication_id, item_revision_id, position, seen_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(
          occurrence.id,
          publicationId,
          occurrence.revision_id,
          occurrence.rank !== null && occurrence.rank >= 0 ? occurrence.rank : null,
          occurrence.seen_at,
        );
      }

      const decisions = db.prepare(
        `SELECT d.*, i.collection_id
           FROM decision_events d JOIN feedback_items i ON i.id = d.candidate_id
          ORDER BY d.created_at, d.rowid`,
      ).all() as Array<{
        id: string;
        candidate_id: string;
        revision_id: string;
        action: "keep" | "dismiss" | "undo" | "expire";
        actor_user_id: string | null;
        created_at: number;
        collection_id: string;
      }>;
      const effective = new Map<string, { id: string; action: string; response: boolean }>();
      for (const decision of decisions) {
        if (decision.action === "expire") {
          db.prepare(
            `INSERT INTO feedback_item_events
               (id, item_id, item_revision_id, operation, actor_user_id, created_at)
             VALUES (?, ?, ?, 'expired', ?, ?)`,
          ).run(
            decision.id, decision.candidate_id, decision.revision_id,
            decision.actor_user_id, decision.created_at,
          );
          effective.set(decision.revision_id, {
            id: decision.id, action: "expire", response: false,
          });
          continue;
        }
        if (decision.action === "undo") {
          const target = effective.get(decision.revision_id);
          if (!target?.response || target.action === "undo") {
            throw new Error(
              `migration 126 precondition: undo ${decision.id} has no effective response target`,
            );
          }
          db.prepare(
            `INSERT INTO feedback_response_events (
               id, collection_id, item_id, item_revision_id, operation, value_json,
               retracts_event_id, actor_user_id, created_at
             ) VALUES (?, ?, ?, ?, 'retract', NULL, ?, ?, ?)`,
          ).run(
            decision.id, decision.collection_id, decision.candidate_id,
            decision.revision_id, target.id, decision.actor_user_id, decision.created_at,
          );
          effective.set(decision.revision_id, {
            id: decision.id, action: "undo", response: true,
          });
          continue;
        }
        db.prepare(
          `INSERT INTO feedback_response_events (
             id, collection_id, item_id, item_revision_id, operation, value_json,
             retracts_event_id, actor_user_id, created_at
           ) VALUES (?, ?, ?, ?, 'set', ?, NULL, ?, ?)`,
        ).run(
          decision.id,
          decision.collection_id,
          decision.candidate_id,
          decision.revision_id,
          JSON.stringify({ verdict: decision.action }),
          decision.actor_user_id,
          decision.created_at,
        );
        effective.set(decision.revision_id, {
          id: decision.id, action: decision.action, response: true,
        });
      }

      db.exec(
        `INSERT INTO feedback_comments (
           id, collection_id, item_id, item_revision_id, body, actor_user_id, created_at
         )
         SELECT c.id, i.collection_id, c.candidate_id, c.revision_id,
                c.body, c.actor_user_id, c.created_at
           FROM candidate_comments c JOIN feedback_items i ON i.id = c.candidate_id`,
      );

      db.exec(`
        CREATE TABLE agent_dispatch_events_v126 (
          id             TEXT PRIMARY KEY,
          subject_kind   TEXT NOT NULL CHECK(subject_kind IN ('finding','issue')),
          candidate_id   TEXT REFERENCES feedback_items(id) ON DELETE RESTRICT,
          revision_id    TEXT REFERENCES feedback_item_revisions(id) ON DELETE RESTRICT,
          comment_id     TEXT REFERENCES feedback_comments(id) ON DELETE RESTRICT,
          issue_id       TEXT,
          actor_user_id  TEXT REFERENCES users(id) ON DELETE RESTRICT,
          provider       TEXT NOT NULL DEFAULT 'claude',
          instruction    TEXT NOT NULL,
          cwd            TEXT NOT NULL,
          prompt_path    TEXT,
          prompt_sha256  TEXT,
          status         TEXT NOT NULL CHECK(status IN ('dispatching','dispatched','failed')),
          session_handle TEXT,
          session_id     TEXT,
          attach_command TEXT,
          error          TEXT,
          created_at     INTEGER NOT NULL,
          settled_at     INTEGER
        );
        INSERT INTO agent_dispatch_events_v126 SELECT * FROM agent_dispatch_events;
        DROP TABLE agent_dispatch_events;
        ALTER TABLE agent_dispatch_events_v126 RENAME TO agent_dispatch_events;
        CREATE INDEX idx_agent_dispatch_events_candidate
          ON agent_dispatch_events(candidate_id, created_at DESC);
        CREATE INDEX idx_agent_dispatch_events_issue
          ON agent_dispatch_events(issue_id, created_at DESC);
        CREATE INDEX idx_agent_dispatch_events_comment
          ON agent_dispatch_events(comment_id);
      `);

      db.exec(`
        DROP TABLE decision_events;
        DROP TABLE candidate_comments;
        DROP TABLE candidate_occurrences;
        DROP TABLE candidate_revisions;
        DROP TABLE review_candidates;
        DROP TABLE briefing_batches;
      `);

      const expectedCounts: Array<[string, number]> = [
        ["feedback_items", legacyCounts.review_candidates],
        ["feedback_item_revisions", legacyCounts.candidate_revisions],
        ["feedback_publication_items", legacyCounts.candidate_occurrences],
        ["feedback_comments", legacyCounts.candidate_comments],
        ["agent_dispatch_events", dispatchCount],
      ];
      for (const [table, expected] of expectedCounts) {
        const actual = (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
        if (actual !== expected) {
          throw new Error(
            `migration 126 verification: ${table} expected ${expected} rows, found ${actual}`,
          );
        }
      }
      const eventCount = (db.prepare(
        `SELECT (SELECT COUNT(*) FROM feedback_response_events)
              + (SELECT COUNT(*) FROM feedback_item_events) AS n`,
      ).get() as { n: number }).n;
      if (eventCount !== legacyCounts.decision_events) {
        throw new Error(
          `migration 126 verification: expected ${legacyCounts.decision_events} decision rows, ` +
          `found ${eventCount} feedback events`,
        );
      }
      const brokenDispatches = invalid(`SELECT COUNT(*) AS n FROM agent_dispatch_events e
        WHERE e.subject_kind = 'finding' AND (
          NOT EXISTS (SELECT 1 FROM feedback_items i WHERE i.id = e.candidate_id)
          OR NOT EXISTS (SELECT 1 FROM feedback_item_revisions r WHERE r.id = e.revision_id)
          OR NOT EXISTS (SELECT 1 FROM feedback_comments c WHERE c.id = e.comment_id))`);
      if (brokenDispatches > 0) {
        throw new Error(
          `migration 126 verification: ${brokenDispatches} finding dispatch link(s) are unresolved`,
        );
      }
      assertV126AgentDispatchSchema(db);
      assertV126Checks(db, "transaction verification");
      setMeta(db, SCHEMA_VERSION_KEY, "126");
    }).immediate();
  } finally {
    db.pragma(`foreign_keys = ${previousForeignKeys ? "ON" : "OFF"}`);
  }

  assertV126AgentDispatchSchema(db);
  assertV126Checks(db, "post-restore verification");
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

function ensureArtifactVersionParentColumn(db: Db): void {
  if (!tableExists(db, "artifact_versions")) return;
  const columns = tableColumnNames(db, "artifact_versions");
  if (!columns.has("parent_version_id")) {
    db.exec("ALTER TABLE artifact_versions ADD COLUMN parent_version_id TEXT");
  }
}

function ensureConversationEmptyIngestColumns(db: Db): void {
  if (!tableExists(db, "conversation_ingest_state")) {
    throw new Error(
      "migration 103 precondition: table conversation_ingest_state is missing",
    );
  }
  const columns = tableColumnNames(db, "conversation_ingest_state");
  const hasMtime = columns.has("empty_source_mtime");
  const hasSize = columns.has("empty_source_size");
  if (hasMtime !== hasSize) {
    throw new Error(
      "migration 103 precondition: conversation_ingest_state must have either both empty-source columns or neither",
    );
  }
  if (hasMtime) {
    return;
  }
  db.exec("ALTER TABLE conversation_ingest_state ADD COLUMN empty_source_mtime REAL");
  db.exec("ALTER TABLE conversation_ingest_state ADD COLUMN empty_source_size INTEGER");
}

function verifyConversationEmptyIngestSchema(db: Db): void {
  if (!tableExists(db, "conversation_ingest_state")) {
    throw new Error(
      "migration 103 verification: table conversation_ingest_state is missing",
    );
  }
  const columns = db.prepare("PRAGMA table_info(conversation_ingest_state)").all() as Array<{
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
  }>;
  const expected = new Map([
    ["empty_source_mtime", "REAL"],
    ["empty_source_size", "INTEGER"],
  ]);
  for (const [name, type] of expected) {
    const column = columns.find((candidate) => candidate.name === name);
    if (!column) {
      throw new Error(
        `migration 103 verification: conversation_ingest_state is missing expected column '${name}'`,
      );
    }
    if (column.type.toUpperCase() !== type || column.notnull !== 0 || column.dflt_value !== null) {
      throw new Error(
        `migration 103 verification: conversation_ingest_state.${name} must be nullable ${type} with no default`,
      );
    }
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

function ensureArtifactLinkTargetColumns(db: Db): void {
  if (!tableExists(db, "artifact_links")) return;
  const names = tableColumnNames(db, "artifact_links");
  if (!names.has("target_type")) {
    db.exec(
      `ALTER TABLE artifact_links ADD COLUMN target_type TEXT
        CHECK(target_type IS NULL OR target_type IN ('artifact','artifact_version'))`,
    );
  }
  if (!names.has("target_id")) {
    db.exec("ALTER TABLE artifact_links ADD COLUMN target_id TEXT");
  }
  if (!names.has("fallback_version_id")) {
    db.exec("ALTER TABLE artifact_links ADD COLUMN fallback_version_id TEXT");
  }
  if (!names.has("legacy_blob_id")) {
    db.exec("ALTER TABLE artifact_links ADD COLUMN legacy_blob_id TEXT");
  }
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_artifact_links_target
      ON artifact_links(target_type, target_id)
      WHERE target_type IS NOT NULL AND target_id IS NOT NULL`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_artifact_links_fallback_version
      ON artifact_links(fallback_version_id)
      WHERE fallback_version_id IS NOT NULL`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_artifact_links_legacy_blob
      ON artifact_links(legacy_blob_id)
      WHERE legacy_blob_id IS NOT NULL`,
  );
}

function canonicalBlobIdForCompatibilityRef(id: string): string {
  const trimmed = id.trim();
  const shaNamespaced = /^artifact:sha256:(.+)$/i.exec(trimmed);
  if (shaNamespaced) return `artifact-blob:${shaNamespaced[1]}`;
  const shaBare = /^sha256:(.+)$/i.exec(trimmed);
  if (shaBare) return `artifact-blob:${shaBare[1]}`;
  const artifactHash = /^artifact:([a-f0-9]{64})$/i.exec(trimmed);
  if (artifactHash) return `artifact-blob:${artifactHash[1]}`;
  if (/^artifact-blob:/i.test(trimmed)) return trimmed;
  return `artifact-blob:${trimmed}`;
}

function canonicalArtifactIdForCompatibilitySeries(id: string): string {
  const trimmed = id.trim();
  const series = /^artifact-series:(.+)$/i.exec(trimmed);
  if (series) return `artifact:${series[1]}`;
  if (/^artifact:/i.test(trimmed)) return trimmed;
  return `artifact:${trimmed}`;
}

function canonicalVersionIdForCompatibilityVersion(id: string): string {
  const trimmed = id.trim();
  if (/^artifact-version:/i.test(trimmed)) return trimmed;
  return `artifact-version:${trimmed}`;
}

function normalizeArtifactSourceKind(value: unknown): string {
  const kind = typeof value === "string" ? value : "";
  return ["tracked_repo", "local_only", "managed", "external", "mixed"].includes(kind)
    ? kind
    : "managed";
}

function normalizeArtifactVersionSourceKind(value: unknown): string {
  const kind = typeof value === "string" ? value : "";
  return ["tracked_repo", "local_only", "managed", "external"].includes(kind)
    ? kind
    : "managed";
}

function resolveArtifactSourceProjectId(db: Db, repoId: unknown): string | null {
  if (typeof repoId !== "string" || repoId.trim() === "" || !tableExists(db, "ledger_projects")) {
    return null;
  }
  const columns = new Set(
    (db.prepare("PRAGMA table_info(ledger_projects)").all() as Array<{ name: string }>).map(
      (column) => column.name,
    ),
  );
  const predicates = ["id = @repo", "display_name = @repo", "remote_identity = @repo", "upstream_identity = @repo"];
  if (columns.has("project_key")) {
    predicates.splice(1, 0, "project_key = @repo");
  }
  const row = db
    .prepare(
      `SELECT id FROM ledger_projects
       WHERE ${predicates.join(" OR ")}
       ORDER BY id
       LIMIT 1`,
    )
    .get({ repo: repoId.trim() }) as { id: string } | undefined;
  return row?.id ?? null;
}

function artifactIdentityRowCount(db: Db, table: string): number {
  if (!tableExists(db, table)) return 0;
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

function hasArtifactIdentityBackfillWork(db: Db): boolean {
  if (!tableExists(db, "artifact_blob") || !tableExists(db, "artifact") || !tableExists(db, "artifact_version")) {
    return true;
  }
  if (artifactIdentityRowCount(db, "artifacts") > artifactIdentityRowCount(db, "artifact_blob")) {
    return true;
  }
  if (artifactIdentityRowCount(db, "artifact_series") > artifactIdentityRowCount(db, "artifact")) {
    return true;
  }
  if (artifactIdentityRowCount(db, "artifact_versions") > artifactIdentityRowCount(db, "artifact_version")) {
    return true;
  }
  if (tableExists(db, "artifact_links")) {
    const names = tableColumnNames(db, "artifact_links");
    if (!names.has("target_type") || !names.has("target_id") || !names.has("legacy_blob_id")) {
      return true;
    }
    const row = db
      .prepare("SELECT 1 FROM artifact_links WHERE legacy_blob_id IS NULL LIMIT 1")
      .get();
    if (row) return true;
  }
  return false;
}

function backfillArtifactIdentityTables(db: Db): void {
  if (tableExists(db, "artifacts")) {
    const rows = db.prepare("SELECT * FROM artifacts ORDER BY id").all() as Array<Record<string, unknown>>;
    const insert = db.prepare(
      `INSERT OR IGNORE INTO artifact_blob (
        id, algorithm, content_hash, storage_uri, media_type, role, size_bytes,
        provider_id, manifest_id, metadata_json, custody_mode, availability,
        retention_json, reference_json, created_at
      ) VALUES (
        @id, @algorithm, @content_hash, @storage_uri, @media_type, @role, @size_bytes,
        @provider_id, @manifest_id, @metadata_json, @custody_mode, @availability,
        @retention_json, @reference_json, @created_at
      )`,
    );
    for (const row of rows) {
      const legacyId = String(row.id);
      const uri = typeof row.uri === "string" ? row.uri : null;
      insert.run({
        id: canonicalBlobIdForCompatibilityRef(legacyId),
        algorithm: typeof row.algorithm === "string" && row.algorithm ? row.algorithm : "sha256",
        content_hash: String(row.content_hash ?? legacyId),
        storage_uri: uri?.startsWith("repo://") ? null : uri,
        media_type: row.media_type ?? null,
        role: row.role ?? null,
        size_bytes: Number(row.size_bytes ?? 0),
        provider_id: row.provider_id ?? null,
        manifest_id: row.manifest_id ?? null,
        metadata_json: typeof row.metadata_json === "string" ? row.metadata_json : "{}",
        custody_mode: typeof row.custody_mode === "string" ? row.custody_mode : "managed",
        availability: typeof row.availability === "string" ? row.availability : "unchecked",
        retention_json: typeof row.retention_json === "string" ? row.retention_json : "{}",
        reference_json: typeof row.reference_json === "string" ? row.reference_json : "{}",
        created_at: Number(row.created_at ?? Date.now()),
      });
    }
  }

  if (tableExists(db, "artifact_series")) {
    const rows = db.prepare("SELECT * FROM artifact_series ORDER BY id").all() as Array<Record<string, unknown>>;
    const insert = db.prepare(
      `INSERT OR IGNORE INTO artifact (
        id, identity_key, source_kind, title, source_project_id, source_repo_id,
        logical_name, source_path, latest_version_id, version_count, metadata_json,
        created_at, updated_at
      ) VALUES (
        @id, @identity_key, @source_kind, @title, @source_project_id, @source_repo_id,
        @logical_name, @source_path, @latest_version_id, @version_count, @metadata_json,
        @created_at, @updated_at
      )`,
    );
    for (const row of rows) {
      const repoId = row.repo_id;
      insert.run({
        id: canonicalArtifactIdForCompatibilitySeries(String(row.id)),
        identity_key: String(row.series_key ?? row.id),
        source_kind: normalizeArtifactSourceKind(row.source_kind),
        title: row.title ?? null,
        source_project_id: resolveArtifactSourceProjectId(db, repoId),
        source_repo_id: repoId ?? null,
        logical_name: row.logical_name ?? null,
        source_path: row.logical_name ?? null,
        latest_version_id: typeof row.latest_version_id === "string"
          ? canonicalVersionIdForCompatibilityVersion(row.latest_version_id)
          : null,
        version_count: Number(row.version_count ?? 0),
        metadata_json: typeof row.metadata_json === "string" ? row.metadata_json : "{}",
        created_at: Number(row.created_at ?? Date.now()),
        updated_at: Number(row.updated_at ?? row.created_at ?? Date.now()),
      });
    }
  }

  if (tableExists(db, "artifact_versions")) {
    const rows = db
      .prepare(
        `SELECT
           v.*,
           s.repo_id AS series_repo_id,
           s.logical_name AS series_logical_name,
           a.home_repo_id AS blob_home_repo_id,
           a.repo_locator_json AS blob_repo_locator_json,
           a.uri AS blob_uri
         FROM artifact_versions v
         LEFT JOIN artifact_series s ON s.id = v.series_id
         LEFT JOIN artifacts a ON a.id = v.artifact_id
         ORDER BY v.id`,
      )
      .all() as Array<Record<string, unknown>>;
    const insert = db.prepare(
      `INSERT OR IGNORE INTO artifact_version (
        id, artifact_id, version_no, blob_id, source_kind, content_hash,
        source_project_id, source_repo_id, repo_path, commit_sha, observed_path,
        source_locator_json, custody_mode, label, note, metadata_json, created_at
      ) VALUES (
        @id, @artifact_id, @version_no, @blob_id, @source_kind, @content_hash,
        @source_project_id, @source_repo_id, @repo_path, @commit_sha, @observed_path,
        @source_locator_json, @custody_mode, @label, @note, @metadata_json, @created_at
      )`,
    );
    for (const row of rows) {
      const sourceRepoId = row.series_repo_id ?? row.blob_home_repo_id ?? null;
      const locator = {
        migrated_from: "artifact_versions",
        legacy_series_id: row.series_id ?? null,
        legacy_blob_id: row.artifact_id ?? null,
        legacy_uri: row.blob_uri ?? null,
        legacy_repo_locator: row.blob_repo_locator_json ?? null,
        series_logical_name: row.series_logical_name ?? null,
      };
      insert.run({
        id: canonicalVersionIdForCompatibilityVersion(String(row.id)),
        artifact_id: canonicalArtifactIdForCompatibilitySeries(String(row.series_id)),
        version_no: Number(row.version_no ?? 0),
        blob_id: canonicalBlobIdForCompatibilityRef(String(row.artifact_id)),
        source_kind: normalizeArtifactVersionSourceKind(row.source_kind),
        content_hash: String(row.content_hash ?? ""),
        source_project_id: resolveArtifactSourceProjectId(db, sourceRepoId),
        source_repo_id: sourceRepoId,
        repo_path: row.repo_path ?? null,
        commit_sha: row.commit_sha ?? null,
        observed_path: row.observed_path ?? null,
        source_locator_json: JSON.stringify(locator),
        custody_mode: row.custody_mode ?? null,
        label: row.label ?? null,
        note: row.note ?? null,
        metadata_json: typeof row.metadata_json === "string" ? row.metadata_json : "{}",
        created_at: Number(row.created_at ?? Date.now()),
      });
    }
  }
}

function backfillArtifactLinkTargets(db: Db): void {
  if (!tableExists(db, "artifact_links")) return;
  const names = tableColumnNames(db, "artifact_links");
  if (!names.has("target_type") || !names.has("target_id") || !names.has("legacy_blob_id")) return;

  const oldArtifactRows = tableExists(db, "artifacts")
    ? db.prepare("SELECT id FROM artifacts").all() as Array<{ id: string }>
    : [];
  const blobIdByLegacyArtifact = new Map(
    oldArtifactRows.map((row) => [row.id, canonicalBlobIdForCompatibilityRef(row.id)]),
  );
  const versions = tableExists(db, "artifact_versions")
    ? db.prepare("SELECT id, series_id, artifact_id FROM artifact_versions").all() as Array<{
      id: string;
      series_id: string;
      artifact_id: string;
    }>
    : [];
  const byBlob = new Map<string, typeof versions>();
  const byBlobSeries = new Map<string, typeof versions>();
  for (const version of versions) {
    byBlob.set(version.artifact_id, [...(byBlob.get(version.artifact_id) ?? []), version]);
    const key = `${version.artifact_id}\u0000${version.series_id}`;
    byBlobSeries.set(key, [...(byBlobSeries.get(key) ?? []), version]);
  }
  const newArtifactIds = new Set(
    tableExists(db, "artifact")
      ? (db.prepare("SELECT id FROM artifact").all() as Array<{ id: string }>).map((row) => row.id)
      : [],
  );

  const links = db
    .prepare(
      `SELECT id, artifact_id, link_kind, series_id
       FROM artifact_links
       WHERE legacy_blob_id IS NULL OR target_type IS NULL`,
    )
    .all() as Array<{
      id: string;
      artifact_id: string;
      link_kind: string | null;
      series_id: string | null;
    }>;
  const update = db.prepare(
    `UPDATE artifact_links
     SET target_type = COALESCE(target_type, @target_type),
         target_id = COALESCE(target_id, @target_id),
         fallback_version_id = COALESCE(fallback_version_id, @fallback_version_id),
         legacy_blob_id = COALESCE(legacy_blob_id, @legacy_blob_id)
     WHERE id = @id`,
  );

  for (const link of links) {
    const legacyBlobId = blobIdByLegacyArtifact.get(link.artifact_id)
      ?? canonicalBlobIdForCompatibilityRef(link.artifact_id);
    let targetType: string | null = null;
    let targetId: string | null = null;
    let fallbackVersionId: string | null = null;
    const seriesVersions = link.series_id
      ? byBlobSeries.get(`${link.artifact_id}\u0000${link.series_id}`) ?? []
      : [];
    const blobVersions = byBlob.get(link.artifact_id) ?? [];

    if (link.link_kind === "living" && link.series_id) {
      const artifactId = canonicalArtifactIdForCompatibilitySeries(link.series_id);
      if (newArtifactIds.has(artifactId)) {
        targetType = "artifact";
        targetId = artifactId;
      }
      const fallback = seriesVersions.length === 1
        ? seriesVersions[0]
        : blobVersions.length === 1
          ? blobVersions[0]
          : null;
      fallbackVersionId = fallback ? canonicalVersionIdForCompatibilityVersion(fallback.id) : null;
    } else {
      const candidates = seriesVersions.length > 0 ? seriesVersions : blobVersions;
      if (candidates.length === 1) {
        targetType = "artifact_version";
        targetId = canonicalVersionIdForCompatibilityVersion(candidates[0].id);
      }
    }

    update.run({
      id: link.id,
      target_type: targetType,
      target_id: targetId,
      fallback_version_id: fallbackVersionId,
      legacy_blob_id: legacyBlobId,
    });
  }
}

function verifyArtifactIdentityBackfill(db: Db): void {
  const expectedBlobs = artifactIdentityRowCount(db, "artifacts");
  const expectedArtifacts = artifactIdentityRowCount(db, "artifact_series");
  const expectedVersions = artifactIdentityRowCount(db, "artifact_versions");
  if (artifactIdentityRowCount(db, "artifact_blob") < expectedBlobs) {
    throw new Error("migration 91 verification: not every legacy artifacts row was backfilled to artifact_blob");
  }
  if (artifactIdentityRowCount(db, "artifact") < expectedArtifacts) {
    throw new Error("migration 91 verification: not every artifact_series row was backfilled to artifact");
  }
  if (artifactIdentityRowCount(db, "artifact_version") < expectedVersions) {
    throw new Error("migration 91 verification: not every artifact_versions row was backfilled to artifact_version");
  }
  const violations = db.prepare("PRAGMA foreign_key_check").all();
  if (violations.length > 0) {
    throw new Error(`migration 91 verification: ${violations.length} foreign key violation(s) after artifact identity backfill`);
  }
}

function verifyArtifactIdentitySchema(db: Db): void {
  const hasUniqueIndexOver = (table: string, expected: string[]): boolean => {
    const indexes = db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string; unique: number }>;
    return indexes.some((index) => {
      if (!index.unique) return false;
      const cols = (db.prepare(`PRAGMA index_info(${index.name})`).all() as Array<{ name: string }>)
        .map((info) => info.name);
      return cols.length === expected.length && expected.every((col, i) => cols[i] === col);
    });
  };
  const requireTable = (table: string, columns: string[], checkPattern?: RegExp): string => {
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) as { sql: string | null } | undefined;
    if (!row?.sql) {
      throw new Error(`migration 91 verification: table ${table} is missing after migration`);
    }
    const present = new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name),
    );
    for (const column of columns) {
      if (!present.has(column)) {
        throw new Error(`migration 91 verification: table ${table} is missing expected column '${column}'`);
      }
    }
    if (checkPattern && !checkPattern.test(row.sql)) {
      throw new Error(`migration 91 verification: table ${table} is missing expected CHECK constraint`);
    }
    return row.sql;
  };

  const blobSql = requireTable("artifact_blob", [
    "id", "algorithm", "content_hash", "storage_uri", "media_type", "role",
    "size_bytes", "provider_id", "manifest_id", "metadata_json", "custody_mode",
    "availability", "retention_json", "reference_json", "created_at",
  ], /CHECK\s*\(\s*custody_mode\s+IN/i);
  if (/\bhome_repo_id\b/i.test(blobSql) || /\brepo_locator_json\b/i.test(blobSql)) {
    throw new Error("migration 91 verification: artifact_blob must not carry project/source repo columns");
  }
  requireTable("artifact", [
    "id", "identity_key", "source_kind", "title", "source_project_id", "source_repo_id",
    "logical_name", "source_path", "latest_version_id", "version_count",
    "metadata_json", "created_at", "updated_at",
  ], /CHECK\s*\(\s*source_kind\s+IN/i);
  requireTable("artifact_version", [
    "id", "artifact_id", "version_no", "blob_id", "source_kind", "content_hash",
    "source_project_id", "source_repo_id", "repo_path", "commit_sha", "observed_path",
    "source_locator_json", "custody_mode", "label", "note", "metadata_json", "created_at",
  ], /CHECK\s*\(\s*source_kind\s+IN/i);
  requireTable("project_artifact_associations", [
    "id", "project_id", "target_type", "target_id", "association_kind", "role",
    "title", "description", "rank", "status", "source", "source_ref_type",
    "source_ref_id", "metadata_json", "created_at", "updated_at",
  ], /CHECK\s*\(\s*target_type\s+IN/i);

  if (!hasUniqueIndexOver("artifact_blob", ["algorithm", "content_hash"])) {
    throw new Error("migration 91 verification: artifact_blob is missing UNIQUE(algorithm, content_hash)");
  }
  if (!hasUniqueIndexOver("artifact", ["identity_key"])) {
    throw new Error("migration 91 verification: artifact is missing UNIQUE(identity_key)");
  }
  if (!hasUniqueIndexOver("artifact_version", ["artifact_id", "version_no"])) {
    throw new Error("migration 91 verification: artifact_version is missing UNIQUE(artifact_id, version_no)");
  }
  if (!hasUniqueIndexOver("project_artifact_associations", ["project_id", "target_type", "target_id", "role"])) {
    throw new Error("migration 91 verification: project_artifact_associations is missing its inline UNIQUE");
  }

  const versionFkTargets = new Set(
    (db.prepare("PRAGMA foreign_key_list(artifact_version)").all() as Array<{ table: string }>).map(
      (fk) => fk.table,
    ),
  );
  if (!versionFkTargets.has("artifact") || !versionFkTargets.has("artifact_blob")) {
    throw new Error("migration 91 verification: artifact_version is missing artifact/blob foreign keys");
  }
  const artifactFks = db.prepare("PRAGMA foreign_key_list(artifact)").all() as Array<{ from: string; table: string }>;
  if (artifactFks.some((fk) => fk.from === "latest_version_id" || fk.table === "artifact_version")) {
    throw new Error("migration 91 verification: artifact.latest_version_id must remain a soft cache");
  }

  if (tableExists(db, "artifact_links")) {
    const linkSql = (db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'artifact_links'")
      .get() as { sql: string | null } | undefined)?.sql ?? "";
    const columns = tableColumnNames(db, "artifact_links");
    for (const column of ["target_type", "target_id", "fallback_version_id", "legacy_blob_id"]) {
      if (!columns.has(column)) {
        throw new Error(`migration 91 verification: artifact_links is missing ${column}`);
      }
    }
    if (!/CHECK\s*\(\s*target_type\s+IS\s+NULL\s+OR\s+target_type\s+IN/i.test(linkSql)) {
      throw new Error("migration 91 verification: artifact_links.target_type is missing its CHECK");
    }
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

// Umbrella 8e2e8b2 / issue 92813cc (migration 108): guarded ALTER ADD COLUMN
// for the parallel user-attribution columns. Each column is added only when
// absent so a fresh baseline (which already has them) and a schema-rewind
// re-run are both idempotent. The definitions here MUST match the fresh-schema
// baseline byte-for-byte after normalization.
function ensureLedgerUserAttributionColumns(db: Db): void {
  const userFk = "TEXT REFERENCES users(id) ON DELETE RESTRICT";
  const evidenceFk = "TEXT REFERENCES attribution_evidence(id) ON DELETE SET NULL";
  const plan: Array<{ table: string; columns: Array<[string, string]> }> = [
    {
      table: "ledger_issues",
      columns: [
        ["author_user_id", userFk],
        ["evidence_method", "TEXT"],
        ["evidence_id", evidenceFk],
      ],
    },
    {
      table: "ledger_comments",
      columns: [
        ["author_user_id", userFk],
        ["evidence_method", "TEXT"],
        ["evidence_id", evidenceFk],
      ],
    },
    {
      table: "ledger_issue_checkpoints",
      columns: [
        ["author_user_id", userFk],
        ["evidence_method", "TEXT"],
        ["evidence_id", evidenceFk],
      ],
    },
    {
      table: "ledger_events",
      columns: [
        ["actor_user_id", userFk],
        ["evidence_method", "TEXT"],
        ["evidence_id", evidenceFk],
      ],
    },
    {
      table: "ledger_body_revisions",
      columns: [
        ["actor_user_id", userFk],
        ["evidence_method", "TEXT"],
        ["evidence_id", evidenceFk],
        ["redacted_by_user_id", userFk],
      ],
    },
    {
      table: "ledger_relationship_edges",
      columns: [
        ["actor_user_id", userFk],
        ["evidence_method", "TEXT"],
        ["evidence_id", evidenceFk],
      ],
    },
  ];
  const indexes: Record<string, string> = {
    ledger_issues:
      `CREATE INDEX IF NOT EXISTS idx_ledger_issues_author_user
        ON ledger_issues(author_user_id) WHERE author_user_id IS NOT NULL`,
    ledger_comments:
      `CREATE INDEX IF NOT EXISTS idx_ledger_comments_author_user
        ON ledger_comments(author_user_id) WHERE author_user_id IS NOT NULL`,
    ledger_events:
      `CREATE INDEX IF NOT EXISTS idx_ledger_events_actor_user
        ON ledger_events(actor_user_id) WHERE actor_user_id IS NOT NULL`,
  };
  for (const { table, columns } of plan) {
    const tableExistsRow = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table);
    if (!tableExistsRow) continue;
    for (const [name, definition] of columns) {
      const existing = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
        .some((column) => column.name === name);
      if (!existing) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
      }
    }
    const index = indexes[table];
    if (index) db.exec(index);
  }
}

// Umbrella 8e2e8b2 / issue 6349203 (migration 109): guarded auth-request
// requester, approver, and execution-evidence columns. Like migration 108,
// this must tolerate a baseline-shaped table whose schema version was rewound
// for recovery or migration verification.
function ensureAuthRequestUserAttributionColumns(db: Db): void {
  if (!tableExists(db, "auth_requests")) return;
  const columns: Array<[string, string]> = [
    ["requested_by_user_id", "TEXT REFERENCES users(id) ON DELETE RESTRICT"],
    ["approved_by_user_id", "TEXT REFERENCES users(id) ON DELETE RESTRICT"],
    ["execution_evidence_id", "TEXT REFERENCES attribution_evidence(id) ON DELETE SET NULL"],
  ];
  for (const [name, definition] of columns) {
    if (!tableColumnNames(db, "auth_requests").has(name)) {
      db.exec(`ALTER TABLE auth_requests ADD COLUMN ${name} ${definition}`);
    }
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_auth_requests_requested_by_user
    ON auth_requests(requested_by_user_id) WHERE requested_by_user_id IS NOT NULL`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_auth_requests_approved_by_user
    ON auth_requests(approved_by_user_id) WHERE approved_by_user_id IS NOT NULL`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_auth_requests_execution_evidence
    ON auth_requests(execution_evidence_id) WHERE execution_evidence_id IS NOT NULL`);
}

// Issue a64d2de (migration 115): retroactively clear operator misattribution on
// ledger rows that a tokenless compat-mode write stamped with
// evidence_method='local_default'. Only the parallel user-attribution columns
// are nulled, and only for 'local_default' rows — every other evidence class
// (session_claim, api_token, credential_signature, system_internal,
// external_import) and the frozen legacy actor_id/actor_type/author_display
// provenance are untouched. Guarded on table/column existence so a partial or
// rewound schema replays cleanly; the UPDATE is idempotent because a re-run
// finds no remaining 'local_default' rows. ledger_body_revisions is included:
// its rows inherit the parent issue/comment write's attribution (same
// resolveActor context), so a tokenless write stamped them local_default too.
// Only its write-attribution columns (actor_user_id/evidence_method/evidence_id)
// are cleared; the separate redaction-attribution column is not touched.
function clearLocalDefaultLedgerAttribution(db: Db): void {
  const plan: Array<{ table: string; userColumn: string }> = [
    { table: "ledger_issues", userColumn: "author_user_id" },
    { table: "ledger_comments", userColumn: "author_user_id" },
    { table: "ledger_issue_checkpoints", userColumn: "author_user_id" },
    { table: "ledger_events", userColumn: "actor_user_id" },
    { table: "ledger_relationship_edges", userColumn: "actor_user_id" },
    { table: "ledger_body_revisions", userColumn: "actor_user_id" },
  ];
  for (const { table, userColumn } of plan) {
    if (!tableExists(db, table)) continue;
    const columns = tableColumnNames(db, table);
    if (!columns.has("evidence_method") || !columns.has(userColumn)) continue;
    const clearEvidenceId = columns.has("evidence_id") ? ", evidence_id = NULL" : "";
    db.exec(
      `UPDATE ${table}
         SET ${userColumn} = NULL, evidence_method = NULL${clearEvidenceId}
       WHERE evidence_method = 'local_default'`,
    );
  }
}

// Issue be2ab49 (migration 117) — cutoff for the residual local_default sweep.
// This is the exact commit timestamp of the v115 merge commit 08bcc7c on main
// ("2026-07-23 20:29:16 -0400" = epoch seconds 1784852956) in milliseconds. It
// is deliberately hard-coded rather than derived at runtime: this is a one-shot
// correction tied to a specific point in this database's deployment history, so
// the boundary must be immutable regardless of when the migration is applied.
// Rows written strictly before this instant belong to the misattributed window
// (the premature v115 run at 17:53Z through the corrected restart at 20:29:16Z);
// any legitimate operator attribution written after the restart is preserved.
//
// Empirical safety evidence (verified read-only against the affected live DB at
// implementation time): ZERO 'local_default' rows exist at or after this cutoff
// in any of the six tables — the boundary cleanly separates the misattributed
// window from all later writes, so no legitimate post-restart row is at risk
// from the timestamp predicate.
export const RESIDUAL_LOCAL_DEFAULT_CUTOFF_MS = 1784852956000;

// Deployment-history scoping (issue be2ab49): the misattributed rows on THIS
// database all carry the operator's user id (settings key user.operator_id,
// human user "mll") in their attribution column — verified read-only: all 424
// residual rows have this id, and no pre-cutoff 'local_default' row carries any
// other id. Requiring the id in addition to the timestamp confines the clearing
// to this deployment's residue: on a restored backup, a different install, or
// any other database at v115, legitimate 'local_default' attribution belonging
// to a different operator id (or a different deployment timeline) is left
// untouched, and the migration is a no-op there.
export const RESIDUAL_MISATTRIBUTION_OPERATOR_ID = "01KY5J56GRJDK8ZEQS79DPPJFN";

// Issue be2ab49 (migration 117): clear the residual operator misattribution that
// migration 115 could not reach because it was consumed prematurely (see the
// migration 117 entry and issue 07edc0d for the deployment-history rationale).
// Mirrors clearLocalDefaultLedgerAttribution but narrows the WHERE clause three
// ways so only this deployment's historical residue is cleared:
//   1. evidence_method = 'local_default' (as v115);
//   2. the attribution user column equals this deployment's operator id, so the
//      migration is a no-op on any other database (restored backups, other
//      installs) even if it is also at v115 with its own local_default rows;
//   3. the row's attribution-write timestamp is strictly before the cutoff.
// For the timestamp, ledger_relationship_edges is upserted in place on relink
// (src/ledger/store.ts): a relink overwrites actor_user_id/evidence_method but
// preserves created_at and stamps updated_at, so created_at can predate a later
// legitimate attribution write. Edges therefore use COALESCE(updated_at,
// created_at) — the column that reflects the LAST attribution write. The other
// five tables set attribution once at row creation (edits append new
// events/body-revisions rather than overwriting the row), so their creation
// timestamp is the correct and only attribution-write time. Guarded and
// naturally idempotent: a no-op on fresh databases and on any DB with no
// matching residual rows.
function clearResidualLocalDefaultLedgerAttribution(db: Db): void {
  const plan: Array<{
    table: string;
    userColumn: string;
    timeExpr: string;
    timeColumns: string[];
  }> = [
    { table: "ledger_issues", userColumn: "author_user_id", timeExpr: "created_at", timeColumns: ["created_at"] },
    { table: "ledger_comments", userColumn: "author_user_id", timeExpr: "created_at", timeColumns: ["created_at"] },
    { table: "ledger_issue_checkpoints", userColumn: "author_user_id", timeExpr: "created_at", timeColumns: ["created_at"] },
    { table: "ledger_events", userColumn: "actor_user_id", timeExpr: "occurred_at", timeColumns: ["occurred_at"] },
    {
      table: "ledger_relationship_edges",
      userColumn: "actor_user_id",
      timeExpr: "COALESCE(updated_at, created_at)",
      timeColumns: ["updated_at", "created_at"],
    },
    { table: "ledger_body_revisions", userColumn: "actor_user_id", timeExpr: "occurred_at", timeColumns: ["occurred_at"] },
  ];
  for (const { table, userColumn, timeExpr, timeColumns } of plan) {
    if (!tableExists(db, table)) continue;
    const columns = tableColumnNames(db, table);
    if (!columns.has("evidence_method") || !columns.has(userColumn)) continue;
    if (!timeColumns.every((column) => columns.has(column))) continue;
    const clearEvidenceId = columns.has("evidence_id") ? ", evidence_id = NULL" : "";
    db.prepare(
      `UPDATE ${table}
         SET ${userColumn} = NULL, evidence_method = NULL${clearEvidenceId}
       WHERE evidence_method = 'local_default'
         AND ${userColumn} = ?
         AND ${timeExpr} < ?`,
    ).run(RESIDUAL_MISATTRIBUTION_OPERATOR_ID, RESIDUAL_LOCAL_DEFAULT_CUTOFF_MS);
  }
}

// Umbrella 8e2e8b2 / issue e552606 (migration 110): guarded ownership columns.
// These are write-time identity facts, separate from mutable liveness and
// provider/session mechanism bookkeeping.
function ensureSessionOwnershipColumns(db: Db): void {
  for (const table of ["sessions", "console_sessions", "work_units"]) {
    if (!tableExists(db, table)) continue;
    if (!tableColumnNames(db, table).has("owner_user_id")) {
      db.exec(
        `ALTER TABLE ${table} ADD COLUMN owner_user_id
          TEXT REFERENCES users(id) ON DELETE SET NULL`,
      );
    }
  }
}

// Issue 499c148 (migration 116): both columns are nullable and additive, so
// legacy session rows simply start out unflagged.
function ensureSessionIdentityMismatchColumns(db: Db): void {
  if (!tableExists(db, "sessions")) return;
  const columns = tableColumnNames(db, "sessions");
  if (!columns.has("identity_mismatch_at")) {
    db.exec("ALTER TABLE sessions ADD COLUMN identity_mismatch_at INTEGER");
  }
  if (!columns.has("identity_mismatch_json")) {
    db.exec("ALTER TABLE sessions ADD COLUMN identity_mismatch_json TEXT");
  }
}

// Umbrella 8e2e8b2 / issue a0379a3 (migration 111): restriction is opt-in so
// adding this column preserves every existing project's effective access.
function ensureProjectRestrictionColumn(db: Db): void {
  if (!tableExists(db, "ledger_projects")) return;
  if (!tableColumnNames(db, "ledger_projects").has("restricted")) {
    db.exec(
      `ALTER TABLE ledger_projects ADD COLUMN restricted INTEGER NOT NULL DEFAULT 0
        CHECK(restricted IN (0, 1))`,
    );
  }
}

function ensureBranchReapingKnowledgeColumns(db: Db): void {
  const expected = [
    "worktree_inventory_known",
    "worktree_status_known",
    "default_comparison_known",
  ];
  const table = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'branches'")
    .get();
  if (!table) return;

  for (const name of expected) {
    const columns = db.prepare("PRAGMA table_info(branches)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    const existing = columns.find((column) => column.name === name);
    if (!existing) {
      db.exec(`ALTER TABLE branches ADD COLUMN ${name} INTEGER NOT NULL DEFAULT 0`);
      continue;
    }
    if (
      existing.type.toUpperCase() !== "INTEGER" ||
      existing.notnull !== 1 ||
      existing.dflt_value !== "0"
    ) {
      throw new Error(`migration 106 verification: branches.${name} has divergent definition`);
    }
  }
}

function ensureBranchUpstreamColumns(db: Db): void {
  const table = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'branches'")
    .get();
  if (!table) return;

  const columnInfo = () =>
    db.prepare("PRAGMA table_info(branches)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }>;

  const hasUpstream = columnInfo().find((column) => column.name === "has_upstream");
  if (!hasUpstream) {
    db.exec("ALTER TABLE branches ADD COLUMN has_upstream INTEGER NOT NULL DEFAULT 0");
  } else if (
    hasUpstream.type.toUpperCase() !== "INTEGER" ||
    hasUpstream.notnull !== 1 ||
    hasUpstream.dflt_value !== "0"
  ) {
    throw new Error("migration 112 verification: branches.has_upstream has divergent definition");
  }

  const upstream = columnInfo().find((column) => column.name === "upstream");
  if (!upstream) {
    db.exec("ALTER TABLE branches ADD COLUMN upstream TEXT");
  } else if (upstream.type.toUpperCase() !== "TEXT") {
    throw new Error("migration 112 verification: branches.upstream has divergent definition");
  }
}

// Issue 93d978e (migration 113 after integration reconciliation) — additive
// nullable tombstone column for the merge-scan retirement sweep. Guarded so
// re-running migrate over a database that already has the column (e.g.
// version-rewind test fixtures) is a no-op rather than a duplicate-column error.
function ensureWorkUnitMergeScanRetirementColumn(db: Db): void {
  const table = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'work_units'")
    .get();
  if (!table) return;
  const columns = db.prepare("PRAGMA table_info(work_units)").all() as Array<{
    name: string;
    type: string;
  }>;
  const existing = columns.find((column) => column.name === "merge_scan_retired_at");
  if (!existing) {
    db.exec("ALTER TABLE work_units ADD COLUMN merge_scan_retired_at INTEGER");
    return;
  }
  if (existing.type.toUpperCase() !== "INTEGER") {
    throw new Error(
      "migration 113 verification: work_units.merge_scan_retired_at has divergent definition",
    );
  }
}

// Issue 75f52ac (migration 114 after integration reconciliation) — additive
// nullable JSON column recording the background finalizer queue's per-step
// durable state. Guarded so re-running migrate over a database that already has
// the column (version-rewind fixtures) is a no-op rather than a
// duplicate-column error.
function ensureAuthRequestMergeFinalizerStateColumn(db: Db): void {
  if (!tableExists(db, "auth_requests")) return;
  const columns = tableColumnNames(db, "auth_requests");
  if (!columns.has("merge_finalizer_state")) {
    db.exec("ALTER TABLE auth_requests ADD COLUMN merge_finalizer_state TEXT");
  }
}

function ensureAuthRequestAtomicMergeColumns(db: Db): void {
  if (!tableExists(db, "auth_requests")) return;
  const columns = tableColumnNames(db, "auth_requests");
  if (!columns.has("merge_candidate_tree_sha")) {
    db.exec("ALTER TABLE auth_requests ADD COLUMN merge_candidate_tree_sha TEXT");
  }
  if (!columns.has("merge_candidate_pin_sha")) {
    db.exec("ALTER TABLE auth_requests ADD COLUMN merge_candidate_pin_sha TEXT");
  }
  if (!columns.has("merge_atomic_enabled")) {
    db.exec("ALTER TABLE auth_requests ADD COLUMN merge_atomic_enabled INTEGER NOT NULL DEFAULT 0");
  }
}

// Integration reconciliation (umbrella c16807e): true when any renumbered
// additive column (v112 branches.has_upstream/upstream, v113
// work_units.merge_scan_retired_at, v114 auth_requests.merge_finalizer_state) is
// still absent from a live, non-fresh database. The convergence pass is gated on
// this LIVE schema inspection rather than the recorded schema version so that if
// a convergence hook throws and its repair rolls back, the next open re-detects
// the missing column and retries — a version-based gate would be permanently
// skipped once applySchemaMigrations has already recorded the head version.
function needsRenumberedColumnConvergence(db: Db): boolean {
  const missing = (table: string, required: readonly string[]): boolean => {
    if (!tableExists(db, table)) return false;
    const present = new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (column) => column.name,
      ),
    );
    return required.some((column) => !present.has(column));
  };
  return (
    missing("branches", ["has_upstream", "upstream"]) ||
    missing("work_units", ["merge_scan_retired_at"]) ||
    missing("auth_requests", ["merge_finalizer_state"])
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
      merge_preflight_base_sha TEXT,
      merge_preflight_queue_fingerprint TEXT,
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
    ["merge_preflight_base_sha", "TEXT"],
    ["merge_preflight_queue_fingerprint", "TEXT"],
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

// Issue 7d64d8f (migration 123) — additive nullable digest column binding an
// auth request to the exact canonical change message bytes the merge commits.
function ensureAuthRequestCanonicalChangeMessageColumn(db: Db): void {
  if (!tableExists(db, "auth_requests")) return;
  const existing = (db.prepare("PRAGMA table_info(auth_requests)").all() as Array<{
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
  }>).find((column) => column.name === "commit_message_digest");
  if (!existing) {
    db.exec("ALTER TABLE auth_requests ADD COLUMN commit_message_digest TEXT");
    return;
  }
  if (
    existing.type.toUpperCase() !== "TEXT" ||
    existing.notnull !== 0 ||
    existing.dflt_value !== null
  ) {
    throw new Error(
      "migration 123 verification: auth_requests.commit_message_digest has a divergent definition",
    );
  }
}

// Issue c94c6d0 (migration 131): schema-rewind fixtures may already have the
// acknowledgement columns from the current baseline while recording v130.
// Guard each additive column so replay converges instead of failing with a
// duplicate-column error; the migration statement then creates the dependent
// index after both columns are known to exist.
function ensureManagedReminderOccurrenceAcknowledgementColumns(db: Db): void {
  if (!tableExists(db, "managed_task_occurrences")) return;
  const columns = tableColumnNames(db, "managed_task_occurrences");
  if (!columns.has("acknowledged_by")) {
    db.exec("ALTER TABLE managed_task_occurrences ADD COLUMN acknowledged_by TEXT");
  }
  if (!columns.has("acknowledged_at")) {
    db.exec("ALTER TABLE managed_task_occurrences ADD COLUMN acknowledged_at INTEGER");
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

function ensureAuthRequestPreflightReuseColumns(db: Db): void {
  if (!tableExists(db, "auth_requests")) return;
  const columns = tableColumnNames(db, "auth_requests");
  if (!columns.has("merge_preflight_base_sha")) {
    db.exec("ALTER TABLE auth_requests ADD COLUMN merge_preflight_base_sha TEXT");
  }
  if (!columns.has("merge_preflight_queue_fingerprint")) {
    db.exec("ALTER TABLE auth_requests ADD COLUMN merge_preflight_queue_fingerprint TEXT");
  }
}

function ensureConsoleTransportLaneColumn(db: Db): void {
  if (!tableExists(db, "console_sessions")) return;
  const columns = tableColumnNames(db, "console_sessions");
  if (columns.has("transport_lane")) return;

  db.exec("ALTER TABLE console_sessions ADD COLUMN transport_lane TEXT NOT NULL DEFAULT 'pty'");
  db.exec(
    `UPDATE console_sessions
       SET transport_lane = CASE
         WHEN channel_enabled = 1 THEN 'channel'
         WHEN backend_type = 'sdk' THEN 'sdk'
         WHEN backend_type = 'acp' THEN 'acp'
         WHEN backend_type = 'spawn' THEN 'spawn'
         ELSE 'pty'
       END`
  );
}

function ensureMessageParamsThinkingEffortColumn(db: Db): void {
  if (!tableExists(db, "message_params")) return;
  const columns = tableColumnNames(db, "message_params");
  if (columns.has("thinking_effort")) return;

  db.exec("ALTER TABLE message_params ADD COLUMN thinking_effort TEXT");
}

const ARTIFACT_CANONICAL_TARGET_TABLES = [
  "artifact_aliases",
  "artifact_links",
  "session_instruction_artifacts",
  "artifact_drafts",
] as const;

const ARTIFACT_CANONICAL_TARGET_INDEXES = new Set([
  "idx_artifact_aliases_artifact",
  "idx_artifact_aliases_blob",
  "idx_artifact_aliases_scheme_ref",
  "idx_artifact_aliases_status",
  "idx_artifact_links_artifact",
  "idx_artifact_links_blob",
  "idx_artifact_links_entity",
  "idx_artifact_links_fallback_version",
  "idx_artifact_links_kind",
  "idx_artifact_links_legacy_blob",
  "idx_artifact_links_provider",
  "idx_artifact_links_repo",
  "idx_artifact_links_role",
  "idx_artifact_links_series",
  "idx_artifact_links_target",
  "idx_artifact_drafts_base",
  "idx_artifact_drafts_legacy_series",
  "idx_artifact_drafts_version",
  "idx_session_instruction_artifacts_legacy_series",
  "idx_session_instruction_artifacts_legacy_version",
  "idx_session_instruction_artifacts_session",
  "idx_session_instruction_artifacts_version",
]);

function needsArtifactCanonicalTargetMigration(db: Db): boolean {
  const canonicalColumns: ReadonlyArray<readonly [string, string[]]> = [
    ["artifact_aliases", ["blob_id"]],
    ["artifact_links", ["blob_id"]],
    ["session_instruction_artifacts", ["artifact_id", "version_id"]],
    ["artifact_drafts", ["artifact_id", "version_id"]],
  ];
  const states = canonicalColumns.map(([table, columns]) => {
    if (!tableExists(db, table)) return false;
    const names = tableColumnNames(db, table);
    return columns.every((column) => names.has(column));
  });
  if (states.every(Boolean)) {
    verifyArtifactCanonicalTargetSchema(db);
    return false;
  }
  if (states.some(Boolean)) {
    throw new Error(
      "migration 104 precondition: canonical target columns are only partially applied",
    );
  }
  return true;
}

function migration104FailureIds(
  db: Db,
  label: string,
  sql: string,
): void {
  const rows = db.prepare(sql).all() as Array<{ id: string }>;
  if (rows.length === 0) return;
  throw new Error(
    `migration 104 preflight: ${label}; offending ids: ${rows.map((row) => row.id).join(", ")}`,
  );
}

function assertMigration104Preconditions(db: Db): void {
  for (const table of ARTIFACT_CANONICAL_TARGET_TABLES) {
    if (!tableExists(db, table)) {
      throw new Error(`migration 104 precondition: required table ${table} is missing`);
    }
  }
  const mappingTables = [
    "artifacts",
    "artifact_series",
    "artifact_versions",
    "artifact_blob",
    "artifact",
    "artifact_version",
  ];
  for (const table of mappingTables) {
    if (!tableExists(db, table)) {
      throw new Error(`migration 104 precondition: required mapping table ${table} is missing`);
    }
  }

  const triggers = db.prepare(
    `SELECT name AS id
       FROM sqlite_master
      WHERE type = 'trigger'
        AND tbl_name IN ('artifact_aliases', 'artifact_links',
                         'session_instruction_artifacts', 'artifact_drafts')
      ORDER BY name`,
  ).all() as Array<{ id: string }>;
  if (triggers.length > 0) {
    const triggerIds = triggers.map((row) => row.id).join(", ");
    throw new Error(
      `migration 104 precondition: affected tables have triggers that cannot be lost; ` +
      `offending ids: ${triggerIds}`,
    );
  }
  for (const table of ARTIFACT_CANONICAL_TARGET_TABLES) {
    if (tableExists(db, `${table}_v104`)) {
      throw new Error(`migration 104 precondition: unexpected staging table ${table}_v104 exists`);
    }
  }

  migration104FailureIds(
    db,
    "resolved aliases must map to exactly one canonical blob",
    `SELECT aa.id
       FROM artifact_aliases aa
      WHERE aa.resolution_status = 'resolved'
        AND (
          aa.artifact_id IS NULL OR
          COALESCE(
            (SELECT COUNT(*)
               FROM artifacts legacy_blob
               JOIN artifact_blob canonical_blob
                 ON canonical_blob.algorithm = legacy_blob.algorithm
                AND canonical_blob.content_hash = legacy_blob.content_hash
              WHERE legacy_blob.id = aa.artifact_id),
            0
          ) +
          CASE WHEN EXISTS (
            SELECT 1
              FROM artifacts legacy_blob
             WHERE legacy_blob.id = aa.artifact_id
               AND aa.scheme = 'repo'
               AND aa.normalized_ref = legacy_blob.uri
               AND legacy_blob.algorithm = 'ref-sha256'
               AND legacy_blob.id = 'artifact:ref:' || legacy_blob.content_hash
               AND NOT EXISTS (
                 SELECT 1
                   FROM artifact_blob canonical_blob
                  WHERE canonical_blob.algorithm = legacy_blob.algorithm
                    AND canonical_blob.content_hash = legacy_blob.content_hash
               )
          ) THEN (
            SELECT COUNT(*)
              FROM artifacts recovered_artifact
              JOIN artifact_blob recovered_blob
                ON recovered_blob.algorithm = recovered_artifact.algorithm
               AND recovered_blob.content_hash = recovered_artifact.content_hash
              JOIN artifacts legacy_blob ON legacy_blob.id = aa.artifact_id
             WHERE recovered_artifact.uri = legacy_blob.uri
               AND recovered_artifact.algorithm = 'sha256'
               AND recovered_artifact.id =
                 'artifact:sha256:' || recovered_artifact.content_hash
               AND recovered_blob.id =
                 'artifact-blob:' || recovered_artifact.content_hash
          ) ELSE 0 END != 1
        )
      ORDER BY aa.id`,
  );
  migration104FailureIds(
    db,
    "links must map to exactly one canonical blob",
    `SELECT link.id
       FROM artifact_links link
      WHERE (SELECT COUNT(*)
               FROM artifacts legacy_blob
               JOIN artifact_blob canonical_blob
                 ON canonical_blob.algorithm = legacy_blob.algorithm
                AND canonical_blob.content_hash = legacy_blob.content_hash
              WHERE legacy_blob.id = link.artifact_id) != 1
      ORDER BY link.id`,
  );
  migration104FailureIds(
    db,
    "living links must map to exactly one canonical artifact",
    `SELECT link.id
       FROM artifact_links link
      WHERE link.link_kind = 'living'
        AND (
          (link.series_id IS NOT NULL AND
           (SELECT COUNT(*)
              FROM artifact_series legacy_series
              JOIN artifact canonical_artifact
                ON canonical_artifact.identity_key = legacy_series.series_key
             WHERE legacy_series.id = link.series_id) != 1)
          OR
          (link.series_id IS NULL AND NOT EXISTS (
            SELECT 1
              FROM artifacts legacy_blob
              JOIN artifact_blob canonical_blob
                ON canonical_blob.algorithm = legacy_blob.algorithm
               AND canonical_blob.content_hash = legacy_blob.content_hash
              JOIN artifact_version fallback_version
                ON fallback_version.id = link.fallback_version_id
               AND fallback_version.blob_id = canonical_blob.id
               AND fallback_version.content_hash = canonical_blob.content_hash
              JOIN artifact canonical_artifact
                ON canonical_artifact.id = link.target_id
               AND fallback_version.artifact_id = canonical_artifact.id
             WHERE legacy_blob.id = link.artifact_id
               AND link.target_type = 'artifact'
          ))
        )
      ORDER BY link.id`,
  );
  migration104FailureIds(
    db,
    "existing link targets contradict canonical identity or bytes",
    `WITH link_map AS (
       SELECT link.*,
              canonical_blob.id AS mapped_blob_id,
              canonical_artifact.id AS mapped_artifact_id
         FROM artifact_links link
         JOIN artifacts legacy_blob ON legacy_blob.id = link.artifact_id
         JOIN artifact_blob canonical_blob
           ON canonical_blob.algorithm = legacy_blob.algorithm
          AND canonical_blob.content_hash = legacy_blob.content_hash
         LEFT JOIN artifact_series legacy_series ON legacy_series.id = link.series_id
         LEFT JOIN artifact canonical_artifact
           ON canonical_artifact.identity_key = legacy_series.series_key
     )
     SELECT link_map.id
       FROM link_map
      WHERE (target_type IS NULL) != (target_id IS NULL)
         OR (legacy_blob_id IS NOT NULL AND legacy_blob_id != mapped_blob_id)
         OR (fallback_version_id IS NOT NULL AND NOT EXISTS (
               SELECT 1 FROM artifact_version version
                WHERE version.id = fallback_version_id
                  AND version.blob_id = mapped_blob_id
                  AND version.content_hash = (
                    SELECT content_hash FROM artifact_blob WHERE id = mapped_blob_id
                  )
             ))
         OR (link_kind = 'living' AND series_id IS NOT NULL AND (
               mapped_artifact_id IS NULL OR
               (target_type IS NOT NULL AND
                (target_type != 'artifact' OR target_id != mapped_artifact_id))
             ))
         OR (link_kind = 'living' AND series_id IS NULL AND NOT EXISTS (
               SELECT 1
                 FROM artifact_version fallback_version
                 JOIN artifact canonical_artifact
                   ON canonical_artifact.id = target_id
                  AND fallback_version.artifact_id = canonical_artifact.id
                WHERE target_type = 'artifact'
                  AND fallback_version.id = fallback_version_id
                  AND fallback_version.blob_id = mapped_blob_id
                  AND fallback_version.content_hash = (
                    SELECT content_hash FROM artifact_blob WHERE id = mapped_blob_id
                  )
             ))
         OR (link_kind = 'pinned' AND target_type IS NOT NULL AND NOT (
               (target_type = 'artifact_blob' AND target_id = mapped_blob_id) OR
               (target_type = 'artifact_version' AND EXISTS (
                 SELECT 1 FROM artifact_version version
                  WHERE version.id = target_id
                    AND version.blob_id = mapped_blob_id
                    AND version.content_hash = (
                      SELECT content_hash FROM artifact_blob WHERE id = mapped_blob_id
                    )
               ))
             ))
      ORDER BY link_map.id`,
  );
  migration104FailureIds(
    db,
    "session attachments must map one-to-one to canonical versions",
    `SELECT attachment.session_id || ':' || attachment.artifact_series_id AS id
       FROM session_instruction_artifacts attachment
      WHERE (SELECT COUNT(*)
               FROM artifact_series legacy_series
               JOIN artifact_versions legacy_version
                 ON legacy_version.id = attachment.artifact_version_id
                AND legacy_version.series_id = legacy_series.id
               JOIN artifact canonical_artifact
                 ON canonical_artifact.identity_key = legacy_series.series_key
               JOIN artifacts legacy_blob ON legacy_blob.id = legacy_version.artifact_id
               JOIN artifact_blob canonical_blob
                 ON canonical_blob.algorithm = legacy_blob.algorithm
                AND canonical_blob.content_hash = legacy_blob.content_hash
               JOIN artifact_version canonical_version
                 ON canonical_version.artifact_id = canonical_artifact.id
                AND canonical_version.version_no = legacy_version.version_no
                AND canonical_version.content_hash = legacy_version.content_hash
                AND canonical_version.blob_id = canonical_blob.id
                AND canonical_version.content_hash = canonical_blob.content_hash
              WHERE legacy_series.id = attachment.artifact_series_id) != 1
      ORDER BY id`,
  );
  migration104FailureIds(
    db,
    "drafts must map one-to-one to canonical versions",
    `SELECT draft.id
       FROM artifact_drafts draft
      WHERE (SELECT COUNT(*)
               FROM artifact_series legacy_series
               JOIN artifact_versions legacy_version
                 ON legacy_version.id = draft.base_version_id
                AND legacy_version.series_id = legacy_series.id
               JOIN artifact canonical_artifact
                 ON canonical_artifact.identity_key = legacy_series.series_key
               JOIN artifacts legacy_blob ON legacy_blob.id = legacy_version.artifact_id
               JOIN artifact_blob canonical_blob
                 ON canonical_blob.algorithm = legacy_blob.algorithm
                AND canonical_blob.content_hash = legacy_blob.content_hash
               JOIN artifact_version canonical_version
                 ON canonical_version.artifact_id = canonical_artifact.id
                AND canonical_version.version_no = legacy_version.version_no
                AND canonical_version.content_hash = legacy_version.content_hash
                AND canonical_version.blob_id = canonical_blob.id
                AND canonical_version.content_hash = canonical_blob.content_hash
              WHERE legacy_series.id = draft.series_id) != 1
      ORDER BY draft.id`,
  );
  migration104FailureIds(
    db,
    "canonical session attachment keys collide",
    `SELECT attachment.session_id || ':' || canonical_artifact.id AS id
       FROM session_instruction_artifacts attachment
       JOIN artifact_series legacy_series ON legacy_series.id = attachment.artifact_series_id
       JOIN artifact canonical_artifact
         ON canonical_artifact.identity_key = legacy_series.series_key
      GROUP BY attachment.session_id, canonical_artifact.id
     HAVING COUNT(*) > 1
      ORDER BY id`,
  );
  migration104FailureIds(
    db,
    "canonical draft artifact keys collide",
    `SELECT canonical_artifact.id AS id
       FROM artifact_drafts draft
       JOIN artifact_series legacy_series ON legacy_series.id = draft.series_id
       JOIN artifact canonical_artifact
         ON canonical_artifact.identity_key = legacy_series.series_key
      GROUP BY canonical_artifact.id
     HAVING COUNT(*) > 1
      ORDER BY id`,
  );
}

function explicitMigration104Indexes(db: Db): string[] {
  return (db.prepare(
    `SELECT name, sql
       FROM sqlite_master
      WHERE type = 'index'
        AND tbl_name IN ('artifact_aliases', 'artifact_links',
                         'session_instruction_artifacts', 'artifact_drafts')
        AND sql IS NOT NULL
      ORDER BY name`,
  ).all() as Array<{ name: string; sql: string }>)
    .filter((row) => !ARTIFACT_CANONICAL_TARGET_INDEXES.has(row.name))
    .map((row) => row.sql);
}

function createMigration104Indexes(db: Db, preservedIndexes: readonly string[]): void {
  db.exec(`
    CREATE UNIQUE INDEX idx_artifact_aliases_scheme_ref
      ON artifact_aliases(scheme, normalized_ref);
    CREATE INDEX idx_artifact_aliases_artifact
      ON artifact_aliases(artifact_id) WHERE artifact_id IS NOT NULL;
    CREATE INDEX idx_artifact_aliases_blob
      ON artifact_aliases(blob_id) WHERE blob_id IS NOT NULL;
    CREATE INDEX idx_artifact_aliases_status
      ON artifact_aliases(resolution_status, scheme);
    CREATE INDEX idx_artifact_links_artifact
      ON artifact_links(artifact_id, link_type) WHERE artifact_id IS NOT NULL;
    CREATE INDEX idx_artifact_links_blob
      ON artifact_links(blob_id, link_type);
    CREATE INDEX idx_artifact_links_entity
      ON artifact_links(entity_type, entity_id);
    CREATE INDEX idx_artifact_links_fallback_version
      ON artifact_links(fallback_version_id) WHERE fallback_version_id IS NOT NULL;
    CREATE INDEX idx_artifact_links_kind ON artifact_links(link_kind);
    CREATE INDEX idx_artifact_links_legacy_blob
      ON artifact_links(legacy_blob_id) WHERE legacy_blob_id IS NOT NULL;
    CREATE INDEX idx_artifact_links_provider
      ON artifact_links(provider_id) WHERE provider_id IS NOT NULL;
    CREATE INDEX idx_artifact_links_repo
      ON artifact_links(repo_id) WHERE repo_id IS NOT NULL;
    CREATE INDEX idx_artifact_links_role
      ON artifact_links(role) WHERE role IS NOT NULL;
    CREATE INDEX idx_artifact_links_series
      ON artifact_links(series_id) WHERE series_id IS NOT NULL;
    CREATE INDEX idx_artifact_links_target
      ON artifact_links(target_type, target_id);
    CREATE INDEX idx_artifact_drafts_base
      ON artifact_drafts(base_version_id) WHERE base_version_id IS NOT NULL;
    CREATE UNIQUE INDEX idx_artifact_drafts_legacy_series
      ON artifact_drafts(series_id) WHERE series_id IS NOT NULL;
    CREATE INDEX idx_artifact_drafts_version ON artifact_drafts(version_id);
    CREATE INDEX idx_session_instruction_artifacts_session
      ON session_instruction_artifacts(session_id, position);
    CREATE INDEX idx_session_instruction_artifacts_version
      ON session_instruction_artifacts(version_id);
    CREATE UNIQUE INDEX idx_session_instruction_artifacts_legacy_series
      ON session_instruction_artifacts(session_id, artifact_series_id)
      WHERE artifact_series_id IS NOT NULL;
    CREATE INDEX idx_session_instruction_artifacts_legacy_version
      ON session_instruction_artifacts(artifact_version_id)
      WHERE artifact_version_id IS NOT NULL;
  `);
  for (const indexSql of preservedIndexes) db.exec(indexSql);
}

function rebuildArtifactCanonicalTargets(db: Db): void {
  if (!needsArtifactCanonicalTargetMigration(db)) return;
  if (db.inTransaction) {
    throw new Error("migration 104 precondition: rebuild cannot start inside a transaction");
  }

  const previousForeignKeys = db.pragma("foreign_keys", { simple: true }) as number;
  try {
    if (!previousForeignKeys) db.pragma("foreign_keys = ON");
    const initialViolations = db.pragma("foreign_key_check") as unknown[];
    if (initialViolations.length > 0) {
      throw new Error(
        `migration 104 preflight: database has ${initialViolations.length} ` +
        "foreign key violation(s)",
      );
    }
    assertMigration104Preconditions(db);
    const preservedIndexes = explicitMigration104Indexes(db);

    db.pragma("foreign_keys = OFF");
    db.transaction(() => {
      db.exec(`
        CREATE TABLE artifact_aliases_v104 (
          id                TEXT PRIMARY KEY,
          artifact_id       TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
          blob_id           TEXT REFERENCES artifact_blob(id) ON DELETE RESTRICT,
          scheme            TEXT NOT NULL,
          alias             TEXT NOT NULL,
          normalized_ref    TEXT NOT NULL,
          locator_json      TEXT NOT NULL DEFAULT '{}',
          resolution_status TEXT NOT NULL DEFAULT 'resolved'
            CHECK(resolution_status IN ('resolved','unresolved','ambiguous','unsupported')),
          source            TEXT NOT NULL DEFAULT 'artifact_registry',
          created_at        INTEGER NOT NULL,
          updated_at        INTEGER NOT NULL,
          CHECK (
            (resolution_status = 'resolved' AND blob_id IS NOT NULL) OR
            (resolution_status != 'resolved' AND blob_id IS NULL)
          )
        );
        CREATE TABLE artifact_links_v104 (
          id                  TEXT PRIMARY KEY,
          artifact_id         TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
          blob_id             TEXT NOT NULL REFERENCES artifact_blob(id) ON DELETE RESTRICT,
          entity_type         TEXT NOT NULL,
          entity_id           TEXT NOT NULL,
          link_type           TEXT NOT NULL DEFAULT 'references',
          role                TEXT,
          repo_id             TEXT,
          provider_id         TEXT,
          source              TEXT NOT NULL DEFAULT 'artifact_registry',
          metadata_json       TEXT NOT NULL DEFAULT '{}',
          created_at          INTEGER NOT NULL,
          updated_at          INTEGER NOT NULL,
          link_kind           TEXT NOT NULL DEFAULT 'pinned'
            CHECK(link_kind IN ('pinned','living')),
          series_id           TEXT,
          series_ref          TEXT,
          target_type         TEXT NOT NULL
            CHECK(target_type IN ('artifact','artifact_version','artifact_blob')),
          target_id           TEXT NOT NULL,
          fallback_version_id TEXT REFERENCES artifact_version(id) ON DELETE RESTRICT,
          legacy_blob_id      TEXT,
          CHECK (
            (link_kind = 'living' AND target_type = 'artifact') OR
            (link_kind = 'pinned' AND target_type IN ('artifact_version','artifact_blob'))
          )
        );
        CREATE TABLE session_instruction_artifacts_v104 (
          session_id          TEXT NOT NULL,
          artifact_id         TEXT NOT NULL REFERENCES artifact(id) ON DELETE CASCADE,
          version_id          TEXT NOT NULL REFERENCES artifact_version(id) ON DELETE RESTRICT,
          artifact_series_id  TEXT REFERENCES artifact_series(id) ON DELETE SET NULL,
          artifact_version_id TEXT REFERENCES artifact_versions(id) ON DELETE SET NULL,
          legacy_preset_id    TEXT,
          position            INTEGER NOT NULL DEFAULT 0,
          created_at          INTEGER NOT NULL,
          updated_at          INTEGER NOT NULL,
          PRIMARY KEY (session_id, artifact_id)
        );
        CREATE TABLE artifact_drafts_v104 (
          id              TEXT PRIMARY KEY,
          artifact_id     TEXT NOT NULL REFERENCES artifact(id) ON DELETE CASCADE,
          version_id      TEXT NOT NULL REFERENCES artifact_version(id) ON DELETE RESTRICT,
          series_id       TEXT REFERENCES artifact_series(id) ON DELETE SET NULL,
          base_version_id TEXT REFERENCES artifact_versions(id) ON DELETE SET NULL,
          content         TEXT NOT NULL,
          media_type      TEXT,
          label           TEXT,
          note            TEXT,
          metadata_json   TEXT NOT NULL DEFAULT '{}',
          created_at      INTEGER NOT NULL,
          updated_at      INTEGER NOT NULL,
          UNIQUE(artifact_id)
        );
      `);

      db.exec(`
        INSERT INTO artifact_aliases_v104 (
          id, artifact_id, blob_id, scheme, alias, normalized_ref, locator_json,
          resolution_status, source, created_at, updated_at
        )
        SELECT alias.id, alias.artifact_id,
               CASE WHEN alias.resolution_status = 'resolved'
                 THEN COALESCE(canonical_blob.id, recovered_blob.id)
               END,
               alias.scheme, alias.alias, alias.normalized_ref, alias.locator_json,
               alias.resolution_status, alias.source, alias.created_at, alias.updated_at
          FROM artifact_aliases alias
          LEFT JOIN artifacts legacy_blob ON legacy_blob.id = alias.artifact_id
          LEFT JOIN artifact_blob canonical_blob
            ON canonical_blob.algorithm = legacy_blob.algorithm
           AND canonical_blob.content_hash = legacy_blob.content_hash
          LEFT JOIN artifacts recovered_artifact
            ON recovered_artifact.uri = legacy_blob.uri
           AND alias.resolution_status = 'resolved'
           AND alias.scheme = 'repo'
           AND alias.normalized_ref = legacy_blob.uri
           AND legacy_blob.algorithm = 'ref-sha256'
           AND legacy_blob.id = 'artifact:ref:' || legacy_blob.content_hash
           AND recovered_artifact.algorithm = 'sha256'
           AND recovered_artifact.id =
             'artifact:sha256:' || recovered_artifact.content_hash
           AND canonical_blob.id IS NULL
          LEFT JOIN artifact_blob recovered_blob
            ON recovered_blob.algorithm = recovered_artifact.algorithm
           AND recovered_blob.content_hash = recovered_artifact.content_hash
           AND recovered_blob.id =
             'artifact-blob:' || recovered_artifact.content_hash;

        INSERT INTO artifact_links_v104 (
          id, artifact_id, blob_id, entity_type, entity_id, link_type, role,
          repo_id, provider_id, source, metadata_json, created_at, updated_at,
          link_kind, series_id, series_ref, target_type, target_id,
          fallback_version_id, legacy_blob_id
        )
        SELECT link.id, link.artifact_id, canonical_blob.id, link.entity_type,
               link.entity_id, link.link_type, link.role, link.repo_id,
               link.provider_id, link.source, link.metadata_json, link.created_at,
               link.updated_at, link.link_kind, link.series_id, link.series_ref,
               CASE
                 WHEN link.link_kind = 'living' THEN 'artifact'
                 WHEN link.target_type = 'artifact_version' THEN 'artifact_version'
                 ELSE 'artifact_blob'
               END,
               CASE
                 WHEN link.link_kind = 'living' THEN COALESCE(canonical_artifact.id, link.target_id)
                 WHEN link.target_type = 'artifact_version' THEN link.target_id
                 ELSE canonical_blob.id
               END,
               link.fallback_version_id, COALESCE(link.legacy_blob_id, canonical_blob.id)
          FROM artifact_links link
          JOIN artifacts legacy_blob ON legacy_blob.id = link.artifact_id
          JOIN artifact_blob canonical_blob
            ON canonical_blob.algorithm = legacy_blob.algorithm
           AND canonical_blob.content_hash = legacy_blob.content_hash
          LEFT JOIN artifact_series legacy_series ON legacy_series.id = link.series_id
          LEFT JOIN artifact canonical_artifact
            ON canonical_artifact.identity_key = legacy_series.series_key;

        INSERT INTO session_instruction_artifacts_v104 (
          session_id, artifact_id, version_id, artifact_series_id,
          artifact_version_id, legacy_preset_id, position, created_at, updated_at
        )
        SELECT attachment.session_id, canonical_artifact.id, canonical_version.id,
               attachment.artifact_series_id, attachment.artifact_version_id,
               attachment.legacy_preset_id, attachment.position,
               attachment.created_at, attachment.updated_at
          FROM session_instruction_artifacts attachment
          JOIN artifact_series legacy_series
            ON legacy_series.id = attachment.artifact_series_id
          JOIN artifact_versions legacy_version
            ON legacy_version.id = attachment.artifact_version_id
           AND legacy_version.series_id = legacy_series.id
          JOIN artifact canonical_artifact
            ON canonical_artifact.identity_key = legacy_series.series_key
          JOIN artifacts legacy_blob ON legacy_blob.id = legacy_version.artifact_id
          JOIN artifact_blob canonical_blob
            ON canonical_blob.algorithm = legacy_blob.algorithm
           AND canonical_blob.content_hash = legacy_blob.content_hash
          JOIN artifact_version canonical_version
            ON canonical_version.artifact_id = canonical_artifact.id
           AND canonical_version.version_no = legacy_version.version_no
           AND canonical_version.content_hash = legacy_version.content_hash
           AND canonical_version.blob_id = canonical_blob.id
           AND canonical_version.content_hash = canonical_blob.content_hash;

        INSERT INTO artifact_drafts_v104 (
          id, artifact_id, version_id, series_id, base_version_id, content,
          media_type, label, note, metadata_json, created_at, updated_at
        )
        SELECT draft.id, canonical_artifact.id, canonical_version.id,
               draft.series_id, draft.base_version_id, draft.content,
               draft.media_type, draft.label, draft.note, draft.metadata_json,
               draft.created_at, draft.updated_at
          FROM artifact_drafts draft
          JOIN artifact_series legacy_series ON legacy_series.id = draft.series_id
          JOIN artifact_versions legacy_version
            ON legacy_version.id = draft.base_version_id
           AND legacy_version.series_id = legacy_series.id
          JOIN artifact canonical_artifact
            ON canonical_artifact.identity_key = legacy_series.series_key
          JOIN artifacts legacy_blob ON legacy_blob.id = legacy_version.artifact_id
          JOIN artifact_blob canonical_blob
            ON canonical_blob.algorithm = legacy_blob.algorithm
           AND canonical_blob.content_hash = legacy_blob.content_hash
          JOIN artifact_version canonical_version
            ON canonical_version.artifact_id = canonical_artifact.id
           AND canonical_version.version_no = legacy_version.version_no
           AND canonical_version.content_hash = legacy_version.content_hash
           AND canonical_version.blob_id = canonical_blob.id
           AND canonical_version.content_hash = canonical_blob.content_hash;
      `);

      for (const table of ARTIFACT_CANONICAL_TARGET_TABLES) db.exec(`DROP TABLE ${table}`);
      for (const table of ARTIFACT_CANONICAL_TARGET_TABLES) {
        db.exec(`ALTER TABLE ${table}_v104 RENAME TO ${table}`);
      }
      createMigration104Indexes(db, preservedIndexes);
      verifyArtifactCanonicalTargetSchema(db);
      const violations = db.pragma("foreign_key_check") as unknown[];
      if (violations.length > 0) {
        throw new Error(
          `migration 104 verification: ${violations.length} foreign key violation(s)`,
        );
      }
      const integrity = db.pragma("integrity_check") as Array<{ integrity_check: string }>;
      if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
        throw new Error("migration 104 verification: integrity_check failed");
      }
    }).immediate();
  } finally {
    db.pragma(`foreign_keys = ${previousForeignKeys ? "ON" : "OFF"}`);
  }

  const violations = db.pragma("foreign_key_check") as unknown[];
  if (violations.length > 0) {
    throw new Error(
      `migration 104 verification: ${violations.length} foreign key violation(s) after restore`,
    );
  }
  const integrity = db.pragma("integrity_check") as Array<{ integrity_check: string }>;
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
    throw new Error("migration 104 verification: integrity_check failed after restore");
  }
}

function verifyArtifactCanonicalTargetSchema(db: Db): void {
  const requiredColumns: ReadonlyArray<readonly [string, string, number]> = [
    ["artifact_aliases", "blob_id", 0],
    ["artifact_links", "artifact_id", 0],
    ["artifact_links", "blob_id", 1],
    ["artifact_links", "target_type", 1],
    ["artifact_links", "target_id", 1],
    ["session_instruction_artifacts", "artifact_id", 1],
    ["session_instruction_artifacts", "version_id", 1],
    ["session_instruction_artifacts", "artifact_series_id", 0],
    ["session_instruction_artifacts", "artifact_version_id", 0],
    ["artifact_drafts", "artifact_id", 1],
    ["artifact_drafts", "version_id", 1],
    ["artifact_drafts", "series_id", 0],
    ["artifact_drafts", "base_version_id", 0],
  ];
  for (const [table, name, notnull] of requiredColumns) {
    const column = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
      notnull: number;
    }>).find((candidate) => candidate.name === name);
    if (!column || column.notnull !== notnull) {
      throw new Error(
        `migration 104 verification: ${table}.${name} must have notnull=${notnull}`,
      );
    }
  }
  const requireForeignKey = (
    table: string,
    from: string,
    target: string,
    onDelete: string,
  ): void => {
    const matches = (db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{
      from: string;
      table: string;
      on_delete: string;
    }>).some((foreignKey) =>
      foreignKey.from === from &&
      foreignKey.table === target &&
      foreignKey.on_delete.toUpperCase() === onDelete
    );
    if (!matches) {
      throw new Error(
        `migration 104 verification: ${table}.${from} must reference ${target} ON DELETE ${onDelete}`,
      );
    }
  };
  requireForeignKey("artifact_aliases", "artifact_id", "artifacts", "SET NULL");
  requireForeignKey("artifact_aliases", "blob_id", "artifact_blob", "RESTRICT");
  requireForeignKey("artifact_links", "artifact_id", "artifacts", "SET NULL");
  requireForeignKey("artifact_links", "blob_id", "artifact_blob", "RESTRICT");
  requireForeignKey(
    "artifact_links",
    "fallback_version_id",
    "artifact_version",
    "RESTRICT",
  );
  requireForeignKey("session_instruction_artifacts", "artifact_id", "artifact", "CASCADE");
  requireForeignKey(
    "session_instruction_artifacts",
    "version_id",
    "artifact_version",
    "RESTRICT",
  );
  requireForeignKey(
    "session_instruction_artifacts",
    "artifact_series_id",
    "artifact_series",
    "SET NULL",
  );
  requireForeignKey(
    "session_instruction_artifacts",
    "artifact_version_id",
    "artifact_versions",
    "SET NULL",
  );
  requireForeignKey("artifact_drafts", "artifact_id", "artifact", "CASCADE");
  requireForeignKey("artifact_drafts", "version_id", "artifact_version", "RESTRICT");
  requireForeignKey("artifact_drafts", "series_id", "artifact_series", "SET NULL");
  requireForeignKey("artifact_drafts", "base_version_id", "artifact_versions", "SET NULL");

  const tableSql = (table: string): string => (
    db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as
      | { sql: string }
      | undefined
  )?.sql ?? "";
  if (!/resolution_status\s*=\s*'resolved'\s+AND\s+blob_id\s+IS\s+NOT\s+NULL/i.test(
    tableSql("artifact_aliases"),
  )) {
    throw new Error("migration 104 verification: artifact_aliases resolution/blob CHECK is missing");
  }
  const linkSql = tableSql("artifact_links");
  if (
    !/target_type\s+IN\s*\(\s*'artifact'\s*,\s*'artifact_version'\s*,\s*'artifact_blob'/i.test(
      linkSql,
    ) ||
    !/link_kind\s*=\s*'living'\s+AND\s+target_type\s*=\s*'artifact'/i.test(linkSql)
  ) {
    throw new Error("migration 104 verification: artifact_links target CHECKs are missing");
  }
  const sessionPk = (db.prepare("PRAGMA table_info(session_instruction_artifacts)").all() as Array<{
    name: string;
    pk: number;
  }>).filter((column) => column.pk > 0).sort((left, right) => left.pk - right.pk);
  if (sessionPk.map((column) => column.name).join(",") !== "session_id,artifact_id") {
    throw new Error("migration 104 verification: session attachment canonical primary key is missing");
  }
  const draftArtifactUnique = (db.prepare("PRAGMA index_list(artifact_drafts)").all() as Array<{
    name: string;
    unique: number;
  }>).some((index) => {
    if (!index.unique) return false;
    const columns = db.prepare(`PRAGMA index_info(${index.name})`).all() as Array<{ name: string }>;
    return columns.length === 1 && columns[0]?.name === "artifact_id";
  });
  if (!draftArtifactUnique) {
    throw new Error("migration 104 verification: artifact_drafts canonical uniqueness is missing");
  }
  for (const index of ARTIFACT_CANONICAL_TARGET_INDEXES) {
    if (!indexExists(db, index)) {
      throw new Error(`migration 104 verification: missing index ${index}`);
    }
  }
  migration104FailureIds(
    db,
    "canonical link targets are invalid after rebuild",
    `SELECT link.id
       FROM artifact_links link
      WHERE (link.target_type = 'artifact' AND NOT EXISTS (
               SELECT 1 FROM artifact WHERE artifact.id = link.target_id
             ))
         OR (link.target_type = 'artifact_version' AND NOT EXISTS (
               SELECT 1 FROM artifact_version version
                WHERE version.id = link.target_id
                  AND version.blob_id = link.blob_id
                  AND version.content_hash = (
                    SELECT content_hash FROM artifact_blob WHERE id = link.blob_id
                  )
             ))
         OR (link.target_type = 'artifact_blob' AND link.target_id != link.blob_id)
         OR (link.fallback_version_id IS NOT NULL AND NOT EXISTS (
               SELECT 1 FROM artifact_version version
                WHERE version.id = link.fallback_version_id
                  AND version.blob_id = link.blob_id
                  AND version.content_hash = (
                    SELECT content_hash FROM artifact_blob WHERE id = link.blob_id
                  )
             ))
      ORDER BY link.id`,
  );
  migration104FailureIds(
    db,
    "canonical session version ownership is invalid after rebuild",
    `SELECT attachment.session_id || ':' || attachment.artifact_id AS id
       FROM session_instruction_artifacts attachment
      WHERE NOT EXISTS (
        SELECT 1 FROM artifact_version version
         WHERE version.id = attachment.version_id
           AND version.artifact_id = attachment.artifact_id
      )
      ORDER BY id`,
  );
  migration104FailureIds(
    db,
    "canonical draft version ownership is invalid after rebuild",
    `SELECT draft.id
       FROM artifact_drafts draft
      WHERE NOT EXISTS (
        SELECT 1 FROM artifact_version version
         WHERE version.id = draft.version_id
           AND version.artifact_id = draft.artifact_id
      )
      ORDER BY draft.id`,
  );
}

const SPACE_EXPORT_CANONICAL_COLUMNS = [
  ["last_export_artifact_id", "last_export_blob_id"],
  ["pre_export_snapshot_artifact_id", "pre_export_snapshot_blob_id"],
] as const;

interface SpaceExportSchemaInventory {
  tableSql: string;
  columns: Array<{
    cid: number;
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
  }>;
  indexes: Array<{ name: string; sql: string | null }>;
  indexList: Array<{
    name: string;
    unique: number;
    origin: string;
    partial: number;
    columns: string[];
  }>;
  triggers: Array<{ name: string; sql: string | null }>;
}

function spaceExportSchemaInventory(db: Db): SpaceExportSchemaInventory {
  const table = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'space_exports'",
  ).get() as { sql: string | null } | undefined;
  if (!table?.sql) {
    throw new Error("migration 105 precondition: required table space_exports is missing");
  }
  const indexList = (db.pragma("index_list(space_exports)") as Array<{
    name: string;
    unique: number;
    origin: string;
    partial: number;
  }>).map((index) => ({
    ...index,
    columns: (db.pragma(`index_info(${JSON.stringify(index.name)})`) as Array<{ name: string }>)
      .map((column) => column.name),
  }));
  return {
    tableSql: table.sql,
    columns: db.pragma("table_info(space_exports)") as SpaceExportSchemaInventory["columns"],
    indexes: db.prepare(
      `SELECT name, sql FROM sqlite_master
        WHERE type = 'index' AND tbl_name = 'space_exports'
        ORDER BY name`,
    ).all() as SpaceExportSchemaInventory["indexes"],
    indexList: indexList.sort((left, right) => left.name.localeCompare(right.name)),
    triggers: db.prepare(
      `SELECT name, sql FROM sqlite_master
        WHERE type = 'trigger' AND tbl_name = 'space_exports'
        ORDER BY name`,
    ).all() as SpaceExportSchemaInventory["triggers"],
  };
}

function requireSpaceExportForeignKey(
  db: Db,
  column: string,
  target: string,
  onDelete: string,
  phase: "precondition" | "verification",
): void {
  const matches = (db.pragma("foreign_key_list(space_exports)") as Array<{
    from: string;
    table: string;
    to: string;
    on_delete: string;
  }>).filter((foreignKey) =>
    foreignKey.from === column &&
    foreignKey.table === target &&
    foreignKey.to === "id" &&
    foreignKey.on_delete.toUpperCase() === onDelete
  );
  if (matches.length !== 1) {
    throw new Error(
      `migration 105 ${phase}: space_exports.${column} must reference ` +
      `${target}(id) ON DELETE ${onDelete}`,
    );
  }
}

function verifySpaceExportCanonicalColumn(db: Db, column: string): void {
  const matches = (db.pragma("table_info(space_exports)") as Array<{
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
  }>).filter((candidate) => candidate.name === column);
  if (
    matches.length !== 1 ||
    matches[0].type.toUpperCase() !== "TEXT" ||
    matches[0].notnull !== 0 ||
    matches[0].dflt_value !== null ||
    matches[0].pk !== 0
  ) {
    throw new Error(
      `migration 105 verification: space_exports.${column} must be nullable TEXT with no default`,
    );
  }
  requireSpaceExportForeignKey(db, column, "artifact_blob", "SET NULL", "verification");
}

function assertSpaceExportMappingPreconditions(db: Db): void {
  for (const table of ["artifacts", "artifact_blob"]) {
    if (!tableExists(db, table)) {
      throw new Error(`migration 105 precondition: required mapping table ${table} is missing`);
    }
  }
  const violations = db.pragma("foreign_key_check") as unknown[];
  if (violations.length > 0) {
    throw new Error(
      `migration 105 preflight: database has ${violations.length} foreign key violation(s)`,
    );
  }

  for (const [legacyColumn, canonicalColumn] of SPACE_EXPORT_CANONICAL_COLUMNS) {
    const rows = db.prepare(
      `SELECT export.id,
              export.${legacyColumn} AS legacy_id,
              export.${canonicalColumn} AS canonical_id,
              (SELECT COUNT(*) FROM artifacts legacy
                WHERE legacy.id = export.${legacyColumn}) AS legacy_count,
              (SELECT COUNT(*)
                 FROM artifacts legacy
                 JOIN artifact_blob canonical
                   ON canonical.algorithm = legacy.algorithm
                  AND canonical.content_hash = legacy.content_hash
                WHERE legacy.id = export.${legacyColumn}) AS mapping_count,
              (SELECT canonical.id
                 FROM artifacts legacy
                 JOIN artifact_blob canonical
                   ON canonical.algorithm = legacy.algorithm
                  AND canonical.content_hash = legacy.content_hash
                WHERE legacy.id = export.${legacyColumn}
                LIMIT 1) AS mapped_id
         FROM space_exports export
        WHERE export.${legacyColumn} IS NOT NULL
        ORDER BY export.id`,
    ).all() as Array<{
      id: string;
      legacy_id: string;
      canonical_id: string | null;
      legacy_count: number;
      mapping_count: number;
      mapped_id: string | null;
    }>;
    for (const row of rows) {
      if (row.legacy_count !== 1 || row.mapping_count !== 1 || !row.mapped_id) {
        throw new Error(
          `migration 105 preflight: ${legacyColumn} must map to exactly one canonical blob; ` +
          `offending id: ${row.id}`,
        );
      }
      if (row.canonical_id !== null && row.canonical_id !== row.mapped_id) {
        throw new Error(
          `migration 105 preflight: ${canonicalColumn} contradicts legacy artifact bytes; ` +
          `offending id: ${row.id}`,
        );
      }
    }
  }
}

function verifySpaceExportCanonicalData(db: Db): void {
  for (const [legacyColumn, canonicalColumn] of SPACE_EXPORT_CANONICAL_COLUMNS) {
    const invalid = db.prepare(
      `SELECT export.id
         FROM space_exports export
        WHERE (export.${canonicalColumn} IS NOT NULL AND NOT EXISTS (
                 SELECT 1 FROM artifact_blob canonical
                  WHERE canonical.id = export.${canonicalColumn}
               ))
           OR (export.${legacyColumn} IS NOT NULL AND NOT EXISTS (
                 SELECT 1
                   FROM artifacts legacy
                   JOIN artifact_blob canonical
                     ON canonical.algorithm = legacy.algorithm
                    AND canonical.content_hash = legacy.content_hash
                  WHERE legacy.id = export.${legacyColumn}
                    AND canonical.id = export.${canonicalColumn}
               ))
        ORDER BY export.id`,
    ).all() as Array<{ id: string }>;
    if (invalid.length > 0) {
      throw new Error(
        `migration 105 verification: ${canonicalColumn} has missing or cross-byte targets; ` +
        `offending ids: ${invalid.map((row) => row.id).join(", ")}`,
      );
    }
  }
}

function migrateSpaceExportCanonicalArtifacts(db: Db): void {
  if (!db.inTransaction) {
    throw new Error("migration 105 precondition: migration must run inside its schema transaction");
  }
  const before = spaceExportSchemaInventory(db);
  const names = new Set(before.columns.map((column) => column.name));
  for (const [legacyColumn] of SPACE_EXPORT_CANONICAL_COLUMNS) {
    if (!names.has(legacyColumn)) {
      throw new Error(
        `migration 105 precondition: required column space_exports.${legacyColumn} is missing`,
      );
    }
    requireSpaceExportForeignKey(db, legacyColumn, "artifacts", "SET NULL", "precondition");
  }

  const canonicalStates = SPACE_EXPORT_CANONICAL_COLUMNS.map(([, column]) => names.has(column));
  if (canonicalStates.some(Boolean) && !canonicalStates.every(Boolean)) {
    throw new Error("migration 105 precondition: canonical columns are only partially applied");
  }
  if (canonicalStates.every(Boolean)) {
    for (const [, column] of SPACE_EXPORT_CANONICAL_COLUMNS) {
      verifySpaceExportCanonicalColumn(db, column);
    }
  } else {
    db.exec(
      "ALTER TABLE space_exports ADD COLUMN last_export_blob_id " +
      "TEXT REFERENCES artifact_blob(id) ON DELETE SET NULL",
    );
    db.exec(
      "ALTER TABLE space_exports ADD COLUMN pre_export_snapshot_blob_id " +
      "TEXT REFERENCES artifact_blob(id) ON DELETE SET NULL",
    );
  }

  assertSpaceExportMappingPreconditions(db);
  for (const [legacyColumn, canonicalColumn] of SPACE_EXPORT_CANONICAL_COLUMNS) {
    db.exec(
      `UPDATE space_exports
          SET ${canonicalColumn} = (
            SELECT canonical.id
              FROM artifacts legacy
              JOIN artifact_blob canonical
                ON canonical.algorithm = legacy.algorithm
               AND canonical.content_hash = legacy.content_hash
             WHERE legacy.id = space_exports.${legacyColumn}
          )
        WHERE ${legacyColumn} IS NOT NULL
          AND ${canonicalColumn} IS NULL`,
    );
    verifySpaceExportCanonicalColumn(db, canonicalColumn);
  }
  verifySpaceExportCanonicalData(db);

  const after = spaceExportSchemaInventory(db);
  const originalColumns = after.columns.filter((column) => names.has(column.name));
  if (JSON.stringify(originalColumns) !== JSON.stringify(before.columns)) {
    throw new Error("migration 105 verification: existing space_exports columns changed");
  }
  if (
    JSON.stringify(after.indexes) !== JSON.stringify(before.indexes) ||
    JSON.stringify(after.indexList) !== JSON.stringify(before.indexList) ||
    JSON.stringify(after.triggers) !== JSON.stringify(before.triggers)
  ) {
    throw new Error("migration 105 verification: space_exports index or trigger inventory changed");
  }
  const violations = db.pragma("foreign_key_check") as unknown[];
  if (violations.length > 0) {
    throw new Error(
      `migration 105 verification: ${violations.length} foreign key violation(s)`,
    );
  }
  const integrity = db.pragma("integrity_check") as Array<{ integrity_check: string }>;
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
    throw new Error("migration 105 verification: integrity_check failed");
  }
}

function ensureBriefingIngestRequestColumn(db: Db): void {
  const columns = db.prepare("PRAGMA table_info(feedback_publications)").all() as
    Array<{ name: string }>;
  if (!columns.some((column) => column.name === "ingest_request_id")) {
    db.exec(
      `ALTER TABLE feedback_publications ADD COLUMN ingest_request_id TEXT
        REFERENCES feedback_ingest_requests(id) ON DELETE RESTRICT`,
    );
  }
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_feedback_publications_ingest_request
      ON feedback_publications(ingest_request_id)
      WHERE ingest_request_id IS NOT NULL`,
  );
}

function ensureFeedbackCollectionExpiryColumn(db: Db): void {
  const columns = db.prepare("PRAGMA table_info(feedback_collections)").all() as
    Array<{ name: string }>;
  if (!columns.some((column) => column.name === "expires_at")) {
    db.exec("ALTER TABLE feedback_collections ADD COLUMN expires_at INTEGER");
  }
  db.exec(
    "UPDATE feedback_collections SET expires_at = NULL " +
    "WHERE kind = 'bounded_ask' AND expires_at IS NOT NULL",
  );

  const askColumns = db.prepare("PRAGMA table_info(feedback_ask_sessions)").all() as
    Array<{ name: string; notnull: number }>;
  if (askColumns.find((column) => column.name === "expires_at")?.notnull === 1) {
    db.exec(`
      DROP INDEX IF EXISTS idx_feedback_ask_sessions_requester;
      DROP INDEX IF EXISTS idx_feedback_ask_sessions_expiry;
      ALTER TABLE feedback_ask_sessions RENAME TO feedback_ask_sessions_v131;
      CREATE TABLE feedback_ask_sessions (
        collection_id             TEXT PRIMARY KEY
                                  REFERENCES feedback_collections(id) ON DELETE RESTRICT,
        requester_user_id         TEXT NOT NULL
                                  REFERENCES users(id) ON DELETE RESTRICT,
        requester_session_id      TEXT NOT NULL
                                  REFERENCES sessions(id) ON DELETE RESTRICT,
        request_key               TEXT NOT NULL CHECK(trim(request_key) != ''),
        request_digest            TEXT NOT NULL CHECK(trim(request_digest) != ''),
        responder_user_ids_json   TEXT NOT NULL
                                  CHECK(json_valid(responder_user_ids_json)
                                    AND json_type(responder_user_ids_json) = 'array'),
        expires_at                INTEGER,
        retention_expires_at      INTEGER,
        created_at                INTEGER NOT NULL,
        UNIQUE(requester_user_id, requester_session_id, request_key),
        CHECK(expires_at IS NULL OR expires_at > created_at),
        CHECK(expires_at IS NULL
          OR retention_expires_at IS NULL
          OR retention_expires_at >= expires_at)
      );
      INSERT INTO feedback_ask_sessions (
        collection_id, requester_user_id, requester_session_id, request_key, request_digest,
        responder_user_ids_json, expires_at, retention_expires_at, created_at
      )
      SELECT collection_id, requester_user_id, requester_session_id, request_key, request_digest,
             responder_user_ids_json, expires_at, retention_expires_at, created_at
        FROM feedback_ask_sessions_v131;
      DROP TABLE feedback_ask_sessions_v131;
      CREATE INDEX idx_feedback_ask_sessions_requester
        ON feedback_ask_sessions(requester_user_id, requester_session_id, created_at DESC);
      CREATE INDEX idx_feedback_ask_sessions_expiry
        ON feedback_ask_sessions(expires_at);
    `);
  }
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_feedback_collections_expiry
       ON feedback_collections(expires_at)`,
  );
}

function tableColumnNames(db: Db, table: string): Set<string> {
  const allowed = new Set([
    "artifact",
    "artifact_blob",
    "artifact_aliases",
    "artifact_drafts",
    "artifacts",
    "artifact_links",
    "artifact_versions",
    "artifact_version",
    "auth_requests",
    "console_sessions",
    "conversation_blocks",
    "conversation_ingest_state",
    "conversations",
    "ledger_body_revisions",
    "ledger_comments",
    "ledger_events",
    "ledger_issue_checkpoints",
    "ledger_issues",
    "ledger_projects",
    "ledger_relationship_edges",
    "message_params",
    "managed_task_occurrences",
    "project_artifact_associations",
    "session_instruction_artifacts",
    "session_projects",
    "sessions",
    "space_exports",
    "work_units",
    "workflow_ingest_state",
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

function isFreshDatabase(db: Db): boolean {
  const row = db
    .prepare(`
      SELECT 1
      FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%'
      LIMIT 1
    `)
    .get();
  return !row;
}
