#!/bin/sh
set -eu
runtime="$(scripts/bun-runtime.sh --bun-only)"
export PATH="$(dirname "$runtime"):$PATH"
"$runtime" run build
scripts/build-local-ca-trust-helper.sh
"$runtime" scripts/stage-app-payload.mjs
triple="$(rustc -vV | sed -n 's/^host: //p')"
payload_contents="${MANDIBLE_DESKTOP_PAYLOAD_CONTENTS:-src-tauri/resources/app-payload/Contents}"
binaries="${MANDIBLE_DESKTOP_BINARIES_DIR:-src-tauri/binaries}"
sqlite_library="${MANDIBLE_DESKTOP_SQLITE_LIBRARY:-src-tauri/resources/libsqlite3.dylib}"
mkdir -p "$binaries"
for name in mandible-bun mandible-caddy mandible-claude mandible-trust-helper mandible-service; do
  cp "$payload_contents/MacOS/$name" "$binaries/$name-$triple"
done
cp -f "$payload_contents/Frameworks/libsqlite3.dylib" "$sqlite_library"
echo "complete desktop app payload generated"
