#!/bin/sh
# Bug: 88a4472 — create desktop bootstrap assets for Tauri builds.
# Keep the Tauri bootstrap separate from the daemon's generated dist/ tree.
# A native build must not overwrite dist/index.js after `bun run build`.
set -e
bun scripts/generate-canonical-origin.mjs --check
bun scripts/prepare-desktop-runtime.mjs
mkdir -p src-tauri/dist
scripts/build-local-ca-trust-helper.sh
cp src-tauri/bootstrap/index.html src-tauri/dist/index.html
cp src-tauri/bootstrap/bootstrap.css src-tauri/dist/bootstrap.css
cp src-tauri/bootstrap/bootstrap.js src-tauri/dist/bootstrap.js
cp src-tauri/bootstrap/canonical-origin.js src-tauri/dist/canonical-origin.js
echo "desktop bootstrap assets generated"
