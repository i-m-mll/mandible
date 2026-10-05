#!/usr/bin/env bash

set -u
set -o pipefail

# MANDIBLE_PORT and MANDIBLE_BASE are exported by the dispatcher
GIT_ENV_HELPER="${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/git-env.sh"
source "$GIT_ENV_HELPER"

AUTH_PREFLIGHT_HELPER="${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/auth-preflight.sh"
source "$AUTH_PREFLIGHT_HELPER"

LEDGER_CLIENT_HELPER="${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/ledger-client.sh"
source "$LEDGER_CLIENT_HELPER"

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

auth_phase() {
  err "Auth phase: $1"
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
  mandible auth merge <source-branch> --preserve-head-branch

Options:
  --into <target>          Target/base branch (default: protected branch)
  --preserve-head-branch   Do not tear down the merged source branch/worktree
                           after a successful merge. Used when the source is a
                           long-lived branch (e.g. the Spaces docs branch) that
                           must survive promotion. Promotion normally cuts a
                           throwaway promote/docs/<ts> proxy branch instead, so
                           this flag is a defensive belt-and-suspenders guard.
USAGE
}

# Promotion proxy branches (promote/docs/<ts>) are deliberately disposable: a
# proxy is cut from the long-lived docs-branch head purely to feed the auth
# queue, so the post-merge worktree cleanup tears down only the proxy, never the
# long-lived docs worktree. The proxy therefore takes the NORMAL cleanup path
# (no preserve flag); the guards below exist to protect the docs worktree if a
# docs branch is ever merged directly. See child issue 8921e84.

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

git_lock_roots() {
  local common_dir
  local git_dir
  common_dir=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 1
  git_dir=$(git rev-parse --path-format=absolute --git-dir 2>/dev/null || true)

  printf "%s\n" "$common_dir"
  if [[ -n "$git_dir" && "$git_dir" != "$common_dir" ]]; then
    printf "%s\n" "$git_dir"
  fi
  if [[ -d "${common_dir}/worktrees" ]]; then
    printf "%s\n" "${common_dir}/worktrees"
  fi
}

git_lock_files() {
  local root
  git_lock_roots | sort -u | while IFS= read -r root; do
    if [[ -n "$root" && -d "$root" ]]; then
      find "$root" -maxdepth 3 -type f \( \
        -name "index.lock" -o \
        -name "HEAD.lock" -o \
        -name "config.lock" -o \
        -name "packed-refs.lock" -o \
        -name "shallow.lock" \
      \) -print 2>/dev/null
    fi
  done | sort -u
}

file_age_seconds() {
  local path=$1
  local mtime=""
  local now
  now=$(date +%s)
  mtime=$(stat -f %m "$path" 2>/dev/null || true)
  if [[ ! "$mtime" =~ ^[0-9]+$ ]]; then
    mtime=$(stat -c %Y "$path" 2>/dev/null || true)
  fi
  if [[ ! "$mtime" =~ ^[0-9]+$ ]]; then
    printf "unknown"
    return 0
  fi
  printf "%s" "$((now - mtime))"
}

lock_owner_pids() {
  local path=$1
  if ! command -v lsof >/dev/null 2>&1; then
    return 0
  fi
  lsof -t -- "$path" 2>/dev/null | sort -u | paste -sd, -
}

preflight_git_locks() {
  auth_phase "checking git locks..."
  local locks
  locks=$(git_lock_files)
  if [[ -z "$locks" ]]; then
    return 0
  fi

  err ""
  err "  ${RED}FATAL: Git lock file(s) are present before auth merge.${RESET}"
  err "  ${DIM_WHITE}Auth merge is aborting before dirty-tree checks, stash, signing, or merge work.${RESET}"
  err ""

  local lock
  while IFS= read -r lock; do
    [[ -n "$lock" ]] || continue
    local age
    local owners
    age=$(file_age_seconds "$lock")
    owners=$(lock_owner_pids "$lock")
    err "  ${RED}${lock}${RESET}"
    if [[ -n "$owners" ]]; then
      err "    ${DIM_WHITE}age: ${age}s; owning pid(s): ${owners}${RESET}"
    else
      err "    ${DIM_WHITE}age: ${age}s; no owning process found${RESET}"
    fi
  done <<<"$locks"

  err ""
  err "  ${DIM_WHITE}Remove stale lock files only after verifying no git process owns them, then retry.${RESET}"
  die "Aborting before auth merge because git lock files are present." 1
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

preflight_signing_check() {
  auth_phase "checking signing configuration..."
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

signing_key_is_sk() {
  local signing_key
  signing_key=$(git config --get user.signingkey 2>/dev/null || true)
  [[ -n "$signing_key" ]] || return 1

  case "$signing_key" in
    *sk-ssh-*|*sk-ecdsa-*) return 0 ;;
  esac

  local signing_key_path=$signing_key
  if [[ "$signing_key_path" == "~/"* ]]; then
    signing_key_path="${HOME}/${signing_key_path#\~/}"
  fi
  [[ -f "$signing_key_path" ]] || return 1
  local key_type
  key_type=$(awk 'NR == 1 { print $1 }' "$signing_key_path" 2>/dev/null || true)
  case "$key_type" in
    sk-ssh-*|sk-ecdsa-*) return 0 ;;
  esac
  return 1
}

is_daemon_sk_signing_failure() {
  local signing_stderr=$1
  local sk_key_in_use=${2:-false}

  case "$signing_stderr" in
    *"incorrect passphrase supplied to decrypt private key"*|*"invalid format"*) ;;
    *) return 1 ;;
  esac

  case "$signing_stderr" in
    *"Confirm user presence"*|*"sk-ssh-"*|*"sk-ecdsa-"*) return 0 ;;
  esac
  [[ "$sk_key_in_use" == "true" ]]
}

report_daemon_sk_signing_failure() {
  local signing_stderr=$1
  local sk_key_in_use=false
  if signing_key_is_sk; then
    sk_key_in_use=true
  fi
  is_daemon_sk_signing_failure "$signing_stderr" "$sk_key_in_use" || return 1

  err ""
  err "  ${RED}Protected merge signing failed; the cause is not established.${RESET}"
  err "  ${DIM_WHITE}The request and Git state require inspection before another attempt.${RESET}"
  err ""
  err "  Preserve the current state. Do not continue or abort the merge with raw Git commands:"
  err "  they bypass Mandible's auth-result and convergence checks, and ambient Git"
  err "  configuration may select a different signing key. Ask the configured operator"
  err "  to inspect the failed request and Git state before arranging audited recovery"
  err "  and, if needed, a fresh reviewed Mandible request."
  return 0
}

