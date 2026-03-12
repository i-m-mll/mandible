#!/usr/bin/env bash

set -u
set -o pipefail

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
  mandible issue close <id> [--commit <sha>]   Close issue, recording resolving commit
  mandible issue comment <id> -m <text>         Add a comment
  mandible issue show <id>                      Show issue details
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

# --- Main ---

if (( $# < 1 )); then
  usage
  exit 2
fi

subcmd="$1"
shift

case "$subcmd" in
  close)   cmd_close "$@" ;;
  comment) cmd_comment "$@" ;;
  show)    cmd_show "${1:-}" ;;
  -h|--help) usage ;;
  *)       die "Unknown subcommand: $subcmd" 2 ;;
esac
