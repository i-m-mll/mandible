#!/usr/bin/env bash
set -euo pipefail
source "${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/api.sh"
source "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd -P)/command-syntax.sh"

request=""
json=0
binding=$(mandible_bind_main_arguments "auth.review.show" '{"request":{"position":0},"json":{"option":"json","constant":"1"}}' "$@") || exit $?
eval "$binding"
command -v jq >/dev/null 2>&1 || { printf '%s\n' 'Error: jq is required.' >&2; exit 1; }
response=$(api_get "/api/auth/request/$(urlencode "$request")/review/returned") || {
  printf 'Error: could not read the returned review for %s.\n' "$request" >&2
  exit 1
}
if [[ "$json" == 1 ]]; then
  printf '%s\n' "$response" | jq .
  exit 0
fi
printf '%s\n' "$response" | jq -r '
  def safe: gsub("[\u0000-\u0008\u000b-\u001f\u007f-\u009f]"; "");
  "Review for \(.request_id[0:8]) returned at revision \(.revision)",
  "Current status \(.status) at revision \(.lifecycle_revision), custody generation \(.responsibility.custody_generation)",
  (if .delivered then empty else "Review notice undelivered" end),
  (.reason // empty | safe),
  (if (.comments | length) == 0 then "No comments" else .comments[] |
    (if .source.kind == "request_description" then "Description"
     else (.source.path | safe) + " (" + .source.side + ")" end) +
    (if .source.format == "lines" then " lines \(.start_offset + 1)–\(.end_offset)"
     else " offsets \(.start_offset)–\(.end_offset)" end),
    (.quote | safe | split("\n")[] | "> " + .),
    (.body | safe)
  end)'
