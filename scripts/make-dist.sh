#!/bin/sh
# Bug: 88a4472 — create desktop bootstrap assets for Tauri builds.
# Keep the Tauri bootstrap separate from the daemon's generated dist/ tree.
# A native build must not overwrite dist/index.js after `bun run build`.
set -e
runtime="$(scripts/bun-runtime.sh --bun-only)"
export PATH="$(dirname "$runtime"):$PATH"
"$runtime" run build
"$runtime" scripts/generate-canonical-origin.mjs --check
bootstrap_output="${MANDIBLE_DESKTOP_BOOTSTRAP_DIR:-src-tauri/dist}"
mkdir -p "$bootstrap_output"
scripts/build-local-ca-trust-helper.sh
cp src-tauri/bootstrap/index.html "$bootstrap_output/index.html"
cp src-tauri/bootstrap/bootstrap.css "$bootstrap_output/bootstrap.css"
cp src-tauri/bootstrap/bootstrap.js "$bootstrap_output/bootstrap.js"
cp src-tauri/bootstrap/canonical-origin.js "$bootstrap_output/canonical-origin.js"
"$runtime" scripts/stage-app-payload.mjs
triple="$(rustc -vV | sed -n 's/^host: //p')"
payload_contents="${MANDIBLE_DESKTOP_PAYLOAD_CONTENTS:-src-tauri/resources/app-payload/Contents}"
binaries="${MANDIBLE_DESKTOP_BINARIES_DIR:-src-tauri/binaries}"
sqlite_library="${MANDIBLE_DESKTOP_SQLITE_LIBRARY:-src-tauri/resources/libsqlite3.dylib}"
mkdir -p "$binaries"
for name in mandible-bun mandible-caddy mandible-claude mandible-trust-helper; do
  cp "$payload_contents/MacOS/$name" "$binaries/$name-$triple"
done
cp -f "$payload_contents/Frameworks/libsqlite3.dylib" "$sqlite_library"
echo "desktop bootstrap and complete app payload generated"
