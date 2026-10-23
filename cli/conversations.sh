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
  binding=$(mandible_bind_arguments "conversations.show" '{"json":{"option":"json","constant":"1"},"blocks":{"option":"blocks","constant":"1"}}' "$ident" "$@") || return $?
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
  binding=$(mandible_bind_arguments "conversations.blocks" '{"type_filter":{"option":"type"},"role_filter":{"option":"role"},"content_filter":{"option":["content","contains"]},"limit":{"option":"limit"},"offset":{"option":"offset"},"json":{"option":"json","constant":"1"}}' "$ident" "$@") || return $?
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
  binding=$(mandible_bind_arguments "conversations.export" '{"format":{"option":"format"}}' "$ident" "$@") || return $?
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

conversation_search() {
  local query="" provider="all" role="" since="" limit=20 title=0 json=0 source request response
  local binding
  binding=$(mandible_bind_arguments "conversations.search" '{"query":{"position":0},"provider":{"option":"provider"},"role":{"option":"role"},"since":{"option":"since"},"limit":{"option":"limit"},"title":{"option":"title","constant":"1"},"json":{"option":"json","constant":"1"}}' "$@") || return $?
  eval "$binding"
  source=$(conversation_source "$provider")
  request="/api/conversations/search?q=$(urlencode "$query")&limit=$(urlencode "$limit")"
  if [[ -n "$source" ]]; then request="${request}&source=$(urlencode "$source")"; fi
  if [[ -n "$role" ]]; then request="${request}&role=$(urlencode "$role")"; fi
  if [[ -n "$since" ]]; then request="${request}&since=$(urlencode "$since")"; fi
  if (( title )); then request="${request}&title=true"; fi
  response=$(api_get "$request") || return $?
  printf '%s\n' "$response" | jq -r --argjson requested "$limit" \
    'select(.limit < $requested) | "Warning: --limit \($requested) exceeds the server cap; at most \(.limit) hits are returned."' >&2
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
    search) shift; conversation_search "$@" ;;
    scan-credentials) shift; scan_credentials "$@" ;;
    ""|-h|--help|help) usage; exit 0 ;;
    *) echo "Unknown conversations subcommand: $command" >&2; usage >&2; exit 1 ;;
  esac
}

# Issue 061c5d6 — conversations that are children without a trustworthy
# parent (gaps), and children whose relation was assumed (warnings).
lineage_gaps_command() {
  local since="" provider="all" json=0 query response binding
  binding=$(mandible_bind_arguments "conversations.lineage-gaps" '{"since":{"option":"since"},"provider":{"option":"provider"},"json":{"option":"json","constant":"1"}}' "$@") || return $?
  eval "$binding"
  query="provider=$(urlencode "$provider")"
  if [[ -n "$since" ]]; then query="${query}&since=$(urlencode "$since")"; fi
  response=$(api_get "/api/conversations/lineage-gaps?${query}") || return $?
  if (( json )); then
    printf '%s\n' "$response" | jq .
    return 0
  fi
  printf '%s\n' "$response" | api_jq_human '
    (if .since then "Lineage gaps in conversations started since \(.since):" else "Lineage gaps:" end),
    (if (.gaps | length) == 0 then "none" else
      (.counts[] | "  \(.severity)\t\(.source)\t\(.kind)\t\(.count)"),
      "",
      (.gaps[] | "\(.session_id)\t\(.source)\t\(.severity)\t\(.kind)\t\(.started_at)\t\(.opening_line // .title)")
    end)'
}

if api_is_file_rpc; then
  case "${1:-}" in
    star|unstar|tag|comment) command="$1"; shift; conversation_metadata_command "$command" "$@"; exit $? ;;
    custody) shift; conversation_custody_command "$@"; exit $? ;;
    lineage-gaps) shift; lineage_gaps_command "$@"; exit $? ;;
  esac
  file_rpc_main "$@"
  exit $?
fi

case "${1:-}" in
  storage)
    shift
    exec "$("$SCRIPT_DIR/../scripts/bun-runtime.sh")" "$(cd "$SCRIPT_DIR/.." && pwd -P)/src/cli/conversation-storage.ts" "$@" --db "$MANDIBLE_DB"
    ;;
  star|unstar|tag|comment) command="$1"; shift; conversation_metadata_command "$command" "$@"; exit $? ;;
  custody) shift; conversation_custody_command "$@"; exit $? ;;
  lineage-gaps) shift; lineage_gaps_command "$@"; exit $? ;;
esac

# Issue 71a287e — scan-credentials is daemon-side in every transport: only the
# daemon holds the token pepper needed to verify a candidate.
if [[ "${1:-}" == "scan-credentials" ]]; then
  shift
  scan_credentials "$@"
  exit $?
fi

# List and exact reads share the daemon identity and freshness boundary.
case "${1:-}" in
  list) shift; file_rpc_list "$@" ;;
  search) shift; conversation_search "$@" ;;
  show) shift; file_rpc_show "$@" ;;
  blocks) shift; file_rpc_blocks "$@" ;;
  export) shift; conversation_export_api "$@" ;;
  ""|-h|--help|help) usage ;;
  *) echo "Unknown conversations subcommand: $1" >&2; usage >&2; exit 1 ;;
esac
