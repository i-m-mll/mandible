#!/usr/bin/env bash
# mandible conversations: inspect DB-backed normalized conversations.
source "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd -P)/command-syntax.sh"

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
source "$SCRIPT_DIR/api.sh"

MANDIBLE_DB="$(api_live_db_path)"

usage() {
  mandible_command_help conversations
}

conversation_spawn_command() {
  local provider="" message="" label="New chat" project_id="" checkout_id="" topology="top-level" target="" idempotency_key="" json=0
  local command backend lane payload response topology_json placement_json
  local binding
  binding=$(mandible_bind_arguments "conversations.spawn" '{"provider":{"option":"provider"},"message":{"option":"message"},"label":{"option":"label"},"project_id":{"option":"project-id"},"checkout_id":{"option":"checkout-id"},"topology":{"option":"topology"},"target":{"option":"target"},"idempotency_key":{"option":"idempotency-key"},"json":{"option":"json","constant":"1"}}' "$@") || return $?
  eval "$binding"
  [[ -n "$message" ]] || { echo "Error: --message is required." >&2; return 2; }
  [[ "$provider" == "claude" || "$provider" == "codex" || "$provider" == "gemini" ]] || {
    echo "Error: --provider must be claude, codex, or gemini." >&2; return 2;
  }
  [[ -z "$project_id" && -z "$checkout_id" || -n "$project_id" && -n "$checkout_id" ]] || {
    echo "Error: --project-id and --checkout-id must be supplied together." >&2; return 2;
  }
  if [[ "$topology" == "top-level" ]]; then
    [[ -z "$target" ]] || { echo "Error: top-level topology does not accept --target." >&2; return 2; }
    topology_json='{"kind":"top-level"}'
  elif [[ "$topology" == "autonomous" ]]; then
    topology_json=$(jq -nc --arg target "$target" '{kind:"autonomous",sponsor_conversation_id:(if $target == "" then null else $target end)}')
  else
    [[ "$topology" == "child" || "$topology" == "sibling" || "$topology" == "successor" ]] || { echo "Error: invalid topology." >&2; return 2; }
    [[ -n "$target" ]] || { echo "Error: --target is required for $topology topology." >&2; return 2; }
    local target_key="${topology}_conversation_id"
    [[ "$topology" == "successor" ]] && target_key="predecessor_conversation_id"
    topology_json=$(jq -nc --arg kind "$topology" --arg key "$target_key" --arg target "$target" '{kind:$kind} + {($key):$target}')
  fi
  if [[ -n "$project_id" ]]; then
    placement_json=$(jq -nc --arg project "$project_id" --arg checkout "$checkout_id" '{project_id:$project,checkout_id:$checkout}')
  else
    placement_json='{"project_id":null,"checkout_id":null}'
  fi
  [[ -n "$idempotency_key" ]] || idempotency_key="cli-$(uuidgen | tr '[:upper:]' '[:lower:]')"
  command="$provider"; backend="acp"; lane="acp"
  [[ "$provider" == "claude" ]] && { command="claude"; backend="sdk"; lane="sdk"; provider="claude_code"; }
  payload=$(jq -nc --arg schema "mandible-conversation-spawn-request@1" --arg key "$idempotency_key" \
    --arg provider "$provider" --arg label "$label" --arg message "$message" --arg command "$command" \
    --arg backend "$backend" --arg lane "$lane" --argjson placement "$placement_json" --argjson topology "$topology_json" \
    '{schema:$schema,idempotency_key:$key,provider:$provider,label:$label,initial_message:$message,placement:$placement,topology:$topology,command:{name:$command,backend_type:$backend,transport_lane:$lane,channel_enabled:false,run_options:{}}}')
  response=$(api_send POST "/api/conversation-spawns" "$payload") || return $?
  if (( json )); then printf '%s\n' "$response" | jq .; else
    printf '%s\n' "$response" | api_jq_human '"\(.spawn.reservation_id | mandible_short_id): \(.spawn.state) [\(.spawn.request.provider)]\ninitial message: \(.spawn.initial_message_state)"'
  fi
}

