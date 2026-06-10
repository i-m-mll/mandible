#!/usr/bin/env bash

set -euo pipefail

BEGIN_MARKER="<!-- BEGIN MANDIBLE MANAGED INSTRUCTIONS -->"
END_MARKER="<!-- END MANDIBLE MANAGED INSTRUCTIONS -->"
MANIFEST_PATH="$(cd "$(dirname "$0")" && pwd -P)/instructions-contract.json"

usage() {
  cat <<'EOF'
Usage:
  mandible instructions diff [--target <file>]
  mandible instructions install [--target <file>]
EOF
}

default_target() {
  printf '%s/.claude/CLAUDE.md' "${HOME:?HOME is required}"
}

render_fragment() {
  jq -r '
    def bullets(xs): xs[] | "- " + .;
    [
      "# " + .title,
      "",
      "Version: " + (.version | tostring),
      "",
      "This section is Mandible'\''s interface contract. It describes daemon and CLI behavior that is the same for every install. It deliberately excludes user policy such as signing key names, branch naming schemes, editor preferences, and worktree tooling.",
      "",
      "## Commands",
      "",
      (.commands[] | "- `" + .name + "` - " + .description),
      "",
      "## Commit Trailers",
      "",
      (bullets(.trailers)),
      "",
      "## Auth Requests",
      "",
      (bullets(.authLifecycle)),
      "",
      "## Coordination",
      "",
      (bullets(.coordination)),
      "",
      "## Transports",
      "",
      (bullets(.transports))
    ] | join("\n")
  ' "$MANIFEST_PATH"
}

render_block() {
  printf '%s\n' "$BEGIN_MARKER"
  render_fragment
  printf '\n%s\n' "$END_MARKER"
}

write_desired_file() {
  local target="$1"
  local output="$2"
  local block_file
  block_file=$(mktemp)
  render_block > "$block_file"

  BEGIN_MARKER="$BEGIN_MARKER" END_MARKER="$END_MARKER" \
    node - "$target" "$block_file" <<'NODE' > "$output"
const fs = require("node:fs");
const target = process.argv[2];
const blockFile = process.argv[3];
const current = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
const block = fs.readFileSync(blockFile, "utf8");
const begin = process.env.BEGIN_MARKER;
const end = process.env.END_MARKER;
const start = current.indexOf(begin);
if (start < 0) {
  const prefix = current.trimEnd();
  process.stdout.write(`${prefix}${prefix ? "\n\n" : ""}${block}`);
} else {
  const endStart = current.indexOf(end, start);
  if (endStart < 0) {
    process.stderr.write("managed instructions begin marker exists without end marker\n");
    process.exit(2);
  }
  const endIndex = endStart + end.length + (current[endStart + end.length] === "\n" ? 1 : 0);
  process.stdout.write(`${current.slice(0, start)}${block}${current.slice(endIndex)}`);
}
NODE
  rm -f "$block_file"
}

install_block() {
  local target="$1"
  local tmp
  tmp=$(mktemp)
  write_desired_file "$target" "$tmp"
  if [[ -f "$target" ]] && cmp -s "$target" "$tmp"; then
    rm -f "$tmp"
    printf 'Mandible instructions already current: %s\n' "$target"
    return 0
  fi
  mkdir -p "$(dirname "$target")"
  mv "$tmp" "$target"
  printf 'Installed Mandible instructions: %s\n' "$target"
}

diff_block() {
  local target="$1"
  local desired current
  desired="$(mktemp)"
  if [[ -f "$target" ]]; then
    current="$target"
  else
    current="/dev/null"
  fi
  write_desired_file "$target" "$desired"
  if [[ -f "$target" ]] && cmp -s "$target" "$desired"; then
    rm -f "$desired"
    printf 'Mandible instructions already current: %s\n' "$target"
    return 0
  fi
  diff -u "$current" "$desired" || true
  rm -f "$desired"
}

subcommand="${1:-}"
shift || true
target="$(default_target)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)
      target="${2:?--target requires a value}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unexpected argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

case "$subcommand" in
  diff) diff_block "$target" ;;
  install) install_block "$target" ;;
  ""|-h|--help|help) usage ;;
  *)
    printf 'Unknown instructions subcommand: %s\n' "$subcommand" >&2
    usage >&2
    exit 2
    ;;
esac
