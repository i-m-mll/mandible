#!/bin/sh
# Bug: 88a4472 — create desktop bootstrap assets for Tauri builds.
# Keep the Tauri bootstrap separate from the daemon's generated dist/ tree.
# A native build must not overwrite dist/index.js after `bun run build`.
set -e
runtime="$(scripts/bun-runtime.sh --bun-only)"
export PATH="$(dirname "$runtime"):$PATH"
"$runtime" scripts/generate-canonical-origin.mjs --check
bootstrap_output="${MANDIBLE_DESKTOP_BOOTSTRAP_DIR:-src-tauri/dist}"
mkdir -p "$bootstrap_output"
for name in index.html bootstrap.css bootstrap.js canonical-origin.js; do
  if ! cmp -s "src-tauri/bootstrap/$name" "$bootstrap_output/$name"; then
    cp "src-tauri/bootstrap/$name" "$bootstrap_output/$name"
  fi
done
echo "desktop bootstrap generated"
