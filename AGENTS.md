# Mandible Agent Instructions

These repo-local instructions supplement the global agent instructions and
`CLAUDE.md`.

## Local user access

- Mandible belongs to the logged-in OS user.
- Opening it always gives that user access.
- Time passing, inactivity, restarting, or refreshing must never revoke that access.
- Human authorship, agent identities, and approval requirements remain intact.

Ordinary local access has no login, logout, pairing, or expiring user session.
Do not reintroduce those concepts behind automatic renewal or recovery flows.
Future multi-user support requires an explicit product decision.

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

The in-development application theme is `codex`: during IAB review, theme
feedback without another named target belongs in its shared tokens and shared
components, not view-specific overrides. Ask which theme only after `codex` is
declared complete or the user explicitly introduces another theme.

## Dataful UX State

Mandible dataful workspaces must preserve user-visible state unless the user
explicitly changes or resets it. Unexpected resets are bugs.

Design smooth state transitions that preserve useful content instead of narrating
internal activity. Use placeholder text only as hints in input fields. Never claim
a conversation is empty until its emptiness has been confirmed.

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

## Data-view composition

Build data views from the shared composition primitives first. Detail panes use
`DetailPaneShell` for one anchored header, one scrolling body, and an optional
anchored footer; compose the header with the typed `DetailPaneHeader` standard,
compact, or versioned variant. A bespoke shell or header requires a concrete written
justification naming the missing shared-contract capability before it is added.
Do not reproduce identity/copy controls, long canonical IDs, or action bars in
the scrolling body.

## Production runtime gate

Approving a merge request for this repository requires a passing candidate
acceptance of its exact candidate, which the daemon runs automatically and the
request view shows. No development or preview build substitutes for it. See
[candidate acceptance](docs/candidate-acceptance.md) and
[runtime handoff](docs/runtime-handoff.md).

