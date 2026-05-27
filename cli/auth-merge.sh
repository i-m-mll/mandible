#!/usr/bin/env bash

set -u
set -o pipefail

# MANDIBLE_PORT and MANDIBLE_BASE are exported by the dispatcher

RESET=$'\033[0m'
BOLD_WHITE=$'\033[1;37m'
DIM_WHITE=$'\033[2;37m'
BOLD_CYAN=$'\033[1;36m'
BOLD_GREEN=$'\033[1;32m'
BOLD_YELLOW=$'\033[1;33m'
GREEN=$'\033[32m'
RED=$'\033[31m'

trap 'exit 130' INT

err() {
  printf "%b\n" "$*" >&2
}

die() {
  local message=$1
  local code=${2:-1}
  err "$message"
  exit "$code"
}

usage() {
  cat <<'USAGE'
Usage:
  mandible auth merge <source-branch>
  mandible auth merge <source-branch> --into <target>
  mandible auth merge --hierarchical <b1> <b2> <b3> --into <target>
USAGE
}

strip_ansi() {
  printf "%s" "$1" | sed -E 's/\x1B\[[0-9;]*m//g'
}

repeat_char() {
  local char=$1
  local count=$2
  local out=""
  for ((i=0; i<count; i++)); do
    out+="$char"
  done
  printf "%s" "$out"
}

branch_exists() {
  git show-ref --verify --quiet "refs/heads/$1"
}

protected_branch() {
  if branch_exists "develop"; then
    printf "%s" "develop"
  else
    printf "%s" "main"
  fi
}

pluralize() {
  local count=$1
  local word=$2
  if [[ "$count" == "1" ]]; then
    printf "%s %s" "$count" "$word"
  else
    printf "%s %ss" "$count" "$word"
  fi
}

parse_shortstat() {
  local shortstat=$1
  local files=0
  local insertions=0
  local deletions=0

  if [[ -n "$shortstat" ]]; then
    files=$(awk '{for (i=1;i<=NF;i++) if ($i=="files" || $i=="file") {print $(i-1); exit}}' <<<"$shortstat")
    insertions=$(awk '{for (i=1;i<=NF;i++) if ($i ~ /insertions?/) {print $(i-1); exit}}' <<<"$shortstat")
    deletions=$(awk '{for (i=1;i<=NF;i++) if ($i ~ /deletions?/) {print $(i-1); exit}}' <<<"$shortstat")
  fi

  files=${files:-0}
  insertions=${insertions:-0}
  deletions=${deletions:-0}

  printf "%s %s %s" "$files" "$insertions" "$deletions"
}

