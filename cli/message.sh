#!/usr/bin/env bash
# mandible message: messages from one agent to another exact agent.

set -euo pipefail

API_HELPER="${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/api.sh"
source "$API_HELPER"
mandible_prepare_syntax_runtime || exit $?

usage() {
  mandible_command_help message
}

fail() {
  printf 'mandible message: %s\n' "$1" >&2
  exit "${2:-2}"
}

require_tools() {
  api_is_file_rpc || command -v curl >/dev/null 2>&1 || fail "curl not found" 1
  command -v jq >/dev/null 2>&1 || fail "jq not found" 1
}

read_response() {
  local code="$1" response_file="$2" response error_code message
  response="$(cat "$response_file")"
  rm -f "$response_file"
  if [[ "$code" =~ ^2 ]]; then
    printf '%s' "$response"
    return 0
  fi
  error_code="$(printf '%s' "$response" | jq -r '.code // empty' 2>/dev/null || true)"
  message="$(printf '%s' "$response" | jq -r '.error // .message // empty' 2>/dev/null || true)"
  printf 'mandible message: request failed (status=%s' "$code" >&2
  [[ -z "$error_code" ]] || printf ', code=%s' "$error_code" >&2
  printf ')' >&2
  [[ -z "$message" ]] || printf ': %s' "$message" >&2
  printf '\n' >&2
  return 22
}

# A message's reach, the one line `send`, `status` and `list` print.
REACH_JQ='
  def when: if . == null then "-" else (. / 1000 | todate) end;
  def reason: {
    no_route: "no route", route_refused: "route refused", provider_not_running: "provider not running",
    not_app_thread: "not an app thread", entry_point_failed: "entry point failed", not_main_thread: "only a main thread is woken",
    not_attempted: "no wake attempted"
  }[.reason] + (if .detail == null then "" else " (\(.detail))" end);
  def reach: if .kind == "delivered" then "delivered \(.at | when)"
    elif .kind == "working" then "recipient working (observed \(.observed_at | when)); its hooks will deliver"
    elif .kind == "woken" then "woken \(.at | when); not yet delivered"
    elif .kind == "wake_in_progress" then "wake in progress"
    elif .kind == "not_woken" then "not woken: \(reason); delivered at its next turn"
    elif .kind == "ended" then "ended (observed \(.observed_at | when)); delivered only if it is resumed"
    else "unknown to Mandible: no hook has run in that session" end;
'

# One message as `status` prints it.
MESSAGE_JQ="$REACH_JQ"'
  "message \(.short_id)",
  "from: \(.sender_agent_ref // "a shell")",
  "to: \(.recipient_agent_ref)",
  "sent: \(.sent_at | when)",
  "reach: \(.reach | reach)",
  "text: \(.text)"
'

cmd_send() {
  local to="" message="" json=0
  local binding
  binding=$(mandible_bind_arguments "message.send" '{"to":{"option":"to"},"message":{"option":["m","message"]},"json":{"option":"json","constant":"1"}}' "$@") || return $?
  eval "$binding"
  [[ -n "$to" ]] || fail "send requires --to"
  if [[ -z "$message" && ! -t 0 ]]; then message="$(cat)"; fi
  [[ -n "${message//[[:space:]]/}" ]] || fail "the message is empty"
  require_tools
  local payload response_file code response
  payload="$(jq -n --arg to "$to" --arg text "$message" '{to:$to, text:$text}')"
  response_file="$(api_temp_file)"
  code="$(api_send_capture POST "/api/messages" "$payload" "$response_file")"
  response="$(read_response "$code" "$response_file")"
  if (( json )); then printf '%s\n' "$response" | jq .; else printf '%s\n' "$response" | jq -r "$REACH_JQ"' .message | .short_id, (.reach | reach)'; fi
}

cmd_status() {
  local id="" json=0
  local binding
  binding=$(mandible_bind_arguments "message.status" '{"json":{"option":"json","constant":"1"},"id":{"position":0}}' "$@") || return $?
  eval "$binding"
  [[ -n "$id" ]] || fail "Usage: $(mandible_command_syntax message.status)"
  require_tools
  local response_file code response
  response_file="$(api_temp_file)"
  code="$(api_send_capture GET "/api/messages/$(urlencode "$id")" "" "$response_file")"
  response="$(read_response "$code" "$response_file")"
  if (( json )); then printf '%s\n' "$response" | jq .; else printf '%s\n' "$response" | jq -r ".message | $MESSAGE_JQ"; fi
}

cmd_list() {
  local limit="" json=0
  local binding
  binding=$(mandible_bind_arguments "message.list" '{"limit":{"option":"limit"},"json":{"option":"json","constant":"1"}}' "$@") || return $?
  eval "$binding"
  require_tools
  local response_file code response url="/api/messages"
  [[ -z "$limit" ]] || url="$url?limit=$(urlencode "$limit")"
  response_file="$(api_temp_file)"
  code="$(api_send_capture GET "$url" "" "$response_file")"
  response="$(read_response "$code" "$response_file")"
  if (( json )); then
    printf '%s\n' "$response" | jq .
  else
    printf '%s\n' "$response" | jq -r "$REACH_JQ"'
      .agent_ref as $me
      | .messages[]
      | [.short_id,
         (if .recipient_agent_ref == $me then "received" else "sent" end),
         (if .recipient_agent_ref == $me then (.sender_agent_ref // "a shell") else .recipient_agent_ref end),
         (.reach | reach),
         .text]
      | @tsv'
  fi
}

command="${1:-}"
case "$command" in
  ""|-h|--help|help) usage; [[ -n "$command" ]] || exit 1; exit 0 ;;
esac
shift

case "$command" in
  send) cmd_send "$@" ;;
  status) cmd_status "$@" ;;
  list) cmd_list "$@" ;;
  *) fail "unknown subcommand '$command'" ;;
esac
