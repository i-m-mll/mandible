#!/bin/sh
set -eu

output="src-tauri/resources/local-ca-trust-helper"
mkdir -p src-tauri/resources
if [ "$(uname -s)" = Darwin ]; then
  compiler="$(xcrun --find swiftc)"
  "$compiler" -O -target "$(uname -m)-apple-macosx15.0" -sdk "$(xcrun --show-sdk-path)" src-tauri/local-ca-trust-helper.swift -o "$output"
else
  # The bundle resource exists for cross-platform builds; setup itself fails
  # explicitly on unsupported hosts before attempting this macOS adapter.
  printf '%s\n' '#!/bin/sh' 'echo "Native macOS trust setup is unsupported on this platform" >&2' 'exit 1' > "$output"
  chmod 755 "$output"
fi
