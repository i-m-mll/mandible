#!/bin/sh
set -eu

output="${MANDIBLE_DESKTOP_HELPERS:-src-tauri/resources}"
mkdir -p "$output"
if [ "$(uname -s)" = Darwin ]; then
  compiler="$(xcrun --find swiftc)"
  sdk="$(xcrun --show-sdk-path)"
  set -- -O -target "$(uname -m)-apple-macosx15.0" -sdk "$sdk"
  if [ -n "${MANDIBLE_DESKTOP_SWIFT_CACHE:-}" ]; then
    mkdir -p "$MANDIBLE_DESKTOP_SWIFT_CACHE"
    set -- "$@" -module-cache-path "$MANDIBLE_DESKTOP_SWIFT_CACHE"
  fi
  "$compiler" "$@" src-tauri/local-ca-trust-helper.swift -o "$output/local-ca-trust-helper" &
  trust=$!
  "$compiler" "$@" src-tauri/approval-helper/*.swift -o "$output/approval-helper" &
  approval=$!
  wait "$trust"
  wait "$approval"
else
  # The bundle resources exist for cross-platform builds; setup and approval
  # fail explicitly on unsupported hosts before reaching these macOS adapters.
  for name in local-ca-trust-helper approval-helper; do
    printf '%s\n' '#!/bin/sh' "echo \"$name requires macOS\" >&2" 'exit 1' > "$output/$name"
    chmod 755 "$output/$name"
  done
fi
