# Bundle-owned macOS services

The installed app owns two logged-in-user agents: `backend` and `gateway`.
`scripts/bundle-services.json` declares their label suffixes. The signed app
contains `Contents/MacOS/mandible-service`, the pinned Bun/Caddy executables,
and fixed `Contents/Library/LaunchAgents` descriptors. `BundleProgram` locates
the native helper relative to the app. No user path or launch preference is
written into a signed descriptor. SMAppService owns registration; the GUI is
not the services' parent process.

Build the small helper with
`MACOSX_DEPLOYMENT_TARGET=13.0 cargo build --locked --release --manifest-path src-tauri/service-helper/Cargo.toml`.
Before final payload hashing/signing, call `stageBundleServices(contents, helper)`
from `scripts/prepare-bundle-services.mjs`. The payload manifest must include
the native `serviceHelper` role, both descriptors, and the `scripts/` closure.
The helper uses the objc2 Service Management binding, available from macOS 13.
The app declares macOS 15 as its minimum, matching the bundled trust helper's
deployment target and the installed command baseline. Current qualification
is macOS arm64.

## Runtime and mutable state

Every installed controller/foreground launch supplies `MANDIBLE_RELEASE_ROOT`
as `Contents/Resources`. `installedRuntimeEnvironment` supplies package-owned
runtime and dependency paths. An installed GUI refuses missing resources;
it never selects a source checkout or extracts an ambient runtime installation.
Foreground services run from their bundle, load the installation's canonical
authority/instance registration, and report the shipped release generation.

The OS account retains `~/.mandible` and `~/.cache/mandible`. Existing
authority, database/WAL, CA state, and `service-config.json` are preserved.
`config/local-sessions/bundle-owner.json` binds installation authority,
bundle location, and release provenance. `bundle-launch.json` holds launch
mode, enabled roles, and the boot UUID plus GUI login-domain handle. A manual
start survives GUI exit but does not start the backend in a later login
session. An on-demand registration starts at login. Stopping the backend
preserves a shared gateway while registered previews still need it.

Native registration reports `not_registered`, `enabled`, `requires_approval`,
or `not_found`. `enabled` is separate from daemon readiness. The bootstrap
offers System Settings for denied background permission. Existing health,
TLS/authority, startup epoch and service ownership observations determine
readiness. Ordinary local OS-user access has no expiring session.

## Lifecycle and delivery boundary

`scripts/local-runtime.mjs` selects the bundle adapter only in explicit
installed context. It retains the installation gateway lock, pending-handoff
guard, shared service inspector and existing readiness classifier. Source
previews retain their source adapter; isolated homes cannot register the
production bundle services.

The adapter supports `status`, `install`, `start`, `stop`, `restart`,
`configure-launch-mode`, `reload-gateway`, `repair`, `remove` and
`background-settings`. Removal unregisters owned agents and removes their
owner binding; durable data/configuration remain. It refuses removal or
relocation while previews need the shared gateway. Registration denial is
reported without changing macOS permission preferences.

`admitBundleOwner` is read-only. A duplicate location, changed authority, or
different release is refused before setup/registration. `repair` can adopt
a moved app only when the previous location is absent and release provenance
matches. The inspector checks launchd's native bundle/program identity and
the actual running executable path before stop/restart. It waits for captured
process identities to disappear after asynchronous native unregister.

The exact-package delivery transaction owns drain/journal/publication and
legacy runner removal. After draining and removing legacy definitions, it
calls `adoptBundleRelease(context, release, expectedOwner)` under its lifecycle
lock. This compares the captured owner, requires stopped writers and absent
legacy definitions, and binds the accepted release. The transaction then
invokes installed `start` and verifies exact package/generation convergence.
First launch never silently migrates a live source runner or replaces a
different release. Linux/Windows adapters can implement the same roles,
registration observations, owner admission and readiness boundary; no native
support for those platforms is included here.

## Qualification

`scripts/prove-bundle-services.mjs` creates and signs a private app with unique
service labels, registers its bundled helper through SMAppService, confirms
bundle-only foreground execution and heartbeats after the registration app
process exits, then unregisters and removes the fixture. It uses a signed
fixture-only resource for an isolated home, admitted only by a
`bio.mll.mandible.fixture.*` bundle identifier. It never uses production labels
or production state. The helper crate and fixture run independently of a full
Tauri/payload rebuild. Full daemon, gateway, GUI, replacement and clean-machine
qualification belongs to exact-candidate package acceptance.

Co-Authored-By: Codex (GPT) <codex@openai.com>
