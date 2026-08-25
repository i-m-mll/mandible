#!/usr/bin/env bash
set -euo pipefail

source "${MANDIBLE_CLI_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}/api.sh"

usage() {
  cat <<'EOF'
Usage: mandible auth clearance <command> [options]

Commands:
  create --grantee <user> [--request <request-id>] [--project <project> --base <branch>]
         [--issue <ref>] [--head <branch>] [--credential <id>]
         [--duration-minutes <n>] [--max-uses <n>] [--json]
  list [--request <request-id>] [--json]
  show <clearance-id> [--json]
  revoke <clearance-id> [--json]
  execute <request-id> [--json]
EOF
}

command_name="${1:-}"
[[ -n "$command_name" ]] || { usage >&2; exit 2; }
shift
json=0
case "$command_name" in
  create)
    request_id=""; grantee=""; credential=""; project=""; base=""; issue=""; head=""; duration=""; max_uses=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --request) request_id="${2:-}"; shift 2 ;;
        --grantee) grantee="${2:-}"; shift 2 ;;
        --credential) credential="${2:-}"; shift 2 ;;
        --project) project="${2:-}"; shift 2 ;;
        --base) base="${2:-}"; shift 2 ;;
        --issue) issue="${2:-}"; shift 2 ;;
        --head) head="${2:-}"; shift 2 ;;
        --duration-minutes) duration="${2:-}"; shift 2 ;;
        --max-uses) max_uses="${2:-}"; shift 2 ;;
        --json) json=1; shift ;;
        *) printf 'Unknown option: %s\n' "$1" >&2; exit 2 ;;
      esac
    done
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
    response=$(api_mutate POST "/api/auth/clearances" "$payload") ;;
  list)
    request_id=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --request) request_id="${2:-}"; shift 2 ;;
        --json) json=1; shift ;;
        *) printf 'Unknown option: %s\n' "$1" >&2; exit 2 ;;
      esac
    done
    if [[ -n "$request_id" ]]; then
      response=$(api_get "/api/auth/clearances?request_id=$(jq -rn --arg v "$request_id" '$v|@uri')")
    else
      response=$(api_get "/api/auth/clearances")
    fi ;;
  show)
    clearance_id="${1:-}"; [[ -n "$clearance_id" ]] || { usage >&2; exit 2; }; shift
    [[ "${1:-}" != "--json" ]] || { json=1; shift; }
    [[ $# -eq 0 ]] || { usage >&2; exit 2; }
    response=$(api_get "/api/auth/clearances/$clearance_id") ;;
  revoke)
    clearance_id="${1:-}"; [[ -n "$clearance_id" ]] || { usage >&2; exit 2; }; shift
    [[ "${1:-}" != "--json" ]] || { json=1; shift; }
    [[ $# -eq 0 ]] || { usage >&2; exit 2; }
    response=$(api_mutate POST "/api/auth/clearances/$clearance_id/revoke" '{}') ;;
  execute)
    request_id="${1:-}"; [[ -n "$request_id" ]] || { usage >&2; exit 2; }; shift
    [[ "${1:-}" != "--json" ]] || { json=1; shift; }
    [[ $# -eq 0 ]] || { usage >&2; exit 2; }
    response=$(api_mutate POST "/api/auth/request/$request_id/clearance/execute" '{}') ;;
  help|-h|--help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac

if [[ "$json" -eq 1 ]]; then
  printf '%s\n' "$response" | jq .
else
  printf '%s\n' "$response" | jq .
fi