AUTH_MERGE_LAST_GIT_STDERR=""
run_signing_git() {
  local stderr_file
  stderr_file=$(mktemp "${TMPDIR:-/tmp}/mandible-auth-merge-stderr.XXXXXX") || return 1

  # Preserve stdout and stream stderr (including the user-presence prompt) while
  # retaining a copy for precise post-failure diagnosis.
  git "$@" 2>&1 1>&3 | tee "$stderr_file" >&2
  local git_status=${PIPESTATUS[0]}
  AUTH_MERGE_LAST_GIT_STDERR=$(<"$stderr_file")
  rm -f "$stderr_file"
  return "$git_status"
} 3>&1

current_branch_sha() {
  local branch="$1"
  git rev-parse --verify "refs/heads/${branch}^{commit}" 2>/dev/null || true
}

# --- Canonical change message (issue 7d64d8f) ---
#
# An auth request may carry an agent-authored canonical change message: the
# exact merge commit message, reviewed as part of the request and bound to a
# SHA-256 of its canonical bytes. When one exists, this script uses those bytes
# verbatim on every merge path instead of `git fmt-merge-msg`.
#
# Existence is asserted by the daemon through MANDIBLE_AUTH_CHANGE_MESSAGE_DIGEST,
# alongside the other reviewed merge inputs (expected head SHA, retained
# candidate tree). That is what makes a failed fetch fatal rather than a silent
# fallback: the merge knows a canonical message must be applied even when it
# cannot read it. A direct CLI invocation that can still read the request also
# honours a stored message, so the API remains the source of the bytes.
#
# Canonicalization mirrors src/auth-change-message.ts exactly: drop CR, strip
# trailing spaces/tabs per line, collapse runs of blank lines, drop leading and
# trailing blank lines, single trailing newline. Those are also git's own
# message-cleanup normalizations, so `git merge -m` cannot alter the approved
# bytes.
AUTH_MERGE_CANONICAL_MESSAGE=""
AUTH_MERGE_CANONICAL_MESSAGE_FILE=""
AUTH_MERGE_HAS_CANONICAL_MESSAGE=0

canonicalize_change_message() {
  LC_ALL=C tr -d '\r' | LC_ALL=C awk '
    { sub(/[ \t]+$/, ""); lines[++n] = $0 }
    END {
      s = 1
      while (s <= n && lines[s] == "") s++
      e = n
      while (e >= s && lines[e] == "") e--
      blank = 0
      for (i = s; i <= e; i++) {
        if (lines[i] == "") {
          if (blank) continue
          blank = 1
        } else {
          blank = 0
        }
        printf "%s\n", lines[i]
      }
    }
  '
}

change_message_digest() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | awk '{print $1}'
  else
    sha256sum | awk '{print $1}'
  fi
}

load_canonical_change_message() {
  local request_id="${MANDIBLE_AUTH_REQUEST_ID:-}"
  local expected_digest="${MANDIBLE_AUTH_CHANGE_MESSAGE_DIGEST:-}"

  if [[ -z "$request_id" ]]; then
    if [[ -n "$expected_digest" ]]; then
      err "${RED}A canonical change message digest was supplied without an auth request id; no ref or worktree was changed.${RESET}"
      return 1
    fi
    return 0
  fi

  local resolved_timeout resolved_retries
  resolved_timeout="${MANDIBLE_HTTP_TIMEOUT:-5}"
  resolved_retries="${MANDIBLE_HTTP_RETRIES:-0}"
  local MANDIBLE_HTTP_TIMEOUT="$resolved_timeout"
  local MANDIBLE_HTTP_RETRIES="$resolved_retries"

  local response
  if ! response=$(api_get "/api/auth/request/${request_id}" 2>/dev/null); then
    if [[ -n "$expected_digest" ]]; then
      err "${RED}Auth request ${request_id} carries an approved canonical change message (sha256 ${expected_digest}) that could not be fetched; no ref or worktree was changed.${RESET}"
      return 1
    fi
    return 0
  fi

  local stored_digest
  stored_digest=$(printf '%s' "$response" | jq -r '.commit_message_digest // empty' 2>/dev/null || true)
  if [[ -z "$stored_digest" ]]; then
    if [[ -n "$expected_digest" ]]; then
      err "${RED}Auth request ${request_id} no longer carries the approved canonical change message (sha256 ${expected_digest}); requeue and reapprove. No ref or worktree was changed.${RESET}"
      return 1
    fi
    return 0
  fi
  if [[ -n "$expected_digest" && "$stored_digest" != "$expected_digest" ]]; then
    err "${RED}Canonical change message changed after approval (approved sha256 ${expected_digest}, stored sha256 ${stored_digest}); requeue and reapprove. No ref or worktree was changed.${RESET}"
    return 1
  fi

  # The digest binds the exact stored octets, terminal newline included, so the
  # bytes are captured verbatim (jq -j, no added newline) and hashed as-is.
  # Canonical form is asserted separately and fails closed; re-canonicalizing
  # before hashing would let a non-canonical stored message pass by digesting a
  # normalized copy of something the merge would not commit.
  local message_file canonical_file actual
  message_file=$(mktemp "${TMPDIR:-/tmp}/mandible-canonical-message.XXXXXX") || return 1
  AUTH_MERGE_CANONICAL_MESSAGE_FILE="$message_file"
  trap 'rm -f "$AUTH_MERGE_CANONICAL_MESSAGE_FILE"' EXIT
  if ! printf '%s' "$response" | jq -j '.commit_message // ""' > "$message_file" 2>/dev/null; then
    err "${RED}Could not read the canonical change message bytes for auth request ${request_id}; no ref or worktree was changed.${RESET}"
    return 1
  fi
  if [[ ! -s "$message_file" ]]; then
    err "${RED}Auth request ${request_id} records a canonical change message digest but no message bytes; no ref or worktree was changed.${RESET}"
    return 1
  fi

  canonical_file="${message_file}.canonical"
  canonicalize_change_message < "$message_file" > "$canonical_file"
  if ! cmp -s "$message_file" "$canonical_file"; then
    rm -f "$canonical_file"
    err "${RED}The stored change message for auth request ${request_id} is not in canonical form; requeue and reapprove. No ref or worktree was changed.${RESET}"
    return 1
  fi
  rm -f "$canonical_file"

  actual=$(change_message_digest < "$message_file")
  if [[ "$actual" != "$stored_digest" ]]; then
    err "${RED}Canonical change message digest mismatch (expected sha256 ${stored_digest}, computed sha256 ${actual}); no ref or worktree was changed.${RESET}"
    return 1
  fi

  # `git merge -m` takes the message as an argument, and git's own cleanup
  # normalizes exactly the way canonical form already is, so dropping the
  # terminal newline here is byte-equivalent in the resulting commit. The
  # commit-tree path feeds the file itself and never goes through a variable.
  AUTH_MERGE_CANONICAL_MESSAGE=$(cat "$message_file")
  AUTH_MERGE_HAS_CANONICAL_MESSAGE=1
  auth_phase "using the approved canonical change message (sha256 ${stored_digest})."
  return 0
}

