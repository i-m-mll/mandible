#!/usr/bin/env bash
source "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd -P)/command-syntax.sh"

set -u
set -o pipefail

CLIENT_HELPER="${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/ledger-client.sh"
source "$CLIENT_HELPER"

usage() {
  cat <<'USAGE' | mandible_render_commands
Usage:
  {{command issue-file.path}}
  {{command issue-file.read}}
  {{command issue-file.write}}
USAGE
}

action="${1:-}"
shift || true

case "$action" in
  path) mandible_issue_file_path "${1:-$PWD}" ;;
  read) mandible_issue_file_read "${1:-$PWD}" ;;
  write) mandible_issue_file_write "$@" ;;
  ""|-h|--help|help) usage ;;
  *) mandible_ledger_err "Unknown issue-file action: $action"; usage >&2; exit 2 ;;
esac
