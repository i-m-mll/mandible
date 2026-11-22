#!/usr/bin/env bash
set -euo pipefail
source "${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/api.sh"
source "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd -P)/command-syntax.sh"

command -v jq >/dev/null 2>&1 || { printf '%s\n' 'Error: jq is required.' >&2; exit 1; }
action="$1"
shift
request=""
comment=""
message=""
json=0
case "$action" in
  show) bindings='{"request":{"position":0},"json":{"option":"json","constant":"1"}}' ;;
  reply) bindings='{"request":{"position":0},"comment":{"position":1},"message":{"option":"message"}}' ;;
  address) bindings='{"request":{"position":0},"comment":{"position":1}}' ;;
esac
binding=$(mandible_bind_main_arguments "auth.review.$action" "$bindings" "$@") || exit $?
eval "$binding"

if [[ "$action" != "show" ]]; then
  request_path="/api/auth/request/$(urlencode "$request")"
  current=$(api_get "$request_path") || exit $?
  data=$(printf '%s\n' "$current" | jq -e -c --arg comment "$comment" --arg action "$action" --arg message "$message" '
    .lifecycle_events[-1].revision as $revision | .responsibility.custody_generation as $generation |
    select(($revision | type) == "number" and ($generation | type) == "number") |
    {expected_revision: $revision, expected_custody_generation: $generation, comment_id: $comment,
      mutation: (if $action == "reply" then {operation: "reply", body: $message} else {operation: "address"} end)}') || {
    printf 'Error: lifecycle revision or custody generation missing for %s.\n' "$request" >&2
    exit 1
  }
  response=$(api_send POST "$request_path/review/thread-events" "$data") || exit $?
  printf '%s\n' "$response" | jq -e -r '.event_id[:8]'
  exit
fi

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
  (if .change_edit then "Change edit \(.change_edit.commit_sha)", "Git ref \(.change_edit.ref)",
    ((.replacements // .replacements_error // empty) | safe) else empty end),
  (.answers[]? | "Answer \(.directive_key): \(.value | tojson | safe)"),
  (if (.comments | length) == 0 then "No comments" else .comments[] |
    (if .source.kind == "request_description" then "Description"
     elif .source.kind == "request_narrative" then "Narrative"
     else (.source.path | safe) + " (" + .source.side + ")" end) +
    (if .source.format == "lines" then " lines \(.start_offset + 1)–\(.end_offset)"
     else " offsets \(.start_offset)–\(.end_offset)" end),
    (.quote | safe | split("\n")[] | "> " + .),
    (.body | safe),
    "Comment \(.thread.short_id) [\(if .thread.resolved then "resolved" else "open" end)]",
    (.thread.events[] |
      if .operation == "reply" then "  \(.actor_role) replied: \(.body | safe)"
      elif .operation == "address" then "  Addressed in request \(.request_ref)"
      elif .operation == "resolve" then "  Resolved on request \(.request_ref)"
      else "  Reopened on request \(.request_ref)" end)
  end)'
