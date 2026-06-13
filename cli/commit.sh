#!/usr/bin/env bash

set -u
set -o pipefail

CLIENT_HELPER="${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/ledger-client.sh"
source "$CLIENT_HELPER"

usage() {
  cat <<'USAGE'
Usage:
  mandible commit trailer [issue...]
USAGE
}

action="${1:-}"
shift || true

case "$action" in
  trailer|trailers) mandible_commit_trailers "$@" ;;
  ""|-h|--help|help) usage ;;
  *) mandible_ledger_err "Unknown commit action: $action"; usage >&2; exit 2 ;;
esac
