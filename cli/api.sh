#!/usr/bin/env bash

: "${MANDIBLE_PORT:=19420}"
: "${MANDIBLE_BASE:=http://127.0.0.1:${MANDIBLE_PORT}}"

api_base() {
  printf '%s' "$MANDIBLE_BASE"
}

api_is_file_rpc() {
  [[ "${MANDIBLE_BASE}" == file://* ]]
}

api_file_rpc_dir() {
  local value="${MANDIBLE_BASE#file://}"
  case "$value" in
    localhost/*) printf '/%s' "${value#localhost/}" ;;
    /*) printf '%s' "$value" ;;
    *) printf '%s' "$value" ;;
  esac
}

api_ambient_provider() {
  if [[ -n "${CODEX_THREAD_ID:-}" ]]; then
    printf 'codex'
  fi
}

api_ambient_session_id() {
  if [[ -n "${CODEX_THREAD_ID:-}" ]]; then
    printf '%s' "$CODEX_THREAD_ID"
  fi
}

api_curl_ambient_headers() {
  local method="$1"
  local provider session_id
  [[ "$method" != "GET" ]] || return 0
  provider=$(api_ambient_provider)
  session_id=$(api_ambient_session_id)
  [[ -n "$provider" && -n "$session_id" ]] || return 0
  printf '%s\0%s\0%s\0%s\0' \
    '-H' "X-Mandible-Ambient-Provider: ${provider}" \
    '-H' "X-Mandible-Ambient-Provider-Session-Id: ${session_id}"
}

urlencode() {
  jq -rn --arg value "$1" '$value|@uri'
}

api_get() {
  local request_path="$1"
  api_request GET "$request_path" ""
}

api_send() {
  local method="$1"
  local request_path="$2"
  local data="$3"
  api_request "$method" "$request_path" "$data"
}

api_send_capture() {
  local method="$1"
  local request_path="$2"
  local data="$3"
  local output_file="$4"

  api_capture "$method" "$request_path" "$data" "$output_file"
}

api_capture() {
  local method="$1"
  local request_path="$2"
  local data="$3"
  local output_file="$4"
  local ambient_headers=()

  if api_is_file_rpc; then
    api_file_rpc_exchange "$method" "$request_path" "$data" "$output_file"
    return
  fi

  if [[ "$method" != "GET" ]]; then
    while IFS= read -r -d '' header_arg; do
      ambient_headers+=("$header_arg")
    done < <(api_curl_ambient_headers "$method")
  fi

  if [[ "$method" == "GET" ]]; then
    curl -s --max-time 15 -o "$output_file" -w "%{http_code}" \
      "$(api_base)$request_path" 2>/dev/null || printf ''
    return
  fi

  curl -s --max-time 15 -o "$output_file" -w "%{http_code}" \
    -X "$method" "$(api_base)$request_path" \
    -H 'Content-Type: application/json' \
    "${ambient_headers[@]}" \
    -d "$data" 2>/dev/null || printf ''
}

api_file_rpc_cleanup() {
  # Cleanup is best-effort: create-only sandbox mounts can allow response reads
  # while denying unlink, and the command exit code must reflect the API result.
  rm -f "$1" 2>/dev/null || true
}

api_request() {
  local method="$1"
  local request_path="$2"
  local data="${3:-}"
  local tmp_response response_status
  local ambient_headers=()

  if api_is_file_rpc; then
    tmp_response=$(mktemp)
    response_status=$(api_file_rpc_exchange "$method" "$request_path" "$data" "$tmp_response")
    if [[ "$response_status" =~ ^2 ]]; then
      cat "$tmp_response"
      rm -f "$tmp_response"
      return 0
    fi
    rm -f "$tmp_response"
    return 22
  fi

  if [[ "$method" == "GET" ]]; then
    curl -sf --max-time 15 "$(api_base)$request_path"
  else
    while IFS= read -r -d '' header_arg; do
      ambient_headers+=("$header_arg")
    done < <(api_curl_ambient_headers "$method")
    curl -sf --max-time 15 -X "$method" "$(api_base)$request_path" \
      -H 'Content-Type: application/json' \
      "${ambient_headers[@]}" \
      -d "$data"
  fi
}

api_file_rpc_exchange() {
  local method="$1"
  local request_path="$2"
  local data="${3:-}"
  local output_file="$4"
  local dir request_id request_tmp request_file response_file deadline response response_status
  local provider session_id

  dir=$(api_file_rpc_dir)
  mkdir -p "$dir"
  request_id="cli-$RANDOM-$$-$(date +%s)"
  request_tmp="${dir}/${request_id}.request.json.tmp"
  request_file="${dir}/${request_id}.request.json"
  response_file="${dir}/${request_id}.response.json"
  provider=$(api_ambient_provider)
  session_id=$(api_ambient_session_id)

  if [[ -n "$data" ]]; then
    jq -n \
      --arg id "$request_id" \
      --arg method "$method" \
      --arg path "$request_path" \
      --arg provider "$provider" \
      --arg provider_session_id "$session_id" \
      --argjson body "$data" \
      '{id:$id, method:$method, path:$path, body:$body}
       + (if $method != "GET" and $provider != "" and $provider_session_id != ""
          then {ambient_identity:{provider:$provider, provider_session_id:$provider_session_id}}
          else {} end)' > "$request_tmp"
  else
    jq -n \
      --arg id "$request_id" \
      --arg method "$method" \
      --arg path "$request_path" \
      --arg provider "$provider" \
      --arg provider_session_id "$session_id" \
      '{id:$id, method:$method, path:$path}
       + (if $method != "GET" and $provider != "" and $provider_session_id != ""
          then {ambient_identity:{provider:$provider, provider_session_id:$provider_session_id}}
          else {} end)' > "$request_tmp"
  fi
  mv "$request_tmp" "$request_file"

  deadline=$(( $(date +%s) + ${MANDIBLE_FILE_RPC_TIMEOUT:-15} ))
  while [[ $(date +%s) -le "$deadline" ]]; do
    if [[ -f "$response_file" ]]; then
      response=$(cat "$response_file")
      api_file_rpc_cleanup "$response_file"
      response_status=$(printf '%s' "$response" | jq -r '.status // 500')
      printf '%s' "$response" | jq -c '.body' > "$output_file"
      printf '%s' "$response_status"
      return 0
    fi
    sleep 0.05
  done

  api_file_rpc_cleanup "$request_file"
  printf '{"error":"file_rpc_timeout"}' > "$output_file"
  printf '000'
}
