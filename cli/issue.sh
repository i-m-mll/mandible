#!/usr/bin/env bash

set -u
set -o pipefail

# Bug: fa1ac4c — CLI wrapper for manual issue operations.
# Ledger-era implementation: ordinary issue operations use the Mandible daemon API.

RESET=$'\033[0m'
RED=$'\033[31m'
GREEN=$'\033[32m'

err() {
  printf "%b\n" "$*" >&2
}

die() {
  err "$1"
  exit "${2:-1}"
}

usage() {
  cat <<'USAGE'
Usage:
  mandible issue new -t <title> -m <body> [--label <label>]...   Create a new issue
  mandible issue list [--status open|closed|all]                  List issues (default: open)
  mandible issue show <id>                                        Show issue details
  mandible issue close <id> [--commit <sha>]                      Close issue, recording resolving commit
  mandible issue open <id>                                        Reopen a closed issue
  mandible issue comment <id> -m <text>                           Add a comment
  mandible issue label add <id> <label>                           Add a label
  mandible issue label rm <id> <label>                            Remove a label
USAGE
}

require_tools() {
  command -v curl >/dev/null 2>&1 || die "curl not found." 1
  command -v jq >/dev/null 2>&1 || die "jq not found." 1
}

api_base() {
  printf 'http://127.0.0.1:%s' "${MANDIBLE_PORT:-19420}"
}

urlencode() {
  jq -rn --arg value "$1" '$value|@uri'
}

repo_root() {
  git rev-parse --show-toplevel 2>/dev/null || pwd
}

repo_ref() {
  repo_root
}

api_get() {
  local path="$1"
  curl -sf --max-time 15 "$(api_base)$path"
}

api_send() {
  local method="$1"
  local path="$2"
  local data="$3"
  curl -sf --max-time 15 -X "$method" "$(api_base)$path" \
    -H 'Content-Type: application/json' \
    -d "$data"
}

