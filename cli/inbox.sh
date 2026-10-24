#!/usr/bin/env zsh
# mandible inbox: Query and manage the session inbox via Mandible
#
# Usage:
#   mandible inbox                        Pretty-print pending items for current branch
#   mandible inbox check                  Machine-friendly one-liner for hooks
#   mandible inbox add "text"             Create Mandible reminder issue (label: reminder)
#   mandible inbox ack <type> <id>        Acknowledge an item (type: continuation|auth_result)
#   mandible inbox watch <request-id>  Poll until auth request resolves (timeout 30 min)

emulate -L zsh -o pipefail

# MANDIBLE_PORT and MANDIBLE_BASE are exported by the dispatcher
GIT_ENV_HELPER="${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/git-env.sh"
source "$GIT_ENV_HELPER"
API_HELPER="${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/api.sh"
source "$API_HELPER"
mandible_prepare_syntax_runtime || exit $?

# Derive branch and repo from git
branch=$(git branch --show-current 2>/dev/null) || true
repo=$(git rev-parse --show-toplevel 2>/dev/null) || true

if [[ -z "$branch" ]]; then
  # Not in a git repo or detached HEAD — nothing to query
  exit 0
fi

session_id="${MANDIBLE_SESSION_ID:-}"

# --- Subcommands ---

cmd_default() {
  local url="/api/inbox?branch=$(urlencode "$branch")"
  [[ -n "$repo" ]] && url="${url}&repo=$(urlencode "$repo")"
  [[ -n "$session_id" ]] && url="${url}&session_id=$(urlencode "$session_id")"

  local response
  response=$(api_get "$url") || exit 0

  local total
  total=$(printf '%s' "$response" | jq -r '.total // 0')
  if [[ "$total" == "0" ]]; then
    print "Inbox: no pending items for branch '$branch'"
    return 0
  fi

  print "Inbox: $total pending item(s) for branch '$branch'"
  print ""

  # Continuations
  local cont_count
  cont_count=$(printf '%s' "$response" | jq '.continuations | length')
  if [[ "$cont_count" -gt 0 ]]; then
    print "\033[1;36mContinuations:\033[0m"
    printf '%s' "$response" | api_jq_human '.continuations[] | "  [\(.session_id | mandible_short_id)] \(.continuation) (ended: \(.ended_at))"'
    print ""
  fi

  # Auth results
  local auth_count
  auth_count=$(printf '%s' "$response" | jq '.auth_results | length')
  if [[ "$auth_count" -gt 0 ]]; then
    print "\033[1;33mAuth Results:\033[0m"
    printf '%s' "$response" | api_jq_human '.auth_results[] | "  [\(mandible_display_id)] \(.title) — \(.status)\(if .exit_code != null then " (exit \(.exit_code))" else "" end)"'
    print ""
  fi

  # Open issues
  local issue_count
  issue_count=$(printf '%s' "$response" | jq '.open_issues | length')
  if [[ "$issue_count" -gt 0 ]]; then
    print "\033[1;32mOpen Issues:\033[0m"
    printf '%s' "$response" | api_jq_human '.open_issues[] | "  [\(mandible_display_id)] \(.title)\(if (.labels | length) > 0 then " [\(.labels | join(", "))]" else "" end)"'
    print ""
  fi
}

cmd_check() {
  local url="/api/inbox?branch=$(urlencode "$branch")"
  [[ -n "$repo" ]] && url="${url}&repo=$(urlencode "$repo")"
  [[ -n "$session_id" ]] && url="${url}&session_id=$(urlencode "$session_id")"

  local response
  response=$(api_get "$url") || exit 0

  local total
  total=$(printf '%s' "$response" | jq -r '.total // 0')
  if [[ "$total" == "0" ]]; then
    exit 0
  fi

  local cont_count auth_count issue_count parts
  cont_count=$(printf '%s' "$response" | jq '.continuations | length')
  auth_count=$(printf '%s' "$response" | jq '.auth_results | length')
  issue_count=$(printf '%s' "$response" | jq '.open_issues | length')

  parts=()
  [[ "$cont_count" -gt 0 ]] && parts+=("${cont_count} continuation(s)")
  [[ "$auth_count" -gt 0 ]] && parts+=("${auth_count} auth result(s)")
  [[ "$issue_count" -gt 0 ]] && parts+=("${issue_count} open issue(s)")

  local detail
  detail="${(j:, :)parts}"

  print "Inbox: ${total} item(s) (${detail})"
}

