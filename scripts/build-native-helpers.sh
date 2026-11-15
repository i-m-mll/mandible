#!/bin/sh
set -eu

output="${MANDIBLE_DESKTOP_HELPERS:-src-tauri/resources}"
approval="$output/MandibleApproval.app/Contents"
rm -rf "$output/MandibleApproval.app"
mkdir -p "$approval/MacOS" "$approval/Resources"
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
  "$compiler" "$@" src-tauri/approval-helper/*.swift -o "$approval/MacOS/mandible-approval-helper" &
  helper=$!
  wait "$trust"
  wait "$helper"
  # The Touch ID sheet names and badges the calling program by its bundle.
  plist="$approval/Info.plist"
  plutil -create xml1 "$plist"
  plutil -insert CFBundleIdentifier -string "$(plutil -extract identifier raw src-tauri/tauri.conf.json).approval" "$plist"
  plutil -insert CFBundleName -string "$(plutil -extract productName raw src-tauri/tauri.conf.json)" "$plist"
  plutil -insert CFBundleExecutable -string mandible-approval-helper "$plist"
  plutil -insert CFBundleIconFile -string icon.icns "$plist"
  plutil -insert CFBundlePackageType -string APPL "$plist"
  plutil -insert LSUIElement -bool true "$plist"
  cp src-tauri/icons/icon.icns "$approval/Resources/icon.icns"
  codesign --force --sign - "$output/MandibleApproval.app"
else
  # The bundle resources exist for cross-platform builds; setup and approval
  # fail explicitly on unsupported hosts before reaching these macOS adapters.
  for file in "$output/local-ca-trust-helper" "$approval/MacOS/mandible-approval-helper"; do
    printf '%s\n' '#!/bin/sh' "echo \"$(basename "$file") requires macOS\" >&2" 'exit 1' > "$file"
    chmod 755 "$file"
  done
fi
