#!/usr/bin/env bash
# Inspect or repair one candidate-only pending auth lifecycle snapshot drift.
set -euo pipefail
source "${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/api.sh"
mandible_prepare_syntax_runtime || exit $?

usage='Usage: mandible auth candidate-repair inspect <request> [--operator-recovery] [--json]
       mandible auth candidate-repair apply <request> --expected-revision <n> --expected-custody-generation <n> --expected-current-snapshot-sha256 <sha256> [--operator-recovery] [--json]'
action="${1:-}"
[[ "$action" == inspect || "$action" == apply ]] || { printf '%s\n' "$usage" >&2; exit 2; }
shift
request_id="${1:-}"
[[ -n "$request_id" && "$request_id" != -* ]] || { printf '%s\n' "$usage" >&2; exit 2; }
shift
revision="" generation="" digest="" recovery=false json=0
binding=$(mandible_bind_main_arguments "auth.candidate-repair.${action}" '{"revision":{"option":"expected-revision"},"generation":{"option":"expected-custody-generation"},"digest":{"option":"expected-current-snapshot-sha256"},"recovery":{"option":"operator-recovery","constant":"true"},"json":{"option":"json","constant":"1"}}' "$request_id" "$@") || exit $?
eval "$binding"
if [[ "$action" == apply ]] && { [[ ! "$revision" =~ ^[0-9]+$ ]] || [[ ! "$generation" =~ ^[0-9]+$ ]] || [[ ! "$digest" =~ ^[0-9a-f]{64}$ ]]; }; then
  printf '%s\n' "$usage" >&2
  exit 2
fi
command -v jq >/dev/null 2>&1 || { printf '%s\n' 'Error: jq is required.' >&2; exit 1; }
if [[ "$action" == inspect ]]; then
  payload=$(jq -nc --argjson operator_recovery "$recovery" '{operator_recovery: $operator_recovery}')
else
  payload=$(jq -nc --argjson operator_recovery "$recovery" --argjson expected_revision "$revision" \
    --argjson expected_custody_generation "$generation" --arg expected_current_snapshot_sha256 "$digest" \
    '{operator_recovery: $operator_recovery, expected_revision: $expected_revision,
      expected_custody_generation: $expected_custody_generation,
      expected_current_snapshot_sha256: $expected_current_snapshot_sha256}')
fi
if [[ "$action" == inspect ]]; then
  response=$(api_send POST "/api/auth/request/$(urlencode "$request_id")/candidate-snapshot-repair/inspect" "$payload") || {
    printf 'Error: candidate snapshot inspection refused for auth request %s.\n' "$request_id" >&2
    exit 1
  }
else
  response=$(api_send POST "/api/auth/request/$(urlencode "$request_id")/candidate-snapshot-repair/apply" "$payload") || {
  printf 'Error: candidate snapshot %s refused for auth request %s.\n' "$action" "$request_id" >&2
  exit 1
  }
fi
if [[ "$json" == 1 ]]; then
  printf '%s\n' "$response" | jq .
else
  printf '%s\n' "$response" | jq -r 'if .lifecycle_revision then
    "Candidate-only drift proven for \(.request_id[0:8]): revision \(.lifecycle_revision), custody generation \(.custody_generation), current snapshot \(.current_snapshot_sha256)."
    else "Repaired candidate snapshot for \(.request_id[0:8]); refresh before any further mutation." end'
fi
