#!/usr/bin/env bash

# Sourceable policy-free client for Mandible ledger mechanism operations.

set -u
set -o pipefail

LEDGER_CLIENT_DIR="${MANDIBLE_CLI_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
API_HELPER="${LEDGER_CLIENT_DIR}/api.sh"
source "$API_HELPER"

mandible_ledger_err() {
  printf '%s\n' "$*" >&2
}

mandible_ledger_die() {
  mandible_ledger_err "$1"
  return "${2:-1}"
}

mandible_ledger_urlencode() {
  urlencode "$1"
}

mandible_ledger_require_tools() {
  command -v jq >/dev/null 2>&1 || mandible_ledger_die "jq not found." 1 || return $?
  if ! api_is_file_rpc; then
    command -v curl >/dev/null 2>&1 || mandible_ledger_die "curl not found." 1 || return $?
  fi
}

mandible_ledger_request() {
  local method="$1"
  local request_path="$2"
  local data="${3:-}"
  local graceful="${4:-${MANDIBLE_LEDGER_GRACEFUL:-0}}"
  local tmp_response status

  tmp_response=$(mktemp) || return 1
  status=$(api_send_capture "$method" "$request_path" "$data" "$tmp_response")
  if [[ "$status" =~ ^2 ]]; then
    cat "$tmp_response"
    rm -f "$tmp_response"
    return 0
  fi

  if [[ "$graceful" == "1" || "$graceful" == "true" ]]; then
    mandible_ledger_err "Mandible ledger request skipped (${method} ${request_path}, status ${status:-unreachable})"
    rm -f "$tmp_response"
    return 0
  fi

  mandible_ledger_err "Mandible ledger request failed (${method} ${request_path}, status ${status:-unreachable})"
  if [[ -s "$tmp_response" ]]; then
    cat "$tmp_response" >&2
    mandible_ledger_err ""
  fi
  rm -f "$tmp_response"
  return 1
}

mandible_ledger_payload_base() {
  local issue_id="$1"
  local repo_id="$2"
  jq -n --arg issue_id "$issue_id" --arg repo_id "$repo_id" '{issue_id:$issue_id, repo_id:$repo_id}'
}

mandible_work_unit_claim() {
  local issue_id="" repo_id="" branch="" parent_branch="" kind="" assigned_session_id="" graceful="${MANDIBLE_LEDGER_GRACEFUL:-0}"
  while (( $# > 0 )); do
    case "$1" in
      --issue|--issue-id) issue_id="${2:-}"; shift 2 ;;
      --repo|--repo-id) repo_id="${2:-}"; shift 2 ;;
      --branch) branch="${2:-}"; shift 2 ;;
      --parent-branch) parent_branch="${2:-}"; shift 2 ;;
      --kind) kind="${2:-}"; shift 2 ;;
      --session|--assigned-session-id) assigned_session_id="${2:-}"; shift 2 ;;
      --graceful) graceful=1; shift ;;
      *) mandible_ledger_die "Unknown work-unit claim option: $1" 2; return $? ;;
    esac
  done

  [[ -n "$issue_id" ]] || mandible_ledger_die "Missing --issue" 2 || return $?
  [[ -n "$repo_id" ]] || mandible_ledger_die "Missing --repo" 2 || return $?
  mandible_ledger_require_tools || return $?

  local payload
  payload=$(jq -n \
    --arg issue_id "$issue_id" \
    --arg repo_id "$repo_id" \
    --arg branch "$branch" \
    --arg parent_branch "$parent_branch" \
    --arg kind "$kind" \
    --arg assigned_session_id "$assigned_session_id" \
    '{
      issue_id:$issue_id,
      repo_id:$repo_id
    }
    + (if $branch != "" then {branch:$branch} else {} end)
    + (if $parent_branch != "" then {parent_branch:$parent_branch} else {} end)
    + (if $kind != "" then {kind:$kind} else {} end)
    + (if $assigned_session_id != "" then {assigned_session_id:$assigned_session_id} else {} end)')
  mandible_ledger_request POST "/api/work-units/claim" "$payload" "$graceful"
}

