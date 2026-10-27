#!/bin/sh
# Bug: 88a4472 — create desktop bootstrap assets for Tauri builds.
# Keep the Tauri bootstrap separate from the daemon's generated dist/ tree.
# A native build must not overwrite dist/index.js after `bun run build`.
set -e
bun run build
bun scripts/generate-canonical-origin.mjs --check
bootstrap_output="${MANDIBLE_DESKTOP_BOOTSTRAP_DIR:-src-tauri/dist}"
mkdir -p "$bootstrap_output"
scripts/build-local-ca-trust-helper.sh
cp src-tauri/bootstrap/index.html "$bootstrap_output/index.html"
cp src-tauri/bootstrap/bootstrap.css "$bootstrap_output/bootstrap.css"
cp src-tauri/bootstrap/bootstrap.js "$bootstrap_output/bootstrap.js"
cp src-tauri/bootstrap/canonical-origin.js "$bootstrap_output/canonical-origin.js"
bun scripts/stage-app-payload.mjs
triple="$(rustc -vV | sed -n 's/^host: //p')"
mkdir -p src-tauri/binaries
for name in mandible-bun mandible-caddy mandible-claude mandible-trust-helper; do
  cp "src-tauri/resources/app-payload/Contents/MacOS/$name" "src-tauri/binaries/$name-$triple"
done
cp src-tauri/resources/app-payload/Contents/Frameworks/libsqlite3.dylib src-tauri/resources/libsqlite3.dylib
echo "desktop bootstrap and complete app payload generated"
