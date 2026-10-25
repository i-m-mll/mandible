#!/usr/bin/env bash
# mandible auth list: List active Mandible auth requests.
#
# Usage: mandible auth list [options]
source "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd -P)/command-syntax.sh"

set -u
set -o pipefail

# MANDIBLE_PORT and MANDIBLE_BASE are exported by the dispatcher.
API_HELPER="${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/api.sh"
source "$API_HELPER"

json=0
repo_filter=""
head_filter=""
base_filter=""
status_filter=""
type_filter=""

usage() {
  mandible_command_help auth list
}

binding=$(mandible_bind_main_arguments "auth.list" '{"json":{"option":"json","constant":"1"},"repo_filter":{"option":"repo"},"head_filter":{"option":"head"},"base_filter":{"option":"base"},"status_filter":{"option":"status"},"type_filter":{"option":"type"}}' "$@") || exit $?
eval "$binding"

if ! command -v jq >/dev/null 2>&1; then
  printf '%s\n' "Error: jq is required for mandible auth list." >&2
  exit 1
fi

url="/api/auth/queue"
if [[ -n "$type_filter" ]]; then
  url="${url}?type=$(urlencode "$type_filter")"
fi

response=$(api_get "$url" 2>/dev/null) || {
  printf '%s\n' "Error: could not reach Mandible daemon at ${MANDIBLE_BASE}." >&2
  exit 1
}

jq_filter='.requests'
jq_args=()
if [[ -n "$repo_filter" ]]; then
  repo_aliases_json="[]"
  repo_lookup=$(api_get "/api/issues?repo=$(urlencode "$repo_filter")" 2>/dev/null || true)
  if [[ -n "$repo_lookup" ]]; then
    repo_aliases_json=$(printf '%s' "$repo_lookup" \
      | jq -c '[.[] | .repo_id, .repo_name, .repo_root, .project_key | select(. != null and . != "")] | unique' 2>/dev/null \
      || printf '[]')
  fi
  jq_filter="${jq_filter} | map(select(.repo as \$repo_value | \$repo_value == \$repo or ((\$repo_aliases | index(\$repo_value)) != null)))"
  jq_args+=(--arg repo "$repo_filter")
  jq_args+=(--argjson repo_aliases "$repo_aliases_json")
fi
if [[ -n "$head_filter" ]]; then
  jq_filter="${jq_filter} | map(select(.head_branch == \$head))"
  jq_args+=(--arg head "$head_filter")
fi
if [[ -n "$base_filter" ]]; then
  jq_filter="${jq_filter} | map(select(.base_branch == \$base))"
  jq_args+=(--arg base "$base_filter")
fi
if [[ -n "$status_filter" ]]; then
  jq_filter="${jq_filter} | map(select(.status == \$status))"
  jq_args+=(--arg status "$status_filter")
fi

filtered=$(printf '%s' "$response" | jq ${jq_args[@]+"${jq_args[@]}"} "{ requests: (${jq_filter}) }") || {
  printf '%s\n' "Error: auth queue response was not valid JSON." >&2
  exit 1
}

if [[ "$json" == "1" ]]; then
  printf '%s\n' "$filtered"
  exit 0
fi

count=$(printf '%s' "$filtered" | jq '.requests | length')
if [[ "$count" == "0" ]]; then
  printf '%s\n' "Auth queue: no active requests"
  exit 0
fi

printf '%s\n' "Auth queue: ${count} active request(s)"
printf '%s' "$filtered" | api_jq_human '
  .requests[]
  | "[\(mandible_display_id)] \(.status) \(.repo // "-") \(.head_branch // "-") -> \(.base_branch // "-") - \(.title // "(untitled)")",
    (if .status == "failed" then "    failed: \(.failure_reason)" else empty end)
'
