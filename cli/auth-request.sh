#!/usr/bin/env bash
# mandible auth request: Submit an auth request to Mandible and poll until resolved.
# Combines submission + watching into a single command for use as a background task.
#
# Usage: mandible auth request <branch> --title <text> [options]
#
# Required:
#   <branch>                Branch to merge into protected branch
#   --title <text>          Dashboard title
#
# Options:
#   --commit-message <text> Commit message (auto-generated from git log if omitted)
#   --diff-summary <text>   Unified diff (auto-generated from git diff if omitted; truncated at 100KB)
#   --spec <text>           Spec/notes content
#   --repo <name>           Repo name (auto-detected from git toplevel basename)
#   --cwd <path>            Override auto-detected protected branch worktree path
#   --target <branch>       Override auto-detected target/base branch (default: protected branch)
#   --timeout <seconds>     SSE listen timeout (default: 14400 / 4 hours)
#   --no-watch              Submit only, don't poll
#
# Bug: c23f479 -- unified auth request submission + polling
#
# NOTE: If this script or the mandible CLI is being renamed/moved in the branch
# being merged, submit the request from the main worktree instead — the stored
# command must exist on the target branch at merge time.

set -euo pipefail

# MANDIBLE_PORT and MANDIBLE_BASE are exported by the dispatcher

# --- Usage ---

usage() {
  sed -n '2,/^$/{ s/^# //; s/^#$//; p; }' "$0"
}

# --- Argument parsing ---

branch=""
title=""
commit_message=""
diff_summary=""
spec_content=""
repo=""
cwd_override=""
target_override=""
timeout=14400
no_watch=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --title)          title="$2"; shift 2 ;;
    --commit-message) commit_message="$2"; shift 2 ;;
    --diff-summary)   diff_summary="$2"; shift 2 ;;
    --spec)           spec_content="$2"; shift 2 ;;
    --repo)           repo="$2"; shift 2 ;;
    --cwd)            cwd_override="$2"; shift 2 ;;
    --target)         target_override="$2"; shift 2 ;;
    --timeout)        timeout="$2"; shift 2 ;;
    --no-watch)       no_watch=1; shift ;;
    -h|--help)        usage; exit 0 ;;
    -*)               echo "Unknown option: $1" >&2; exit 2 ;;
    *)
      if [[ -z "$branch" ]]; then
        branch="$1"
      else
        echo "Unexpected argument: $1" >&2; exit 2
      fi
      shift
      ;;
  esac
done

if [[ -z "$branch" ]]; then
  echo "Usage: mandible auth request <branch> --title <text> [options]" >&2
  exit 2
fi
if [[ -z "$title" ]]; then
  echo "Error: --title is required" >&2
  exit 2
fi

# --- Auto-detect protected branch ---

detect_protected_branch() {
  if git show-ref --verify --quiet refs/heads/develop 2>/dev/null; then
    echo "develop"
  else
    echo "main"
  fi
}

# Bug: c6bd770 — allow explicit --target override so callers can target a branch
# other than the auto-detected protected branch (e.g., merging a CLAUDE.md update
# into main in a repo where develop is protected).
if [[ -n "$target_override" ]]; then
  base_branch="$target_override"
else
  base_branch=$(detect_protected_branch)
fi

# --- Auto-detect cwd (protected branch worktree) ---

if [[ -n "$cwd_override" ]]; then
  target_cwd="$cwd_override"
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

  if [[ -z "$target_cwd" ]]; then
    echo "Error: cannot find worktree for protected branch '${base_branch}'" >&2
    exit 1
  fi
fi

# --- Auto-detect repo name ---

if [[ -z "$repo" ]]; then
  # Bug: 72384c5 — use --git-common-dir instead of --show-toplevel so worktrees
  # resolve to the real repo root, not the worktree directory.
  repo=$(basename "$(dirname "$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)")" 2>/dev/null) || repo=""
fi

# --- Verify branch has unique commits ---

unique_commits=$(git log --oneline "${base_branch}..${branch}" 2>/dev/null | wc -l | tr -d ' ')
if [[ "$unique_commits" -eq 0 ]]; then
  echo "Error: branch '${branch}' has no unique commits vs '${base_branch}' -- already merged?" >&2
  exit 1
fi

