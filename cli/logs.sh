#!/usr/bin/env bash
# mandible logs: inspect provider-native source logs and retained daemon telemetry.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
source "$SCRIPT_DIR/api.sh"

usage() {
  mandible_command_help logs
}

if [[ "${1:-}" == "daemon" ]]; then
  shift
  exec "$(mandible_bun_runtime)" --no-install "$(mandible_cli_module cli/operational-logs)" "$@"
fi

mandible_prepare_syntax_runtime || exit $?

logs_source() {
  case "$1" in
    claude) echo "claude_code" ;;
    codex|gemini) echo "$1" ;;
    all|"") echo "" ;;
    *) echo "Error: unknown provider '$1'. Use: codex, claude, gemini, all" >&2; exit 1 ;;
  esac
}

logs_resolve_conversation_id() {
  local target="$1"
  local encoded response resolved
  encoded=$(urlencode "$target")
  response=$(api_get "/api/conversations?session_id=${encoded}&limit=1" 2>/dev/null || true)
  resolved=$(printf '%s' "$response" | jq -r '.conversations[0].id // empty' 2>/dev/null || true)
  if [[ -n "$resolved" ]]; then
    printf '%s' "$resolved"
  else
    printf '%s' "$target"
  fi
}

file_rpc_inventory() {
  local provider="all" since="" limit=50 json=0 source request response
  local binding
  binding=$(mandible_bind_arguments "logs.inventory" '{"provider":{"option":"provider"},"since":{"option":"since"},"limit":{"option":"limit"},"json":{"option":"json","constant":"1"}}' "$@") || return $?
  eval "$binding"
  source=$(logs_source "$provider")
  request="/api/conversations?limit=$(urlencode "$limit")"
  if [[ -n "$source" ]]; then request="${request}&source=$(urlencode "$source")"; fi
  if [[ -n "$since" ]]; then request="${request}&since=$(urlencode "$since")"; fi
  response=$(api_get "$request")
  if (( json )); then
    printf '%s\n' "$response" | jq '[.conversations[] | {
      provider: .source,
      path: .source_path,
      size: null,
      mtime: (.updated_at // .started_at),
      session_id,
      title,
      cwd,
      model,
      branch
    }]'
  else
    printf '%s\n' "$response" | api_jq_human '.conversations[] | "\(.source)\t\((.updated_at // .started_at)[0:19])\t\((.session_id // .id) | mandible_short_id)\t\(.source_path)"'
  fi
}

file_rpc_inspect() {
  local target="${1:-}" provider="all" head=20 parse=0 json=0 host_filter="" role_filter="" type_filter="" content_filter="" limit=50 offset=0 conv_id request response
  if [[ -z "$target" ]]; then echo "log path, conversation id, or session id required" >&2; exit 2; fi
  shift
  local binding
  binding=$(mandible_bind_arguments "logs.inspect" '{"provider":{"option":"provider"},"head":{"option":"head"},"parse":{"option":"parse","constant":"1"},"role_filter":{"option":"role"},"type_filter":{"option":"type"},"content_filter":{"option":["content","contains"]},"limit":{"option":"limit"},"offset":{"option":"offset"},"json":{"option":"json","constant":"1"},"host_filter":{"option":["tool","tool-kind","since","until"],"constant":"1"}}' "$target" "$@") || return $?
  eval "$binding"
  if [[ -n "$host_filter" ]]; then
    echo "Error: logs inspect --tool, --tool-kind, --since and --until read host logs and are not available through file-RPC." >&2
    return 2
  fi
  conv_id=$(logs_resolve_conversation_id "$target")
  if (( parse )); then
    request="/api/conversations/$(urlencode "$conv_id")/blocks?limit=$(urlencode "$limit")&offset=$(urlencode "$offset")"
    if [[ -n "$type_filter" ]]; then request="${request}&type=$(urlencode "$type_filter")"; fi
    response=$(api_get "$request")
    file_rpc_warn_truncated_blocks "$response"
    if (( json )); then
      printf '%s\n' "$response" | jq \
        --arg role "$role_filter" \
        --arg content "$content_filter" \
        '[.blocks[] | select($role == "" or .role == $role) | select($content == "" or (.content | contains($content)))]'
    else
      printf '%s\n' "$response" | jq -r \
        --arg role "$role_filter" \
        --arg content "$content_filter" \
        '.blocks[] | select($role == "" or .role == $role) | select($content == "" or (.content | contains($content))) | "\(.position)\t\(.type)\t\(.role)\t\((.content | gsub("\\s+"; " ")) | if length > 500 then .[0:497] + "..." else . end)"'
    fi
    return
  fi

  response=$(api_get "/api/conversations/$(urlencode "$conv_id")")
  if (( json )); then
    printf '%s\n' "$response" | jq --argjson head "$head" '{summary: .conversation, records: (.blocks[0:$head])}'
  else
    printf '%s\n' "$response" | api_jq_human '
      .conversation as $c |
      "\($c.source) \(($c.session_id // $c.id) | mandible_short_id)",
      "path: \($c.source_path)",
      "mtime: \($c.updated_at // $c.started_at)",
      "records shown: \([.blocks[0:$head][]] | length)",
      (.blocks[0:$head][] | (.content | gsub("\\s+"; " ") | if length > 500 then .[0:497] + "..." else . end))' --argjson head "$head"
  fi
}

file_rpc_warn_truncated_blocks() {
  local response="$1" total returned offset limit next_offset truncated
  total=$(printf '%s\n' "$response" | jq -r '.total // 0')
  returned=$(printf '%s\n' "$response" | jq -r '.blocks | length')
  offset=$(printf '%s\n' "$response" | jq -r '.offset // 0')
  limit=$(printf '%s\n' "$response" | jq -r '.limit // 0')
  truncated=$(printf '%s\n' "$response" | jq -r '((.truncated // false) or (((.offset // 0) + (.blocks | length)) < (.total // 0)))')
  if [[ "$truncated" == "true" ]]; then
    next_offset=$(( offset + returned ))
    printf 'Warning: output truncated: returned %s of %s blocks from offset %s (limit %s). Use --offset %s for the next window.\n' \
      "$returned" "$total" "$offset" "$limit" "$next_offset" >&2
  fi
}

if api_is_file_rpc; then
  case "${1:-}" in
    inventory) shift; file_rpc_inventory "$@"; exit $? ;;
    inspect) shift; file_rpc_inspect "$@"; exit $? ;;
    missing|orphans)
      echo "Error: logs ${1} needs host filesystem comparison and is not available through file-RPC." >&2
      exit 2 ;;
  esac
fi

if [[ $# -eq 0 || "${1:-}" == "-h" || "${1:-}" == "--help" || "${1:-}" == "help" ]]; then
  usage
  if [[ $# -eq 0 ]]; then
    exit 2
  fi
  exit 0
fi

export MANDIBLE_DB="$(api_live_db_path)"
exec "$(mandible_bun_runtime)" --no-install "$(mandible_cli_module cli/source-logs)" "$@"