# Issue 08a5f04 (review F3) — the daemon passes the reviewed head commit as
# MANDIBLE_AUTH_EXPECTED_HEAD_SHA on every daemon-started merge. When a
# reviewed commit is supplied, the live source ref is verified against it
# immediately before the signing merge, and the merge then targets the exact
# reviewed object (not the racy branch name) with the branch-style merge
# message. Without a reviewed commit (direct CLI invocation), the legacy
# merge-by-branch-name behavior is preserved.


run_merge_preflight() {
  local cwd="$1"
  local head_branch="$2"
  local base_branch="$3"

  if [[ -n "${MANDIBLE_AUTH_PREFLIGHT_BASE_SHA:-}" ]]; then
    local current_base_sha
    current_base_sha=$(current_branch_sha "$base_branch")
    if [[ -z "$current_base_sha" || "$current_base_sha" != "$MANDIBLE_AUTH_PREFLIGHT_BASE_SHA" ]]; then
      err "${RED}Target ${base_branch} moved from reviewed base ${MANDIBLE_AUTH_PREFLIGHT_BASE_SHA} to ${current_base_sha:-unknown}; requeue and reapprove. No ref or worktree was changed.${RESET}"
      return 1
    fi
    if [[ "${MANDIBLE_AUTH_SKIP_MERGE_PREFLIGHT:-}" == "1" ]]; then
      auth_phase "reusing submit-time merge preflight; target ${base_branch} is still ${current_base_sha}."
      return 0
    fi
  fi
  auth_phase "running merge preflight checks..."

  mandible_auth_merge_preflight "$cwd" "$head_branch" "$base_branch"
}

tracked_worktree_is_clean() {
  [[ -z "$(git status --porcelain --untracked-files=no --ignore-submodules=none)" ]]
}

cached_candidate_tree() {
  local base_sha=$1
  local head_sha=$2
  local tree_sha=${MANDIBLE_AUTH_CANDIDATE_TREE_SHA:-}
  local pin_sha=${MANDIBLE_AUTH_CANDIDATE_PIN_SHA:-}
  local cached_base=${MANDIBLE_AUTH_CANDIDATE_BASE_SHA:-}
  local cached_head=${MANDIBLE_AUTH_CANDIDATE_HEAD_SHA:-}
  local cache_ref=${MANDIBLE_AUTH_CANDIDATE_REF:-}

  [[ -n "$tree_sha" && -n "$pin_sha" && "$base_sha" == "$cached_base" && "$head_sha" == "$cached_head" ]] || return 1
  git cat-file -e "${tree_sha}^{tree}" 2>/dev/null || return 1
  [[ "$(git cat-file -t "$pin_sha" 2>/dev/null || true)" == "commit" ]] || return 1
  [[ "$(git rev-parse --verify "${pin_sha}^{tree}" 2>/dev/null || true)" == "$tree_sha" ]] || return 1
  [[ "$(git rev-parse --verify "${pin_sha}^1" 2>/dev/null || true)" == "$base_sha" ]] || return 1
  [[ "$(git rev-parse --verify "${pin_sha}^2" 2>/dev/null || true)" == "$head_sha" ]] || return 1
  if [[ -n "$cache_ref" ]]; then
    [[ "$(git rev-parse --verify "$cache_ref" 2>/dev/null || true)" == "$pin_sha" ]] || return 1
  fi
  printf '%s' "$tree_sha"
}

require_cached_candidate_tree() {
  local base_sha=$1
  local head_sha=$2
  local tree_sha
  if tree_sha=$(cached_candidate_tree "$base_sha" "$head_sha"); then
    auth_phase "reusing retained submit-time merge tree ${tree_sha}."
    printf '%s' "$tree_sha"
    return 0
  fi
  err "${RED}Reviewed atomic merge inputs are stale or unavailable; requeue and reapprove the request. No ref or worktree was changed.${RESET}"
  return 1
}

verify_atomic_merge_not_empty() {
  local tree_sha=$1
  local parent_sha=$2
  local parent_tree
  parent_tree=$(git rev-parse --verify "${parent_sha}^{tree}") || return 1
  if [[ "$tree_sha" == "$parent_tree" ]]; then
    err "${RED}FATAL: Merge candidate has the same tree as its first parent.${RESET}"
    err "${DIM_WHITE}No ref or worktree was changed.${RESET}"
    return 1
  fi
}

