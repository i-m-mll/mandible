#!/usr/bin/env bash
source "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd -P)/command-syntax.sh"

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

  if [[ -n "${MANDIBLE_LEDGER_ERROR_BODY_FILE:-}" ]]; then
    cp "$tmp_response" "$MANDIBLE_LEDGER_ERROR_BODY_FILE"
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
  local issue_id="" repo_id="" branch="" assigned_session_id="" worker_owner=0 graceful="${MANDIBLE_LEDGER_GRACEFUL:-0}"
  while (( $# > 0 )); do
    case "$1" in
      --issue|--issue-id) issue_id="${2:-}"; shift 2 ;;
      --repo|--repo-id) repo_id="${2:-}"; shift 2 ;;
      --branch) branch="${2:-}"; shift 2 ;;
      --session|--assigned-session-id) assigned_session_id="${2:-}"; shift 2 ;;
      --worker) worker_owner=1; shift ;;
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
    --argjson worker_owner "$worker_owner" \
    '{
      issue_id:$issue_id,
      repo_id:$repo_id
    }
    + (if $branch != "" then {branch:$branch} else {} end)
    + (if $assigned_session_id != "" then {assigned_session_id:$assigned_session_id} else {} end)
    + (if $worker_owner == 1 then {worker_owner:true} else {} end)')
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
  local id="" auth_request_id="" expected_generation="" graceful="${MANDIBLE_LEDGER_GRACEFUL:-0}"
  while (( $# > 0 )); do
    case "$1" in
      --id) id="${2:-}"; shift 2 ;;
      --auth-request-id) auth_request_id="${2:-}"; shift 2 ;;
      --expected-generation) expected_generation="${2:-}"; shift 2 ;;
      --graceful) graceful=1; shift ;;
      *) mandible_ledger_die "Unknown work-unit resolve option: $1" 2; return $? ;;
    esac
  done
  [[ -n "$id" ]] || mandible_ledger_die "Missing --id" 2 || return $?
  [[ "$expected_generation" =~ ^[0-9]+$ ]] || mandible_ledger_die "Missing or invalid --expected-generation" 2 || return $?
  mandible_ledger_require_tools || return $?
  local payload
  payload=$(jq -n --arg auth_request_id "$auth_request_id" --argjson expected_generation "$expected_generation" \
    '{state:"resolved",expected_generation:$expected_generation} + (if $auth_request_id != "" then {auth_request_id:$auth_request_id} else {} end)')
  mandible_ledger_request PATCH "/api/work-units/$(mandible_ledger_urlencode "$id")" "$payload" "$graceful"
}

mandible_work_unit_release() {
  local id="" issue_id="" repo_id="" branch="" expected_generation="" graceful="${MANDIBLE_LEDGER_GRACEFUL:-0}"
  while (( $# > 0 )); do
    case "$1" in
      --id) id="${2:-}"; shift 2 ;;
      --issue|--issue-id) issue_id="${2:-}"; shift 2 ;;
      --repo|--repo-id) repo_id="${2:-}"; shift 2 ;;
      --branch) branch="${2:-}"; shift 2 ;;
      --expected-generation) expected_generation="${2:-}"; shift 2 ;;
      --graceful) graceful=1; shift ;;
      *) mandible_ledger_die "Unknown work-unit release option: $1" 2; return $? ;;
    esac
  done
  if [[ -n "$id" ]]; then
    [[ -z "$issue_id$repo_id$branch" ]] || mandible_ledger_die "--id cannot be combined with issue, repository or branch" 2 || return $?
  else
    [[ -n "$repo_id" && -n "$branch" ]] || mandible_ledger_die "Select --id or --repo and --branch" 2 || return $?
  fi
  [[ "$expected_generation" =~ ^[0-9]+$ ]] || mandible_ledger_die "Missing or invalid --expected-generation" 2 || return $?
  mandible_ledger_require_tools || return $?
  local payload
  payload=$(jq -n --arg id "$id" --arg issue_id "$issue_id" --arg repo_id "$repo_id" --arg branch "$branch" --argjson expected_generation "$expected_generation" \
    '{expected_generation:$expected_generation} + (if $id != "" then {id:$id} else {repo_id:$repo_id,branch:$branch} + (if $issue_id != "" then {issue_id:$issue_id} else {} end) end)')
  mandible_ledger_request POST "/api/work-units/release" "$payload" "$graceful"
}

