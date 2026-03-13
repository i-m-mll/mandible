# Mandible

A local-first control plane for AI coding agents. Mandible runs as a daemon on your workstation, tracking Claude Code and Codex sessions, gating protected-branch merges behind hardware key authentication, and providing a web dashboard for managing everything from one place.

## Features

- 🔐 **Async auth queue** — agents submit merge requests; you approve them from a dashboard with YubiKey/GPG signing. No more agents waiting for a human in the loop.
- 📡 **Live session monitor** — tracks all running Claude Code and Codex sessions with process discovery, PID-based liveness checks, and automatic dead-session reaping.
- 💬 **Conversation browser** — ingests and indexes chat transcripts from Claude Code, Codex, and Gemini. Full-text search, starring, export to Markdown/MDX/JSON.
- 🖥️ **Console** — embedded terminal sessions backed by node-pty with xterm.js rendering, WebSocket streaming, and Claude `--output-format stream-json` integration for rich chat views.
- 📦 **Project & branch tracking** — scans registered repos for branches, worktrees, ahead/behind counts, dirty state, and commit history.
- 🐛 **Issue tracking** — reads git-bug refs from all registered repos, links issues to sessions, and auto-closes issues on merge via `Bug:` commit trailers.
- 📥 **Inbox** — session continuations (handoff notes from ended sessions) and auth results delivered to the next session on the same branch.
- 🔄 **Push sync** — batch `git push` across all repos with SSH ControlMaster connection reuse (one YubiKey touch for all repos). Pushes branches, git-bug refs, and git notes.
- 🔌 **Switchboard** — manages symlink pairings between source and target directories with setup/teardown hooks (e.g., publishing draft content by toggling symlinks).
- 🕸️ **Knowledge graph** — D3 force-directed graph visualizing relationships between sessions, issues, and auth requests with clickable navigation.
- 📊 **Diff review** — renders git diffs with syntax highlighting (diff2html) for any repo/base/head combination.
- 🔍 **Chat history search** — CLI and API search across all conversation blocks with provider, role, and date filtering.
- ⚙️ **Settings dashboard** — configurable reaper timeouts, notification preferences, theme, quiet hours, and pre-tool hooks.
- 🔁 **Real-time updates** — Server-Sent Events push every state change to the dashboard; fallback polling as a safety net.
- 🖥️ **Tauri native wrapper** — optional macOS desktop app shell (thin launcher pointing at the daemon).

## Table of Contents

