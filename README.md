# Mandible

A local-first agent control plane for AI coding agents. Mandible runs as a daemon on your workstation, providing an async auth queue for protected-branch operations, a web dashboard for managing sessions and conversations.

## Features

### Auth Queue

Agents work on feature branches freely. Protected-branch operations require explicit human authentication via hardware key (YubiKey/GPG).

1. An agent checks for an existing request if needed: `mandible auth list --repo <repo> --head feature/x`
2. An agent finishes work and submits: `mandible auth request <branch> --title "Merge feature/x" --no-watch`
3. The request appears in the Auth tab with diff summary, change message, and file stats.
4. You review and approve — Mandible executes the operation with your hardware key.
5. The result is delivered to the agent's next session via the inbox.

Auth types are generalized beyond merges: `merge`, `commit`, `force-push`, `branch-delete`, `config-change`, and `data-delete` are all supported. Requests support dependency chains, custom commit messages, post-action handoff notes, structured reference-only issue links, and explicit close-on-merge issue links.

### Auth Hook System

Configurable hooks that run after successful auth actions. Hooks are stored in the database and matched by repo pattern and auth type. This replaces hardcoded post-merge logic (build dist, restart daemon) with a flexible, per-repo, per-action-type hook pipeline. Hooks are managed from the dashboard or API.

### Live Session Monitor

Shows Claude Code, Codex, and Gemini sessions. Each session is identified by its provider session id and its indexed conversation; Claude lifecycle hooks and Mandible launches add a process attachment for sessions Mandible can reach:

- **Status**: active (green), ended, or dead (PID vanished)
- **Navigation**: click to switch your terminal multiplexer (Zellij/tmux) to the session's pane
- **Kill / Pin**: terminate or protect sessions from the automatic reaper
- **Issues & Projects**: linked Mandible issues and repo associations
- **Channel sessions**: Claude CLI sessions connected via MCP channel server appear with a link badge

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

- **Operator session**: persistent Claude SDK session (auto-restarted on exit)
- **Claude sessions — SDK lane (default)**: spawned via the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) with full lifecycle control, structured event streaming, real permission gating through `canUseTool`, cost tracking, and conversation branching. This is the only Claude chat lane a released build offers.
- **Claude sessions — headless spawn lane**: the documented `claude -p --output-format stream-json` mode, used for one-shot and resumed non-interactive work
- **Codex / Gemini sessions**: ACP lane by default (Agent Client Protocol live sessions), with a plain PTY terminal available as a CLI fallback
- **PTY sessions**: terminal processes for Codex, Gemini, and shell commands with xterm.js rendering over WebSocket
- **Rich chat view**: for SDK sessions, structured stream events are rendered alongside the terminal using the shared message-blocks library

#### Claude PTY lane (local-only, off by default)

Mandible also contains a lane that drives the interactive Claude Code CLI inside
a Mandible-owned PTY — classifying the terminal screen, parsing permission
prompts, and answering them with synthetic keystrokes. That is a developer
capability for running against your own account locally, not something a
released build ships or enables. It is gated behind the `claude_pty_lane_enabled`
setting (or the `MANDIBLE_CLAUDE_PTY_LANE` environment variable), defaults to
off, and while off:

- creating a Claude session on the `pty` or `channel` transport lane is rejected
  with `claude_pty_lane_disabled`, and the lane is hidden in the new-session dialog;
- an existing Claude PTY session will not start;
- screen classification and permission-prompt parsing never engage for Claude;
- the development-channel launch flag is never appended.

Codex, Gemini, and shell PTY sessions are unaffected.

#### Anthropic billing posture

Claude sessions report which credentials they will bill against. If
`ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`) is present in the daemon
environment, the session is marked `api_key` — it bills to the Anthropic API —
and the daemon logs a warning at spawn. Otherwise the session runs on the local
Claude Code credentials and their subscription limits. The posture is surfaced
on the session as `anthropic_billing` so it is never a silent inheritance.
- **Token/context indicators**: real-time token usage and context-window fill displayed per session, with model-aware context window sizes

### Issue Tracking

Aggregates Mandible ledger issues from all registered repos:

- Grouped by repo with open/closed counts
- Issue detail view with title, labels, comments
- Deep-linkable views
- Auth request issue links distinguish reference-only `--issue` context from explicit `--closes-issue` closure targets
- "Resume Work" spawns a first-class SDK session for any issue

### Project & Branch Tracking

Shows all registered git repos with branch lists, ahead/behind counts, worktree detection, dirty/clean state, and commit history. Push individual repos or batch-push all with SSH ControlMaster connection reuse (one YubiKey touch for all repos).

### Knowledge Graph

D3 force-directed graph connecting session, issue, and auth-request nodes with clickable navigation. Filter by repo, branch, and time range.

### Inbox

Collects continuations (handoff notes from ended sessions), auth results (merge outcomes with linked issues), and open issues. Items are acknowledged individually or in bulk.

### IndexedDB Stream Cache

SDK session stream events are cached in IndexedDB on the client for instant hydration on tab switch or page reload. Uses LRU eviction (default: 20 sessions) with debounced cleanup to avoid write amplification during active streaming.

## Getting Started

### Requirements

- **Bun** at the exact version and verified binary selected by `scripts/bun-runtime.sh`
- **macOS** (primary target; Linux should work but is less tested)
- The stock SQLite library qualified by the [Bun runtime contract](docs/bun-foundation.md)

### Installation

```bash
git clone <repo-url> mandible
cd mandible
runtime_path="$(scripts/bun-runtime.sh)"
export PATH="$(dirname "$runtime_path"):$PATH"
"$runtime_path" install --frozen-lockfile
"$runtime_path" run build
```

### Running

```bash
# Start the daemon (default backend port: 29420)
bun run start

# Or run directly
"$(scripts/bun-runtime.sh)" --no-install dist/index.js

# Open the dashboard
open https://app.mandible.localhost:19420
```

The daemon creates a SQLite database at `~/.mandible/mandible.db` on first run and applies all schema migrations automatically.

Mandible splits its on-disk state by lifetime:

| Root | Contract | Contents |
|------|----------|----------|
| `~/.mandible` | durable — losing it is data loss | `mandible.db` (+ `-wal`/`-shm`), `backups/`, `config/`, `artifacts/`, `runtime/`, `repairs/` |
| `~/.cache/mandible` | disposable — safe to delete | previews, `agent-rpc/`, the cowork CLI mirror, `claude-hooks/`, logs, `daemon.pid`, `restart-availability.json` |

`MANDIBLE_HOME` relocates the durable root wholesale. A database left at the
pre-split location (`~/.cache/mandible/mandible.db`) is copied forward to the
durable root, with its `-wal`/`-shm` sidecars, on the first daemon start after
upgrading; the originals are retained and a receipt is written beside them.

The retired self-modification feature no longer creates or uses a patch table.
During upgrade, an empty `runtime_patches` table is dropped. A nonempty table
stays in the database solely to preserve historical rows and remains included
in metadata backups; no application route reads or changes those rows.

### Operator setup and the signing credential

```bash
mandible user setup
```

This creates the local human operator (the only path that does) and, when **global** `git config user.signingkey` is set, registers that key as the operator's `ssh_key` credential. Registration matters: the auth queue only attests a protected-branch merge whose commit signature verifies against an *active registered* credential, so an unregistered signing key makes later approvals refuse with no visible cause. `user setup` is idempotent and never adds a duplicate.

Auto-registration reads global config only, and deliberately so: an operator credential is the identity every protected merge is attested against, in every repository. Running setup inside a repository that sets its own `user.signingkey` (a per-project or agent key) therefore registers nothing — it prints the key it found and the command that would register it. Register or rotate a key by hand with `mandible user credential add <operator> --from-git-signingkey`, which reads the effective configuration of the current repository and prints which config scope the key came from. The daemon warns at startup if the configured key has no matching active credential.

### Integrating with Claude Code

