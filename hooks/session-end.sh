#!/usr/bin/env bash

set -o pipefail

if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

INPUT=$(cat)

session_id="${MANDIBLE_SESSION_ID:-}"
if [[ -z "$session_id" ]]; then
  session_id=$(echo "$INPUT" | jq -r '.session_id // .id // .session.id // empty')
fi
if [[ -z "$session_id" ]]; then
  exit 0
fi

MANDIBLE_PORT="${MANDIBLE_PORT:-19420}"

payload=$(jq -n '{ status: "ended" }')

curl -sS --max-time 5 -X PATCH "http://127.0.0.1:${MANDIBLE_PORT}/api/sessions/${session_id}/end" \
  -H "Content-Type: application/json" \
  -d "$payload" >/dev/null 2>&1 || exit 0

exit 0
