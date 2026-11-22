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
      elif [[ "$request_status" == returned ]]; then
        printf 'Auth request %s returned for revision. Review with: mandible auth review show %s\n' "$request_id" "$request_id"
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

# Wait for one request to reach a terminal status and report it; returns 0 only
# for completed. The request is read once the subscription is registered (the
# stream's ": connected" comment), so a resolution that lands between the
# caller's submission and the subscription is still reported. The stream is
# read through a FIFO so the watcher stops curl as soon as it has a result,
# rather than waiting for curl's next write to fail. Requires api.sh.
mandible_auth_watch() {
  local request_id="$1" timeout="$2" short_id fifo config="" token traced=0 result="" final line json curl_pid
  local curl_args=()
  short_id="$(api_short_id "$request_id")"
  case "$-" in *x*) traced=1; { set +x; } 2>/dev/null ;; esac
  token="$(api_client_token POST)"
  if [[ -n "$token" ]]; then
    config="$(api_temp_file)"
    printf 'header = "Authorization: Bearer %s"\n' "$token" > "$config"
  fi
  token=""
  (( traced == 0 )) || set -x
  curl_args=(-sN --max-time "$timeout" -X POST -H 'Content-Type: application/json' --data-binary '{"topics":["auth:"]}')
  api_is_local_socket && curl_args+=(--unix-socket "$MANDIBLE_SOCKET")
  [[ -z "$config" ]] || curl_args+=(--config "$config")
  fifo="$(api_temp_file)"
  rm -f "$fifo"
  mkfifo -m 600 "$fifo"
  curl "${curl_args[@]}" "$(api_base)/api/events/subscribe" > "$fifo" 2>/dev/null &
  curl_pid=$!
  while IFS= read -r line; do
    if [[ "$line" == ": connected"* ]]; then
      json=$(api_get "/api/auth/request/$(urlencode "$request_id")" 2>/dev/null) || continue
    elif [[ "$line" == data:* ]]; then
      json="${line#data: }"
      [[ "$(printf '%s' "$json" | jq -r '.type // empty' 2>/dev/null)" == auth:resolved ]] || continue
      [[ "$(printf '%s' "$json" | jq -r '.data.request_id // .data.id // empty' 2>/dev/null)" == "$request_id" ]] || continue
      json=$(printf '%s' "$json" | jq -c '.data') || continue
    else
      continue
    fi
    result=0
    mandible_auth_report "$short_id" "$json" || result=$?
    [[ "$result" == 2 ]] && { result=""; continue; }
    break
  done < "$fifo"
  kill "$curl_pid" 2>/dev/null || true
  wait "$curl_pid" 2>/dev/null || true
  rm -f "$fifo"
  [[ -z "$config" ]] || rm -f "$config"
  if [[ -n "$result" ]]; then
    [[ "$result" == 0 ]] && return 0
    return 1
  fi
  # Reconcile once after the stream ends, with the same classification.
  final=$(api_get "/api/auth/request/$(urlencode "$request_id")" 2>/dev/null || true)
  if [[ -n "$final" ]]; then
    result=0
    mandible_auth_report "$short_id" "$final" || result=$?
    [[ "$result" == 0 ]] && return 0
    if [[ "$result" == 2 ]]; then
      printf 'Auth request %s: still in progress (%s) after SSE ended; check dashboard.\n' "$short_id" "$(printf '%s' "$final" | jq -r '.status')" >&2
    fi
    return 1
  fi
  printf 'Auth request %s: SSE connection lost, status unknown. Check dashboard.\n' "$short_id" >&2
  return 1
}
