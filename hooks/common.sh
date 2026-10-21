# Shared by the Claude lifecycle hooks: read the hook payload, call Mandible
# through the CLI's socket client, and carry the session's own attribution.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/../cli" && pwd)/api.sh"

INPUT=$(cat)
provider_session_id=$(jq -r '.session_id // empty' <<< "$INPUT")

# A nested run inherits its parent's MANDIBLE_SESSION_ID; it keys on its own
# provider session instead (api_scope_inherited_identity).
inherited_session_id="${MANDIBLE_SESSION_ID:-}"
api_scope_inherited_identity || exit 1
[[ -z "${MANDIBLE_SESSION_ID:-}" ]] || inherited_session_id=""
session_id="${MANDIBLE_SESSION_ID:-$provider_session_id}"
[[ -n "$session_id" ]] || { printf 'Mandible hook: no session id in the hook payload.\n' >&2; exit 1; }

# Claude writes a subagent's transcript stream here.
construct_output_path() {
  local cwd_sanitized
  cwd_sanitized=$(echo "$1" | sed 's|^/||' | tr '/ ' '-')
  echo "/private/tmp/claude-$(id -u)/${cwd_sanitized}/tasks/$2.output"
}
