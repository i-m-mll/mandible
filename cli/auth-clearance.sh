#!/usr/bin/env bash
set -euo pipefail

source "${MANDIBLE_CLI_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}/api.sh"
mandible_prepare_syntax_runtime || exit $?

usage() {
  mandible_command_help auth clearance
}

command_name="${1:-}"
[[ -n "$command_name" ]] || { usage >&2; exit 2; }
shift
case "$command_name" in
  create)
    request_id=""; grantee=""; credential=""; project=""; base=""; issue=""; head=""; duration=""; max_uses=""
    binding=$(mandible_bind_main_arguments "auth.clearance.create" '{"json":{"option":"json","inert":true},"request_id":{"option":"request"},"grantee":{"option":"grantee"},"credential":{"option":"credential"},"project":{"option":"project"},"base":{"option":"base"},"issue":{"option":"issue"},"head":{"option":"head"},"duration":{"option":"duration-minutes"},"max_uses":{"option":"max-uses"}}' "$@") || exit $?
    eval "$binding"
    [[ -n "$grantee" && ( -n "$issue" || -n "$head" ) ]] || { usage >&2; exit 2; }
    [[ -n "$request_id" || ( -n "$project" && -n "$base" ) ]] || { usage >&2; exit 2; }
    payload=$(jq -n \
      --arg request_id "$request_id" --arg grantee "$grantee" --arg credential "$credential" \
      --arg project "$project" --arg base "$base" --arg issue "$issue" --arg head "$head" \
      --arg duration "$duration" --arg max_uses "$max_uses" \
      '{grantee:$grantee,action:"merge"}
       + (if $request_id == "" then {} else {request_id:$request_id} end)
       + (if $credential == "" then {} else {grantee_credential_id:$credential} end)
       + (if $project == "" then {} else {project:$project} end)
       + (if $base == "" then {} else {base:$base} end)
       + (if $issue == "" then {} else {issue:$issue} end)
       + (if $head == "" then {} else {head:$head} end)
       + (if $duration == "" then {} else {duration_minutes:($duration|tonumber)} end)
       + (if $max_uses == "" then {} else {max_uses:($max_uses|tonumber)} end)')
    response=$(api_send POST "/api/auth/clearances" "$payload") ;;
  list)
    request_id=""
    binding=$(mandible_bind_main_arguments "auth.clearance.list" '{"json":{"option":"json","inert":true},"request_id":{"option":"request"}}' "$@") || exit $?
    eval "$binding"
    if [[ -n "$request_id" ]]; then
      response=$(api_get "/api/auth/clearances?request_id=$(jq -rn --arg v "$request_id" '$v|@uri')")
    else
      response=$(api_get "/api/auth/clearances")
    fi ;;
  show)
    clearance_id=""
    binding=$(mandible_bind_main_arguments "auth.clearance.show" '{"json":{"option":"json","inert":true},"clearance_id":{"position":0}}' "$@") || exit $?
    eval "$binding"
    response=$(api_get "/api/auth/clearances/$clearance_id") ;;
  revoke)
    clearance_id=""
    binding=$(mandible_bind_main_arguments "auth.clearance.revoke" '{"json":{"option":"json","inert":true},"clearance_id":{"position":0}}' "$@") || exit $?
    eval "$binding"
    response=$(api_send POST "/api/auth/clearances/$clearance_id/revoke" '{}') ;;
  execute)
    request_id=""
    binding=$(mandible_bind_main_arguments "auth.clearance.execute" '{"json":{"option":"json","inert":true},"request_id":{"position":0}}' "$@") || exit $?
    eval "$binding"
    response=$(api_send POST "/api/auth/request/$request_id/clearance/execute" '{}') ;;
  help|-h|--help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac

# --json is inert: this command has no human rendering and always emits API JSON.
printf '%s\n' "$response" | jq .