conversation_custody_command() {
  local operation="${1:-}" target="${2:-}" json=0 rewind=0 mirroring=0
  local version="" destination="" staging_root="" provider_root="" payload response conv_id
  [[ -n "$operation" ]] || { usage >&2; return 2; }
  shift || true
  shift || true
  local binding
  binding=$(mandible_bind_arguments "conversations.custody.${operation}" '{"json":{"option":"json","constant":"1"},"rewind":{"option":"rewind","constant":"1"},"mirroring":{"option":"mirroring","constant":"1"},"version":{"option":"version"},"destination":{"option":"destination"},"staging_root":{"option":"staging-root"},"provider_root":{"option":"provider-root"}}' "$target" "$@") || return $?
  eval "$binding"
  [[ -n "$target" ]] || { echo "Error: custody $operation requires a target." >&2; return 2; }

  if [[ "$operation" == "import" ]]; then
    payload=$(jq -nc --arg archive_root "$target" '{archive_root:$archive_root}')
    response=$(api_send POST "/api/conversation-custody/import" "$payload") || return $?
  else
    conv_id=$(conversation_resolve_id "$target") || return $?
    case "$operation" in
      status) response=$(api_get "/api/conversations/$(urlencode "$conv_id")/custody") || return $? ;;
      capture)
        payload=$(jq -nc --argjson rewind "$rewind" --argjson seal "$(( mirroring ? 0 : 1 ))" '{rewind:($rewind == 1),seal:($seal == 1)}')
        response=$(api_send POST "/api/conversations/$(urlencode "$conv_id")/custody/capture" "$payload") || return $? ;;
      verify)
        payload=$(jq -nc --arg version "$version" 'if $version == "" then {} else {version:$version} end')
        response=$(api_send POST "/api/conversations/$(urlencode "$conv_id")/custody/verify" "$payload") || return $? ;;
      archive)
        [[ -n "$destination" ]] || { echo "Error: custody archive requires --destination." >&2; return 2; }
        payload=$(jq -nc --arg destination "$destination" '{destination:$destination}')
        response=$(api_send POST "/api/conversations/$(urlencode "$conv_id")/custody/archive" "$payload") || return $? ;;
      stage-restore)
        [[ -n "$staging_root" && -n "$provider_root" ]] || { echo "Error: stage-restore requires --staging-root and --provider-root." >&2; return 2; }
        payload=$(jq -nc --arg staging_root "$staging_root" --arg provider_root "$provider_root" '{staging_root:$staging_root,provider_root:$provider_root}')
        response=$(api_send POST "/api/conversations/$(urlencode "$conv_id")/custody/stage-restore" "$payload") || return $? ;;
      *) echo "Unknown custody operation: $operation" >&2; return 2 ;;
    esac
  fi

  if (( json )); then
    printf '%s\n' "$response" | jq .
  else
    printf '%s\n' "$response" | api_jq_human '
      if .status then
        (.status | "\(.conversation_id | mandible_short_id): \(.state)" + (if .active_version then " version \(.active_version)" else "" end))
      elif .archive_path then "Archive: \(.archive_path)"
      elif .staging_path then "Staged \(.files) files at \(.staging_path)\nProvider restore: \(.capability.capability)"
      elif .ok != null then "Integrity: " + (if .ok then "verified" else "FAILED\n" + (.errors | join("\n")) end)
      else .
      end'
  fi
}

conversation_source() {
  case "$1" in
    claude) echo "claude_code" ;;
    codex|gemini) echo "$1" ;;
    all|"") echo "" ;;
    *) echo "Error: unknown provider '$1'. Use: claude, codex, gemini, all" >&2; exit 1 ;;
  esac
}