create_signed_merge_commit() {
  local tree_sha=$1
  local first_parent=$2
  local second_parent=$3
  local source_branch=$4
  local message merge_sha
  if (( AUTH_MERGE_HAS_CANONICAL_MESSAGE )); then
    # Feed the approved file directly: the commit body is these exact octets.
    if ! merge_sha=$(run_signing_git commit-tree "$tree_sha" -p "$first_parent" -p "$second_parent" -S -F - \
      < "$AUTH_MERGE_CANONICAL_MESSAGE_FILE"); then
      report_daemon_sk_signing_failure "$AUTH_MERGE_LAST_GIT_STDERR" || true
      err "${RED}Signed commit creation failed; no ref or worktree was changed.${RESET}"
      return 1
    fi
    merge_sha=$(printf '%s' "$merge_sha" | tail -n 1 | tr -d '[:space:]')
    [[ "$merge_sha" =~ ^[0-9a-fA-F]{40,64}$ ]] || {
      err "${RED}git commit-tree did not return a commit object.${RESET}"
      return 1
    }
    printf '%s' "$merge_sha"
    return 0
  fi
  message=$(printf "%s\t\tbranch '%s' of .\n" "$second_parent" "$source_branch" | git fmt-merge-msg) || return 1
  if ! merge_sha=$(printf '%s\n' "$message" |
    run_signing_git commit-tree "$tree_sha" -p "$first_parent" -p "$second_parent" -S -F -); then
    report_daemon_sk_signing_failure "$AUTH_MERGE_LAST_GIT_STDERR" || true
    err "${RED}Signed commit creation failed; no ref or worktree was changed.${RESET}"
    return 1
  fi
  merge_sha=$(printf '%s' "$merge_sha" | tail -n 1 | tr -d '[:space:]')
  [[ "$merge_sha" =~ ^[0-9a-fA-F]{40,64}$ ]] || {
    err "${RED}git commit-tree did not return a commit object.${RESET}"
    return 1
  }
  printf '%s' "$merge_sha"
}

verify_atomic_merge_signature() {
  local merge_sha=$1
  local allowed_signers=${MANDIBLE_AUTH_ALLOWED_SIGNERS:-}
  [[ -n "$allowed_signers" ]] || {
    err "${RED}Atomic merge has no approving-user signer allowlist; refusing ref update.${RESET}"
    return 1
  }
  local verify_dir allowed_file output status
  verify_dir=$(mktemp -d "${TMPDIR:-/tmp}/mandible-auth-verify.XXXXXX") || return 1
  allowed_file="${verify_dir}/allowed_signers"
  printf '%s\n' "$allowed_signers" > "$allowed_file"
  chmod 600 "$allowed_file"
  output=$(
    unset GIT_CONFIG_COUNT GIT_CONFIG_PARAMETERS GIT_CONFIG
    local config_var
    for config_var in ${!GIT_CONFIG_KEY_@} ${!GIT_CONFIG_VALUE_@}; do
      unset "$config_var"
    done
    env \
      GIT_OPTIONAL_LOCKS=0 \
      GIT_CONFIG_NOSYSTEM=1 \
      GIT_CONFIG_GLOBAL=/dev/null \
      GIT_CONFIG_SYSTEM=/dev/null \
      git \
      -c gpg.format=ssh \
      -c "gpg.ssh.allowedSignersFile=${allowed_file}" \
      -c gpg.ssh.program=/usr/bin/ssh-keygen \
      -c gpg.ssh.revocationFile=/dev/null \
      -c gpg.minTrustLevel=fully \
      verify-commit "$merge_sha" 2>&1
  )
  status=$?
  rm -rf "$verify_dir"
  if (( status != 0 )); then
    err "$output"
    err "${RED}Signed commit is not trusted for the approving user; no ref or worktree was changed.${RESET}"
    return 1
  fi
  err "$output"
}

# Issue 70dffb8 — shared daemon exchange for auth-merge's HTTP-only reads and
# writes, replacing hand-rolled `curl` invocations.
#
# These call sites deliberately use api_http_exchange rather than
# api_get/api_send:
#   - The routes involved (POST /api/auth/request/:id/output, GET
#     /api/settings/:key) are registered `fileRpc: "deny"`, so routing them
#     through api_get/api_send would claim a file:// transport the daemon
#     refuses, and would trip the CLI route-coverage lint.
#   - api_send would additionally run the operational-mutation preflight, which
#     can refuse or defer a write from a stale restart-availability receipt or a
#     non-main instance reading. Inside the atomic merge window that would turn
#     an advisory preflight into an aborted (or "recovery required") merge.
# api_http_exchange is still the shared exchange: it resolves MANDIBLE_BASE,
# injects the client-auth bearer token via a 0600 curl config, and keeps curl
# handling in one place.
#
# Retries are pinned off and the timeout is pinned to each call site's previous
# `--max-time`, so the attempt count and wall-clock bound of the merge path are
# exactly what they were before the conversion. An explicit environment
# override still wins.
auth_merge_http_request() {
  local method="$1"
  local request_path="$2"
  local data="$3"
  local timeout="$4"
  local resolved_timeout resolved_retries response_file status
  resolved_timeout="${MANDIBLE_HTTP_TIMEOUT:-$timeout}"
  resolved_retries="${MANDIBLE_HTTP_RETRIES:-0}"
  local MANDIBLE_HTTP_TIMEOUT="$resolved_timeout"
  local MANDIBLE_HTTP_RETRIES="$resolved_retries"

  response_file=$(api_temp_file) || return 1
  status=$(api_http_exchange "$method" "$request_path" "$data" "$response_file")
  if [[ "$status" =~ ^2 ]]; then
    cat "$response_file"
    rm -f "$response_file"
    return 0
  fi
  rm -f "$response_file"
  return 1
}

persist_atomic_marker() {
  local marker=$1
  local request_id=${MANDIBLE_AUTH_REQUEST_ID:?missing auth request id}
  local payload
  payload=$(jq -nc --arg chunk "${marker}\n" '{chunk:$chunk}') || return 1
  auth_merge_http_request POST \
    "/api/auth/request/${request_id}/output" "$payload" 5 >/dev/null
}

