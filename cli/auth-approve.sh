#!/usr/bin/env bash
# mandible auth approve: the operator's own approval of one pending request at
# the lifecycle revision they reviewed. A protected merge raises the approval
# key's single Touch ID sheet; the command then waits for the request to settle.

set -euo pipefail
source "${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/api.sh"
mandible_prepare_syntax_runtime || exit $?
source "${MANDIBLE_CLI_DIR:-$MANDIBLE_COMMAND_SYNTAX_DIR}/auth-status.sh"

request_id=""
revision=""
review_file=""
binding=$(mandible_bind_main_arguments "auth.approve" '{"request_id":{"position":0},"revision":{"option":"revision"},"review_file":{"option":"review"}}' "$@") || exit $?
eval "$binding"
if api_managed_client_markers_present; then
  printf '%s\n' 'Error: auth approve is the operator'\''s own command; agent and managed sessions cannot approve.' >&2
  exit 1
fi
command -v jq >/dev/null 2>&1 || { printf '%s\n' 'Error: jq is required.' >&2; exit 1; }

if [[ -n "$review_file" ]]; then
  approval=$(jq -ce -s --arg request "$request_id" '
    ($request | sub("^auth:"; "")) as $ref
    | select(length == 1)
    | .[0]
    | select((.request_id | type) == "string" and (.request_id | startswith($ref)))
    | .approval
    | select((.lifecycle_revision | type) == "number" and (.review | type) == "object")
  ' -- "$review_file") || {
    printf '%s\n' 'Error: the saved approval review is invalid or names a different request.' >&2
    exit 2
  }
else
  approval=$(jq -nc --argjson revision "$revision" '{lifecycle_revision: $revision}') || exit 2
fi

approve_path="/api/auth/request/$(urlencode "$request_id")"
response_file=$(api_temp_file)
status_file=$(api_temp_file)

kill_tree() {
  local child
  for child in $(pgrep -P "$1" 2>/dev/null); do kill_tree "$child"; done
  kill -TERM "$1" 2>/dev/null || true
}

approval_pid=""
cancel_approval() {
  trap - INT TERM
  api_send POST "$approve_path/cancel-proof" '{}' >/dev/null 2>&1 || true
  if [[ -n "$approval_pid" ]]; then
    kill_tree "$approval_pid"
    wait "$approval_pid" 2>/dev/null || true
  fi
  printf 'Auth request %s: approval cancelled.\n' "$request_id" >&2
  api_cleanup_temp_files
  exit 130
}
trap cancel_approval INT TERM
# The approval call holds the sheet open; it runs in the background so INT and
# TERM interrupt the wait at once and dismiss the sheet through cancel-proof.
# Retries stay off: a retried approval would raise a second sheet.
(
  MANDIBLE_HTTP_RETRIES=0 MANDIBLE_HTTP_TIMEOUT=75
  api_send_capture POST "$approve_path/approve" "$approval" "$response_file" > "$status_file"
) &
approval_pid=$!
wait "$approval_pid" || true
trap - INT TERM

http_status=$(cat "$status_file")
if [[ "$http_status" != 202 ]]; then
  detail=$(jq -r '[.error, .code] | map(select(. != null)) | join(" ")' "$response_file" 2>/dev/null || true)
  printf 'Error: auth request %s was not approved (HTTP %s)%s\n' "$request_id" "$http_status" "${detail:+: $detail}" >&2
  exit 1
fi
mandible_auth_watch "$(jq -r '.request_id' "$response_file")" 14400
