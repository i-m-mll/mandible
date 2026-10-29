#!/usr/bin/env bash
set -euo pipefail
export MANDIBLE_HTTP_RETRIES=0
source "${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/api.sh"
mandible_prepare_syntax_runtime || exit $?
request="" reason="" revision="" generation="" recovery=false json=0
binding=$(mandible_bind_main_arguments "auth.retire-delivery" '{"request":{"position":0},"reason":{"option":"reason"},"revision":{"option":"expected-revision"},"generation":{"option":"expected-custody-generation"},"recovery":{"option":"operator-recovery","constant":"true"},"json":{"option":"json","constant":"1"}}' "$@") || exit $?
eval "$binding"
[[ -n "${reason//[[:space:]]/}" && "$revision" =~ ^[0-9]+$ && "$generation" =~ ^[0-9]+$ ]] || { mandible_command_help auth retire-delivery >&2; exit 2; }
payload=$(jq -nc --arg reason "$reason" --argjson expected_revision "$revision" --argjson expected_custody_generation "$generation" --argjson operator_recovery "$recovery" '{reason:$reason,expected_revision:$expected_revision,expected_custody_generation:$expected_custody_generation,operator_recovery:$operator_recovery}')
response=$(api_send POST "/api/auth/request/$(urlencode "$request")/retire-delivery" "$payload") || {
  printf 'Retirement outcome unconfirmed for %s. Inspect auth show before retrying with fresh lifecycle/custody preconditions.\n' "$request" >&2
  exit 1
}
if [[ "$json" == 1 ]]; then printf '%s\n' "$response" | jq .;
else printf '%s\n' "$response" | jq -r '"Delivery \(.retirement.state); cleanup \(.retirement.cleanup). Historical convergence remains failed."'; fi
