#!/usr/bin/env bash

set -u
set -o pipefail

# TODO: Add to ~/.dotfiles/bin/mandible dispatcher:
#   issue) shift; exec "$MANDIBLE_CLI_DIR/issue.sh" "$@" ;;
# This requires a dotfiles feature branch (see issue c934e60).

# Bug: fa1ac4c — CLI wrapper for manual issue operations.
# Enforces the resolving-commit convention when closing issues.

RESET=$'\033[0m'
DIM_WHITE=$'\033[2;37m'
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

  if ! command -v git-bug >/dev/null 2>&1; then
    die "git-bug not found." 1
  fi

  # Record resolving commit
  git-bug bug comment new "$id" -m "Resolved by commit ${sha:0:12}" --non-interactive 2>/dev/null || true

  # Add git note linking commit to issue
  git notes append -m "closes: ${id:0:8}" "$sha" 2>/dev/null || true

  # Ensure git notes get pushed with normal pushes
  if ! git config --local push.notesRef >/dev/null 2>&1; then
    git config --local push.notesRef "refs/notes/commits" 2>/dev/null || true
  fi

  # Close the issue
  if git-bug bug status close "$id" 2>/dev/null; then
    err "${GREEN}Closed issue ${id} (resolved by ${sha:0:12})${RESET}"
  else
    die "${RED}Failed to close issue ${id}${RESET}" 1
  fi

  # Bug: c934e60 — record resolution in Mandible DB (non-fatal if daemon is down)
  MANDIBLE_PORT="${MANDIBLE_PORT:-19420}"
  repo_id=$(git rev-parse --show-toplevel 2>/dev/null | xargs basename)
  curl -sf --max-time 5 \
    "http://127.0.0.1:${MANDIBLE_PORT}/api/issues/resolutions" \
    -H 'Content-Type: application/json' \
    -d "{\"issue_id\":\"${id}\",\"commit_sha\":\"${sha}\",\"repo_id\":\"${repo_id}\"}" \
    >/dev/null 2>&1 || true
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

  if ! command -v git-bug >/dev/null 2>&1; then
    die "git-bug not found." 1
  fi

  git-bug bug comment new "$id" -m "$message" --non-interactive
}

cmd_show() {
  local id="$1"

  if [[ -z "$id" ]]; then
    die "Usage: mandible issue show <id>" 2
  fi

  if ! command -v git-bug >/dev/null 2>&1; then
    die "git-bug not found." 1
  fi

  git-bug bug show "$id"
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

  if ! command -v git-bug >/dev/null 2>&1; then
    die "git-bug not found." 1
  fi

  local output
  output=$(git-bug bug new -t "$title" -m "$body" --non-interactive 2>&1) || die "${RED}Failed to create issue${RESET}: $output" 1

  # Extract the issue ID from git-bug output
  local id
  id=$(printf '%s' "$output" | grep -oE '[0-9a-f]{7,}' | head -1)

  # Apply labels
  local label
  for label in "${labels[@]+"${labels[@]}"}"; do
    git-bug bug label new "$id" "$label" 2>/dev/null || err "${RED}Failed to add label: ${label}${RESET}"
  done

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

  if ! command -v git-bug >/dev/null 2>&1; then
    die "git-bug not found." 1
  fi

  case "$status" in
    open)   git-bug bug --status open ;;
    closed) git-bug bug --status closed ;;
    all)    git-bug bug ;;
    *)      die "Unknown status: $status (expected open, closed, or all)" 2 ;;
  esac
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
    add) cmd_label_add "$@" ;;
    rm)  cmd_label_rm "$@" ;;
    *)   die "Unknown label action: $action (expected add or rm)" 2 ;;
  esac
}

cmd_label_add() {
  if (( $# < 2 )); then
    die "Usage: mandible issue label add <id> <label>" 2
  fi

  local id="$1"
  local label="$2"

  if ! command -v git-bug >/dev/null 2>&1; then
    die "git-bug not found." 1
  fi

  if git-bug bug label new "$id" "$label" 2>/dev/null; then
    err "${GREEN}Added label '${label}' to ${id}${RESET}"
  else
    die "${RED}Failed to add label '${label}' to ${id}${RESET}" 1
  fi
}

cmd_label_rm() {
  if (( $# < 2 )); then
    die "Usage: mandible issue label rm <id> <label>" 2
  fi

  local id="$1"
  local label="$2"

  if ! command -v git-bug >/dev/null 2>&1; then
    die "git-bug not found." 1
  fi

  if git-bug bug label rm "$id" "$label" 2>/dev/null; then
    err "${GREEN}Removed label '${label}' from ${id}${RESET}"
  else
    die "${RED}Failed to remove label '${label}' from ${id}${RESET}" 1
  fi
}

cmd_open() {
  local id="${1:-}"

  if [[ -z "$id" ]]; then
    die "Usage: mandible issue open <id>" 2
  fi

  if ! command -v git-bug >/dev/null 2>&1; then
    die "git-bug not found." 1
  fi

  if git-bug bug status open "$id" 2>/dev/null; then
    err "${GREEN}Reopened issue ${id}${RESET}"
  else
    die "${RED}Failed to reopen issue ${id}${RESET}" 1
  fi
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
