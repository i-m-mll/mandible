#!/bin/sh
# Bug: 88a4472 — create desktop bootstrap assets for Tauri builds.
# Keep the Tauri bootstrap separate from the daemon's generated dist/ tree.
# A native build must not overwrite dist/index.js after `bun run build`.
set -e
bun scripts/generate-canonical-origin.mjs --check
bun scripts/prepare-desktop-runtime.mjs
bootstrap_output="${MANDIBLE_DESKTOP_BOOTSTRAP_DIR:-src-tauri/dist}"
mkdir -p "$bootstrap_output"
scripts/build-local-ca-trust-helper.sh
cp src-tauri/bootstrap/index.html "$bootstrap_output/index.html"
cp src-tauri/bootstrap/bootstrap.css "$bootstrap_output/bootstrap.css"
cp src-tauri/bootstrap/bootstrap.js "$bootstrap_output/bootstrap.js"
cp src-tauri/bootstrap/canonical-origin.js "$bootstrap_output/canonical-origin.js"
echo "desktop bootstrap assets generated"