mandible_work_unit_release_issue() {
  local issue_id="" repo_id="" units_file="" graceful="${MANDIBLE_LEDGER_GRACEFUL:-0}"
  while (( $# > 0 )); do
    case "$1" in
      --issue) issue_id="${2:-}"; shift 2 ;;
      --repo) repo_id="${2:-}"; shift 2 ;;
      --units-file) units_file="${2:-}"; shift 2 ;;
      --graceful) graceful=1; shift ;;
      *) mandible_ledger_die "Unknown work-unit release-issue option: $1" 2; return $? ;;
    esac
  done
  [[ -n "$issue_id" && -n "$repo_id" && -f "$units_file" ]] || mandible_ledger_die "Explicit --issue, --repo and --units-file snapshot required" 2 || return $?
  mandible_ledger_require_tools || return $?
  local payload
  payload=$(jq -n --arg issue_id "$issue_id" --arg repo_id "$repo_id" --slurpfile units "$units_file" \
    '{issue_id:$issue_id,repo_id:$repo_id,work_units:$units[0]}') || return $?
  mandible_ledger_request POST "/api/work-units/release-issue" "$payload" "$graceful"
}

mandible_work_unit_custody_assume() {
  local id="" expected_generation="" reason="" checkpoint="" graceful="${MANDIBLE_LEDGER_GRACEFUL:-0}"
  while (( $# > 0 )); do
    case "$1" in
      --id) id="${2:-}"; shift 2 ;;
      --expected-generation) expected_generation="${2:-}"; shift 2 ;;
      --reason) reason="${2:-}"; shift 2 ;;
      --parent-role-checkpoint) checkpoint="${2:-}"; shift 2 ;;
      --graceful) graceful=1; shift ;;
      *) mandible_ledger_die "Unknown work-unit custody-assume option: $1" 2; return $? ;;
    esac
  done
  [[ -n "$id" ]] || mandible_ledger_die "Missing --id" 2 || return $?
  [[ "$expected_generation" =~ ^[0-9]+$ ]] || mandible_ledger_die "Missing or invalid --expected-generation" 2 || return $?
  [[ -n "$reason" ]] || mandible_ledger_die "Missing --reason" 2 || return $?
  mandible_ledger_require_tools || return $?
  local payload
  payload=$(jq -n --argjson expected_generation "$expected_generation" --arg reason "$reason" --arg checkpoint "$checkpoint" \
    '{expected_generation:$expected_generation,reason:$reason} + (if $checkpoint != "" then {parent_role_checkpoint_id:$checkpoint} else {} end)')
  mandible_ledger_request POST "/api/work-units/$(mandible_ledger_urlencode "$id")/custody/assume" "$payload" "$graceful"
}

mandible_trash_list() {
  local project="" state=""
  while (( $# > 0 )); do
    case "$1" in
      --project) project="${2:-}"; shift 2 ;;
      --state) state="${2:-}"; shift 2 ;;
      *) mandible_ledger_die "Unknown trash list option: $1" 2; return $? ;;
    esac
  done

  mandible_ledger_require_tools || return $?
  local query=""
  [[ -z "$project" ]] || query="project=$(mandible_ledger_urlencode "$project")"
  if [[ -n "$state" ]]; then
    [[ -z "$query" ]] || query="${query}&"
    query="${query}state=$(mandible_ledger_urlencode "$state")"
  fi
  [[ -z "$query" ]] || query="?${query}"
  mandible_ledger_request GET "/api/v1/trash${query}"
}

