#!/usr/bin/env bash
# mandible auth watch: wait for one auth request to settle and report its
# outcome. Exit 0 only when it completed.
#
# Usage: {{command auth.watch}}
set -euo pipefail
source "${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/api.sh"
source "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd -P)/command-syntax.sh"
source "${MANDIBLE_CLI_DIR:-$MANDIBLE_COMMAND_SYNTAX_DIR}/auth-status.sh"

request=""
timeout=""
binding=$(mandible_bind_main_arguments "auth.watch" '{"request":{"position":0},"timeout":{"option":"timeout"}}' "$@") || exit $?
eval "$binding"
if api_is_file_rpc; then
  printf '%s\n' 'Error: file transport does not support SSE; auth watch needs the daemon socket or HTTP.' >&2
  exit 2
fi
command -v jq >/dev/null 2>&1 || { printf '%s\n' 'Error: jq is required.' >&2; exit 1; }
response=$(api_get "/api/auth/request/$(urlencode "$request")") || { printf 'Error: could not read auth request %s.\n' "$request" >&2; exit 1; }
request_id=$(jq -er '.request_id' <<<"$response") || { printf 'Error: no request_id for auth request %s.\n' "$request" >&2; exit 1; }
mandible_auth_watch "$request_id" ${timeout:+"$timeout"}
