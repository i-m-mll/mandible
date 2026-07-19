#!/usr/bin/env bash

set -u
set -o pipefail

CLIENT_HELPER="${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/ledger-client.sh"
source "$CLIENT_HELPER"

usage() {
  cat <<'USAGE'
Usage:
  mandible trash list [--project <ref>] [--state <state>]
  mandible trash create --project <ref> --branch <branch> --reason <reason> [--actor <actor>] [--issue <ref>...] [--checkout-root <path>] [--retention-days <days>]
  mandible trash restore <id> [--worktree-path <path>] [--actor <actor>]
  mandible trash gc [--now <timestamp>] [--limit <count>] [--actor <actor>]

Create resolves --project through Mandible's canonical project registry; a
registered checkout root is a valid reference. Successful create removes the
normal worktree and branch after preserving them in reversible trash custody.
USAGE
}

action="${1:-}"
shift || true

case "$action" in
  list)
    mandible_trash_list "$@"
    ;;
  create)
    requested_branch=""
    requested_checkout=""
    previous=""
    for argument in "$@"; do
      if [[ "$previous" == "--branch" ]]; then requested_branch="$argument"; fi
      if [[ "$previous" == "--checkout-root" ]]; then requested_checkout="$argument"; fi
      previous="$argument"
    done
    removed_path=""
    if [[ -n "$requested_branch" && -n "$requested_checkout" ]]; then
      current_path=""
      while IFS= read -r line; do
        if [[ "$line" == worktree\ * ]]; then
          current_path="${line#worktree }"
        elif [[ "$line" == branch\ refs/heads/* && "${line#branch refs/heads/}" == "$requested_branch" ]]; then
          removed_path="$current_path"
        fi
      done < <(git -C "$requested_checkout" worktree list --porcelain 2>/dev/null || true)
    fi
    response=$(mandible_trash_create "$@") || exit $?
    printf '%s\n' "$response"
    if printf '%s' "$response" | jq -e '.outcome.worktree_removed == true' >/dev/null 2>&1; then
      [[ -n "$removed_path" ]] || removed_path="for branch ${requested_branch:-unknown}"
      mandible_ledger_err "Trash custody complete: worktree path ${removed_path} is gone. No further work may happen there."
    elif printf '%s' "$response" | jq -e '.outcome.branch_removed == true' >/dev/null 2>&1; then
      mandible_ledger_err "Trash custody complete: the normal branch ref is gone; preserved bytes remain restorable until expiry."
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
