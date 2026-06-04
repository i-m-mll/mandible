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
#   --depends-on <id>       Auth request ID that must complete before this one runs
#   --issue <id>            Issue ID to reference for context (repeatable; does not close)
#   --ref-issue <id>        Alias for --issue
#   --closes-issue <id>     Issue ID to close on successful merge (repeatable)
#   --type <type>           Auth request type (default: merge; options: merge, commit, force-push, branch-delete, config-change, preset-promote, data-delete)
#   --handoff <text>        Post-merge handoff note for next session
#   --dirty-policy <policy> Protected-root dirty policy: block, allow-untracked, stash, branch-off
#   --dirty-branch-prefix <prefix>
#                           Branch prefix for --dirty-policy branch-off (default from mandible.toml or shelve/protected-root)
#   --timeout <seconds>     SSE listen timeout (default: 14400 / 4 hours)
#   --force / -f             Skip CWD validation checks
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
auth_type="merge"
commit_message=""
diff_summary=""
spec_content=""
post_merge_handoff=""
depends_on_id=""
ISSUE_REFERENCES=()
ISSUE_CLOSURES=()
repo=""
cwd_override=""
target_override=""
timeout=14400
no_watch=0
force=false
dirty_policy=""
dirty_branch_prefix=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --title)          title="$2"; shift 2 ;;
    --type)           auth_type="$2"; shift 2 ;;
    --commit-message) commit_message="$2"; shift 2 ;;
    --diff-summary)   diff_summary="$2"; shift 2 ;;
    --spec)           spec_content="$2"; shift 2 ;;
    --handoff)        post_merge_handoff="$2"; shift 2 ;;
    --dirty-policy)   dirty_policy="$2"; shift 2 ;;
    --dirty-branch-prefix) dirty_branch_prefix="$2"; shift 2 ;;
    --depends-on)     depends_on_id="$2"; shift 2 ;;
    --issue|--ref-issue|--references-issue) ISSUE_REFERENCES+=("$2"); shift 2 ;;
    --closes-issue|--close-issue) ISSUE_CLOSURES+=("$2"); shift 2 ;;
    --repo)           repo="$2"; shift 2 ;;
    --cwd)            cwd_override="$2"; shift 2 ;;
    --target)         target_override="$2"; shift 2 ;;
    --timeout)        timeout="$2"; shift 2 ;;
    --no-watch)       no_watch=1; shift ;;
    --force|-f)       force=true; shift ;;
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
if [ $(( ${#ISSUE_REFERENCES[@]} + ${#ISSUE_CLOSURES[@]} )) -eq 0 ]; then
  echo "Error: at least one --issue <id> or --closes-issue <id> is required" >&2
  exit 1
fi

# Validate auth type
valid_types="merge commit force-push branch-delete config-change preset-promote data-delete"
if ! echo "$valid_types" | grep -qw "$auth_type"; then
  echo "Error: invalid --type '$auth_type'. Must be one of: $valid_types" >&2
  exit 2
fi

# --- Repo config helpers ---

read_mandible_toml_value() {
  local repo_root="$1"
  local section="$2"
  local key="$3"
  local config_file=""

  for candidate in "$repo_root/mandible.toml" "$repo_root/.mandible.toml"; do
    if [[ -f "$candidate" ]]; then
      config_file="$candidate"
      break
    fi
  done
  [[ -n "$config_file" ]] || return 1

  awk -v section="$section" -v key="$key" '
    function trim(value) {
      gsub(/^[ \t\r\n]+|[ \t\r\n]+$/, "", value)
      return value
    }
    BEGIN { in_section = 0 }
    /^[ \t]*#/ { next }
    /^[ \t]*\[/ {
      current = $0
      sub(/^[ \t]*\[/, "", current)
      sub(/\][ \t]*$/, "", current)
      in_section = (trim(current) == section)
      next
    }
    in_section {
      split($0, parts, "=")
      candidate = trim(parts[1])
      if (candidate == key) {
        value = substr($0, index($0, "=") + 1)
        value = trim(value)
        sub(/[ \t]*#.*/, "", value)
        value = trim(value)
        if ((substr(value, 1, 1) == "\"" && substr(value, length(value), 1) == "\"") ||
            (substr(value, 1, 1) == "'"'"'" && substr(value, length(value), 1) == "'"'"'")) {
          value = substr(value, 2, length(value) - 2)
        }
        print value
        exit 0
      }
    }
  ' "$config_file"
}

normalize_dirty_policy() {
  case "$1" in
    ""|block) echo "block" ;;
    allow-untracked|allow_untracked) echo "allow-untracked" ;;
    stash) echo "stash" ;;
    branch-off|branch_off) echo "branch-off" ;;
    *)
      echo "Error: invalid --dirty-policy '$1'. Must be one of: block, allow-untracked, stash, branch-off" >&2
      exit 2
      ;;
  esac
}

truthy_config_value() {
  case "$1" in
    true|True|TRUE|1|yes|Yes|YES|on|On|ON) return 0 ;;
    *) return 1 ;;
  esac
}