- [Requirements](#requirements)
- [Installation](#installation)
- [Getting Started](#getting-started)
  - [Integrating with Claude Code / Codex](#integrating-with-claude-code--codex)
- [Usage](#usage)
  - [Auth Queue](#auth-queue)
  - [Session Monitor](#session-monitor)
  - [Conversation Browser](#conversation-browser)
  - [Console](#console)
  - [Project & Branch Tracking](#project--branch-tracking)
  - [Knowledge Graph](#knowledge-graph)
  - [Issue Tracking](#issue-tracking)
  - [Inbox](#inbox)
  - [Push Sync](#push-sync)
  - [Switchboard](#switchboard)
  - [Diff Review](#diff-review)
  - [CLI Reference](#cli-reference)
- [Configuration](#configuration)
- [Architecture](#architecture)
- [Development](#development)
- [Future / Roadmap](#future--roadmap)

## Requirements

- **Node.js** >= 18 (uses ESM, `node:` imports, and `structuredClone`)
- **macOS** (primary target; Linux should work but is untested)
- **git-bug** for issue tracking features (optional but recommended)
- **node-pty** native module (postinstall script fixes permissions)

## Installation

```bash
git clone <repo-url> mandible
cd mandible
npm install
npm run build
```

The `postinstall` script runs `scripts/fix-pty-permissions.js` to set correct permissions on the node-pty binary.

## Getting Started

```bash
# Start the daemon (default port: 19420)
npm start

# Or run directly
node dist/index.js

# Open the dashboard
open http://localhost:19420
```

The daemon creates a SQLite database at `~/.cache/mandible/mandible.db` on first run and applies all schema migrations automatically.

### Integrating with Claude Code / Codex

Mandible discovers running agent sessions by scanning processes. For full lifecycle tracking, wrap agent invocations with the session wrapper:

```bash
mandible wrap --app claude -- claude
mandible wrap --app codex -- codex
```

This registers sessions at startup, tracks PID liveness, and delivers inbox items (continuations, auth results) at session start.

## Usage

### Auth Queue

The auth queue is the core workflow: agents work on feature branches freely, but protected-branch merges require explicit human authentication.

**How it works:**

1. An agent finishes work and submits: `mandible auth request <branch> --title "Merge feature/x: description" --no-watch`
2. The request appears in the Auth tab of the dashboard with diff summary, commit message, file stats, and optional spec.
3. You review and click Approve — Mandible runs `git merge --gpg-sign` with your hardware key.
4. The result (success/failure/output) is recorded and delivered to the agent's next session via the inbox.

Requests support dependency chains (`--depends-on <id>`), custom commit messages, post-merge handoff notes, and automatic `Bug:` trailer extraction for issue auto-close.

**CLI reference:**

```bash
mandible auth request <branch> [--title TEXT] [--spec TEXT] [--no-watch]
mandible auth merge <branch>    # Execute the merge (called by daemon on approve)
```

### Session Monitor

The Sessions tab shows all tracked agent sessions:

- **Status**: active (green), ended, or dead (PID vanished)
- **Navigation**: click "Go to" to switch your terminal multiplexer (Zellij/tmux) to the session's pane
- **Kill**: terminate a session's process from the dashboard
- **Pin**: protect a session from the automatic reaper
- **Issues & Projects**: linked git-bug issues and repo associations

Session discovery runs on startup and periodically via the reaper timer, which scans for dead PIDs and marks them accordingly.

### Conversation Browser

The Chat History tab indexes transcripts from:

- **Claude Code**: `~/.claude/projects/**/*.jsonl`
- **Codex**: `~/.codex/sessions/**/*.jsonl`
- **Gemini**: `~/.gemini/tmp/**/chats/*.json`

File watchers (chokidar) detect new and changed transcripts automatically. Conversations are parsed into typed blocks (user message, assistant message, thinking, tool use, tool result, system) and stored with gzip compression.

Features:

- Filter by source, model, branch, starred status
- Full-text search in titles
- Star and annotate conversations
- Export to Markdown, MDX, or JSON (with block type filtering)
- AI-powered content transformation via Claude CLI
- Parent/child conversation linking (orchestrator and sub-agent conversations)

### Console

The Console tab provides embedded terminal sessions:

- **Operator session**: a persistent shell session (auto-restarted on exit)
- **On-demand sessions**: spawn Claude or Codex instances with full PTY emulation
- **Rich chat view**: for Claude sessions, a parallel `--output-format stream-json` subprocess provides structured stream events rendered alongside the terminal view
- **WebSocket streaming**: xterm.js terminal connected via WebSocket with ring buffer history (512 KB per session)
- **Session management**: start, stop, restart, resize, delete

### Project & Branch Tracking

The Projects tab (under the overflow menu) shows all registered git repos with:

- Branch list with ahead/behind counts (both upstream and default branch)
- Worktree detection and status
- Dirty/clean state per branch
- Last commit info (hash, message, author, date)
- Sort by recency, name, or activity
- Push individual repos or batch-push all repos with unpushed commits

Repos are auto-discovered from session working directories and can be manually added/removed.

### Knowledge Graph

The Graph tab (under overflow) renders a D3 force-directed graph connecting:

- **Session nodes** — colored by status (active/ended/dead)
- **Issue nodes** — from git-bug, colored by status
- **Auth request nodes** — merge requests

Edges represent: session parent-child relationships, session-to-issue links (from `session_issues` table), and auth-request-to-issue links (from `Bug:` commit trailers). Nodes are clickable and navigate to the corresponding detail view.

Supports filtering by repo, branch, and time range (e.g., `?since=3d`).

### Issue Tracking

The Issues tab aggregates git-bug issues from all registered repos:

- Grouped by repo with open/closed counts
- Issue detail view with title, labels, comments
- Rescan button to refresh from git-bug refs
- Deep-linkable: `#/issues?repo=<id>&issue=<id>`

Issues are scanned on startup and periodically (every 5 minutes). When an auth merge completes, issues referenced via `Bug:` trailers in commit messages are automatically closed.

### Inbox

The Inbox tab collects items that need attention:

- **Continuations**: handoff notes from ended sessions — when a session ends with unfinished work, it writes a continuation note that the next session on the same branch receives.
- **Auth results**: merge outcomes (completed/rejected/expired) with post-merge handoff notes and linked issue IDs.
- **Open issues**: aggregated from all repos for quick reference.

Items can be acknowledged individually or in bulk. The `mandible inbox` CLI checks for pending items at session start.

### Push Sync

Push all unpushed work across repos in one operation:

- Uses SSH ControlMaster to open one connection per host (one YubiKey touch total)
- Pushes branches with upstream tracking that are ahead
- Pushes `refs/bugs/*` (git-bug issues) and `refs/notes/*` (git notes) if they exist
- Real-time progress via SSE events
- History recorded in the `push_history` table

### Switchboard

The Switchboard manages symlink-based feature flags between a source directory and a target directory. Each "pairing" defines a source and target; individual items within the source can be toggled (linked/unlinked) via the dashboard.

Pairings support setup and teardown hooks — shell commands that run when an item is linked or unlinked (e.g., setting `draft: false` in frontmatter when publishing a blog post).

### Diff Review

The Diff tab (under overflow) renders side-by-side or unified diffs for any repo/base/head combination using diff2html. Accessible via `#/review?repo=<id>&base=<ref>&head=<ref>`.

### CLI Reference

```
mandible wrap [--app NAME] -- <cmd>      Session lifecycle wrapper
mandible task <description>              Set session task/status
mandible inbox [check|ack|watch|add]     Manage session inbox
mandible issue <subcommand>              Issue operations (close, comment, show)
mandible auth request <branch> [opts]    Submit auth merge request
mandible auth merge <branch> [opts]      Execute authenticated merge
mandible search "<query>" [opts]         Search chat history across providers
mandible help                            Show help
```

## Configuration

| Item | Default | Description |
|------|---------|-------------|
| `MANDIBLE_PORT` | `19420` | Daemon HTTP/SSE port |
| `MANDIBLE_DB` | `~/.cache/mandible/mandible.db` | SQLite database path |
| `LOG_LEVEL` | `info` | Logging level: `debug`, `info`, `warn`, `error` |

Dashboard-configurable settings (persisted in the `settings` table):

| Setting | Description |
|---------|-------------|
| `protected_branches` | Branch names to protect (default: `main,develop`) |
| `reaper_enabled` | Enable automatic idle session termination |
| `reaper_claude_idle_minutes` / `reaper_codex_idle_minutes` | Idle timeout per agent type |
| `theme` | UI theme (default: `catppuccin-mocha`) |
| `notification_sound` / `quiet_hours` | macOS notification preferences |
| `push_same_name_upstream` | Push branches to same-name remote refs |
| `pretool_hooks_enabled` | Enable Claude Code PreToolUse hooks |
| `auto_close_issues_on_merge` | Close `Bug:`-referenced issues on auth merge |

## Architecture

```
┌─────────────────────────────────────────────────┐
│              Tauri Shell (optional)              │
│  ┌───────────────────────────────────────────┐  │
│  │      Preact SPA (esbuild, xterm.js)       │  │
│  │  Sessions | Auth | Console | Issues | ... │  │
│  └────────────────┬──────────────────────────┘  │
│                   │ HTTP / SSE / WebSocket       │
│  ┌────────────────┴──────────────────────────┐  │
│  │         Node.js Daemon (TypeScript)        │  │
│  │                                            │  │
│  │  Router → Routes (auth, sessions, work, …) │  │
│  │  SSE Manager → Real-time event broadcast   │  │
│  │  PTY Manager → node-pty terminal sessions  │  │
│  │  Session Registry → lifecycle tracking     │  │
│  │  Auth Queue → merge request state machine  │  │
│  │  Work Scanner → git repo/branch scanning   │  │
│  │  Issue Scanner → git-bug ref parsing       │  │
│  │  Ingestion → conversation file watching    │  │
│  │  Push Manager → SSH batch push             │  │
│  │  Session Discovery → process scanning      │  │
│  │  Reaper Timer → dead session cleanup       │  │
│  │  Nav Enricher → terminal metadata          │  │
│  │                                            │  │
│  │  SQLite (better-sqlite3, WAL mode)         │  │
│  └────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────┘
```

**Key design decisions:**

- **SQLite + WAL mode** for fast concurrent reads from the dashboard while the daemon writes. No external database dependency.
- **SSE for push updates** — every state mutation broadcasts an event. The dashboard subscribes on load and falls back to 10-second polling.
- **WebSocket for terminal I/O** — PTY output streams over WebSocket to xterm.js; HTTP endpoints handle session lifecycle.
- **No framework** — the HTTP server is a minimal custom router (no Express/Fastify dependency). Preact for the UI with esbuild bundling.
- **Conversation compression** — blocks are gzip-compressed in SQLite to keep the database compact as transcript history grows.

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

The schema uses numbered migrations in `src/db.ts` (currently at version 31). New columns or tables must be added as a new migration entry — never modify existing migrations or use ad-hoc `CREATE TABLE` in modules.

## Future / Roadmap

The following items are tracked as open issues but **are not yet implemented**:

- **Tauri Level 2**: bundled daemon sidecar — currently the Tauri wrapper is a thin launcher that expects the daemon to already be running separately.
- **Configurable keyboard shortcuts**: the key binding map is hardcoded (Ctrl+1–9 for tabs).
- **GitHub bridge for issues**: one-way push from git-bug to GitHub Issues for public visibility.
- **Database backup/restore UI**: backup routes exist but the UI for scheduled backups is minimal.
- **Multi-machine sync**: push/pull of Mandible state across machines (currently local-only).