color_diff_line() {
  local line=$1
  if [[ "$line" == *"|"* ]]; then
    local left=${line%%|*}
    local right=${line#*|}
    local colored=""
    local ch
    local i
    for ((i=0; i<${#right}; i++)); do
      ch=${right:i:1}
      case "$ch" in
        "+") colored+="${GREEN}+${RESET}" ;;
        "-") colored+="${RED}-${RESET}" ;;
        *) colored+="$ch" ;;
      esac
    done
    printf "%b" "${left}|${colored}"
  else
    printf "%b" "$line"
  fi
}

build_lines_for_source() {
  local source=$1
  local target=$2
  local commit_count=$3
  local files=$4
  local insertions=$5
  local deletions=$6
  local -a diff_lines
  local -a lines
  local stats_text

  stats_text="$(pluralize "$commit_count" "commit") · $(pluralize "$files" "file") · +$insertions -$deletions"

  lines+=("  ${BOLD_CYAN}${source}${RESET} ${DIM_WHITE}→${RESET} ${BOLD_GREEN}${target}${RESET}")
  lines+=("  ${DIM_WHITE}${stats_text}${RESET}")

  local IFS_BAK="$IFS"
  IFS=$'\n'
  diff_lines=( $(git diff --stat "$target..$source") )
  IFS="$IFS_BAK"
  for line in "${diff_lines[@]}"; do
    if [[ "$line" == *"files changed"* ]]; then
      continue
    fi
    if [[ -z "$line" ]]; then
      continue
    fi
    lines+=("  $(color_diff_line "$line")")
  done

  printf "%s\n" "${lines[@]}"
}

print_box() {
  # Pass lines via global _box_lines array (bash 3.2 compat, no namerefs)
  local max_len=0
  local line
  local idx

  for idx in $(seq 0 $(( ${#_box_lines[@]} - 1 )) ); do
    line="${_box_lines[$idx]}"
    local stripped
    stripped=$(strip_ansi "$line")
    local len=${#stripped}
    if (( len > max_len )); then
      max_len=$len
    fi
  done

  local top="╭$(repeat_char "─" "$max_len")╮"
  local bottom="╰$(repeat_char "─" "$max_len")╯"

  err "${DIM_WHITE}${top}${RESET}"
  for idx in $(seq 0 $(( ${#_box_lines[@]} - 1 )) ); do
    line="${_box_lines[$idx]}"
    local stripped
    stripped=$(strip_ansi "$line")
    local pad=$((max_len - ${#stripped}))
    local padded
    padded="${line}$(printf '%*s' "$pad")"
    err "${DIM_WHITE}│${RESET}${padded}${DIM_WHITE}│${RESET}"
  done
  err "${DIM_WHITE}${bottom}${RESET}"
}

read_tty() {
  local response
  if [[ "${AUTH_MERGE_AUTO_CONFIRM:-}" = "1" ]]; then
    response="y"
  else
    { IFS= read -r response </dev/tty; } 2>/dev/null || IFS= read -r response
  fi
  printf "%s" "$response"
}

prompt_confirm() {
  local prompt=$1
  err "${BOLD_YELLOW}${prompt}${RESET}"
  read_tty
}

confirm_checkout_if_needed() {
  local current=$1
  local target=$2

  if [[ "$current" != "$target" ]]; then
    local response
    response=$(prompt_confirm "Not on ${target}. Checkout ${target}? [y/N]")
    response=$(printf "%s" "$response" | tr '[:upper:]' '[:lower:]')
    case "$response" in
      y|yes)
        git checkout "$target"
        return $?
        ;;
      *)
        err "Merge cancelled."
        return 1
        ;;
    esac
  fi

  return 0
}

has_conflicts() {
  [[ -n "$(git diff --name-only --diff-filter=U)" ]]
}

# Bug: bb2d9ef — auto-resolve conflicts in generated dist files.
# When git merge encounters conflicts, check if ALL conflicts are in
# generated/dist paths. If so, take --theirs for each and stage them,
# returning 0. If any non-dist conflicts remain, return 1.
# Patterns (prefix match on path): */dist/*.js, */dist/*.js.map,
# */dist/*.css, */dist/*.css.map
is_dist_file() {
  local f="$1"
  case "$f" in
    */dist/*.js|*/dist/*.js.map|*/dist/*.css|*/dist/*.css.map) return 0 ;;
  esac
  return 1
}

auto_resolve_dist_conflicts() {
  local conflict_files
  local IFS_BAK="$IFS"
  IFS=$'\n'
  conflict_files=( $(git diff --name-only --diff-filter=U) )
  IFS="$IFS_BAK"

  if [[ ${#conflict_files[@]} -eq 0 ]]; then
    return 1  # no conflicts, something else went wrong
  fi

  # Check that every conflicted file is a dist file
  local f
  local non_dist=0
  for f in "${conflict_files[@]}"; do
    if [[ -n "$f" ]] && ! is_dist_file "$f"; then
      non_dist=$((non_dist + 1))
    fi
  done

  if [[ "$non_dist" -gt 0 ]]; then
    err "${BOLD_YELLOW}Conflicts in non-generated files require manual resolution.${RESET}"
    local g
    for g in "${conflict_files[@]}"; do
      if [[ -n "$g" ]] && ! is_dist_file "$g"; then
        err "  ${RED}${g}${RESET}"
      fi
    done
    return 1
  fi

  # All conflicts are in dist files — auto-resolve with --theirs
  err "${DIM_WHITE}Auto-resolving dist file conflicts (taking --theirs):${RESET}"
  for f in "${conflict_files[@]}"; do
    if [[ -n "$f" ]]; then
      git checkout --theirs -- "$f"
      git add -- "$f"
      err "  ${GREEN}resolved: ${f}${RESET}"
    fi
  done

  return 0
}

# Safety: after any successful merge, verify the result actually
# contains changes. A merge whose tree matches parent-1 is a no-op
# that silently discards the feature branch.
verify_merge_not_empty() {
  local merge_tree parent_tree
  merge_tree=$(git rev-parse HEAD^{tree})
  parent_tree=$(git rev-parse HEAD^1^{tree})
  if [[ "$merge_tree" == "$parent_tree" ]]; then
    err ""
    err "  ${RED}FATAL: Merge produced no changes — tree is identical to parent.${RESET}"
    err "  ${DIM_WHITE}This means the feature branch changes were silently dropped.${RESET}"
    err "  ${DIM_WHITE}Reverting the empty merge...${RESET}"
    git reset --hard HEAD~1
    err ""
    die "Empty merge reverted. Investigate before retrying." 1
  fi
}

preflight_signing_check() {
  local effective
  effective=$(git config --get commit.gpgsign 2>/dev/null || true)
  if [[ "$effective" == "false" ]]; then
    err ""
    err "  ${RED}FATAL: commit.gpgsign is set to false.${RESET}"
    err "  Signing is disabled — merges would go through unsigned."
    err ""
    err "  Check: git config --show-origin --show-scope commit.gpgsign"
    err "  Fix:   git config --local --unset commit.gpgsign"
    err ""
    die "Aborting. Fix signing config before merging." 1
  fi

  local sigkey
  sigkey=$(git config --get user.signingkey 2>/dev/null || true)
  if [[ -z "$sigkey" ]]; then
    err ""
    err "  ${RED}FATAL: No signing key configured.${RESET}"
    err "  Set user.signingkey in git config."
    err ""
    die "Aborting. No signing key." 1
  fi
}

cleanup_merged_worktrees() {
  local branch="$1"
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  # dwt is vendored alongside this script in cli/
  local dwt="${script_dir}/dwt"

  # Only attempt cleanup if dwt exists (absent = broken Mandible install, not a normal skip)
  [[ -x "$dwt" ]] || { err "warning: vendored dwt not found at ${dwt}; skipping worktree cleanup"; return 0; }

  # Clean the merged branch's worktree (if it has one)
  "$dwt" "$branch" 2>/dev/null || true

  # Clean __-delimited child branches
  local prefix="${branch}__"
  local child
  git for-each-ref --format='%(refname:short)' 'refs/heads/' | while IFS= read -r child; do
    case "$child" in
      "${prefix}"*)
        "$dwt" "$child" 2>/dev/null || true
        ;;
    esac
  done
}

urlencode() {
  jq -rn --arg value "$1" '$value|@uri'
}

current_repo_id() {
  local root
  root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
  basename "$root"
}

# Bug: 670e375 — auto-close issues referenced in explicit closure trailers after merge
# Bug: 7b83c1f — Bug: trailers are reference/work-tracking links only.
collect_auto_close_issues() {
  local base_commit="$1"  # commit before merge (ORIG_HEAD)
  # Check if auto-close is enabled via Mandible setting
  local setting
  setting=$(curl -sf --max-time 2 "${MANDIBLE_BASE}/api/settings/auto_close_issues_on_merge" 2>/dev/null) || setting=""
  if [[ -n "$setting" ]]; then
    local enabled
    enabled=$(printf '%s' "$setting" | jq -r '.value // "true"' 2>/dev/null)
    if [[ "$enabled" == "false" ]]; then
      return 0
    fi
  fi

  # Extract explicit closure trailers from merged commits.
  local issue_ids
  issue_ids=$(git log --format='%b' "${base_commit}..HEAD" 2>/dev/null \
    | grep -oE '^(Closes|Resolves): [a-f0-9]+' \
    | awk '{print $2}' \
    | sort -u)
  printf "%s" "$issue_ids"
}

# Bug: 297677f — include issues declared in the auth request's issues field.
# Bug: 7b83c1f — prefer issue_closures; issues remains legacy close-on-merge.
collect_declared_issues() {
  # Requires MANDIBLE_AUTH_REQUEST_ID to be set by the executor
  local request_id="${MANDIBLE_AUTH_REQUEST_ID:-}"
  if [[ -z "$request_id" ]]; then
    return 0
  fi

  local port="${MANDIBLE_PORT:-19420}"
  local base="http://127.0.0.1:${port}"

  # Query the auth request for issues
  local response
  response=$(curl -sf --max-time 5 "${base}/api/auth/request/${request_id}" 2>/dev/null) || return 0

  local issues_json
  issues_json=$(printf '%s' "$response" | jq -r '.issue_closures // .issues // empty' 2>/dev/null) || return 0
  if [[ -z "$issues_json" || "$issues_json" == "null" ]]; then
    return 0
  fi

  # Parse the JSON array into individual IDs
  local ids
  ids=$(printf '%s' "$issues_json" | jq -r '.[]' 2>/dev/null) || return 0
  printf "%s" "$ids"
}

issue_ids_to_json() {
  local ids="$1"
  if [[ -z "$ids" ]]; then
    printf "[]"
    return 0
  fi
  printf "%s\n" "$ids" | jq -R 'select(length > 0)' | jq -sc .
}

record_auth_merge_result() {
  local pre_merge_head="$1"
  local merge_sha
  merge_sha=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
  local auto_ids
  local declared_ids
  auto_ids=$(collect_auto_close_issues "$pre_merge_head")
  declared_ids=$(collect_declared_issues)
  err "MANDIBLE_MERGE_RESULT $(jq -nc \
    --arg merge_sha "$merge_sha" \
    --arg repo_id "$(current_repo_id)" \
    --argjson auto_close_issues "$(issue_ids_to_json "$auto_ids")" \
    --argjson declared_issues "$(issue_ids_to_json "$declared_ids")" \
    '{merge_sha:$merge_sha, repo_id:$repo_id, auto_close_issues:$auto_close_issues, declared_issues:$declared_issues}')"
}

# Bug: 4afab83 — post-merge build/restart logic has been moved to the auth_hooks
# system in the Mandible daemon. Hooks are configured per-repo in the auth_hooks
# table and run automatically after successful auth actions.

main() {
  if ! git rev-parse --git-dir >/dev/null 2>&1; then
    die "Not a git repository." 2
  fi

  # Strip agent-injected git config overrides (e.g., GIT_CONFIG_COUNT from
  # CLAUDECODE=1). This is a USER operation — signing must use the user's
  # configured key (e.g., YubiKey), not the agent's.
  local var
  for var in $(env | grep '^GIT_CONFIG_' | cut -d= -f1); do
    unset "$var"
  done

  local hierarchical=false
  local target=""
  local -a sources=()

  while (( $# > 0 )); do
    case "$1" in
      --help|-h)
        usage
        exit 0
        ;;
      --hierarchical)
        hierarchical=true
        shift
        ;;
      --into)
        if (( $# < 2 )); then
          die "Missing value for --into." 2
        fi
        target=$2
        shift 2
        ;;
      --)
        shift
        break
        ;;
      -* )
        die "Unknown option: $1" 2
        ;;
      * )
        sources+=("$1")
        shift
        ;;
    esac
  done

  if (( $# > 0 )); then
    sources+=("$@")
  fi

  if [[ -z "$target" ]]; then
    target=$(protected_branch)
  fi

  # Bug: bb2d9ef — detect MERGE_HEAD before running pre-auth-check.
  # When Mandible restarts mid-merge (e.g. a dist rebuild triggers a
  # process restart), the executor re-runs auth-merge from scratch.
  # pre-auth-check sees staged mid-merge files and fails with "dirty tree".
  # Instead: detect the in-progress merge and resume it with --continue.
  local merge_head_file
  merge_head_file="$(git rev-parse --git-dir)/MERGE_HEAD"
  if [[ -f "$merge_head_file" ]]; then
    err ""
    err "${BOLD_YELLOW}Merge already in progress — resuming with git merge --continue${RESET}"
    err ""

    # Show what's staged
    local staged_status
    staged_status=$(git status --short)
    if [[ -n "$staged_status" ]]; then
      err "${DIM_WHITE}Staged files:${RESET}"
      local line
      local IFS_BAK_MH="$IFS"
      IFS=$'\n'
      for line in $staged_status; do
        err "  ${DIM_WHITE}${line}${RESET}"
      done
      IFS="$IFS_BAK_MH"
      err ""
    fi

    preflight_signing_check

    local resume_response
    resume_response=$(prompt_confirm "Resume merge with --continue? (requires YubiKey) [y/N]")
    resume_response=$(printf "%s" "$resume_response" | tr '[:upper:]' '[:lower:]')
    case "$resume_response" in
      y|yes) ;;
      *)
        err "Merge resume cancelled. Run 'git merge --continue' or 'git merge --abort' manually."
        exit 1
        ;;
    esac

    # ORIG_HEAD is the pre-merge HEAD (set by git when the merge started)
    local pre_merge_head
    pre_merge_head=$(git rev-parse ORIG_HEAD 2>/dev/null || git rev-parse HEAD)

    if git commit -S --no-edit; then
      verify_merge_not_empty
      if [[ ${#sources[@]} -gt 0 ]]; then
        record_auth_merge_result "$pre_merge_head"
        cleanup_merged_worktrees "${sources[0]}"
      fi
      # Bug: 4afab83 — post-merge hooks now run in the daemon via auth_hooks table
      exit 0
    else
      err "${RED}git commit failed.${RESET}"
      if has_conflicts; then
        err "Conflicts remain — resolve them manually and run 'git merge --continue'."
      fi
      exit 1
    fi
  fi

  # Pre-flight: ensure working tree is clean and merge will succeed
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  local pre_auth_check="${script_dir}/../../../../bin/pre-auth-check"
  pre_auth_check="$(cd "$(dirname "$pre_auth_check")" && pwd)/$(basename "$pre_auth_check")"
  if [[ -f "$pre_auth_check" ]]; then
    if ! bash "$pre_auth_check" "$(pwd)" "${sources[0]:-}" "$target"; then
      die "Pre-auth-check failed." 1
    fi
  else
    # Fallback: simple dirty check (pre-auth-check not found)
    local status_output
    status_output=$(git status --porcelain)
    if [[ -n "$status_output" ]]; then
      err "Working tree is dirty:"
      echo "$status_output" | head -20
      die "Clean up your working tree before merging." 1
    fi
  fi

  if [[ ${#sources[@]} -eq 0 ]]; then
    usage >&2
    exit 2
  fi

  if [[ "$hierarchical" == "false" && ${#sources[@]} -ne 1 ]]; then
    usage >&2
    exit 2
  fi

  if ! branch_exists "$target"; then
    die "Target branch '$target' does not exist." 2
  fi

  local source
  for source in "${sources[@]}"; do
    if ! branch_exists "$source"; then
      die "Source branch '$source' does not exist." 2
    fi
  done

  local current_branch
  current_branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)

  local -a lines=()
  lines+=("  ${BOLD_WHITE}Protected Branch Merge${RESET}")
  lines+=("  ")

  local -a commit_counts=()

  for source in "${sources[@]}"; do
    local commit_count
    commit_count=$(git log --oneline "$target..$source" | wc -l | awk '{print $1}')
    commit_count=${commit_count:-0}
    commit_counts+=("$commit_count")

    local shortstat
    shortstat=$(git diff --shortstat "$target..$source")

    local files insertions deletions
    read -r files insertions deletions <<<"$(parse_shortstat "$shortstat")"

    if [[ "$hierarchical" == "false" && "$commit_count" == "0" ]]; then
      err "Already up to date."
      exit 0
    fi

    local IFS_BAK2="$IFS"
    IFS=$'\n'
    source_lines=( $(build_lines_for_source "$source" "$target" "$commit_count" "$files" "$insertions" "$deletions") )
    IFS="$IFS_BAK2"

    lines+=("${source_lines[@]}")
    lines+=("  ")
  done

  if [[ "$hierarchical" == "true" ]]; then
    local total_commits=0
    for count in "${commit_counts[@]}"; do
      total_commits=$((total_commits + count))
    done
    if (( total_commits == 0 )); then
      err "Already up to date."
      exit 0
    fi
  fi

  preflight_signing_check

  _box_lines=("${lines[@]}")
  print_box

  local response
  response=$(prompt_confirm "Confirm merge? [y/N]")
  response=$(printf "%s" "$response" | tr '[:upper:]' '[:lower:]')
  case "$response" in
    y|yes)
      if ! confirm_checkout_if_needed "$current_branch" "$target"; then
        exit 1
      fi
      ;;
    *)
      err "Merge cancelled."
      exit 1
      ;;
  esac

  if [[ "$hierarchical" == "false" ]]; then
    source=${sources[0]}
    local pre_merge_head
    pre_merge_head=$(git rev-parse HEAD)
    if git merge --no-ff --no-edit -S "$source"; then
      verify_merge_not_empty
      record_auth_merge_result "$pre_merge_head"
      cleanup_merged_worktrees "$source"
      # Bug: 4afab83 — post-merge hooks now run in the daemon via auth_hooks table
      exit 0
    fi

    # Bug: bb2d9ef — auto-resolve dist file conflicts before giving up.
    if has_conflicts; then
      err "Merge conflict detected."
      if auto_resolve_dist_conflicts; then
        err "${DIM_WHITE}All conflicts were in generated files — continuing merge.${RESET}"
        if git -c commit.gpgsign=true merge --continue; then
          verify_merge_not_empty
          record_auth_merge_result "$pre_merge_head"
          cleanup_merged_worktrees "$source"
          # Bug: 4afab83 — post-merge hooks now run in the daemon via auth_hooks table
          exit 0
        else
          err "${RED}git merge --continue failed after auto-resolving dist conflicts.${RESET}"
        fi
      fi
    else
      err "Merge failed."
    fi
    exit 1
  fi

  local pre_merge_head
  pre_merge_head=$(git rev-parse HEAD)
  local -a succeeded=()
  for source in "${sources[@]}"; do
    if git merge --no-ff --no-edit -S "$source"; then
      verify_merge_not_empty
      succeeded+=("$source")
      continue
    fi

    # Bug: bb2d9ef — auto-resolve dist file conflicts before giving up.
    if has_conflicts; then
      err "Merge conflict detected while merging $source."
      if auto_resolve_dist_conflicts; then
        err "${DIM_WHITE}All conflicts were in generated files — continuing merge.${RESET}"
        if git -c commit.gpgsign=true merge --continue; then
          verify_merge_not_empty
          succeeded+=("$source")
          continue
        else
          err "${RED}git merge --continue failed after auto-resolving dist conflicts.${RESET}"
        fi
      fi
    else
      err "Merge failed while merging $source."
    fi

    if (( ${#succeeded[@]} > 0 )); then
      err "Merges completed before failure: ${succeeded[*]}"
    fi
    exit 1
  done

  # Record issue-closure evidence from all merged commits (hierarchical)
  record_auth_merge_result "$pre_merge_head"

  for source in "${succeeded[@]}"; do
    cleanup_merged_worktrees "$source"
  done
  # Bug: 4afab83 — post-merge hooks now run in the daemon via auth_hooks table
}

main "$@"
