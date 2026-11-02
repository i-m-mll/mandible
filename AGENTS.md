# Mandible Agent Instructions

## Local user access

Mandible belongs to the logged-in OS user. Opening it always gives that user access; inactivity, time, restart, or refresh must never revoke it. Ordinary local access has no login, logout, pairing, or expiring user session. Do not reintroduce these through renewal or recovery flows. Human authorship, agent identities, and approval requirements remain intact. Multi-user access requires an explicit product decision.

## IAB previews and theme

When asked to work on or annotate Mandible in the in-app browser, open an integration branch there, or run a copy-instance for browser iteration, start with:

```sh
bun run iab-preview -- --json
```

The launcher creates or reuses an isolated preview with a copied database, checks its health, and reports the URL and ownership metadata. Open its `freshUrl` in the IAB. A non-protected checkout can preview itself; a protected checkout creates or reuses an integration preview worktree. Use `--force-new` only when the user explicitly needs a separate instance. Do not restart or replace an unrelated preview without an explicit request for that instance.

The in-development theme is `codex`. During IAB review, theme feedback without another named target belongs in its shared tokens and components. Ask which theme only after `codex` is declared complete or the user names another theme.

## UI/UX

Be careful to follow your global instructions. Use consistent row, event, ref, entity, and selection contracts. Unify and centralize components with the same job, rather than reinventing the wheel or finding a new way to display the same kind of thing. For example:
- if you need a foldable box with a title, use the same component we use for Approval descriptions, references, etc.
- if you want to display an error or warning, use the existing callout-header component.

Build data views from shared composition primitives. Detail panes use `DetailPaneShell` for one anchored header, a scrolling body, and an optional anchored footer; compose the header with the typed `DetailPaneHeader` standard, compact, or versioned variant. A bespoke shell or header requires a written justification naming the missing shared-contract capability. 

Do not roll your own SVG icons unless the user asks you to. 

Preserve user-visible state unless the user or explicitly changes or resets it. Unexpected resets are bugs, except where explicitly stated and confirmed otherwise. Preserve per-workspace and per-project intent across navigation, refreshes, daemon syncs, and restarts. Treat polling, SSE, and refetches as reconciliation inputs, not reasons to clear selections, collapse panes, reset filters, lose scroll or zoom, or flicker structure.  Keep URL-shareable state, browser-local state, project defaults, and canonical ledger state distinct; do not silently promote local state into the ledger.  Canonical mutations require explicit user actions with clear affordances. 

Preserve useful content during transitions. Timeline has one shared global time axis: expansion or row visibility changes the visible row tree, not the meaning of horizontal time coordinates.

Do not embed descriptions or prose in the UI, except where there is an explicit reason to do so, and you confirm with the user. Similarly,  do not use text to explain to the user what is going on with the app state; for example, if you anticipate a short delay in loading entity details, a chat stream, et cetera, do not print text such as "Loading data" in the detail area; instead, optimize the loading to be quick, and trust the user to raise an issue, if they are confused by the UX. In  any case, interaction should be governed by visual affordances and where necessary, minimal action labels, such as in context menus or on buttons. Where sensible, prefer icons without background (except on hover) or borders, to buttons with text. Use hover tips (ours — not native styling) extensively. Minimal muted placeholder text is okay in text entry fields, but only serves as an input hint. 

The main area of a view's detail pane is for data, not metadata. Metadata should be accessible through an entity's ellipsis menu in the header of the respective view.

## Development contracts

Follow the [development guide](README.md#development), [pinned Bun setup](docs/bun-foundation.md), [test policy](test/README.md), and [instruction sources](docs/instruction-sources.md) for runtime, schema, test, generated-output, and interface-contract changes. The SQLite boundary is `src/sqlite.ts`; use `mandible db` for direct read-only ledger queries so reads include the WAL. An `immutable=1` SQLite URI can silently omit current WAL data.

Never propose changes that would violate our policies downstream. For example, the Mandible app should never require the user to copy and run a shell command to get past some blocker, when that blocker could have been avoided with a better design.

If you find violations of any of any of these project instructions: It's Always Time to Do The Right Thing.

When Mandible interface or lifecycle behavior changes, check the current global instructions and Mandible skill for affected workflows; propose necessary policy updates in the dotfiles repository. Keep user-specific workflow conventions out of product mechanisms; see [contract vs. policy](docs/contract-vs-policy.md).

Before ad hoc migration or repair of live data, take a fresh, consistent full SQLite online backup into durable storage such as `~/.mandible/backups/`.  Scheduled metadata backups are separate and do not guarantee a pre-migration snapshot. Test migrations on private fixtures or copies, never the live database; see the [test policy](test/README.md). New or ad hoc repairs should default to a dry run and check integrity in scope or compare foreign-key violations before and after, so unrelated pre-existing violations do not block valid repairs.

When changing provider parsers under `src/parsers/`, update the normalized block contract and capability metadata in `src/parsers/types.ts` and `src/parsers/capabilities.ts` in the same change. Test changes to block types, roles, tool metadata, timestamps, and provider limitations that affect log or conversation block filters. Provider-native logs are the source transcript; Mandible conversations are the normalized index.

For runtime self-update requests in scope, the daemon runs package/runtime acceptance for the exact candidate, and approval requires a pass. Preview and development builds do not substitute for it. The scope and behavior are in [candidate acceptance](docs/candidate-acceptance.md); upgrade qualification is separate, as described in [runtime handoff](docs/runtime-handoff.md).
