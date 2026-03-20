# Mandible

Mandible is a local-first agent control plane and conversation browser. It provides:
- An async auth queue for protected-branch merges (agent submits, user authenticates via YubiKey)
- A web dashboard (sessions, issues, conversations, switchboard, console)
- A daemon that manages git-bug ref sync, session lifecycle, and inbox delivery
- A Tauri native window wrapper (Level 1: thin launcher; Level 2: bundled sidecar, see issue fdc0e8a)

## Build

```bash
npm run build        # Full build (TypeScript + esbuild UI)
npm run build:watch  # UI hot-reload (esbuild watch only)
npm run dev          # TypeScript watch + UI watch (both in parallel)
npm start            # Run daemon (requires prior build)
npm test             # Run tests (vitest)
```

## Repo conventions

- **Protected branch:** `main`
- **Feature branches:** `feature/<name>`
- **Integration branches:** `feature/<name>` when aggregating child branches
- **Sub-branch separator:** `__` (e.g., `feature/stage1__sim-oracle`) — Git refuses path-based refs that conflict
- **Agent commits:** use agent signing key (GIT_CONFIG_COUNT pattern from dotfiles CLAUDE.md)
- **Auth requests:** `mandible auth request <branch> --no-watch`
- **Worktrees:** `wt <branch>` from dotfiles tooling (`~/.dotfiles/bin/wt`)

## Database

Uses SQLite via better-sqlite3. Schema migrations live in `src/db.ts` in the `MIGRATIONS` array.

**Always add new columns/tables via a new migration entry** — never via ad-hoc `CREATE TABLE IF NOT EXISTS` in individual modules. The `ensureSchema()` functions are fallbacks for fresh databases only; they do NOT alter existing tables.

## Work units

The `work_units` table tracks the dispatch state of issues through their lifecycle: open → committed → resolved (+ abandoned). Work units join the issue tree (git-bug), branch tree (git worktrees), and session tree (agent sessions) into a single reconciliation layer. See umbrella issue f3dbb3e for the full design.

Key conventions:
- `wt --issue <id>` registers a work unit and writes a `.issue` file for auto-discovery
- `agent-commit` auto-discovers the issue from `.issue` if `--issue` is not passed explicitly
- Liveness (is an agent currently working?) is derived at query time, not stored as a state
- Continuations (handoff notes) live on the work unit, not on individual sessions

## Dist files

Do **not** commit `dist/` in feature branches. Build once in the integration branch after all feature merges, then commit the dist there.

## Worktree build notes

**Never run `npm ci` in a feature worktree.** `npm ci` deletes `node_modules` before reinstalling — if the worktree shares or symlinks `node_modules` from main, it destroys the main install and crashes the running daemon.

Correct build procedure in a worktree:
```bash
cp -r <main-worktree>/node_modules <feature-worktree>/node_modules
cd <feature-worktree>
npm run build
```

## Auth flow

The auth queue is the mechanism for protected-branch merges. Full protocol is in the dotfiles CLAUDE.md (`~/.claude/CLAUDE.md`). Key points:
- Agent submits: `mandible auth request <branch> --no-watch`
- User approves via dashboard or terminal pane
- `auth-merge` runs the actual `git merge --gpg-sign` with YubiKey
- Auth results arrive in the session inbox at next session start

## Agent interaction tiers

Mandible interacts with agents at four tiers of integration:

- **First-class (SDK)**: Agents spawned via Console using the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`). Full lifecycle control (start, stop, abort, resume), structured event stream (tool calls, thinking, content blocks), permission gating, cost tracking, conversation branching/forking. This is the intended primary workflow for Claude interactions.
- **1.5-class (Channel)**: External Claude CLI sessions connected via the MCP channel server (`claude --channels server:mandible`). No lifecycle control, but rich integration: sessions self-register, tool usage is tracked for liveness, work-unit assignment works via `mandible_request_work`, and webhook events are surfaced via `mandible_check_inbox`. Channel sessions appear in the Sessions tab with a link-icon badge.
- **Second-class (PTY)**: Agents spawned via Console as PTY terminal processes. Process-level control (start, stop, signal), terminal I/O. Used for `codex`, `gemini`, shell commands, and cases where raw terminal access is needed.
- **Third-class (External)**: Agents discovered via process scan or session registration hooks. Best-effort tracking only — Mandible monitors but does not control. Used for agents started from terminal (e.g., `claude` CLI sessions in Zellij panes).

Feature design targets SDK-first: new capabilities (work-unit assignment, handoff notes, conversation branching, permission policies, cost tracking, auto-resume) are SDK-only. Channel sessions get tool-mediated access to the same features (inbox, issues, work units, auth submission). PTY and external agents get whatever can be inferred from their limited integration surface.

"Resume Work" from the Issues tab always spawns a first-class SDK session, regardless of what tier the previous session was. This is the natural upgrade path.

### Connecting via channel

To connect a Claude CLI session via the MCP channel server:
```bash
claude --channels server:mandible
```
The channel server registers the session with Mandible on startup and records tool usage for liveness tracking. Channel-connected sessions are marked with `channel_connected_at` in the sessions table and appear with a purple link badge in the dashboard.

## Mandible API quick reference

Base URL: `http://localhost:19420`

```
GET  /api/auth/queue            → list pending auth requests
GET  /api/auth/request/<id>     → request details
POST /api/auth/request          → submit new request (use CLI instead)
PUT  /api/auth/request/<id>     → update existing request (pending/failed only)
DELETE /api/auth/request/<id>   → delete request (body: {"reason":"..."})
GET  /api/events?topic=auth:    → SSE stream for auth resolution
GET  /api/inbox?branch=<b>      → session inbox (continuations, auth results)
PATCH /api/sessions/<id>        → update session (continuation_acked, etc.)
```

Note: DELETE body parsing requires "DELETE" in the method allowlist in `server.ts` (see issue 511ebaa).

## Issue tracking

Issues are stored in git-bug refs. See the open issue list with `git-bug bug`.

Key open issues by area:
- Auth queue UX: 40a3976, 0a803ab, 831cb3e, a7ef2fe, 2bce9cb
- Dashboard UI: aee671a, c58f784, b011e5b, 76ea6c6, 7a95348, e7a8bad
- Console: aea2c67, 3da19be
- Switchboard: b538b26, ab0a8f0, f03feda
- Infrastructure/bugs: 6e31c5f, 215897e, 4594641, 00b046e, f8d050b, 1ed1d90
- Tauri/desktop: fdc0e8a, dffc52f
- Long-term/future: 0af826a, dfaf93c, 4aa3e17, 5bc113d

## Architectural reflection

When making architectural changes to Mandible's backend or behavior, agents MUST explicitly reflect on `~/.claude/CLAUDE.md` (the global conventions) as part of their design process. Mandible's behavior and the global workflow conventions are tightly coupled — changes to one often imply changes to the other.

This goes beyond the standard "read CLAUDE.md before working": agents must actively reason about how a proposed change interacts with worktree conventions, issue tracking rules, commit workflows, merge protocols, and the auth queue. If a Mandible change would require or benefit from a corresponding CLAUDE.md update, file a git-bug issue in the dotfiles repo proposing the change.

Examples:
- Adding a new work-unit state → does CLAUDE.md's "Issue Registration" section need updating?
- Changing how sessions are tracked → does it affect the "Mandible Operations" section in global CLAUDE.md?
- Adding inbox behavior → does it interact with the "Session Inbox" subsection?