mandible_work_unit_activate() {
  local issue_id="" repo_id="" branch="" assigned_session_id="" graceful="${MANDIBLE_LEDGER_GRACEFUL:-0}"
  while (( $# > 0 )); do
    case "$1" in
      --issue|--issue-id) issue_id="${2:-}"; shift 2 ;;
      --repo|--repo-id) repo_id="${2:-}"; shift 2 ;;
      --branch) branch="${2:-}"; shift 2 ;;
      --session|--assigned-session-id) assigned_session_id="${2:-}"; shift 2 ;;
      --graceful) graceful=1; shift ;;
      *) mandible_ledger_die "Unknown work-unit activate option: $1" 2; return $? ;;
    esac
  done

  [[ -n "$issue_id" ]] || mandible_ledger_die "Missing --issue" 2 || return $?
  [[ -n "$repo_id" ]] || mandible_ledger_die "Missing --repo" 2 || return $?
  mandible_ledger_require_tools || return $?

  local payload
  payload=$(jq -n \
    --arg issue_id "$issue_id" \
    --arg repo_id "$repo_id" \
    --arg branch "$branch" \
    --arg assigned_session_id "$assigned_session_id" \
    '{
      issue_id:$issue_id,
      repo_id:$repo_id
    }
    + (if $branch != "" then {branch:$branch} else {} end)
    + (if $assigned_session_id != "" then {assigned_session_id:$assigned_session_id} else {} end)')
  mandible_ledger_request POST "/api/work-units/activate" "$payload" "$graceful"
}

mandible_work_unit_find() {
  local issue_id="" repo_id="" branch="" state="" graceful="${MANDIBLE_LEDGER_GRACEFUL:-0}"
  while (( $# > 0 )); do
    case "$1" in
      --issue|--issue-id) issue_id="${2:-}"; shift 2 ;;
      --repo|--repo-id) repo_id="${2:-}"; shift 2 ;;
      --branch) branch="${2:-}"; shift 2 ;;
      --state) state="${2:-}"; shift 2 ;;
      --graceful) graceful=1; shift ;;
      *) mandible_ledger_die "Unknown work-unit find option: $1" 2; return $? ;;
    esac
  done

  [[ -n "$repo_id" ]] || mandible_ledger_die "Missing --repo" 2 || return $?
  if [[ -z "$issue_id" && -z "$branch" ]]; then
    mandible_ledger_die "Missing --issue or --branch" 2
    return $?
  fi
  mandible_ledger_require_tools || return $?

  local query=""
  query="repo_id=$(mandible_ledger_urlencode "$repo_id")"
  [[ -z "$issue_id" ]] || query="${query}&issue_id=$(mandible_ledger_urlencode "$issue_id")"
  [[ -z "$branch" ]] || query="${query}&branch=$(mandible_ledger_urlencode "$branch")"
  [[ -z "$state" ]] || query="${query}&state=$(mandible_ledger_urlencode "$state")"
  mandible_ledger_request GET "/api/work-units?${query}" "" "$graceful"
}

mandible_work_unit_resolve() {
  local id="" auth_request_id="" graceful="${MANDIBLE_LEDGER_GRACEFUL:-0}"
  while (( $# > 0 )); do
    case "$1" in
      --id) id="${2:-}"; shift 2 ;;
      --auth-request-id) auth_request_id="${2:-}"; shift 2 ;;
      --graceful) graceful=1; shift ;;
      *) mandible_ledger_die "Unknown work-unit resolve option: $1" 2; return $? ;;
    esac
  done

  [[ -n "$id" ]] || mandible_ledger_die "Missing --id" 2 || return $?
  mandible_ledger_require_tools || return $?

  local payload
  payload=$(jq -n --arg auth_request_id "$auth_request_id" \
    '{state:"resolved"} + (if $auth_request_id != "" then {auth_request_id:$auth_request_id} else {} end)')
  mandible_ledger_request PATCH "/api/work-units/$(mandible_ledger_urlencode "$id")" "$payload" "$graceful"
}

mandible_work_unit_release() {
  local issue_id="" repo_id="" graceful="${MANDIBLE_LEDGER_GRACEFUL:-0}"
  while (( $# > 0 )); do
    case "$1" in
      --issue|--issue-id) issue_id="${2:-}"; shift 2 ;;
      --repo|--repo-id) repo_id="${2:-}"; shift 2 ;;
      --graceful) graceful=1; shift ;;
      *) mandible_ledger_die "Unknown work-unit release option: $1" 2; return $? ;;
    esac
  done

  [[ -n "$issue_id" ]] || mandible_ledger_die "Missing --issue" 2 || return $?
  [[ -n "$repo_id" ]] || mandible_ledger_die "Missing --repo" 2 || return $?
  mandible_ledger_require_tools || return $?

  local payload
  payload=$(mandible_ledger_payload_base "$issue_id" "$repo_id")
  mandible_ledger_request POST "/api/work-units/release" "$payload" "$graceful"
}

