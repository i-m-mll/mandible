#!/usr/bin/env bash

set -euo pipefail

BEGIN_MARKER="<!-- BEGIN MANDIBLE MANAGED INSTRUCTIONS -->"
END_MARKER="<!-- END MANDIBLE MANAGED INSTRUCTIONS -->"
MANIFEST_PATH="$(cd "$(dirname "$0")" && pwd -P)/instructions-contract.json"

usage() {
  cat <<'EOF'
Usage:
  mandible instructions diff [--target <file>]
  mandible instructions install [--target <file>] [--worktree <path>] [--force]
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

absolute_path() {
  node - "$1" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const target = path.resolve(process.argv[2]);
try {
  process.stdout.write(fs.realpathSync.native(target));
} catch {
  const parent = fs.realpathSync.native(path.dirname(target));
  process.stdout.write(path.join(parent, path.basename(target)));
}
NODE
}

git_root_for_path() {
  local path="$1"
  local dir
  if [[ -d "$path" ]]; then
    dir="$path"
  else
    dir="$(dirname "$path")"
  fi
  git -C "$dir" rev-parse --show-toplevel 2>/dev/null || true
}

repo_relative_path() {
  local root="$1"
  local target="$2"
  node - "$root" "$target" <<'NODE'
const path = require("node:path");
const root = path.resolve(process.argv[2]);
const target = path.resolve(process.argv[3]);
const relative = path.relative(root, target);
if (relative.startsWith("..") || path.isAbsolute(relative)) {
  process.exit(1);
}
process.stdout.write(relative);
NODE
}

map_target_to_worktree() {
  local target="$1"
  local worktree="$2"
  local target_abs worktree_abs source_root rel
  target_abs="$(absolute_path "$target")"
  worktree_abs="$(absolute_path "$worktree")"
  if rel="$(repo_relative_path "$worktree_abs" "$target_abs" 2>/dev/null)"; then
    printf '%s\n' "$target_abs"
    return 0
  fi
  source_root="$(git_root_for_path "$target_abs")"
  if [[ -z "$source_root" ]]; then
    printf 'Cannot map target outside a git worktree: %s\n' "$target" >&2
    return 2
  fi
  if ! rel="$(repo_relative_path "$source_root" "$target_abs")"; then
    printf 'Cannot map target outside source repo root: %s\n' "$target" >&2
    return 2
  fi
  printf '%s/%s\n' "$worktree_abs" "$rel"
}

tracked_file_on_protected_branch() {
  local target="$1"
  local root rel branch protected
  root="$(git_root_for_path "$target")"
  [[ -n "$root" ]] || return 1
  rel="$(repo_relative_path "$root" "$(absolute_path "$target")")" || return 1
  git -C "$root" ls-files --error-unmatch -- "$rel" >/dev/null 2>&1 || return 1
  branch="$(git -C "$root" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
  [[ -n "$branch" ]] || return 1
  if git -C "$root" show-ref --verify --quiet refs/heads/develop; then
    protected="develop"
  else
    protected="main"
  fi
  [[ "$branch" == "$protected" ]]
}

guard_install_target() {
  local target="$1"
  local force="$2"
  [[ "$force" == "1" ]] && return 0
  if tracked_file_on_protected_branch "$target"; then
    cat >&2 <<EOF
Refusing to install Mandible instructions into a tracked file on the protected branch:
  $target

Install into a feature worktree instead, for example:
  mandible instructions install --target "$target" --worktree <feature-worktree>

Use --force only when you intentionally want to bypass this guard.
EOF
    return 3
  fi
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
worktree=""
force=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)
      target="${2:?--target requires a value}"
      shift 2
      ;;
    --worktree)
      worktree="${2:?--worktree requires a value}"
      shift 2
      ;;
    --force)
      force=1
      shift
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

if [[ -n "$worktree" ]]; then
  target="$(map_target_to_worktree "$target" "$worktree")"
fi

case "$subcommand" in
  diff) diff_block "$target" ;;
  install)
    guard_install_target "$target" "$force"
    install_block "$target"
    ;;
  ""|-h|--help|help) usage ;;
  *)
    printf 'Unknown instructions subcommand: %s\n' "$subcommand" >&2
    usage >&2
    exit 2
    ;;
esac
