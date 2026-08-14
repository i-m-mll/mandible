#!/usr/bin/env bash

set -euo pipefail

API_HELPER="${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/api.sh"
source "$API_HELPER"

usage() {
  cat <<'EOF'
Usage: mandible ask submit <packet.json|-> [--json]
       mandible ask wait <id> [--timeout <duration>] [--json]
       mandible ask result <id> [--json]

Wait durations accept milliseconds, with optional ms, s, or m suffix.
The final timeout must be between 0 and 55000 milliseconds.
EOF
}

fail() {
  printf 'mandible ask: %s\n' "$1" >&2
  exit 1
}

parse_timeout_ms() {
  local input="$1" number suffix multiplier timeout
  if [[ ! "$input" =~ ^([0-9]+([.][0-9]+)?)(ms|s|m)?$ ]]; then
    fail "invalid timeout '$input'"
  fi
  number="${BASH_REMATCH[1]}"
  suffix="${BASH_REMATCH[3]:-ms}"
  case "$suffix" in
    ms) multiplier=1 ;;
    s) multiplier=1000 ;;
    m) multiplier=60000 ;;
  esac
  timeout="$(jq -nr --arg number "$number" --argjson multiplier "$multiplier" '
    ($number | tonumber) * $multiplier
    | if (isfinite and floor == .) then tostring else error("non-integer timeout") end
  ' 2>/dev/null)" || fail "timeout must resolve to an integer number of milliseconds"
  (( timeout >= 0 && timeout <= 55000 )) || fail "timeout must be between 0 and 55000 ms"
  printf '%s' "$timeout"
}

ask_api_request() {
  local method="$1" request_path="$2" data="${3:-}" response_file status code
  response_file="$(api_temp_file)"
  status="$(api_capture "$method" "$request_path" "$data" "$response_file")"
  if [[ "$status" =~ ^2 ]]; then
    cat "$response_file"
    rm -f "$response_file"
    return 0
  fi
  code="$(jq -r '.code // empty' "$response_file" 2>/dev/null || true)"
  rm -f "$response_file"
  printf 'mandible ask: request failed (status=%s' "$status" >&2
  if [[ "$code" =~ ^[A-Za-z0-9_-]+$ ]]; then printf ', code=%s' "$code" >&2; fi
  printf ')\n' >&2
  return 22
}

print_result_summary() {
  jq -r '
    "Ask \(.ask_id): \(.state)"
    + (if .submission == null then ""
       else " (submission \(.submission.id), ordinal \(.submission.ordinal))" end)
    + (if .wait_timed_out == true then " (wait timed out)" else "" end)
  '
}

command="${1:-}"
case "$command" in
  -h|--help|help|"") usage; [[ -n "$command" ]] || exit 1; exit 0 ;;
esac
shift

case "$command" in
  submit)
    [[ $# -ge 1 ]] || { usage >&2; exit 1; }
    source_path="$1"
    shift
    json=0
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --json) json=1 ;;
        -h|--help) usage; exit 0 ;;
        *) fail "unknown submit option '$1'" ;;
      esac
      shift
    done
    if [[ "$source_path" == "-" ]]; then
      payload="$(</dev/stdin)"
    else
      [[ -f "$source_path" ]] || fail "packet file not found: $source_path"
      payload="$(<"$source_path")"
    fi
    printf '%s' "$payload" | jq -e -s 'length == 1' >/dev/null 2>&1 \
      || fail "packet must contain exactly one valid JSON document"
    response="$(ask_api_request POST "/api/asks" "$payload")"
    if (( json )); then
      printf '%s\n' "$response"
    else
      printf '%s\n' "$response" | jq -r '"Ask \(.ask_id)\n\(.dashboard_url)"'
    fi
    ;;
  wait)
    [[ $# -ge 1 ]] || { usage >&2; exit 1; }
    ask_id="$1"
    shift
    timeout_ms=25000
    json=0
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --timeout)
          [[ $# -ge 2 ]] || fail "--timeout requires a duration"
          timeout_ms="$(parse_timeout_ms "$2")"
          shift
          ;;
        --json) json=1 ;;
        -h|--help) usage; exit 0 ;;
        *) fail "unknown wait option '$1'" ;;
      esac
      shift
    done
    transport_budget=$(( (timeout_ms + 999) / 1000 + 3 ))
    response="$(
      export MANDIBLE_HTTP_TIMEOUT="$transport_budget"
      export MANDIBLE_FILE_RPC_TIMEOUT="$transport_budget"
      ask_api_request GET "/api/asks/$(urlencode "$ask_id")/wait?timeout_ms=${timeout_ms}"
    )"
    if (( json )); then printf '%s\n' "$response"; else printf '%s\n' "$response" | print_result_summary; fi
    ;;
  result)
    [[ $# -ge 1 ]] || { usage >&2; exit 1; }
    ask_id="$1"
    shift
    json=0
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --json) json=1 ;;
        -h|--help) usage; exit 0 ;;
        *) fail "unknown result option '$1'" ;;
      esac
      shift
    done
    response="$(ask_api_request GET "/api/asks/$(urlencode "$ask_id")/result")"
    if (( json )); then printf '%s\n' "$response"; else printf '%s\n' "$response" | print_result_summary; fi
    ;;
  *) fail "unknown subcommand '$command'" ;;
esac
