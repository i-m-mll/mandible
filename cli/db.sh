#!/bin/sh
# mandible db: read-only SQL access to the live ledger database.
set -eu

repo_root=$(cd "${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/.." && pwd -P)
exec "$("$repo_root/scripts/bun-runtime.sh")" --no-install "$repo_root/dist/cli/db-read.js" "$@"
