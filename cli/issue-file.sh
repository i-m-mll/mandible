#!/usr/bin/env bash

set -u
set -o pipefail

CLIENT_HELPER="${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/ledger-client.sh"
source "$CLIENT_HELPER"

usage() {
  cat <<'USAGE'
Usage:
  mandible issue-file path [cwd]
  mandible issue-file read [cwd]
  mandible issue-file write [--cwd <path>] <issue>...
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
