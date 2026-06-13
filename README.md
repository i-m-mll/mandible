# Mandible

A local-first agent control plane for AI coding agents. Mandible runs as a daemon on your workstation, providing an async auth queue for protected-branch operations, a web dashboard for managing sessions and conversations, configurable instruction presets, and a split-runtime architecture that supports safe self-modification.

## Features

### Auth Queue

Agents work on feature branches freely. Protected-branch operations require explicit human authentication via hardware key (YubiKey/GPG).

1. An agent checks for an existing request if needed: `mandible auth list --repo <repo> --head feature/x`
2. An agent finishes work and submits: `mandible auth request <branch> --title "Merge feature/x" --no-watch`
3. The request appears in the Auth tab with diff summary, commit message, file stats, and optional spec.
4. You review and approve — Mandible executes the operation with your hardware key.
5. The result is delivered to the agent's next session via the inbox.

Auth types are generalized beyond merges: `merge`, `commit`, `force-push`, `branch-delete`, `config-change`, `preset-promote`, and `data-delete` are all supported. Requests support dependency chains, custom commit messages, post-action handoff notes, automatic `Mandible-Issue:` trailer extraction for reference-only issue links, and explicit close-on-merge issue links.

### Auth Hook System

Configurable hooks that run after successful auth actions. Hooks are stored in the database and matched by repo pattern and auth type. This replaces hardcoded post-merge logic (build dist, restart daemon) with a flexible, per-repo, per-action-type hook pipeline. Hooks are managed from the dashboard or API.

### Live Session Monitor

Tracks all running Claude Code, Codex, and Gemini sessions:

- **Status**: active (green), ended, or dead (PID vanished)
- **Navigation**: click to switch your terminal multiplexer (Zellij/tmux) to the session's pane
- **Kill / Pin**: terminate or protect sessions from the automatic reaper
- **Issues & Projects**: linked Mandible issues and repo associations
- **Channel sessions**: Claude CLI sessions connected via MCP channel server appear with a link badge

Session discovery runs on startup and periodically via the reaper timer.

### Conversation Browser

Indexes transcripts from Claude Code, Codex, and Gemini with file watchers for automatic detection. Conversations are parsed into typed blocks and stored with gzip compression.

- Filter by source, model, branch, starred status
- Full-text search
- Star and annotate conversations
- Export to Markdown, MDX, or JSON
- AI-powered content transformation
- Parent/child conversation linking

Chat History and Console Chat use a **shared message-blocks library** (`ui/src/components/message-blocks/`) — TextBlock, ThinkingBlock, ToolUseBlock, FileEditBlock, TurnGroup, UserBubble, and GroupFooter are rendered identically in both views.

### Console

Embedded terminal sessions with rich agent integration:

- **Operator session**: persistent shell (auto-restarted on exit)
- **SDK sessions**: Claude agents spawned via the Claude Agent SDK with full lifecycle control, structured event streaming, permission gating, cost tracking, and conversation branching
- **PTY sessions**: terminal processes for Codex, Gemini, and shell commands with xterm.js rendering over WebSocket
- **Rich chat view**: for SDK sessions, structured stream events are rendered alongside the terminal using the shared message-blocks library
- **Token/context indicators**: real-time token usage and context-window fill displayed per session, with model-aware context window sizes

### Presets (Convention Management)

A tree-structured editor for managing agent instruction sets:

- **Tree editor**: presets are composed of hierarchical nodes (sections/subsections), editable with drag-and-drop reordering
- **Convention library**: browse and search all convention nodes across presets
- **CLAUDE.md import**: import presets from global, project, or local CLAUDE.md files, parsed into structured nodes
- **Union composition**: compose multiple presets into a single instruction set, with token estimation
- **Preset diffs**: track proposed changes (add/remove/modify) with accept/reject/promote workflow
- **Convention-setting links**: nodes can reference dashboard settings, creating bidirectional traceability between conventions and configuration
- **Session assignment**: presets are assigned to sessions and versions are tracked

### Issue Tracking

Aggregates Mandible ledger issues from all registered repos:

- Grouped by repo with open/closed counts
- Issue detail view with title, labels, comments
- Deep-linkable views
- Auth request issue links distinguish reference-only `Mandible-Issue:`/`--issue` context from explicit `Closes-Mandible-Issue:`/`--closes-issue` closure targets
- "Resume Work" spawns a first-class SDK session for any issue

### Project & Branch Tracking

Shows all registered git repos with branch lists, ahead/behind counts, worktree detection, dirty/clean state, and commit history. Push individual repos or batch-push all with SSH ControlMaster connection reuse (one YubiKey touch for all repos).

### Knowledge Graph

D3 force-directed graph connecting session, issue, and auth-request nodes with clickable navigation. Filter by repo, branch, and time range.

### Inbox

Collects continuations (handoff notes from ended sessions), auth results (merge outcomes with linked issues), and open issues. Items are acknowledged individually or in bulk.