cmd_add() {
  local text="" binding
  binding=$(mandible_bind_arguments "inbox.add" '{"text":{"position":0}}' "$@") || return $?
  eval "$binding"
  if [[ -z "$text" ]]; then
    print -u2 "usage: mandible inbox add \"reminder text\""
    exit 1
  fi

  if ! command -v jq >/dev/null 2>&1; then
    print -u2 "error: jq not found"
    exit 1
  fi

  local root repo_name payload response reminder_id
  root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
  repo_name=$(basename "$root")
  payload=$(jq -n \
    --arg title "$text" \
    --arg body "Reminder created via mandible inbox on branch $branch" \
    --arg root "$root" \
    '{title:$title, body:$body, root:$root, labels:["reminder"]}')

  response=$(api_send POST "/api/issues/$(urlencode "$repo_name")" "$payload") || {
    print -u2 "error: failed to create reminder (Mandible unreachable or ledger writes unavailable)"
    exit 1
  }

  reminder_id=$(printf '%s' "$response" | api_jq_human 'mandible_display_id')
  if [[ -z "$reminder_id" ]]; then
    print -u2 "error: failed to parse created reminder ID"
    exit 1
  fi
  print "Created reminder: $reminder_id"
}

cmd_ack() {
  local type="" id="" binding
  binding=$(mandible_bind_arguments "inbox.ack" '{"type":{"position":0},"id":{"position":1}}' "$@") || return $?
  eval "$binding"
  if [[ -z "$type" || -z "$id" ]]; then
    print -u2 "usage: mandible inbox ack <continuation|auth_result> <id>"
    exit 1
  fi

  local body='{}'
  if [[ -n "$session_id" ]]; then
    body=$(jq -n --arg sid "$session_id" '{"session_id": $sid}')
  fi

  local response
  response=$(api_send POST "/api/inbox/$(urlencode "$type")/$(urlencode "$id")/ack" "$body") || {
    print -u2 "error: failed to acknowledge (Mandible unreachable or item not found)"
    exit 1
  }

  local ok
  ok=$(printf '%s' "$response" | jq -r '.ok // empty')
  if [[ "$ok" == "true" ]]; then
    print "Acknowledged ${type} $(api_short_id "$id")"
  else
    local err
    err=$(printf '%s' "$response" | jq -r '.error // "unknown error"')
    print -u2 "error: $err"
    exit 1
  fi
}

cmd_watch() {
  local request_id="" binding
  binding=$(mandible_bind_arguments "inbox.watch" '{"request_id":{"position":0}}' "$@") || return $?
  eval "$binding"
  if [[ -z "$request_id" ]]; then
    print -u2 "usage: mandible inbox watch <request-id>"
    exit 1
  fi

  local timeout=1800  # 30 minutes
  local interval=5
  local elapsed=0

  while [[ $elapsed -lt $timeout ]]; do
    local response
    response=$(api_get "/api/auth/request/$(urlencode "$request_id")") || {
      sleep "$interval"
      elapsed=$((elapsed + interval))
      continue
    }

    local request_status
    request_status=$(printf '%s' "$response" | jq -r '.status // "unknown"')

    case "$request_status" in
      pending|approved)
        # Still in progress, keep polling
        ;;
      completed)
        local exit_code
        exit_code=$(printf '%s' "$response" | jq -r '.exit_code // "null"')
        print "Auth request ${request_id}: completed (exit ${exit_code})"
        exit 0
        ;;
      failed)
        local exit_code reason
        exit_code=$(printf '%s' "$response" | jq -r '.exit_code // "null"')
        reason=$(printf '%s' "$response" | jq -r '.failure_reason // "no reason recorded"')
        print "Auth request ${request_id}: failed (exit ${exit_code}) — ${reason}"
        exit 1
        ;;
      rejected|withdrawn|superseded|expired|dismissed)
        local error
        error=$(printf '%s' "$response" | jq -r '.error // "none"')
        print "Auth request ${request_id}: ${request_status} — ${error}"
        exit 1
        ;;
      *)
        print -u2 "Auth request ${request_id}: unexpected status '${request_status}'"
        exit 1
        ;;
    esac

    sleep "$interval"
    elapsed=$((elapsed + interval))
  done

  print -u2 "Auth request ${request_id}: timed out after ${timeout}s"
  exit 1
}

# --- Main dispatch ---

case "${1:-}" in
  check)
    shift
    mandible_bind_arguments "inbox.check" '{}' "$@" >/dev/null || exit $?
    cmd_check
    ;;
  add)
    shift
    cmd_add "$@"
    ;;
  ack)
    shift
    cmd_ack "$@"
    ;;
  watch)
    shift
    cmd_watch "$@"
    ;;
  --help|-h)
    mandible_command_help inbox
    exit 0
    ;;
  "")
    cmd_default
    ;;
  *)
    print -u2 "unknown command: $1"
    print -u2 "usage: mandible inbox [check|add|ack|watch]"
    exit 1
    ;;
esac
