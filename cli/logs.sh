#!/usr/bin/env bash
# mandible logs: inspect provider-native source logs and retained daemon telemetry.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
source "$SCRIPT_DIR/api.sh"

usage() {
  cat <<'EOF'
Usage:
  mandible logs inventory [--provider codex|claude|gemini|all] [--since Nd|YYYY-MM-DD] [--limit N] [--json]
  mandible logs capabilities [--provider codex|claude_code|gemini] [--json]
  mandible logs missing [--provider codex|claude|gemini|all] [--json]
  mandible logs orphans [--provider codex|claude|gemini|all] [--json]
  mandible logs inspect <path|session-id> [--provider codex|claude|gemini|all] [--parse] [filters] [--json] [--head N]
  mandible logs daemon copy|reconcile|verify|reclaim-plan|export [options]

Filters for --parse: --role ROLE --type TYPE --tool NAME --tool-kind KIND --since TIME --until TIME --content TEXT --limit N --offset N

Raw provider source logs are the veridical transcript source. These commands do
not import, reconcile, or mutate the Mandible database. The daemon subcommands
operate only on the dedicated operational-log lifecycle; reclaim-plan is always
read-only and copy is bounded and resumable.
EOF
}

if [[ "${1:-}" == "daemon" ]]; then
  shift
  exec "$("$SCRIPT_DIR/../scripts/bun-runtime.sh")" "$SCRIPT_DIR/../dist/cli/operational-logs.js" "$@"
fi

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
  while (( $# > 0 )); do
    case "$1" in
      --provider) provider="${2:?--provider requires a value}"; shift 2 ;;
      --since) since="${2:?--since requires a value}"; shift 2 ;;
      --limit) limit="${2:?--limit requires a value}"; shift 2 ;;
      --json) json=1; shift ;;
      -h|--help) usage; exit 0 ;;
      *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
    esac
  done
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
  local target="${1:-}" provider="all" head=20 parse=0 json=0 role_filter="" type_filter="" content_filter="" limit=50 offset=0 conv_id request response
  if [[ -z "$target" ]]; then echo "log path, conversation id, or session id required" >&2; exit 2; fi
  shift
  while (( $# > 0 )); do
    case "$1" in
      --provider) provider="${2:?--provider requires a value}"; logs_source "$provider" >/dev/null; shift 2 ;;
      --head) head="${2:?--head requires a value}"; shift 2 ;;
      --parse) parse=1; shift ;;
      --role) role_filter="${2:?--role requires a value}"; shift 2 ;;
      --type) type_filter="${2:?--type requires a value}"; shift 2 ;;
      --content|--contains) content_filter="${2:?--content requires a value}"; shift 2 ;;
      --limit) limit="${2:?--limit requires a value}"; shift 2 ;;
      --offset) offset="${2:?--offset requires a value}"; shift 2 ;;
      --json) json=1; shift ;;
      --tool|--tool-kind|--since|--until)
        echo "Error: $1 is not supported through file-RPC logs inspect." >&2
        exit 2 ;;
      -h|--help) usage; exit 0 ;;
      *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
    esac
  done
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

# Issue 24f0316 — resolve the live ledger database in bash (the embedded
# python cannot call api_live_db_path) and hand it down through the env.
export MANDIBLE_DB="$(api_live_db_path)"

export MANDIBLE_RUNTIME="$("$SCRIPT_DIR/../scripts/bun-runtime.sh")"
exec python3 - "$@" <<'PY'
from __future__ import annotations

import argparse
import datetime as dt
import glob
import json
import os
import pathlib
import sqlite3
import subprocess
import sys
from typing import Any


HOME = pathlib.Path.home()
MANDIBLE_DB = pathlib.Path(os.environ["MANDIBLE_DB"])


def parse_since(value: str | None) -> float | None:
    if not value:
        return None
    now = dt.datetime.now(dt.timezone.utc)
    if value.endswith("d") and value[:-1].isdigit():
        return (now - dt.timedelta(days=int(value[:-1]))).timestamp()
    try:
        return dt.datetime.fromisoformat(value).replace(tzinfo=dt.timezone.utc).timestamp()
    except ValueError:
        raise SystemExit("--since must be Nd or YYYY-MM-DD")


def provider_patterns(provider: str) -> list[tuple[str, str]]:
    patterns: list[tuple[str, str]] = []
    providers = ["codex", "claude", "gemini"] if provider == "all" else [provider]
    for item in providers:
        if item == "codex":
            patterns.extend([
                ("codex", str(HOME / ".codex" / "sessions" / "**" / "*.jsonl")),
                ("codex", str(HOME / ".codex" / "archived_sessions" / "**" / "*.jsonl")),
            ])
        elif item == "claude":
            patterns.append(("claude", str(HOME / ".claude" / "projects" / "**" / "*.jsonl")))
        elif item == "gemini":
            patterns.extend([
                ("gemini", str(HOME / ".gemini" / "tmp" / "**" / "chats" / "*.json")),
                ("gemini", str(HOME / ".gemini" / "tmp" / "**" / "chats" / "*.jsonl")),
            ])
        else:
            raise SystemExit(f"unknown provider: {item}")
    return patterns


