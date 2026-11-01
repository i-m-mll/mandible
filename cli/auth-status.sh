source "${MANDIBLE_CLI_DIR:-$MANDIBLE_COMMAND_SYNTAX_DIR}/auth-status.generated.sh"

# Response is the canonical request shape, including for SSE's data envelope.
# In-flight responses are silent so callers can continue waiting.
mandible_auth_report() {
  local request_id="$1" response="$2" request_status classification=0 detail exit_code
  request_status=$(printf '%s' "$response" | jq -r '.status // "unknown"') || return 3
  mandible_auth_classify "$request_status" || classification=$?
  case "$classification" in
    0)
      exit_code=$(printf '%s' "$response" | jq -r '.exit_code // "null"')
      printf 'Auth request %s: completed (exit %s)\n' "$request_id" "$exit_code"
      ;;
    1)
      detail=$(printf '%s' "$response" | jq -r '.failure_reason // .error // "no reason recorded"')
      if [[ "$request_status" == needs_rebase ]]; then
        printf 'Auth request %s: needs_rebase -- rebase the source branch and retry the request. %s\n' "$request_id" "$detail"
      elif [[ "$request_status" == failed ]]; then
        exit_code=$(printf '%s' "$response" | jq -r '.exit_code // "null"')
        printf 'Auth request %s: failed (exit %s) -- %s\n' "$request_id" "$exit_code" "$detail"
      else
        printf 'Auth request %s: %s -- %s\n' "$request_id" "$request_status" "$detail"
      fi
      ;;
    2) ;;
    *) printf "Auth request %s: unknown status '%s'; check dashboard.\n" "$request_id" "$request_status" >&2 ;;
  esac
  return "$classification"
}
