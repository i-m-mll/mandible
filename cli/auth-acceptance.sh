#!/usr/bin/env bash
# Run or show daemon-run candidate acceptance of one runtime self-update request.
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
binding=$(mandible_bind_main_arguments "auth.acceptance.${action}" '{"json":{"option":"json","constant":"1"}}' "$request" "$@") || exit $?
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
    if .acceptance == null then "No candidate acceptance has run for \(.request_id[0:8])."
    else .acceptance as $a |
      "Candidate acceptance for \($a.auth_request_id[0:8]): \($a.status)",
      "  candidate pin \($a.pin_sha[0:12]) tree \($a.tree_sha[0:12]) base \($a.base_sha[0:12]) head \($a.head_sha[0:12])",
      (if $a.error then "  error: \($a.error)" else empty end),
      (if $a.status == "running" then "  check again with: mandible auth acceptance show \($a.auth_request_id[0:8])" else empty end)
    end'
fi
