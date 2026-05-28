#!/usr/bin/env bash
# mandible conversations: inspect DB-backed normalized conversations.

set -euo pipefail

MANDIBLE_DB="${MANDIBLE_DB:-${HOME}/.cache/mandible/mandible.db}"

usage() {
  cat <<'EOF'
Usage:
  mandible conversations list [--provider claude|codex|gemini|all] [--since Nd] [--limit N] [--json]
  mandible conversations show <id|session-id> [--json] [--blocks]
  mandible conversations blocks <id|session-id> [filters] [--json]
  mandible conversations export <id|session-id> [--format json|markdown]
  mandible conversations search "<query>" [search options...]

These commands read Mandible's normalized SQLite conversation index. Use
`mandible logs ...` for provider-native source files.

Block filters: --role ROLE --type TYPE[,TYPE...] --tool NAME --tool-kind KIND --since TIME --until TIME --content TEXT --limit N
EOF
}

if [[ ! -f "$MANDIBLE_DB" ]]; then
  echo "Error: Mandible database not found at $MANDIBLE_DB" >&2
  exit 1
fi

case "${1:-}" in
  search)
    shift
    exec "$(dirname "$0")/search.sh" "$@"
    ;;
  blocks)
    shift
    exec node "$(cd "$(dirname "$0")/.." && pwd -P)/dist/cli/conversation-blocks.js" conversations "$MANDIBLE_DB" "$@"
    ;;
esac

exec python3 - "$MANDIBLE_DB" "$@" <<'PY'
from __future__ import annotations

import argparse
import datetime as dt
import gzip
import json
import sqlite3
import sys
import zlib
from typing import Any


def usage() -> None:
    print("""Usage:
  mandible conversations list [--provider claude|codex|gemini|all] [--since Nd] [--limit N] [--json]
  mandible conversations show <id|session-id> [--json] [--blocks]
  mandible conversations blocks <id|session-id> [filters] [--json]
  mandible conversations export <id|session-id> [--format json|markdown]
  mandible conversations search "<query>" [search options...]
""")


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
    return {key: row[key] for key in row.keys()}


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
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
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


def list_cmd(conn: sqlite3.Connection, args: argparse.Namespace) -> int:
    params: list[Any] = []
    where = ["1=1"]
    source = map_provider(args.provider)
    if source:
        where.append("source = ?")
        params.append(source)
    since = parse_since(args.since)
    if since:
        where.append("started_at >= ?")
        params.append(since)
    params.append(args.limit)
    rows = conn.execute(
        f"""
        SELECT id, source, title, started_at, updated_at, block_count, session_id, cwd, branch, model, source_path
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


def show_cmd(conn: sqlite3.Connection, args: argparse.Namespace) -> int:
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


def blocks_cmd(conn: sqlite3.Connection, args: argparse.Namespace) -> int:
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


def export_cmd(conn: sqlite3.Connection, args: argparse.Namespace) -> int:
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
    argv = sys.argv[2:]
    if not argv or argv[0] in {"-h", "--help", "help"}:
        usage()
        return 0 if argv else 2
    parser = argparse.ArgumentParser(prog="mandible conversations", add_help=False)
    sub = parser.add_subparsers(dest="command")
    list_parser = sub.add_parser("list")
    list_parser.add_argument("--provider", default="all", choices=["claude", "codex", "gemini", "all"])
    list_parser.add_argument("--since")
    list_parser.add_argument("--limit", type=int, default=20)
    list_parser.add_argument("--json", action="store_true")
    show_parser = sub.add_parser("show")
    show_parser.add_argument("ident")
    show_parser.add_argument("--json", action="store_true")
    show_parser.add_argument("--blocks", action="store_true")
    export_parser = sub.add_parser("export")
    export_parser.add_argument("ident")
    export_parser.add_argument("--format", default="markdown", choices=["json", "markdown"])
    args = parser.parse_args(argv)
    conn = connect(db_path)
    if args.command == "list":
        return list_cmd(conn, args)
    if args.command == "show":
        return show_cmd(conn, args)
    if args.command == "export":
        return export_cmd(conn, args)
    usage()
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
PY