cas_update_and_sync_target() {
  local target=$1
  local expected_sha=$2
  local merge_sha=$3

  if [[ "$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)" != "$target" ]] || \
     [[ "$(git rev-parse --verify HEAD 2>/dev/null || true)" != "$expected_sha" ]]; then
    err "${RED}Protected checkout branch or HEAD changed before ref update; compare-and-swap refused.${RESET}"
    return 1
  fi
  if ! tracked_worktree_is_clean; then
    err "${RED}Tracked worktree state changed before ref update; refusing atomic merge.${RESET}"
    return 1
  fi
  if [[ "$(current_branch_sha "$target")" != "$expected_sha" ]]; then
    err "${RED}Target ${target} moved before ref update; compare-and-swap refused.${RESET}"
    return 1
  fi
  verify_atomic_merge_signature "$merge_sha" || return 1
  local prepared_marker applied_marker
  prepared_marker="MANDIBLE_MERGE_PREPARED $(jq -nc --arg merge_sha "$merge_sha" --arg base_sha "$expected_sha" --arg head_sha "${MANDIBLE_AUTH_CANDIDATE_HEAD_SHA:-}" --arg tree_sha "${MANDIBLE_AUTH_CANDIDATE_TREE_SHA:-}" '{merge_sha:$merge_sha,base_sha:$base_sha,head_sha:$head_sha,tree_sha:$tree_sha}')"
  persist_atomic_marker "$prepared_marker" || {
    err "${RED}Could not durably record the prepared merge commit; no ref or worktree was changed.${RESET}"
    return 1
  }
  err "$prepared_marker"
  if ! git update-ref -m "mandible auth merge ${MANDIBLE_AUTH_REQUEST_ID:-unknown}" \
    "refs/heads/${target}" "$merge_sha" "$expected_sha"; then
    err "${RED}Target ${target} moved during ref update; compare-and-swap refused. No worktree was changed.${RESET}"
    return 1
  fi
  if ! git update-ref ORIG_HEAD "$expected_sha"; then
    err "Protected publication succeeded, but its native-hook original-head input could not be recorded; recovery is required."
    return 75
  fi
  applied_marker="MANDIBLE_MERGE_APPLIED $(jq -nc --arg merge_sha "$merge_sha" --arg base_sha "$expected_sha" '{merge_sha:$merge_sha,base_sha:$base_sha}')"
  persist_atomic_marker "$applied_marker" || {
    err "${RED}Target ref advanced to ${merge_sha}, but the applied checkpoint could not be persisted; recovery is required.${RESET}"
    return 75
  }
  err "$applied_marker"
  if ! git read-tree -m -u "$expected_sha" "$merge_sha"; then
    err "${RED}Target ref advanced to ${merge_sha}, but collision-safe protected worktree synchronization was blocked; recovery is required.${RESET}"
    return 75
  fi
  local merge_tree index_tree
  merge_tree=$(git rev-parse --verify "${merge_sha}^{tree}") || return 75
  index_tree=$(git write-tree) || return 75
  if [[ "$index_tree" != "$merge_tree" ]] || ! tracked_worktree_is_clean || [[ "$(git rev-parse --verify HEAD)" != "$merge_sha" ]]; then
    err "${RED}Protected worktree did not synchronize cleanly to ${merge_sha}.${RESET}"
    return 75
  fi
}

