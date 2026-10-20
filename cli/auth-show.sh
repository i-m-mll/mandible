#!/usr/bin/env bash
# Show one auth request with its protected-base history audit (issue 117ba80).
set -euo pipefail
source "${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/api.sh"
source "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd -P)/command-syntax.sh"

usage='Usage: mandible auth show <request> [--json]'
request=""
json=0
binding=$(mandible_bind_main_arguments "auth.show" '{"request":{"position":0},"json":{"option":"json","constant":"1"}}' "$@") || exit $?
eval "$binding"
[[ -n "$request" ]] || { printf '%s\n' "$usage" >&2; exit 2; }
command -v jq >/dev/null 2>&1 || { printf '%s\n' 'Error: jq is required.' >&2; exit 1; }
response=$(api_get "/api/auth/request/$(urlencode "$request")") || { printf 'Error: could not read auth request %s.\n' "$request" >&2; exit 1; }
if [[ "$json" == 1 ]]; then
  printf '%s\n' "$response" | jq .
  exit 0
fi
printf '%s\n' "$response" | jq -r '
  "\(.id[0:8]) [\(.status)] \(.title)",
  (if .base_branch then "  \(.repo // "?"): \(.head_branch // "?") -> \(.base_branch)" else empty end),
  (if .merge_preflight_base_sha then "  reviewed base \(.merge_preflight_base_sha[0:10])" else empty end),
  (.base_audit as $a |
    if $a == null then empty
    elif $a.status == "clean" then "  base history: clean (\($a.checked_commits) commit(s) since the last Mandible merge)"
    elif $a.status == "no_baseline" then "  base history: not checked (no recorded Mandible merge into this branch)"
    elif $a.status == "error" then "  base history: check failed: \($a.error)"
    else
      "  base history: commits that are neither recorded Mandible merges nor operator-signed:",
      ($a.unexpected[] | "    \(.sha[0:10]) \(.subject) (\(if .signer then "signed by \(.signer)" else "unsigned" end))"),
      ($a.missing_merges[] | "    \(.[0:10]) recorded Mandible merge no longer in the branch history"),
      (if $a.truncated then "    only the newest \($a.checked_commits) commits were checked" else empty end)
    end)'
