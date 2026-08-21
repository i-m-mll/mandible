#!/usr/bin/env bash
# mandible reminder: durable one-shot reminder CLI.

set -euo pipefail

API_HELPER="${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/api.sh"
source "$API_HELPER"

usage() {
  cat <<'EOF'
Usage:
  mandible reminder create --project <ref> --message <text> --idempotency-key <key> --at <RFC3339> [--json]
  mandible reminder create --project <ref> --message <text> --idempotency-key <key> --issue-closed <issue-ref> [--json]
  mandible reminder create --project <ref> --message <text> --idempotency-key <key> --auth-merge-count-gte <positive-int> [--base-branch <exact>] [--canonical-message <true|false>] [--json]
  mandible reminder show <id> [--json]
  mandible reminder list [--project <ref>] [--lifecycle <armed|completed|cancelled>] [--json]
  mandible reminder cancel <id> [--json]

Creation requires an explicit idempotency key. Reuse the same key and exact
arguments after an uncertain outcome; reusing it with different arguments is a conflict.
Exactly one trigger (--at, --issue-closed, or --auth-merge-count-gte) is required.
EOF
}

fail() {
  printf 'mandible reminder: %s\n' "$1" >&2
  exit "${2:-2}"
}

require_value() {
  local option="$1" count="$2"
  (( count >= 2 )) || fail "$option requires a value"
}

require_tools() {
  api_is_file_rpc || command -v curl >/dev/null 2>&1 || fail "curl not found" 1
  command -v jq >/dev/null 2>&1 || fail "jq not found" 1
}

read_response() {
  local status="$1" response_file="$2" response code message
  response="$(cat "$response_file")"
  rm -f "$response_file"
  if [[ "$status" =~ ^2 ]]; then
    printf '%s' "$response"
    return 0
  fi
  code="$(printf '%s' "$response" | jq -r '.code // empty' 2>/dev/null || true)"
  message="$(printf '%s' "$response" | jq -r '.error // .message // empty' 2>/dev/null || true)"
  printf 'mandible reminder: request failed (status=%s' "$status" >&2
  [[ -z "$code" ]] || printf ', code=%s' "$code" >&2
  printf ')' >&2
  [[ -z "$message" ]] || printf ': %s' "$message" >&2
  printf '\n' >&2
  return 22
}

print_reminder() {
  local response="$1" envelope="$2"
  printf '%s\n' "$response" | api_jq_human '
    def predicate:
      .revision.payload.predicate
      | if .kind == "at" then "at " + .at
        elif .kind == "issue_closed" then "issue_closed " + .issue_id
        else "auth_merge_count_gte project=" + .project_id
          + " threshold=" + (.threshold | tostring)
          + (if .base_branch == null then "" else " base_branch=" + .base_branch end)
          + (if .canonical_message == null then "" else " canonical_message=" + (.canonical_message | tostring) end)
        end;
    (if $envelope == "create" then .reminder else .reminder end) as $r
    | "Reminder \($r | mandible_display_id)",
      "project: \($r.project_key) (\($r.project_id | mandible_short_id))",
      "lifecycle: \($r.lifecycle)",
      "predicate: \($r | predicate)",
      "message: \($r.revision.payload.message)",
      (if $envelope == "create" then "stored: \(.stored)\nfired_immediately: \(.fired_immediately)" else empty end),
      (if $r.occurrence == null then "occurrence: none"
       else "occurrence: \($r.occurrence | mandible_display_id)\nevidence: \($r.occurrence.triggering_evidence | tojson)" end)
  ' --arg envelope "$envelope"
}

cmd_create() {
  local project="" message="" idempotency_key="" at="" issue_closed=""
  local auth_merge_count="" base_branch="" canonical_message="" json=0
  while (( $# > 0 )); do
    case "$1" in
      --project) require_value "$1" "$#"; project="$2"; shift 2 ;;
      --message) require_value "$1" "$#"; message="$2"; shift 2 ;;
      --idempotency-key) require_value "$1" "$#"; idempotency_key="$2"; shift 2 ;;
      --at) require_value "$1" "$#"; at="$2"; shift 2 ;;
      --issue-closed) require_value "$1" "$#"; issue_closed="$2"; shift 2 ;;
      --auth-merge-count-gte) require_value "$1" "$#"; auth_merge_count="$2"; shift 2 ;;
      --base-branch) require_value "$1" "$#"; base_branch="$2"; shift 2 ;;
      --canonical-message) require_value "$1" "$#"; canonical_message="$2"; shift 2 ;;
      --json) json=1; shift ;;
      -h|--help) usage; return 0 ;;
      -*) fail "unknown create option '$1'" ;;
      *) fail "unexpected create argument '$1'" ;;
    esac
  done

  [[ -n "$project" ]] || fail "create requires --project"
  [[ -n "$message" ]] || fail "create requires --message"
  [[ -n "$idempotency_key" ]] || fail "create requires --idempotency-key so uncertain retries can reuse it"

  local trigger_count=0
  [[ -z "$at" ]] || (( trigger_count += 1 ))
  [[ -z "$issue_closed" ]] || (( trigger_count += 1 ))
  [[ -z "$auth_merge_count" ]] || (( trigger_count += 1 ))
  (( trigger_count == 1 )) || fail "create requires exactly one of --at, --issue-closed, or --auth-merge-count-gte"
  if [[ -n "$base_branch" || -n "$canonical_message" ]]; then
    [[ -n "$auth_merge_count" ]] || fail "--base-branch and --canonical-message require --auth-merge-count-gte"
  fi
  if [[ -n "$auth_merge_count" && ! "$auth_merge_count" =~ ^[1-9][0-9]*$ ]]; then
    fail "--auth-merge-count-gte must be a positive integer"
  fi
  if [[ -n "$canonical_message" && "$canonical_message" != "true" && "$canonical_message" != "false" ]]; then
    fail "--canonical-message must be true or false"
  fi

  require_tools
  local predicate payload response_file status response
  if [[ -n "$at" ]]; then
    predicate="$(jq -n --arg at "$at" '{kind:"at", at:$at}')"
  elif [[ -n "$issue_closed" ]]; then
    predicate="$(jq -n --arg issue "$issue_closed" '{kind:"issue_closed", issue:$issue}')"
  else
    predicate="$(jq -n \
      --arg project "$project" --arg threshold "$auth_merge_count" \
      --arg base_branch "$base_branch" --arg canonical_message "$canonical_message" \
      '{kind:"auth_merge_count_gte", project:$project, threshold:($threshold | tonumber)}
       + (if $base_branch == "" then {} else {base_branch:$base_branch} end)
       + (if $canonical_message == "" then {} else {canonical_message:($canonical_message == "true")} end)')"
  fi
  payload="$(jq -n \
    --arg schema "mandible-reminder@1" --arg key "$idempotency_key" \
    --arg project "$project" --arg message "$message" --argjson predicate "$predicate" \
    '{schema:$schema, idempotency_key:$key, project:$project, message:$message, predicate:$predicate}')"
  response_file="$(api_temp_file)"
  status="$(api_send_capture POST "/api/reminders" "$payload" "$response_file")"
  response="$(read_response "$status" "$response_file")"
  if (( json )); then printf '%s\n' "$response" | jq .; else print_reminder "$response" create; fi
}

