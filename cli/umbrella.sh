#!/usr/bin/env bash

set -u
set -o pipefail

API_HELPER="${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/api.sh"
source "$API_HELPER"

die() {
  printf '%s\n' "$1" >&2
  exit "${2:-1}"
}

require_tools() {
  command -v jq >/dev/null 2>&1 || die "jq not found." 1
  if ! api_is_file_rpc; then
    command -v curl >/dev/null 2>&1 || die "curl not found." 1
  fi
}

usage() {
  cat <<'USAGE'
Usage:
  mandible umbrella status <id> [--json]
USAGE
}

cmd_status() {
  local issue_ref=""
  local json=0
  while (( $# > 0 )); do
    case "$1" in
      --json) json=1; shift ;;
      -*)
        die "Unknown option: $1" 2
        ;;
      *)
        if [[ -z "$issue_ref" ]]; then
          issue_ref="$1"
        else
          die "Unexpected argument: $1" 2
        fi
        shift
        ;;
    esac
  done

  if [[ -z "$issue_ref" ]]; then
    die "Usage: mandible umbrella status <id> [--json]" 2
  fi

  require_tools
  local response
  response=$(api_get "/api/ledger/issues/$(urlencode "$issue_ref")/umbrella-status") \
    || die "Failed to fetch umbrella status for ${issue_ref}" 1
  if (( json )); then
    printf '%s\n' "$response" | jq '.'
  else
    printf '%s\n' "$response" | jq -r '
      "umbrella \(.umbrella.short_id) [\(.umbrella.status)] \(.umbrella.title)",
      "children: \((.children // []) | length)",
      "delegation_manifest: \(.delegation_manifest.id // "-")",
      "pending_auth: \((.auth_queue.pending_requests // []) | length)",
      "active_auth: \((.auth_queue.active_requests // []) | length)"
    '
  fi
}

case "${1:-}" in
  status)
    shift
    cmd_status "$@"
    ;;
  ""|-h|--help)
    usage
    ;;
  *)
    die "Unknown umbrella subcommand: ${1:-}" 2
    ;;
esac