# --- Verify protected branch worktree is clean ---

wt_status=$(git -C "$target_cwd" status --short 2>/dev/null)
if [[ -n "$wt_status" ]]; then
  echo "Warning: protected branch worktree is dirty, attempting auto-fix..." >&2
  git -C "$target_cwd" checkout HEAD -- . 2>/dev/null || true
  # Re-check
  wt_status=$(git -C "$target_cwd" status --short 2>/dev/null)
  if [[ -n "$wt_status" ]]; then
    # Check if only untracked files remain
    # Bug: fee554b — untracked files alone don't block a merge; pre-auth-check
    # removes the specific conflicting ones, so a purely untracked dirty state
    # here is non-fatal. Only tracked dirty files actually prevent the merge.
    tracked_dirty=$(git -C "$target_cwd" status --short 2>/dev/null | grep -v '^??' || true)
    if [[ -z "$tracked_dirty" ]]; then
      echo "Warning: protected branch worktree has untracked files (non-blocking):" >&2
      echo "$wt_status" >&2
      # Untracked files don't prevent merge — continue
    else
      echo "Error: protected branch worktree still dirty after auto-fix:" >&2
      echo "$wt_status" >&2
      exit 1
    fi
  fi
fi

# --- Pre-flight: check for merge conflicts ---
# Run a dry-run merge to catch conflicts before submitting the request.
# The actual merge check also happens in auth-merge, but catching it here
# lets the agent fail fast rather than waiting for user YubiKey auth.
# Bug: be8b0ed — pre-submission conflict check missing from auth-request

pre_auth_check="${HOME}/.dotfiles/bin/pre-auth-check"
if [[ -x "$pre_auth_check" ]]; then
  if ! "$pre_auth_check" "$target_cwd" "$branch" "$base_branch" 2>&1; then
    echo "Error: pre-submission conflict check failed. Resolve conflicts before submitting." >&2
    exit 1
  fi
fi

# --- Auto-detect diff stats ---

shortstat=$(git diff --shortstat "${base_branch}..${branch}" 2>/dev/null || echo "")
files_changed=0
additions=0
deletions=0
if [[ -n "$shortstat" ]]; then
  files_changed=$(echo "$shortstat" | grep -oE '[0-9]+ file' | grep -oE '[0-9]+' || echo 0)
  additions=$(echo "$shortstat" | grep -oE '[0-9]+ insertion' | grep -oE '[0-9]+' || echo 0)
  deletions=$(echo "$shortstat" | grep -oE '[0-9]+ deletion' | grep -oE '[0-9]+' || echo 0)
fi

# Ensure these are valid integers (default to 0 if empty or non-numeric)
[[ "$files_changed" =~ ^[0-9]+$ ]] || files_changed=0
[[ "$additions" =~ ^[0-9]+$ ]] || additions=0
[[ "$deletions" =~ ^[0-9]+$ ]] || deletions=0

# --- Auto-detect diff summary ---
# Bug: c8dd9c8 — use unified diff format so the UI's per-file tab viewer works.
# The --diff-summary CLI flag still works but should contain unified diff format.

MAX_DIFF_BYTES=102400  # 100KB truncation limit

