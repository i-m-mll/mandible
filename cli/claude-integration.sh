#!/bin/sh
set -eu

repo_root=$(cd "${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/.." && pwd -P)
entry="$repo_root/dist/claude-integration-cli.js"

if [ ! -f "$entry" ]; then
  echo "mandible claude-integration requires a built daemon bundle. Run bun run build:server first." >&2
  exit 1
fi

exec "$("$repo_root/scripts/bun-runtime.sh")" "$entry" "$@"
