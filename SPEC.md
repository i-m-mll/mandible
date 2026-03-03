# Partition 1: Core Daemon + Storage

## What

A single-process HTTP daemon that serves as the backbone for all other
partitions. It owns the SQLite database, SSE broadcast infrastructure,
and lifecycle management.

## Runtime

Node.js with TypeScript. Use `better-sqlite3`
for synchronous SQLite access.

## API Skeleton

```
GET  /api/health                → { status: "ok", uptime, version }
GET  /api/events                → SSE stream (all event types)
POST /api/events/subscribe      → SSE stream with topic filter
```

All partition-specific routes (sessions, auth, work, review) are
registered by their respective modules but served by this core server.

## SQLite Schema

```sql
-- Core metadata
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Sessions (Partition 2 owns the logic, core owns the table)
CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,
  app           TEXT NOT NULL CHECK(app IN ('claude', 'codex')),
  parent_id     TEXT REFERENCES sessions(id),
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK(status IN ('active', 'idle', 'ended', 'dead')),
  pid           INTEGER,
  pid_start     TEXT,  -- process start time for PID reuse detection
  cwd           TEXT,
  branch        TEXT,
  worktree      TEXT,
  task          TEXT,  -- intent/description from SubagentStart or voluntary update
  terminal      TEXT,  -- wezterm, iterm, kitty, ghostty, generic
  multiplexer   TEXT,  -- zellij, tmux, or null
  -- Navigation metadata (mirrors claude-notify session fields)
  nav_session   TEXT,  -- multiplexer session name
  nav_tab       TEXT,  -- tab name
  nav_pane_id   TEXT,  -- terminal-specific pane/window ID
  nav_extra     TEXT,  -- JSON blob for additional terminal-specific IDs
  started_at    TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at      TEXT,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Auth requests (Partition 3 owns the logic)
CREATE TABLE auth_requests (
  id            TEXT PRIMARY KEY,
  session_id    TEXT REFERENCES sessions(id),
  command       TEXT NOT NULL,
  title         TEXT,
  cwd           TEXT,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK(status IN ('pending', 'approved', 'rejected', 'expired')),
  diff_summary  TEXT,  -- cached diff stats
  spec_content  TEXT,  -- git notes or COMMIT_MSG.txt content
  result        TEXT,  -- JSON: { stdout, stderr, exit_code }
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at   TEXT
);

-- Branch state cache (Partition 4 owns the logic)
CREATE TABLE branches (
  repo_root     TEXT NOT NULL,
  branch        TEXT NOT NULL,
  is_worktree   INTEGER DEFAULT 0,
  worktree_path TEXT,
  is_dirty      INTEGER DEFAULT 0,
  ahead         INTEGER DEFAULT 0,
  behind        INTEGER DEFAULT 0,
  last_commit   TEXT,
  last_scan     TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (repo_root, branch)
);
```

Migrations are embedded in the daemon startup. Version tracked in `meta`.

## SSE Infrastructure

```typescript
interface SSEEvent {
  type: string;       // e.g. "session:registered", "auth:new", "branch:updated"
  data: unknown;      // partition-specific payload
  timestamp: string;  // ISO 8601
}
```

The core maintains a Set of active SSE connections. Any module can call
`broadcast(event)` to push to all connected clients. Clients can filter
by event type prefix on the server side via query param.

## Lifecycle

- **Port**: Fixed at `19420` (configurable via `MANDIBLE_PORT` env var)
- **PID file**: `~/.cache/mandible/daemon.pid`
- **Auto-start**: Hooks and MCP tool check if daemon is running; if not,
  spawn it in the background before proceeding. Use a short startup
  probe (poll health endpoint for up to 3s).
- **Idle shutdown**: Optional. If no SSE clients and no active sessions
  for 30 minutes, the daemon may exit. Disabled by default.
- **Logging**: Structured JSON to stderr. Log level via `LOG_LEVEL` env var.

## Project Structure

```
.config/mcp-servers/mandible/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts          -- entry point, starts server
│   ├── server.ts         -- HTTP server, route registration
│   ├── db.ts             -- SQLite connection, migrations
│   ├── sse.ts            -- SSE connection manager, broadcast
│   ├── lifecycle.ts      -- PID file, health check, auto-start
│   └── types.ts          -- shared type definitions
├── dist/                 -- compiled JS
└── test/
    └── core.test.ts
```

## Tests

1. Server starts and responds to health endpoint
2. SSE connection receives broadcast events
3. DB migrations run on fresh database
4. DB migrations are idempotent on existing database
5. PID file created on start, removed on clean shutdown
6. Auto-start utility spawns daemon and waits for health
