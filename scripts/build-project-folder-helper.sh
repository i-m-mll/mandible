#!/bin/sh
set -eu

bundle="${MANDIBLE_DESKTOP_PROJECT_FOLDER_HELPER:-src-tauri/resources/MandibleProjectFolder.app}"
contents="$bundle/Contents"
mkdir -p "$contents/MacOS"

compiler="$(xcrun --find swiftc)"
sdk="$(xcrun --show-sdk-path)"
set -- -O -target "$(uname -m)-apple-macosx15.0" -sdk "$sdk"
if [ -n "${MANDIBLE_DESKTOP_SWIFT_CACHE:-}" ]; then
  mkdir -p "$MANDIBLE_DESKTOP_SWIFT_CACHE"
  set -- "$@" -module-cache-path "$MANDIBLE_DESKTOP_SWIFT_CACHE"
fi
"$compiler" "$@" src-tauri/project-folder-helper.swift -o "$contents/MacOS/mandible-project-folder"

plist="$contents/Info.plist"
rm -f "$plist"
plutil -create xml1 "$plist"
plutil -insert CFBundleIdentifier -string "$(plutil -extract identifier raw src-tauri/tauri.conf.json).project-folder" "$plist"
plutil -insert CFBundleName -string "Mandible Project Folder" "$plist"
plutil -insert CFBundleExecutable -string mandible-project-folder "$plist"
plutil -insert CFBundlePackageType -string APPL "$plist"
plutil -insert LSUIElement -bool true "$plist"
codesign --force --sign - "$bundle"
