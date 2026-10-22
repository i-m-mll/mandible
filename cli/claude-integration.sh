#!/bin/sh
set -eu

repo_root=$(cd "${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/.." && pwd -P)
exec "$("$repo_root/scripts/bun-runtime.sh")" --no-install "$repo_root/src/claude-integration-cli.ts" "$@"