if [[ -z "$diff_summary" ]]; then
  full_diff=$(git diff "${base_branch}..${branch}" 2>/dev/null) || full_diff=""
  diff_bytes=${#full_diff}
  if [[ "$diff_bytes" -gt "$MAX_DIFF_BYTES" ]]; then
    diff_summary="${full_diff:0:$MAX_DIFF_BYTES}
... [truncated: ${diff_bytes} bytes total, showing first ${MAX_DIFF_BYTES}]"
  else
    diff_summary="$full_diff"
  fi
fi

# --- Auto-detect commit message ---
# Bug: 8b0b5e2 — COMMIT_MSG.txt removed; auto-generate from git log instead.

if [[ -z "$commit_message" ]]; then
  commit_message=$(git log --format="%s" "${base_branch}..${branch}" 2>/dev/null | head -20)
  if [[ -z "$commit_message" ]]; then
    commit_message="Merge ${branch}"
  fi
fi

# --- Build command and metadata ---

command="${HOME}/.dotfiles/bin/mandible auth merge ${branch} --into ${base_branch}"
head_branch="$branch"
execution_mode="daemon"

# --- Submit to Mandible ---

payload=$(jq -nc \
  --arg command "$command" \
  --arg cwd "$target_cwd" \
  --arg title "$title" \
  --arg execution_mode "$execution_mode" \
  --arg repo "$repo" \
  --arg base_branch "$base_branch" \
  --arg head_branch "$head_branch" \
  --argjson files_changed "$files_changed" \
  --argjson additions "$additions" \
  --argjson deletions "$deletions" \
  --arg diff_summary "$diff_summary" \
  --arg commit_message "$commit_message" \
  --arg spec_content "$spec_content" \
  '{
    command: $command,
    cwd: $cwd,
    title: $title,
    execution_mode: $execution_mode,
    repo: $repo,
    base_branch: $base_branch,
    head_branch: $head_branch,
    files_changed: $files_changed,
    additions: $additions,
    deletions: $deletions,
    diff_summary: $diff_summary,
    commit_message: $commit_message,
    spec_content: $spec_content
  }')

# Bug: de8d29c — use -w to capture HTTP status separately so we can distinguish
# a 409 Conflict (duplicate) from a connection failure. curl -sf treats HTTP 4xx
# as failures (exit 22), which triggered the "Mandible unreachable" fallback and
# caused a terminal pane to spawn instead of recognising the duplicate.
# The response body is written to a temp file; HTTP status in the exit variable.
tmp_response=$(mktemp)
tmp_sse_result=$(mktemp)
trap 'rm -f "$tmp_response" "$tmp_sse_result"' EXIT

http_status=$(curl -s --max-time 5 -o "$tmp_response" -w "%{http_code}" \
  -X POST "${MANDIBLE_BASE}/api/auth/request" \
  -H 'Content-Type: application/json' \
  -d "$payload" 2>/dev/null) || http_status=""

response=$(cat "$tmp_response" 2>/dev/null || echo "")

if [[ -z "$http_status" || "$http_status" == "000" ]]; then
  # Connection failed — Mandible unreachable
  echo "Mandible unreachable. Falling back to terminal pane..." >&2

  auth_merge_cmd="${HOME}/.dotfiles/bin/mandible auth merge ${branch} --into ${base_branch}"

  if [[ -n "${ZELLIJ:-}" ]]; then
    # Bug: 36a37d7 — pass --cwd so the pane starts in the main worktree, not
    # wherever the agent's Bash tool happened to be CWD'd.
    zellij run --floating --pinned true --close-on-exit --name "Auth: merge ${branch}" --cwd "${target_cwd}" -- $auth_merge_cmd
    echo "Spawned Zellij pane for mandible auth merge"
    exit 0
  elif [[ -n "${TMUX:-}" ]]; then
    tmux split-window -v -l 15 -c "${target_cwd}" "$auth_merge_cmd"
    echo "Spawned tmux pane for mandible auth merge"
    exit 0
  else
    echo "Run manually: $auth_merge_cmd" >&2
    exit 1
  fi
fi

if [[ "$http_status" == "409" ]]; then
  # Bug: 16985e8 — server detected a duplicate. Use the existing request_id.
  existing_id=$(printf '%s' "$response" | jq -r '.request_id // empty' 2>/dev/null || echo "")
  existing_status=$(printf '%s' "$response" | jq -r '.status // "pending"' 2>/dev/null || echo "pending")
  echo "Auth request already exists (${existing_status}): ${existing_id}" >&2
  echo "Use PUT /api/auth/request/${existing_id} to update it, or check the dashboard." >&2
  # Output the existing ID on stdout so callers can detect and handle it
  request_id="$existing_id"
  if [[ -z "$request_id" ]]; then
    echo "Error: 409 but no existing request_id in response: $response" >&2
    exit 1
  fi
  # Skip the submit success message and go straight to watching
  echo "Auth request (existing): ${request_id}"
  echo "Title: ${title}"
  echo "Branch: ${head_branch} -> ${base_branch}"
elif [[ "$http_status" != "201" ]]; then
  error_msg=$(printf '%s' "$response" | jq -r '.error // empty' 2>/dev/null || echo "")
  echo "Error: POST /api/auth/request returned HTTP ${http_status}" >&2
  [[ -n "$error_msg" ]] && echo "Server error: ${error_msg}" >&2
  exit 1
else
  request_id=$(printf '%s' "$response" | jq -r '.request_id // empty' 2>/dev/null || echo "")
  if [[ -z "$request_id" ]]; then
    echo "Error: no request_id in response: $response" >&2
    exit 1
  fi

  echo "Auth request submitted: ${request_id}"
  echo "Title: ${title}"
  echo "Branch: ${head_branch} -> ${base_branch}"
  echo "Files: ${files_changed} changed, +${additions} -${deletions}"
fi

# --- Watch for resolution via SSE (unless --no-watch) ---

if [[ $no_watch -eq 1 ]]; then
  exit 0
fi

echo "Listening for auth resolution via SSE (timeout: ${timeout}s)..."

# SSE endpoint with topic filter — single persistent connection, no polling.
# Mandible emits auth:resolved when a request reaches terminal state.
# Heartbeats every 15s keep the connection alive.

#
# Bug: 2fa626e — when the while-loop exits inside a pipeline, curl gets SIGPIPE
# and exits 23. With set -o pipefail, the pipeline exit code becomes 23 (non-zero),
# causing false failure even when the auth succeeded.
#
# Fix: disable pipefail for the SSE pipeline, communicate resolution via a temp
# file written from within the while-subshell, then check it after the pipeline
# completes. This avoids exit 23 propagating as a failure.
set +o pipefail
curl -sN --max-time "$timeout" \
  "${MANDIBLE_BASE}/api/events?topic=auth:" 2>/dev/null | \
while IFS= read -r line; do
  # Skip heartbeat comments and empty lines
  [[ "$line" =~ ^: ]] && continue
  [[ -z "$line" ]] && continue

  # SSE format: "data: {json}"
  if [[ "$line" == data:* ]]; then
    json="${line#data: }"
    evt_type=$(printf '%s' "$json" | jq -r '.type // empty' 2>/dev/null) || continue
    evt_id=$(printf '%s' "$json" | jq -r '.data.request_id // .data.id // empty' 2>/dev/null) || continue

    # Only care about our request
    [[ "$evt_id" != "$request_id" ]] && continue

    case "$evt_type" in
      auth:resolved)
        status=$(printf '%s' "$json" | jq -r '.data.status // "unknown"' 2>/dev/null)
        exit_code_val=$(printf '%s' "$json" | jq -r '.data.exit_code // "null"' 2>/dev/null)
        case "$status" in
          completed)
            echo "Auth request ${request_id}: completed (exit ${exit_code_val})"
            printf 'ok' > "$tmp_sse_result"
            break
            ;;
          rejected|expired|dismissed)
            error=$(printf '%s' "$json" | jq -r '.data.error // "none"' 2>/dev/null)
            echo "Auth request ${request_id}: ${status} -- ${error}"
            printf 'fail' > "$tmp_sse_result"
            break
            ;;
          *)
            echo "Auth request ${request_id}: resolved with status '${status}'"
            printf 'ok' > "$tmp_sse_result"
            break
            ;;
        esac
        ;;
    esac
  fi
done || true
set -o pipefail

sse_result=$(cat "$tmp_sse_result" 2>/dev/null || echo "")

if [[ "$sse_result" == "ok" ]]; then
  exit 0
elif [[ "$sse_result" == "fail" ]]; then
  exit 1
fi

# If we reach here, curl exited (timeout or connection lost) without resolving.
# Do a single fallback poll to check final status.
final=$(curl -sf --max-time 5 "${MANDIBLE_BASE}/api/auth/request/${request_id}" 2>/dev/null)
if [[ -n "$final" ]]; then
  status=$(printf '%s' "$final" | jq -r '.status // "unknown"')
  case "$status" in
    completed)
      exit_code_val=$(printf '%s' "$final" | jq -r '.exit_code // "null"')
      echo "Auth request ${request_id}: completed (exit ${exit_code_val})"
      exit 0
      ;;
    rejected|expired|dismissed)
      error=$(printf '%s' "$final" | jq -r '.error // "none"')
      echo "Auth request ${request_id}: ${status} -- ${error}"
      exit 1
      ;;
  esac
fi

echo "Auth request ${request_id}: SSE connection lost, status unknown. Check dashboard." >&2
exit 1
