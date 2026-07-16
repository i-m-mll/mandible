-- Frozen result of Mandible migration v1 ("init").
--
-- This fixture is intentionally independent of src/db-migrations.ts so the
-- baseline equivalence test exercises the complete supported v1-to-head replay.
-- Rows are synthetic but shaped like a small production database: one ended
-- Codex session, one dismissed auth request, and one observed branch.

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE sessions (
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
);

CREATE INDEX sessions_parent_idx ON sessions(parent_id);
CREATE INDEX sessions_status_idx ON sessions(status);
CREATE INDEX sessions_app_idx ON sessions(app);

CREATE TABLE auth_requests (
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
);

CREATE INDEX idx_auth_requests_status_created
  ON auth_requests(status, created_at);
CREATE INDEX idx_auth_requests_queue
  ON auth_requests(status, skipped_at, created_at);

CREATE TABLE branches (
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
);

INSERT INTO meta (key, value) VALUES ('schema_version', '1');

INSERT INTO sessions (
  id, app, status, cwd, branch, worktree, task, terminal, agent_type,
  description, created_at, ended_at, updated_at
) VALUES (
  'fixture-session-v1', 'codex', 'ended', '/tmp/mandible-fixture', 'main',
  '/tmp/mandible-fixture', 'Exercise historical schema replay', 'fixture-terminal',
  'codex', 'Synthetic production-shaped migration fixture',
  '2025-01-01 00:00:00', '2025-01-01 01:00:00', '2025-01-01 01:00:00'
);

INSERT INTO auth_requests (
  id, session_id, command, title, cwd, diff_summary, spec_content, status,
  created_at, updated_at, resolved_at, expires_at, exit_code, output
) VALUES (
  'fixture-auth-v1', 'fixture-session-v1', 'git status', 'Fixture auth request',
  '/tmp/mandible-fixture', 'No changes', 'Synthetic fixture only', 'dismissed',
  1735689600000, 1735689660000, 1735689660000, 1735693200000, 0, 'fixture output'
);

INSERT INTO branches (
  repo_root, branch, is_current, is_worktree, worktree_path, is_dirty,
  ahead, behind, last_commit_hash, last_commit_message, last_commit_author,
  last_commit_date, diff_stat, updated_at
) VALUES (
  '/tmp/mandible-fixture', 'main', 1, 0, NULL, 0, 0, 0,
  '0000000000000000000000000000000000000000', 'Fixture commit', 'Fixture User',
  '2025-01-01 00:00:00', '0 files changed', '2025-01-01 00:00:00'
);
