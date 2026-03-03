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
  # dwt is in the bin/ directory, which is ../../../../bin/ relative to cli/
  local dwt="${script_dir}/../../../../bin/dwt"
  # Normalize the path
  dwt="$(cd "$(dirname "$dwt")" && pwd)/$(basename "$dwt")"

  # Only attempt cleanup if dwt exists
  [[ -x "$dwt" ]] || return 0

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

# Bug: 670e375 — auto-close issues referenced in Bug: trailers after merge
auto_close_issues() {
  local target="$1"
  local base_commit="$2"  # commit before merge (ORIG_HEAD)

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

  # Extract Bug: trailers from merged commits
  local issue_ids
  issue_ids=$(git log --format='%b' "${base_commit}..HEAD" 2>/dev/null \
    | grep -oE '^Bug: [a-f0-9]+' \
    | awk '{print $2}' \
    | sort -u)

  if [[ -z "$issue_ids" ]]; then
    return 0
  fi

  # Close each referenced issue via git-bug
  if ! command -v git-bug >/dev/null 2>&1; then
    err "${DIM_WHITE}[auto-close] git-bug not found, skipping issue closure${RESET}"
    return 0
  fi

  local id
  local closed=0
  for id in $issue_ids; do
    if git-bug bug status close "$id" 2>/dev/null; then
      # Bug: e32ee8b — mark as "merged" (closed + merged label = three-state lifecycle)
      git-bug bug label new "$id" merged 2>/dev/null || true
      err "${DIM_WHITE}[auto-close] merged issue ${id}${RESET}"
      closed=$((closed + 1))
    fi
  done

  if [[ "$closed" -gt 0 ]]; then
    err "${GREEN}[auto-close] merged ${closed} issue(s)${RESET}"
  fi
}

restart_mandible_if_dist_changed() {
  local base_commit="$1"
  local changed
  changed=$(git diff --name-only "${base_commit}" HEAD -- .config/mcp-servers/mandible/dist/)
  if [[ -z "$changed" ]]; then
    return 0
  fi

  local uid
  uid=$(id -u)
  if launchctl kickstart -k "gui/${uid}/com.mll.mandible" >/dev/null 2>&1; then
    err "${GREEN}[post-merge] restarted com.mll.mandible (dist changed)${RESET}"
  else
    err "${BOLD_YELLOW}[post-merge] failed to restart com.mll.mandible${RESET}"
  fi
}

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

  # If a previous merge attempt left MERGE_HEAD, abort it and start
  # fresh. Resuming a stale merge is unsafe — the index may have been
  # reset between attempts (e.g., by `git checkout HEAD -- .`), which
  # would produce a merge commit with the parent's tree (no changes).
  local merge_head_file
  merge_head_file="$(git rev-parse --git-dir)/MERGE_HEAD"
  if [[ -f "$merge_head_file" ]]; then
    err "Cleaning up stale MERGE_HEAD from a previous attempt..."
    git merge --abort 2>/dev/null || rm -f "$merge_head_file"
  fi

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

  if [[ "$hierarchical" == "false" ]]; then
    source=${sources[0]}
    local pre_merge_head
    pre_merge_head=$(git rev-parse HEAD)
    if git merge --no-ff --no-edit -S "$source"; then
      verify_merge_not_empty
      auto_close_issues "$target" "$pre_merge_head"
      cleanup_merged_worktrees "$source"
      restart_mandible_if_dist_changed "$pre_merge_head"
      exit 0
    fi

    if has_conflicts; then
      err "Merge conflict detected."
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

    if has_conflicts; then
      err "Merge conflict detected while merging $source."
    else
      err "Merge failed while merging $source."
    fi

    if (( ${#succeeded[@]} > 0 )); then
      err "Merges completed before failure: ${succeeded[*]}"
    fi
    exit 1
  done

  # Auto-close issues from all merged commits (hierarchical)
  auto_close_issues "$target" "$pre_merge_head"

  for source in "${succeeded[@]}"; do
    cleanup_merged_worktrees "$source"
  done
  restart_mandible_if_dist_changed "$pre_merge_head"
}

main "$@"