def iter_files(provider: str) -> list[tuple[str, pathlib.Path]]:
    seen: set[str] = set()
    rows: list[tuple[str, pathlib.Path]] = []
    for source, pattern in provider_patterns(provider):
        for match in glob.iglob(pattern, recursive=True):
            path = pathlib.Path(match)
            key = str(path)
            if key in seen or not path.is_file():
                continue
            seen.add(key)
            rows.append((source, path))
    return rows


def read_jsonl_head(path: pathlib.Path, limit: int = 200) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    try:
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            for idx, line in enumerate(handle):
                if idx >= limit:
                    break
                line = line.strip()
                if not line:
                    continue
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    except OSError:
        pass
    return rows


def summarize_file(source: str, path: pathlib.Path) -> dict[str, Any]:
    stat = path.stat()
    summary: dict[str, Any] = {
        "provider": source,
        "path": str(path),
        "size": stat.st_size,
        "mtime": dt.datetime.fromtimestamp(stat.st_mtime, dt.timezone.utc).isoformat(),
        "session_id": None,
        "title": None,
        "cwd": None,
        "model": None,
    }
    rows = read_jsonl_head(path)
    for row in rows:
        payload = row.get("payload") if isinstance(row, dict) else None
        if source == "codex" and row.get("type") == "session_meta" and isinstance(payload, dict):
            summary["session_id"] = payload.get("id")
            summary["cwd"] = payload.get("cwd")
            summary["model"] = payload.get("model_provider")
            git = payload.get("git") if isinstance(payload.get("git"), dict) else {}
            summary["branch"] = git.get("branch")
            break
        if source == "claude":
            summary["session_id"] = row.get("sessionId") or row.get("session_id") or summary["session_id"]
            summary["cwd"] = row.get("cwd") or summary["cwd"]
            summary["model"] = row.get("model") or summary["model"]
        if source == "gemini":
            summary["session_id"] = row.get("id") or row.get("session_id") or summary["session_id"]
    return summary


def inventory(args: argparse.Namespace) -> int:
    cutoff = parse_since(args.since)
    rows = []
    for provider, path in iter_files(args.provider):
        stat = path.stat()
        if cutoff is not None and stat.st_mtime < cutoff:
            continue
        rows.append(summarize_file(provider, path))
    rows.sort(key=lambda row: row["mtime"], reverse=True)
    rows = rows[: args.limit]
    if args.json:
        print(json.dumps(rows, indent=2))
    else:
        for row in rows:
            title = row.get("title") or row.get("session_id") or "-"
            print(f"{row['provider']}\t{row['mtime'][:19]}\t{title}\t{row['path']}")
    return 0


def db_source(provider: str) -> str | None:
    return {"claude": "claude_code", "codex": "codex", "gemini": "gemini", "all": None}[provider]


