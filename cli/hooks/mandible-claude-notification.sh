#!/bin/sh

INPUT=$(cat 2>/dev/null || true)

json_field() {
  key=$1
  printf '%s' "$INPUT" |
    tr '\n' ' ' |
    sed -n 's/.*"'"$key"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' |
    sed -n '1p'
}

json_escape() {
  printf '%s' "$1" |
    sed 's/\\/\\\\/g; s/"/\\"/g; s/	/\\t/g'
}

session_ref=${MANDIBLE_SESSION_REF:-}
if [ -z "$session_ref" ]; then
  session_ref=$(json_field session_id)
fi
if [ -z "$session_ref" ]; then
  session_ref=$(json_field sessionId)
fi

transcript_path=$(json_field transcript_path)
if [ -z "$transcript_path" ]; then
  transcript_path=$(json_field transcriptPath)
fi

message=$(json_field message)
if [ -z "$message" ]; then
  message=$(json_field notification)
fi

if [ -z "$session_ref" ] && [ -z "$transcript_path" ]; then
  exit 0
fi

payload="{"
sep=""
if [ -n "$session_ref" ]; then
  payload="${payload}${sep}\"sessionRef\":\"$(json_escape "$session_ref")\""
  sep=","
fi
if [ -n "$transcript_path" ]; then
  payload="${payload}${sep}\"transcriptPath\":\"$(json_escape "$transcript_path")\""
  sep=","
fi
if [ -n "$message" ]; then
  payload="${payload}${sep}\"message\":\"$(json_escape "$message")\""
fi
payload="${payload}}"

. "$(dirname "$0")/local-transport.sh"
mandible_hook_transport || exit 0
base=$MANDIBLE_HOOK_BASE
if [ -n "$MANDIBLE_HOOK_SOCKET" ]; then set -- --unix-socket "$MANDIBLE_HOOK_SOCKET"; else set --; fi
# Hook input owns the Claude provider ID; sessionRef may be a Mandible alias.
set -- "$@" -H 'X-Mandible-Managed-Client: 1'
hook_provider_id=$(mandible_hook_provider_session_id "$(json_field session_id)" 2>/dev/null) || hook_provider_id=
if [ -n "$hook_provider_id" ]; then
  set -- "$@" -H 'X-Mandible-Ambient-Provider: claude' \
    -H "X-Mandible-Ambient-Provider-Session-Id: $hook_provider_id"
fi
if mandible_hook_alias_valid "${MANDIBLE_MANAGED_APP:-}" "${MANDIBLE_SESSION_ID:-}"; then
  set -- "$@" -H "X-Mandible-Managed-App: $MANDIBLE_MANAGED_APP" \
    -H "X-Mandible-Managed-Session-Id: $MANDIBLE_SESSION_ID"
fi
curl "$@" -fsS --connect-timeout 0.25 --max-time "${MANDIBLE_HOOK_TIMEOUT:-1}" \
  -H 'Content-Type: application/json' \
  -d "$payload" \
  "$base/api/hooks/notification" >/dev/null 2>&1 || true

exit 0
