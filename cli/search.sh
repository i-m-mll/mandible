#!/usr/bin/env bash
# mandible search: exact source-verified chat history search across providers.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
source "$SCRIPT_DIR/api.sh"

QUERY=""
PROVIDER="all"
ROLE=""
SINCE=""
LIMIT=20
TITLE_ONLY=0

usage() {
  mandible_command_help search
}

binding=$(mandible_bind_main_arguments "search" '{"PROVIDER":{"option":"provider"},"ROLE":{"option":"role"},"SINCE":{"option":"since"},"LIMIT":{"option":"limit"},"TITLE_ONLY":{"option":"title","constant":"1"},"QUERY":{"position":0}}' "$@") || exit $?
eval "$binding"

if [[ -z "$QUERY" ]]; then
  echo "Error: search query is required." >&2
  usage >&2
  exit 1
fi

case "$PROVIDER" in
  claude) SOURCE="claude_code" ;;
  codex|gemini) SOURCE="$PROVIDER" ;;
  all) SOURCE="" ;;
  *) echo "Error: unknown provider '$PROVIDER'. Use: claude, gemini, codex, all" >&2; exit 1 ;;
esac
case "$ROLE" in
  user|assistant|"") ;;
  *) echo "Error: unknown role '$ROLE'. Use: user, assistant" >&2; exit 1 ;;
esac
if [[ -n "$SINCE" && ! "$SINCE" =~ ^[0-9]+d$ ]]; then
  echo "Error: --since format must be Nd (e.g. 7d, 30d)" >&2
  exit 1
fi
if [[ ! "$LIMIT" =~ ^[0-9]+$ ]] || (( LIMIT < 1 )); then
  echo "Error: --limit must be a positive integer" >&2
  exit 1
fi

# Loopback and file-RPC deliberately share the daemon route. A direct local
# SQLite fallback would bypass the disposable cache, bounded cold reader, and
# exact verification contract.
request="/api/conversations/search?q=$(urlencode "$QUERY")&limit=$(urlencode "$LIMIT")"
if [[ -n "$SOURCE" ]]; then request="${request}&source=$(urlencode "$SOURCE")"; fi
if [[ -n "$ROLE" ]]; then request="${request}&role=$(urlencode "$ROLE")"; fi
if [[ -n "$SINCE" ]]; then request="${request}&since=$(urlencode "$SINCE")"; fi
if (( TITLE_ONLY )); then request="${request}&title=true"; fi

api_get "$request" | jq -r '
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
