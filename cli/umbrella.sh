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
  mandible umbrella status <id> [--deep] [--json]
  mandible umbrella adopt <umbrella> <children...> [--json]
  mandible umbrella reconcile <umbrella> [--json]
  mandible umbrella manifest refresh <umbrella> [--json]
USAGE
}

print_status_response() {
  local response="$1"
  local json="$2"
  if (( json )); then
    printf '%s\n' "$response" | jq '.'
  else
    printf '%s\n' "$response" | jq -r '
      "umbrella \(.umbrella.short_id) [\(.umbrella.status)] \(.umbrella.title)",
      "children: \((.children // []) | length)",
      "delegation_manifest: \(.delegation_manifest.id // "-")",
      "operation: \(.operation.kind // "-")",
      "created_edges: \((.operation.created_child_refs // []) | length)",
      "missing_edges: \((.child_drift.missing_edge_refs // []) | length)",
      "pending_auth: \((.auth_queue.pending_requests // []) | length)",
      "active_auth: \((.auth_queue.active_requests // []) | length)"
    '
  fi
}

cmd_status() {
  local issue_ref=""
  local deep=0
  local json=0
  while (( $# > 0 )); do
    case "$1" in
      --deep) deep=1; shift ;;
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
    die "Usage: mandible umbrella status <id> [--deep] [--json]" 2
  fi

  require_tools
  local path="/api/ledger/issues/$(urlencode "$issue_ref")/umbrella-status"
  if (( deep )); then
    path="${path}?deep=true"
  fi
  local response
  response=$(api_get "$path") \
    || die "Failed to fetch umbrella status for ${issue_ref}" 1
  print_status_response "$response" "$json"
}

cmd_adopt() {
  local issue_ref=""
  local json=0
  local children=()
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
          children+=("$1")
        fi
        shift
        ;;
    esac
  done

  if [[ -z "$issue_ref" || ${#children[@]} -eq 0 ]]; then
    die "Usage: mandible umbrella adopt <umbrella> <children...> [--json]" 2
  fi

  require_tools
  local payload response
  payload=$(printf '%s\n' "${children[@]}" | jq -R -s '{child_refs: split("\n") | map(select(length > 0))}')
  response=$(api_send POST "/api/ledger/issues/$(urlencode "$issue_ref")/umbrella-adopt" "$payload") \
    || die "Failed to adopt children for umbrella ${issue_ref}" 1
  print_status_response "$response" "$json"
}

cmd_reconcile() {
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
    die "Usage: mandible umbrella reconcile <umbrella> [--json]" 2
  fi

  require_tools
  local response
  response=$(api_send POST "/api/ledger/issues/$(urlencode "$issue_ref")/umbrella-reconcile" '{}') \
    || die "Failed to reconcile umbrella ${issue_ref}" 1
  print_status_response "$response" "$json"
}

cmd_manifest() {
  local action="${1:-}"
  if [[ "$action" != "refresh" ]]; then
    die "Usage: mandible umbrella manifest refresh <umbrella> [--json]" 2
  fi
  shift

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
    die "Usage: mandible umbrella manifest refresh <umbrella> [--json]" 2
  fi

  require_tools
  local response
  response=$(api_send POST "/api/ledger/issues/$(urlencode "$issue_ref")/umbrella-manifest-refresh" '{}') \
    || die "Failed to refresh umbrella manifest for ${issue_ref}" 1
  print_status_response "$response" "$json"
}

case "${1:-}" in
  status)
    shift
    cmd_status "$@"
    ;;
  adopt)
    shift
    cmd_adopt "$@"
    ;;
  reconcile)
    shift
    cmd_reconcile "$@"
    ;;
  manifest)
    shift
    cmd_manifest "$@"
    ;;
  ""|-h|--help)
    usage
    ;;
  *)
    die "Unknown umbrella subcommand: ${1:-}" 2
    ;;
esac
