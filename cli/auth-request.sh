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
# Canonical change message (issue 7d64d8f):
#   --message <text>        Agent-authored change message (mutually exclusive with
#                           --message-file and --commit-message)
#   --message-file <file>   Read the agent-authored change message from a file
#                           ('-' reads stdin)
#   --verification <text>   Verification section text (default: "Not recorded")
#
#   The agent authors only prose. Its first non-empty line is the <outcome>;
#   the CLI prefixes it with "Merge <branch>: " so the subject stays
#   merge-recognizable. Everything after that line is the body, where the agent
#   writes the "Why:" section and, optionally, a "Caveats:" section. The CLI
#   owns the rest of the template:
#
#       Merge <branch>: <outcome>
#
#       Why:
#       <one short agent-authored paragraph>
#
#       Verification:
#       <--verification text, or "Not recorded">
#
#       Caveats:
#       <agent-authored; omitted when empty>
#
#       Mandible-Issue: <ref>
#
#   The machine-owned "Verification:" section is inserted immediately before a
#   "Caveats:" heading when one is present, otherwise appended after the body.
#   Trailers are derived from --issue / --closes-issue only, never parsed from
#   prose, and are always reference-only "Mandible-Issue:" lines. A canonical
#   message never carries "Closes-Mandible-Issue:": closure is carried solely by
#   the request's structured issue_closures field, so the frozen signed message
#   can never disagree with the authorization that actually runs (issue
#   529f0f2). Authoring a "Verification:" heading or any Mandible issue trailer
#   inside the message is an error, as is a "#"-leading line.
#
#   With no message flag, no change message is submitted and the merge keeps
#   git's own default merge message.
#
# Options:
#   --commit-message <text> Legacy free-form review text stored on the request.
#                           Not used as the merge commit message.
#   --diff-summary <text>   Unified diff (auto-generated from git diff if omitted; truncated at 100KB)
#   --spec <text>           Inline spec/review Markdown
#   --spec-file <file>      Read spec/review Markdown from a file ('-' reads stdin)
#   --repo <name>           Repo name (auto-detected from git toplevel basename)
#   --cwd <path>            Override auto-detected protected branch worktree path
#   --target <branch>       Override auto-detected target/base branch (default: protected branch)
#   --depends-on <id>       Auth request ID that must complete before this one runs
#   --issue <id>            Issue ID to reference for context (repeatable; does not close)
#   --ref-issue <id>        Alias for --issue
#   --closes-issue <id>     Issue ID to close on successful merge (repeatable)
#   --promote-briefing <group> <expected-base> <proposal>
#                           After successful convergence, promote the exact
#                           active proposal to this Briefing group's Base
#   --type <type>           Auth request type (default: merge; options: merge, commit, force-push, branch-delete, config-change, data-delete)
#   --handoff <text>        Post-merge handoff note for next session
#   --dirty-policy <policy> Protected-root dirty policy: block, allow-untracked, stash, branch-off
#   --dirty-branch-prefix <prefix>
#                           Branch prefix for --dirty-policy branch-off (default from mandible.toml or shelve/protected-root)
#   --timeout <seconds>     SSE listen timeout (default: 14400 / 4 hours)
#   --force / -f             Skip CWD validation checks
#   --no-watch              Submit only, don't poll
#
# Exit codes:
#   0   Request submitted (and, without --no-watch, resolved)
#   1   Runtime failure (unreachable daemon, bad server response)
#   2   Usage/validation error
#   3   Refused as a duplicate: an existing request in THIS repo already covers
#       this branch pair. Nothing was queued (issue 608d1db). Duplicate
#       detection is scoped to the repository, so the same branch name in a
#       different repo submits normally.
#
# Bug: c23f479 -- unified auth request submission + polling
#
# NOTE: If this script or the mandible CLI is being renamed/moved in the branch
# being merged, submit the request from the main worktree instead — the stored
# command must exist on the target branch at merge time.

set -euo pipefail

# MANDIBLE_PORT and MANDIBLE_BASE are exported by the dispatcher
GIT_ENV_HELPER="${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/git-env.sh"
source "$GIT_ENV_HELPER"

API_HELPER="${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/api.sh"
source "$API_HELPER"

AUTH_PREFLIGHT_HELPER="${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/auth-preflight.sh"
source "$AUTH_PREFLIGHT_HELPER"

# --- Usage ---

usage() {
  sed -n '2,/^$/{ s/^# //; s/^#$//; p; }' "$0"
}

# --- Argument parsing ---