conversation_resolve_id() {
  local ident="$1"
  local encoded response resolved
  encoded=$(urlencode "$ident")
  response=$(api_get "/api/conversations?session_id=${encoded}&limit=1" 2>/dev/null || true)
  resolved=$(printf '%s' "$response" | jq -r '.conversations[0].id // empty' 2>/dev/null || true)
  if [[ -n "$resolved" ]]; then
    printf '%s' "$resolved"
  else
    printf '%s' "$ident"
  fi
}

file_rpc_list() {
  local provider="all" tag="" since="" limit=20 json=0 source request response
  local binding
  binding=$(mandible_bind_arguments "conversations.list" '{"provider":{"option":"provider"},"tag":{"option":"tag"},"since":{"option":"since"},"limit":{"option":"limit"},"json":{"option":"json","constant":"1"}}' "$@") || return $?
  eval "$binding"
  source=$(conversation_source "$provider")
  request="/api/conversations?limit=$(urlencode "$limit")"
  if [[ -n "$source" ]]; then request="${request}&source=$(urlencode "$source")"; fi
  if [[ -n "$tag" ]]; then request="${request}&tag=$(urlencode "$tag")"; fi
  if [[ -n "$since" ]]; then request="${request}&since=$(urlencode "$since")"; fi
  response=$(api_get "$request")
  if (( json )); then
    printf '%s\n' "$response" | jq '.conversations'
  else
    printf '%s\n' "$response" | api_jq_human '.conversations[] | "\(mandible_display_id)\t\(.source)\t\(.started_at)\t\(.block_count)\t\(.title)"'
  fi
}