mandible_issue_title() {
  local issue_id="" json=0 graceful="${MANDIBLE_LEDGER_GRACEFUL:-0}"
  while (( $# > 0 )); do
    case "$1" in
      --json) json=1; shift ;;
      --graceful) graceful=1; shift ;;
      -*)
        mandible_ledger_die "Unknown issue title option: $1" 2
        return $?
        ;;
      *)
        if [[ -z "$issue_id" ]]; then
          issue_id="$1"
        else
          mandible_ledger_die "Unexpected argument: $1" 2
          return $?
        fi
        shift
        ;;
    esac
  done

  [[ -n "$issue_id" ]] || mandible_ledger_die "Usage: mandible issue title <id> [--json] [--graceful]" 2 || return $?
  mandible_ledger_require_tools || return $?

  local response
  response=$(mandible_ledger_request GET "/api/ledger/issues/$(mandible_ledger_urlencode "$issue_id")" "" "$graceful") || return $?
  if [[ -z "$response" ]]; then
    return 0
  fi
  if (( json )); then
    printf '%s\n' "$response" | jq '{id:(.display_id // .id), title:(.title // "")}'
  else
    printf '%s\n' "$response" | jq -r '.title // ""'
  fi
}

mandible_session_link_issue() {
  local session_id="" issue_id="" repo_id="" repo_name="" graceful="${MANDIBLE_LEDGER_GRACEFUL:-0}"
  while (( $# > 0 )); do
    case "$1" in
      --session|--session-id) session_id="${2:-}"; shift 2 ;;
      --issue|--issue-id) issue_id="${2:-}"; shift 2 ;;
      --repo|--repo-id) repo_id="${2:-}"; shift 2 ;;
      --repo-name) repo_name="${2:-}"; shift 2 ;;
      --graceful) graceful=1; shift ;;
      -*)
        mandible_ledger_die "Unknown session link option: $1" 2
        return $?
        ;;
      *)
        if [[ -z "$session_id" ]]; then
          session_id="$1"
        else
          mandible_ledger_die "Unexpected argument: $1" 2
          return $?
        fi
        shift
        ;;
    esac
  done

  [[ -n "$session_id" ]] || mandible_ledger_die "Missing session id" 2 || return $?
  [[ -n "$issue_id" ]] || mandible_ledger_die "Missing --issue" 2 || return $?
  [[ -n "$repo_id" ]] || mandible_ledger_die "Missing --repo" 2 || return $?
  mandible_ledger_require_tools || return $?

  local payload
  payload=$(jq -n \
    --arg issue_id "$issue_id" \
    --arg repo_id "$repo_id" \
    --arg repo_name "$repo_name" \
    '{issue_id:$issue_id, repo_id:$repo_id} + (if $repo_name != "" then {repo_name:$repo_name} else {} end)')
  mandible_ledger_request POST "/api/sessions/$(mandible_ledger_urlencode "$session_id")/issues" "$payload" "$graceful"
}

mandible_issue_file_path() {
  local start="${1:-$PWD}"
  local root
  root=$(git -C "$start" rev-parse --show-toplevel 2>/dev/null) || return 1
  printf '%s/.issue\n' "$root"
}

mandible_issue_file_read() {
  local start="${1:-$PWD}"
  local path
  path=$(mandible_issue_file_path "$start") || return 1
  [[ -f "$path" ]] || return 1
  sed -e 's/[[:space:]]*#.*$//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' "$path" \
    | awk 'NF > 0'
}

mandible_issue_file_write() {
  local target="$PWD"
  if [[ "${1:-}" == "--cwd" ]]; then
    target="${2:-}"
    shift 2
  fi
  if (( $# == 0 )); then
    mandible_ledger_die "Usage: mandible issue-file write [--cwd <path>] <issue>..." 2
    return $?
  fi
  local path
  path=$(mandible_issue_file_path "$target") || mandible_ledger_die "Not inside a git worktree: $target" 2 || return $?
  {
    for issue in "$@"; do
      printf '%s\n' "$issue"
    done
  } > "$path"
}

mandible_commit_trailers() {
  local issues=("$@")
  if (( ${#issues[@]} == 0 )); then
    local discovered_issue
    while IFS= read -r discovered_issue; do
      issues+=("$discovered_issue")
    done < <(mandible_issue_file_read "$PWD")
  fi
  if (( ${#issues[@]} == 0 )); then
    mandible_ledger_die "No issues provided and no .issue file found." 2
    return $?
  fi
  local issue
  for issue in "${issues[@]}"; do
    [[ -z "$issue" ]] || printf 'Mandible-Issue: %s\n' "$issue"
  done
}
