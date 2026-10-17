#!/usr/bin/env bash
# Inspect the runtime handoff lock, recover a failed handoff whose exact
# generation is live, or retire a failed lock as the operator.
set -euo pipefail
# Verification-only recovery observes the running daemon for over 31 seconds.
export MANDIBLE_HTTP_TIMEOUT="${MANDIBLE_HTTP_TIMEOUT:-300}"
source "${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/api.sh"
source "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd -P)/command-syntax.sh"

usage='Usage: mandible auth handoff status [--json]
       mandible auth handoff recover <request> [--operator-recovery] [--json]
       mandible auth handoff retire --binding-digest <sha256> --reason <text> [--json]'
action="${1:-}"
[[ "$action" == status || "$action" == recover || "$action" == retire ]] || { printf '%s\n' "$usage" >&2; exit 2; }
shift
digest="" reason="" json=0 recovery=false request_id=""
if [[ "$action" == status ]]; then
  binding=$(mandible_bind_main_arguments "auth.handoff.status" '{"json":{"option":"json","constant":"1"}}' "$@") || exit $?
elif [[ "$action" == recover ]]; then
  request_id="${1:-}"
  [[ -n "$request_id" && "$request_id" != -* ]] || { printf '%s\n' "$usage" >&2; exit 2; }
  shift
  binding=$(mandible_bind_main_arguments "auth.handoff.recover" '{"recovery":{"option":"operator-recovery","constant":"true"},"json":{"option":"json","constant":"1"}}' "$request_id" "$@") || exit $?
else
  binding=$(mandible_bind_main_arguments "auth.handoff.retire" '{"digest":{"option":"binding-digest"},"reason":{"option":"reason"},"json":{"option":"json","constant":"1"}}' "$@") || exit $?
fi
eval "$binding"
command -v jq >/dev/null 2>&1 || { printf '%s\n' 'Error: jq is required.' >&2; exit 1; }
if [[ "$action" == status ]]; then
  response=$(api_get "/api/runtime-handoff/lock") || { printf '%s\n' 'Error: could not read the runtime handoff lock.' >&2; exit 1; }
  if [[ "$json" == 1 ]]; then printf '%s\n' "$response" | jq .; exit 0; fi
  printf '%s\n' "$response" | jq -r '
    if .lock == null then "No runtime handoff lock is held."
    else .lock as $l |
      "Runtime handoff lock held: \($l.file)",
      "  request \(($l.requestId // "unknown")[0:8]) phase \($l.phase // "unknown")",
      (if $l.error then "  error: \($l.error)" else empty end),
      "  journal \($l.journalPath // "unknown")",
      "  binding digest \($l.bindingDigest // "unknown")"
    end'
  exit 0
fi
if [[ "$action" == recover ]]; then
  # The daemon re-verifies the exact live generation and settles convergence;
  # it never reruns the merge, a build, an installer or a restart.
  payload=$(jq -nc --argjson operator_recovery "$recovery" '{mode: "verify-current", operator_recovery: $operator_recovery}')
  response=$(api_send POST "/api/auth/request/$(urlencode "$request_id")/retry-convergence" "$payload") || {
    printf 'Error: verification-only recovery refused for auth request %s; the failed handoff and its evidence are unchanged.\n' "$request_id" >&2
    exit 1
  }
  if [[ "$json" == 1 ]]; then printf '%s\n' "$response" | jq .; exit 0; fi
  printf '%s\n' "$response" | jq -r '"Recovered the runtime handoff for request \(.request_id[0:8]): convergence \(.convergence.state)."'
  exit 0
fi
if [[ ! "$digest" =~ ^[0-9a-f]{64}$ || -z "${reason//[[:space:]]/}" ]]; then
  printf '%s\n' "$usage" >&2
  exit 2
fi
payload=$(jq -nc --arg binding_digest "$digest" --arg reason "$reason" '{binding_digest: $binding_digest, reason: $reason}')
response=$(api_send POST "/api/runtime-handoff/retire" "$payload") || { printf '%s\n' 'Error: runtime handoff retirement refused.' >&2; exit 1; }
if [[ "$json" == 1 ]]; then
  printf '%s\n' "$response" | jq .
else
  printf '%s\n' "$response" | jq -r '.retirement as $r |
    "Retired the failed runtime handoff for request \($r.requestId[0:8]); its journal and retirement record remain in place as evidence."'
fi