conversation_resolve_mutation_target() {
  local target="$1" current="$2" source="" session_id="" exact_file session_file exact_status response count parent_id
  exact_file=$(api_temp_file)
  session_file=$(api_temp_file)
  if (( current )); then
    source=$(api_ambient_provider)
    session_id=$(api_ambient_session_id)
    [[ -n "$source" && -n "$session_id" ]] || {
      echo "Error: --current requires an ambient provider session/thread id." >&2
      return 2
    }
    source=$(conversation_source "$source")
    printf '{}\n' > "$exact_file"
  else
    session_id="$target"
    exact_status=$(api_capture GET "/api/conversations/$(urlencode "$target")" "" "$exact_file")
    [[ "$exact_status" == "404" || "$exact_status" =~ ^2 ]] || {
      cat "$exact_file" >&2
      return 22
    }
  fi
  response=$(api_get "/api/conversations?session_id=$(urlencode "$session_id")&limit=200${source:+&source=$(urlencode "$source")}")
  printf '%s\n' "$response" > "$session_file"
  response=$(jq -sc '[ (.[0].conversation? // empty), (.[1].conversations[]? // empty) ] | unique_by(.id)' "$exact_file" "$session_file")
  count=$(printf '%s\n' "$response" | jq 'length')
  if (( count > 1 )); then
    parent_id=$(printf '%s\n' "$response" | jq -r '
      def sidechain: (.is_sidechain == true or .is_sidechain == 1);
      [ .[] | select((sidechain | not) and (.parent_conversation_id // null) == null) ] as $parents
      | if ($parents | length) == 1
          and all(.[]; .id == $parents[0].id or (sidechain and .parent_conversation_id == $parents[0].id))
        then $parents[0].id
        else empty
        end')
    if [[ -n "$parent_id" ]]; then
      printf '%s\n' "$parent_id"
      return 0
    fi
  fi
  if [[ "$count" != "1" ]]; then
    echo "Error: conversation reference resolved to ${count} matches; expected exactly one." >&2
    return 2
  fi
  printf '%s\n' "$response" | jq -r '.[0].id'
}

conversation_render_mutation() {
  local response="$1" json="$2"
  if (( json )); then
    printf '%s\n' "$response" | jq .
  else
    printf '%s\n' "$response" | api_jq_human '"\(mandible_display_id) [\(.source)] \(.title)\nstarred: \(.starred)\ntags: \(.tags | join(", "))\nnotes: \(.notes // "-")"'
  fi
}

conversation_metadata_command() {
  local command="$1"; shift
  local operation="" target="" current=0 json=0 message="" payload="" conv_id response
  local -a tags=()
  if [[ "$command" == "tag" ]]; then
    operation="${1:-}"; shift || true
    [[ "$operation" == "add" || "$operation" == "rm" ]] || { usage >&2; return 2; }
  else
    operation="$command"
  fi
  local grammar_key="conversations.$command"
  [[ "$command" != "tag" ]] || grammar_key="conversations.tag.$operation"
  local binding
  binding=$(mandible_bind_arguments "$grammar_key" '{"current":{"option":"current","constant":"1"},"json":{"option":"json","constant":"1"},"message":{"option":["m","message"]},"target":{"position":0,"unlessOption":"current"},"tags":[{"rest":0,"whenOption":"current"},{"rest":1}]}' "$@") || return $?
  eval "$binding"
  if (( current )); then
    [[ -z "$target" ]] || { echo "Error: use a conversation ref or --current, not both." >&2; return 2; }
  else
    [[ -n "$target" ]] || { echo "Error: conversation ref or --current is required." >&2; return 2; }
  fi
  case "$operation" in
    star) payload='{"starred":true}' ;;
    unstar) payload='{"starred":false}' ;;
    add)
      (( ${#tags[@]} > 0 )) || { echo "Error: at least one tag is required." >&2; return 2; }
      payload=$(printf '%s\n' "${tags[@]}" | jq -Rsc 'split("\n")[:-1] | {tags_add:.}') ;;
    rm)
      (( ${#tags[@]} > 0 )) || { echo "Error: at least one tag is required." >&2; return 2; }
      payload=$(printf '%s\n' "${tags[@]}" | jq -Rsc 'split("\n")[:-1] | {tags_remove:.}') ;;
    comment)
      [[ -n "${message//[[:space:]]/}" ]] || { echo "Error: comment -m requires non-empty markdown." >&2; return 2; }
      payload=$(jq -nc --arg notes_append "$message" '{notes_append:$notes_append}') ;;
  esac
  conv_id=$(conversation_resolve_mutation_target "$target" "$current") || return $?
  response=$(api_send PATCH "/api/conversations/$(urlencode "$conv_id")" "$payload") || return $?
  conversation_render_mutation "$response" "$json"
}

file_rpc_show() {
  local ident="${1:-}" json=0 blocks=0 response
  if [[ -z "$ident" ]]; then echo "conversation id or session id required" >&2; exit 2; fi
  shift
  local binding
  binding=$(mandible_bind_arguments "conversations.show" '{"json":{"option":"json","constant":"1"},"blocks":{"option":"blocks","constant":"1"}}' "$target" "$@") || return $?
  eval "$binding"
  response=$(api_get "/api/conversations/$(urlencode "$ident")?target=latest")
  if (( json )); then
    if (( blocks )); then
      printf '%s\n' "$response" | jq .
    else
      printf '%s\n' "$response" | jq '{conversation: .conversation}'
    fi
  else
    printf '%s\n' "$response" | api_jq_human '
      .conversation as $c |
      "\($c | mandible_display_id) [\($c.source)] \($c.title)",
      "session: \($c.session_id | mandible_short_id)",
      "started: \($c.started_at)",
      "blocks: \($c.block_count)",
      "cwd: \($c.cwd // "-")",
      "source_path: \($c.source_path)"'
    if (( blocks )); then
      printf '%s\n' "$response" | jq -r '.blocks[0:20][] | "- \(.position) \(.type) \(.role): \((.content | gsub("\\s+"; " ")) | if length > 160 then .[0:157] + "..." else . end)"'
    fi
  fi
}

file_rpc_blocks() {
  local ident="${1:-}" type_filter="" role_filter="" content_filter="" limit=100 offset=0 json=0 request response
  if [[ -z "$ident" ]]; then echo "conversation id or session id required" >&2; exit 2; fi
  shift
  local binding
  binding=$(mandible_bind_arguments "conversations.blocks" '{"type_filter":{"option":"type"},"role_filter":{"option":"role"},"content_filter":{"option":["content","contains"]},"limit":{"option":"limit"},"offset":{"option":"offset"},"json":{"option":"json","constant":"1"}}' "$target" "$@") || return $?
  eval "$binding"
  request="/api/conversations/$(urlencode "$ident")/blocks?limit=$(urlencode "$limit")&offset=$(urlencode "$offset")"
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
      '.blocks[] | select($role == "" or .role == $role) | select($content == "" or (.content | contains($content))) | "\(.position)\t\(.type)\t\(.role)\t\((.content | gsub("\\s+"; " ")) | if length > 220 then .[0:217] + "..." else . end)"'
  fi
}

conversation_export_api() {
  local ident="${1:-}" format="markdown" payload response
  if [[ -z "$ident" ]]; then echo "conversation id or session id required" >&2; return 2; fi
  shift
  local binding
  binding=$(mandible_bind_arguments "conversations.export" '{"format":{"option":"format"}}' "$target" "$@") || return $?
  eval "$binding"
  [[ "$format" == "json" || "$format" == "markdown" ]] || {
    echo "Error: format must be json or markdown." >&2
    return 2
  }
  payload=$(jq -nc --arg format "$format" '{format:$format}')
  response=$(api_send POST "/api/conversations/$(urlencode "$ident")/export" "$payload") || return $?
  printf '%s\n' "$response" | jq -r '.content'
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

file_rpc_search() {
  local query="${1:-}" provider="all" role="" since="" limit=20 title=0 json=0 source request response
  if [[ -z "$query" ]]; then echo "Error: search query is required." >&2; exit 1; fi
  shift
  local binding
  binding=$(mandible_bind_arguments "conversations.search" '{"provider":{"option":"provider"},"role":{"option":"role"},"since":{"option":"since"},"limit":{"option":"limit"},"title":{"option":"title","constant":"1"},"json":{"option":"json","constant":"1"}}' "$query" "$@") || return $?
  eval "$binding"
  source=$(conversation_source "$provider")
  request="/api/conversations/search?q=$(urlencode "$query")&limit=$(urlencode "$limit")"
  if [[ -n "$source" ]]; then request="${request}&source=$(urlencode "$source")"; fi
  if [[ -n "$role" ]]; then request="${request}&role=$(urlencode "$role")"; fi
  if [[ -n "$since" ]]; then request="${request}&since=$(urlencode "$since")"; fi
  if (( title )); then request="${request}&title=true"; fi
  response=$(api_get "$request")
  if (( json )); then
    printf '%s\n' "$response" | jq .
  else
    printf '%s\n' "$response" | jq -r '
      .results[] |
      .conversation as $c |
      ($c.source | sub("claude_code"; "claude")) as $source |
      ($c.started_at[0:10] // "?") as $date |
      ($c.title // "" | if length > 60 then .[0:60] + "..." else . end) as $title |
      if .block then
        "[\($source)] \($date) | \"\($title)\" | \(.block.role): \(.snippet)"
      else
        "[\($source)] \($date) | \"\(.snippet)\""
      end'
  fi
}

# Issue 71a287e — on-demand credential-leak sweep over the normalized index.
# The daemon does the matching (it holds the token pepper); this only shapes the
# request and renders the structured result. No token material is ever printed.
scan_credentials() {
  local conversation="" limit="" dry_run=0 json=0 payload response
  local binding
  binding=$(mandible_bind_arguments "conversations.scan-credentials" '{"conversation":{"option":"conversation"},"limit":{"option":"limit"},"dry_run":{"option":"dry-run","constant":"1"},"json":{"option":"json","constant":"1"}}' "$@") || return $?
  eval "$binding"

  payload=$(jq -nc \
    --arg conversation "$conversation" \
    --arg limit "$limit" \
    --argjson record "$(( dry_run ? 0 : 1 ))" \
    '{record: ($record == 1)}
     + (if $conversation == "" then {} else {conversation_id: $conversation} end)
     + (if $limit == "" then {} else {limit: ($limit | tonumber)} end)')

  response=$(api_send POST "/api/conversations/scan-credentials" "$payload")

  if (( json )); then
    printf '%s\n' "$response" | jq .
    return 0
  fi

  printf '%s\n' "$response" | jq -r '
    "Scanned \(.scanned_blocks) blocks across \(.scanned_conversations) conversations."
    + (if .truncated then "\nWarning: candidate verification was truncated at the pathological per-text limit." else "" end)
    + (if .skipped then "\nSkipped: \(.skipped)" else "" end)
    + (if (.detections | length) == 0 then "\nNo leaked credentials found."
       else "\n\nLeaked credentials (\(.detections | length)):\n"
         + ([.detections[] |
              "  - \(.credential_label // .credential_id) (\(.credential_id))"
              + "\n      owner:      \(.user_slug // "unknown")"
              + "\n      leaked in:  \(.conversation_title // .conversation_id) [\(.provider // "unknown")]"
              + "\n      policy:     " + (if .session_scoped then "session-scoped" else "long-lived PAT — not auto-revoked" end)
              + "\n      revoked:    \(.auto_revoked)"
              + "\n      remediate:  \(.remediation.mint)"
              + "\n                  \(.remediation.revoke)"
            ] | join("\n"))
       end)'
}

file_rpc_main() {
  local command="${1:-}"
  case "$command" in
    list) shift; file_rpc_list "$@" ;;
    show) shift; file_rpc_show "$@" ;;
    blocks) shift; file_rpc_blocks "$@" ;;
    export) shift; conversation_export_api "$@" ;;
    search) shift; file_rpc_search "$@" ;;
    scan-credentials) shift; scan_credentials "$@" ;;
    ""|-h|--help|help) usage; exit 0 ;;
    *) echo "Unknown conversations subcommand: $command" >&2; usage >&2; exit 1 ;;
  esac
}

if api_is_file_rpc; then
  case "${1:-}" in
    star|unstar|tag|comment) command="$1"; shift; conversation_metadata_command "$command" "$@"; exit $? ;;
    spawn) shift; conversation_spawn_command "$@"; exit $? ;;
    custody) shift; conversation_custody_command "$@"; exit $? ;;
  esac
  file_rpc_main "$@"
  exit $?
