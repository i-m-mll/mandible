#!/usr/bin/env zsh
# Read-only, cursor-based ledger change feed for recurring agents.
source "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd -P)/command-syntax.sh"
set -euo pipefail

source "${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/api.sh"

usage() {
  cat <<'EOF' | mandible_render_commands
Usage: {{command changes}}
                        [--schema mandible-ledger-change-feed@1] [--json]

Omit --cursor to establish a controlled resync point at the current high-water
mark. Persist next_cursor and pass it to the next invocation. JSON is the
authoritative output; the default view is a compact event summary followed by
the next cursor.
EOF
}

project=""
cursor=""
limit=""
schema=""
json=0
while (( $# > 0 )); do
  case "$1" in
    --project) project="${2:-}"; shift 2 ;;
    --cursor) cursor="${2:-}"; shift 2 ;;
    --limit) limit="${2:-}"; shift 2 ;;
    --schema) schema="${2:-}"; shift 2 ;;
    --json) json=1; shift ;;
    -h|--help|help) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ -n "$project" ]] || { usage >&2; exit 2; }
if [[ -n "$limit" && ! "$limit" =~ '^[0-9]+$' ]]; then
  printf '%s\n' '--limit must be an integer from 1 through 200' >&2
  exit 2
fi

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