safe_branch_component() {
  printf '%s' "$1" | tr '/: .' '____' | tr -cd 'A-Za-z0-9._-'
}

git_status_for_json() {
  local status="$1"
  if [[ -z "$status" ]]; then
    printf '[]'
  else
    printf '%s\n' "$status" | jq -R '{
      status: .[0:2],
      path: (.[3:] | sub("^\""; "") | sub("\"$"; ""))
    }' | jq -sc .
  fi
}

build_dirty_action_json() {
  local policy="$1"
  local action="$2"
  local status="$3"
  local branch_name="${4:-}"
  local worktree_path="${5:-}"
  local stash_ref="${6:-}"
  local message="$7"

  jq -nc \
    --arg policy "$policy" \
    --arg action "$action" \
    --arg branch "$branch_name" \
    --arg worktree "$worktree_path" \
    --arg stash "$stash_ref" \
    --arg message "$message" \
    --argjson files "$(git_status_for_json "$status")" \
    '{
      policy: $policy,
      action: $action,
      branch: (if $branch == "" then null else $branch end),
      worktree: (if $worktree == "" then null else $worktree end),
      stash: (if $stash == "" then null else $stash end),
      files: $files,
      message: $message
    }'
}

append_dirty_action_to_spec() {
  local action_json="$1"
  [[ "$action_json" != "null" ]] || return 0
  local pretty
  pretty=$(printf '%s' "$action_json" | jq .)
  if [[ -n "$spec_content" ]]; then
    spec_content="${spec_content}

Protected-root dirty action:
\`\`\`json
${pretty}
\`\`\`"
  else
    spec_content="Protected-root dirty action:
\`\`\`json
${pretty}
\`\`\`"
  fi
}

ensure_clean_with_dirty_policy() {
  local target="$1"
  local base="$2"
  local source="$3"
  local policy="$4"
  local branch_prefix="$5"
  local include_untracked="$6"
  local status tracked_status stash_args stash_ref timestamp shelve_branch safe_branch shelve_root message

  status=$(git -C "$target" status --porcelain=v1 2>/dev/null || true)
  if [[ -z "$status" ]]; then
    printf 'null'
    return 0
  fi

  tracked_status=$(printf '%s\n' "$status" | grep -v '^??' || true)
  case "$policy" in
    block)
      echo "Error: protected branch worktree is dirty; auth request will not modify it." >&2
      echo "$status" >&2
      echo "Move, commit, stash, or explicitly request --dirty-policy stash or --dirty-policy branch-off." >&2
      exit 1
      ;;
    allow-untracked)
      if [[ -n "$tracked_status" ]]; then
        echo "Error: protected branch worktree has tracked/staged changes; auth request will not modify it." >&2
        echo "$status" >&2
        exit 1
      fi
      message="Protected branch worktree has untracked files; continuing because dirty policy is allow-untracked."
      echo "Warning: $message" >&2
      echo "$status" >&2
      build_dirty_action_json "$policy" "allowed-untracked" "$status" "" "" "" "$message"
      return 0
      ;;
    stash|branch-off)
      stash_args=(push)
      if truthy_config_value "$include_untracked"; then
        stash_args+=(-u)
      fi
      stash_args+=(-m "mandible protected-root dirty state before auth request ${source}")
      git -C "$target" stash "${stash_args[@]}" >/dev/null
      stash_ref=$(git -C "$target" rev-parse -q --verify refs/stash 2>/dev/null || true)
      if [[ -z "$stash_ref" ]]; then
        echo "Error: dirty policy ${policy} could not create a stash for protected-root changes." >&2
        exit 1
      fi
      if [[ "$policy" == "stash" ]]; then
        message="Protected-root changes were preserved in stash ${stash_ref} before auth request submission."
        echo "Warning: $message" >&2
        build_dirty_action_json "$policy" "stashed" "$status" "" "" "$stash_ref" "$message"
        return 0
      fi

      timestamp=$(date +%Y%m%d-%H%M%S)
      shelve_branch="${branch_prefix}-${timestamp}"
      while git -C "$target" rev-parse --verify "refs/heads/${shelve_branch}" >/dev/null 2>&1; do
        sleep 1
        timestamp=$(date +%Y%m%d-%H%M%S)
        shelve_branch="${branch_prefix}-${timestamp}"
      done
      safe_branch=$(safe_branch_component "$shelve_branch")
      shelve_root="${target}/worktrees/${safe_branch}"
      mkdir -p "$(dirname "$shelve_root")"
      git -C "$target" branch "$shelve_branch" "$base"
      git -C "$target" worktree add "$shelve_root" "$shelve_branch" >/dev/null
      if ! git -C "$shelve_root" stash apply --index "$stash_ref" >/dev/null 2>&1; then
        git -C "$shelve_root" stash apply "$stash_ref" >/dev/null
      fi
      git -C "$target" stash drop "$stash_ref" >/dev/null
      message="Protected-root changes were moved to branch ${shelve_branch} at ${shelve_root} before auth request submission."
      echo "Warning: $message" >&2
      build_dirty_action_json "$policy" "branched-off" "$status" "$shelve_branch" "$shelve_root" "" "$message"
      return 0
      ;;
  esac
}

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

# --- Validate CWD and branch ---
# Bug: 4594641 — validate target_cwd is on the protected branch and that the
# source branch exists in the repo, before submitting. Catches misconfigured
# --cwd overrides and cross-repo submission mistakes.

RED='\033[0;31m'
RESET='\033[0m'

if [[ "$force" != "true" ]]; then
  # Validation 1: Confirm target_cwd is on the protected branch
  cwd_branch=$(git -C "$target_cwd" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
  if [[ "$cwd_branch" != "$base_branch" ]]; then
    echo -e "${RED}Error: target CWD '$target_cwd' is on branch '$cwd_branch', expected '$base_branch'${RESET}" >&2
    echo "The CWD for auth merge must be the worktree tracking the protected branch." >&2
    echo "Use --cwd to specify the correct protected branch worktree, or --force to skip this check." >&2
    exit 1
  fi

  # Validation 2: Confirm the source branch exists in that repo
  if ! git -C "$target_cwd" rev-parse --verify "refs/heads/$branch" >/dev/null 2>&1; then
    echo -e "${RED}Error: branch '$branch' not found in repo at '$target_cwd'${RESET}" >&2
    echo "Ensure you are submitting from the correct repository." >&2
    exit 1
  fi
fi

# --- Auto-detect repo name ---

if [[ -z "$repo" ]]; then
  # Bug: 72384c5 — use --git-common-dir instead of --show-toplevel so worktrees
  # resolve to the real repo root, not the worktree directory.
  repo=$(basename "$(dirname "$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)")" 2>/dev/null) || repo=""
fi

# --- Resolve protected-root dirty policy ---

configured_dirty_policy=$(read_mandible_toml_value "$target_cwd" "auth.protected_root_dirty" "default_policy" || true)
configured_allow_untracked=$(read_mandible_toml_value "$target_cwd" "auth.protected_root_dirty" "allow_untracked" || true)
configured_branch_prefix=$(read_mandible_toml_value "$target_cwd" "auth.protected_root_dirty" "branch_prefix" || true)
configured_include_untracked=$(read_mandible_toml_value "$target_cwd" "auth.protected_root_dirty" "include_untracked" || true)

if [[ -z "$dirty_policy" ]]; then
  if [[ -n "$configured_dirty_policy" ]]; then
    dirty_policy="$configured_dirty_policy"
  elif truthy_config_value "$configured_allow_untracked"; then
    dirty_policy="allow-untracked"
  else
    dirty_policy="block"
  fi
fi
dirty_policy=$(normalize_dirty_policy "$dirty_policy")
if [[ -z "$dirty_branch_prefix" ]]; then
  dirty_branch_prefix="${configured_branch_prefix:-shelve/protected-root}"
fi
if [[ -z "$configured_include_untracked" ]]; then
  configured_include_untracked="true"
fi

# --- Verify branch has unique commits ---

unique_commits=$(git log --oneline "${base_branch}..${branch}" 2>/dev/null | wc -l | tr -d ' ')
if [[ "$unique_commits" -eq 0 ]]; then
  echo "Error: branch '${branch}' has no unique commits vs '${base_branch}' -- already merged?" >&2
  exit 1
fi

# --- Verify or preserve protected branch worktree dirtiness ---

# Bug: 350817b — never destructively auto-fix protected-root dirtiness.
# Policy is explicit via --dirty-policy or repo-local mandible.toml /
# .mandible.toml [auth.protected_root_dirty].
protected_root_dirty_action_json=$(ensure_clean_with_dirty_policy \
  "$target_cwd" "$base_branch" "$branch" "$dirty_policy" "$dirty_branch_prefix" "$configured_include_untracked")
append_dirty_action_to_spec "$protected_root_dirty_action_json"

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
  commit_message=$(git log --format="- %s" "${base_branch}..${branch}" 2>/dev/null | head -20)
  if [[ -z "$commit_message" ]]; then
    commit_message="Merge ${branch}"
  fi
fi

# --- Build command and metadata ---

command="${HOME}/.dotfiles/bin/mandible auth merge ${branch} --into ${base_branch}"
head_branch="$branch"
execution_mode="daemon"

# --- Bug: 4e32923 — scoped delivery fields ---
# target_session_id: the Mandible session that owns this request (so the MCP
# channel server can forward the auth:resolved event only to it).
# target_repo_root: the protected-branch worktree path. Used for tier-2 inbox
# scoping (any session in the same project) once the project grace window passes.
target_session_id="${MANDIBLE_SESSION_ID:-}"
# Bug: 6d7411b — conversation_id persists across Claude Code resumes, unlike
# MANDIBLE_SESSION_ID which is regenerated on each channel-server restart.
# Stored alongside the auth request so the new session can match on it.
conversation_id="${CLAUDE_CODE_SESSION_ID:-}"
target_repo_root=""
if git_common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null); then
  # --git-common-dir resolves to the main worktree's .git, so the repo root is
  # its parent. This intentionally matches the same heuristic used to detect
  # `repo` above (basename of that dirname), so the two values stay aligned.
  target_repo_root=$(dirname "$git_common")
fi

# --- Build issue relationship JSON arrays ---
# Bug: 7b83c1f — reference-only issues are distinct from close-on-merge issues.

issue_references_json="null"
if [[ ${#ISSUE_REFERENCES[@]} -gt 0 ]]; then
  issue_references_json=$(printf '%s\n' "${ISSUE_REFERENCES[@]}" | jq -R . | jq -sc .)
fi
issue_closures_json="null"
if [[ ${#ISSUE_CLOSURES[@]} -gt 0 ]]; then
  issue_closures_json=$(printf '%s\n' "${ISSUE_CLOSURES[@]}" | jq -R . | jq -sc .)
fi

# --- Submit to Mandible ---

payload=$(jq -nc \
  --arg command "$command" \
  --arg cwd "$target_cwd" \
  --arg title "$title" \
  --arg auth_type "$auth_type" \
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
  --arg post_merge_handoff "$post_merge_handoff" \
  --arg depends_on_id "$depends_on_id" \
  --arg target_session_id "$target_session_id" \
  --arg target_repo_root "$target_repo_root" \
  --arg conversation_id "$conversation_id" \
  --argjson issue_references "$issue_references_json" \
  --argjson issue_closures "$issue_closures_json" \
  --argjson protected_root_dirty_action "$protected_root_dirty_action_json" \
  '{
    command: $command,
    cwd: $cwd,
    title: $title,
    type: $auth_type,
    execution_mode: $execution_mode,
    repo: $repo,
    base_branch: $base_branch,
    head_branch: $head_branch,
    files_changed: $files_changed,
    additions: $additions,
    deletions: $deletions,
    diff_summary: $diff_summary,
    commit_message: $commit_message,
    spec_content: $spec_content,
    post_merge_handoff: (if $post_merge_handoff == "" then null else $post_merge_handoff end),
    issue_references: $issue_references,
    issue_closures: $issue_closures,
    issues: $issue_closures,
    depends_on_id: (if $depends_on_id == "" then null else $depends_on_id end),
    target_session_id: (if $target_session_id == "" then null else $target_session_id end),
    target_repo_root: (if $target_repo_root == "" then null else $target_repo_root end),
    conversation_id: (if $conversation_id == "" then null else $conversation_id end),
    protected_root_dirty_action: $protected_root_dirty_action
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