fi

case "${1:-}" in
  storage)
    shift
    exec "$("$SCRIPT_DIR/../scripts/bun-runtime.sh")" "$(cd "$SCRIPT_DIR/.." && pwd -P)/dist/cli/conversation-storage.js" "$@" --db "$MANDIBLE_DB"
    ;;
  star|unstar|tag|comment) command="$1"; shift; conversation_metadata_command "$command" "$@"; exit $? ;;
  spawn) shift; conversation_spawn_command "$@"; exit $? ;;
  custody) shift; conversation_custody_command "$@"; exit $? ;;
esac

# Issue 71a287e — scan-credentials is daemon-side in every transport: only the
# daemon holds the token pepper needed to verify a candidate.
if [[ "${1:-}" == "scan-credentials" ]]; then
  shift
  scan_credentials "$@"
  exit $?
fi

# Exact reads always traverse the daemon's shared resolver/freshness barrier,
# including the normal local transport. The Python/SQLite code below remains
# list-only compatibility machinery and cannot bypass catch-up.
case "${1:-}" in
  show) shift; file_rpc_show "$@"; exit $? ;;
  blocks) shift; file_rpc_blocks "$@"; exit $? ;;
  export) shift; conversation_export_api "$@"; exit $? ;;
esac

if [[ ! -f "$MANDIBLE_DB" ]]; then
  echo "Error: Mandible database not found at $MANDIBLE_DB" >&2
  exit 1
