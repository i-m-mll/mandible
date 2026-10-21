# Mandible

Read and follow the [local user access contract in AGENTS.md](AGENTS.md#local-user-access).

Mandible is a local-first agent control plane and conversation browser. It provides:
- An async auth queue for protected-branch merges (agent submits, user authenticates via YubiKey)
- A web dashboard (sessions, issues, conversations, console)
- A daemon that manages the local issue ledger, session lifecycle, and inbox delivery
- A Tauri native window wrapper (Level 1: thin launcher; Level 2: bundled sidecar, see issue fdc0e8a)

## Build

```bash
bun run build        # Full build (TypeScript + esbuild UI)
bun run build:watch  # UI hot-reload (esbuild watch only)
bun run dev          # TypeScript watch + UI watch (both in parallel)
bun run iab-preview  # Create/reuse an isolated integration-branch IAB preview
bun run start            # Run daemon (requires prior build)
bun run test             # Run tests (vitest)
```

## IAB integration previews

When a user asks to work on Mandible in the IAB, annotate Mandible in the
in-app browser, open Mandible from an integration branch, or run a copy-instance
of Mandible for browser iteration, start with the deterministic local launcher:

```bash
bun run iab-preview -- --json
```

This is the expected one-command path for preview setup. It creates or reuses
an `integration/mandible-iab-preview-*` worktree, copies the live Mandible DB
into `~/.cache/mandible/previews/`, starts a persistent preview daemon on a
free local port, verifies `/api/health`, and returns the URL, branch, worktree,
database copy, launch label, and log paths. After it succeeds, use the Codex
Browser/IAB skill to open the returned `freshUrl`.

If the current checkout is already a non-protected `integration/*` preview
branch and the recorded preview is healthy, the launcher reports that existing
instance and does not create another branch. Use `--force-new` only when the
user explicitly needs a separate integration branch/instance. Do not interfere
with another running preview branch or daemon unless the user explicitly asks
for that specific instance to be restarted or replaced.

## Repo conventions

- **Protected branch:** `main`
- **Feature branches:** `feature/<name>`
- **Integration branches:** `feature/<name>` when aggregating child branches
- **Sub-branch separator:** `__` (e.g., `feature/stage1__sim-oracle`) — Git refuses path-based refs that conflict
- **Agent commits:** use agent signing key (GIT_CONFIG_COUNT pattern from dotfiles CLAUDE.md)
- **Auth requests:** `mandible auth request <branch> --ref-issue <id> --no-watch`
- **Worktrees:** `wt <branch>` from dotfiles tooling (`~/.dotfiles/bin/wt`)

## Database

Uses the shared `src/sqlite.ts` storage boundary backed by the pinned Bun SQLite runtime. Schema migrations live in `src/db-migrations.ts`.

**Always add new columns/tables via a new migration entry** — never via ad-hoc `CREATE TABLE IF NOT EXISTS` in individual modules. The `ensureSchema()` functions are fallbacks for fresh databases only; they do NOT alter existing tables.

### Reading the ledger directly

For counts, joins, and other queries the structured commands do not cover, use
`mandible db`:

```bash
mandible db tables                      # tables and views
mandible db schema ledger_issues        # exact CREATE statements
mandible db query "select count(*) from ledger_issues"
mandible db info                        # path, journal mode, WAL bytes
```

`src/db-read.ts` opens the database `SQLITE_OPEN_READONLY` with `query_only`,
refuses any statement SQLite does not classify as both read-only and
row-returning, and
imports no migration code. It reads the write-ahead log, so its answers are
current.

The database is in WAL mode, so a `sqlite3 'file:...mandible.db?immutable=1'`
open answers from the main file alone and returns rows that are behind — or
missing entirely — with no error (issue 78163ba). `mandible db` cannot be
pointed at a URI filename, which is the only way to spell that.

## Work units

The `work_units` table tracks the dispatch state of issues through their lifecycle: open → committed → resolved (+ abandoned). Work units join the issue ledger, branch tree (git worktrees), and session tree (agent sessions) into a single reconciliation layer. The work-unit table was designed as part of umbrella issue f3dbb3e ("Inbox redesign: work-queue dispatch model") — its body contains the full design, not just the inbox UI.

Key conventions:
- `wt --issue <id>` registers a work unit and writes a `.issue` file for auto-discovery
- `agent-commit` auto-discovers the issue from `.issue` if `--issue` is not passed explicitly
- Liveness (is an agent currently working?) is derived at query time, not stored as a state
- Work units are the source of an issue's branches and in-progress state; readers derive both in `src/ledger/issue-work-state.ts`. Stored `worker_status` keeps only explicit `done`, `blocked`, or `pivot-needed`, and `issue_branches` keeps only branches without a work unit and the `superseded` role
- Continuations (handoff notes) live on the work unit, not on individual sessions

## Test suites

The flat `test/*.test.{ts,tsx}` directory is the default contract suite, selected
by `vitest.config.ts`. See [test/README.md](test/README.md) for the maintained default,
extended, quarantine, and browser gates. External runtime fixtures remain in
explicit provisioned suites.

## Dist files

Do **not** commit `dist/` or `ui/dist/` in feature branches or integration
branches. They are local runtime build outputs and are rebuilt locally after
merge by the Mandible post-merge build hook. Before delivery, verify generated
output hygiene with:

```bash
git ls-files dist ui/dist
git status --short --ignored dist ui/dist
```

`git ls-files dist ui/dist` should return no tracked files.

## Dataful UX state

Mandible dataful workspaces must preserve user-visible state unless the user
explicitly changes or resets it. Unexpected resets are bugs.

- Preserve per-workspace and per-project view state across tab switches,
  project switches, route changes, refreshes, daemon syncs, and app restarts
  when the state represents user intent.
- Treat backend refreshes, polling, SSE events, and refetches as reconciliation
  inputs, not as reasons to collapse panes, clear selections, reset filters,
  lose scroll/zoom position, or flicker UI structure.
- Keep URL-shareable state, browser-local state, project defaults, and
  ledger-backed persisted state distinct in types and code paths. Do not
  silently promote local view state into canonical project or ledger state.
- Resets, destructive state changes, and canonical mutations must be caused by
  explicit user actions with clear affordances.
- Use consistent contracts for rows, events, refs, entities, and selections so
  a new entity type does not become a special edge case that bypasses normal
  rendering, persistence, navigation, or accessibility behavior.

For Timeline specifically, the shared global time axis is a contract: changing
expansion or row visibility changes the visible row tree, never the meaning of
horizontal time coordinates.

## Worktree build notes

Each worktree owns its dependencies. Inspect shared links before setup, then
use the verified runtime with a frozen install in the issue-linked worktree:

```bash
runtime_path="$(scripts/bun-runtime.sh)"
export PATH="$(dirname "$runtime_path"):$PATH"
"$runtime_path" install --frozen-lockfile
"$runtime_path" run build
```

Do not copy or mutate another worktree's dependencies. The canonical
[installation guide](docs/getting-started/installation.mdx) and
[Bun contract](docs/bun-foundation.md) describe runtime setup.

## Auth flow

The auth queue is the mechanism for protected-branch merges. Full protocol is in the dotfiles CLAUDE.md (`~/.claude/CLAUDE.md`). Key points:
- Agent submits: `mandible auth request <branch> --ref-issue <id> --no-watch`
- User approves via dashboard or terminal pane
- `auth-merge` runs the actual `git merge --gpg-sign` with YubiKey
- Auth results arrive in the session inbox at next session start
- `--issue` / `--ref-issue` attach reference-only issue context for review and tracking; they do not close issues on merge
- Use `--closes-issue <id>` only when a successful protected-branch merge should close that issue
- The Git `reference-transaction` guard (`hooks/git/reference-transaction`) refuses local protected-branch updates whose new tip is not operator-signed; the daemon keeps its projection under `~/.mandible/git-guard/`. See [protected-branch guard](docs/protected-branch-guard.md)

### Production runtime gate

For a candidate that can affect Mandible daemon or desktop runtime behavior,
the late pre-auth integration bar must launch the production daemon and
packaged desktop app together from the exact candidate revision, not use a
development or preview substitute. Probe startup completion and health,
exercise one representative interaction, then inspect logs captured from that
launch for crash or restart loops, repeated-event storms, database or
foreign-key errors, and event-loop stalls or starvation. Any unexplained
occurrence fails the gate. Run this once after the candidate stabilizes, and
rerun it only when a later change can affect the result.

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
GET  /api/auth/queue            → list active auth queue
GET  /api/auth/request/<id>     → request details
POST /api/auth/request          → submit new request (use CLI instead)
PUT  /api/auth/request/<id>     → revise existing request (pending only)
POST /api/auth/request/<id>/withdraw → exact requester withdraws pending request with a reason
DELETE /api/auth/request/<id>   → retired; returns 410 without deleting history
GET  /api/events?topic=auth:    → SSE stream for auth resolution
GET  /api/inbox?branch=<b>      → session inbox (continuations, auth results)
PATCH /api/sessions/<id>        → update session (continuation_acked, etc.)
```

Use `mandible auth list` to inspect the active queue when an auth request ID is
unknown; use `GET /api/auth/queue` as the raw API fallback.

Auth requests and their hashed lifecycle revisions are durable records. Operator rejection and exact-requester withdrawal are distinct transitions; changed reviewed bytes require explicit supersession.

## Issue tracking

Use `mandible issue` commands for issue reads and writes. The legacy git-bug
mirror, import, and export paths have been retired; retained git-bug provenance
is historical data, not an operational compatibility surface. See the open
issue list with `mandible issue list --status open`.

For agent planning or handoff context, prefer `mandible issue report <id> --json`
before manually reconstructing issue state. It is a deterministic fact packet,
not an agentic synthesis of remaining work. Use `mandible issue triage` for
read-only filtering of open, stale, or labeled issue sets.

For conversation/history audits, keep the source surfaces distinct:
`mandible logs ...` inspects provider-native source logs as the veridical
transcript record, while `mandible conversations ...` inspects Mandible's
normalized SQLite index for UI, search, export, and metadata workflows.

When updating provider parsers under `src/parsers/`, update the normalized
block contract and provider capability metadata in `src/parsers/types.ts` and
`src/parsers/capabilities.ts` in the same change. Parser tests should cover any
new block type, role, tool metadata, timestamp behavior, or provider limitation
that affects `mandible logs inspect --parse` or `mandible conversations blocks`
filters.

Key open issues by area:
- Auth queue UX: 40a3976, 0a803ab, 831cb3e, a7ef2fe, 2bce9cb
- Dashboard UI: aee671a, c58f784, b011e5b, 76ea6c6, 7a95348, e7a8bad
- Console: aea2c67, 3da19be
- Infrastructure/bugs: 6e31c5f, 215897e, 4594641, 00b046e, f8d050b, 1ed1d90
- Tauri/desktop: fdc0e8a, dffc52f
- Long-term/future: 0af826a, dfaf93c, 4aa3e17, 5bc113d

## Architectural reflection

When making architectural changes to Mandible's backend or behavior, agents MUST explicitly reflect on `~/.claude/CLAUDE.md` (the global conventions) as part of their design process. Mandible's behavior and the global workflow conventions are tightly coupled — changes to one often imply changes to the other.

This goes beyond the standard "read CLAUDE.md before working": agents must actively reason about how a proposed change interacts with worktree conventions, issue tracking rules, commit workflows, merge protocols, and the auth queue. If a Mandible change would require or benefit from a corresponding CLAUDE.md update, file a Mandible issue in the dotfiles repo proposing the change.

Examples:
- Adding a new work-unit state → does CLAUDE.md's "Issue Registration" section need updating?
- Changing how sessions are tracked → does it affect the "Mandible Operations" section in global CLAUDE.md?
- Adding inbox behavior → does it interact with the "Session Inbox" subsection?
