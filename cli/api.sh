#!/usr/bin/env bash

: "${MANDIBLE_PORT:=19420}"
: "${MANDIBLE_BASE:=http://127.0.0.1:${MANDIBLE_PORT}}"

api_base() {
  printf '%s' "$MANDIBLE_BASE"
}

api_is_file_rpc() {
  [[ "${MANDIBLE_BASE}" == file://* ]]
}

# Issue 708dc4c — resolve the client-auth config dir, mirroring the daemon's
# getMandibleConfigDir (src/platform-paths.ts). Used only to locate the operator
# bootstrap-token file; the MANDIBLE_CONFIG_DIR override is honored first.
api_client_auth_config_dir() {
  if [[ -n "${MANDIBLE_CONFIG_DIR:-}" ]]; then
    printf '%s' "$MANDIBLE_CONFIG_DIR"
    return
  fi
  case "$(uname -s)" in
    Darwin) printf '%s/Library/Application Support/Mandible/config' "$HOME" ;;
    *) printf '%s' "${XDG_CONFIG_HOME:-$HOME/.config}/mandible" ;;
  esac
}

# Resolve the client-auth bearer/capability token: MANDIBLE_TOKEN wins, else the
# same-user operator bootstrap-token file (filesystem trust, like file-RPC).
api_client_token() {
  if [[ -n "${MANDIBLE_TOKEN:-}" ]]; then
    printf '%s' "$MANDIBLE_TOKEN"
    return
  fi
  local token_file line
  token_file="$(api_client_auth_config_dir)/client-auth/bootstrap-token"
  if [[ -r "$token_file" ]]; then
    IFS= read -r line < "$token_file" || true
    printf '%s' "$line"
  fi
}