fi

case "${1:-}" in
  search)
    shift
    exec "$SCRIPT_DIR/search.sh" "$@"
    ;;
  blocks)
    shift
    exec "$("$SCRIPT_DIR/../scripts/bun-runtime.sh")" "$(cd "$SCRIPT_DIR/.." && pwd -P)/dist/cli/conversation-blocks.js" conversations "$MANDIBLE_DB" "$@"
    ;;
esac

export MANDIBLE_PARSED_COMMAND
MANDIBLE_PARSED_COMMAND=$(mandible_parse_command conversations "$@") || exit $?
exec python3 - "$MANDIBLE_DB" "$@" <<'PY'
from __future__ import annotations

from types import SimpleNamespace
import datetime as dt
import gzip
import json
import sqlite3
import sys
import zlib
from typing import Any


def map_provider(value: str) -> str | None:
    return {"claude": "claude_code", "codex": "codex", "gemini": "gemini", "all": None}[value]


def parse_since(value: str | None) -> str | None:
    if not value:
        return None
    if value.endswith("d") and value[:-1].isdigit():
        cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=int(value[:-1]))
        return cutoff.isoformat()
    return value


def row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    item = {key: row[key] for key in row.keys()}
    if "tags" in item:
        item["tags"] = json.loads(item["tags"])
    return item


