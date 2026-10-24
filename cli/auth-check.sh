#!/usr/bin/env bash
# mandible auth check: Check whether a branch is independent from the auth queue.
#
# Usage: {{command auth.check}}

source "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd -P)/command-syntax.sh"

set -euo pipefail

GIT_ENV_HELPER="${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/git-env.sh"
source "$GIT_ENV_HELPER"

API_HELPER="${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/api.sh"
source "$API_HELPER"

branch=""
repo=""
target_override=""
cwd_override=""
json=0

usage() {
  mandible_command_help auth check
}

binding=$(mandible_bind_main_arguments "auth.check" '{"branch":[{"option":"branch"},{"position":0}],"repo":{"option":"repo"},"target_override":{"option":["target","base"]},"cwd_override":{"option":"cwd"},"json":{"option":"json","constant":"1"}}' "$@") || exit $?
eval "$binding"

detect_protected_branch() {
  if git show-ref --verify --quiet refs/heads/develop 2>/dev/null; then
    echo "develop"
  else
    echo "main"
  fi
}

if [[ -z "$branch" ]]; then
  branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)
fi
if [[ -z "$branch" || "$branch" == "HEAD" ]]; then
  echo "Error: could not determine branch; pass --branch." >&2
  exit 2
fi

if [[ -n "$target_override" ]]; then
  base_branch="$target_override"
elif [[ -n "$repo" && -z "$cwd_override" ]]; then
  base_branch=""
else
  base_branch=$(detect_protected_branch)
fi

if [[ -n "$cwd_override" ]]; then
  target_cwd="$cwd_override"
elif [[ -n "$repo" ]]; then
  target_cwd=""
else
  target_cwd=""
  current_wt=""
  while IFS= read -r line; do
    if [[ "$line" == worktree\ * ]]; then
      current_wt="${line#worktree }"
    elif [[ "$line" == "branch refs/heads/${base_branch}" ]]; then
      target_cwd="$current_wt"
      break
    fi
  done < <(git worktree list --porcelain 2>/dev/null)
fi
if [[ -z "$target_cwd" && -z "$repo" ]]; then
  echo "Error: cannot find worktree for target branch '${base_branch}'" >&2
  exit 1
fi

if [[ -z "$repo" ]]; then
  repo=$(basename "$(dirname "$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)")" 2>/dev/null) || repo=""
fi

payload=$(jq -nc \
  --arg repo "$repo" \
  --arg base_branch "$base_branch" \
  --arg head_branch "$branch" \
  --arg cwd "$target_cwd" \
  '{
    repo: (if $repo == "" then null else $repo end),
    base_branch: (if $base_branch == "" then null else $base_branch end),
    head_branch: $head_branch,
    cwd: (if $cwd == "" then null else $cwd end)
  }')

response=$(api_send POST "/api/auth/check" "$payload") || {
  echo "Error: could not reach Mandible daemon at ${MANDIBLE_BASE}." >&2
  exit 1
}

if [[ "$json" == "1" ]]; then
  printf '%s\n' "$response"
  status=$(printf '%s' "$response" | jq -r '.check.status // "unknown"')
  [[ "$status" == "clean" ]]
  exit $?
fi

status=$(printf '%s' "$response" | jq -r '.check.status // "unknown"')
checked=$(printf '%s' "$response" | jq -r '.check.checked_requests // 0')
case "$status" in
  clean)
    printf 'Auth check: clean (%s pending request(s) checked)\n' "$checked"
    blocker=$(printf '%s' "$response" | jq -r '.check.publication_blocker.message // empty')
    if [[ -n "$blocker" ]]; then
      printf 'Publication blocked: %s\n' "$blocker"
    fi
    exit 0
    ;;
  conflict)
    printf 'Auth check: conflict\n' >&2
    printf '%s\n' "$response" | jq -r '
      .check.conflicts[]
      | "- " + .scope + ": " + (.request_id // "target") + " " + (.head_branch // "") +
        (if (.files | length) > 0 then " [" + (.files | join(", ")) + "]" else "" end)
    ' >&2
    exit 1
    ;;
  stale_request)
    # Issue fbf2a58 — a queued request references a head branch that no longer
    # exists. This is NOT a merge conflict and NOT a dirty worktree: the queue
    # holds a stale row (its branch was already merged and torn down, or
    # deleted). Surface the remediation, not a conflict/dirty-state banner.
    printf 'Auth check: stale queue request(s) — not a conflict\n' >&2
    printf '%s\n' "$response" | jq -r '
      .check.stale_requests[]?
      | "- " + .message
    ' >&2
    printf 'Remediation: reconcile the auth queue (already-merged requests self-resolve at daemon startup and periodically), or have the exact requester withdraw or replace the stale pending request, then recheck.\n' >&2
    exit 1
    ;;
  error)
    reason=$(printf '%s' "$response" | jq -r '.check.reason // "unknown"')
    printf 'Auth check: error: %s\n' "$reason" >&2
    exit 1
    ;;
  *)
    reason=$(printf '%s' "$response" | jq -r '.check.reason // "unknown"')
    printf 'Auth check: unknown: %s\n' "$reason" >&2
    exit 1
    ;;
esac
