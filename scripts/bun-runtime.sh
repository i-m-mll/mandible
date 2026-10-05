#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
version=$(cat "$root/.bun-version")
verify() {
  [ -x "$1" ] && [ "$("$1" --version)" = "$version" ]
}
if [ -n "${MANDIBLE_RUNTIME:-}" ]; then
  if ! verify "$MANDIBLE_RUNTIME"; then
    echo "MANDIBLE_RUNTIME must be an executable Bun $version" >&2
    exit 1
  fi
  printf '%s\n' "$MANDIBLE_RUNTIME"
  exit 0
fi
runtime="${XDG_CACHE_HOME:-$HOME/.cache}/mandible/runtimes/bun/$version/bun"
if verify "$runtime"; then
  printf '%s\n' "$runtime"
  exit 0
fi
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) asset=bun-darwin-aarch64; checksum=90987a3a16d7db556d886ac3d551e7b6d3edf0a1cf43acaed622e8676be1d12f ;;
  Darwin-x86_64) asset=bun-darwin-x64-baseline; checksum=bad5bbd6cf14d0980d115f5954c9ff904df619d5e994d2da1ffccd3f316300b0 ;;
  Linux-aarch64) asset=bun-linux-aarch64; checksum=54328bbc2d9c8e0c9f892c544d66c57a83b84139e34909e5ee81758f1ac8fda7 ;;
  Linux-x86_64) asset=bun-linux-x64-baseline; checksum=c678040f14fe0440eb839d37cbd0ce4c051a32da72806ac97de6a6aab6bf728f ;;
  *) echo "Unsupported Bun platform; set MANDIBLE_RUNTIME to Bun $version" >&2; exit 1 ;;
esac
[ "$version" = 1.4.2 ] || { echo "No verified release checksums for Bun $version" >&2; exit 1; }
mkdir -p "$(dirname "$runtime")"
scratch=$(mktemp -d "$(dirname "$runtime")/install.XXXXXX")
trap 'rm -rf "$scratch"' EXIT HUP INT TERM
curl -fsSL --max-time 120 "https://github.com/oven-sh/bun/releases/download/bun-v$version/$asset.zip" -o "$scratch/release.zip"
actual=$(shasum -a 256 "$scratch/release.zip" | cut -d ' ' -f 1)
[ "$actual" = "$checksum" ] || { echo "Bun release checksum mismatch" >&2; exit 1; }
unzip -q "$scratch/release.zip" -d "$scratch"
verify "$scratch/$asset/bun" || { echo "Bun release version mismatch" >&2; exit 1; }
mv "$scratch/$asset/bun" "$runtime"
printf '%s\n' "$runtime"
