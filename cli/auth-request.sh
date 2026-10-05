#!/usr/bin/env bash
# mandible auth request: Submit an auth request to Mandible and poll until resolved.
# Combines submission + watching into a single command for use as a background task.
#
# Usage: {{command auth.request}}
#        {{command auth.request.command}}
#
# Required:
#   <branch>                Source branch (merge requests only)
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
#   The machine-owned "Verification:" section is inserted immediately before a
#   "Caveats:" heading when one is present, otherwise appended after the body.
#   Issue associations and closures are carried only in structured fields.
#   Authoring a "Verification:" heading or a "#"-leading line is an error.
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
#   --cwd <path>            Merge: protected worktree override. Other types: required execution directory
#   --target <branch>       Override auto-detected target/base branch (default: protected branch)
#   --depends-on <id>       Auth request ID that must complete before this one runs
#   --supersedes <id>       Atomically replace this exact pending request
#   --expected-revision <n> Required with --supersedes
#   --expected-custody-generation <n> Required with --supersedes
#   --drop-superseded-action <ordinal>:<reason>
#                           Explicitly dispose one staged predecessor action
#   --issue <id>            Issue ID to reference for context (repeatable; does not close)
#   --ref-issue <id>        Alias for --issue
#   --closes-issue <id>     Issue ID to close on successful merge (repeatable)
#   --promote-briefing <group> <expected-base> <proposal>
#                           After successful convergence, promote the exact
#                           active proposal to this Briefing group's Base
#   --command <command>     Exact shell command for a non-merge request; reviewed before execution
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

source "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd -P)/command-syntax.sh"
set -euo pipefail

# MANDIBLE_PORT and MANDIBLE_BASE are exported by the dispatcher
GIT_ENV_HELPER="${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/git-env.sh"
source "$GIT_ENV_HELPER"

API_HELPER="${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/api.sh"
source "$API_HELPER"

MANDIBLE_CLI_DIR="${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}"

# --- Usage ---

usage() {
  mandible_command_help auth request
}

# --- Argument parsing ---

branch=""
title=""
auth_type="merge"
command=""
command_set=0
base_branch=""
head_branch=""
target_repo_root=""
protected_root_dirty_action_json="null"
execution_mode="daemon"
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
supersedes_request_id=""
expected_revision=""
expected_custody_generation=""
SUPERSEDED_ACTION_DISPOSITIONS=()
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
space_publication_id=""
promote_briefing_group=""
promote_briefing_expected_base=""
promote_briefing_proposal=""

binding=$(mandible_bind_main_arguments "@auth request" '{"space_publication_id":{"option":"space-publication"},"title":{"option":"title"},"auth_type":{"option":"type"},"command":{"option":"command"},"command_set":{"option":"command","constant":"1"},"commit_message":{"option":"commit-message"},"change_message_text":{"option":"message"},"change_message_set":[{"option":"message","constant":"1"},{"option":"message-file","constant":"1"}],"change_message_file":{"option":"message-file"},"verification_text":{"option":"verification"},"diff_summary":{"option":"diff-summary"},"spec_content":{"option":"spec"},"spec_inline_set":{"option":"spec","constant":"1"},"spec_file":{"option":"spec-file"},"spec_file_set":{"option":"spec-file","constant":"1"},"post_merge_handoff":{"option":"handoff"},"dirty_policy":{"option":"dirty-policy"},"dirty_branch_prefix":{"option":"dirty-branch-prefix"},"depends_on_id":{"option":"depends-on"},"supersedes_request_id":{"option":"supersedes"},"expected_revision":{"option":"expected-revision"},"expected_custody_generation":{"option":"expected-custody-generation"},"SUPERSEDED_ACTION_DISPOSITIONS":{"option":"drop-superseded-action","array":true},"ISSUE_REFERENCES":{"option":["issue","ref-issue","references-issue"],"array":true},"ISSUE_CLOSURES":{"option":["closes-issue","close-issue"],"array":true},"promote_briefing_group":{"option":"promote-briefing","valueIndex":0},"promote_briefing_expected_base":{"option":"promote-briefing","valueIndex":1},"promote_briefing_proposal":{"option":"promote-briefing","valueIndex":2},"repo":{"option":"repo"},"cwd_override":{"option":"cwd"},"target_override":{"option":"target"},"timeout":{"option":"timeout"},"no_watch":{"option":"no-watch","constant":"1"},"force":{"option":["force","f"],"constant":"true"},"branch":{"position":0}}' "$@") || exit $?
eval "$binding"

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
if [[ "$auth_type" == *[[:space:]]* || " $valid_types " != *" $auth_type "* ]]; then
  echo "Error: invalid --type '$auth_type'. Must be one of: $valid_types" >&2
  exit 2
