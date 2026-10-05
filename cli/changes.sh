#!/usr/bin/env zsh
# Read-only, cursor-based ledger change feed for recurring agents.
source "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd -P)/command-syntax.sh"
set -euo pipefail

source "${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/api.sh"

usage() {
  mandible_command_help changes
}

project=""
cursor=""
limit=""
schema=""
json=0
binding=$(mandible_bind_main_arguments changes '{"project":{"option":"project"},"cursor":{"option":"cursor"},"limit":{"option":"limit"},"schema":{"option":"schema"},"json":{"option":"json","flag":true}}' "$@") || exit $?
eval "$binding"

request="/api/ledger/changes?project=$(urlencode "$project")"
[[ -z "$cursor" ]] || request="${request}&cursor=$(urlencode "$cursor")"
[[ -z "$limit" ]] || request="${request}&limit=$(urlencode "$limit")"
[[ -z "$schema" ]] || request="${request}&schema=$(urlencode "$schema")"

response_file=$(api_temp_file)
api_track_temp "$response_file"
http_status=$(api_send_capture GET "$request" "" "$response_file")
response=$(cat "$response_file")
if [[ ! "$http_status" =~ '^2' ]]; then
  printf '%s\n' "$response" | jq -r '(.code // "change_feed_error") + ": " + (.error // "request failed")' >&2
  exit 1
fi
if (( json )); then
  printf '%s\n' "$response" | jq .
else
  printf '%s\n' "$response" | jq -r '
    .changes[]? | "\(.sequence)\t\(.event_type)\t\(.entity.type):\(.entity.id)\t\(.event_id)",
    "high-water\t\(.high_water_mark)",
    "next-cursor\t\(.next_cursor)"'
fi
