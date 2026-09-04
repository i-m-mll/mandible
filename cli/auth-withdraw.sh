#!/usr/bin/env bash
# mandible auth withdraw: requester-authenticated withdrawal of one pending request.

set -euo pipefail
source "${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/api.sh"

request_id=""
reason=""
json=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --reason) reason="${2:-}"; shift 2 ;;
    --json) json=1; shift ;;
    -h|--help)
      printf '%s\n' 'Usage: mandible auth withdraw <request> --reason <text> [--json]'
      exit 0
      ;;
    -*) printf 'Unknown option: %s\n' "$1" >&2; exit 2 ;;
    *)
      [[ -z "$request_id" ]] || { printf 'Unexpected argument: %s\n' "$1" >&2; exit 2; }
      request_id="$1"; shift
      ;;
  esac
done
[[ -n "$request_id" && -n "${reason//[[:space:]]/}" ]] || {
  printf '%s\n' 'Usage: mandible auth withdraw <request> --reason <text> [--json]' >&2
  exit 2
}
command -v jq >/dev/null 2>&1 || { printf '%s\n' 'Error: jq is required.' >&2; exit 1; }
session_id=$(api_ambient_session_id)
payload=$(jq -nc --arg reason "$reason" --arg session_id "$session_id" '{
  reason: $reason,
  session_id: (if $session_id == "" then null else $session_id end)
}')
response=$(api_send POST "/api/auth/request/$(urlencode "$request_id")/withdraw" "$payload") || {
  printf 'Error: withdrawal refused for auth request %s.\n' "$request_id" >&2
  exit 1
}
if [[ "$json" == 1 ]]; then
  printf '%s\n' "$response" | jq .
else
  printf '%s\n' "$response" | jq -r '"Withdrew auth request \(.request_id[0:8]) (\(.status))."'
fi
