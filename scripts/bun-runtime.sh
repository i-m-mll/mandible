#!/bin/sh
set -eu

mode=${1:-runtime}
case "$mode" in runtime|--archive) ;; *) echo "Usage: bun-runtime.sh [--archive]" >&2; exit 1 ;; esac

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
version=$(cat "$root/.bun-version")
lock="$root/scripts/bun-runtime-lock.tsv"
revision=$(awk -F '\t' '$1 == "revision" { print $2 }' "$lock")
platform="$(uname -s)-$(uname -m)"
row=$(awk -F '\t' -v platform="$platform" '$1 == platform { print }' "$lock")
[ -n "$row" ] || { echo "No pinned Bun runtime for $platform" >&2; exit 1; }
IFS="$(printf '\t')" read -r platform asset archive_sha binary_sha url evidence <<EOF
$row
EOF

# These upstream x64 archives require AVX2; this build has no baseline asset.
case "$platform" in
  Darwin-x86_64)
    sysctl -n machdep.cpu.leaf7_features | tr '[:lower:]' '[:upper:]' | grep -q AVX2 || { echo "Pinned Bun x64 runtime requires AVX2; no baseline build is available" >&2; exit 1; } ;;
  Linux-x86_64)
    grep -qw avx2 /proc/cpuinfo || { echo "Pinned Bun x64 runtime requires AVX2; no baseline build is available" >&2; exit 1; } ;;
esac

hash() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
verify() {
  [ -x "$1" ] && [ "$(hash "$1")" = "$binary_sha" ] &&
    [ "$("$1" --version)" = "$version" ] &&
    [ "$("$1" --no-install --print 'Bun.revision')" = "$revision" ]
}
emit_runtime() {
  "$1" --no-install "$root/scripts/sqlite-runtime-install.mjs" >/dev/null
  printf '%s\n' "$1"
}
if [ -n "${MANDIBLE_RUNTIME:-}" ]; then
  if ! verify "$MANDIBLE_RUNTIME"; then
    echo "MANDIBLE_RUNTIME must match the pinned Bun $version revision and binary checksum" >&2
    exit 1
  fi
  if [ "$mode" = runtime ]; then
    emit_runtime "$MANDIBLE_RUNTIME"
    exit 0
  fi
fi
runtime="${XDG_CACHE_HOME:-$HOME/.cache}/mandible/runtimes/bun/$revision/$binary_sha/bun"
archive_cache="$(dirname "$runtime")/runtime.zip"
if [ -e "$archive_cache" ]; then
  [ "$(hash "$archive_cache")" = "$archive_sha" ] || { echo "Pinned Bun archive cache is corrupt: $archive_cache" >&2; exit 1; }
fi
if [ -e "$runtime" ]; then
  verify "$runtime" || { echo "Pinned Bun cache is corrupt: $runtime; preserve it and supply a verified runtime archive" >&2; exit 1; }
  if [ "$mode" = runtime ]; then
    emit_runtime "$runtime"
    exit 0
  elif [ -f "$archive_cache" ]; then
    printf '%s\n' "$archive_cache"
    exit 0
  fi
fi
mkdir -p "$(dirname "$runtime")"
scratch=$(mktemp -d "$(dirname "$runtime")/install.XXXXXX")
trap 'rm -rf "$scratch"' EXIT HUP INT TERM
archive="${MANDIBLE_RUNTIME_ARCHIVE:-$root/runtime/$asset.zip}"
if [ -z "${MANDIBLE_RUNTIME_ARCHIVE:-}" ] && [ -f "$archive_cache" ]; then archive="$archive_cache"; fi
if [ -f "$archive" ]; then
  cp "$archive" "$scratch/runtime.zip"
elif [ -n "${MANDIBLE_RUNTIME_ARCHIVE:-}" ]; then
  echo "Runtime archive does not exist: $archive" >&2
  exit 1
else
  if ! curl -fsSL --max-time 120 "$url" -o "$scratch/runtime.zip"; then
    echo "Pinned Bun download is unavailable. Set MANDIBLE_RUNTIME_ARCHIVE to the preserved $asset.zip offline bundle" >&2
    exit 1
  fi
fi
[ "$(hash "$scratch/runtime.zip")" = "$archive_sha" ] || { echo "Bun runtime archive checksum mismatch" >&2; exit 1; }
unzip -q "$scratch/runtime.zip" -d "$scratch/unpacked"
verify "$scratch/unpacked/$asset/bun" || { echo "Bun runtime identity or binary checksum mismatch" >&2; exit 1; }
if ! ln "$scratch/runtime.zip" "$archive_cache" 2>/dev/null; then
  [ "$(hash "$archive_cache")" = "$archive_sha" ] || { echo "Pinned Bun archive publication failed" >&2; exit 1; }
fi
# Atomic publication never overwrites a concurrently installed or corrupt entry.
if ! ln "$scratch/unpacked/$asset/bun" "$runtime" 2>/dev/null; then
  verify "$runtime" || { echo "Pinned Bun runtime publication failed" >&2; exit 1; }
fi
if [ "$mode" = --archive ]; then printf '%s\n' "$archive_cache"; else emit_runtime "$runtime"; fi
