#!/usr/bin/env bash

set -u
set -o pipefail

CLIENT_HELPER="${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/ledger-client.sh"
source "$CLIENT_HELPER"

usage() {
  cat <<'USAGE'
Usage:
  mandible session link-issue <session-id> --issue <id> --repo <repo> [--repo-name <name>] [--graceful]
USAGE
}

action="${1:-}"
shift || true

case "$action" in
  link-issue|issue-link) mandible_session_link_issue "$@" ;;
  ""|-h|--help|help) usage ;;
  *) mandible_ledger_err "Unknown session action: $action"; usage >&2; exit 2 ;;
esac
