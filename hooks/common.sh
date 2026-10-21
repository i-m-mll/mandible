# Shared by the Claude lifecycle hooks: read the hook payload, call Mandible
# through the CLI's socket client, and carry the session's own attribution.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/../cli" && pwd)/api.sh"

INPUT=$(cat)
provider_session_id=$(jq -r '.session_id // empty' <<< "$INPUT")

# MANDIBLE_SESSION_ID names the session of the process `mandible wrap` exec'd,
# and its row records that process's pid. Every descendant inherits the
# variable, so a nested `claude -p` must not take it for its own: it belongs to
# this process only while its row is unbound or bound to this Claude process.
# An inherited one is treated as unset.
session_id="$provider_session_id"
inherited_session_id=""
if [[ -n "${MANDIBLE_SESSION_ID:-}" ]]; then
  session_row=$(api_temp_file) || exit 1
  session_status=$(api_capture GET "/api/sessions/$(urlencode "$MANDIBLE_SESSION_ID")" "" "$session_row")
  case "$session_status" in
    200) owner_pid=$(jq -r '.pid // empty' "$session_row") ;;
    404) owner_pid="" ;;
    *) rm -f "$session_row"; printf 'Mandible hook: could not read session %s (HTTP %s).\n' "$MANDIBLE_SESSION_ID" "$session_status" >&2; exit 1 ;;
  esac
  rm -f "$session_row"
  if [[ -z "$owner_pid" || "$owner_pid" == "${CLAUDE_PID:-}" ]]; then
    session_id="$MANDIBLE_SESSION_ID"
  else
    inherited_session_id="$MANDIBLE_SESSION_ID"
  fi
fi
[[ -n "$session_id" ]] || { printf 'Mandible hook: no session id in the hook payload.\n' >&2; exit 1; }

# Claude writes a subagent's transcript stream here.
construct_output_path() {
  local cwd_sanitized
  cwd_sanitized=$(echo "$1" | sed 's|^/||' | tr '/ ' '-')
  echo "/private/tmp/claude-$(id -u)/${cwd_sanitized}/tasks/$2.output"
}
