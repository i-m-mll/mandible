#!/usr/bin/env bash
set -euo pipefail
provider="${1:-}"
case "$provider" in claude|codex) ;; *) printf 'Mandible execution hook: expected claude or codex.\n' >&2; exit 1 ;; esac
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/../cli" && pwd)/api.sh"
export MANDIBLE_HTTP_TIMEOUT=2 MANDIBLE_FILE_RPC_TIMEOUT=2 MANDIBLE_HTTP_RETRIES=0
payload=$(jq -ce --arg provider "$provider" '
  if type != "object" or (.session_id | type != "string") or (.session_id | length == 0)
    or (.hook_event_name | type != "string") then error("invalid execution envelope") else . end |
  {provider:$provider, session_id, hook_event_name} +
  (if has("turn_id") then {turn_id} else {} end) +
  (if has("agent_id") then {agent_id} else {} end) +
  (if .hook_event_name == "SessionStart" and has("source") then {source} else {} end) +
  (if .hook_event_name == "SessionEnd" and has("reason") then {reason} else {} end) +
  (if .hook_event_name == "StopFailure" then {error, error_details, last_assistant_message} else {} end)
') || { printf 'Mandible execution hook: invalid payload.\n' >&2; exit 1; }
session_id=$(jq -r '.session_id' <<< "$payload")
# A fresh app-server learns its native ID after spawn. Its private binding is
# published atomically, and remains scoped to the owning controller instance.
if [[ -n "${MANDIBLE_EXECUTION_OBSERVER_ID:-}" && -n "${MANDIBLE_EXECUTION_OBSERVER_SESSION_FILE:-}" ]]; then
  MANDIBLE_EXECUTION_OBSERVER_SESSION_ID=""
  if [[ -f "$MANDIBLE_EXECUTION_OBSERVER_SESSION_FILE" ]]; then
    MANDIBLE_EXECUTION_OBSERVER_SESSION_ID=$(jq -r --arg controller "$MANDIBLE_EXECUTION_OBSERVER_ID" '
      select(.controller_instance_id == $controller) | .provider_session_id // empty
    ' "$MANDIBLE_EXECUTION_OBSERVER_SESSION_FILE") || { printf 'Mandible execution hook: invalid observer binding.\n' >&2; exit 1; }
  fi
  export MANDIBLE_EXECUTION_OBSERVER_SESSION_ID
fi
# A nested provider has its own payload identity, even with inherited markers.
if [[ -n "${MANDIBLE_EXECUTION_OBSERVER_ID:-}" && "${MANDIBLE_EXECUTION_OBSERVER_SESSION_ID:-}" == "$session_id" ]]; then exit 0; fi
api_scope_inherited_identity || exit 1
if ! api_send POST /api/hooks/session-execution "$payload" >/dev/null; then
  printf 'Mandible execution hook: observation delivery failed.\n' >&2
  exit 1
fi
