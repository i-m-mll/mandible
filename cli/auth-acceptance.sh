#!/usr/bin/env bash
# Rerun or show daemon-run candidate acceptance of one runtime self-update
# request. The daemon also runs acceptance automatically (issue 7d83fe5).
set -euo pipefail
source "${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/api.sh"
source "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd -P)/command-syntax.sh"

usage='Usage: mandible auth acceptance run <request> [--json]
       mandible auth acceptance show <request> [--json]'
action="${1:-}"
[[ "$action" == run || "$action" == show ]] || { printf '%s\n' "$usage" >&2; exit 2; }
shift
request=""
json=0
binding=$(mandible_bind_main_arguments "auth.acceptance.${action}" '{"request":{"position":0},"json":{"option":"json","constant":"1"}}' "$@") || exit $?
eval "$binding"
[[ -n "$request" ]] || { printf '%s\n' "$usage" >&2; exit 2; }
command -v jq >/dev/null 2>&1 || { printf '%s\n' 'Error: jq is required.' >&2; exit 1; }
encoded=$(urlencode "$request")
if [[ "$action" == run ]]; then
  response=$(api_send POST "/api/auth/request/${encoded}/candidate-acceptance" '{}') || { printf 'Error: candidate acceptance refused for auth request %s.\n' "$request" >&2; exit 1; }
else
  response=$(api_get "/api/auth/request/${encoded}/candidate-acceptance") || { printf 'Error: could not read candidate acceptance for auth request %s.\n' "$request" >&2; exit 1; }
fi
if [[ "$json" == 1 ]]; then
  printf '%s\n' "$response" | jq .
else
  printf '%s\n' "$response" | jq -r '
    if .acceptance == null then "Candidate acceptance does not apply to \(.request_id[0:8])."
    else .acceptance as $a |
      "Candidate acceptance for \(.request_id[0:8]): \($a.state)",
      (if $a.reason then "  \($a.reason)" else empty end),
      (if $a.state == "running" then "  check again with: mandible auth acceptance show \(.request_id[0:8])" else empty end)
    end'
fi
