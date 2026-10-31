#!/usr/bin/env bash
set -euo pipefail
source "${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/api.sh"
mandible_prepare_syntax_runtime || exit $?
action="${1:-}"
shift
case "$action" in assume|release) ;; *) printf 'Expected assume or release\n' >&2; exit 2 ;; esac
request_id="" reason="" expected_revision="" expected_custody_generation="" session="" json=0
binding=$(mandible_bind_main_arguments "auth.responsibility.$action" '{"request_id":{"position":0},"reason":{"option":"reason"},"expected_revision":{"option":"expected-revision"},"expected_custody_generation":{"option":"expected-custody-generation"},"session":{"option":"session"},"json":{"option":"json","constant":"1"}}' "$@") || exit $?
eval "$binding"
[[ -n "$request_id" && -n "${reason//[[:space:]]/}" && "$expected_revision" =~ ^[0-9]+$ && "$expected_custody_generation" =~ ^[0-9]+$ ]] || exit 2
payload=$(jq -nc --arg reason "$reason" --arg session "$session" --argjson revision "$expected_revision" --argjson generation "$expected_custody_generation" '{reason:$reason,expected_revision:$revision,expected_custody_generation:$generation} + (if $session == "" then {} else {target_session_id:$session} end)')
api_send POST "/api/auth/request/$(urlencode "$request_id")/responsibility/$action" "$payload"
