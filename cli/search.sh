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
  cat <<'EOF'
Usage: mandible search "<query>" [options]

Search conversation history across all providers (Claude, Codex, Gemini).

Options:
  --provider claude|gemini|codex|all   Filter by provider (default: all)
  --role user|assistant                Filter by message role
  --since Nd                           Only conversations from last N days
  --limit N                            Max results (default: 20)
  --title                              Search conversation titles only
  -h, --help                           Show this help

Examples:
  mandible search "worktree merge"
  mandible search "auth request" --provider claude --since 7d
  mandible search "training loss" --role assistant --limit 5
  mandible search "bigbuild" --title
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --provider) PROVIDER="${2:?--provider requires a value}"; shift 2 ;;
    --role) ROLE="${2:?--role requires a value}"; shift 2 ;;
    --since) SINCE="${2:?--since requires a value}"; shift 2 ;;
    --limit) LIMIT="${2:?--limit requires a value}"; shift 2 ;;
    --title) TITLE_ONLY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
    *)
      if [[ -z "$QUERY" ]]; then
        QUERY="$1"
      else
        echo "Unexpected argument: $1" >&2
        usage >&2
        exit 1
      fi
      shift
      ;;
  esac
done

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
