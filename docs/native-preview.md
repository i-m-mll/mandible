# Visible native preview

Build the integrated candidate without installing it:

```sh
bun run build
bun run tauri:build -- --bundles app
```

Launch against an existing healthy IAB preview selected by its launcher branch:

```sh
bun run native-preview launch \
  --branch integration/mandible-iab-preview-20261023-fe8a60d \
  --bundle "$PWD/src-tauri/target/release/bundle/macos/Mandible.app" \
  --project prj_00mpmtnfob_dea6b2e21567ce3dbac0 \
  --work-unit <owning-work-unit-id> \
  --agent-session "$CODEX_THREAD_ID"
```

The branch selects the existing `iab-preview` manifest under the normal preview
cache root (`MANDIBLE_PREVIEW_BASE_DIR` can select the launcher's existing alternate
cache). The preview must already be healthy, with current isolation policy and
matching owner, instance and generation. HTTPS must serve that exact instance
using the Mac's trusted local certificate. Missing or stale input fails without
starting or replacing a daemon. There is no URL override.

The host requires macOS 14 or newer, the normal Tauri build prerequisites, and
the macOS `ditto`, `PlistBuddy`, `plutil`, `codesign`, `curl`, `ps` and `lsof`
utilities. macOS 14 is required for the separate WebKit data store. The launcher
does not install trust, register services, or repair unavailable previews.

The launcher copies the noninstalled app into a new owned run under
`~/.cache/mandible/native-previews/`, gives that copy a unique bundle identifier,
executable name and window title, removes its URL schemes, and signs the copy
ad hoc. It runs that executable directly. The build bundle and production bundle
identity are unchanged. The owned profile supplies `MANDIBLE_HOME`, desktop
configuration and a separate WebKit store; inherited Mandible runtime variables
are removed from the child environment.

Native preview starts at the selected dashboard and retains its launch context
for the window lifetime. Navigation stays on that origin. Its remote permissions
allow window dragging, theme changes and native presentation queries. Daemon
control, connection setup, production bootstrap and deep-link handling are
unavailable. The normal production and hidden acceptance paths retain their
existing behavior.

The command returns JSON after the selected page finishes loading. Its receipt
path is `receipt`; the receipt contains `build` (commit and source digest),
`executableDigest`, source and copied bundle paths, exact executable, PID and
process identity, selected preview manifest/run/origin/instance, native owned
run, profile, logs and window identity. `window` records the native process's
matching page-load evidence. Confirm visibility and frame behavior in the actual
window as part of review.

Stop only the owned native process, then explicitly discard its browser profile:

```sh
bun run native-preview stop --receipt /absolute/native-run/metadata.json
bun run native-preview cleanup --receipt /absolute/native-run/metadata.json
```

Stop verifies the process start identity and owned executable before signaling
its PID; a reused or foreign PID is refused. Cleanup requires the native process
to be absent, applies the existing owned-run consumer and file custody checks,
and retains a compact outcome plus launch receipt in the sibling `.receipts`
directory. Closing the window naturally also permits later cleanup. Neither
operation signals, stops, replaces or removes the selected preview daemon or
production. Writes made through the dashboard remain in the selected preview's
existing data store.

Co-Authored-By: Codex (GPT) <codex@openai.com>