api_file_rpc_dir() {
  local value="${MANDIBLE_BASE#file://}"
  case "$value" in
    localhost/*) printf '/%s' "${value#localhost/}" ;;
    /*) printf '%s' "$value" ;;
    *) printf '%s' "$value" ;;
  esac
}

api_http_retryable_status() {
  local http_status="${1:-000}"
  [[ -n "$http_status" && "$http_status" != "000" && ! "$http_status" =~ ^5 ]] && return 1
  return 0
}

api_http_retry_delay_ms() {
  local retry_index="${1:-0}"
  local base_ms="${MANDIBLE_HTTP_RETRY_BASE_MS:-100}"
  local max_ms="${MANDIBLE_HTTP_RETRY_MAX_MS:-1000}"
  local jitter_ms="${MANDIBLE_HTTP_RETRY_JITTER_MS:-100}"
  local delay_ms jitter=0 i

  [[ "$base_ms" =~ ^[0-9]+$ ]] || base_ms=100
  [[ "$max_ms" =~ ^[0-9]+$ ]] || max_ms=1000
  [[ "$jitter_ms" =~ ^[0-9]+$ ]] || jitter_ms=100
  [[ "$retry_index" =~ ^[0-9]+$ ]] || retry_index=0
  delay_ms="$base_ms"
  for ((i = 0; i < retry_index; i += 1)); do
    delay_ms=$(( delay_ms * 2 ))
    (( delay_ms >= max_ms )) && { delay_ms="$max_ms"; break; }
  done
  (( delay_ms > max_ms )) && delay_ms="$max_ms"
  (( jitter_ms > 0 )) && jitter=$(( RANDOM % (jitter_ms + 1) ))
  printf '%s' "$(( delay_ms + jitter ))"
}

api_http_sleep_before_retry() {
  local delay_ms
  delay_ms=$(api_http_retry_delay_ms "$1")
  sleep "$(printf '%d.%03d' "$(( delay_ms / 1000 ))" "$(( delay_ms % 1000 ))")"
}

api_http_probe_health() {
  local health_base="${1:-$(api_base)}"
  local health_tmp http_status curl_exit=0 ready rebuilding
  health_tmp=$(mktemp)
  if http_status=$(curl -s --max-time "${MANDIBLE_HEALTH_TIMEOUT:-2}" -o "$health_tmp" \
      -w "%{http_code}" "${health_base}/api/health" 2>/dev/null); then
    :
  else
    curl_exit=$?
  fi
  http_status="${http_status:-000}"
  if [[ "$curl_exit" -eq 0 && "$http_status" =~ ^2 ]]; then
    ready=$(jq -r 'if has("ready") then (.ready | tostring) else "unknown" end' "$health_tmp" 2>/dev/null || printf 'unknown')
    rebuilding=$(jq -r '.rebuilding // false' "$health_tmp" 2>/dev/null || printf 'false')
    rm -f "$health_tmp"
    if [[ "$ready" == "false" || "$rebuilding" == "true" ]]; then
      printf 'busy_not_ready'
    elif [[ "$ready" == "true" ]]; then
      printf 'busy_ready'
    else
      printf 'reachable_unknown'
    fi
    return 0
  fi
  if [[ "$http_status" =~ ^5 ]]; then
    rm -f "$health_tmp"
    printf 'busy_not_ready'
    return 0
  fi
  if [[ "$http_status" != "000" ]]; then
    rm -f "$health_tmp"
    printf 'reachable_unknown'
    return 0
  fi
  rm -f "$health_tmp"
  printf 'down_unreachable'
}

api_report_final_http_failure() {
  local request_path="$1" http_status="$2" curl_exit="$3" health_state
  health_state=$(api_http_probe_health)
  case "$health_state" in
    busy_not_ready)
      printf 'Mandible request failed after bounded retries: daemon is reachable but busy or not ready (path=%s, status=%s, curl=%s).\n' \
        "$request_path" "$http_status" "$curl_exit" >&2
      ;;
    busy_ready)
      printf 'Mandible request failed after bounded retries: daemon is reachable and ready, but this request remained busy or timed out (path=%s, status=%s, curl=%s).\n' \
        "$request_path" "$http_status" "$curl_exit" >&2
      ;;
    reachable_unknown)
      printf 'Mandible request failed after bounded retries: daemon is reachable, but readiness is unknown (path=%s, status=%s, curl=%s).\n' \
        "$request_path" "$http_status" "$curl_exit" >&2
      ;;
    *)
      printf 'Mandible request failed after bounded retries: daemon is down or unreachable (path=%s, status=%s, curl=%s).\n' \
        "$request_path" "$http_status" "$curl_exit" >&2
      ;;
  esac
}

# Execute one API request with bounded retry. The response body always lands in
# output_file and the final HTTP-equivalent status is the only stdout output.
api_http_exchange() {
  local method="$1" request_path="$2" data="$3" output_file="$4"
  local retry_limit="${MANDIBLE_HTTP_RETRIES:-2}" attempt=0 http_status curl_exit
  local body_tmp="" stderr_tmp retryable empty_response token token_cfg=""
  local ambient_headers=() curl_args=()

  [[ "$retry_limit" =~ ^[0-9]+$ ]] || retry_limit=2
  if [[ "$method" != "GET" ]]; then
    while IFS= read -r -d '' header_arg; do
      ambient_headers+=("$header_arg")
    done < <(api_curl_ambient_headers "$method")
    body_tmp=$(mktemp)
    printf '%s' "$data" > "$body_tmp"
  fi
  stderr_tmp=$(mktemp)

  # Issue 708dc4c (finding 6) — present the client-auth bearer token via a 0600
  # curl config file, never on argv (which is visible in `ps`). Resolve it from
  # MANDIBLE_TOKEN or the same-user operator bootstrap-token file.
  token="$(api_client_token)"
  if [[ -n "$token" ]]; then
    token_cfg=$(mktemp)
    chmod 600 "$token_cfg" 2>/dev/null || true
    printf 'header = "Authorization: Bearer %s"\n' "$token" > "$token_cfg"
  fi

  while true; do
    : > "$output_file"
    : > "$stderr_tmp"
    curl_args=(-s --max-time "${MANDIBLE_HTTP_TIMEOUT:-15}" -o "$output_file" -w "%{http_code}")
    [[ -n "$token_cfg" ]] && curl_args+=(--config "$token_cfg")
    if [[ "$method" != "GET" ]]; then
      curl_args+=(-X "$method" -H 'Content-Type: application/json')
      (( ${#ambient_headers[@]} )) && curl_args+=("${ambient_headers[@]}")
      curl_args+=(--data-binary "@$body_tmp")
    fi
    curl_args+=("$(api_base)$request_path")
    if http_status=$(curl "${curl_args[@]}" 2>"$stderr_tmp"); then
      curl_exit=0
    else
      curl_exit=$?
    fi
    http_status="${http_status:-000}"
    empty_response=false
    [[ ! -s "$output_file" ]] && empty_response=true
    retryable=false
    if api_http_retryable_status "$http_status" \
        || [[ "$empty_response" == "true" && "$http_status" =~ ^2 && "$http_status" != "204" ]]; then
      retryable=true
    fi

    if [[ "$retryable" != "true" ]]; then
      break
    fi
    if (( attempt >= retry_limit )); then
      api_report_final_http_failure "$request_path" "$http_status" "$curl_exit"
      break
    fi
    printf 'Mandible request transient failure; retrying (attempt=%s, path=%s, status=%s, curl=%s).\n' \
      "$(( attempt + 1 ))" "$request_path" "$http_status" "$curl_exit" >&2
    api_http_sleep_before_retry "$attempt"
    attempt=$(( attempt + 1 ))
  done

  rm -f "$stderr_tmp"
  [[ -z "$body_tmp" ]] || rm -f "$body_tmp"
  [[ -z "$token_cfg" ]] || rm -f "$token_cfg"
  printf '%s' "$http_status"
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

api_route_mutation_category_file() {
  if [[ -n "${MANDIBLE_ROUTE_MUTATION_CATEGORIES_FILE:-}" ]]; then
    printf '%s' "$MANDIBLE_ROUTE_MUTATION_CATEGORIES_FILE"
    return 0
  fi
  printf '%s/route-mutation-categories.json' "${MANDIBLE_CLI_CACHE_DIR:-${HOME}/.cache/mandible/cli}"
}

api_route_template_matches() {
  local route_template="$1"
  local pathname="$2"
  local template_part path_part template_more path_more

  # This helper is sourced by both bash and zsh CLIs. Split one path segment at
  # a time instead of using either shell's incompatible `read` array option.
  while true; do
    template_more=0
    path_more=0
    if [[ "$route_template" == */* ]]; then
      template_part="${route_template%%/*}"
      route_template="${route_template#*/}"
      template_more=1
    else
      template_part="$route_template"
    fi
    if [[ "$pathname" == */* ]]; then
      path_part="${pathname%%/*}"
      pathname="${pathname#*/}"
      path_more=1
    else
      path_part="$pathname"
    fi

    if [[ "$template_part" == :* ]]; then
      [[ -n "$path_part" ]] || return 1
    else
      [[ "$template_part" == "$path_part" ]] || return 1
    fi

    [[ "$template_more" -eq "$path_more" ]] || return 1
    [[ "$template_more" -eq 1 ]] || return 0
  done
}