Mandible knows every session from its indexed conversation. For process lifecycle tracking:

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
|  |  Sessions | Auth | Console | Artifacts | ...  |  |
|  +-------------------+------------------------+  |
|                      | HTTP / SSE / WebSocket    |
|  +-------------------+------------------------+  |
|  |        Node.js Daemon (TypeScript)          |  |
|  |                                             |  |
|  |  Router -> Route modules:                   |  |
|  |    auth, auth-hooks, sessions, artifacts,   |  |
|  |    console, conversations, chats, inbox,    |  |
|  |    issues, work-units, work, graph, review, |  |
|  |    settings, system, backup, webhooks       |  |
|  |                                             |  |
|  |  Core services:                             |  |
|  |    SSE Manager     - real-time broadcast    |  |
|  |    PTY Manager     - node-pty terminals     |  |
|  |    Session Registry - lifecycle tracking    |  |
|  |    Auth Queue      - request state machine  |  |
|  |    Auth Hooks      - post-action pipeline   |  |
|  |    Channel Registry - MCP channel sessions  |  |
|  |    Work Scanner    - git repo/branch scan   |  |
|  |    Issue Ledger    - local issue storage    |  |
|  |    Ingestion       - transcript watching    |  |
|  |    Push Manager    - SSH batch push         |  |
|  |    Reaper Timer    - dead session cleanup   |  |
|  |                                             |  |
|  |  SQLite (Bun node:sqlite, WAL mode)          |  |
|  +---------------------------------------------+ |
+--------------------------------------------------+

```

### Agent Interaction Tiers

Mandible interacts with agents at four integration tiers:

| Tier | Name | Control | Use case |
|------|------|---------|----------|
| 1st | SDK | Full lifecycle (start/stop/abort/resume), structured events, permissions, cost tracking | Claude sessions spawned from Console (the default) |
| 1.5 | Channel | No lifecycle control; rich tool-mediated integration (inbox, issues, work units, auth) | A Claude CLI session you start yourself and connect to Mandible |
| 2nd | ACP | Structured live sessions over Agent Client Protocol | Codex and Gemini sessions in Console (the default for both) |
| 2nd | PTY | Process-level control, terminal I/O | Codex, Gemini, shell commands in Console. For Claude, local-only and off by default — see the Claude PTY lane note above |
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
| `MANDIBLE_PORT` | `29420` | Daemon HTTP/SSE backend port |
| `MANDIBLE_DB` | `~/.mandible/mandible.db` | SQLite database path |
| `MANDIBLE_HOME` | `~/.mandible` | Durable-state root (database, backups, config, artifacts) |
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

## API Quick Reference

Base URL: `https://app.mandible.localhost:19420`

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
mandible conversations search "<query>"  Search chat history across providers
mandible help                            Show help
```

## Development

```bash
bun run build          # Full build (TypeScript + esbuild UI)
bun run build:server   # TypeScript only
bun run build:ui       # UI only
bun run build:watch    # UI hot-reload (esbuild watch)
bun run dev            # TypeScript watch + UI watch in parallel
bun run test               # Run tests (vitest)
bun run tauri          # Tauri dev mode
bun run tauri:build    # Build Tauri desktop app
```

Schema uses numbered migrations in `src/db.ts`. New columns or tables must be added as a new migration entry — never modify existing migrations.

### Worktree Build Notes

Worktrees own their dependency trees. Inspect shared links first, then use the
verified Bun runtime for `install --frozen-lockfile` in the issue-linked worktree.
Do not copy or mutate the serving checkout's dependencies. See the canonical
[installation guide](docs/getting-started/installation.mdx),
[Bun runtime contract](docs/bun-foundation.md), and
[test suite guide](test/README.md).

## Other Features

- **Header icon modes** — text, icons, or both display modes in Settings > Appearance
- **Custom CSS injection** — planned support for user-defined stylesheets
- **Breadcrumb toggle** — show/hide breadcrumb navigation in Convention Library
- **PTY deprecation banner** — informational notice for PTY sessions encouraging SDK migration
- **Diff review** — side-by-side or unified diffs for any repo/base/head via diff2html
- **Chat history search** — CLI and API search across all conversation blocks with provider, role, and date filtering
- **Push sync** — batch `git push` across repos with SSH ControlMaster (one YubiKey touch for all)
- **Database backup/restore** — backup routes with scheduled backup support