fi
if [[ -n "$promote_briefing_group" && "$auth_type" != "merge" ]]; then
  echo "Error: --promote-briefing requires --type merge" >&2
  exit 2
fi
if [[ "$auth_type" == "merge" ]]; then
  if [[ -z "$branch" ]]; then
    echo "Error: merge requests require a source branch" >&2
    exit 2
  fi
  if [[ $command_set -eq 1 ]]; then
    echo "Error: --command cannot override a merge; its command is derived from the reviewed branches" >&2
    exit 2
  fi
  if [[ "$branch" == integration/mandible-iab-preview-* ]]; then
    echo "Error: persistent IAB preview branches cannot be submitted for protected merge; create a disposable delivery branch at the exact reviewed preview HEAD." >&2
    exit 2
  fi
else
  if [[ -n "$branch" || -n "$target_override" || -n "$dirty_policy" || -n "$dirty_branch_prefix" || "$force" == "true" || $change_message_set -eq 1 || -n "$commit_message" || -n "$verification_text" || -n "$post_merge_handoff" || ${#ISSUE_CLOSURES[@]} -gt 0 ]]; then
    echo "Error: branches, merge messages, closure, handoff, and protected-root options require --type merge" >&2
    exit 2
  fi
  if [[ $command_set -ne 1 || -z "${command//[[:space:]]/}" ]]; then
    echo "Error: --type $auth_type requires an explicit non-empty --command; no operation is inferred" >&2
    exit 2
  fi
  if [[ -z "$cwd_override" || -z "$repo" ]]; then
    echo "Error: command requests require explicit --cwd and --repo execution context" >&2
    exit 2
  fi
fi
if [[ ${#SUPERSEDED_ACTION_DISPOSITIONS[@]} -gt 0 && -z "$supersedes_request_id" ]]; then
  echo "Error: --drop-superseded-action requires --supersedes" >&2
  exit 2
fi
if [[ -n "$supersedes_request_id" ]] && { [[ ! "$expected_revision" =~ ^[0-9]+$ ]] || [[ ! "$expected_custody_generation" =~ ^[0-9]+$ ]]; }; then
  echo "Error: --supersedes requires --expected-revision and --expected-custody-generation" >&2
  exit 2
fi
superseded_action_dispositions_json='[]'
for disposition in ${SUPERSEDED_ACTION_DISPOSITIONS[@]+"${SUPERSEDED_ACTION_DISPOSITIONS[@]}"}; do
  ordinal="${disposition%%:*}"
  disposition_reason="${disposition#*:}"
  if [[ "$ordinal" == "$disposition" || ! "$ordinal" =~ ^[1-9][0-9]*$ || -z "${disposition_reason//[[:space:]]/}" ]]; then
    echo "Error: --drop-superseded-action must be <positive-ordinal>:<reason>" >&2
    exit 2
  fi
  superseded_action_dispositions_json=$(jq -c \
    --argjson ordinal "$ordinal" --arg reason "$disposition_reason" \
    '. + [{ordinal: $ordinal, reason: $reason}]' <<<"$superseded_action_dispositions_json")
done

# Each preparer supplies command and execution context. Submission and watching
# below do not infer an operation from its label.
case "$auth_type" in
  merge)
    source "${MANDIBLE_CLI_DIR}/auth-request-merge.sh"
    prepare_merge_request
    ;;
  *)
    source "${MANDIBLE_CLI_DIR}/auth-request-command.sh"
    prepare_command_request
    ;;
esac

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
  --arg diff_summary "$diff_summary" \
  --arg commit_message "$commit_message" \
  --argjson canonical_message "$canonical_message" \
  --arg verification "$verification_text" \
  --arg spec_content "$spec_content" \
  --arg post_merge_handoff "$post_merge_handoff" \
  --arg depends_on_id "$depends_on_id" \
  --arg supersedes_request_id "$supersedes_request_id" \
  --arg expected_revision "$expected_revision" \
  --arg expected_custody_generation "$expected_custody_generation" \
  --argjson superseded_action_dispositions "$superseded_action_dispositions_json" \
  --arg session_id "$requester_session_id" \
  --arg target_session_id "$target_session_id" \
  --arg target_repo_root "$target_repo_root" \
  --arg conversation_id "$conversation_id" \
  --arg space_publication_id "$space_publication_id" \
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
    base_branch: (if $base_branch == "" then null else $base_branch end),
    head_branch: (if $head_branch == "" then null else $head_branch end),
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
    supersedes_request_id: (if $supersedes_request_id == "" then null else $supersedes_request_id end),
    expected_revision: (if $expected_revision == "" then null else ($expected_revision | tonumber) end),
    expected_custody_generation: (if $expected_custody_generation == "" then null else ($expected_custody_generation | tonumber) end),
    superseded_action_dispositions: $superseded_action_dispositions,
    session_id: (if $session_id == "" then null else $session_id end),
    target_session_id: (if $target_session_id == "" then null else $target_session_id end),
    target_repo_root: (if $target_repo_root == "" then null else $target_repo_root end),
    conversation_id: (if $conversation_id == "" then null else $conversation_id end),
    protected_root_dirty_action: $protected_root_dirty_action
  } + (if $space_publication_id == "" then {} else {space_publication_id:$space_publication_id} end)')

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
  echo "Error: submission could not be confirmed. This CLI did not execute the command; inspect the queue before retrying." >&2
  exit 1
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
    echo "No new request was created by this submission."
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
    echo "  Candidate bytes cannot be revised in place; use guarded supersession"
    echo "  so the daemon captures a new immutable change report."
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
  if [[ "$auth_type" == "merge" ]]; then
    echo "Branch: ${head_branch} -> ${base_branch}"
  else
    echo "Type: ${auth_type}"
  fi
  if [[ "$auth_type" == "merge" ]]; then
    files_changed=$(printf '%s' "$response" | jq -r '.files_changed // empty' 2>/dev/null || echo "")
    additions=$(printf '%s' "$response" | jq -r '.additions // empty' 2>/dev/null || echo "")
    deletions=$(printf '%s' "$response" | jq -r '.deletions // empty' 2>/dev/null || echo "")
    if [[ "$files_changed" =~ ^[0-9]+$ && "$additions" =~ ^[0-9]+$ && "$deletions" =~ ^[0-9]+$ ]]; then
      echo "Files: ${files_changed} changed, +${additions} -${deletions} (server-captured)"
    else
      echo "Files: server-captured (this daemon did not return headline counts)"
    fi
  fi
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
_mandible_sse_traced=0
case "$-" in *x*) _mandible_sse_traced=1; { set +x; } 2>/dev/null ;; esac
_mandible_sse_token="$(api_client_token POST)"
_mandible_sse_config=""
if [[ -n "$_mandible_sse_token" ]]; then
  _mandible_sse_config="$(api_temp_file)"
  printf 'header = "Authorization: Bearer %s"\n' "$_mandible_sse_token" > "$_mandible_sse_config"
fi
_mandible_sse_token=""
(( _mandible_sse_traced == 0 )) || set -x
_mandible_sse_curl_args=(-sN --max-time "$timeout" -X POST -H 'Content-Type: application/json' --data-binary '{"topics":["auth:"]}')
api_is_local_socket && _mandible_sse_curl_args+=(--unix-socket "$MANDIBLE_SOCKET")
[[ -z "$_mandible_sse_config" ]] || _mandible_sse_curl_args+=(--config "$_mandible_sse_config")
curl "${_mandible_sse_curl_args[@]}" \
  "$(api_base)/api/events/subscribe" 2>/dev/null | \
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
          rejected|withdrawn|superseded|expired|dismissed)
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
[[ -z "$_mandible_sse_config" ]] || rm -f "$_mandible_sse_config"
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
    rejected|withdrawn|superseded|expired|dismissed)
      error=$(printf '%s' "$final" | jq -r '.error // "none"')
      echo "Auth request $(api_short_id "$request_id"): ${status} -- ${error}"
      exit 1
      ;;
  esac
fi

echo "Auth request $(api_short_id "$request_id"): SSE connection lost, status unknown. Check dashboard." >&2
exit 1
