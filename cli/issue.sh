#!/usr/bin/env bash
source "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd -P)/command-syntax.sh"

set -u
set -o pipefail

GIT_ENV_HELPER="${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/git-env.sh"
source "$GIT_ENV_HELPER"

# Bug: fa1ac4c — CLI wrapper for manual issue operations.
# Ledger-era implementation: ordinary issue operations use the Mandible daemon API.

RESET=$'\033[0m'
RED=$'\033[31m'
GREEN=$'\033[32m'

API_HELPER="${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/api.sh"
source "$API_HELPER"
CLIENT_HELPER="${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/ledger-client.sh"
source "$CLIENT_HELPER"

err() {
  printf "%b\n" "$*" >&2
}

die() {
  err "$1"
  exit "${2:-1}"
}

RELATIONSHIP_TYPES=(
  parent_child
  blocks
  duplicate_of
  related
  references
  fixed_by
  caused_by
  implements
  tests
)
ACCEPTED_RELATIONSHIP_TYPES="parent_child, blocks, duplicate_of, related, references, fixed_by, caused_by, implements, tests"

ISSUE_KINDS=(bug feature umbrella maintenance experiment tracker unknown)
CREATABLE_ISSUE_KINDS=(bug feature umbrella maintenance experiment tracker)
ACCEPTED_ISSUE_KINDS="bug, feature, umbrella, maintenance, experiment, tracker, unknown"
ACCEPTED_CREATION_KINDS="bug, feature, umbrella, maintenance, experiment, tracker"
ISSUE_PRIORITIES=(low normal high urgent unknown)
ACCEPTED_ISSUE_PRIORITIES="low, normal, high, urgent, unknown"
ISSUE_CLOSE_RESOLUTIONS=(delivered duplicate wontfix)
ACCEPTED_ISSUE_CLOSE_RESOLUTIONS="delivered, duplicate, wontfix"

usage_link() {
  mandible_command_help issue link
}

usage_unlink() {
  mandible_command_help issue unlink
}

usage_checkpoint_add() {
  mandible_command_help issue checkpoint add
}

usage_checkpoint_show() {
  mandible_command_help issue checkpoint show
}

valid_relationship_type() {
  local candidate="$1"
  local accepted
  for accepted in "${RELATIONSHIP_TYPES[@]}"; do
    if [[ "$candidate" == "$accepted" ]]; then
      return 0
    fi
  done
  return 1
}

require_relationship_type() {
  local candidate="$1"
  if ! valid_relationship_type "$candidate"; then
    die "Invalid relationship type: ${candidate}. Accepted relationship types: ${ACCEPTED_RELATIONSHIP_TYPES}" 2
  fi
}

valid_issue_kind() {
  local candidate="$1"
  local accepted
  for accepted in "${ISSUE_KINDS[@]}"; do
    if [[ "$candidate" == "$accepted" ]]; then
      return 0
    fi
  done
  return 1
}

require_issue_kind() {
  local candidate="$1"
  if ! valid_issue_kind "$candidate"; then
    die "Invalid issue kind: ${candidate}. Accepted issue kinds: ${ACCEPTED_ISSUE_KINDS}" 2
  fi
}

require_creation_kind() {
  local candidate="$1"
  local accepted
  for accepted in "${CREATABLE_ISSUE_KINDS[@]}"; do
    if [[ "$candidate" == "$accepted" ]]; then
      return 0
    fi
  done
  die "Invalid creation kind: ${candidate}. New issues require one of: ${ACCEPTED_CREATION_KINDS}" 2
}

valid_issue_priority() {
  local candidate="$1"
  local accepted
  for accepted in "${ISSUE_PRIORITIES[@]}"; do
    if [[ "$candidate" == "$accepted" ]]; then
      return 0
    fi
  done
  return 1
}

require_issue_priority() {
  local candidate="$1"
  if ! valid_issue_priority "$candidate"; then
    die "Invalid issue priority: ${candidate}. Accepted priorities: ${ACCEPTED_ISSUE_PRIORITIES}" 2
  fi
}

valid_issue_close_resolution() {
  local candidate="$1"
  local accepted
  for accepted in "${ISSUE_CLOSE_RESOLUTIONS[@]}"; do
    if [[ "$candidate" == "$accepted" ]]; then
      return 0
    fi
  done
  return 1
}

require_issue_close_resolution() {
  local candidate="$1"
  if ! valid_issue_close_resolution "$candidate"; then
    die "Invalid issue resolution: ${candidate}. Accepted resolutions: ${ACCEPTED_ISSUE_CLOSE_RESOLUTIONS}" 2
  fi
}

die_api_status() {
  local message="$1"
  local status="$2"
  local response="$3"
  err "${RED}${message}${RESET}"
  if [[ -n "$status" ]]; then
    err "API status ${status}: ${response}"
  elif [[ -n "$response" ]]; then
    err "API response: ${response}"
  fi
  exit 1
}

usage() {
  mandible_command_help issue
}

require_tools() {
  command -v jq >/dev/null 2>&1 || die "jq not found." 1
  if ! api_is_file_rpc; then
    command -v curl >/dev/null 2>&1 || die "curl not found." 1
  fi
}

repo_root() {
  git rev-parse --show-toplevel 2>/dev/null || pwd
}