cmd_show() {
  local id="" json=0
  while (( $# > 0 )); do
    case "$1" in
      --json) json=1; shift ;;
      -h|--help) usage; return 0 ;;
      -*) fail "unknown show option '$1'" ;;
      *) [[ -z "$id" ]] || fail "unexpected show argument '$1'"; id="$1"; shift ;;
    esac
  done
  [[ -n "$id" ]] || fail "Usage: mandible reminder show <id> [--json]"
  require_tools
  local response_file status response
  response_file="$(api_temp_file)"
  status="$(api_send_capture GET "/api/reminders/$(urlencode "$id")" "" "$response_file")"
  response="$(read_response "$status" "$response_file")"
  if (( json )); then printf '%s\n' "$response" | jq .; else print_reminder "$response" show; fi
}

cmd_list() {
  local project="" lifecycle="" json=0
  while (( $# > 0 )); do
    case "$1" in
      --project) require_value "$1" "$#"; project="$2"; shift 2 ;;
      --lifecycle) require_value "$1" "$#"; lifecycle="$2"; shift 2 ;;
      --json) json=1; shift ;;
      -h|--help) usage; return 0 ;;
      -*) fail "unknown list option '$1'" ;;
      *) fail "unexpected list argument '$1'" ;;
    esac
  done
  if [[ -n "$lifecycle" && "$lifecycle" != "armed" && "$lifecycle" != "completed" && "$lifecycle" != "cancelled" ]]; then
    fail "--lifecycle must be armed, completed, or cancelled"
  fi
  require_tools
  local response_file status response
  response_file="$(api_temp_file)"
  if [[ -n "$project" && -n "$lifecycle" ]]; then
    status="$(api_send_capture GET "/api/reminders?project=$(urlencode "$project")&lifecycle=$(urlencode "$lifecycle")" "" "$response_file")"
  elif [[ -n "$project" ]]; then
    status="$(api_send_capture GET "/api/reminders?project=$(urlencode "$project")" "" "$response_file")"
  elif [[ -n "$lifecycle" ]]; then
    status="$(api_send_capture GET "/api/reminders?lifecycle=$(urlencode "$lifecycle")" "" "$response_file")"
  else
    status="$(api_send_capture GET "/api/reminders" "" "$response_file")"
  fi
  response="$(read_response "$status" "$response_file")"
  if (( json )); then
    printf '%s\n' "$response" | jq .
  else
    printf '%s\n' "$response" | api_jq_human '
      .reminders[]?
      | [mandible_display_id, .lifecycle, .project_key, .revision.payload.predicate.kind,
         (if .occurrence then (.occurrence | mandible_display_id) else "-" end), .revision.payload.message]
      | @tsv
    '
  fi
}

cmd_cancel() {
  local id="" json=0
  while (( $# > 0 )); do
    case "$1" in
      --json) json=1; shift ;;
      -h|--help) usage; return 0 ;;
      -*) fail "unknown cancel option '$1'" ;;
      *) [[ -z "$id" ]] || fail "unexpected cancel argument '$1'"; id="$1"; shift ;;
    esac
  done
  [[ -n "$id" ]] || fail "Usage: mandible reminder cancel <id> [--json]"
  require_tools
  local response_file status response
  response_file="$(api_temp_file)"
  status="$(api_send_capture POST "/api/reminders/$(urlencode "$id")/cancel" "{}" "$response_file")"
  response="$(read_response "$status" "$response_file")"
  if (( json )); then printf '%s\n' "$response" | jq .; else print_reminder "$response" show; fi
}

command="${1:-}"
case "$command" in
  ""|-h|--help|help) usage; [[ -n "$command" ]] || exit 1; exit 0 ;;
esac
shift

case "$command" in
  create) cmd_create "$@" ;;
  show) cmd_show "$@" ;;
  list) cmd_list "$@" ;;
  cancel) cmd_cancel "$@" ;;
  *) fail "unknown subcommand '$command'" ;;
esac
