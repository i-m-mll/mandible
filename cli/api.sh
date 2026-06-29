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

api_operational_mutation_category() {
  local method="$1"
  local request_path="$2"
  local pathname="${request_path%%\?*}"
  method="$(printf '%s' "$method" | tr '[:lower:]' '[:upper:]')"

  case "$method" in
    POST|PUT|PATCH|DELETE) ;;
    *) return 1 ;;
  esac

  [[ "$pathname" != "/api/auth/check" ]] || return 1

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

api_fetch_instance_payload() {
  local output_file="$1"
  local http_status

  if api_is_file_rpc; then
    return 1
  fi

  http_status=$(curl -s --max-time 5 -o "$output_file" -w "%{http_code}" \
    "$(api_base)/api/instance" 2>/dev/null || printf '')
  if [[ "$http_status" =~ ^2 ]] && jq -e '.instance and (.instance | type == "object")' "$output_file" >/dev/null 2>&1; then
    return 0
  fi

  http_status=$(curl -s --max-time 5 -o "$output_file" -w "%{http_code}" \
    "$(api_base)/api/health" 2>/dev/null || printf '')
  [[ "$http_status" =~ ^2 ]] \
    && jq -e '.instance and (.instance | type == "object")' "$output_file" >/dev/null 2>&1
}

api_preflight_operational_mutation() {
  local method="$1"
  local request_path="$2"
  local output_file="${3:-}"
  local category tmp_response role policy db_path source_db_path message

  category=$(api_operational_mutation_category "$method" "$request_path") || return 0
  api_is_file_rpc && return 0
  api_non_main_operational_mutation_override_enabled && return 0

  tmp_response="$(mktemp)"
  if ! api_fetch_instance_payload "$tmp_response"; then
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
  local ambient_headers=()

  if ! api_preflight_operational_mutation "$method" "$request_path" "$output_file"; then
    printf '403'
    return 0
  fi

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

  # Route the request body through a temp file (curl --data-binary @file) so it
  # never travels through argv. Large artifact payloads would otherwise blow the
  # OS ARG_MAX limit (issue 833e972). Build the curl argv as an array (guarding
  # the possibly-empty ambient header list) so it stays correct under zsh, which
  # sources this helper.
  local body_tmp
  body_tmp="$(mktemp)"
  printf '%s' "$data" > "$body_tmp"
  local curl_args=(-s --max-time 15 -o "$output_file" -w "%{http_code}"
    -X "$method" "$(api_base)$request_path" -H 'Content-Type: application/json')
  (( ${#ambient_headers[@]} )) && curl_args+=("${ambient_headers[@]}")
  curl_args+=(--data-binary "@$body_tmp")
  curl "${curl_args[@]}" 2>/dev/null || printf ''
  rm -f "$body_tmp"
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

  api_preflight_operational_mutation "$method" "$request_path" || return 22

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
    # Body via temp file so large payloads never hit argv (issue 833e972).
    # Build argv as an array, guarding the possibly-empty ambient header list,
    # so it stays correct under zsh (which sources this helper). NB: avoid the
    # name `status` — it is a read-only special var under zsh.
    local body_tmp curl_status
    body_tmp="$(mktemp)"
    printf '%s' "$data" > "$body_tmp"
    local curl_args=(-sf --max-time 15 -X "$method" "$(api_base)$request_path"
      -H 'Content-Type: application/json')
    (( ${#ambient_headers[@]} )) && curl_args+=("${ambient_headers[@]}")
    curl_args+=(--data-binary "@$body_tmp")
    if curl "${curl_args[@]}"; then
      curl_status=0
    else
      curl_status=$?
    fi
    rm -f "$body_tmp"
    return "$curl_status"
  fi
}

# Capture-style POST/PATCH where bytes for a body field come from a
# daemon-visible file rather than inline base64 (issue 833e972).
#   api_send_content METHOD PATH PAYLOAD FIELD SRC_ABS_FILE OUTFILE
# Prints the HTTP-equivalent status and writes the response body to OUTFILE.
# - file-RPC: SRC bytes ride as a spool attachment; the daemon injects FIELD.
# - HTTP (shared filesystem): FIELD is set to the daemon-visible absolute path.
api_send_content() {
  local method="$1" request_path="$2" data="$3" field="$4" src="$5" output_file="$6"
  if ! api_preflight_operational_mutation "$method" "$request_path" "$output_file"; then
    printf '403'
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
  local dir request_id request_tmp request_file response_file deadline response response_status
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
  jq -n \
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
     + (if $method != "GET" and $provider != "" and $provider_session_id != ""
        then {ambient_identity:{provider:$provider, provider_session_id:$provider_session_id}}
        else {} end)' > "$request_tmp"
  rm -f "$body_tmp"
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
  [[ -n "$attach_name" ]] && api_file_rpc_cleanup "${dir}/${attach_name}"
  printf '{"error":"file_rpc_timeout"}' > "$output_file"
  printf '000'
}
