#!/bin/sh

INPUT=$(cat 2>/dev/null || true)

json_field() {
  key=$1
  printf '%s' "$INPUT" |
    tr '\n' ' ' |
    sed -n 's/.*"'"$key"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' |
    sed -n '1p'
}

json_number() {
  key=$1
  printf '%s' "$INPUT" |
    tr '\n' ' ' |
    sed -n 's/.*"'"$key"'"[[:space:]]*:[[:space:]]*\([0-9][0-9.]*\).*/\1/p' |
    sed -n '1p'
}

urlencode() {
  # Session IDs are normally URL-safe. Escape the few shell/common URL
  # delimiters that would break the query parameter.
  printf '%s' "$1" |
    sed 's/%/%25/g; s/ /%20/g; s/#/%23/g; s/&/%26/g; s/?/%3F/g; s/=/%3D/g'
}

session_ref=${MANDIBLE_SESSION_REF:-}
if [ -z "$session_ref" ]; then
  session_ref=$(json_field session_id)
fi
if [ -z "$session_ref" ]; then
  session_ref=$(json_field sessionId)
fi

. "$(dirname "$0")/local-transport.sh"
mandible_hook_transport || exit 0
base=$MANDIBLE_HOOK_BASE
if [ -n "$MANDIBLE_HOOK_SOCKET" ]; then set -- --unix-socket "$MANDIBLE_HOOK_SOCKET"; else set --; fi
url="$base/api/hooks/statusline"
if [ -n "$session_ref" ]; then
  url="$url?sessionRef=$(urlencode "$session_ref")"
fi

if [ -n "$INPUT" ]; then
  curl "$@" -fsS --connect-timeout 0.25 --max-time "${MANDIBLE_HOOK_TIMEOUT:-1}" \
    -H 'Content-Type: application/json' \
    -d "$INPUT" \
    "$url" >/dev/null 2>&1 || true
fi

if [ -n "${MANDIBLE_CHAINED_STATUSLINE:-}" ]; then
  printf '%s' "$INPUT" | sh -c "$MANDIBLE_CHAINED_STATUSLINE"
  exit $?
fi

model=$(json_field display_name)
if [ -z "$model" ]; then
  model=$(json_field model)
fi
if [ -z "$model" ]; then
  model="Claude"
fi

context=$(json_number used_percentage)
if [ -n "$context" ]; then
  printf '%s ctx %s%%\n' "$model" "$context"
else
  printf '%s\n' "$model"
fi
