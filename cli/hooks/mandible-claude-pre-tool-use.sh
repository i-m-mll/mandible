#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../command-syntax.sh"
exec "$(mandible_bun_runtime)" --no-install "$(mandible_cli_module cli/claude-pre-tool-use)"