### Zone 2 Self-Modification Infrastructure

Mandible's runtime is split into two zones:

- **Zone 1** (immutable): the installed binary or repo checkout — never modified at runtime.
- **Zone 2** (mutable): a separate runtime directory (`~/Library/Application Support/Mandible/runtime/` on macOS, `~/.local/share/mandible/runtime/` on Linux) that can receive patches from agents.

Zone 2 patches are tracked in the database with fingerprint, commit hash, diff summary, source (agent/known_fix/manual/upstream_update), and session linkage. Patches can be applied, reverted, and submitted upstream.

The Tauri shell resolves the daemon entry point in priority order: **Zone 2 -> bundled sidecar -> dev path**, ensuring that Zone 2 patches always take effect.

The daemon exposes `/api/runtime/status`, `/api/runtime/patches`, and `/api/runtime/bootstrap` endpoints for managing Zone 2.

### IndexedDB Stream Cache

SDK session stream events are cached in IndexedDB on the client for instant hydration on tab switch or page reload. Uses LRU eviction (default: 20 sessions) with debounced cleanup to avoid write amplification during active streaming.

## Getting Started

### Requirements

- **Node.js** >= 18 (ESM, `node:` imports, `structuredClone`)
- **macOS** (primary target; Linux should work but is less tested)
- **git-bug** for legacy issue import/export compatibility (optional)
- **node-pty** native module (postinstall script fixes permissions)

### Installation

```bash
git clone <repo-url> mandible
cd mandible
npm install
npm run build
```

### Running

```bash
# Start the daemon (default port: 19420)
npm start

# Or run directly
node dist/index.js

# Open the dashboard
open http://localhost:19420
```

The daemon creates a SQLite database at `~/.cache/mandible/mandible.db` on first run and applies all schema migrations automatically.

### Integrating with Claude Code

Mandible discovers running agent sessions by scanning processes. For full lifecycle tracking:

```bash
# Session lifecycle wrapper
mandible wrap --app claude -- claude

# Connect via MCP channel (rich integration without PTY)
claude --channels server:mandible
```

Channel-connected sessions get tool-mediated access to inbox, issues, work units, and auth submission.

## Architecture

```
+--------------------------------------------------+
|             Tauri Shell (optional)                |
|  +--------------------------------------------+  |
|  |     Preact SPA (esbuild, xterm.js)         |  |
|  |  Sessions | Auth | Console | Presets | ...  |  |
|  +-------------------+------------------------+  |
|                      | HTTP / SSE / WebSocket    |
|  +-------------------+------------------------+  |
|  |        Node.js Daemon (TypeScript)          |  |
|  |                                             |  |
|  |  Router -> Route modules:                   |  |
|  |    auth, auth-hooks, sessions, presets,     |  |
|  |    console, conversations, chats, inbox,    |  |
|  |    issues, work-units, work, graph, review, |  |
|  |    runtime, settings, system, backup,       |  |
|  |    webhooks                                 |  |
|  |                                             |  |
|  |  Core services:                             |  |
|  |    SSE Manager     - real-time broadcast    |  |
|  |    PTY Manager     - node-pty terminals     |  |
|  |    Session Registry - lifecycle tracking    |  |
|  |    Auth Queue      - request state machine  |  |
|  |    Auth Hooks      - post-action pipeline   |  |
|  |    Preset Manager  - convention trees       |  |
|  |    Runtime Manager - Zone 2 patches         |  |
|  |    Channel Registry - MCP channel sessions  |  |
|  |    Work Scanner    - git repo/branch scan   |  |
|  |    Issue Ledger    - local issue storage    |  |
|  |    Ingestion       - transcript watching    |  |
|  |    Push Manager    - SSH batch push         |  |
|  |    Reaper Timer    - dead session cleanup   |  |
|  |                                             |  |
|  |  SQLite (better-sqlite3, WAL mode)          |  |
|  +---------------------------------------------+ |
+--------------------------------------------------+

Zone 2 Runtime (mutable, outside repo):
  ~/Library/Application Support/Mandible/runtime/
    dist/index.js   <- patched daemon entry point
    patches/        <- tracked patch metadata
```

### Agent Interaction Tiers

Mandible interacts with agents at four integration tiers:

| Tier | Name | Control | Use case |
|------|------|---------|----------|
| 1st | SDK | Full lifecycle (start/stop/abort/resume), structured events, permissions, cost tracking | Claude sessions spawned from Console |
| 1.5 | Channel | No lifecycle control; rich tool-mediated integration (inbox, issues, work units, auth) | `claude --channels server:mandible` |
| 2nd | PTY | Process-level control, terminal I/O | Codex, Gemini, shell commands in Console |
| 3rd | External | Best-effort monitoring only | Agents started from terminal |

### Key Design Decisions