repo_ref() {
  local common_dir

  if common_dir=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) \
    && [[ -n "$common_dir" ]]; then
    case "$common_dir" in
      */.git)
        dirname "$common_dir"
        return
        ;;
      */.git/*)
        printf '%s\n' "${common_dir%%/.git/*}"
        return
        ;;
    esac
  fi

  repo_root
}

repo_filter_response() {
  local repo="$1"
  api_get "/api/issues?repo=$(urlencode "$repo")"
}

require_inferred_repo_ref() {
  local repo response
  repo="$(repo_ref)"
  response=$(repo_filter_response "$repo") \
    || die "${RED}Failed to resolve current repository scope${RESET}" 1
  if ! printf '%s\n' "$response" | jq -e 'length > 0' >/dev/null; then
    die "cwd does not resolve to a registered repo; pass --repo <path|id>" 1
  fi
  printf '%s\n' "$repo"
}

labels_json() {
  if (( $# == 0 )); then
    printf '[]'
    return
  fi
  printf '%s\n' "$@" | jq -R . | jq -s .
}

print_issue_detail() {
  api_jq_human '
    "\(.display_id) [\(.status)] \(.title)",
    "kind: \(.kind // "unknown")",
    "priority: \(.priority // "unknown")",
    "resolution: \(.resolution // "none")",
    (if (.labels | length) > 0 then "labels: \(.labels | join(", "))" else "labels:" end),
    (if ((.dependencies // []) | length) > 0 then
      "prerequisites:",
      ((.dependencies // [])[] | "- \(.display_id // .id) \(.title) [status=\(.status // "unknown"); resolution=\(.resolution // "none")]" + (if .status == "open" then " (open warning)" else "" end))
    else empty end),
    (if ((.work_notes // "") | length) > 0 then "", "working notes:", .work_notes else empty end),
    "",
    .body,
    (.comments[]? | "\n---\n\(.id | mandible_short_id) \(.author.display) \(.source)\n\(.body)")
  '
}

cmd_close() {
  local id=""
  local sha=""
  local resolution=""
  local commit_provided=0

  local binding
  binding=$(mandible_bind_arguments "issue.close" '{"sha":{"option":"commit"},"commit_provided":{"option":"commit","constant":"1"},"resolution":{"option":"resolution"},"id":{"position":0}}' "$@") || return $?
  eval "$binding"

  if [[ -z "$id" ]]; then
    die "Usage: $(mandible_command_syntax issue.close)" 2
  fi

  if [[ -z "$resolution" ]]; then
    die "Missing --resolution. Accepted resolutions: ${ACCEPTED_ISSUE_CLOSE_RESOLUTIONS}" 2
  fi
  require_issue_close_resolution "$resolution"
  if [[ "$resolution" != "delivered" && "$commit_provided" == "1" ]]; then
    die "--commit is only supported with --resolution delivered." 2
  fi

  require_tools
  local message_payload status_payload resolution_payload repo_id
  status_payload=$(jq -n --arg resolution "$resolution" '{status:"closed", resolution:$resolution}')
  api_send PATCH "/api/ledger/issues/$(urlencode "$id")" "$status_payload" >/dev/null \
    || die "${RED}Failed to close issue ${id}${RESET}" 1

  if [[ "$resolution" == "delivered" && "$commit_provided" == "1" && -n "$sha" && "$sha" != "unknown" ]]; then
    message_payload=$(jq -n --arg message "Resolved as delivered by commit ${sha:0:12}" '{message:$message}')
    api_send POST "/api/ledger/issues/$(urlencode "$id")/comments" "$message_payload" >/dev/null || true
    git notes append -m "closes: ${id:0:8}" "$sha" 2>/dev/null || true
    if ! git config --local push.notesRef >/dev/null 2>&1; then
      git config --local push.notesRef "refs/notes/commits" 2>/dev/null || true
    fi

    repo_id=$(basename "$(repo_root)")
    resolution_payload=$(jq -n --arg issue_id "$id" --arg commit_sha "$sha" --arg repo_id "$repo_id" \
      '{issue_id:$issue_id, commit_sha:$commit_sha, repo_id:$repo_id}')
    api_send POST "/api/issues/resolutions" "$resolution_payload" >/dev/null || true
  fi
  if [[ "$resolution" == "delivered" && "$commit_provided" == "1" && -n "$sha" && "$sha" != "unknown" ]]; then
    err "${GREEN}Closed issue ${id} as delivered (resolved by ${sha:0:12})${RESET}"
  else
    err "${GREEN}Closed issue ${id} as ${resolution}${RESET}"
  fi
}

cmd_comment_add() {
  local id=""
  local message=""
  local reopen=0

  local binding
  binding=$(mandible_bind_arguments "issue.comment.add" '{"reopen":{"option":"reopen","constant":"1"},"message":{"option":["m","message"]},"id":{"position":0}}' "$@") || return $?
  eval "$binding"

  if [[ -z "$id" || -z "$message" ]]; then
    die "Usage: $(mandible_command_syntax issue.comment.add)" 2
  fi

  require_tools
  local payload response
  payload=$(jq -n --arg message "$message" --arg reopen "$reopen" \
    '{message:$message} + (if $reopen == "1" then {reopen:true} else {} end)')
  response=$(api_send POST "/api/ledger/issues/$(urlencode "$id")/comments" "$payload") \
    || die "${RED}Failed to add comment to ${id}${RESET}" 1
  printf '%s\n' "$response" | api_jq_human '
    "comment \((((.comments // []) | sort_by(.created_at // 0) | last | .id) // "-") | mandible_short_id) issue_status=\(.status // "unknown")"
  '
}

cmd_comment_edit() {
  local comment_ref=""
  local message=""
  local base_revision_id=""
  local base_body_hash=""

  local binding
  binding=$(mandible_bind_arguments "issue.comment.edit" '{"message":{"option":["m","message"]},"base_revision_id":{"option":"base-revision"},"base_body_hash":{"option":"base-body-hash"},"comment_ref":{"position":0}}' "$@") || return $?
  eval "$binding"

  if [[ -z "$comment_ref" || -z "$message" ]]; then
    die "Usage: $(mandible_command_syntax issue.comment.edit)" 2
  fi

  require_tools
  local comment_id payload tmp_response status response
  comment_id=$(resolve_comment_ref "$comment_ref")
  payload=$(
    jq -n \
      --arg body "$message" \
      --arg base_revision_id "$base_revision_id" \
      --arg base_body_hash "$base_body_hash" \
      '{body: $body}
      + (if $base_revision_id == "" then {} else {base_body_revision_id: $base_revision_id} end)
      + (if $base_body_hash == "" then {} else {base_body_hash: $base_body_hash} end)'
  )
  tmp_response=$(mktemp)
  status=$(api_send_capture PATCH "/api/ledger/comments/$(urlencode "$comment_id")" "$payload" "$tmp_response")
  response=$(cat "$tmp_response")
  rm -f "$tmp_response"
  if [[ "$status" =~ ^2 ]]; then
    err "${GREEN}Edited comment ${comment_ref}${RESET}"
    return 0
  fi
  if [[ "$status" == "409" ]]; then
    printf '%s\n' "$response" | jq -r '"stale base conflict: \(.error // "base revision or hash does not match current comment")"' >&2
    return 3
  fi
  printf '%s\n' "$response" >&2
  die "${RED}Failed to edit comment ${comment_ref}${RESET}" 1
}

cmd_show() {
  local binding
  binding=$(mandible_bind_arguments "issue.show" '{"id":{"position":0}}' "$@") || return $?
  eval "$binding"

  if [[ -z "$id" ]]; then
    die "Usage: $(mandible_command_syntax issue.show)" 2
  fi

  require_tools
  api_get "/api/ledger/issues/$(urlencode "$id")" | print_issue_detail
}

cmd_report() {
  local id=""
  local json=0

  local binding
  binding=$(mandible_bind_arguments "issue.report" '{"json":{"option":"json","constant":"1"},"id":{"position":0}}' "$@") || return $?
  eval "$binding"

  if [[ -z "$id" ]]; then
    die "Usage: $(mandible_command_syntax issue.report)" 2
  fi

  require_tools
  if (( json )); then
    api_get "/api/ledger/issues/$(urlencode "$id")" | jq '{
      id,
      display_id,
      title,
      status,
      worker_status,
      resolution,
      labels,
      issue_branches,
      priority,
      kind,
      work_notes,
      work_notes_revision,
      dependencies,
      project,
      created_at,
      updated_at,
      closed_at,
      author,
      aliases,
      body,
      comments,
      relationships,
      work_units,
      sessions,
      auth_requests,
      timeline,
      conflicts
    }'
  else
    api_get "/api/ledger/issues/$(urlencode "$id")" | api_jq_human '
      def list_or_dash(xs): if (xs // []) | length == 0 then "-" else (xs | join(", ")) end;
      def short(s): (s // "" | gsub("\\s+"; " ") | if length > 180 then .[0:177] + "..." else . end);
      "\(.display_id) [\(.status)] \(.title)",
      "worker_status: \(.worker_status // "none")",
      "branches: \(list_or_dash((.issue_branches // []) | map(.branch + " (" + .role + ")")))",
      "labels: \(list_or_dash(.labels))",
      "kind: \(.kind // "unknown")",
      "prerequisites: \(list_or_dash((.dependencies // []) | map((.display_id // .id) + " " + .title + " [status=" + (.status // "unknown") + "; resolution=" + (.resolution // "none") + "]" + (if .status == "open" then " (open warning)" else "" end))))",
      "updated: \(.updated_at // "-")",
      "created: \(.created_at // "-")",
      "comments: \((.comments // []) | length)",
      "relationships: \((.relationships // []) | length)",
      "work_units: \((.work_units // []) | length)",
      "sessions: \((.sessions // []) | length)",
      "auth_requests: \((.auth_requests // []) | length)",
      "",
      "body:",
      (.body // ""),
      (if ((.work_notes // "") | length) > 0 then "", "working notes:", .work_notes else empty end),
      "",
      "latest comments:",
      (((.comments // []) | sort_by(.created_at // "") | reverse | .[0:5][])?
        | "- \((.id // "?") | mandible_short_id) \(.author.display // (.author.id | mandible_short_id) // "unknown") \(.created_at // ""): \(short(.body))")
    '
  fi
}

cmd_triage() {
  local status="open"
  local resolution=""
  local label=""
  local kind=""
  local priority=""
  local stale_days=""
  local limit=50
  local json=0
  local repo=""

  local binding
  binding=$(mandible_bind_arguments "issue.triage" '{"status":{"option":"status"},"resolution":{"option":"resolution"},"label":{"option":"label"},"kind":{"option":"kind"},"priority":{"option":"priority"},"repo":{"option":"repo"},"stale_days":{"option":"stale-days"},"limit":{"option":"limit"},"json":{"option":"json","constant":"1"}}' "$@") || return $?
  eval "$binding"

  case "$status" in
    open|closed|all) ;;
    *) die "Unknown status: $status (expected open, closed, or all; use --status closed --resolution delivered for delivered issues)" 2 ;;
  esac
  if [[ -n "$resolution" ]]; then require_issue_close_resolution "$resolution"; fi
  if [[ -n "$kind" ]]; then require_issue_kind "$kind"; fi
  if [[ -n "$priority" ]]; then require_issue_priority "$priority"; fi
  if [[ -n "$stale_days" && ! "$stale_days" =~ ^[0-9]+$ ]]; then
    die "--stale-days must be an integer" 2
  fi
  if [[ ! "$limit" =~ ^[0-9]+$ ]]; then
    die "--limit must be an integer" 2
  fi

  require_tools
  local root query inferred_repo
  if [[ -n "$repo" ]]; then
    root=$(urlencode "$repo")
  else
    inferred_repo=$(require_inferred_repo_ref) || exit $?
    root=$(urlencode "$inferred_repo")
  fi
  query="repo=${root}&status=$(urlencode "$status")"
  api_get "/api/issues?${query}" | jq \
    --arg label_filter "$label" \
    --arg resolution_filter "$resolution" \
    --arg kind_filter "$kind" \
    --arg priority_filter "$priority" \
    --arg stale_days "$stale_days" \
    --argjson limit "$limit" \
    --argjson json "$json" '
      def epoch($s):
        if ($s // "") == "" then 0
        else (($s | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601?) // 0)
        end;
      def stale_cutoff:
        if $stale_days == "" then null
        else (now - (($stale_days | tonumber) * 86400))
        end;
      [ .[] as $repo
        | $repo.issues[]
        | . + {repo_name: $repo.repo_name}
        | select($label_filter == "" or ((.labels // []) | index($label_filter)))
        | select($resolution_filter == "" or .resolution == $resolution_filter)
        | select($kind_filter == "" or .kind == $kind_filter)
        | select($priority_filter == "" or .priority == $priority_filter)
        | select((stale_cutoff == null) or (epoch(.updated_at) <= stale_cutoff))
      ]
      | sort_by(.updated_at // "")
      | .[0:$limit]
      | if $json then .
        else .[] | "\(.display_id // .short_id // .id)\t\(.status)\t\(.kind // "unknown")\t\(.priority // "unknown")\t\(.resolution // "-")\t\(.repo_name)\t\(.updated_at // "-")\t\((.labels // []) | join(","))\t\(.title)"
        end
    '
}

cmd_status() {
  local binding
  binding=$(mandible_bind_arguments "issue.status" '{"id":{"position":0},"worker_status":{"position":1}}' "$@") || return $?
  eval "$binding"

  if [[ -z "$id" || -z "$worker_status" ]]; then
    die "Usage: $(mandible_command_syntax issue.status)" 2
  fi

  require_tools
  local payload
  payload=$(jq -n --arg worker_status "$worker_status" '{worker_status:$worker_status}')
  api_send POST "/api/ledger/issues/$(urlencode "$id")/worker-status" "$payload" >/dev/null \
    || die "${RED}Failed to set worker status on ${id}${RESET}" 1
  err "${GREEN}Set worker status '${worker_status}' on ${id}${RESET}"
}

cmd_branch() {
  local action="${1:-}"
  shift || true

  case "$action" in
    add) cmd_branch_add "$@" ;;
    ""|-h|--help)
      cat <<'BRANCH_USAGE' | mandible_render_commands
Usage:
  {{command issue.branch.add}}
BRANCH_USAGE
      ;;
    *)
      die "Unknown branch action: $action (expected add)" 2
      ;;
  esac
}

cmd_branch_add() {
  local id=""
  local branch=""
  local role="primary"

  local binding
  binding=$(mandible_bind_arguments "issue.branch.add" '{"role":{"option":"role"},"id":{"position":0},"branch":{"position":1}}' "$@") || return $?
  eval "$binding"

  if [[ -z "$id" || -z "$branch" ]]; then
    die "Usage: $(mandible_command_syntax issue.branch.add)" 2
  fi
  case "$role" in
    primary|superseded) ;;
    *) die "Unknown branch role: $role" 2 ;;
  esac

  require_tools
  local payload
  payload=$(jq -n --arg branch "$branch" --arg role "$role" '{branch:$branch, role:$role}')
  api_send POST "/api/ledger/issues/$(urlencode "$id")/branches" "$payload" >/dev/null \
    || die "${RED}Failed to link branch '${branch}' to ${id}${RESET}" 1
  err "${GREEN}Linked branch '${branch}' to ${id} (${role})${RESET}"
}

cmd_link() {
  local source_ref=""
  local link_type="references"
  local note=""
  local -a targets=()

  local binding
  binding=$(mandible_bind_arguments "issue.link" '{"link_type":{"option":"type"},"note":{"option":"note"},"source_ref":{"position":0},"targets":{"rest":1}}' "$@") || return $?
  eval "$binding"

  if [[ -z "$source_ref" || ${#targets[@]} -eq 0 ]]; then
    usage_link >&2
    exit 2
  fi
  require_relationship_type "$link_type"

  require_tools
  local targets_json payload response status tmp_response
  targets_json=$(printf '%s\n' "${targets[@]}" | jq -R . | jq -s .)
  payload=$(jq -n \
    --arg source_ref "$source_ref" \
    --arg link_type "$link_type" \
    --arg note "$note" \
    --argjson target_refs "$targets_json" \
    '{source_ref:$source_ref, target_refs:$target_refs, link_type:$link_type}
     + (if $note == "" then {} else {note:$note} end)')
  tmp_response=$(mktemp)
  status=$(api_send_capture POST "/api/ledger/relationships" "$payload" "$tmp_response")
  response=$(cat "$tmp_response")
  rm -f "$tmp_response"
  if [[ ! "$status" =~ ^2 ]]; then
    die_api_status "Failed to link relationship(s) from ${source_ref}" "$status" "$response"
  fi
  printf '%s\n' "$response" | api_jq_human '"linked \(.edges | length) relationship(s) action_id=\(.action_id | mandible_short_id)"'
}

cmd_unlink() {
  local source_ref=""
  local link_type="references"
  local -a targets=()

  local binding
  binding=$(mandible_bind_arguments "issue.unlink" '{"link_type":{"option":"type"},"source_ref":{"position":0},"targets":{"rest":1}}' "$@") || return $?
  eval "$binding"

  if [[ -z "$source_ref" || ${#targets[@]} -eq 0 ]]; then
    usage_unlink >&2
    exit 2
  fi
  require_relationship_type "$link_type"

  require_tools
  local targets_json payload response status tmp_response
  targets_json=$(printf '%s\n' "${targets[@]}" | jq -R . | jq -s .)
  payload=$(jq -n \
    --arg source_ref "$source_ref" \
    --arg link_type "$link_type" \
    --argjson target_refs "$targets_json" \
    '{source_ref:$source_ref, target_refs:$target_refs, link_type:$link_type}')
  tmp_response=$(mktemp)
  status=$(api_send_capture POST "/api/ledger/relationships/unlink" "$payload" "$tmp_response")
  response=$(cat "$tmp_response")
  rm -f "$tmp_response"
  if [[ ! "$status" =~ ^2 ]]; then
    die_api_status "Failed to unlink relationship(s) from ${source_ref}" "$status" "$response"
  fi
  printf '%s\n' "$response" | api_jq_human '"unlinked \(.edges | length) relationship(s) action_id=\(.action_id | mandible_short_id)"'
}

print_issue_heads() {
  local json="$1"
  local file="$2"

  if (( json )); then
    jq -s '.' "$file"
  else
    jq -r '
      "issue\tdigest\tsubtree_digest\tlast_event_at\tlast_event_kind",
      (.[] | "\(.short_id)\t\(.digest)\t\(.subtree_digest // "-")\t\(.last_event_at // "-")\t\(.last_event_kind // "-")")
    ' "$file"
  fi
}

cmd_heads() {
  local json=0
  local -a ids=()

  local binding
  binding=$(mandible_bind_arguments "issue.heads" '{"json":{"option":"json","constant":"1"},"ids":{"rest":0}}' "$@") || return $?
  eval "$binding"

  if (( ${#ids[@]} == 0 )); then
    die "Usage: $(mandible_command_syntax issue.heads)" 2
  fi

  require_tools
  local tmp response id
  tmp=$(mktemp)
  for id in "${ids[@]}"; do
    response=$(api_get "/api/ledger/issues/$(urlencode "$id")/head") \
      || die "${RED}Failed to fetch issue head for ${id}${RESET}" 1
    printf '%s\n' "$response" >> "$tmp"
  done
  print_issue_heads "$json" "$tmp"
  rm -f "$tmp"
}

print_changed_result() {
  local json="$1"
  local changed_file="$2"
  local subtree_changed_file="$3"
  local unchanged_file="$4"
  local unknown_file="$5"
  local missing_file="$6"

  if (( json )); then
    jq -n \
      --slurpfile changed "$changed_file" \
      --slurpfile subtree_changed "$subtree_changed_file" \
      --slurpfile unchanged "$unchanged_file" \
      --slurpfile unknown "$unknown_file" \
      --slurpfile missing "$missing_file" \
      '{
        changed: $changed,
        subtree_changed: $subtree_changed,
        unchanged: $unchanged,
        unknown: $unknown,
        missing: $missing
      }'
  else
    jq -n -r \
      --slurpfile changed "$changed_file" \
      --slurpfile subtree_changed "$subtree_changed_file" \
      --slurpfile unchanged "$unchanged_file" \
      --slurpfile unknown "$unknown_file" \
      --slurpfile missing "$missing_file" '
        "changed:",
        (if ($changed | length) == 0 then "  -" else ($changed[] | "  \(.issue)\t\(.expected_digest // "null") -> \(.current_digest)\t\(.last_event_kind // "-")") end),
        "subtree_changed:",
        (if ($subtree_changed | length) == 0 then "  -" else ($subtree_changed[] | "  \(.issue)\t\(.expected_subtree_digest // "null") -> \(.current_subtree_digest)\t\(.subtree_last_event_kind // "-")") end),
        "unchanged:",
        (if ($unchanged | length) == 0 then "  -" else ($unchanged[] | "  \(.issue)\t\(.current_digest)") end),
        "unknown:",
        (if ($unknown | length) == 0 then "  -" else ($unknown[] | "  \(.issue)\t\(.current_digest)\t(no baseline subtree digest)") end),
        "missing:",
        (if ($missing | length) == 0 then "  -" else ($missing[] | "  \(.issue)") end)
      '
  fi
}

cmd_changed() {
  local manifest=""
  local since_issue=""
  local kind="delegation-manifest"
  local checkpoint_ref=""
  local json=0

  local binding
  binding=$(mandible_bind_arguments "issue.changed" '{"manifest":{"option":"since-manifest"},"since_issue":{"option":"since-issue"},"kind":{"option":"kind"},"checkpoint_ref":{"option":"checkpoint"},"json":{"option":"json","constant":"1"}}' "$@") || return $?
  eval "$binding"

  if [[ -n "$manifest" && -n "$since_issue" ]]; then
    die "Use only one of --since-manifest or --since-issue." 2
  fi
  if [[ -n "$checkpoint_ref" && -z "$since_issue" ]]; then
    die "--checkpoint requires --since-issue." 2
  fi
  if [[ -z "$manifest" && -z "$since_issue" ]]; then
    die "Usage: $(mandible_command_syntax issue.changed)" 2
  fi

  require_tools
  local checkpoint_tmp=""
  if [[ -n "$since_issue" ]]; then
    local checkpoint_path checkpoint_response checkpoint_list_response checkpoint_created_at checkpoint_id
    if [[ -n "$checkpoint_ref" ]]; then
      checkpoint_path="/api/ledger/issues/$(urlencode "$since_issue")/checkpoints"
      if [[ -n "$kind" ]]; then
        checkpoint_path="${checkpoint_path}?kind=$(urlencode "$kind")"
      fi
      checkpoint_list_response=$(api_get "$checkpoint_path") \
        || die "${RED}Failed to fetch checkpoints for ${since_issue}${RESET}" 1
      checkpoint_response=$(printf '%s\n' "$checkpoint_list_response" \
        | jq -e --arg id "$checkpoint_ref" '.checkpoints[] | select(.id == $id)') \
        || die "Checkpoint not found on ${since_issue}: ${checkpoint_ref}" 2
    else
      checkpoint_path="/api/ledger/issues/$(urlencode "$since_issue")/checkpoints?latest=true"
      if [[ -n "$kind" ]]; then
        checkpoint_path="${checkpoint_path}&kind=$(urlencode "$kind")"
      fi
      checkpoint_response=$(api_get "$checkpoint_path") \
        || die "${RED}Failed to fetch checkpoint for ${since_issue}${RESET}" 1
    fi
    checkpoint_tmp=$(mktemp)
    printf '%s\n' "$checkpoint_response" | jq -e '.payload | type == "array"' >/dev/null \
      || die "Checkpoint payload must be a manifest JSON array." 2
    checkpoint_created_at=$(printf '%s\n' "$checkpoint_response" | jq -r '.created_at // empty')
    [[ -n "$checkpoint_created_at" ]] \
      || die "Checkpoint response must include created_at to compare the umbrella head." 2
    checkpoint_id=$(printf '%s\n' "$checkpoint_response" | jq -r '.id // empty')
    [[ -n "$checkpoint_id" ]] \
      || die "Checkpoint response must include id to compare the umbrella head." 2
    # Baseline for the umbrella's own (self) entry:
    #
    # Post-upgrade checkpoints (written by refreshDelegationManifest since
    # subtree digests landed) store the umbrella's own head in the payload as an
    # explicit self-baseline entry marked `"self": true`. When that entry is
    # present -- or any payload entry otherwise matches the umbrella's ids --
    # the stored digests are compared directly and nothing is synthesized here.
    # This makes pre-upgrade detection explicit rather than inferred: a
    # post-upgrade ZERO-CHILD checkpoint still carries its self entry, so a
    # stable umbrella correctly classifies "unchanged" instead of being
    # misdetected as pre-upgrade by an empty child list.
    #
    # Legacy checkpoints (no self entry) predate the stored baseline. For those
    # we synthesize a self entry whose own-digest baseline is reconstructed from
    # /head?at=<checkpoint-time> (`at` filters events by occurred_at <= at, so
    # the reconstruction reflects the umbrella's state at checkpoint time), but
    # whose subtree baseline is null: the checkpoint never observed a subtree
    # digest, so subtree drift is indeterminate and the self entry classifies
    # "unknown", never silently "unchanged".
    local issue_head_at_checkpoint
    issue_head_at_checkpoint=$(api_get "/api/ledger/issues/$(urlencode "$since_issue")/head?at=$(urlencode "$checkpoint_created_at")") \
      || die "${RED}Failed to fetch historical head for ${since_issue}${RESET}" 1
    printf '%s\n' "$checkpoint_response" | jq \
      --arg issue "$since_issue" \
      --arg issue_id "$(printf '%s\n' "$issue_head_at_checkpoint" | jq -r '.issue_id')" \
      --arg short_id "$(printf '%s\n' "$issue_head_at_checkpoint" | jq -r '.short_id')" \
      --arg digest "$(printf '%s\n' "$issue_head_at_checkpoint" | jq -r '.digest')" \
      '
        .payload as $payload
        | if $payload | any(
            (.self == true)
            or ((.issue // .short_id // .id // "") as $entry
              | $entry == $issue or $entry == $issue_id or $entry == $short_id))
          then $payload
          else $payload + [{
            issue: $issue,
            short_id: $short_id,
            id: $issue_id,
            digest: $digest,
            subtree_digest: null
          }]
          end
      ' > "$checkpoint_tmp"
    manifest="$checkpoint_tmp"
  fi
  if [[ ! -f "$manifest" ]]; then
    die "Manifest not found: $manifest" 2
  fi
  jq -e 'type == "array"' "$manifest" >/dev/null \
    || die "Manifest must be a JSON array." 2

  local tmpdir changed_file subtree_changed_file unchanged_file unknown_file missing_file
  tmpdir=$(mktemp -d)
  changed_file="$tmpdir/changed.jsonl"
  subtree_changed_file="$tmpdir/subtree_changed.jsonl"
  unchanged_file="$tmpdir/unchanged.jsonl"
  unknown_file="$tmpdir/unknown.jsonl"
  missing_file="$tmpdir/missing.jsonl"
  : > "$changed_file"
  : > "$subtree_changed_file"
  : > "$unchanged_file"
  : > "$unknown_file"
  : > "$missing_file"

  # Classify each manifest entry against the current head:
  #   changed         - the entry's own digest drifted
  #   subtree_changed - own digest stable, subtree digest drifted
  #   unchanged       - own and subtree digests both stable
  #   unknown         - own digest stable but the manifest predates subtree
  #                     digests, so subtree drift cannot be determined
  # An empty expected subtree digest (pre-upgrade manifest) never falls through
  # to "unchanged"; it is reported as "unknown".
  local issue expected expected_subtree self_entry response current current_subtree
  local classification subtree_state target_file head_ok
  while IFS=$'\t' read -r issue expected self_entry expected_subtree; do
    if [[ -z "$issue" ]]; then
      rm -rf "$tmpdir"
      die "Manifest entries must include issue, short_id, or id." 2
    fi
    # A post-upgrade self entry snapshots the umbrella immediately before its
    # own manifest checkpoint is written. Exclude only that exact establishing
    # checkpoint while comparing the pinned baseline. Normal head reads still
    # include it, and all later umbrella and descendant events remain visible.
    if [[ -n "$since_issue" && "$self_entry" == "true" ]]; then
      if response=$(api_get "/api/ledger/issues/$(urlencode "$issue")/head?exclude_checkpoint=$(urlencode "$checkpoint_id")"); then
        head_ok=true
      else
        head_ok=false
      fi
    elif response=$(api_get "/api/ledger/issues/$(urlencode "$issue")/head"); then
      head_ok=true
    else
      head_ok=false
    fi
    if [[ "$head_ok" == "true" ]]; then
      current=$(printf '%s\n' "$response" | jq -r '.digest')
      current_subtree=$(printf '%s\n' "$response" | jq -r '.subtree_digest // ""')
      if [[ "$expected" != "$current" ]]; then
        classification="changed"
        subtree_state="changed"
        target_file="$changed_file"
      elif [[ -z "$expected_subtree" ]]; then
        classification="unknown"
        subtree_state="unknown"
        target_file="$unknown_file"
      elif [[ "$expected_subtree" != "$current_subtree" ]]; then
        classification="subtree_changed"
        subtree_state="changed"
        target_file="$subtree_changed_file"
      else
        classification="unchanged"
        subtree_state="unchanged"
        target_file="$unchanged_file"
      fi
      jq -n \
        --arg issue "$issue" \
        --arg expected "$expected" \
        --arg expected_subtree "$expected_subtree" \
        --arg classification "$classification" \
        --arg subtree_state "$subtree_state" \
        --argjson head "$response" \
        '{
          issue: $issue,
          classification: $classification,
          subtree_state: $subtree_state,
          expected_digest: (if $expected == "" then null else $expected end),
          current_digest: $head.digest,
          expected_subtree_digest: (if $expected_subtree == "" then null else $expected_subtree end),
          current_subtree_digest: $head.subtree_digest,
          last_event_at: $head.last_event_at,
          last_event_kind: $head.last_event_kind,
          subtree_last_event_at: $head.subtree_last_event_at,
          subtree_last_event_kind: $head.subtree_last_event_kind,
          head: $head
        }' >> "$target_file"
    else
      jq -n --arg issue "$issue" '{issue: $issue}' >> "$missing_file"
    fi
  done < <(jq -r '.[] | [(.issue // .short_id // .id // ""), (.digest // ""), (.self == true), (.subtree_digest // "")] | @tsv' "$manifest")

  print_changed_result "$json" "$changed_file" "$subtree_changed_file" "$unchanged_file" "$unknown_file" "$missing_file"
  rm -rf "$tmpdir"
  if [[ -n "$checkpoint_tmp" ]]; then
    rm -f "$checkpoint_tmp"
  fi
}

cmd_checkpoint() {
  local action="${1:-}"
  shift || true

  case "$action" in
    add)
      local id=""
      local kind=""
      local payload_inline=""
      local payload_file=""

      local binding
      binding=$(mandible_bind_arguments "issue.checkpoint.add" '{"kind":{"option":"kind"},"payload_inline":{"option":"payload"},"payload_file":{"option":"payload-file"},"id":{"position":0}}' "$@") || return $?
      eval "$binding"

      if [[ -z "$id" || -z "$kind" ]]; then
        usage_checkpoint_add >&2
        exit 2
      fi
      if [[ -n "$payload_inline" && -n "$payload_file" ]]; then
        die "Use only one of --payload or --payload-file." 2
      fi

      require_tools
      local payload
      if [[ -n "$payload_inline" ]]; then
        if [[ "$payload_inline" == "-" ]]; then
          payload=$(jq -c '.')
        else
          payload=$(printf '%s\n' "$payload_inline" | jq -c '.')
        fi
      elif [[ -z "$payload_file" ]]; then
        payload='{}'
      elif [[ "$payload_file" == "-" ]]; then
        payload=$(jq -c '.')
      else
        [[ -f "$payload_file" ]] || die "Payload file not found: $payload_file" 2
        payload=$(jq -c '.' "$payload_file")
      fi

      local request response
      request=$(jq -n --arg kind "$kind" --argjson payload "$payload" '{kind:$kind, payload:$payload}')
      response=$(api_send POST "/api/ledger/issues/$(urlencode "$id")/checkpoints" "$request") \
        || die "${RED}Failed to add checkpoint for ${id}${RESET}" 1
      printf '%s\n' "$response" | api_jq_human '"checkpoint \(.id | mandible_short_id) \(.kind) \(.created_at)"'
      ;;
    show)
      local id=""
      local kind=""
      local latest=1
      local json=0

      local binding
      binding=$(mandible_bind_arguments "issue.checkpoint.show" '{"kind":{"option":"kind"},"latest":[{"option":"latest","constant":"1"},{"option":"all","constant":"0"}],"json":{"option":"json","constant":"1"},"id":{"position":0}}' "$@") || return $?
      eval "$binding"

      if [[ -z "$id" || -z "$kind" ]]; then
        usage_checkpoint_show >&2
        exit 2
      fi

      require_tools
      local path response
      path="/api/ledger/issues/$(urlencode "$id")/checkpoints?kind=$(urlencode "$kind")"
      if (( latest )); then
        path="${path}&latest=true"
      fi
      response=$(api_get "$path") \
        || die "${RED}Failed to fetch checkpoints for ${id}${RESET}" 1
      if (( json )); then
        printf '%s\n' "$response" | jq '.'
      elif (( latest )); then
        printf '%s\n' "$response" | api_jq_human '
          "checkpoint \(.id | mandible_short_id) \(.kind)",
          "created_at: \(.created_at)",
          "payload:",
          (.payload | tojson)
        '
      else
        printf '%s\n' "$response" | api_jq_human '
          .checkpoints[]? |
          "checkpoint \(.id | mandible_short_id) \(.kind)\t\(.created_at)\t\(.payload | tojson)"
        '
      fi
      ;;
    ""|-h|--help)
      cat <<'CHECKPOINT_USAGE' | mandible_render_commands
Usage:
  {{command issue.checkpoint.add}}
  {{command issue.checkpoint.show}}
CHECKPOINT_USAGE
      ;;
    *)
      die "Unknown checkpoint action: $action (expected add or show)" 2
      ;;
  esac
}

cmd_new() {
  local title=""
  local body=""
  local kind=""
  local -a labels=()
  local project_ref=""

  local binding
  binding=$(mandible_bind_arguments "issue.new" '{"title":{"option":["t","title"]},"body":{"option":["m","message"]},"kind":{"option":"kind"},"labels":{"option":"label","array":true},"project_ref":{"option":"project"}}' "$@") || return $?
  eval "$binding"

  if [[ -z "$title" || -z "$body" || -z "$kind" ]]; then
    die "Usage: $(mandible_command_syntax issue.new)" 2
  fi
  require_creation_kind "$kind"

  require_tools
  local root payload id label_json repo
  root=$(repo_root)
  label_json=$(labels_json "${labels[@]+"${labels[@]}"}")
  if [[ -n "$project_ref" ]]; then
    repo="$project_ref"
    payload=$(jq -n \
      --arg title "$title" --arg body "$body" --arg root "$root" \
      --argjson labels "$label_json" --arg project "$project_ref" \
      --arg kind "$kind" \
      '{title:$title, body:$body, root:$root, labels:$labels, project:$project}
       + (if $kind == "" then {} else {kind:$kind} end)')
  else
    repo=$(basename "$root")
    payload=$(jq -n \
      --arg title "$title" --arg body "$body" --arg root "$root" --argjson labels "$label_json" \
      --arg kind "$kind" \
      '{title:$title, body:$body, root:$root, labels:$labels}
       + (if $kind == "" then {} else {kind:$kind} end)')
  fi
  id=$(api_send POST "/api/issues/$(urlencode "$repo")" "$payload" | jq -r '.display_id // .id') \
    || die "${RED}Failed to create issue${RESET}" 1
  err "${GREEN}Created issue ${id}${RESET}"
}

cmd_list() {
  local status="open"
  local repo=""

  local binding
  binding=$(mandible_bind_arguments "issue.list" '{"status":{"option":"status"},"repo":{"option":"repo"}}' "$@") || return $?
  eval "$binding"

  case "$status" in
    open|closed|all) ;;
    *) die "Unknown status: $status (expected open, closed, or all; use --status closed for delivered issues and inspect resolution with triage)" 2 ;;
  esac

  require_tools
  local root query inferred_repo
  if [[ -n "$repo" ]]; then
    root=$(urlencode "$repo")
  else
    inferred_repo=$(require_inferred_repo_ref) || exit $?
    root=$(urlencode "$inferred_repo")
  fi
  query="repo=${root}&status=$(urlencode "$status")"
  api_get "/api/issues?${query}" | api_jq_human '.[] as $repo | $repo.issues[] | "\(mandible_display_id)\t\(.status)\t\($repo.repo_name)\t\(.title)"'
}

cmd_parent_role() {
  local action="${1:-}"
  shift || true

  case "$action" in
    status) cmd_parent_role_status "$@" ;;
    assume) cmd_parent_role_assume "$@" ;;
    ""|-h|--help)
      mandible_command_help issue parent-role
      ;;
    *)
      die "Unknown parent-role action: $action (expected status or assume)" 2
      ;;
  esac
}

cmd_parent_role_status() {
  local issue_ref=""
  local json=0
  local binding
  binding=$(mandible_bind_arguments "issue.parent-role.status" '{"json":{"option":"json","constant":"1"},"issue_ref":{"position":0}}' "$@") || return $?
  eval "$binding"
  if [[ -z "$issue_ref" ]]; then
    die "Usage: $(mandible_command_syntax issue.parent-role.status)" 2
  fi
  require_tools
  local response
  response=$(api_get "/api/ledger/issues/$(urlencode "$issue_ref")/parent-role") \
    || die "${RED}Failed to fetch parent-role status for ${issue_ref}${RESET}" 1
  if (( json )); then
    printf '%s\n' "$response" | jq '.'
  else
    printf '%s\n' "$response" | api_jq_human '
      if .live_holder then
        "live holder: \((.live_holder.session_id // "-") | mandible_short_id) (\(.live_holder.mechanism // "-"))"
      elif .holder then
        "stale holder: \((.holder.session_id // "-") | mandible_short_id) (\(.holder.mechanism // "-"))"
      else
        "no parent-role holder"
      end
    '
  fi
}

cmd_parent_role_assume() {
  local issue_ref=""
  local session_id="${MANDIBLE_SESSION_ID:-${CODEX_SESSION_ID:-}}"
  local mechanism="codex"
  local override=0
  local json=0
  local binding
  binding=$(mandible_bind_arguments "issue.parent-role.assume" '{"session_id":{"option":"session"},"mechanism":{"option":"mechanism"},"override":{"option":"override","constant":"1"},"json":{"option":"json","constant":"1"},"issue_ref":{"position":0}}' "$@") || return $?
  eval "$binding"
  if [[ -z "$issue_ref" ]]; then
    die "Usage: $(mandible_command_syntax issue.parent-role.assume)" 2
  fi
  if [[ -z "$session_id" ]]; then
    die "Missing parent-role session id. Pass --session <id>, or set MANDIBLE_SESSION_ID or CODEX_SESSION_ID for auto-detection." 2
  fi
  require_tools
  local payload tmp_response status response
  payload=$(jq -n \
    --arg session_id "$session_id" \
    --arg mechanism "$mechanism" \
    --arg override "$override" \
    '{session_id:$session_id, mechanism:$mechanism, override:($override == "1")}')
  tmp_response=$(mktemp)
  status=$(api_send_capture POST "/api/ledger/issues/$(urlencode "$issue_ref")/parent-role" "$payload" "$tmp_response")
  response=$(cat "$tmp_response")
  rm -f "$tmp_response"
  if [[ "$status" =~ ^2 ]]; then
    if (( json )); then
      printf '%s\n' "$response" | jq '.'
    else
      printf '%s\n' "$response" | api_jq_human '"parent-role assumed checkpoint=\(.checkpoint.id | mandible_short_id) holder=\(.parent_role.holder.payload.session_id | mandible_short_id)"'
    fi
    return 0
  fi
  # Only a response that actually carries a holder is a holder conflict. Other
  # 409s on this route (and the 400 for an unregistered session id) carry their
  # own `error` and must be shown as themselves, not rendered as a phantom
  # "live parent-role holder exists: - (-)" (issue 7a97e2c).
  if [[ "$status" == "409" ]] && printf '%s\n' "$response" | jq -e '.live_holder != null' >/dev/null 2>&1; then
    printf '%s\n' "$response" | api_jq_human '"live parent-role holder exists: \((.live_holder.session_id // "-") | mandible_short_id) (\(.live_holder.mechanism // "-")); rerun with --override to retake"' >&2
    return 3
  fi
  local rendered
  rendered=$(printf '%s\n' "$response" \
    | jq -r 'if type == "object" and (.error | type) == "string" then .error else . end' 2>/dev/null) \
    || rendered="$response"
  printf '%s\n' "$rendered" >&2
  return 1
}

cmd_label() {
  if (( $# < 1 )); then
    mandible_command_help issue label
    exit 2
  fi

  local action="$1"
  shift

  case "$action" in
    add) cmd_label_set true "$@" ;;
    rm)  cmd_label_set false "$@" ;;
    *)   die "Unknown label action: $action (expected add or rm)" 2 ;;
  esac
}

cmd_label_set() {
  local present="$1"
  shift
  local action=rm binding id="" label=""
  [[ "$present" != true ]] || action=add
  binding=$(mandible_bind_arguments "issue.label.$action" '{"id":{"position":0},"label":{"position":1}}' "$@") || return $?
  eval "$binding"
  local payload
  require_tools
  payload=$(jq -n --arg label "$label" --argjson present "$present" '{"label":$label, present:$present}')
  api_send POST "/api/ledger/issues/$(urlencode "$id")/labels" "$payload" >/dev/null \
    || die "${RED}Failed to update label '${label}' on ${id}${RESET}" 1
  if [[ "$present" == "true" ]]; then
    err "${GREEN}Added label '${label}' to ${id}${RESET}"
  else
    err "${GREEN}Removed label '${label}' from ${id}${RESET}"
  fi
}

cmd_open() {
  local binding
  binding=$(mandible_bind_arguments "issue.open" '{"id":{"position":0}}' "$@") || return $?
  eval "$binding"

  if [[ -z "$id" ]]; then
    die "Usage: $(mandible_command_syntax issue.open)" 2
  fi

  require_tools
  api_send PATCH "/api/ledger/issues/$(urlencode "$id")" '{"status":"open","resolution":null}' >/dev/null \
    || die "${RED}Failed to reopen issue ${id}${RESET}" 1
  err "${GREEN}Reopened issue ${id}${RESET}"
}

print_revision_history() {
  local with_body="$1"
  local subject="${2:-body}"
  api_jq_human '
    def timestamp:
      ((.occurred_at // .observed_at // 0) / 1000 | todateiso8601);
    def actor:
      (.actor_id // .actor_type // "-");
    def short_hash:
      ((.new_hash // "")[0:12]);
    .revisions as $revisions
    | if ($revisions | length) == 0 then
        ("No " + $subject + " revisions.")
      else
        "rev\tid\treason\tsource\toccurred\tactor\thash",
        ($revisions[]
          | "#\(.revision_no)\t\(.id | mandible_short_id)\t\(.reason)\t\(.source)\t\(timestamp)\t\(actor | mandible_short_id)\t\(short_hash)",
            (if $with_body == "1" then
              ("----- " + $subject + " #\(.revision_no) -----\n\(.snapshot_body)\n----- end " + $subject + " #\(.revision_no) -----")
            else empty end))
      end
  ' --arg with_body "$with_body" --arg subject "$subject"
}

cmd_description_show() {
  local issue_ref=""
  local json=0

  local binding
  binding=$(mandible_bind_arguments "issue.description.show" '{"json":{"option":"json","constant":"1"},"issue_ref":{"position":0}}' "$@") || return $?
  eval "$binding"

  if [[ -z "$issue_ref" ]]; then
    die "Usage: $(mandible_command_syntax issue.description.show)" 2
  fi

  require_tools
  local response
  response=$(api_get "/api/ledger/issues/$(urlencode "$issue_ref")") \
    || die "${RED}Failed to fetch issue ${issue_ref}${RESET}" 1
  if (( json )); then
    printf '%s\n' "$response" | jq '{issue_id: .id, display_id, title, description: .body, updated_at}'
  else
    printf '%s\n' "$response" | jq -r '.body // ""'
  fi
}

cmd_description_history() {
  local issue_ref=""
  local json=0
  local with_body=0

  local binding
  binding=$(mandible_bind_arguments "issue.description.history" '{"json":{"option":"json","constant":"1"},"with_body":{"option":"with-body","constant":"1"},"issue_ref":{"position":0}}' "$@") || return $?
  eval "$binding"

  if [[ -z "$issue_ref" ]]; then
    die "Usage: $(mandible_command_syntax issue.description.history)" 2
  fi

  require_tools
  local response
  response=$(api_get "/api/ledger/issues/$(urlencode "$issue_ref")/body/revisions") \
    || die "${RED}Failed to fetch body revisions for issue ${issue_ref}${RESET}" 1
  if (( json )); then
    printf '%s\n' "$response" | jq '.'
  else
    printf '%s\n' "$response" | print_revision_history "$with_body"
  fi
}

cmd_description_edit() {
  local issue_ref=""
  local message=""
  local base_revision_id=""
  local base_body_hash=""

  local binding
  binding=$(mandible_bind_arguments "issue.description.edit" '{"message":{"option":["m","message"]},"base_revision_id":{"option":"base-revision"},"base_body_hash":{"option":"base-body-hash"},"issue_ref":{"position":0}}' "$@") || return $?
  eval "$binding"

  if [[ -z "$issue_ref" || -z "$message" ]]; then
    die "Usage: $(mandible_command_syntax issue.description.edit)" 2
  fi

  require_tools
  local payload
  payload=$(
    jq -n \
      --arg body "$message" \
      --arg base_revision_id "$base_revision_id" \
      --arg base_body_hash "$base_body_hash" \
      '{
        body: $body
      }
      + (if $base_revision_id == "" then {} else {base_body_revision_id: $base_revision_id} end)
      + (if $base_body_hash == "" then {} else {base_body_hash: $base_body_hash} end)'
  )
  api_send PATCH "/api/ledger/issues/$(urlencode "$issue_ref")" "$payload" >/dev/null \
    || die "${RED}Failed to edit description for issue ${issue_ref}${RESET}" 1
  err "${GREEN}Edited description for ${issue_ref}${RESET}"
}

cmd_description() {
  local action="${1:-}"
  shift || true

  case "$action" in
    show) cmd_description_show "$@" ;;
    edit) cmd_description_edit "$@" ;;
    history) cmd_description_history "$@" ;;
    ""|-h|--help)
      cat <<'DESCRIPTION_USAGE' | mandible_render_commands
Usage:
  mandible issue description show <issue-ref> [--json]
  {{command issue.description.edit}}
  mandible issue description history <issue-ref> [--json] [--with-body]
DESCRIPTION_USAGE
      ;;
    *)
      die "Unknown description action: $action (expected show, edit, or history)" 2
      ;;
  esac
}

cmd_work_notes_show() {
  local issue_ref=""
  local json=0

  local binding
  binding=$(mandible_bind_arguments "issue.work-notes.show" '{"json":{"option":"json","constant":"1"},"issue_ref":{"position":0}}' "$@") || return $?
  eval "$binding"

  if [[ -z "$issue_ref" ]]; then
    die "Usage: $(mandible_command_syntax issue.work-notes.show)" 2
  fi

  require_tools
  local response
  response=$(api_get "/api/ledger/issues/$(urlencode "$issue_ref")") \
    || die "${RED}Failed to fetch issue ${issue_ref}${RESET}" 1
  if (( json )); then
    printf '%s\n' "$response" | jq '{issue_id: .id, display_id, title, work_notes: (.work_notes // ""), work_notes_revision: (.work_notes_revision // null), updated_at}'
  else
    printf '%s\n' "$response" | jq -r '.work_notes // ""'
  fi
}

cmd_work_notes_patch() {
  local action="$1"
  shift
  local issue_ref=""
  local message=""
  local base_revision_id=""

  local binding
  binding=$(mandible_bind_arguments "issue.work-notes.${action}" '{"message":{"option":"m"},"base_revision_id":{"option":"base-revision"},"issue_ref":{"position":0}}' "$@") || return $?
  eval "$binding"

  if [[ -z "$issue_ref" ]]; then
    die "Usage: mandible issue work-notes ${action} <issue-ref> $([[ "$action" == edit ]] && printf '%s' '-m <text> ') [--base-revision <rev>]" 2
  fi
  if [[ "$action" == edit && -z "$message" ]]; then
    die "Usage: $(mandible_command_syntax issue.work-notes.edit)" 2
  fi

  require_tools
  local payload
  payload=$(
    jq -n \
      --arg work_notes "$message" \
      --arg expected_revision "$base_revision_id" \
      '{work_notes: $work_notes}
       + (if $expected_revision == "" then {} else {expected_work_notes_revision: $expected_revision} end)'
  )
  api_send PATCH "/api/ledger/issues/$(urlencode "$issue_ref")" "$payload" >/dev/null \
    || die "${RED}Failed to ${action} work notes for issue ${issue_ref}${RESET}" 1
  if [[ "$action" == edit ]]; then
    err "${GREEN}Edited work notes for ${issue_ref}${RESET}"
  else
    err "${GREEN}Cleared work notes for ${issue_ref}${RESET}"
  fi
}

cmd_work_notes_history() {
  local issue_ref=""
  local json=0
  local with_body=0

  local binding
  binding=$(mandible_bind_arguments "issue.work-notes.history" '{"json":{"option":"json","constant":"1"},"with_body":{"option":"with-body","constant":"1"},"issue_ref":{"position":0}}' "$@") || return $?
  eval "$binding"

  if [[ -z "$issue_ref" ]]; then
    die "Usage: $(mandible_command_syntax issue.work-notes.history)" 2
  fi

  require_tools
  local response
  response=$(api_get "/api/ledger/issues/$(urlencode "$issue_ref")/work-notes/history") \
    || die "${RED}Failed to fetch work-notes revisions for issue ${issue_ref}${RESET}" 1
  if (( json )); then
    printf '%s\n' "$response" | jq '.'
  else
    printf '%s\n' "$response" | print_revision_history "$with_body" "work notes"
  fi
}

cmd_work_notes() {
  local action="${1:-}"
  shift || true
  case "$action" in
    show) cmd_work_notes_show "$@" ;;
    edit) cmd_work_notes_patch edit "$@" ;;
    clear) cmd_work_notes_patch clear "$@" ;;
    history) cmd_work_notes_history "$@" ;;
    ""|-h|--help)
      mandible_command_help issue work-notes
      ;;
    *) die "Unknown work-notes action: $action (expected show, edit, clear, or history)" 2 ;;
  esac
}

cmd_kind() {
  local action="${1:-}"
  shift || true
  if [[ "$action" != set ]]; then
    if [[ -z "$action" || "$action" == -h || "$action" == --help ]]; then
      cat <<'KIND_USAGE' | mandible_render_commands
Usage:
  {{command issue.kind.set}}
KIND_USAGE
      return 0
    fi
    die "Unknown kind action: $action (expected set)" 2
  fi

  local issue_ref="" kind="" binding
  binding=$(mandible_bind_arguments "issue.kind.set" '{"issue_ref":{"position":0},"kind":{"position":1}}' "$@") || return $?
  eval "$binding"
  require_tools
  local payload
  payload=$(jq -n --arg kind "$kind" '{kind:$kind}')
  api_send PATCH "/api/ledger/issues/$(urlencode "$issue_ref")" "$payload" >/dev/null \
    || die "${RED}Failed to set kind for issue ${issue_ref}${RESET}" 1
  err "${GREEN}Set kind for ${issue_ref} to ${kind}${RESET}"
}

resolve_comment_ref() {
  local comment_ref="$1"

  if [[ "$comment_ref" != *"#"* ]]; then
    printf '%s' "$comment_ref"
    return
  fi

  local issue_ref="${comment_ref%%#*}"
  local selector="${comment_ref##*#}"
  if [[ -z "$issue_ref" || -z "$selector" ]]; then
    die "Comment reference must be <issue-ref>#<ordinal>, <issue-ref>#last, or a raw comment id." 2
  fi
  if [[ "$selector" != "last" && ! "$selector" =~ ^[0-9]+$ ]]; then
    die "Comment selector must be an integer ordinal or 'last': $comment_ref" 2
  fi
  if [[ "$selector" == "0" ]]; then
    die "Comment ordinal 0 is the issue description; use 'mandible issue description show ${issue_ref}' or 'mandible issue description history ${issue_ref}'." 2
  fi

  local comment_id
  if [[ "$selector" == "last" ]]; then
    comment_id=$(
      api_get "/api/ledger/issues/$(urlencode "$issue_ref")" \
        | jq -er '(.comments // [] | sort_by(.created_at // 0) | last | .id) // empty'
    ) || die "${RED}Could not resolve comment reference ${comment_ref}${RESET}" 1
  else
    comment_id=$(
      api_get "/api/ledger/issues/$(urlencode "$issue_ref")" \
        | jq -er --argjson ordinal "$selector" '
            (.comments // [])[]
            | select(.ordinal == $ordinal)
            | .id
          '
    ) || die "${RED}Could not resolve comment reference ${comment_ref}${RESET}" 1
  fi
  printf '%s' "$comment_id"
}

cmd_comment_show() {
  local comment_ref=""
  local json=0

  local binding
  binding=$(mandible_bind_arguments "issue.comment.show" '{"json":{"option":"json","constant":"1"},"comment_ref":{"position":0}}' "$@") || return $?
  eval "$binding"

  if [[ -z "$comment_ref" ]]; then
    die "Usage: $(mandible_command_syntax issue.comment.show)" 2
  fi

  require_tools
  local comment_id response
  comment_id=$(resolve_comment_ref "$comment_ref")
  response=$(api_get "/api/ledger/comments/$(urlencode "$comment_id")/revisions") \
    || die "${RED}Failed to fetch comment ${comment_ref}${RESET}" 1
  if (( json )); then
    printf '%s\n' "$response" | jq --arg comment_id "$comment_id" '{
      comment_id: $comment_id,
      revision: (.revisions // [] | sort_by(.revision_no) | last),
      body: ((.revisions // [] | sort_by(.revision_no) | last | .snapshot_body) // "")
    }'
  else
    printf '%s\n' "$response" | jq -r '(.revisions // [] | sort_by(.revision_no) | last | .snapshot_body) // ""'
  fi
}

cmd_comment_history() {
  local comment_ref=""
  local json=0
  local with_body=0

  local binding
  binding=$(mandible_bind_arguments "issue.comment.history" '{"json":{"option":"json","constant":"1"},"with_body":{"option":"with-body","constant":"1"},"comment_ref":{"position":0}}' "$@") || return $?
  eval "$binding"

  if [[ -z "$comment_ref" ]]; then
    die "Usage: $(mandible_command_syntax issue.comment.history)" 2
  fi

  require_tools
  local comment_id response
  comment_id=$(resolve_comment_ref "$comment_ref")
  response=$(api_get "/api/ledger/comments/$(urlencode "$comment_id")/revisions") \
    || die "${RED}Failed to fetch body revisions for comment ${comment_ref}${RESET}" 1
  if (( json )); then
    printf '%s\n' "$response" | jq '.'
  else
    printf '%s\n' "$response" | print_revision_history "$with_body"
  fi
}

cmd_comment() {
  local action="${1:-}"

  case "$action" in
    add)
      shift
      cmd_comment_add "$@"
      ;;
    edit)
      shift
      cmd_comment_edit "$@"
      ;;
    show)
      shift
      cmd_comment_show "$@"
      ;;
    history)
      shift
      cmd_comment_history "$@"
      ;;
    ""|-h|--help)
      cat <<'COMMENT_USAGE' | mandible_render_commands
Usage:
  {{command issue.comment.add}}
  {{command issue.comment.edit}}
  mandible issue comment show <comment-ref> [--json]
  mandible issue comment history <comment-ref> [--json] [--with-body]

Comment refs can be raw comment IDs, <issue-ref>#<ordinal>, or <issue-ref>#last.
Compatibility alias: mandible issue comment <issue-ref> -m <text>
COMMENT_USAGE
      ;;
    *)
      cmd_comment_add "$@"
      ;;
  esac
}

fetch_revision() {
  local revision_id="$1"
  api_get "/api/ledger/body-revisions/$(urlencode "$revision_id")" | jq -c '.revision'
}

print_revision_detail() {
  api_jq_human '
    def timestamp:
      ((.occurred_at // .observed_at // 0) / 1000 | todateiso8601);
    "revision: \(.id | mandible_short_id)",
    "entity: \(.entity_type) \(.entity_id | mandible_short_id)",
    "issue: \(.issue_id | mandible_short_id)",
    "number: #\(.revision_no)",
    "reason: \(.reason)",
    "source: \(.source)",
    "occurred: \(timestamp)",
    "actor: \((.actor_id // .actor_type // "-") | mandible_short_id)",
    "base_revision: \((.base_revision_id // "-") | mandible_short_id)",
    "hash: \(.new_hash)",
    "",
    "body:",
    .snapshot_body
  '
}

cmd_revision_show() {
  local revision_id=""
  local json=0

  local binding
  binding=$(mandible_bind_arguments "issue.revision.show" '{"json":{"option":"json","constant":"1"},"revision_id":{"position":0}}' "$@") || return $?
  eval "$binding"

  if [[ -z "$revision_id" ]]; then
    die "Usage: $(mandible_command_syntax issue.revision.show)" 2
  fi

  require_tools
  local response
  response=$(api_get "/api/ledger/body-revisions/$(urlencode "$revision_id")") \
    || die "${RED}Failed to fetch body revision ${revision_id}${RESET}" 1
  if (( json )); then
    printf '%s\n' "$response" | jq '.'
  else
    printf '%s\n' "$response" | jq -c '.revision' | print_revision_detail
  fi
}

cmd_revision_diff() {
  local old_revision_id=""
  local new_revision_id=""
  local force=0

  local binding
  binding=$(mandible_bind_arguments "issue.revision.diff" '{"force":{"option":"force","constant":"1"},"old_revision_id":{"position":0},"new_revision_id":{"position":1}}' "$@") || return $?
  eval "$binding"

  if [[ -z "$old_revision_id" || -z "$new_revision_id" ]]; then
    die "Usage: $(mandible_command_syntax issue.revision.diff)" 2
  fi

  command -v python3 >/dev/null 2>&1 || die "python3 not found." 1
  require_tools

  local old_revision new_revision old_entity new_entity old_id new_id
  old_revision=$(fetch_revision "$old_revision_id") \
    || die "${RED}Failed to fetch body revision ${old_revision_id}${RESET}" 1
  new_revision=$(fetch_revision "$new_revision_id") \
    || die "${RED}Failed to fetch body revision ${new_revision_id}${RESET}" 1
  old_entity=$(printf '%s\n' "$old_revision" | jq -r '.entity_type')
  new_entity=$(printf '%s\n' "$new_revision" | jq -r '.entity_type')
  old_id=$(printf '%s\n' "$old_revision" | jq -r '.entity_id')
  new_id=$(printf '%s\n' "$new_revision" | jq -r '.entity_id')

  if (( ! force )) && [[ "$old_entity:$old_id" != "$new_entity:$new_id" ]]; then
    die "Refusing to diff revisions from different entities (${old_entity}:${old_id} vs ${new_entity}:${new_id}); pass --force to override." 2
  fi

  local old_file new_file
  old_file=$(mktemp)
  new_file=$(mktemp)
  printf '%s\n' "$old_revision" | jq -j '.snapshot_body' > "$old_file"
  printf '%s\n' "$new_revision" | jq -j '.snapshot_body' > "$new_file"

  local status
  python3 - "$old_file" "$new_file" "$old_revision" "$new_revision" <<'PY'
import difflib
import json
import sys

old_path, new_path, old_json, new_json = sys.argv[1:5]
old = json.loads(old_json)
new = json.loads(new_json)

def label(revision):
    return f"{revision['id']} #{revision['revision_no']} {revision['entity_type']}:{revision['entity_id']}"

with open(old_path, "r", encoding="utf-8") as handle:
    old_lines = handle.read().splitlines()
with open(new_path, "r", encoding="utf-8") as handle:
    new_lines = handle.read().splitlines()

for line in difflib.unified_diff(
    old_lines,
    new_lines,
    fromfile=label(old),
    tofile=label(new),
    lineterm="",
):
    print(line)
PY
  status=$?
  rm -f "$old_file" "$new_file"
  return "$status"
}

cmd_revision() {
  local action="${1:-}"
  shift || true

  case "$action" in
    show) cmd_revision_show "$@" ;;
    diff) cmd_revision_diff "$@" ;;
    ""|-h|--help)
      mandible_command_help issue revision
      ;;
    *)
      die "Unknown revision action: $action (expected show or diff)" 2
      ;;
  esac
}

cmd_refs() {
  local action="${1:-}"
  shift || true

  case "$action" in
    backfill)
      local root
      root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
      exec "$("$root/scripts/bun-runtime.sh")" "$root/dist/cli/issue-refs-backfill.js" "$@"
      ;;
    ""|-h|--help)
      cat <<'REFS_USAGE'
Usage:
  mandible issue refs backfill [--dry-run] [--apply] [--repo <repo>] [--issue <ref>] [--since <date>] [--until <date>] [--json]
REFS_USAGE
      ;;
    *)
      die "Unknown refs action: $action (expected backfill)" 2
      ;;
  esac
}

cmd_markdown() {
  local root
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
  exec "$("$root/scripts/bun-runtime.sh")" "$root/dist/cli/issue-markdown-tools.js" "$@"
}

# --- Main ---

if (( $# < 1 )); then
  usage
  exit 2
fi

subcmd="$1"
shift

case "$subcmd" in
  new)     cmd_new "$@" ;;
  list)    cmd_list "$@" ;;
  show)    cmd_show "$@" ;;
  title)   mandible_issue_title "$@" ;;
  report)  cmd_report "$@" ;;
  triage)  cmd_triage "$@" ;;
  heads)   cmd_heads "$@" ;;
  changed) cmd_changed "$@" ;;
  checkpoint) cmd_checkpoint "$@" ;;
  status)  cmd_status "$@" ;;
  parent-role) cmd_parent_role "$@" ;;
  branch)  cmd_branch "$@" ;;
  link)    cmd_link "$@" ;;
  unlink)  cmd_unlink "$@" ;;
  close)   cmd_close "$@" ;;
  open)    cmd_open "$@" ;;
  description) cmd_description "$@" ;;
  work-notes) cmd_work_notes "$@" ;;
  kind)    cmd_kind "$@" ;;
  comment) cmd_comment "$@" ;;
  body-history) cmd_description_history "$@" ;;
  comment-history) cmd_comment_history "$@" ;;
  revision) cmd_revision "$@" ;;
  label)   cmd_label "$@" ;;
  markdown) cmd_markdown "$@" ;;
  refs)    cmd_refs "$@" ;;
  -h|--help) usage ;;
  *)       die "Unknown subcommand: $subcmd" 2 ;;
esac
