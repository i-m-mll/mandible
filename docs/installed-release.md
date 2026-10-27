# Installed release resources

Mandible's immutable program files stay in the installed application. Durable
state uses `~/.mandible`; disposable state uses `~/.cache/mandible`. An installed
release never installs dependencies, compiles, discovers a checkout, or selects
a developer runtime store while starting.

## Manifest and paths

`release.json`, schema `mandible-installed-release@1`, is located by the native
launcher. Its root is a manifest locator. `layout.kind` selects the native path
adapter, and `layout.roots` names the permitted program roots. The implemented
`macos-app` layout declares resources `.`, executables `../MacOS`, and libraries
`../Frameworks`, relative to `Contents/Resources`. Other platform layouts can
resolve their own program directories through the adapter without changing the
logical resource roles. They are not implemented or qualified yet.

The manifest contains version, target, source commit/digest, commit summary/date,
qualified Bun revision, original native qualification digests, entrypoints,
native resource roles, and a SHA-256/size inventory of the shipped payload.
The final package acceptance receipt must bind the manifest and whole app; the
manifest cannot contain its own signature digest.

| Entrypoint | Role |
| --- | --- |
| `daemon` | Built daemon with its worker module tree |
| `cli` | Public command dispatcher |
| `channel` | Built MCP channel subprocess |
| `controller` | Shared lifecycle controller |
| `trustSetup` | Narrow local trust setup controller |
| `service` | Native service launcher, supplied by the lifecycle lane |

Native roles are `bun`, `sqlite`, `caddy`, `claude`, `trustHelper`, and the
lifecycle lane's `serviceHelper`. The service roles become part of the assembled
release when that lane adds its helper and fixed service descriptors.

`scripts/installed-release.mjs` and its declaration file export:

- `readInstalledRelease(root)`: validate the target, identity and declared files.
- `releaseFile(root, relative)`: resolve a declared resource within native program
  roots; reject missing resources and links to another installation.
- `verifyInstalledRelease(root)`: verify the complete shipped file inventory.
- `installedRuntimeEnvironment(root, environment)`: produce the installed
  runtime/SQLite/Caddy/trust-helper/CLI environment and remove archive overrides.
- `installedResourceRoot()`: return explicit installed context or the installed
  module's own resource root; source modules return no installed context.

`MANDIBLE_RELEASE_ROOT` selects an installed release explicitly. The packaged
module also has an installed build context, so removing its manifest fails
instead of selecting the source runtime store. Native release builds require
the manifest. Debug source development retains its explicit source paths.

## Assembly and signing

`bun run tauri:build -- --bundles app` builds and finalizes a complete Mac app.
Tauri uses its normal resource map, external binaries and framework mechanisms.
`scripts/make-dist.sh` selects the qualified runtime, builds TypeScript/UI,
builds the trust helper and calls `stageAppPayload(contents)`. It refuses stale
compiled output. The assembler copies the production dependency graph, built
daemon/channel/worker modules, UI shell/assets, CLI/hooks, command grammar,
instruction resources, runtime scripts and lock provenance. Runtime script
imports of source modules are mapped to built modules. Source/build workflows
continue using the repository's selector and revision validation.

The Claude SDK's native executable is moved out of the JavaScript dependency
directory into `Contents/MacOS`; SDK invocation and provenance select it
explicitly. Qualified Bun/Caddy live there too, while SQLite lives in
`Contents/Frameworks`. The SQLite staging copy is writable for the bundle's
attribute cleanup/signing; its qualified build-store source is untouched.

The assembler retains the qualified Bun and SDK executable entitlements. After
Tauri signs nested code, `finalizeAppPayload(app)` reapplies those role-specific
entitlements and inventories its final
shipped bytes, preserves signing metadata while signing the app envelope again,
then verifies deep/strict signatures and the release inventory. This accounts
for signature changes to native file digests while retaining original runtime
qualification identity. Keeping Bun's JIT and library-loading entitlements is
required for the packaged runtime to load SQLite under hardened signing; the
GUI and native libraries do not receive those runtime entitlements. SQLite also
checks its loaded native version/source ID.
Acceptance and distribution containers must consume this finalized app. The
current build command creates the `.app`; creating a DMG/archive must happen
after finalization. Notarization and distributor signing require their configured
credentials and final distribution qualification.

The lifecycle lane stages its helper/descriptors before manifest finalization.
Installed command registration and provider integrations use these resources;
remaining command behavior changes are delivered by that lane, rather than
shipping a Python runtime or depending on the developer checkout.

## Behavioral proof

After a build, `bun run test:app-payload` stages an isolated copy. To exercise
the final signed app, pass its resource directory:

```sh
bun run test:app-payload -- src-tauri/target/release/bundle/macos/Mandible.app/Contents/Resources
```

The proof copies the app away from the checkout, verifies its signature and
manifest, then uses macOS sandbox rules to deny the source checkout, dotfiles,
developer dependency/runtime stores, Homebrew and ambient Bun. Its isolated
home contains its own ledger, authority, socket and caches; app resources are
read-only. It requires ready/warm daemon health with shipped provenance, the
bundled UI, a ledger-worker request, a CLI SQLite query, native SDK execution,
and MCP initialization. This is the payload gate. Integrated candidate
acceptance still owns native service lifetime, GUI interaction, installation
adoption and accepted-package activation.

Co-Authored-By: Codex (GPT) <codex@openai.com>
