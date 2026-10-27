#!/bin/bash
# mandible db: read-only SQL access to the live ledger database.
set -eu

source "$(cd "$(dirname "$0")" && pwd -P)/command-syntax.sh"
exec "$(mandible_bun_runtime)" --no-install "$(mandible_cli_module cli/db-read)" "$@"
