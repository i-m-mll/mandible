#!/bin/sh
set -eu

output="${MANDIBLE_DESKTOP_TRUST_HELPER:-src-tauri/resources/local-ca-trust-helper}"
mkdir -p "$(dirname "$output")"
if [ "$(uname -s)" = Darwin ]; then
  compiler="$(xcrun --find swiftc)"
  set --
  if [ -n "${MANDIBLE_DESKTOP_TRUST_CACHE:-}" ]; then
    mkdir -p "$MANDIBLE_DESKTOP_TRUST_CACHE"
    set -- -module-cache-path "$MANDIBLE_DESKTOP_TRUST_CACHE"
  fi
  "$compiler" "$@" -O -target "$(uname -m)-apple-macosx15.0" -sdk "$(xcrun --show-sdk-path)" src-tauri/local-ca-trust-helper.swift -o "$output"
else
  # The bundle resource exists for cross-platform builds; setup itself fails
  # explicitly on unsupported hosts before attempting this macOS adapter.
  printf '%s\n' '#!/bin/sh' 'echo "Native macOS trust setup is unsupported on this platform" >&2' 'exit 1' > "$output"
  chmod 755 "$output"
fi