# Resolve the on-disk worktree path linked to a branch, if any.
branch_worktree_path() {
  local branch="$1"
  local current_path="" found_path=""
  while IFS= read -r line; do
    if [[ "$line" == worktree\ * ]]; then
      current_path="${line#worktree }"
    elif [[ "$line" == branch\ refs/heads/* ]]; then
      local b="${line#branch refs/heads/}"
      [[ "$b" == "$branch" ]] && found_path="$current_path"
    fi
  done < <(git worktree list --porcelain 2>/dev/null)
  printf "%s" "$found_path"
}

# The Spaces export backend provisions the long-lived docs worktree under
# `<repoRoot>/.git/mandible-docs-worktrees/<branch>` (see src/spaces/export.ts).
# That worktree (and its branch) must NEVER be destroyed by post-merge cleanup:
# promotion is supposed to run through a disposable proxy branch. This is a
# defensive guard so that even a misdirected direct docs-branch merge cannot
# tear down the managed docs worktree.
is_managed_docs_worktree_branch() {
  local branch="$1"
  local wt
  wt="$(branch_worktree_path "$branch")"
  [[ -n "$wt" ]] || return 1
  case "$wt" in
    */.git/mandible-docs-worktrees/*) return 0 ;;
    *) return 1 ;;
  esac
}

is_app_managed_worktree_branch() {
  local branch="$1"
  local wt
  wt="$(branch_worktree_path "$branch")"
  [[ -n "$wt" ]] || return 1
  case "$wt" in
    */.codex/worktrees/*|*/.git/mandible-docs-worktrees/*) return 0 ;;
    *) return 1 ;;
  esac
}

branch_worktree_status() {
  local branch="$1"
  local wt
  wt="$(branch_worktree_path "$branch")"
  [[ -n "$wt" && -d "$wt" ]] || return 0
  git -C "$wt" status --porcelain --untracked-files=all --ignore-submodules=none 2>/dev/null
}

branch_reap_proof() {
  local branch="$1"
  local target="$2"
  local branch_oid target_oid target_tree merge_output merge_tree
  branch_oid=$(git rev-parse --verify "refs/heads/${branch}^{commit}" 2>/dev/null) || return 1
  target_oid=$(git rev-parse --verify "refs/heads/${target}^{commit}" 2>/dev/null) || return 1
  if git merge-base --is-ancestor "$branch_oid" "$target_oid" 2>/dev/null; then
    printf '%s\t%s' "merged" "$branch_oid"
    return 0
  fi

  # `git cherry` ignores merge commits and can therefore miss merge-resolution
  # tree changes. A synthetic merge that produces the target's exact tree is a
  # complete, merge-aware proof that the candidate contributes no bytes.
  target_tree=$(git rev-parse --verify "${target_oid}^{tree}" 2>/dev/null) || return 1
  merge_output=$(git merge-tree --write-tree "$target_oid" "$branch_oid" 2>/dev/null) || return 1
  merge_tree=$(printf '%s\n' "$merge_output" | sed -n '1p')
  if [[ "$merge_tree" == "$target_tree" ]]; then
    printf '%s\t%s' "tree-equivalent" "$branch_oid"
    return 0
  fi
  return 1
}

configured_protected_branches() {
  if [[ -n "${MANDIBLE_AUTH_PROTECTED_BRANCHES:-}" ]]; then
    printf '%s' "$MANDIBLE_AUTH_PROTECTED_BRANCHES"
    return 0
  fi
  local response value
  # Issue 70dffb8 — same contract as the previous `curl -sf --max-time 2`:
  # a single quiet 2s attempt, non-2xx or unreachable daemon returns 1.
  response=$(auth_merge_http_request GET "/api/settings/protected_branches" "" 2 2>/dev/null) || return 1
  value=$(printf '%s' "$response" | jq -er '.value | select(type == "string" and length > 0)' 2>/dev/null) || return 1
  printf '%s' "$value"
}

branch_cleanup_guard() {
  local branch="$1"
  local target="$2"
  local current configured protected_name
  current=$(git branch --show-current 2>/dev/null || true)
  case "$branch" in
    ""|main|develop|master|HEAD) printf '%s' "protected/default branch"; return 0 ;;
  esac
  if [[ "$branch" == "$target" || "$branch" == "$current" || "$branch" == "$(protected_branch)" ]]; then
    printf '%s' "protected/default/current branch"
    return 0
  fi
  if ! configured=$(configured_protected_branches); then
    printf '%s' "protected branch configuration unavailable"
    return 0
  fi
  while IFS= read -r protected_name; do
    protected_name=$(printf '%s' "$protected_name" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    if [[ -n "$protected_name" && "$branch" == "$protected_name" ]]; then
      printf '%s' "configured protected branch"
      return 0
    fi
  done < <(printf '%s\n' "$configured" | tr ',' '\n')
  if is_app_managed_worktree_branch "$branch"; then
    printf '%s' "app-managed worktree"
    return 0
  fi
  return 1
}

trash_dirty_branch() {
  local branch="$1"
  local issue_ids="$2"
  local root
  root=$(git rev-parse --show-toplevel 2>/dev/null) || return 1
  local worktree_path
  worktree_path="$(branch_worktree_path "$branch")"
  local -a args=(--project "$root" --checkout-root "$root" --branch "$branch" --reason merged --actor auth-merge)
  local issue_id
  while IFS= read -r issue_id; do
    [[ -n "$issue_id" ]] || continue
    args+=(--issue "$issue_id")
  done <<< "$issue_ids"

  local response error_file status error_response
  error_file=$(mktemp) || return 1
  response=$(MANDIBLE_LEDGER_ERROR_BODY_FILE="$error_file" mandible_trash_create "${args[@]}")
  status=$?
  if (( status != 0 )); then
    error_response=$(cat "$error_file")
    rm -f "$error_file"
    if printf '%s' "$error_response" | jq -e '.detail.outcome.worktree_removed == true' >/dev/null 2>&1; then
      local reported_path
      reported_path=$(printf '%s' "$error_response" | jq -r '.detail.outcome.worktree_path // empty' 2>/dev/null)
      err "${BOLD_YELLOW}Trash custody is incomplete, but worktree path ${reported_path:-${worktree_path:-for ${branch}}} is gone. No further work may happen there.${RESET}"
    elif printf '%s' "$error_response" | jq -e '.detail.outcome.branch_removed == true' >/dev/null 2>&1; then
      err "${BOLD_YELLOW}Trash custody is incomplete; the normal branch ref is gone, and repair is required before restore.${RESET}"
    else
      err "${BOLD_YELLOW}Trash custody failed for ${branch}; the service reported no local removal.${RESET}"
    fi
    return "$status"
  fi
  rm -f "$error_file"
  err "${GREEN}trashed dirty merged branch ${branch}; reversible custody recorded.${RESET}"
  if printf '%s' "$response" | jq -e '.outcome.worktree_removed == true' >/dev/null 2>&1; then
    local reported_path
    reported_path=$(printf '%s' "$response" | jq -r '.outcome.worktree_path // empty' 2>/dev/null)
    err "${BOLD_YELLOW}Worktree path ${reported_path:-${worktree_path:-for ${branch}}} is gone. No further work may happen there.${RESET}"
  fi
}

remove_clean_reapable_branch() {
  local branch="$1"
  local evidence="$2"
  local expected_oid="$3"
  local dwt="$4"
  local wt
  wt="$(branch_worktree_path "$branch")"

  if [[ -n "$wt" ]]; then
    if ! "$dwt" "$branch" --keep-branch; then
      err "${BOLD_YELLOW}preserved ${branch}: clean worktree removal failed.${RESET}"
      return 1
    fi
    err "${BOLD_YELLOW}Worktree path ${wt} is gone. No further work may happen there.${RESET}"
  fi
  if ! git update-ref -d "refs/heads/${branch}" "$expected_oid" >/dev/null 2>&1; then
    err "${BOLD_YELLOW}preserved ${branch}: branch advanced after proof or its ref changed; compare-and-swap deletion refused.${RESET}"
    return 1
  fi
  err "${GREEN}reaped clean ${evidence} branch ${branch}${wt:+ and worktree ${wt}}.${RESET}"
}

cleanup_branch_candidate() {
  local branch="$1"
  local target="$2"
  local issue_ids="$3"
  local dwt="$4"
  local guard proof evidence expected_oid wt worktree_status

  if ! git show-ref --verify --quiet "refs/heads/${branch}"; then
    return 0
  fi
  guard=$(branch_cleanup_guard "$branch" "$target") && {
    err "${DIM_WHITE}preserved ${branch}: ${guard}.${RESET}"
    return 0
  }
  proof=$(branch_reap_proof "$branch" "$target") || {
    err "${DIM_WHITE}preserved ${branch}: git cannot prove merged or patch-equivalent to ${target}.${RESET}"
    return 0
  }
  IFS=$'\t' read -r evidence expected_oid <<< "$proof"
  wt="$(branch_worktree_path "$branch")"
  if [[ -n "$wt" && ! -d "$wt" ]]; then
    err "${BOLD_YELLOW}preserved ${branch}: registered worktree path is missing or ambiguous (${wt}).${RESET}"
    return 0
  fi
  if ! worktree_status=$(branch_worktree_status "$branch"); then
    err "${BOLD_YELLOW}preserved ${branch}: worktree status is unavailable.${RESET}"
    return 0
  fi
  if [[ -n "$worktree_status" ]]; then
    if ! trash_dirty_branch "$branch" "$issue_ids"; then
      err "${BOLD_YELLOW}Trash custody for dirty merged branch ${branch} did not complete; see the reported removal outcome above. No further cleanup was attempted.${RESET}"
    fi
    return 0
  fi
  remove_clean_reapable_branch "$branch" "$evidence" "$expected_oid" "$dwt" || true
}

collect_work_unit_branches() {
  local issue_ids="$1"
  local repo_id="$2"
  local issue_id response
  while IFS= read -r issue_id; do
    [[ -n "$issue_id" ]] || continue
    if ! response=$(mandible_work_unit_find --repo "$repo_id" --issue "$issue_id" 2>/dev/null); then
      err "${BOLD_YELLOW}Could not inspect work-unit branches for issue ${issue_id}; sibling cleanup skipped for that issue.${RESET}"
      continue
    fi
    printf '%s' "$response" | jq -r '.work_units[]?.branch // empty' 2>/dev/null
  done <<< "$issue_ids"
}

current_canonical_repo_id() {
  local root response project_key
  root=$(git rev-parse --show-toplevel 2>/dev/null) || return 1
  response=$(api_get "/api/projects/$(urlencode "$root")" 2>/dev/null) || return 1
  project_key=$(printf '%s' "$response" | jq -er \
    '.project.project_key | select(type == "string" and length > 0)' 2>/dev/null) || return 1
  printf '%s' "$project_key"
}

# $1 = merged source branch
# $2 = preserve flag ("1" to skip tearing down the merged branch itself)
# $3 = target branch used for authoritative merged/patch-equivalent evidence
# $4 = newline-delimited closed/declared issue refs used to discover sibling work units
cleanup_merged_worktrees() {
  local branch="$1"
  local preserve_head="${2:-0}"
  local target="${3:-$(protected_branch)}"
  local issue_ids="${4:-}"
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  # dwt is vendored alongside this script in cli/
  local dwt="${script_dir}/dwt"

  # Only attempt cleanup if dwt exists (absent = broken Mandible install, not a normal skip)
  [[ -x "$dwt" ]] || { err "warning: vendored dwt not found at ${dwt}; skipping worktree cleanup"; return 0; }

  # Never destroy a long-lived branch the caller asked to preserve, and never
  # destroy the managed Spaces docs worktree even if a docs branch was merged
  # directly. Promotion of the docs branch is supposed to go through a
  # disposable promote/docs/<ts> proxy branch instead.
  if [[ "$preserve_head" == "1" ]]; then
    err "${DIM_WHITE}--preserve-head-branch: leaving ${branch} and its worktree in place.${RESET}"
  elif is_managed_docs_worktree_branch "$branch"; then
    err "${DIM_WHITE}Refusing to tear down managed docs worktree for ${branch}; promote via a proxy branch instead.${RESET}"
  else
    cleanup_branch_candidate "$branch" "$target" "$issue_ids" "$dwt"
  fi

  # Clean __-delimited child branches (these are always disposable feature
  # sub-branches; the preserve guard only applies to the merged head branch).
  local prefix="${branch}__"
  local child
  git for-each-ref --format='%(refname:short)' 'refs/heads/' | while IFS= read -r child; do
    case "$child" in
      "${prefix}"*)
        cleanup_branch_candidate "$child" "$target" "$issue_ids" "$dwt"
        ;;
    esac
  done

  # Work-unit branches for the issue(s) declared closed by this merge may be
  # siblings with unrelated names. The ledger only supplies candidates; each
  # branch still needs authoritative ancestry or patch-equivalence evidence.
  if [[ -n "$issue_ids" ]]; then
    local sibling canonical_repo_id
    if ! canonical_repo_id=$(current_canonical_repo_id); then
      err "${BOLD_YELLOW}Preserved sibling work-unit branches: canonical project identity could not be resolved uniquely for this checkout; destructive candidate discovery was skipped.${RESET}"
      return 0
    fi
    collect_work_unit_branches "$issue_ids" "$canonical_repo_id" | sort -u | while IFS= read -r sibling; do
      [[ -n "$sibling" && "$sibling" != "$branch" && "$sibling" != "${prefix}"* ]] || continue
      cleanup_branch_candidate "$sibling" "$target" "$issue_ids" "$dwt"
    done
  fi
}

urlencode() {
  jq -rn --arg value "$1" '$value|@uri'
}

current_repo_id() {
  local root
  root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
  basename "$root"
}

# Bug: 297677f — include issues declared in the auth request's issues field.
# Bug: 7b83c1f — prefer issue_closures; issues remains legacy close-on-merge.
collect_declared_issues() {
  # Requires MANDIBLE_AUTH_REQUEST_ID to be set by the executor
  local request_id="${MANDIBLE_AUTH_REQUEST_ID:-}"
  if [[ -z "$request_id" ]]; then
    return 0
  fi

  # Issue 70dffb8 — read the auth request through the shared api.sh client
  # instead of a hardcoded http://127.0.0.1:<port> base. GET /api/auth/request/:id
  # is registered fileRpc:"allow" and GETs never enter the operational-mutation
  # preflight, so api_get is a faithful swap: it resolves MANDIBLE_BASE (or the
  # file:// spool) and injects the client-auth bearer token. Attempt count and
  # the 5s bound are pinned to the previous `curl -sf --max-time 5`, and any
  # failure still means "no declared issues".
  local resolved_timeout resolved_retries
  resolved_timeout="${MANDIBLE_HTTP_TIMEOUT:-5}"
  resolved_retries="${MANDIBLE_HTTP_RETRIES:-0}"
  local MANDIBLE_HTTP_TIMEOUT="$resolved_timeout"
  local MANDIBLE_HTTP_RETRIES="$resolved_retries"

  # Query the auth request for issues
  local response
  response=$(api_get "/api/auth/request/${request_id}" 2>/dev/null) || return 0

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

collect_cleanup_issue_ids() {
  collect_declared_issues | sed '/^$/d' | sort -u
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
  merge_sha=${2:-$(git rev-parse HEAD 2>/dev/null || echo "unknown")}
  local declared_ids
  declared_ids=$(collect_declared_issues)
  err "MANDIBLE_MERGE_RESULT $(jq -nc \
    --arg merge_sha "$merge_sha" \
    --arg repo_id "$(current_repo_id)" \
    --argjson declared_issues "$(issue_ids_to_json "$declared_ids")" \
    '{merge_sha:$merge_sha, repo_id:$repo_id, declared_issues:$declared_issues}')"
}

# Bug: 4afab83 — post-merge build/restart logic has been moved to the auth_hooks
# system in the Mandible daemon. Hooks are configured per-repo in the auth_hooks
# table and run automatically after successful auth actions.

main() {
  if ! git rev-parse --git-dir >/dev/null 2>&1; then
    die "Not a git repository." 2
  fi

  # Strip agent-injected git config overrides (e.g., GIT_CONFIG_COUNT from
  # CLAUDECODE=1). Trusted delegated-signing approvals deliberately pass
  # GIT_CONFIG_* overrides from the daemon so git signs with the short-lived key.
  if [[ "${MANDIBLE_AUTH_DELEGATED_SIGNING:-}" != "1" ]]; then
    local var
    for var in $(env | grep '^GIT_CONFIG_' | cut -d= -f1); do
      unset "$var"
    done
  fi

  local target=""
  local preserve_head=0
  local -a sources=()

  while (( $# > 0 )); do
    case "$1" in
      --help|-h)
        usage
        exit 0
        ;;
      --preserve-head-branch)
        preserve_head=1
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

  preflight_git_locks

  if [[ ${#sources[@]} -ne 1 ]]; then
    usage >&2
    exit 2
  fi
  local source=${sources[0]}

  [[ "${MANDIBLE_AUTH_ATOMIC:-}" == "1" ]] || die "Protected merges require a reviewed signed candidate; submit an auth request. No protected state changed." 1
  [[ ! -f "$(git rev-parse --git-dir)/MERGE_HEAD" ]] || die "Interrupted legacy merge state requires operator recovery; candidate publication cannot resume it." 1


  if ! branch_exists "$target"; then
    die "Target branch '$target' does not exist." 2
  fi

  if ! branch_exists "$source"; then
    die "Source branch '$source' does not exist." 2
  fi

  # Issue 7d64d8f — resolve the approved merge commit message before anything
  # is confirmed or mutated, so a missing or tampered message fails the request
  # rather than the repository.
  if ! load_canonical_change_message; then
    exit 1
  fi

  # Pre-flight: ensure tracked worktree state and the candidate merge are clean.
  # The definition lives behind `mandible auth check`; this path does not call
  # user dotfiles policy scripts or weaker local fallbacks.
  if ! run_merge_preflight "$(pwd)" "$source" "$target"; then
    exit 1
  fi

  local current_branch
  current_branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)

  local -a lines=()
  lines+=("  ${BOLD_WHITE}Protected Branch Merge${RESET}")
  lines+=("  ")

  local commit_count
  commit_count=$(git log --oneline "$target..$source" | wc -l | awk '{print $1}')
  commit_count=${commit_count:-0}

  local shortstat
  shortstat=$(git diff --shortstat "$target..$source")

  local files insertions deletions
  read -r files insertions deletions <<<"$(parse_shortstat "$shortstat")"

  if [[ "$commit_count" == "0" ]]; then
    err "Already up to date."
    exit 0
  fi

  local IFS_BAK2="$IFS"
  IFS=$'\n'
  source_lines=( $(build_lines_for_source "$source" "$target" "$commit_count" "$files" "$insertions" "$deletions") )
  IFS="$IFS_BAK2"

  lines+=("${source_lines[@]}")
  lines+=("  ")

  preflight_signing_check

  _box_lines=("${lines[@]}")
  print_box

  local response
  response=$(prompt_confirm "Confirm merge? [y/N]")
  response=$(printf "%s" "$response" | tr '[:upper:]' '[:lower:]')
  case "$response" in
    y|yes)
      ;;
    *)
      err "Merge cancelled."
      exit 1
      ;;
  esac

  if [[ "${MANDIBLE_AUTH_ATOMIC:-}" == "1" ]]; then
    if [[ "$current_branch" != "$target" ]]; then
      die "Atomic auth merge must run in the worktree already tracking target branch '$target'; current branch is '${current_branch:-detached HEAD}'." 1
    fi
    if ! tracked_worktree_is_clean; then
      die "Tracked worktree state changed after preflight; no ref or worktree was changed." 1
    fi

    local atomic_base
    atomic_base=$(current_branch_sha "$target")
    local source_head merge_tree merge_sha
    source_head=$(current_branch_sha "$source")
    # Issue 08a5f04 (review F3) — the reviewed-head context must be internally
    # consistent: the daemon-supplied expected head and the cached candidate
    # head describe the same reviewed commit.
    if [[ -n "${MANDIBLE_AUTH_EXPECTED_HEAD_SHA:-}" && \
          "${MANDIBLE_AUTH_EXPECTED_HEAD_SHA}" != "${MANDIBLE_AUTH_CANDIDATE_HEAD_SHA:-}" ]]; then
      die "Reviewed head context is inconsistent (expected ${MANDIBLE_AUTH_EXPECTED_HEAD_SHA}, candidate ${MANDIBLE_AUTH_CANDIDATE_HEAD_SHA:-unset}); requeue and reapprove. No ref or worktree was changed." 1
    fi
    if [[ "$atomic_base" != "${MANDIBLE_AUTH_CANDIDATE_BASE_SHA:-}" ]] || \
       [[ "$source_head" != "${MANDIBLE_AUTH_CANDIDATE_HEAD_SHA:-}" ]]; then
      die "Reviewed base or head moved since auth submission; requeue and reapprove. No ref or worktree was changed." 1
    fi
    merge_tree=$(require_cached_candidate_tree "$atomic_base" "$source_head") || exit 1
    verify_atomic_merge_not_empty "$merge_tree" "$atomic_base" || exit 1
    auth_phase "creating signed merge commit for ${source} with git commit-tree..."
    merge_sha=$(create_signed_merge_commit "$merge_tree" "$atomic_base" "$source_head" "$source") || exit 1
    [[ "$(current_branch_sha "$source")" == "$source_head" ]] || die "Source ${source} moved before target update; no ref or worktree was changed." 1
    auth_phase "signed merge commit complete; atomically advancing ${target}..."
    cas_update_and_sync_target "$target" "$atomic_base" "$merge_sha"
    local cas_status=$?
    (( cas_status == 0 )) || exit "$cas_status"
    auth_phase "protected worktree synchronized; running follow-up actions..."
    record_auth_merge_result "$atomic_base"
    cleanup_merged_worktrees "$source" "$preserve_head" "$target" "$(collect_cleanup_issue_ids "$atomic_base")"
    exit 0
  fi


}

# Allow tests to source this script for unit-testing individual helpers
# (e.g. cleanup_merged_worktrees) without running the full merge flow.
if [[ "${MANDIBLE_AUTH_MERGE_SOURCE_ONLY:-}" != "1" ]]; then
  main "$@"
fi
