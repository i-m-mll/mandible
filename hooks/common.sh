# Shared by the Claude lifecycle hooks: read the hook payload, call Mandible
# through the CLI's socket client, and carry the session's own attribution.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/../cli" && pwd)/api.sh"

INPUT=$(cat)
provider_session_id=$(jq -r '.session_id // empty' <<< "$INPUT")
session_id="${MANDIBLE_SESSION_ID:-$provider_session_id}"
[[ -n "$session_id" ]] || { printf 'Mandible hook: no session id in the hook payload.\n' >&2; exit 1; }
if [[ -z "${CODEX_THREAD_ID:-}" ]]; then
  export CLAUDE_CODE_SESSION_ID="${CLAUDE_CODE_SESSION_ID:-$provider_session_id}"
fi

# Claude writes a subagent's transcript stream here.
construct_output_path() {
  local cwd_sanitized
  cwd_sanitized=$(echo "$1" | sed 's|^/||' | tr '/ ' '-')
  echo "/private/tmp/claude-$(id -u)/${cwd_sanitized}/tasks/$2.output"
}
