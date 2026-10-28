#!/bin/bash
set -eu

source "$(cd "$(dirname "$0")" && pwd -P)/command-syntax.sh"
exec "$(mandible_bun_runtime)" --no-install "$(mandible_cli_module claude-integration-cli)" "$@"