mandible_trash_create() {
  local project="" branch="" reason="" actor="" checkout_root="" retention_days=""
  local issue_refs='[]'
  while (( $# > 0 )); do
    case "$1" in
      --project) project="${2:-}"; shift 2 ;;
      --branch) branch="${2:-}"; shift 2 ;;
      --reason) reason="${2:-}"; shift 2 ;;
      --actor) actor="${2:-}"; shift 2 ;;
      --checkout-root) checkout_root="${2:-}"; shift 2 ;;
      --retention-days) retention_days="${2:-}"; shift 2 ;;
      --issue|--issue-ref)
        issue_refs=$(printf '%s' "$issue_refs" | jq --arg value "${2:-}" '. + [$value]')
        shift 2
        ;;
      *) mandible_ledger_die "Unknown trash create option: $1" 2; return $? ;;
    esac
  done

  [[ -n "$project" ]] || mandible_ledger_die "Missing --project" 2 || return $?
  [[ -n "$branch" ]] || mandible_ledger_die "Missing --branch" 2 || return $?
  case "$reason" in
    superseded|merged|abandoned|manual) ;;
    "") mandible_ledger_die "Missing --reason" 2; return $? ;;
    *) mandible_ledger_die "Invalid --reason (expected superseded, merged, abandoned, or manual)" 2; return $? ;;
  esac
  if [[ -n "$retention_days" && ( ! "$retention_days" =~ ^[0-9]+$ || "$retention_days" -lt 1 || "$retention_days" -gt 3650 ) ]]; then
    mandible_ledger_die "Invalid --retention-days (expected an integer from 1 to 3650)" 2
    return $?
  fi
  mandible_ledger_require_tools || return $?

  local payload
  payload=$(jq -n \
    --arg project "$project" \
    --arg branch "$branch" \
    --arg reason "$reason" \
    --arg actor "$actor" \
    --arg checkout_root "$checkout_root" \
    --arg retention_days "$retention_days" \
    --argjson issue_refs "$issue_refs" \
    '{project:$project, branch:$branch, reason:$reason}
     + (if $actor != "" then {actor:$actor} else {} end)
     + (if $checkout_root != "" then {checkout_root:$checkout_root} else {} end)
     + (if ($issue_refs | length) > 0 then {issue_refs:$issue_refs} else {} end)
     + (if $retention_days != "" then {retention_days:($retention_days | tonumber)} else {} end)')
  mandible_ledger_request POST "/api/v1/trash" "$payload"
}

mandible_trash_restore() {
  local id="" worktree_path="" actor=""
  while (( $# > 0 )); do
    case "$1" in
      --id) id="${2:-}"; shift 2 ;;
      --worktree-path) worktree_path="${2:-}"; shift 2 ;;
      --actor) actor="${2:-}"; shift 2 ;;
      *) mandible_ledger_die "Unknown trash restore option: $1" 2; return $? ;;
    esac
  done

  [[ -n "$id" ]] || mandible_ledger_die "Missing --id" 2 || return $?
  mandible_ledger_require_tools || return $?
  local payload
  payload=$(jq -n --arg worktree_path "$worktree_path" --arg actor "$actor" \
    '{}
     + (if $worktree_path != "" then {worktree_path:$worktree_path} else {} end)
     + (if $actor != "" then {actor:$actor} else {} end)')
  mandible_ledger_request POST "/api/v1/trash/$(mandible_ledger_urlencode "$id")/restore" "$payload"
}

mandible_trash_gc() {
  local now="" limit="" actor=""
  while (( $# > 0 )); do
    case "$1" in
      --now) now="${2:-}"; shift 2 ;;
      --limit) limit="${2:-}"; shift 2 ;;
      --actor) actor="${2:-}"; shift 2 ;;
      *) mandible_ledger_die "Unknown trash gc option: $1" 2; return $? ;;
    esac
  done

  if [[ -n "$now" && ! "$now" =~ ^[0-9]+$ ]]; then
    mandible_ledger_die "Invalid --now (expected an integer timestamp in milliseconds)" 2
    return $?
  fi
  if [[ -n "$limit" && ( ! "$limit" =~ ^[0-9]+$ || "$limit" -lt 1 || "$limit" -gt 1000 ) ]]; then
    mandible_ledger_die "Invalid --limit (expected an integer from 1 to 1000)" 2
    return $?
  fi
  mandible_ledger_require_tools || return $?
  local payload
  payload=$(jq -n --arg now "$now" --arg limit "$limit" --arg actor "$actor" \
    '{}
     + (if $now != "" then {now:($now | tonumber)} else {} end)
     + (if $limit != "" then {limit:($limit | tonumber)} else {} end)
     + (if $actor != "" then {actor:$actor} else {} end)')
  mandible_ledger_request POST "/api/v1/trash/gc" "$payload"
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

  [[ -n "$issue_id" ]] || mandible_ledger_die "Usage: $(mandible_command_syntax issue.title)" 2 || return $?
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
    mandible_ledger_die "Usage: $(mandible_command_syntax issue-file.write)" 2
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
