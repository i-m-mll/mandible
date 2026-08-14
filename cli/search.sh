#!/usr/bin/env bash
# mandible search: Unified chat history search across all providers.
#
# Searches conversation blocks (user/assistant messages) stored in the
# Mandible SQLite database. Blocks are gzip-compressed, so this script
# delegates to Python for decompression + search.
#
# Usage: mandible search "<query>" [options]
#
# Options:
#   --provider claude|gemini|codex|all   Filter by provider (default: all)
#   --role user|assistant                Filter by message role
#   --since Nd                           Only conversations from last N days
#   --limit N                            Max results (default: 20)
#   --title                              Search conversation titles only (fast)
#   -h, --help                           Show this help
#
# Bug: dc6ee15 — unified chat history search CLI

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
source "$SCRIPT_DIR/api.sh"

# --- Defaults ---
QUERY=""
PROVIDER="all"
ROLE=""
SINCE=""
LIMIT=20
TITLE_ONLY=0

MANDIBLE_DB="$(api_live_db_path)"

usage() {
  cat <<'EOF'
Usage: mandible search "<query>" [options]

Search conversation history across all providers (Claude, Codex, Gemini).

Options:
  --provider claude|gemini|codex|all   Filter by provider (default: all)
  --role user|assistant                Filter by message role
  --since Nd                           Only conversations from last N days
  --limit N                            Max results (default: 20)
  --title                              Search conversation titles only (fast)
  -h, --help                           Show this help

Examples:
  mandible search "worktree merge"
  mandible search "auth request" --provider claude --since 7d
  mandible search "training loss" --role assistant --limit 5
  mandible search "bigbuild" --title
EOF
}

# --- Parse arguments ---
while [[ $# -gt 0 ]]; do
  case "$1" in
    --provider)  PROVIDER="${2:?--provider requires a value}"; shift 2 ;;
    --role)      ROLE="${2:?--role requires a value}"; shift 2 ;;
    --since)     SINCE="${2:?--since requires a value}"; shift 2 ;;
    --limit)     LIMIT="${2:?--limit requires a value}"; shift 2 ;;
    --title)     TITLE_ONLY=1; shift ;;
    -h|--help)   usage; exit 0 ;;
    -*)          echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
    *)
      if [[ -z "$QUERY" ]]; then
        QUERY="$1"
      else
        echo "Unexpected argument: $1" >&2; usage >&2; exit 1
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

if api_is_file_rpc; then
  case "$PROVIDER" in
    claude) DB_SOURCE="claude_code" ;;
    codex|gemini) DB_SOURCE="$PROVIDER" ;;
    all) DB_SOURCE="" ;;
    *) echo "Error: unknown provider '$PROVIDER'. Use: claude, gemini, codex, all" >&2; exit 1 ;;
  esac
  case "$ROLE" in
    user|assistant|"") ;;
    *) echo "Error: unknown role '$ROLE'. Use: user, assistant" >&2; exit 1 ;;
  esac

  request="/api/conversations/search?q=$(urlencode "$QUERY")&limit=$(urlencode "$LIMIT")"
  if [[ -n "$DB_SOURCE" ]]; then request="${request}&source=$(urlencode "$DB_SOURCE")"; fi
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
  exit 0
fi

if [[ ! -f "$MANDIBLE_DB" ]]; then
  echo "Error: Mandible database not found at $MANDIBLE_DB" >&2
  echo "Is the Mandible daemon running? Has it ingested any conversations?" >&2
  exit 1
fi

# --- Map provider aliases to DB source values ---
map_provider() {
  case "$1" in
    claude)  echo "claude_code" ;;
    codex)   echo "codex" ;;
    gemini)  echo "gemini" ;;
    all)     echo "all" ;;
    *)       echo "Error: unknown provider '$1'. Use: claude, gemini, codex, all" >&2; exit 1 ;;
  esac
}

DB_SOURCE=$(map_provider "$PROVIDER")

# --- Map role to DB block types ---
map_role() {
  case "$1" in
    user)      echo "user_message" ;;
    assistant) echo "assistant_message" ;;
    "")        echo "" ;;
    *)         echo "Error: unknown role '$1'. Use: user, assistant" >&2; exit 1 ;;
  esac
}

DB_BLOCK_TYPE=$(map_role "$ROLE")

# --- Parse --since into days ---
SINCE_DAYS=""
if [[ -n "$SINCE" ]]; then
  if [[ "$SINCE" =~ ^([0-9]+)d$ ]]; then
    SINCE_DAYS="${BASH_REMATCH[1]}"
  else
    echo "Error: --since format must be Nd (e.g. 7d, 30d)" >&2
    exit 1
  fi
