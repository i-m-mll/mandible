# Visible native preview

Create or reuse an owned repository preview and build its native app:

```sh
bun run iab-preview -- --native --json
```

Native mode uses the normal candidate/owner selection. It compiles and bundles
only an app from that selected candidate, then launches a uniquely named copy.
It does not require a manually built bundle or install into `/Applications`.
The repository entrypoint returns the backend run and native subreceipt.

To attach to an already healthy selected preview without acquiring a backend:

```sh
bun run native-preview launch \
  --branch integration/mandible-iab-preview-example \
  --project <canonical-project-id> \
  --work-unit <owning-work-unit-id> \
  --agent-session "$CODEX_THREAD_ID"
```

The selected preview must have current isolation policy and exact ownership,
instance and backend generation. Its trusted HTTPS origin must serve that
instance. Missing or stale input fails without starting another daemon.
Repeating setup reuses the matching live native attachment; a separate native
instance requires the repository entrypoint's explicit new-instance option.
The low-level launcher accepts `--new-instance true`.

The host requires macOS 14 or newer for an isolated WebKit store, normal Tauri
build prerequisites and the standard macOS build/inspection utilities. No
trust installation, production bootstrap or production daemon startup occurs.

## Build custody

The native run registers its pending consumer before building. Its receipt
records its parent backend, exact candidate commit/source digest, toolchain,
build fingerprint, supervised processes, stage budgets, timings and outputs.
Each launch/rebuild claims an exact attempt identity before effects. A refused
reacquisition leaves the existing run untouched; stale failures cannot stop or
rewrite a later successful attempt.
The build uses the pinned Bun and the candidate's frozen dependencies. The
backend worktree and dependency installation remain borrowed resources.

The owned `build/` directory contains a staged native crate/config, generated
bootstrap, runtime archive copies, trust helper, Cargo target/intermediates,
Tauri schemas and app bundle. Shared preparation scripts accept explicit
output directories and retain their usual defaults for ordinary builds.
Both `CARGO_TARGET_DIR` and `CARGO_BUILD_BUILD_DIR` point inside this root;
an explicit Cargo config argument prevents inherited build-dir overrides.
Older Cargo versions that keep intermediates in target still remain contained.
Download stores and verified runtime archives are borrowed caches.

Preview builds use Tauri's debug app profile with Rust debug info disabled to
reduce compile/link latency. A persistent supervisor owns each build process
group until it is quiescent, including descendants left after a command exits.
Deadline and failure cleanup stop that group before marking a phase finished. They use the same bundling/preparation path as
ordinary builds, with `--bundles app --locked`; no installers are generated.
Repeating setup after stopping or naturally closing the app reacquires the same
run, preserves its profile/target, regenerates staged sources and rebuilds the
selected candidate. A failed relaunch retains that existing profile and warm
target with an explicit retry/cleanup reason.

Preparation has a one-minute budget. Cold native compilation has a ten-minute
upper bound; its actual time is recorded, and the owned target remains warm
until teardown. A running app's files are immutable. Stop it before
building a replacement; source changes never silently replace a live app.

The packaged `build-revision.json` must equal the selected backend's exact
candidate, and source identity is checked again after compilation. An explicit
`--bundle /absolute/noninstalled.app` is accepted only when its marker matches.
Stale bundles are refused. Failure records its cause, stops the exact spawned
processes and reclaims generated residue, or records pending cleanup and why.

Supported setup or exact backend refresh adopts older owned previews only after
verifying their retained runtime, registration and native receipts. Status remains
read-only. Adoption preserves both stopped and live native profiles and records the
unique live attachment as the default, even after it is explicitly stopped. A
missing backend source digest remains unclaimed until ordinary refresh installs
a verified build; native acquisition requires that exact source identity.

## Native isolation

The copied app has a unique bundle identifier, executable name and window title,
no production URL schemes, and an ad-hoc signature. It runs directly with an
owned `MANDIBLE_HOME`, desktop config and separate WebKit store. Inherited
Mandible runtime variables are removed from the child environment.

Navigation stays on the selected preview origin. Its remote permissions allow
window dragging, theme changes and native presentation queries. Daemon control,
connection setup, production bootstrap and deep-link handling are unavailable.

The command returns after matching page-load evidence. The native receipt
contains the bundle/build identity, exact executable/PID/process identity,
parent preview, profile, logs and window identity. Page-load evidence alone
does not prove visible frame behavior; inspect the actual window during review.

## Stop and cleanup

```sh
bun run native-preview stop --receipt /absolute/native-run/metadata.json
bun run native-preview cleanup --receipt /absolute/native-run/metadata.json --disposition discard
```

Stop validates process start identity and executable before signaling. Natural
window exit is also supported. Stop retains the parent association until the
owned profile and build bytes have been disposed. Cleanup requires explicit
profile disposition, applies owned-file/consumer checks, and retains a compact
outcome and launch receipt in the sibling `.receipts` directory. Repeat stop or
cleanup resolves that retained receipt. Foreign/replaced roots and PIDs are
refused. Unknown files remain pending rather than being deleted.

Native-only operations leave the borrowed backend healthy. Dashboard edits stay
in the backend's interactive data store. The parent preview's full teardown can
stop and clean only native children explicitly registered to that exact run,
then dispose its own resources through the shared lifecycle.

Co-Authored-By: Codex (GPT) <codex@openai.com>