def decompress(content: bytes | str, compressed: int) -> str:
    if not compressed:
        return content.decode("utf-8", errors="replace") if isinstance(content, bytes) else str(content)
    data = content.encode("latin-1") if isinstance(content, str) else content
    for fn in (gzip.decompress, lambda b: zlib.decompress(b, zlib.MAX_WBITS | 16), zlib.decompress):
        try:
            return fn(data).decode("utf-8", errors="replace")
        except Exception:
            pass
    return "<decompression failed>"


def connect(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path, timeout=5.0, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 5000")
    conn.execute("PRAGMA query_only = ON")
    return conn


def resolve_conversation(conn: sqlite3.Connection, ident: str) -> sqlite3.Row:
    row = conn.execute(
        """
        SELECT * FROM conversations
        WHERE id = ? OR session_id = ? OR id LIKE ?
        ORDER BY started_at DESC
        LIMIT 1
        """,
        (ident, ident, f"{ident}%"),
    ).fetchone()
    if row is None:
        raise SystemExit(f"conversation not found: {ident}")
    return row


def list_cmd(conn: sqlite3.Connection, args: SimpleNamespace) -> int:
    params: list[Any] = []
    where = ["1=1"]
    source = map_provider(args.provider)
    if source:
        where.append("source = ?")
        params.append(source)
    if args.tag:
        where.append("EXISTS (SELECT 1 FROM json_each(conversations.tags) WHERE json_each.value = ?)")
        params.append(args.tag)
    since = parse_since(args.since)
    if since:
        where.append("started_at >= ?")
        params.append(since)
    params.append(args.limit)
    rows = conn.execute(
        f"""
        SELECT id, source, title, started_at, updated_at, block_count, session_id, cwd, branch, model, source_path, tags
        FROM conversations
        WHERE {' AND '.join(where)}
        ORDER BY started_at DESC
        LIMIT ?
        """,
        params,
    ).fetchall()
    data = [row_to_dict(row) for row in rows]
    if args.json:
        print(json.dumps(data, indent=2))
    else:
        for row in data:
            print(f"{row['id'][:8]}\t{row['source']}\t{row['started_at']}\t{row['block_count']}\t{row['title']}")
    return 0


def blocks_for(conn: sqlite3.Connection, conversation_id: str) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT id, conversation_id, type, role, content, compressed, position, timestamp, parent_id, metadata_json
        FROM conversation_blocks
        WHERE conversation_id = ?
        ORDER BY position ASC
        """,
        (conversation_id,),
    ).fetchall()
    out = []
    for row in rows:
        item = row_to_dict(row)
        item["content"] = decompress(row["content"], row["compressed"])
        del item["compressed"]
        out.append(item)
    return out


def show_cmd(conn: sqlite3.Connection, args: SimpleNamespace) -> int:
    conv = row_to_dict(resolve_conversation(conn, args.ident))
    payload: dict[str, Any] = {"conversation": conv}
    if args.blocks:
        payload["blocks"] = blocks_for(conn, conv["id"])
    if args.json:
        print(json.dumps(payload, indent=2))
    else:
        print(f"{conv['id']} [{conv['source']}] {conv['title']}")
        print(f"session: {conv['session_id']}")
        print(f"started: {conv['started_at']}")
        print(f"blocks: {conv['block_count']}")
        print(f"cwd: {conv['cwd'] or '-'}")
        print(f"source_path: {conv['source_path']}")
        if args.blocks:
            for block in payload["blocks"][:20]:
                text = " ".join(block["content"].split())
                if len(text) > 160:
                    text = text[:157] + "..."
                print(f"- {block['position']} {block['type']} {block['role']}: {text}")
    return 0


def blocks_cmd(conn: sqlite3.Connection, args: SimpleNamespace) -> int:
    conv = row_to_dict(resolve_conversation(conn, args.ident))
    blocks = blocks_for(conn, conv["id"])
    if args.type:
        blocks = [block for block in blocks if block["type"] == args.type]
    blocks = blocks[: args.limit]
    if args.json:
        print(json.dumps(blocks, indent=2))
    else:
        for block in blocks:
            text = " ".join(block["content"].split())
            if len(text) > 220:
                text = text[:217] + "..."
            print(f"{block['position']}\t{block['type']}\t{block['role']}\t{text}")
    return 0


def export_cmd(conn: sqlite3.Connection, args: SimpleNamespace) -> int:
    conv = row_to_dict(resolve_conversation(conn, args.ident))
    blocks = blocks_for(conn, conv["id"])
    if args.format == "json":
        print(json.dumps({"conversation": conv, "blocks": blocks}, indent=2))
    else:
        print(f"# {conv['title']}\n")
        print(f"Source: {conv['source']}  ")
        print(f"Started: {conv['started_at']}  ")
        print(f"Session: {conv['session_id']}\n")
        for block in blocks:
            role = block["role"] or block["type"]
            print(f"## {role} ({block['type']})\n")
            print(block["content"])
            print()
    return 0


def main() -> int:
    db_path = sys.argv[1]
    parsed = json.loads(os.environ["MANDIBLE_PARSED_COMMAND"])
    values = {'provider': 'all', 'since': None, 'tag': None, 'limit': 20, 'json': False, 'blocks': False, 'format': 'markdown', 'head': 20, 'parse': False, 'role': None, 'type': None, 'tool': None, 'tool_kind': None, 'until': None, 'content': None, 'offset': 0}
    values.update({key.replace("-", "_"): value for key, value in parsed["options"].items()})
    for key in ("limit", "head", "offset"):
        values[key] = int(values[key])
    values["command"] = parsed["command"].split(".")[-1]
    positions = parsed["positionals"]
    values["ident"] = positions[0] if positions else None
    values["target"] = positions[0] if positions else None
    args = SimpleNamespace(**values)
    conn = connect(db_path)
    try:
        if args.command == "list":
            return list_cmd(conn, args)
        if args.command == "show":
            return show_cmd(conn, args)
        if args.command == "export":
            return export_cmd(conn, args)
        raise ValueError(f"Unsupported parsed command: {args.command}")
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
PY
