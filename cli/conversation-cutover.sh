#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
exec "$("$SCRIPT_DIR/../scripts/bun-runtime.sh")" "$SCRIPT_DIR/../scripts/conversation-cutover-proof.mjs" "$@"
