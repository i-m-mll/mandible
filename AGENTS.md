# Mandible Agent Instructions

These repo-local instructions supplement the global agent instructions and
`CLAUDE.md`.

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
