#!/usr/bin/env bash
# mandible commit: the operator's direct commit of the staged changes in a
# protected checkout, as `git commit -m` would make it, signed with the
# approval key after one Touch ID match. Exit 0 committed, 1 refused or
# cancelled with nothing changed, 2 usage, 130 interrupted.

set -euo pipefail
source "${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/api.sh"
mandible_prepare_syntax_runtime || exit $?

message=""
binding=$(mandible_bind_main_arguments "commit" '{"message":{"option":["m","message"]}}' "$@") || exit $?
eval "$binding"
[[ -n "${message//[[:space:]]/}" ]] || {
  printf '%s\n' 'Usage: mandible commit -m <message>' >&2
  exit 2
}
if api_managed_client_markers_present; then
  printf '%s\n' 'Error: mandible commit is the operator'\''s own command; agent and managed sessions cannot commit to a protected branch.' >&2
  exit 1
fi
command -v jq >/dev/null 2>&1 || { printf '%s\n' 'Error: jq is required.' >&2; exit 1; }
checkout=$(git rev-parse --show-toplevel 2>/dev/null) \
  || { printf '%s\n' 'Error: mandible commit runs in a Git checkout.' >&2; exit 1; }

response_file=$(api_temp_file)
status_file=$(api_temp_file)
kill_tree() {
  local child
  for child in $(pgrep -P "$1" 2>/dev/null); do kill_tree "$child"; done
  kill -TERM "$1" 2>/dev/null || true
}

commit_pid=""
interrupted() {
  trap - INT TERM
  # Closing the connection dismisses the sheet; nothing is committed.
  [[ -z "$commit_pid" ]] || { kill_tree "$commit_pid"; wait "$commit_pid" 2>/dev/null || true; }
  printf '%s\n' 'Commit cancelled; nothing was committed.' >&2
  api_cleanup_temp_files
  exit 130
}
trap interrupted INT TERM
# The call holds the sheet open; it runs in the background so INT and TERM
# interrupt it at once. Retries stay off: a retry would raise a second sheet.
(
  MANDIBLE_HTTP_RETRIES=0 MANDIBLE_HTTP_TIMEOUT=75
  api_send_capture POST /api/auth/commit "$(jq -nc --arg cwd "$checkout" --arg message "$message" '{cwd: $cwd, message: $message}')" "$response_file" > "$status_file"
) &
commit_pid=$!
wait "$commit_pid" || true
trap - INT TERM

http_status=$(cat "$status_file")
if [[ "$http_status" != 201 ]]; then
  detail=$(jq -r '[.error, .code] | map(select(. != null)) | join(" ")' "$response_file" 2>/dev/null || true)
  printf 'Error: not committed (HTTP %s)%s\n' "$http_status" "${detail:+: $detail}" >&2
  exit 1
fi
jq -r '"[\(.branch) \(.commit_sha[0:7])] \(.title)\n \(.files_changed) file\(if .files_changed == 1 then "" else "s" end) changed, \(.additions) insertions(+), \(.deletions) deletions(-)\nauth request \(.request_id[0:8])"' "$response_file"