api_generated_operational_mutation_category() {
  local method="$1"
  local pathname="$2"
  local category_file route_method route_path route_category

  category_file="$(api_route_mutation_category_file)"
  [[ -f "$category_file" ]] || return 1

  while IFS=$'\t' read -r route_method route_path route_category; do
    [[ -n "$route_method" && -n "$route_path" && -n "$route_category" ]] || continue
    [[ "$route_method" == "$method" ]] || continue
    if api_route_template_matches "$route_path" "$pathname"; then
      printf '%s' "$route_category"
      return 0
    fi
  done < <(
    jq -r '.routes[]? | select(.method and .path and .category) | [.method, .path, .category] | @tsv' \
      "$category_file" 2>/dev/null
  )

  return 1
}

api_operational_mutation_category() {
  local method="$1"
  local request_path="$2"
  local pathname="${request_path%%\?*}"
  local generated_category
  method="$(printf '%s' "$method" | tr '[:lower:]' '[:upper:]')"

  case "$method" in
    POST|PUT|PATCH|DELETE) ;;
    *) return 1 ;;
  esac

  [[ "$pathname" != "/api/auth/check" ]] || return 1

  if generated_category="$(api_generated_operational_mutation_category "$method" "$pathname")"; then
    printf '%s' "$generated_category"
    return 0
  fi

  case "$pathname" in
    /api/admin|/api/admin/*) printf 'system'; return 0 ;;
    /api/artifacts|/api/artifacts/*) printf 'artifacts'; return 0 ;;
    /api/auth|/api/auth/*) printf 'auth'; return 0 ;;
    /api/backup|/api/backup/*) printf 'backup'; return 0 ;;
    /api/chats|/api/chats/*) printf 'chats'; return 0 ;;
    /api/console|/api/console/*) printf 'console'; return 0 ;;
    /api/conversations|/api/conversations/*) printf 'conversations'; return 0 ;;
    /api/inbox|/api/inbox/*) printf 'inbox'; return 0 ;;
    /api/ledger|/api/ledger/*) printf 'ledger'; return 0 ;;
    /api/issues|/api/issues/*) printf 'issues'; return 0 ;;
    /api/knowledge-backrefs|/api/knowledge-backrefs/*) printf 'artifacts'; return 0 ;;
    /api/presets|/api/presets/*) printf 'presets'; return 0 ;;
    /api/projects|/api/projects/*) printf 'projects'; return 0 ;;
    /api/provider-manifests|/api/provider-manifests/*) printf 'providers'; return 0 ;;
    /api/providers|/api/providers/*) printf 'providers'; return 0 ;;
    /api/runtime|/api/runtime/*) printf 'runtime'; return 0 ;;
    /api/settings|/api/settings/*) printf 'settings'; return 0 ;;
    /api/sessions|/api/sessions/*) printf 'sessions'; return 0 ;;
    /api/spaces|/api/spaces/*) printf 'spaces'; return 0 ;;
    /api/system|/api/system/*) printf 'system'; return 0 ;;
    /api/timeline|/api/timeline/*) printf 'timeline'; return 0 ;;
    /api/webhooks|/api/webhooks/*) printf 'webhooks'; return 0 ;;
    /api/work-units|/api/work-units/*) printf 'work_units'; return 0 ;;
    /api/work|/api/work/*) printf 'work'; return 0 ;;
    /api|/api/*) printf 'api'; return 0 ;;
    *) return 1 ;;
  esac
}

api_non_main_operational_mutation_override_enabled() {
  case "${MANDIBLE_TEST_ONLY_ALLOW_NON_MAIN_OPERATIONAL_MUTATIONS:-}" in
    1|true|TRUE|yes|YES|allow|ALLOW) return 0 ;;
    *) return 1 ;;
  esac
}

api_instance_metadata_valid() {
  local input_file="$1"
  jq -e '
    .instance
    and (.instance.role | type == "string")
    and (.instance.role | IN("main", "preview", "dev", "test"))
    and (.instance.operational_mutations | type == "string")
    and (.instance.operational_mutations | IN("allow", "reject"))
  ' "$input_file" >/dev/null 2>&1
}

api_write_instance_metadata_unknown() {
  local category="$1"
  local output_file="${2:-}"
  local message

  message="Refusing ${category} mutation because Mandible instance metadata is unavailable from /api/instance or /api/health. Use a daemon that exposes valid instance metadata, or set MANDIBLE_TEST_ONLY_ALLOW_NON_MAIN_OPERATIONAL_MUTATIONS=1 only in isolated test/dev environments."
  printf '%s\n' "$message" >&2
  if [[ -n "$output_file" ]]; then
    jq -n \
      --arg error "cli_instance_metadata_unknown" \
      --arg message "$message" \
      --arg category "$category" \
      '{error:$error, message:$message, category:$category}' \
      > "$output_file"
  fi
}

api_write_instance_metadata_unavailable() {
  local category="$1"
  local output_file="${2:-}"
  local message

  message="Mandible ${category} mutation was not sent because instance metadata remained temporarily unavailable after bounded retries. Retry after the main daemon is responsive."
  printf '%s\n' "$message" >&2
  if [[ -n "$output_file" ]]; then
    jq -n \
      --arg error "cli_instance_metadata_unavailable" \
      --arg message "$message" \
      --arg category "$category" \
      '{error:$error, message:$message, category:$category, retryable:true}' \
      > "$output_file"
  fi
}

api_fetch_instance_payload() {
  local output_file="$1"
  local http_status
  local instance_transient=false

  if api_is_file_rpc; then
    return 1
  fi

  http_status=$(api_http_exchange GET "/api/instance" "" "$output_file")
  if [[ "$http_status" =~ ^2 ]]; then
    if jq -e '.instance and (.instance | type == "object")' "$output_file" >/dev/null 2>&1; then
      return 0
    fi
    # An empty successful response is a transient exchange failure. A non-empty
    # authoritative response without an instance object is malformed and must
    # remain fail-closed instead of being hidden by the compatibility route.
    [[ ! -s "$output_file" ]] || return 1
    instance_transient=true
  elif api_http_retryable_status "$http_status"; then
    instance_transient=true
  fi

  http_status=$(api_http_exchange GET "/api/health" "" "$output_file")
  if [[ "$http_status" =~ ^2 ]]; then
    if jq -e '.instance and (.instance | type == "object")' "$output_file" >/dev/null 2>&1; then
      return 0
    fi
    if [[ ! -s "$output_file" || "$instance_transient" == "true" ]]; then
      return 75
    fi
    return 1
  fi
  if api_http_retryable_status "$http_status" || [[ "$instance_transient" == "true" ]]; then
    return 75
  fi
  return 1
}

api_preflight_operational_mutation() {
  local method="$1"
  local request_path="$2"
  local output_file="${3:-}"
  local category tmp_response fetch_status role policy db_path source_db_path message

  category=$(api_operational_mutation_category "$method" "$request_path") || return 0
  api_is_file_rpc && return 0
  api_non_main_operational_mutation_override_enabled && return 0

  tmp_response="$(mktemp)"
  if api_fetch_instance_payload "$tmp_response"; then
    fetch_status=0
  else
    fetch_status=$?
  fi
  if [[ "$fetch_status" -eq 75 ]]; then
    rm -f "$tmp_response"
    api_write_instance_metadata_unavailable "$category" "$output_file"
    return 75
  fi
  if [[ "$fetch_status" -ne 0 ]]; then
    rm -f "$tmp_response"
    api_write_instance_metadata_unknown "$category" "$output_file"
    return 22
  fi

  if ! api_instance_metadata_valid "$tmp_response"; then
    rm -f "$tmp_response"
    api_write_instance_metadata_unknown "$category" "$output_file"
    return 22
  fi

  role=$(jq -r '.instance.role' "$tmp_response")
  policy=$(jq -r '.instance.operational_mutations' "$tmp_response")
  if [[ "$role" == "main" && "$policy" == "allow" ]]; then
    rm -f "$tmp_response"
    return 0
  fi

  db_path=$(jq -r '.instance.db_path // ""' "$tmp_response")
  source_db_path=$(jq -r '.instance.source_db_path // ""' "$tmp_response")
  rm -f "$tmp_response"

  message="Refusing ${category} mutation against Mandible ${role} instance (${policy}). This target is not the main operational daemon"
  if [[ -n "$db_path" ]]; then
    message="${message}; db=${db_path}"
  fi
  if [[ -n "$source_db_path" ]]; then
    message="${message}; source_db=${source_db_path}"
  fi
  message="${message}. Use the main Mandible daemon, or set MANDIBLE_TEST_ONLY_ALLOW_NON_MAIN_OPERATIONAL_MUTATIONS=1 only in isolated test/dev environments."

  printf '%s\n' "$message" >&2
  if [[ -n "$output_file" ]]; then
    jq -n \
      --arg error "cli_instance_mutation_forbidden" \
      --arg message "$message" \
      --arg category "$category" \
      --arg role "$role" \
      --arg operational_mutations "$policy" \
      '{error:$error, message:$message, category:$category, instance_role:$role, operational_mutations:$operational_mutations}' \
      > "$output_file"
  fi
  return 22
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

  local preflight_status
  if api_preflight_operational_mutation "$method" "$request_path" "$output_file"; then
    preflight_status=0
  else
    preflight_status=$?
  fi
  if [[ "$preflight_status" -ne 0 ]]; then
    if [[ "$preflight_status" -eq 75 ]]; then
      printf '503'
    else
      printf '403'
    fi
    return 0
  fi

  if api_is_file_rpc; then
    api_file_rpc_exchange "$method" "$request_path" "$data" "$output_file"
    return
  fi

  api_http_exchange "$method" "$request_path" "$data" "$output_file"
}

api_file_rpc_cleanup() {
  # Cleanup is best-effort: create-only sandbox mounts can allow response reads
  # while denying unlink, and the command exit code must reflect the API result.
  rm -f "$1" 2>/dev/null || true
}

api_file_rpc_consume_response() {
  local response_file="$1" output_file="$2" response response_status
  response=$(cat "$response_file")
  api_file_rpc_cleanup "$response_file"
  response_status=$(printf '%s' "$response" | jq -r '.status // 500')
  printf '%s' "$response" | jq -c '.body' > "$output_file"
  printf '%s' "$response_status"
}

api_request() {
  local method="$1"
  local request_path="$2"
  local data="${3:-}"
  local tmp_response response_status preflight_status

  if api_preflight_operational_mutation "$method" "$request_path"; then
    preflight_status=0
  else
    preflight_status=$?
  fi
  [[ "$preflight_status" -eq 0 ]] || return "$preflight_status"

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

  tmp_response=$(mktemp)
  response_status=$(api_http_exchange "$method" "$request_path" "$data" "$tmp_response")
  if [[ "$response_status" =~ ^2 ]]; then
    cat "$tmp_response"
    rm -f "$tmp_response"
    return 0
  fi
  rm -f "$tmp_response"
  return 22
}

# Capture-style POST/PATCH where bytes for a body field come from a
# daemon-visible file rather than inline base64 (issue 833e972).
#   api_send_content METHOD PATH PAYLOAD FIELD SRC_ABS_FILE OUTFILE
# Prints the HTTP-equivalent status and writes the response body to OUTFILE.
# - file-RPC: SRC bytes ride as a spool attachment; the daemon injects FIELD.
# - HTTP (shared filesystem): FIELD is set to the daemon-visible absolute path.
api_send_content() {
  local method="$1" request_path="$2" data="$3" field="$4" src="$5" output_file="$6"
  local preflight_status
  if api_preflight_operational_mutation "$method" "$request_path" "$output_file"; then
    preflight_status=0
  else
    preflight_status=$?
  fi
  if [[ "$preflight_status" -ne 0 ]]; then
    if [[ "$preflight_status" -eq 75 ]]; then
      printf '503'
    else
      printf '403'
    fi
    return 0
  fi
  if api_is_file_rpc; then
    api_file_rpc_exchange "$method" "$request_path" "$data" "$output_file" "$field" "$src"
    return
  fi
  local merged
  merged="$(printf '%s' "$data" | jq --arg f "$field" --arg p "$src" '.[$f]=$p')"
  api_capture "$method" "$request_path" "$merged" "$output_file"
}

api_file_rpc_exchange() {
  local method="$1"
  local request_path="$2"
  local data="${3:-}"
  local output_file="$4"
  local attach_field="${5:-}"
  local attach_src="${6:-}"
  local dir request_id request_tmp request_file response_file deadline late_deadline health_state outcome
  local provider session_id body_tmp attach_name=""

  dir=$(api_file_rpc_dir)
  mkdir -p "$dir"
  request_id="cli-$RANDOM-$$-$(date +%s)"
  request_tmp="${dir}/${request_id}.request.json.tmp"
  request_file="${dir}/${request_id}.request.json"
  response_file="${dir}/${request_id}.response.json"
  provider=$(api_ambient_provider)
  session_id=$(api_ambient_session_id)

  # Stage large bytes as a sibling spool attachment so they never travel through
  # argv/JSON (issue 833e972). The daemon resolves the attachment to a
  # daemon-visible absolute path and injects it into the request body field.
  if [[ -n "$attach_field" && -n "$attach_src" ]]; then
    attach_name="${request_id}.attach-${attach_field}"
    cp "$attach_src" "${dir}/${attach_name}.tmp"
    mv "${dir}/${attach_name}.tmp" "${dir}/${attach_name}"
  fi

  # Assemble the request body via a temp file (jq --slurpfile) so even a large
  # metadata payload is read from disk, not passed as a jq argument.
  body_tmp="$(mktemp)"
  if [[ -n "$data" ]]; then printf '%s' "$data" > "$body_tmp"; else printf 'null' > "$body_tmp"; fi
  # Issue 708dc4c (finding 6) — the capability token is read from the environment
  # inside jq ($ENV) so it is never placed on jq's argv (visible in `ps`). It
  # still lands in the spool request file, which is the file-RPC trust anchor.
  MANDIBLE_CLIENT_TOKEN="$(api_client_token)" jq -n \
    --arg id "$request_id" \
    --arg method "$method" \
    --arg path "$request_path" \
    --arg provider "$provider" \
    --arg provider_session_id "$session_id" \
    --arg attach_field "$attach_field" \
    --arg attach_name "$attach_name" \
    --slurpfile body "$body_tmp" \
    '{id:$id, method:$method, path:$path}
     + (if ($body[0] != null) then {body:$body[0]} else {} end)
     + (if $attach_field != "" and $attach_name != "" then {attachments:{($attach_field):$attach_name}} else {} end)
     + (if ($ENV.MANDIBLE_CLIENT_TOKEN // "") != "" then {capability_token:$ENV.MANDIBLE_CLIENT_TOKEN} else {} end)
     + (if $method != "GET" and $provider != "" and $provider_session_id != ""
        then {ambient_identity:{provider:$provider, provider_session_id:$provider_session_id}}
        else {} end)' > "$request_tmp"
  rm -f "$body_tmp"
  mv "$request_tmp" "$request_file"

  deadline=$(( $(date +%s) + ${MANDIBLE_FILE_RPC_TIMEOUT:-15} ))
  while [[ $(date +%s) -le "$deadline" ]]; do
    if [[ -f "$response_file" ]]; then
      api_file_rpc_consume_response "$response_file" "$output_file"
      return 0
    fi
    sleep 0.05
  done

  # A timeout does not mean the daemon did not execute a mutation: the daemon
  # keeps the request file until after dispatch and response publication. Keep
  # the stable request id alive for a short late-response window and never
  # blindly replay or delete an ambiguous mutation request.
  late_deadline=$(( $(date +%s) + ${MANDIBLE_FILE_RPC_LATE_RESPONSE_GRACE:-2} ))
  while [[ $(date +%s) -le "$late_deadline" ]]; do
    if [[ -f "$response_file" ]]; then
      api_file_rpc_consume_response "$response_file" "$output_file"
      return 0
    fi
    sleep 0.05
  done

  health_state=$(api_http_probe_health \
    "${MANDIBLE_FILE_RPC_HEALTH_BASE:-http://127.0.0.1:${MANDIBLE_PORT}}")
  if [[ "$method" == "GET" ]]; then
    outcome="not_returned"
  else
    outcome="unknown"
  fi
  jq -n \
    --arg error "file_rpc_timeout" \
    --arg request_id "$request_id" \
    --arg outcome "$outcome" \
    --arg daemon_state "$health_state" \
    '{error:$error, request_id:$request_id, outcome:$outcome, daemon_state:$daemon_state}' \
    > "$output_file"
  case "$health_state" in
    busy_not_ready|busy_ready|reachable_unknown)
      printf 'Mandible file-RPC request timed out: daemon is reachable but busy or not ready; request %s remains pending and mutation outcome is %s. Do not replay blindly.\n' \
        "$request_id" "$outcome" >&2
      ;;
    *)
      printf 'Mandible file-RPC request timed out: daemon is down or unreachable (or health is unavailable); request %s remains pending and mutation outcome is %s. Do not replay blindly.\n' \
        "$request_id" "$outcome" >&2
      ;;
  esac
  printf '000'
}
