#!/usr/bin/env bash
source "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd -P)/command-syntax.sh"

set -u
set -o pipefail

CLIENT_HELPER="${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/ledger-client.sh"
source "$CLIENT_HELPER"

usage() {
  mandible_command_help issue-file
}

action="${1:-}"
shift || true

case "$action" in
  path) mandible_issue_file_path "$@" ;;
  read) mandible_issue_file_read "$@" ;;
  write) mandible_issue_file_write "$@" ;;
  ""|-h|--help|help) usage ;;
  *) mandible_ledger_err "Unknown issue-file action: $action"; usage >&2; exit 2 ;;
esac
