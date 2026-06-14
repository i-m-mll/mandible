#!/usr/bin/env bash
# mandible auth replay-archives: Replay Codex thread archive attempts for a completed auth request.
#
# Usage: mandible auth replay-archives <request-id> [--json]

set -euo pipefail

API_HELPER="${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/api.sh"
source "$API_HELPER"

request_id=""
json=0

usage() {
  cat <<'EOF'
Usage: mandible auth replay-archives <request-id> [--json]

Replay Codex thread archive attempts for a completed successful merge auth
request. This does not rerun the protected merge or deferred issue actions.

Options:
  --json      Print the raw replay result JSON.
  -h, --help  Show this help.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --json) json=1; shift ;;
    -h|--help) usage; exit 0 ;;
    -*)
      printf '%s\n' "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      if [[ -z "$request_id" ]]; then
        request_id="$1"
      else
        printf '%s\n' "Unexpected argument: $1" >&2
        exit 2
      fi
      shift
      ;;
  esac
done

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
