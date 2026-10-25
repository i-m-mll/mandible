#!/usr/bin/env bash
# Retry snapshotted convergence hooks without executing the merge again.
set -euo pipefail
# A self-update can replace the daemon before its response reaches this caller.
export MANDIBLE_HTTP_RETRIES=0
export MANDIBLE_HTTP_TIMEOUT="${MANDIBLE_HTTP_TIMEOUT:-300}"
source "${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/api.sh"
source "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd -P)/command-syntax.sh"

request="" hook="" json=0
binding=$(mandible_bind_main_arguments "auth.retry-convergence" '{"request":{"position":0},"hook":{"option":"hook"},"json":{"option":"json","constant":"1"}}' "$@") || exit $?
eval "$binding"
command -v jq >/dev/null 2>&1 || { printf '%s\n' 'Error: jq is required.' >&2; exit 1; }
payload=$(jq -nc --arg hook "$hook" '{mode: "retry"} + (if $hook == "" then {} else {hook_id: $hook} end)')
response=$(api_send POST "/api/auth/request/$(urlencode "$request")/retry-convergence" "$payload") || {
  printf 'Retry outcome unconfirmed for auth request %s. Inspect with: mandible auth show %s. No automatic retry was sent.\n' "$request" "$request" >&2
  exit 1
}
state=$(printf '%s\n' "$response" | jq -er '.convergence.state') || {
  printf 'Retry outcome unconfirmed. Inspect with: mandible auth show %s.\n' "$request" >&2
  exit 1
}
if [[ "$json" == 1 ]]; then
  printf '%s\n' "$response" | jq .
fi
case "$state" in
  complete)
    if [[ "$json" != 1 ]]; then printf 'Convergence complete for auth request %s.\n' "$request"; fi
    ;;
  pending)
    if [[ "$json" != 1 ]]; then printf 'Convergence retry admitted, still running for auth request %s. Check with: mandible auth show %s.\n' "$request" "$request"; fi
    ;;
  failed)
    if [[ "$json" != 1 ]]; then printf 'Convergence failed for auth request %s. Inspect with: mandible auth show %s.\n' "$request" "$request" >&2; fi
    exit 1
    ;;
  *)
    printf 'Retry outcome unconfirmed (state: %s). Inspect with: mandible auth show %s.\n' "$state" "$request" >&2
    exit 1
    ;;
esac
