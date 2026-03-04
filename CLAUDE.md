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
