#!/usr/bin/env bash
# mandible auth action: Manage staged auth request actions.

set -euo pipefail

API_HELPER="${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/api.sh"
source "$API_HELPER"

usage() {
  mandible_command_help auth action
}

json_payload_from_options() {
  local kind="$1"
  local payload_json="$2"
  local body="$3"
  local reason_comment="$4"
  local status="$5"
  local label="$6"
  local checkpoint_kind="$7"
  local checkpoint_payload_json="$8"
  local target="$9"
  local link_type="${10}"
  local note="${11}"

  if [[ -n "$payload_json" ]]; then
    jq -e 'type == "object"' >/dev/null <<<"$payload_json" || {
      echo "Error: --payload-json must be a JSON object" >&2
      exit 2
    }
    printf '%s' "$payload_json"
    return
  fi

  case "$kind" in
    comment_add)
      [[ -n "$body" ]] || { echo "Error: --body is required for comment_add" >&2; exit 2; }
      jq -nc --arg body "$body" '{body:$body}'
      ;;
    issue_close)
      jq -nc --arg reason "$reason_comment" 'if $reason == "" then {} else {reason_comment:$reason} end'
      ;;
    worker_status_set)
      [[ -n "$status" ]] || { echo "Error: --status is required for worker_status_set" >&2; exit 2; }
      jq -nc --arg value "$status" '{value:$value}'
      ;;
    label_add|label_rm)
      [[ -n "$label" ]] || { echo "Error: --label is required for ${kind}" >&2; exit 2; }
      jq -nc --arg label "$label" '{label:$label}'
      ;;
    checkpoint_add)
      [[ -n "$checkpoint_kind" ]] || { echo "Error: --checkpoint-kind is required for checkpoint_add" >&2; exit 2; }
      [[ -n "$checkpoint_payload_json" ]] || checkpoint_payload_json='{}'
      jq -e . >/dev/null <<<"$checkpoint_payload_json" || {
        echo "Error: --checkpoint-payload-json must be valid JSON" >&2
        exit 2
      }
      jq -nc --arg kind "$checkpoint_kind" --argjson payload "$checkpoint_payload_json" '{kind:$kind,payload:$payload}'
      ;;
    link_add)
      [[ -n "$target" ]] || { echo "Error: --target is required for link_add" >&2; exit 2; }
      jq -nc --arg target "$target" --arg type "$link_type" --arg note "$note" '{
        target: $target
      } + (if $type == "" then {} else {type:$type} end) + (if $note == "" then {} else {note:$note} end)'
      ;;
    *)
      echo "Error: unknown action kind '$kind'" >&2
      exit 2
      ;;
  esac
}

build_action_body() {
  local kind="$1"
  local issue="$2"
  local payload="$3"
  [[ -n "$kind" ]] || { echo "Error: --kind is required" >&2; exit 2; }
  [[ -n "$issue" ]] || { echo "Error: --issue is required" >&2; exit 2; }
  jq -nc --arg kind "$kind" --arg issue "$issue" --argjson payload "$payload" \
    '{kind:$kind,target_issue_ref:$issue,payload:$payload}'
}

parse_action_options() {
  kind=""
  issue=""
  payload_json=""
  body=""
  reason_comment=""
  status_value=""
  label=""
  checkpoint_kind=""
  checkpoint_payload_json=""
  target=""
  link_type=""
  note=""

  local binding
  local -a selector=("$request_id")
  [[ "$subcommand" != "edit" ]] || selector+=("$action_id")
  binding=$(mandible_bind_arguments "auth.action.${subcommand}" '{"kind":{"option":"kind"},"issue":{"option":["issue","target-issue"]},"payload_json":{"option":"payload-json"},"body":{"option":"body"},"reason_comment":{"option":"reason-comment"},"status_value":{"option":"status"},"label":{"option":"label"},"checkpoint_kind":{"option":"checkpoint-kind"},"checkpoint_payload_json":{"option":"checkpoint-payload-json"},"target":{"option":"target"},"link_type":{"option":"type"},"note":{"option":"note"}}' "${selector[@]}" "$@") || return $?
  eval "$binding"
}

print_action_human() {
  api_jq_human '
    .actions[]? |
    "[\(mandible_display_id)] #\(.ordinal) \(.kind) \(.target_issue_ref) \(.state) digest=\((.target_digest // "-") | mandible_short_id)"
  '
}

subcommand="${1:-}"
shift || true

case "$subcommand" in
  list)
    request_id="${1:-}"
    [[ -n "$request_id" ]] || { echo "Usage: mandible auth action list <request-id> [--json]" >&2; exit 2; }
    shift
    json=0
    binding=$(mandible_bind_main_arguments "auth.action.list" '{"json":{"option":"json","constant":"1"}}' "$request_id" "$@") || exit $?
    eval "$binding"
    tmp=$(mktemp)
    trap 'rm -f "$tmp"' EXIT
    status=$(api_send_capture GET "/api/auth/request/${request_id}/actions" "" "$tmp") || status=""
    if [[ ! "$status" =~ ^2 ]]; then
      echo "Error: GET /api/auth/request/${request_id}/actions returned HTTP ${status:-000}" >&2
      cat "$tmp" >&2
      exit 1
    fi
    if [[ "$json" -eq 1 ]]; then
      cat "$tmp"
    else
      print_action_human < "$tmp"
    fi
    ;;
  add)
    request_id="${1:-}"
    [[ -n "$request_id" ]] || { echo "Usage: mandible auth action add <request-id> --kind <kind> --issue <issue-ref>" >&2; exit 2; }
    shift
    parse_action_options "$@"
    payload=$(json_payload_from_options "$kind" "$payload_json" "$body" "$reason_comment" "$status_value" "$label" "$checkpoint_kind" "$checkpoint_payload_json" "$target" "$link_type" "$note")
    body_json=$(build_action_body "$kind" "$issue" "$payload")
    api_send POST "/api/auth/request/${request_id}/actions" "$body_json"
    ;;
  edit)
    request_id="${1:-}"
    action_id="${2:-}"
    [[ -n "$request_id" && -n "$action_id" ]] || { echo "Usage: mandible auth action edit <request-id> <action-id> --kind <kind> --issue <issue-ref>" >&2; exit 2; }
    shift 2
    parse_action_options "$@"
    payload=$(json_payload_from_options "$kind" "$payload_json" "$body" "$reason_comment" "$status_value" "$label" "$checkpoint_kind" "$checkpoint_payload_json" "$target" "$link_type" "$note")
    body_json=$(build_action_body "$kind" "$issue" "$payload")
    api_send PUT "/api/auth/request/${request_id}/actions/${action_id}" "$body_json"
    ;;
  rm|delete|remove)
    binding=$(mandible_bind_main_arguments "auth.action.rm" '{"request_id":{"position":0},"action_id":{"position":1}}' "$@") || exit $?
    eval "$binding"
    api_send DELETE "/api/auth/request/${request_id}/actions/${action_id}" "{}"
    ;;
  ""|-h|--help|help)
    usage
    ;;
  *)
    echo "Unknown auth action subcommand: $subcommand" >&2
    usage >&2
    exit 2
    ;;
esac
