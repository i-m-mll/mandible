# External Surface Inventory

This operation preserves the following consumer-visible contracts.

## Package And Entrypoints

- npm package: `@mll/mcp-mandible`
- package version: `0.1.0`
- package entrypoint: `dist/index.js`
- package binary: `dist/index.js`
- package scripts: `build`, `build:server`, `build:channel-server`, `build:ui`, `build:watch`, `dev`, `start`, `postinstall`, `test`, `tauri`, `tauri:build`
- channel server binary path used by scripts/runtime: `dist/channel-server/index.js`
- generated `dist` and `ui/dist` artifacts are intentionally untracked and rebuilt locally after protected-branch merge.

## CLI

The `mandible` dispatcher exposes shell subcommands through `cli/` scripts. Preserve command names, documented flags, positional arguments, stdout/stderr machine-readable shapes, and exit-code semantics unless a compatibility path is recorded.

- `mandible auth request <branch>` with documented flags including `--title`, `--commit-message`, `--diff-summary`, `--spec`, `--repo`, `--cwd`, `--target`, `--depends-on`, `--issue`, `--ref-issue`, `--closes-issue`, `--type`, `--handoff`, `--timeout`, `--force`, and `--no-watch`
- `mandible auth merge <source-branch>` including `--into` and `--hierarchical`
- `mandible conversations list|show|blocks|export|search`
- `mandible inbox`, `inbox check`, `inbox add`, `inbox ack`, `inbox watch`
- `mandible logs` and parsed-log inspection commands implemented by `cli/logs.sh`
- `mandible search`
- `mandible task`
- `mandible wrap`
- `dwt <branch> [--force] [--keep-branch]`
- maintenance scripts under `scripts/` that are invoked by package scripts or documented workflow commands

## HTTP And Realtime API

Preserve route paths, methods, request fields, response envelopes, status codes, SSE event topics, and WebSocket URL shape for all registered routes:

- health/static/realtime: `/api/health`, `/api/events`, `/api/events/subscribe`, `/terminal/:sessionId`
- auth queue: `/api/auth/*`
- auth hooks: `/api/auth/hooks*`
- backup: `/api/backup/*`
- chats: `/api/chats/*`
- console: `/api/console/*`
- conversations: `/api/conversations*`
- graph: `/api/graph`
- inbox: `/api/inbox*`
- issues and ledger issue routes: `/api/issues*`, `/api/ledger/*`
- providers/artifacts/knowledge backrefs: `/api/providers*`, `/api/artifacts*`, `/api/provider-manifests/*`, `/api/knowledge-backrefs*`
- presets: `/api/presets*`
- review: `/api/review/*`
- runtime: `/api/runtime/*`
- sessions: `/api/sessions*`
- settings: `/api/settings*`
- switchboard: `/api/switchboard/*`
- system/admin: `/api/system/*`, `/api/admin/rebuilding`
- webhooks: `/api/webhooks*`
- work and work units: `/api/work*`, `/api/work-units*`

## Database And Ledger

Preserve the SQLite schema as an external contract unless using additive migrations. Existing table/column names, migration ordering, `CURRENT_SCHEMA_VERSION`, event IDs, outbox IDs, issue aliases, relationship labels, and compatibility mirror behavior must remain readable by existing databases and git-bug bridge users.

## Environment And Config

Preserve these environment/config names and fallback behavior:

- `MANDIBLE_DB`
- `MANDIBLE_PORT`
- `MANDIBLE_BASE`
- `MANDIBLE_PID_FILE`
- `MANDIBLE_ENTRY`
- `MANDIBLE_SESSION_ID`
- `MANDIBLE_ARTIFACT_DIR`
- `MANDIBLE_HOME`
- `MANDIBLE_POST_MERGE_BUILD_COMMAND`
- `LOG_LEVEL`
- provider/session variables consumed for integration: `SESSION_ID`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CWD`, `CLAUDE_NOTIFY_CALLBACK`, `HOME`, `USERPROFILE`, `PATH`, platform app-data variables
- config files under `~/.cache/mandible`, `~/.config/mandible`, `.dotfiles` integration paths, and repo registry files read by the scanner/runtime

## Tauri/Desktop Shell

Preserve the Tauri package identity, bootstrap app behavior, generated schema/capability files, icon assets, and daemon sidecar launch behavior.

## Deferred Compatibility Changes

None recorded at this stage.