def db_paths(provider: str) -> dict[str, dict[str, Any]]:
    if not MANDIBLE_DB.exists():
        return {}
    conn = sqlite3.connect(MANDIBLE_DB, timeout=5.0, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 5000")
    conn.execute("PRAGMA query_only = ON")
    params: list[Any] = []
    where = ["source_path IS NOT NULL", "source_path != ''"]
    source = db_source(provider)
    if source:
        where.append("source = ?")
        params.append(source)
    try:
        rows = conn.execute(
            f"""
            SELECT id, source, source_path, source_hash, source_mtime, session_id, title, block_count, updated_at
            FROM conversations
            WHERE {' AND '.join(where)}
            """,
            params,
        ).fetchall()
        return {row["source_path"]: dict(row) for row in rows}
    finally:
        conn.close()


def missing(args: argparse.Namespace) -> int:
    indexed = db_paths(args.provider)
    rows = []
    for provider, path in iter_files(args.provider):
        if str(path) not in indexed:
            rows.append(summarize_file(provider, path))
    rows.sort(key=lambda row: row["mtime"], reverse=True)
    if args.json:
        print(json.dumps(rows, indent=2))
    else:
        for row in rows:
            print(f"{row['provider']}\t{row['mtime'][:19]}\t{row['path']}")
    return 0


def orphans(args: argparse.Namespace) -> int:
    rows = []
    for path, row in db_paths(args.provider).items():
        if not pathlib.Path(path).exists():
            rows.append(row)
    rows.sort(key=lambda row: row.get("updated_at") or "", reverse=True)
    if args.json:
        print(json.dumps(rows, indent=2))
    else:
        for row in rows:
            print(f"{row['source']}\t{row['id'][:8]}\t{row.get('session_id') or '-'}\t{row['source_path']}")
    return 0


def find_log(target: str, provider: str) -> tuple[str, pathlib.Path] | None:
    path = pathlib.Path(os.path.expanduser(target))
    if path.exists():
        return ("file", path)
    for source, candidate in iter_files(provider):
        summary = summarize_file(source, candidate)
        if target in {summary.get("session_id"), candidate.name, str(candidate)}:
            return (source, candidate)
    return None


def inspect(args: argparse.Namespace) -> int:
    found = find_log(args.target, args.provider)
    if not found:
        print(f"log not found: {args.target}", file=sys.stderr)
        return 1
    source, path = found
    if source == "file":
        source = "unknown"
    summary = summarize_file(source, path)
    if args.parse:
        cmd = [
            os.environ["MANDIBLE_RUNTIME"],
            str(pathlib.Path(os.environ.get("MANDIBLE_CLI_DIR", ".")).resolve().parent / "dist" / "cli" / "conversation-blocks.js"),
            "logs",
            str(path),
            "--limit",
            str(args.limit),
        ]
        flag_map = {
            "role": "role",
            "type": "type",
            "tool": "tool",
            "tool_kind": "tool-kind",
            "since": "since",
            "until": "until",
            "content": "content",
        }
        for attr, flag in flag_map.items():
            value = getattr(args, attr)
            if value:
                cmd.extend([f"--{flag}", value])
        if args.json:
            cmd.append("--json")
        return subprocess.run(cmd, check=False).returncode
    rows = read_jsonl_head(path, args.head)
    payload = {"summary": summary, "records": rows}
    if args.json:
        print(json.dumps(payload, indent=2))
    else:
        print(f"{summary['provider']} {summary.get('session_id') or path.name}")
        print(f"path: {path}")
        print(f"mtime: {summary['mtime']}")
        print(f"records shown: {len(rows)}")
        for row in rows:
            print(json.dumps(row, ensure_ascii=False)[:500])
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(prog="mandible logs", add_help=False)
    sub = parser.add_subparsers(dest="command")
    cap = sub.add_parser("capabilities")
    cap.add_argument("--provider", choices=["codex", "claude_code", "gemini"])
    cap.add_argument("--json", action="store_true")
    inv = sub.add_parser("inventory")
    inv.add_argument("--provider", default="all", choices=["codex", "claude", "gemini", "all"])
    inv.add_argument("--since")
    inv.add_argument("--limit", type=int, default=50)
    inv.add_argument("--json", action="store_true")
    missing_parser = sub.add_parser("missing")
    missing_parser.add_argument("--provider", default="all", choices=["codex", "claude", "gemini", "all"])
    missing_parser.add_argument("--json", action="store_true")
    orphans_parser = sub.add_parser("orphans")
    orphans_parser.add_argument("--provider", default="all", choices=["codex", "claude", "gemini", "all"])
    orphans_parser.add_argument("--json", action="store_true")
    ins = sub.add_parser("inspect")
    ins.add_argument("target")
    ins.add_argument("--provider", default="all", choices=["codex", "claude", "gemini", "all"])
    ins.add_argument("--head", type=int, default=20)
    ins.add_argument("--parse", action="store_true")
    ins.add_argument("--role")
    ins.add_argument("--type")
    ins.add_argument("--tool")
    ins.add_argument("--tool-kind", dest="tool_kind")
    ins.add_argument("--since")
    ins.add_argument("--until")
    ins.add_argument("--content")
    ins.add_argument("--contains", dest="content")
    ins.add_argument("--limit", type=int, default=50)
    ins.add_argument("--json", action="store_true")
    if len(sys.argv) == 1 or sys.argv[1] in {"-h", "--help", "help"}:
        usage()
        return 0 if len(sys.argv) > 1 else 2
    args = parser.parse_args()
    if args.command == "inventory":
        return inventory(args)
    if args.command == "capabilities":
        cmd = [
            os.environ["MANDIBLE_RUNTIME"],
            str(pathlib.Path(os.environ.get("MANDIBLE_CLI_DIR", ".")).resolve().parent / "dist" / "cli" / "conversation-blocks.js"),
            "capabilities",
        ]
        if args.provider:
            cmd.append(args.provider)
        if args.json:
            cmd.append("--json")
        return subprocess.run(cmd, check=False).returncode
    if args.command == "missing":
        return missing(args)
    if args.command == "orphans":
        return orphans(args)
    if args.command == "inspect":
        return inspect(args)
    usage()
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
PY
