# Mandible Agent Instructions

These repo-local instructions supplement the global agent instructions and
`CLAUDE.md`.

## Mandible IAB Preview Launcher

When the user asks to work on Mandible in the IAB, annotate Mandible in the
in-app browser, open Mandible from an integration branch, or otherwise run a
copy-instance of Mandible for browser iteration, use the deterministic local
launcher first:

```bash
npm run iab-preview -- --json
```

The launcher creates or reuses an `integration/mandible-iab-preview-*`
worktree, copies the Mandible database into `~/.cache/mandible/previews/`,
starts a persistent preview daemon on a free local port, verifies health, and
prints the URL plus branch/worktree/log metadata. After it succeeds, the only
remaining browser step should be opening the returned `freshUrl` in the Codex
IAB using the browser skill.

If you are already on a non-protected `integration/*` preview branch and its
preview is healthy, the launcher reports the existing instance instead of
creating another branch. Use `--force-new` only when the user explicitly needs
a separate integration branch/instance. Do not restart or replace an unrelated
running preview instance unless the user explicitly asks for that exact action.

## Dataful UX State

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