- **SQLite + WAL mode** for fast concurrent reads. No external database dependency.
- **SSE for push updates** — every state mutation broadcasts an event; fallback 10-second polling.
- **WebSocket for terminal I/O** — PTY output streams to xterm.js; HTTP for lifecycle.
- **No framework** — minimal custom HTTP router (no Express/Fastify). Preact for UI with esbuild bundling.
- **Conversation compression** — blocks are gzip-compressed in SQLite.
- **Shared message-blocks** — Chat and History use identical rendering components.

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MANDIBLE_PORT` | `19420` | Daemon HTTP/SSE port |
| `MANDIBLE_DB` | `~/.cache/mandible/mandible.db` | SQLite database path |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

### Dashboard Settings

Persisted in the `settings` table, configurable from Settings tab:

| Setting | Description |
|---------|-------------|
| `protected_branches` | Branch names to protect (default: `main,develop`) |
| `theme` | UI theme (default: `catppuccin-mocha`) |
| `notification_sound` / `quiet_hours` | macOS notification preferences |
| `push_same_name_upstream` | Push branches to same-name remote refs |
| `pretool_hooks_enabled` | Claude Code PreToolUse hooks |
| `auto_close_issues_on_merge` | Close explicit `Closes-Mandible-Issue:` targets on auth merge |

## API Quick Reference

Base URL: `http://localhost:19420`

### Auth

```
GET    /api/auth/queue            List active auth queue
GET    /api/auth/request/<id>     Request details
POST   /api/auth/request          Submit new request (prefer CLI)
PUT    /api/auth/request/<id>     Update existing request
DELETE /api/auth/request/<id>     Delete request (body: {"reason":"..."})
```

### Auth Hooks

```
GET    /api/auth/hooks            List all hooks
POST   /api/auth/hooks            Create hook
PUT    /api/auth/hooks/<id>       Update hook
DELETE /api/auth/hooks/<id>       Delete hook
```

### Sessions

```
GET    /api/sessions              List sessions
PATCH  /api/sessions/<id>         Update session
DELETE /api/sessions/<id>         Remove session
```

### Presets

```
GET    /api/presets                List presets
POST   /api/presets                Create preset
GET    /api/presets/<id>           Get preset with nodes
PUT    /api/presets/<id>           Update preset
DELETE /api/presets/<id>           Delete preset
GET    /api/presets/union          Compute union of active presets
GET    /api/presets/library        Convention library (all nodes)
POST   /api/presets/import         Import from CLAUDE.md
GET    /api/presets/diffs          List preset diffs
GET    /api/presets/violations     Preset violation checks
```

### Runtime (Zone 2)

```
GET    /api/runtime/status        Zone 2 runtime status
GET    /api/runtime/patches       List applied patches
POST   /api/runtime/bootstrap     Bootstrap Zone 2 from current install
```

### Other

```
GET    /api/events?topic=<t>      SSE event stream
GET    /api/inbox?branch=<b>      Session inbox
GET    /api/issues                Issue list
GET    /api/work-units            Work unit list
GET    /api/conversations         Conversation list
GET    /api/graph                 Knowledge graph data
GET    /api/health                Health check
```

## CLI Reference

```
mandible wrap [--app NAME] -- <cmd>      Session lifecycle wrapper
mandible task <description>              Set session task/status
mandible inbox [check|ack|watch|add]     Manage session inbox
mandible issue <subcommand>              Issue operations, comments, labels, and body revision history
mandible auth list [opts]                List active auth requests
mandible auth request <branch> [opts]    Submit auth request
mandible auth merge <branch> [opts]      Execute authenticated merge
mandible search "<query>" [opts]         Search chat history across providers
mandible help                            Show help
```

## Development

```bash
npm run build          # Full build (TypeScript + esbuild UI)
npm run build:server   # TypeScript only
npm run build:ui       # UI only
npm run build:watch    # UI hot-reload (esbuild watch)
npm run dev            # TypeScript watch + UI watch in parallel
npm test               # Run tests (vitest)
npm run tauri          # Tauri dev mode
npm run tauri:build    # Build Tauri desktop app
```

Schema uses numbered migrations in `src/db.ts`. New columns or tables must be added as a new migration entry — never modify existing migrations.

### Worktree Build Notes

Never run `npm ci` in a feature worktree — it deletes `node_modules`, which may be shared/symlinked from main. Instead:

```bash
cp -r <main-worktree>/node_modules <feature-worktree>/node_modules
cd <feature-worktree>
npm run build
```

## Other Features

- **Header icon modes** — text, icons, or both display modes in Settings > Appearance
- **Custom CSS injection** — planned support for user-defined stylesheets
- **Breadcrumb toggle** — show/hide breadcrumb navigation in Convention Library
- **PTY deprecation banner** — informational notice for PTY sessions encouraging SDK migration
- **Diff review** — side-by-side or unified diffs for any repo/base/head via diff2html
- **Chat history search** — CLI and API search across all conversation blocks with provider, role, and date filtering
- **Push sync** — batch `git push` across repos with SSH ControlMaster (one YubiKey touch for all)
- **Database backup/restore** — backup routes with scheduled backup support