branch=""
title=""
auth_type="merge"
commit_message=""
change_message_text=""
change_message_file=""
change_message_set=0
verification_text=""
canonical_message="false"
diff_summary=""
spec_content=""
spec_file=""
spec_inline_set=0
spec_file_set=0
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
promote_briefing_group=""
promote_briefing_expected_base=""
promote_briefing_proposal=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --title)          title="$2"; shift 2 ;;
    --type)           auth_type="$2"; shift 2 ;;
    --commit-message) commit_message="$2"; shift 2 ;;
    --message)        change_message_text="$2"; change_message_set=1; shift 2 ;;
    --message-file)   change_message_file="$2"; change_message_set=1; shift 2 ;;
    --verification)   verification_text="$2"; shift 2 ;;
    --diff-summary)   diff_summary="$2"; shift 2 ;;
    --spec)           spec_content="$2"; spec_inline_set=1; shift 2 ;;
    --spec-file)      spec_file="$2"; spec_file_set=1; shift 2 ;;
    --handoff)        post_merge_handoff="$2"; shift 2 ;;
    --dirty-policy)   dirty_policy="$2"; shift 2 ;;
    --dirty-branch-prefix) dirty_branch_prefix="$2"; shift 2 ;;
    --depends-on)     depends_on_id="$2"; shift 2 ;;
    --issue|--ref-issue|--references-issue) ISSUE_REFERENCES+=("$2"); shift 2 ;;
    --closes-issue|--close-issue) ISSUE_CLOSURES+=("$2"); shift 2 ;;
    --promote-briefing)
      if [[ $# -lt 4 ]]; then
        echo "Error: --promote-briefing requires <group> <expected-base> <proposal>" >&2
        exit 2
      fi
      if [[ -n "$promote_briefing_group" ]]; then
        echo "Error: --promote-briefing may be specified only once" >&2
        exit 2
      fi
      promote_briefing_group="$2"
      promote_briefing_expected_base="$3"
      promote_briefing_proposal="$4"
      shift 4
      ;;
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
# Issue 7d64d8f — the canonical change message has exactly one source.
if [[ -n "$change_message_text" && -n "$change_message_file" ]]; then
  echo "Error: --message and --message-file are mutually exclusive" >&2
  exit 2
fi
if [[ $spec_inline_set -eq 1 && $spec_file_set -eq 1 ]]; then
  echo "Error: --spec and --spec-file are mutually exclusive" >&2
  exit 2
fi
if [[ "$change_message_file" == "-" && "$spec_file" == "-" ]]; then
  echo "Error: --message-file - and --spec-file - cannot both read stdin" >&2
  exit 2
fi
if [[ $spec_file_set -eq 1 ]]; then
  if [[ "$spec_file" != "-" && ! -f "$spec_file" ]]; then
    echo "Error: --spec-file '${spec_file}' does not exist" >&2
    exit 2
  fi
  # Command substitution normally strips every trailing newline. Append and
  # remove one non-newline sentinel so the opaque Markdown reaches jq exactly
  # as authored, including blank lines and a final newline.
  if [[ "$spec_file" == "-" ]]; then
    spec_content="$(cat; printf '\034')"
  else
    spec_content="$(cat -- "$spec_file"; printf '\034')"
  fi
  spec_content="${spec_content%$'\034'}"
fi
if [[ $change_message_set -eq 1 && -n "$commit_message" ]]; then
  echo "Error: --commit-message cannot be combined with --message/--message-file" >&2
  exit 2
fi
if [[ $change_message_set -eq 0 && -n "$verification_text" ]]; then
  echo "Error: --verification requires --message or --message-file" >&2
  exit 2
fi
if api_is_file_rpc && [[ $no_watch -eq 0 ]]; then
  echo "Error: file transport does not support SSE/watch; pass --no-watch." >&2
  exit 2
fi

# Validate auth type
valid_types="merge commit force-push branch-delete config-change data-delete"
if ! echo "$valid_types" | grep -qw "$auth_type"; then
  echo "Error: invalid --type '$auth_type'. Must be one of: $valid_types" >&2
  exit 2
fi
if [[ -n "$promote_briefing_group" && "$auth_type" != "merge" ]]; then
  echo "Error: --promote-briefing requires --type merge" >&2
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

# --- Canonical change message composition (issue 7d64d8f) ---
#
# Machine-owned parts (the "Merge <branch>: " subject prefix, the
# "Verification:" section, and the Mandible issue trailers) are composed here
# from explicit flags. They are never recovered by parsing agent prose, so an
# agent cannot smuggle a closure trailer or a forged verification claim into
# the durable merge record through the message body.

# Trailers are reference-only. Closure is carried exclusively by the request's
# structured issue_closures field: it stays editable after approval while the
# message is frozen, and cli/auth-merge.sh reads `Closes-Mandible-Issue:` out of
# commit messages as a live closure instruction, so a closure trailer inside a
# signed message could disagree with the authorization actually executed.
# Issue 529f0f2 tracks freezing the structured field; until then the trailer
# must not exist. A plain `Mandible-Issue:` trailer has no control effect.
change_message_trailers() {
  local ref
  local emitted=""
  for ref in ${ISSUE_REFERENCES[@]+"${ISSUE_REFERENCES[@]}"} ${ISSUE_CLOSURES[@]+"${ISSUE_CLOSURES[@]}"}; do
    case "
${emitted}" in
      *"
${ref}
"*) continue ;;
    esac
    emitted="${emitted}${ref}
"
    printf 'Mandible-Issue: %s\n' "$ref"
  done
}

# A ref carrying whitespace or a newline could forge extra trailer lines.
validate_issue_ref_tokens() {
  local ref
  for ref in ${ISSUE_REFERENCES[@]+"${ISSUE_REFERENCES[@]}"} ${ISSUE_CLOSURES[@]+"${ISSUE_CLOSURES[@]}"}; do
    if [[ -z "$ref" || "$ref" =~ [[:space:]] ]]; then
      echo "Error: issue ref '${ref}' must be a single token with no whitespace or newlines." >&2
      exit 2
    fi
  done
}

# The Verification section is machine-owned: single non-empty paragraph, no
# trailer-shaped lines, no '#'-leading lines. Mirrors the daemon-side check in
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
  offending=$(printf '%s\n' "$trimmed" | grep -nE '^#|^[A-Za-z][A-Za-z0-9_-]*:([[:space:]].*)?$' || true)
  if [[ -n "$offending" ]]; then
    echo "Error: --verification text must not contain '#'-leading or trailer-shaped lines:" >&2
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

# Refuse agent-authored text that claims a machine-owned section or trailer.
reject_machine_owned_lines() {
  local body="$1"
  local offending
  offending=$(printf '%s\n' "$body" |
    grep -nE '^(Verification:|Mandible-Issue:|Closes-Mandible-Issue:)' || true)
  if [[ -n "$offending" ]]; then
    echo "Error: the change message may not author machine-owned lines:" >&2
    printf '%s\n' "$offending" >&2
    echo "Use --verification for the Verification section and --issue/--closes-issue for trailers." >&2
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
  local trailers="$4"

  # Multi-line values travel through the environment: BSD awk rejects embedded
  # newlines in -v assignments.
  printf '%s\n' "$body" | \
    MANDIBLE_CM_BRANCH="$branch_name" \
    MANDIBLE_CM_VERIFICATION="$verification" \
    MANDIBLE_CM_TRAILERS="$trailers" \
    awk '
    BEGIN {
      branch = ENVIRON["MANDIBLE_CM_BRANCH"]
      verification = ENVIRON["MANDIBLE_CM_VERIFICATION"]
      trailers = ENVIRON["MANDIBLE_CM_TRAILERS"]
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
      if (trailers != "") printf "\n%s", trailers
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
append_dirty_action_to_spec "$protected_root_dirty_action_json"

# --- Pre-flight: check merge cleanliness through Mandible ---
# This is the same read-only preflight used by `mandible auth check` and the
# merge executor. It deliberately does not call user dotfiles policy scripts.
mandible_auth_merge_preflight "$target_cwd" "$branch" "$base_branch" "$repo"

# --- Auto-detect diff stats ---

# Issue 1512471 — the reviewer-facing range is three-dot, and is spelled once.
# `base...branch` is the change from the merge base, which is what the merge
# applies. `base..branch` is tip-to-tip, so anything that landed on the base
# after this branch was cut shows up inverted: another lane's merged work is
# rendered as this branch deleting it. That error is silent and grows as the
# base advances. The daemon's own derivation is `authReviewDiffRange` in
# src/auth-context.ts; test/auth-review-diff-range.test.ts pins the two to the
# same numbers so this copy cannot drift away from it again.
review_range="${base_branch}...${branch}"

shortstat=$(git diff --shortstat "$review_range" 2>/dev/null || echo "")
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
  full_diff=$(git diff "$review_range" 2>/dev/null) || full_diff=""
  diff_bytes=${#full_diff}
  if [[ "$diff_bytes" -gt "$MAX_DIFF_BYTES" ]]; then
    diff_summary="${full_diff:0:$MAX_DIFF_BYTES}
... [truncated: ${diff_bytes} bytes total, showing first ${MAX_DIFF_BYTES}]"
  else
    diff_summary="$full_diff"
  fi
fi

# --- Canonical change message ---
# Issue 7d64d8f — the merge commit message is authored, not synthesized. The
# previous `git log --format="- %s" | head -20` bullet aggregation is gone: a
# request either carries an agent-authored canonical change message, or carries
# none and the merge keeps git's own default merge message.

if [[ $change_message_set -eq 1 ]]; then
  change_message_body=""
  if [[ -n "$change_message_file" ]]; then
    if [[ "$change_message_file" == "-" ]]; then
      change_message_body=$(cat)
    else
      if [[ ! -f "$change_message_file" ]]; then
        echo "Error: --message-file '${change_message_file}' does not exist" >&2
        exit 2
      fi
      change_message_body=$(cat "$change_message_file")
    fi
  else
    change_message_body="$change_message_text"
  fi

  if [[ -z "${change_message_body//[[:space:]]/}" ]]; then
    echo "Error: the change message is empty" >&2
    exit 2
  fi
  reject_machine_owned_lines "$change_message_body"

  if [[ -z "$verification_text" ]]; then
    verification_text="Not recorded"
  fi
  validate_verification_text "$verification_text"
  validate_issue_ref_tokens
  verification_text=$(printf '%s\n' "$verification_text" | canonicalize_verification_text)

  commit_message=$(compose_change_message \
    "$branch" "$change_message_body" "$verification_text" "$(change_message_trailers)")
  if [[ -z "$commit_message" ]]; then
    echo "Error: the change message could not be composed" >&2
    exit 1
  fi
  canonical_message="true"
else
  echo "Warning: no canonical change message (--message-file / --message); the merge commit will get a bare 'Merge branch ...' subject. See the change-message contract." >&2
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
# Requester attribution uses the provider-native session id already carried by
# the CLI's allowlisted ambient identity contract. Keep this distinct from the
# Mandible target session above, which only scopes resolution notifications.
requester_session_id=$(api_ambient_session_id)
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
actions_json=$(jq -nc --argjson closures "$issue_closures_json" '
  ($closures // []) | map({
    kind: "issue_close",
    target_issue_ref: .,
    payload: {}
  })
')
if [[ -n "$promote_briefing_group" ]]; then
  promotion_target_issue=""
  if [[ ${#ISSUE_REFERENCES[@]} -gt 0 ]]; then
    promotion_target_issue="${ISSUE_REFERENCES[0]}"
  else
    promotion_target_issue="${ISSUE_CLOSURES[0]}"
  fi
  actions_json=$(jq -nc \
    --argjson actions "$actions_json" \
    --arg target_issue_ref "$promotion_target_issue" \
    --arg group_ref "$promote_briefing_group" \
    --arg expected_base_bundle_ref "$promote_briefing_expected_base" \
    --arg proposal_bundle_ref "$promote_briefing_proposal" '
      $actions + [{
        kind: "briefing_group_promote",
        target_issue_ref: $target_issue_ref,
        payload: {
          group_ref: $group_ref,
          expected_base_bundle_ref: $expected_base_bundle_ref,
          proposal_bundle_ref: $proposal_bundle_ref
        }
      }]
    ')
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
  --argjson canonical_message "$canonical_message" \
  --arg verification "$verification_text" \
  --arg spec_content "$spec_content" \
  --arg post_merge_handoff "$post_merge_handoff" \
  --arg depends_on_id "$depends_on_id" \
  --arg session_id "$requester_session_id" \
  --arg target_session_id "$target_session_id" \
  --arg target_repo_root "$target_repo_root" \
  --arg conversation_id "$conversation_id" \
  --argjson issue_references "$issue_references_json" \
  --argjson issue_closures "$issue_closures_json" \
  --argjson actions "$actions_json" \
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
    commit_message: (if $commit_message == "" then null else $commit_message end),
    canonical_message: $canonical_message,
    verification: (if $verification == "" then null else $verification end),
    spec_content: $spec_content,
    post_merge_handoff: (if $post_merge_handoff == "" then null else $post_merge_handoff end),
    issue_references: $issue_references,
    issue_closures: $issue_closures,
    issues: $issue_closures,
    actions: $actions,
    depends_on_id: (if $depends_on_id == "" then null else $depends_on_id end),
    session_id: (if $session_id == "" then null else $session_id end),
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

http_status=$(api_send_capture POST "/api/auth/request" "$payload" "$tmp_response") || http_status=""

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
  # Bug: 16985e8 — server detected a duplicate.
  #
  # Issue 608d1db — this is a refusal, not an outcome. It previously echoed the
  # caller's own --title and branch under an "Auth request (existing)" heading
  # and fell through to the SSE watch with exit 0, so a submitter saw its own
  # arguments printed beside a foreign request's id and concluded it had
  # queued. Nothing is queued here, so: report only the *stored* request's
  # identity, say plainly that nothing was queued, and exit non-zero (3, a
  # conflict distinct from usage errors 2 and runtime failures 1) so no script
  # or agent can read this as a submission.
  existing_id=$(printf '%s' "$response" | jq -r '.request_id // empty' 2>/dev/null || echo "")
  if [[ -z "$existing_id" ]]; then
    echo "Error: 409 but no existing request_id in response: $response" >&2
    exit 1
  fi
  existing_status=$(printf '%s' "$response" | jq -r '.existing.status // .status // "pending"' 2>/dev/null || echo "pending")
  existing_title=$(printf '%s' "$response" | jq -r '.existing.title // empty' 2>/dev/null || echo "")
  existing_repo=$(printf '%s' "$response" | jq -r '.existing.repo // empty' 2>/dev/null || echo "")
  existing_head=$(printf '%s' "$response" | jq -r '.existing.head_branch // empty' 2>/dev/null || echo "")
  existing_base=$(printf '%s' "$response" | jq -r '.existing.base_branch // empty' 2>/dev/null || echo "")

  {
    echo "Error: auth request REFUSED as a duplicate. Nothing was queued."
    echo "No new request was created; '${head_branch}' is NOT in the auth queue from this run."
    echo ""
    echo "The existing request that caused this refusal:"
    echo "  ID:     $(api_short_id "$existing_id")"
    echo "  Status: ${existing_status}"
    # Older daemons answer 409 without the `existing` block. Print nothing
    # rather than substituting this caller's arguments — an unlabelled echo of
    # the submitter's own input is exactly what made this refusal misread.
    [[ -n "$existing_title" ]] && echo "  Title:  ${existing_title}"
    [[ -n "$existing_repo" ]] && echo "  Repo:   ${existing_repo}"
    if [[ -n "$existing_head" ]]; then
      echo "  Branch: ${existing_head} -> ${existing_base:-?}"
    fi
    if [[ -z "$existing_title$existing_repo$existing_head" ]]; then
      echo "  (this daemon did not report the stored request's details;"
      echo "   run 'mandible auth list' or open the dashboard to inspect it)"
    fi
    echo ""
    echo "If that request is the same work, update it:"
    echo "  PUT /api/auth/request/$(api_short_id "$existing_id")"
    # Issue 1512471 — the stored diff stats are NOT recomputed on update, so a
    # prose-only PUT leaves whatever numbers the request was born with in front
    # of the approver. They are accepted in the update payload; name them, with
    # this run's freshly computed values, so the correction is one copy away.
    echo "  Include the diff stats or the approver keeps the old ones:"
    echo "    {\"files_changed\": ${files_changed}, \"additions\": ${additions}, \"deletions\": ${deletions}}"
    echo "If it is different work that merely shares a branch name, rename this"
    echo "branch or resolve the existing request first, then resubmit."
  } >&2
  exit 3
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

  echo "Auth request submitted: $(api_short_id "$request_id")"
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
            echo "Auth request $(api_short_id "$request_id"): completed (exit ${exit_code_val})"
            printf 'ok' > "$tmp_sse_result"
            break
            ;;
          rejected|expired|dismissed)
            error=$(printf '%s' "$json" | jq -r '.data.error // "none"' 2>/dev/null)
            echo "Auth request $(api_short_id "$request_id"): ${status} -- ${error}"
            printf 'fail' > "$tmp_sse_result"
            break
            ;;
          *)
            echo "Auth request $(api_short_id "$request_id"): resolved with status '${status}'"
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
final=$(api_get "/api/auth/request/${request_id}" 2>/dev/null || true)
if [[ -n "$final" ]]; then
  status=$(printf '%s' "$final" | jq -r '.status // "unknown"')
  case "$status" in
    completed)
      exit_code_val=$(printf '%s' "$final" | jq -r '.exit_code // "null"')
      echo "Auth request $(api_short_id "$request_id"): completed (exit ${exit_code_val})"
      exit 0
      ;;
    rejected|expired|dismissed)
      error=$(printf '%s' "$final" | jq -r '.error // "none"')
      echo "Auth request $(api_short_id "$request_id"): ${status} -- ${error}"
      exit 1
      ;;
  esac
fi

echo "Auth request $(api_short_id "$request_id"): SSE connection lost, status unknown. Check dashboard." >&2
exit 1
