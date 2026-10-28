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
release when that lane adds its helper and fixed service descriptors. Additional
non-native resource roles use `resources`; for service descriptors outside
Resources, the native adapter declares their program root and the assembler
includes those roles in the shipped file inventory.

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

The assembler retains the qualified Bun and SDK executable entitlements and
stages the native service helper/descriptors before signing. One package owner,
`scripts/build-desktop-app.mjs`, resolves the effective Tauri configuration and
signing identity, asks Tauri to assemble with `--no-sign`, then calls
`finishAppPackage(app, plan)`. Tauri's resource map, sidecars, frameworks and
native app layout remain the assembly mechanism.

Signing configuration follows the pinned Tauri CLI: the base configuration,
macOS-specific configuration, ordered `--config` JSON/JSON5/TOML patches, then
`APPLE_SIGNING_IDENTITY` over `bundle.macOS.signingIdentity`. A missing or
empty identity is an error; `-` explicitly selects a local ad-hoc candidate.
A configured distributor identity must select one available certificate; it
never falls back to ad-hoc signing. `APPLE_CERTIFICATE` and
`APPLE_CERTIFICATE_PASSWORD` optionally import a certificate into one temporary
private keychain for the whole operation, with cleanup on success or failure.
No global keychain search-list changes are needed. Source native previews
explicitly select ad-hoc signing and do not consume distributor credentials.

The order is fixed:

1. Tauri assembles an unsigned app. Its automatic signing/notarization branch is
   disabled, including when Apple credentials are present.
2. `finalizeAppPayload(app, signer)` cleans attributes and signs every native
   role with the one resolved identity. Bun and the SDK receive their retained
   role-specific entitlements; SQLite receives no executable entitlements.
3. The final native bytes are inventoried in `release.json`, then the outer app
   receives its final signature using the configured app entitlements/hardened
   runtime settings. Deep/strict signatures and the release inventory must pass.
4. When complete notarization credentials are supplied, Apple's `notarytool`
   submits that finished app, waits for acceptance, and `stapler` attaches and
   validates its ticket. Only the supported stapling operation may change the
   app after submission. Its manifest, sealed resources and main executable
   hashes remain fixed, and signature/inventory verification runs again.
5. Requested DMG/ZIP containers are created from the finished, optionally
   stapled app using Apple's `hdiutil`/`ditto`. A distributor DMG is signed
   with the same identity; it contains the notarized/stapled app. The receipt
   describes app notarization, not an independently notarized DMG.

The finalizer refuses any app that already has an app signature. Rebuilding
requires fresh unsigned assembly; it cannot destructively re-sign a finalized
or notarized package. No build step mutates app files after the final signature
or modifies signed content after notarization. Existing generated container
outputs are invalidated when a fresh unsigned assembly is finalized; failures
never present a previous container as the new package.

Notarization uses either `APPLE_ID`/`APPLE_PASSWORD`/`APPLE_TEAM_ID`, or
`APPLE_API_KEY`/`APPLE_API_ISSUER` with `APPLE_API_KEY_PATH` (or Tauri's
standard AuthKey search locations). Incomplete credentials, ad-hoc signing with
distributor credentials, rejected submission, and submission timeouts fail
clearly and preserve the signed app. There is no silent unsigned/ad-hoc or
unnotarized distribution fallback. Without notarization credentials, the
receipt records `not-requested`; public distributor qualification is not
claimed. The wrapper rejects bypass options `--no-sign`, `--no-bundle` and
asynchronous `--skip-stapling`.

Commands:

```sh
# Local candidate with the repository's explicit ad-hoc configuration.
bun run tauri:build -- --bundles app

# Containers are produced only after app finalization and requested notarization.
bun run tauri:build -- --bundles app,dmg --archive

# Distributor configuration; credentials come from the build environment.
bun run tauri:build -- --config release-signing.json --bundles app,dmg
```

The adjacent `Mandible.app.packaging.json` records the resolved certificate
identity, app notarization state, final manifest/signature digests, container
digests and operation order. Acceptance and retained-package delivery consume
the finished app after this command returns. Bun's JIT/library-loading
entitlements and SQLite's loaded native identity remain part of local runtime
qualification. Real distributor certificate import, notarization/stapling and
public distribution qualification require actual credentials and are not
inferred from local ad-hoc evidence.

The native extension-point decision follows the pinned
[Tauri app bundler](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.10.0/crates/tauri-bundler/src/bundle/macos/app.rs),
[configuration precedence](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.10.0/crates/tauri-cli/src/interface/rust.rs),
and [Apple notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow).
Tauri 2.10 does not expose a callback between nested signing, the outer
signature and notarization; post-Tauri mutation is therefore avoided by using
its supported unsigned assembly path and Apple's signing/notarization tools.

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
and MCP initialization. This is the payload gate. [Package/runtime acceptance](candidate-acceptance.md)
also drives the packaged GUI, but starts Bun/Caddy directly in a fresh isolated
home. Native upgrade transitions require the separate source-transformed
[two-hop lifecycle fixture](runtime-handoff.md#verification); the actual
post-approval handoff verifies installation and convergence of the exact retained
package. A package/runtime pass alone does not attest that upgrade.

Co-Authored-By: Codex (GPT) <codex@openai.com>
