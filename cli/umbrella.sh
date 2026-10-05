#!/usr/bin/env bash
source "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd -P)/command-syntax.sh"

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
  mandible_command_help umbrella
}

print_status_response() {
  local response="$1"
  local json="$2"
  if (( json )); then
    printf '%s\n' "$response" | jq '.'
  else
    printf '%s\n' "$response" | api_jq_human '
      "umbrella \(.umbrella.short_id) [\(.umbrella.status)] \(.umbrella.title)",
      "children: \((.children // []) | length)",
      "delegation_manifest: \(if .delegation_manifest then (.delegation_manifest | mandible_display_id) else "-" end)",
      "operation: \(.operation.kind // "-")",
      "created_edges: \((.operation.created_child_refs // []) | length)",
      "pending_auth: \((.auth_queue.pending_requests // []) | length)",
      "active_auth: \((.auth_queue.active_requests // []) | length)"
    '
  fi
}

cmd_status() {
  local issue_ref=""
  local deep=0
  local json=0
  local binding
  binding=$(mandible_bind_arguments umbrella.status '{"issue_ref":{"position":0},"deep":{"option":"deep","flag":true},"json":{"option":"json","flag":true}}' "$@") || return $?
  eval "$binding"

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
  local binding
  binding=$(mandible_bind_arguments umbrella.adopt '{"issue_ref":{"position":0},"children":{"rest":1},"json":{"option":"json","flag":true}}' "$@") || return $?
  eval "$binding"

  require_tools
  local payload response
  payload=$(printf '%s\n' "${children[@]}" | jq -R -s '{child_refs: split("\n") | map(select(length > 0))}')
  response=$(api_send POST "/api/ledger/issues/$(urlencode "$issue_ref")/umbrella-adopt" "$payload") \
    || die "Failed to adopt children for umbrella ${issue_ref}" 1
  print_status_response "$response" "$json"
}

cmd_manifest() {
  local action="${1:-}"
  if [[ "$action" != "refresh" ]]; then
    die "Usage: $(mandible_command_syntax umbrella.manifest.refresh)" 2
  fi
  shift

  local issue_ref=""
  local json=0
  local binding
  binding=$(mandible_bind_arguments umbrella.manifest.refresh '{"issue_ref":{"position":0},"json":{"option":"json","flag":true}}' "$@") || return $?
  eval "$binding"

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
