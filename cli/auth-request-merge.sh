#!/usr/bin/env bash
# Merge-specific request preparation. Sourced by auth-request.sh after parsing.

prepare_merge_request() {
source "${MANDIBLE_CLI_DIR}/auth-preflight.sh"

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

# Canonical message fields are composed from explicit inputs.
validate_issue_ref_tokens() {
  local ref
  for ref in ${ISSUE_REFERENCES[@]+"${ISSUE_REFERENCES[@]}"} ${ISSUE_CLOSURES[@]+"${ISSUE_CLOSURES[@]}"}; do
    if [[ -z "$ref" || "$ref" =~ [[:space:]] ]]; then
      echo "Error: issue ref '${ref}' must be a single token with no whitespace or newlines." >&2
      exit 2
    fi
  done
}

# The Verification section is machine-owned: single non-empty paragraph,
# no '#'-leading lines. Mirrors the daemon-side check in
# src/auth-change-message.ts.
validate_verification_text() {
  local text="$1"
  if [[ -z "${text//[[:space:]]/}" ]]; then
    echo "Error: --verification text must not be empty." >&2
    exit 2
  fi
  local trimmed
  trimmed=$(printf '%s\n' "$text" | canonicalize_verification_text)
  if printf '%s\n' "$trimmed" | grep -qE '^[[:space:]]*$'; then
    echo "Error: --verification text must be a single paragraph." >&2
    exit 2
  fi
  local offending
  offending=$(printf '%s\n' "$trimmed" | grep -nE '^#' || true)
  if [[ -n "$offending" ]]; then
    echo "Error: --verification text must not contain '#'-leading lines:" >&2
    printf '%s\n' "$offending" >&2
    exit 2
  fi
}

# Strip trailing whitespace per line and drop leading/trailing blank lines, so
# the CLI checks and the composed section see the same text the daemon will.
canonicalize_verification_text() {
  LC_ALL=C awk '
    { sub(/\r$/, ""); sub(/[ \t]+$/, ""); lines[++n] = $0 }
    END {
      s = 1
      while (s <= n && lines[s] == "") s++
      e = n
      while (e >= s && lines[e] == "") e--
      for (i = s; i <= e; i++) printf "%s\n", lines[i]
    }
  '
}

# Refuse agent-authored text that claims a machine-owned section.
reject_machine_owned_lines() {
  local body="$1"
  local offending
  offending=$(printf '%s\n' "$body" |
    grep -nE '^Verification:' || true)
  if [[ -n "$offending" ]]; then
    echo "Error: the change message may not author machine-owned lines:" >&2
    printf '%s\n' "$offending" >&2
    echo "Use --verification for the Verification section." >&2
    exit 2
  fi
  # git's commit-message cleanup can drop a '#'-leading line, which would make
  # the merge commit differ from the approved canonical bytes.
  local commented
  commented=$(printf '%s\n' "$body" | grep -nE '^#' || true)
  if [[ -n "$commented" ]]; then
    echo "Error: the change message may not contain lines starting with '#':" >&2
    printf '%s\n' "$commented" >&2
    echo "git's commit-message cleanup would strip them, breaking the canonical digest." >&2
    exit 2
  fi
}

compose_change_message() {
  local branch_name="$1"
  local body="$2"
  local verification="$3"

  # Multi-line values travel through the environment: BSD awk rejects embedded
  # newlines in -v assignments.
  printf '%s\n' "$body" | \
    MANDIBLE_CM_BRANCH="$branch_name" \
    MANDIBLE_CM_VERIFICATION="$verification" \
    awk '
    BEGIN {
      branch = ENVIRON["MANDIBLE_CM_BRANCH"]
      verification = ENVIRON["MANDIBLE_CM_VERIFICATION"]
    }
    { sub(/\r$/, ""); lines[++n] = $0 }
    END {
      s = 1
      while (s <= n && lines[s] ~ /^[ \t]*$/) s++
      if (s > n) exit 3
      outcome = lines[s]
      sub(/^[ \t]+/, "", outcome)

      b1 = s + 1
      while (b1 <= n && lines[b1] ~ /^[ \t]*$/) b1++
      b2 = n
      while (b2 >= b1 && lines[b2] ~ /^[ \t]*$/) b2--

      cav = 0
      for (i = b1; i <= b2; i++) {
        if (lines[i] ~ /^Caveats:/) { cav = i; break }
      }

      printf "Merge %s: %s\n", branch, outcome
      if (cav > 0) {
        p2 = cav - 1
        while (p2 >= b1 && lines[p2] ~ /^[ \t]*$/) p2--
        if (b1 <= p2) {
          printf "\n"
          for (i = b1; i <= p2; i++) printf "%s\n", lines[i]
        }
        printf "\nVerification:\n%s\n", verification
        printf "\n"
        for (i = cav; i <= b2; i++) printf "%s\n", lines[i]
      } else {
        if (b1 <= b2) {
          printf "\n"
          for (i = b1; i <= b2; i++) printf "%s\n", lines[i]
        }
        printf "\nVerification:\n%s\n", verification
      }
    }
  '
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

local_git_repo_name() {
  local git_common repo_root
  git_common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 1
  repo_root=$(dirname "$git_common")
  basename "$repo_root"
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

# The dirty state of a checkout as one commit shaped like `git stash push`
# output (parents: HEAD, the index, and the untracked files when included),
# built under temporary index files so it never enters refs/stash, the stack
# every worktree of the repository shares (issue 029661a). Restore it with
# `git stash apply --index <sha>`. Prints the commit SHA, and writes the
# captured untracked paths NUL-separated to $4 so the caller removes only those.
snapshot_dirty_state() {
  local root="$1" include_untracked="$2" label="$3" untracked_list="$4"
  local scratch head index_tree index_commit work_tree untracked_tree untracked_commit
  local -a parents
  scratch=$(mktemp -d) || return 1
  : > "$untracked_list"
  if ! head=$(git -C "$root" rev-parse --verify HEAD) ||
    ! index_tree=$(git -C "$root" write-tree) ||
    ! index_commit=$(git -C "$root" commit-tree "$index_tree" -p "$head" -m "index on ${label}") ||
    ! cp "$(git -C "$root" rev-parse --path-format=absolute --git-path index)" "$scratch/work" ||
    ! GIT_INDEX_FILE="$scratch/work" git -C "$root" add --update -- ":/" ||
    ! work_tree=$(GIT_INDEX_FILE="$scratch/work" git -C "$root" write-tree); then
    rm -rf "$scratch"
    return 1
  fi
  parents=(-p "$head" -p "$index_commit")
  if truthy_config_value "$include_untracked"; then
    if ! git -C "$root" ls-files -z --others --exclude-standard -- ":/" > "$untracked_list"; then
      rm -rf "$scratch"
      return 1
    fi
    if [[ -s "$untracked_list" ]]; then
      if ! GIT_INDEX_FILE="$scratch/untracked" git -C "$root" update-index --add -z --stdin < "$untracked_list" ||
        ! untracked_tree=$(GIT_INDEX_FILE="$scratch/untracked" git -C "$root" write-tree) ||
        ! untracked_commit=$(git -C "$root" commit-tree "$untracked_tree" -m "untracked files on ${label}"); then
        rm -rf "$scratch"
        return 1
      fi
      parents+=(-p "$untracked_commit")
    fi
  fi
  rm -rf "$scratch"
  git -C "$root" commit-tree "$work_tree" "${parents[@]}" -m "On ${label}"
}

ensure_clean_with_dirty_policy() {
  local target="$1"
  local base="$2"
  local source="$3"
  local policy="$4"
  local branch_prefix="$5"
  local include_untracked="$6"
  local status tracked_status remaining timestamp untracked_list snapshot snapshot_ref restore
  local shelve_branch safe_branch shelve_root message

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
      echo "Move, commit, or explicitly request --dirty-policy stash or --dirty-policy branch-off." >&2
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
      timestamp=$(date +%Y%m%d-%H%M%S)
      untracked_list=$(mktemp)
      if ! snapshot=$(snapshot_dirty_state "$target" "$include_untracked" \
        "${base}: mandible protected-root dirty state before auth request ${source}" "$untracked_list"); then
        rm -f "$untracked_list"
        echo "Error: dirty policy ${policy} could not snapshot protected-root changes; the protected root was not modified." >&2
        exit 1
      fi
      snapshot_ref="refs/mandible/protected-root-dirty/${timestamp}-$(safe_branch_component "$source")"
      if ! git -C "$target" update-ref -m "auth request ${source}" "$snapshot_ref" "$snapshot" ""; then
        rm -f "$untracked_list"
        echo "Error: could not record protected-root snapshot ${snapshot} at ${snapshot_ref}; the protected root was not modified." >&2
        exit 1
      fi
      restore="git -C '${target}' stash apply --index ${snapshot}"

      git -C "$target" reset --hard --quiet HEAD
      if [[ -s "$untracked_list" ]]; then
        (cd "$target" && xargs -0 rm -f -- < "$untracked_list")
      fi
      rm -f "$untracked_list"
      remaining=$(git -C "$target" status --porcelain=v1 2>/dev/null || true)
      if ! truthy_config_value "$include_untracked"; then
        remaining=$(printf '%s\n' "$remaining" | grep -v '^??' || true)
      fi
      if [[ -n "$remaining" ]]; then
        echo "Error: the protected root changed while dirty policy ${policy} was clearing it:" >&2
        echo "$remaining" >&2
        echo "The earlier state is preserved as stash commit ${snapshot} at ${snapshot_ref}; restore it with: ${restore}" >&2
        exit 1
      fi

      if [[ "$policy" == "stash" ]]; then
        message="Protected-root changes were preserved as stash commit ${snapshot} at ${snapshot_ref} before auth request submission. Restore them with: ${restore}"
        echo "Warning: $message" >&2
        build_dirty_action_json "$policy" "stashed" "$status" "" "" "$snapshot" "$message"
        return 0
      fi

      shelve_branch="${branch_prefix}-${timestamp}"
      while git -C "$target" rev-parse --verify "refs/heads/${shelve_branch}" >/dev/null 2>&1; do
        sleep 1
        timestamp=$(date +%Y%m%d-%H%M%S)
        shelve_branch="${branch_prefix}-${timestamp}"
      done
      safe_branch=$(safe_branch_component "$shelve_branch")
      shelve_root="${target}/worktrees/${safe_branch}"
      mkdir -p "$(dirname "$shelve_root")"
      if ! git -C "$target" worktree add -b "$shelve_branch" "$shelve_root" "$base" >/dev/null ||
        ! git -C "$shelve_root" stash apply --index "$snapshot" >/dev/null; then
        echo "Error: could not move protected-root changes to ${shelve_branch}." >&2
        echo "They are preserved as stash commit ${snapshot} at ${snapshot_ref}; restore them in a clean checkout of ${base} with: git stash apply --index ${snapshot}" >&2
        exit 1
      fi
      git -C "$target" update-ref -d "$snapshot_ref" "$snapshot"
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

# --- Canonical change message ---
# Issues 7d64d8f and 4720024 — the merge commit message is authored, not
# synthesized, and every merge request carries one. The command grammar
# requires --message or --message-file plus --verification for a merge. It is
# composed and validated here, before any protected-root or Git side effect.

reject_machine_owned_lines "$change_message_body"

validate_verification_text "$verification_text"
validate_issue_ref_tokens
verification_text=$(printf '%s\n' "$verification_text" | canonicalize_verification_text)

commit_message=$(compose_change_message \
  "$branch" "$change_message_body" "$verification_text")
if [[ -z "$commit_message" ]]; then
  echo "Error: the change message could not be composed" >&2
  exit 1
fi
canonical_message="true"

# Bug: c6bd770 — allow explicit --target override so callers can target a branch
# other than the auto-detected protected branch (e.g., merging a CLAUDE.md update
# into main in a repo where develop is protected).
if [[ -n "$target_override" ]]; then
  base_branch="$target_override"
else
  base_branch=$(detect_protected_branch)
fi

# --- Validate local git context against requested repo ---

local_repo=$(local_git_repo_name || true)
if [[ -n "$repo" ]]; then
  if [[ -z "$local_repo" ]]; then
    echo "Error: cannot resolve cwd git repo while target repo '${repo}' was requested." >&2
    echo "Run mandible auth request from the target repo worktree, or submit through the daemon/API route when local git context is unavailable." >&2
    exit 1
  fi
  if [[ "$local_repo" != "$repo" ]]; then
    echo "Error: cwd git repo '${local_repo}' does not match target repo '${repo}'." >&2
    echo "Run mandible auth request from the target repo worktree, or submit through the daemon/API route when local git context is unavailable." >&2
    exit 1
  fi
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
  repo="$local_repo"
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

# Two dots on purpose (unlike the diff range below, issue 1512471): the
# question here is "does this branch carry commits the base does not have",
# which is exactly `base..branch`. Three dots would add the base's own new
# commits to the count and this guard would stop refusing already-merged
# branches.
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

# --- Pre-flight: check merge cleanliness through Mandible ---
# This is the same read-only preflight used by `mandible auth check` and the
# merge executor. It deliberately does not call user dotfiles policy scripts.
mandible_auth_merge_preflight "$target_cwd" "$branch" "$base_branch" "$repo"

# --- Auto-detect diff summary ---
# Bug: c8dd9c8 — use unified diff format so the UI's per-file tab viewer works.
# The --diff-summary CLI flag still works but should contain unified diff format.

MAX_DIFF_BYTES=102400  # 100KB truncation limit

if [[ -z "$diff_summary" ]]; then
  review_range="${base_branch}...${branch}"
  full_diff=$(git diff "$review_range" 2>/dev/null) || full_diff=""
  diff_bytes=${#full_diff}
  if [[ "$diff_bytes" -gt "$MAX_DIFF_BYTES" ]]; then
    diff_summary="${full_diff:0:$MAX_DIFF_BYTES}
... [truncated: ${diff_bytes} bytes total, showing first ${MAX_DIFF_BYTES}]"
  else
    diff_summary="$full_diff"
  fi
fi

# --- Build command and metadata ---

local command_path=mandible
if [[ -n "${MANDIBLE_RELEASE_ROOT:-}" ]]; then command_path="$MANDIBLE_RELEASE_ROOT/bin/mandible"; fi
printf -v command '%q auth merge %q --into %q' "$command_path" "$branch" "$base_branch"
head_branch="$branch"
execution_mode="daemon"

target_repo_root=""
if git_common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null); then
  # --git-common-dir resolves to the main worktree's .git, so the repo root is
  # its parent. This intentionally matches the same heuristic used to detect
  # `repo` above (basename of that dirname), so the two values stay aligned.
  target_repo_root=$(dirname "$git_common")
fi

}
