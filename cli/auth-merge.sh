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
DIM_WHITE=$'\033[2;37m'
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
  mandible_command_help auth merge
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

current_branch_sha() {
  local branch="$1"
  git rev-parse --verify "refs/heads/${branch}^{commit}" 2>/dev/null || true
}

run_merge_preflight() {
  local cwd="$1"
  local head_branch="$2"
  local base_branch="$3"
  local readiness="${MANDIBLE_CLI_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}/checkout-readiness.sh"
  local -a readiness_args=("$cwd")
  if [[ -n "${MANDIBLE_AUTH_PREFLIGHT_BASE_SHA:-}" && -n "${MANDIBLE_AUTH_CANDIDATE_TREE_SHA:-}" ]]; then
    readiness_args+=("$base_branch" "$MANDIBLE_AUTH_PREFLIGHT_BASE_SHA" "$MANDIBLE_AUTH_CANDIDATE_TREE_SHA")
  fi
  bash "$readiness" "${readiness_args[@]}" || return $?

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
  local readiness="${MANDIBLE_CLI_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}/checkout-readiness.sh"
  local report
  CHECKOUT_READINESS_FAILURE=""
  if report=$(bash "$readiness" "$(pwd)" 2>&1); then return 0; fi
  err "$report"
  CHECKOUT_READINESS_FAILURE="${report##*$'\n'}"
  return 1
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

# The daemon signs the exact merge commit at approval (issue e523950); this
# script never invokes a signer. It checks that the signed object is the
# reviewed merge, and cas_update_and_sync_target verifies its signature.
require_signed_merge_commit() {
  local tree_sha=$1
  local first_parent=$2
  local second_parent=$3
  local merge_sha=${MANDIBLE_AUTH_SIGNED_MERGE_SHA:-}
  [[ "$merge_sha" =~ ^[0-9a-f]{40,64}$ ]] || {
    err "${RED}No approval-signed merge commit was supplied; approve the request again. No ref or worktree was changed.${RESET}"
    return 1
  }
  if [[ "$(git cat-file -t "$merge_sha" 2>/dev/null || true)" != "commit" ]] || \
     [[ "$(git rev-parse --verify "${merge_sha}^{tree}" 2>/dev/null || true)" != "$tree_sha" ]] || \
     [[ "$(git rev-list --parents -n 1 "$merge_sha" 2>/dev/null || true)" != "$merge_sha $first_parent $second_parent" ]]; then
    err "${RED}The approval-signed commit ${merge_sha} is not the reviewed merge; approve the request again. No ref or worktree was changed.${RESET}"
    return 1
  fi
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
  payload=$(jq -nc --arg chunk "$marker" '{chunk:($chunk + "\n")}') || return 1
  auth_merge_http_request POST \
    "/api/auth/request/${request_id}/output" "$payload" 5 >/dev/null
}

cas_update_and_sync_target() {
  local target=$1
  local expected_sha=$2
  local merge_sha=$3
  local source=$4

  if [[ "$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)" != "$target" ]] || \
     [[ "$(git rev-parse --verify HEAD 2>/dev/null || true)" != "$expected_sha" ]]; then
    err "${RED}Protected checkout branch or HEAD changed before ref update; compare-and-swap refused.${RESET}"
    return 1
  fi
  if ! tracked_worktree_is_clean; then
    err "${CHECKOUT_READINESS_FAILURE} No ref or worktree was changed."
    return 1
  fi
  if [[ "$(current_branch_sha "$target")" != "$expected_sha" ]]; then
    err "${RED}Target ${target} moved before ref update; compare-and-swap refused.${RESET}"
    return 1
  fi
  local sync_blockers
  if ! sync_blockers=$(checkout_sync_check "$expected_sha" "$merge_sha"); then
    err "$sync_blockers"
    err "${RED}Merge not applied: the protected checkout could not be synced to it. Nothing was changed; clear the paths above and retry the request.${RESET}"
    return 1
  fi
  local submodule_blockers
  if ! submodule_blockers=$(submodule_sync fetch "$expected_sha" "$merge_sha" "$source"); then
    err "$submodule_blockers"
    err "${RED}Merge not applied: the protected checkout's submodules cannot reach the merged commits. No ref or checkout was changed.${RESET}"
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
  local sync_error
  if ! sync_error=$(git read-tree -m -u "$expected_sha" "$merge_sha" 2>&1); then
    restore_unsynced_target "$target" "$expected_sha" "$merge_sha" "$sync_error"
    return $?
  fi
  if ! submodule_blockers=$(submodule_sync update "$expected_sha" "$merge_sha" "$source"); then
    err "$submodule_blockers"
    err "${RED}Target ${target} advanced to ${merge_sha}, but the protected checkout's submodules did not follow; recovery is required.${RESET}"
    return 75
  fi
  local merge_tree index_tree
  merge_tree=$(git rev-parse --verify "${merge_sha}^{tree}") || return 75
  index_tree=$(git write-tree) || return 75
  if [[ "$index_tree" != "$merge_tree" ]] || ! tracked_worktree_is_clean || [[ "$(git rev-parse --verify HEAD)" != "$merge_sha" ]]; then
    err "${RED}Protected worktree did not synchronize cleanly to ${merge_sha}.${RESET}"
    return 75
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
}

submodule_sync() {
  bash "${MANDIBLE_CLI_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}/submodule-sync.sh" "$1" "$(git rev-parse --show-toplevel)" "$2" "$3" "$4"
}

checkout_sync_check() {
  bash "${MANDIBLE_CLI_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}/checkout-sync-check.sh" "$(git rev-parse --show-toplevel)" "$1" "$2"
}

# The checkout changed between the dry run and the ref advance, so the sync
# refused. The advanced ref is local and unconsumed: put it back, so the
# request is either merged and synced or not merged at all.
restore_unsynced_target() {
  local target=$1 expected_sha=$2 merge_sha=$3 sync_error=$4 blockers
  blockers=$(checkout_sync_check "$expected_sha" "$merge_sha") || true
  if [[ "$(git write-tree 2>/dev/null)" != "$(git rev-parse --verify "${expected_sha}^{tree}")" ]] || \
     ! git update-ref -m "mandible auth merge ${MANDIBLE_AUTH_REQUEST_ID:-unknown} not synced" \
       "refs/heads/${target}" "$expected_sha" "$merge_sha"; then
    err "$sync_error"
    err "${RED}Target ref advanced to ${merge_sha} and the protected checkout could not follow it, and the ref could not be restored; recovery is required.${RESET}"
    return 75
  fi
  err "${blockers:-$sync_error}"
  err "${RED}Merge not applied: the protected checkout changed after the preflight and could not follow it. ${target} was restored to ${expected_sha:0:10}; nothing was changed. Clear the paths above and retry the request.${RESET}"
  return 1
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
  # CLAUDECODE=1).
  local var
  for var in $(env | grep '^GIT_CONFIG_' | cut -d= -f1); do
    unset "$var"
  done

  local target=""
  local -a sources=()

  local binding
  binding=$(mandible_bind_arguments "auth.merge" '{"target":{"option":"into"},"sources":{"rest":0}}' "$@") || return $?
  eval "$binding"

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

  # Pre-flight: ensure tracked worktree state and the candidate merge are clean.
  # The definition lives behind `mandible auth check`; this path does not call
  # user dotfiles policy scripts or weaker local fallbacks.
  if ! run_merge_preflight "$(pwd)" "$source" "$target"; then
    exit 1
  fi

  local current_branch
  current_branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)

  if [[ "$current_branch" != "$target" ]]; then
    die "Atomic auth merge must run in the worktree already tracking target branch '$target'; current branch is '${current_branch:-detached HEAD}'." 1
  fi
  if ! tracked_worktree_is_clean; then
    die "${CHECKOUT_READINESS_FAILURE} No ref or worktree was changed." 1
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
  merge_sha=$(require_signed_merge_commit "$merge_tree" "$atomic_base" "$source_head") || exit 1
  auth_phase "publishing approval-signed merge commit ${merge_sha}; atomically advancing ${target}..."
  cas_update_and_sync_target "$target" "$atomic_base" "$merge_sha" "$source"
  local cas_status=$?
  (( cas_status == 0 )) || exit "$cas_status"
  auth_phase "protected worktree synchronized; recording the merge result..."
  record_auth_merge_result "$atomic_base"
  exit 0
}

# Allow tests and atomic recovery to source this script for individual
# helpers without running the full merge flow.
if [[ "${MANDIBLE_AUTH_MERGE_SOURCE_ONLY:-}" != "1" ]]; then
  main "$@"
fi
