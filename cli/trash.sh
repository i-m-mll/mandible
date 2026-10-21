#!/usr/bin/env bash

set -u
set -o pipefail

CLIENT_HELPER="${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/ledger-client.sh"
source "$CLIENT_HELPER"

usage() {
  mandible_command_help trash
}

action="${1:-}"
shift || true

report_create_outcome() {
  local response="$1"
  local prefix="$2"
  local removed_path
  removed_path=$(printf '%s' "$response" | jq -r '(.outcome // .detail.outcome).worktree_path // empty' 2>/dev/null)
  if printf '%s' "$response" | jq -e '(.outcome // .detail.outcome).worktree_removed == true' >/dev/null 2>&1; then
    mandible_ledger_err "${prefix}: worktree path ${removed_path} is gone. No further work may happen there."
  elif printf '%s' "$response" | jq -e '(.outcome // .detail.outcome).branch_removed == true' >/dev/null 2>&1; then
    mandible_ledger_err "${prefix}: the normal branch ref is gone; preserved bytes remain under trash custody."
  fi
}

case "$action" in
  list)
    mandible_trash_list "$@"
    ;;
  create)
    error_file=$(mktemp) || exit 1
    response=$(MANDIBLE_LEDGER_ERROR_BODY_FILE="$error_file" mandible_trash_create "$@")
    status=$?
    if (( status != 0 )); then
      error_response=$(cat "$error_file")
      rm -f "$error_file"
      report_create_outcome "$error_response" "Trash custody incomplete"
      exit "$status"
    fi
    rm -f "$error_file"
    printf '%s\n' "$response"
    if [[ "$(printf '%s' "$response" | jq -r '.result // empty' 2>/dev/null)" == "removed" ]]; then
      report_create_outcome "$response" "Removed proven-merged branch with no unique bytes; no trash entry was needed"
    else
      report_create_outcome "$response" "Trash custody complete"
    fi
    ;;
  restore)
    id="${1:-}"
    [[ -n "$id" && "$id" != -* ]] || { usage >&2; exit 2; }
    shift
    mandible_trash_restore --id "$id" "$@"
    ;;
  gc)
    mandible_trash_gc "$@"
    ;;
  ""|-h|--help|help)
    usage
    ;;
  *)
    mandible_ledger_err "Unknown trash action: $action"
    usage >&2
    exit 2
    ;;
esac
