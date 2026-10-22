#!/usr/bin/env bash
# mandible auth withdraw: requester-authenticated withdrawal of one pending request.

set -euo pipefail
source "${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/api.sh"
mandible_prepare_syntax_runtime || exit $?

request_id=""
reason=""
expected_revision=""
expected_custody_generation=""
json=0
binding=$(mandible_bind_main_arguments "auth.withdraw" '{"request_id":{"position":0},"reason":{"option":"reason"},"expected_revision":{"option":"expected-revision"},"expected_custody_generation":{"option":"expected-custody-generation"},"json":{"option":"json","constant":"1"}}' "$@") || exit $?
eval "$binding"
[[ -n "$request_id" && -n "${reason//[[:space:]]/}" && "$expected_revision" =~ ^[0-9]+$ && "$expected_custody_generation" =~ ^[0-9]+$ ]] || {
  printf '%s\n' 'Usage: mandible auth withdraw <request> --reason <text> --expected-revision <n> --expected-custody-generation <n> [--json]' >&2
  exit 2
}
command -v jq >/dev/null 2>&1 || { printf '%s\n' 'Error: jq is required.' >&2; exit 1; }
payload=$(jq -nc --arg reason "$reason" --argjson expected_revision "$expected_revision" --argjson expected_custody_generation "$expected_custody_generation" '{
  reason: $reason,
  expected_revision: $expected_revision,
  expected_custody_generation: $expected_custody_generation
}')
response=$(api_send POST "/api/auth/request/$(urlencode "$request_id")/withdraw" "$payload") || {
  printf 'Error: withdrawal refused for auth request %s.\n' "$request_id" >&2
  exit 1
}
if [[ "$json" == 1 ]]; then
  printf '%s\n' "$response" | jq .
else
  printf '%s\n' "$response" | jq -r '"Withdrew auth request \(.request_id[0:8]) (\(.status))."'
fi
