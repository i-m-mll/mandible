#!/bin/sh
set -eu

trust="${MANDIBLE_DESKTOP_TRUST_HELPER:-src-tauri/resources/local-ca-trust-helper}"
bundle="${MANDIBLE_DESKTOP_APPROVAL_HELPER:-src-tauri/resources/MandibleApproval.app}"
approval="$bundle/Contents"
rm -rf "$bundle"
mkdir -p "$(dirname "$trust")" "$approval/MacOS" "$approval/Resources"
if [ "$(uname -s)" = Darwin ]; then
  compiler="$(xcrun --find swiftc)"
  sdk="$(xcrun --show-sdk-path)"
  set -- -O -target "$(uname -m)-apple-macosx15.0" -sdk "$sdk"
  if [ -n "${MANDIBLE_DESKTOP_SWIFT_CACHE:-}" ]; then
    mkdir -p "$MANDIBLE_DESKTOP_SWIFT_CACHE"
    set -- "$@" -module-cache-path "$MANDIBLE_DESKTOP_SWIFT_CACHE"
  fi
  "$compiler" "$@" src-tauri/local-ca-trust-helper.swift -o "$trust" &
  trust_build=$!
  "$compiler" "$@" src-tauri/approval-helper/*.swift -o "$approval/MacOS/mandible-approval-helper" &
  approval_build=$!
  wait "$trust_build"
  wait "$approval_build"
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
  codesign --force --sign - "$bundle"
else
  # The bundle resources exist for cross-platform builds; setup and approval
  # fail explicitly on unsupported hosts before reaching these macOS adapters.
  for file in "$trust" "$approval/MacOS/mandible-approval-helper"; do
    printf '%s\n' '#!/bin/sh' "echo \"$(basename "$file") requires macOS\" >&2" 'exit 1' > "$file"
    chmod 755 "$file"
  done
fi
