#!/usr/bin/env bash
# mandible auth deliver: the operator's own delivery of a branch from its
# checkout, in one command: issue, work unit, request, approval, merge. It ends
# merged (exit 0) or with no pending request left (exit 1, or 130 when
# interrupted).

set -euo pipefail
source "${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/api.sh"
mandible_prepare_syntax_runtime || exit $?
source "${MANDIBLE_CLI_DIR:-$MANDIBLE_COMMAND_SYNTAX_DIR}/git-env.sh"
cli_dir="${MANDIBLE_CLI_DIR:-$MANDIBLE_COMMAND_SYNTAX_DIR}"

branch=""
title=""
message_text=""
message_file=""
message_set=0
verification=""
issue=""
kind="feature"
dirty_policy=""
binding=$(mandible_bind_main_arguments "auth.deliver" '{"branch":{"position":0},"title":{"option":"title"},"message_text":{"option":"message"},"message_file":{"option":"message-file"},"message_set":[{"option":"message","constant":"1"},{"option":"message-file","constant":"1"}],"verification":{"option":"verification"},"issue":{"option":"issue"},"kind":{"option":"kind"},"dirty_policy":{"option":"dirty-policy"}}' "$@") || exit $?
eval "$binding"
usage='Usage: mandible auth deliver <branch> --title <text> (--message <text> | --message-file <file>) --verification <text> [--issue <id>] [--kind <kind>] [--dirty-policy <policy>]'
if [[ -z "$branch" || -z "${title//[[:space:]]/}" || "$message_set" != 1 || -z "${verification//[[:space:]]/}" ]] \
  || [[ -n "$message_text" && -n "$message_file" ]]; then
  printf '%s\n' "$usage" >&2
  exit 2
fi
if api_managed_client_markers_present; then
  printf '%s\n' 'Error: auth deliver is the operator'\''s own command; agent and managed sessions cannot deliver.' >&2
  exit 1
fi
command -v jq >/dev/null 2>&1 || { printf '%s\n' 'Error: jq is required.' >&2; exit 1; }

message="$message_text"
if [[ -n "$message_file" ]]; then
  if [[ "$message_file" == - ]]; then
    message=$(cat)
  else
    [[ -f "$message_file" ]] || { printf "Error: --message-file '%s' does not exist\n" "$message_file" >&2; exit 2; }
    message=$(cat "$message_file")
  fi
fi
[[ -n "${message//[[:space:]]/}" ]] || { printf '%s\n' "$usage" >&2; exit 2; }

git_common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) \
  || { printf '%s\n' 'Error: auth deliver runs in the checkout of the repository it delivers to.' >&2; exit 1; }
repo_root=$(dirname "$git_common")
repo=$(basename "$repo_root")
work_repo_id=$(printf '%s' "$repo" | sed 's/^\.*//')
base_branch=$(detect_protected_branch)

request_state() {
  api_get "/api/auth/request/$(urlencode "$1")"
}

withdraw_pending() {
  local request_id="$1" reason="$2" current
  current=$(request_state "$request_id") || return 1
  [[ "$(jq -r '.status' <<<"$current")" == pending ]] || return 0
  "$cli_dir/auth-withdraw.sh" "$request_id" --reason "$reason" \
    --expected-revision "$(jq -r '.lifecycle_revision' <<<"$current")" \
    --expected-custody-generation "$(jq -r '.responsibility.custody_generation // 0' <<<"$current")" >/dev/null
}

# Requests for the same delivery are settled before anything is written.
queue=$(api_get /api/auth/queue) || { printf '%s\n' 'Error: could not read the auth queue.' >&2; exit 1; }
same_delivery=$(jq -c --arg repo "$repo" --arg head "$branch" --arg base "$base_branch" \
  '[.requests[] | select(.repo == $repo and .head_branch == $head and .base_branch == $base and (.status == "pending" or .status == "approved" or .status == "executing"))]' <<<"$queue")
in_flight=$(jq -r '[.[] | select(.status != "pending") | "\(.id[0:8]) (\(.status))"] | join(", ")' <<<"$same_delivery")
if [[ -n "$in_flight" ]]; then
  printf 'Error: %s -> %s is already being delivered by auth request %s; wait for it to settle.\n' "$branch" "$base_branch" "$in_flight" >&2
  exit 1
fi

if [[ -z "$issue" ]]; then
  issues=$(api_get "/api/issues?repo=$(urlencode "$repo_root")&status=open") \
    || { printf '%s\n' 'Error: could not read the project'\''s issues.' >&2; exit 1; }
  matches=$(jq -r --arg title "$title" '[.[].issues[] | select(.title == $title) | .display_id // .id] | unique | .[]' <<<"$issues")
  if [[ $(grep -c . <<<"$matches" || true) -gt 1 ]]; then
    printf "Error: several open issues are titled '%s' (%s); pass --issue.\n" "$title" "$(tr '\n' ' ' <<<"$matches" | sed 's/ $//')" >&2
    exit 1
  fi
  issue="$matches"
  if [[ -z "$issue" ]]; then
    created=$("$cli_dir/issue.sh" new --title "$title" --message "$message" --kind "$kind" --project "$repo_root" --json) || exit 1
    issue=$(jq -r '.display_id // .id' <<<"$created")
  fi
fi

"$cli_dir/work-unit.sh" activate --issue "$issue" --repo "$work_repo_id" --branch "$branch" >/dev/null || {
  printf 'Error: could not activate the work unit for issue %s on %s.\n' "$issue" "$branch" >&2
  exit 1
}

for pending_id in $(jq -r '.[].id' <<<"$same_delivery"); do
  withdraw_pending "$pending_id" "Replaced by a new delivery of the same branch." || {
    printf 'Error: could not withdraw pending auth request %s.\n' "${pending_id:0:8}" >&2
    exit 1
  }
done

request_args=("$branch" --title "$title" --closes-issue "$issue" --message "$message" --verification "$verification" --json)
[[ -z "$dirty_policy" ]] || request_args+=(--dirty-policy "$dirty_policy")
submitted=$("$cli_dir/auth-request.sh" "${request_args[@]}") || exit 1
request_id=$(jq -r '.request_id' <<<"$submitted")
revision=$(jq -r '.lifecycle_revision' <<<"$submitted")

# A request left pending by a refused, cancelled or interrupted approval is
# withdrawn, so the delivery leaves nothing behind and a rerun starts clean.
settle() {
  local result="$1" status
  status=$(request_state "$request_id" | jq -r '.status') || status=unknown
  if [[ "$status" == pending ]]; then
    withdraw_pending "$request_id" "The operator's approval did not complete." \
      || printf 'Error: auth request %s is still pending and could not be withdrawn.\n' "${request_id:0:8}" >&2
    exit "$result"
  fi
  printf 'Error: auth request %s was approved but did not complete (%s).\n' "${request_id:0:8}" "$status" >&2
  exit 1
}

approval_pid=""
interrupted() {
  trap - INT TERM
  [[ -z "$approval_pid" ]] || { kill -TERM "$approval_pid" 2>/dev/null || true; wait "$approval_pid" 2>/dev/null || true; }
  settle 130
}
trap interrupted INT TERM
"$cli_dir/auth-approve.sh" "$request_id" --revision "$revision" &
approval_pid=$!
approval=0
wait "$approval_pid" || approval=$?
trap - INT TERM
(( approval == 0 )) && exit 0
settle 1
