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

urlencode() {
  jq -rn --arg value "$1" '$value|@uri'
}

api_get() {
  local path="$1"
  api_request GET "$path" ""
}

api_send() {
  local method="$1"
  local path="$2"
  local data="$3"
  api_request "$method" "$path" "$data"
}

api_send_capture() {
  local method="$1"
  local path="$2"
  local data="$3"
  local output_file="$4"

  if api_is_file_rpc; then
    api_file_rpc_exchange "$method" "$path" "$data" "$output_file"
    return
  fi

  curl -s --max-time 5 -o "$output_file" -w "%{http_code}" \
    -X "$method" "$(api_base)$path" \
    -H 'Content-Type: application/json' \
    -d "$data" 2>/dev/null || printf ''
}

api_request() {
  local method="$1"
  local path="$2"
  local data="${3:-}"
  local tmp_response response_status

  if api_is_file_rpc; then
    tmp_response=$(mktemp)
    response_status=$(api_file_rpc_exchange "$method" "$path" "$data" "$tmp_response")
    if [[ "$response_status" =~ ^2 ]]; then
      cat "$tmp_response"
      rm -f "$tmp_response"
      return 0
    fi
    rm -f "$tmp_response"
    return 22
  fi

  if [[ "$method" == "GET" ]]; then
    curl -sf --max-time 15 "$(api_base)$path"
  else
    curl -sf --max-time 15 -X "$method" "$(api_base)$path" \
      -H 'Content-Type: application/json' \
      -d "$data"
  fi
}

api_file_rpc_exchange() {
  local method="$1"
  local request_path="$2"
  local data="${3:-}"
  local output_file="$4"
  local dir request_id request_tmp request_file response_file deadline response response_status

  dir=$(api_file_rpc_dir)
  mkdir -p "$dir"
  request_id="cli-$RANDOM-$$-$(date +%s)"
  request_tmp="${dir}/${request_id}.request.json.tmp"
  request_file="${dir}/${request_id}.request.json"
  response_file="${dir}/${request_id}.response.json"

  if [[ -n "$data" ]]; then
    jq -n \
      --arg id "$request_id" \
      --arg method "$method" \
      --arg path "$request_path" \
      --argjson body "$data" \
      '{id:$id, method:$method, path:$path, body:$body}' > "$request_tmp"
  else
    jq -n \
      --arg id "$request_id" \
      --arg method "$method" \
      --arg path "$request_path" \
      '{id:$id, method:$method, path:$path}' > "$request_tmp"
  fi
  mv "$request_tmp" "$request_file"

  deadline=$(( $(date +%s) + ${MANDIBLE_FILE_RPC_TIMEOUT:-15} ))
  while [[ $(date +%s) -le "$deadline" ]]; do
    if [[ -f "$response_file" ]]; then
      response=$(cat "$response_file")
      rm -f "$response_file"
      response_status=$(printf '%s' "$response" | jq -r '.status // 500')
      printf '%s' "$response" | jq -c '.body' > "$output_file"
      printf '%s' "$response_status"
      return 0
    fi
    sleep 0.05
  done

  rm -f "$request_file"
  printf '{"error":"file_rpc_timeout"}' > "$output_file"
  printf '000'
}
