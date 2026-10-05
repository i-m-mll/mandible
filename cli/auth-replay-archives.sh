#!/usr/bin/env bash
# mandible auth replay-archives: Replay Codex thread archive attempts for a completed auth request.
#
# Usage: mandible auth replay-archives <request-id> [--json]
source "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd -P)/command-syntax.sh"

set -euo pipefail

API_HELPER="${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/api.sh"
source "$API_HELPER"

request_id=""
json=0

usage() {
  mandible_command_help auth replay archives
}

binding=$(mandible_bind_main_arguments "auth.replay-archives" '{"json":{"option":"json","constant":"1"}}' "$request_id" "$@") || exit $?
eval "$binding"

if [[ -z "$request_id" ]]; then
  usage >&2
  exit 2
fi

if ! command -v jq >/dev/null 2>&1; then
  printf '%s\n' "Error: jq is required for mandible auth replay-archives." >&2
  exit 1
fi

encoded_id=$(urlencode "$request_id")
response=$(api_send POST "/api/auth/request/${encoded_id}/replay-codex-archives" '{}') || {
  printf '%s\n' "Error: could not replay Codex archives for auth request ${request_id}." >&2
  exit 1
}

if [[ "$json" == "1" ]]; then
  printf '%s\n' "$response" | jq .
  exit 0
fi

printf '%s\n' "$response" | jq -r '
  "Replayed Codex archive attempts for auth request \(.request_id): \(.archived) archived / \(.candidates | length) candidate(s)",
  (.candidates[]? | "  - \(.provider_session_id) issue=\(.issue_id) work_unit=\(.work_unit_id // "-") archived=\(.archived)")
'
