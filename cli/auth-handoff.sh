#!/usr/bin/env bash
# Inspect the runtime handoff lock, or retire a failed one as the operator.
set -euo pipefail
source "${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/api.sh"
source "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd -P)/command-syntax.sh"

usage='Usage: mandible auth handoff status [--json]
       mandible auth handoff retire --binding-digest <sha256> --reason <text> [--json]'
action="${1:-}"
[[ "$action" == status || "$action" == retire ]] || { printf '%s\n' "$usage" >&2; exit 2; }
shift
digest="" reason="" json=0
if [[ "$action" == status ]]; then
  binding=$(mandible_bind_main_arguments "auth.handoff.status" '{"json":{"option":"json","constant":"1"}}' "$@") || exit $?
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