fi

# --- Execute search via Python (handles gzip decompression) ---
exec python3 - "$MANDIBLE_DB" "$QUERY" "$DB_SOURCE" "$DB_BLOCK_TYPE" "$SINCE_DAYS" "$LIMIT" "$TITLE_ONLY" <<'PYEOF'
import sqlite3
import sys
import zlib
import re
from datetime import datetime, timedelta, timezone

db_path, query, source, block_type, since_days, limit_str, title_only = sys.argv[1:8]
limit = int(limit_str)
title_only = title_only == "1"

conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row

query_lower = query.lower()

# --- Title-only search (fast, no decompression) ---
if title_only:
    sql = "SELECT id, source, title, started_at FROM conversations WHERE 1=1"
    params = []

    if source != "all":
        sql += " AND source = ?"
        params.append(source)

    if since_days:
        cutoff = (datetime.now(timezone.utc) - timedelta(days=int(since_days))).isoformat()
        sql += " AND started_at >= ?"
        params.append(cutoff)

    sql += " ORDER BY started_at DESC"
    rows = conn.execute(sql, params).fetchall()

    count = 0
    for row in rows:
        if count >= limit:
            break
        title = row["title"] or ""
        if query_lower in title.lower():
            src = row["source"].replace("claude_code", "claude")
            date = row["started_at"][:10] if row["started_at"] else "?"
            # Truncate title for display
            display_title = title[:80] + "..." if len(title) > 80 else title
            print(f"[{src}] {date} | \"{display_title}\"")
            count += 1

    if count == 0:
        print("No matching conversations found.", file=sys.stderr)
        sys.exit(1)
    sys.exit(0)

# --- Full-text content search (decompresses blocks) ---

# Step 1: Get candidate conversations
conv_sql = "SELECT id, source, title, started_at FROM conversations WHERE 1=1"
conv_params = []

if source != "all":
    conv_sql += " AND source = ?"
    conv_params.append(source)

if since_days:
    cutoff = (datetime.now(timezone.utc) - timedelta(days=int(since_days))).isoformat()
    conv_sql += " AND started_at >= ?"
    conv_params.append(cutoff)

conv_sql += " ORDER BY started_at DESC"

conversations = conn.execute(conv_sql, conv_params).fetchall()

# Step 2: Search blocks within each conversation
block_sql = """
    SELECT type, role, content, compressed, position
    FROM conversation_blocks
    WHERE conversation_id = ?
"""
block_params_extra = []

if block_type:
    block_sql += " AND type = ?"
    block_params_extra.append(block_type)

block_sql += " ORDER BY position ASC"

def decompress(content, compressed):
    """Decompress gzip content from SQLite blob."""
    if not compressed:
        return content if isinstance(content, str) else content.decode("utf-8", errors="replace")
    if isinstance(content, str):
        content = content.encode("latin-1")
    try:
        return zlib.decompress(content, zlib.MAX_WBITS | 16).decode("utf-8", errors="replace")
    except Exception:
        try:
            return zlib.decompress(content).decode("utf-8", errors="replace")
        except Exception:
            return "<decompression failed>"

def highlight_match(text, query_lower, context_chars=80):
    """Extract a snippet around the first match with context."""
    idx = text.lower().find(query_lower)
    if idx == -1:
        return None
    start = max(0, idx - context_chars)
    end = min(len(text), idx + len(query_lower) + context_chars)

    snippet = text[start:end]
    # Clean up: collapse whitespace, remove newlines
    snippet = re.sub(r'\s+', ' ', snippet).strip()
    if start > 0:
        snippet = "..." + snippet
    if end < len(text):
        snippet = snippet + "..."
    return snippet

result_count = 0

for conv in conversations:
    if result_count >= limit:
        break

    conv_id = conv["id"]
    blocks = conn.execute(block_sql, [conv_id] + block_params_extra).fetchall()

    for block in blocks:
        if result_count >= limit:
            break

        text = decompress(block["content"], block["compressed"])
        snippet = highlight_match(text, query_lower)

        if snippet:
            src = conv["source"].replace("claude_code", "claude")
            date = conv["started_at"][:10] if conv["started_at"] else "?"
            title = (conv["title"] or "")[:60]
            if len(conv["title"] or "") > 60:
                title += "..."
            role = block["role"]

            print(f"[{src}] {date} | \"{title}\" | {role}: {snippet}")
            result_count += 1
            break  # One match per conversation to avoid flooding

if result_count == 0:
    print("No matching content found.", file=sys.stderr)
    sys.exit(1)

conn.close()
PYEOF