labels_json() {
  if (( $# == 0 )); then
    printf '[]'
    return
  fi
  printf '%s\n' "$@" | jq -R . | jq -s .
}

print_issue_detail() {
  jq -r '
    "\(.display_id) [\(.status)] \(.title)",
    (if (.labels | length) > 0 then "labels: \(.labels | join(", "))" else "labels:" end),
    "",
    .body,
    (.comments[]? | "\n---\n\(.id) \(.author.display) \(.source)\n\(.body)")
  '
}

cmd_close() {
  local id=""
  local sha=""

  while (( $# > 0 )); do
    case "$1" in
      --commit)
        if (( $# < 2 )); then
          die "Missing value for --commit." 2
        fi
        sha="$2"
        shift 2
        ;;
      -*)
        die "Unknown option: $1" 2
        ;;
      *)
        if [[ -z "$id" ]]; then
          id="$1"
        else
          die "Unexpected argument: $1" 2
        fi
        shift
        ;;
    esac
  done

  if [[ -z "$id" ]]; then
    die "Usage: mandible issue close <id> [--commit <sha>]" 2
  fi

  if [[ -z "$sha" ]]; then
    sha=$(git rev-parse HEAD 2>/dev/null) || sha="unknown"
  fi

  require_tools
  local message_payload status_payload resolution_payload repo_id
  message_payload=$(jq -n --arg message "Resolved by commit ${sha:0:12}" '{message:$message}')
  api_send POST "/api/ledger/issues/$(urlencode "$id")/comments" "$message_payload" >/dev/null || true

  status_payload=$(jq -n '{status:"closed", resolution:"fixed"}')
  api_send PATCH "/api/ledger/issues/$(urlencode "$id")" "$status_payload" >/dev/null \
    || die "${RED}Failed to close issue ${id}${RESET}" 1

  git notes append -m "closes: ${id:0:8}" "$sha" 2>/dev/null || true
  if ! git config --local push.notesRef >/dev/null 2>&1; then
    git config --local push.notesRef "refs/notes/commits" 2>/dev/null || true
  fi

  repo_id=$(basename "$(repo_root)")
  resolution_payload=$(jq -n --arg issue_id "$id" --arg commit_sha "$sha" --arg repo_id "$repo_id" \
    '{issue_id:$issue_id, commit_sha:$commit_sha, repo_id:$repo_id}')
  api_send POST "/api/issues/resolutions" "$resolution_payload" >/dev/null || true
  err "${GREEN}Closed issue ${id} (resolved by ${sha:0:12})${RESET}"
}

cmd_comment() {
  local id=""
  local message=""

  while (( $# > 0 )); do
    case "$1" in
      -m)
        if (( $# < 2 )); then
          die "Missing value for -m." 2
        fi
        message="$2"
        shift 2
        ;;
      -*)
        die "Unknown option: $1" 2
        ;;
      *)
        if [[ -z "$id" ]]; then
          id="$1"
        else
          die "Unexpected argument: $1" 2
        fi
        shift
        ;;
    esac
  done

  if [[ -z "$id" || -z "$message" ]]; then
    die "Usage: mandible issue comment <id> -m <text>" 2
  fi

  require_tools
  local payload
  payload=$(jq -n --arg message "$message" '{message:$message}')
  api_send POST "/api/ledger/issues/$(urlencode "$id")/comments" "$payload" >/dev/null
}

cmd_show() {
  local id="$1"

  if [[ -z "$id" ]]; then
    die "Usage: mandible issue show <id>" 2
  fi

  require_tools
  api_get "/api/ledger/issues/$(urlencode "$id")" | print_issue_detail
}

cmd_new() {
  local title=""
  local body=""
  local -a labels=()

  while (( $# > 0 )); do
    case "$1" in
      -t)
        if (( $# < 2 )); then
          die "Missing value for -t." 2
        fi
        title="$2"
        shift 2
        ;;
      -m)
        if (( $# < 2 )); then
          die "Missing value for -m." 2
        fi
        body="$2"
        shift 2
        ;;
      --label)
        if (( $# < 2 )); then
          die "Missing value for --label." 2
        fi
        labels+=("$2")
        shift 2
        ;;
      -*)
        die "Unknown option: $1" 2
        ;;
      *)
        die "Unexpected argument: $1" 2
        ;;
    esac
  done

  if [[ -z "$title" || -z "$body" ]]; then
    die "Usage: mandible issue new -t <title> -m <body> [--label <label>]..." 2
  fi

  require_tools
  local root payload id label_json repo
  root=$(repo_root)
  repo=$(basename "$root")
  label_json=$(labels_json "${labels[@]+"${labels[@]}"}")
  payload=$(jq -n --arg title "$title" --arg body "$body" --arg root "$root" --argjson labels "$label_json" \
    '{title:$title, body:$body, root:$root, labels:$labels}')
  id=$(api_send POST "/api/issues/$(urlencode "$repo")" "$payload" | jq -r '.display_id // .id') \
    || die "${RED}Failed to create issue${RESET}" 1
  err "${GREEN}Created issue ${id}${RESET}"
}

cmd_list() {
  local status="open"

  while (( $# > 0 )); do
    case "$1" in
      --status)
        if (( $# < 2 )); then
          die "Missing value for --status." 2
        fi
        status="$2"
        shift 2
        ;;
      -*)
        die "Unknown option: $1" 2
        ;;
      *)
        die "Unexpected argument: $1" 2
        ;;
    esac
  done

  case "$status" in
    open|closed|all|merged) ;;
    *) die "Unknown status: $status (expected open, closed, merged, or all)" 2 ;;
  esac

  require_tools
  local root query
  root=$(urlencode "$(repo_ref)")
  query="repo=${root}&status=$(urlencode "$status")"
  api_get "/api/issues?${query}" | jq -r '.[] as $repo | $repo.issues[] | "\(.id)\t\(.status)\t\($repo.repo_name)\t\(.title)"'
}

cmd_label() {
  if (( $# < 1 )); then
    cat <<'LABEL_USAGE' >&2
Usage:
  mandible issue label add <id> <label>   Add a label to an issue
  mandible issue label rm <id> <label>    Remove a label from an issue
LABEL_USAGE
    exit 2
  fi

  local action="$1"
  shift

  case "$action" in
    add) cmd_label_set true "$@" ;;
    rm)  cmd_label_set false "$@" ;;
    *)   die "Unknown label action: $action (expected add or rm)" 2 ;;
  esac
}

cmd_label_set() {
  local present="$1"
  shift
  if (( $# < 2 )); then
    die "Usage: mandible issue label add|rm <id> <label>" 2
  fi

  local id="$1"
  local label="$2"
  local payload
  require_tools
  payload=$(jq -n --arg label "$label" --argjson present "$present" '{label:$label, present:$present}')
  api_send POST "/api/ledger/issues/$(urlencode "$id")/labels" "$payload" >/dev/null \
    || die "${RED}Failed to update label '${label}' on ${id}${RESET}" 1
  if [[ "$present" == "true" ]]; then
    err "${GREEN}Added label '${label}' to ${id}${RESET}"
  else
    err "${GREEN}Removed label '${label}' from ${id}${RESET}"
  fi
}

cmd_open() {
  local id="${1:-}"

  if [[ -z "$id" ]]; then
    die "Usage: mandible issue open <id>" 2
  fi

  require_tools
  api_send PATCH "/api/ledger/issues/$(urlencode "$id")" '{"status":"open","resolution":null}' >/dev/null \
    || die "${RED}Failed to reopen issue ${id}${RESET}" 1
  err "${GREEN}Reopened issue ${id}${RESET}"
}

# --- Main ---

if (( $# < 1 )); then
  usage
  exit 2
fi

subcmd="$1"
shift

case "$subcmd" in
  new)     cmd_new "$@" ;;
  list)    cmd_list "$@" ;;
  show)    cmd_show "${1:-}" ;;
  close)   cmd_close "$@" ;;
  open)    cmd_open "${1:-}" ;;
  comment) cmd_comment "$@" ;;
  label)   cmd_label "$@" ;;
  -h|--help) usage ;;
  *)       die "Unknown subcommand: $subcmd" 2 ;;
esac
