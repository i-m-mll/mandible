#!/usr/bin/env bash
source "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd -P)/command-syntax.sh"

set -euo pipefail

GIT_ENV_HELPER="${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/git-env.sh"
if [[ -f "$GIT_ENV_HELPER" ]]; then
  source "$GIT_ENV_HELPER"
else
  export GIT_OPTIONAL_LOCKS=0
fi

BEGIN_MARKER="<!-- BEGIN MANDIBLE MANAGED INSTRUCTIONS -->"
END_MARKER="<!-- END MANDIBLE MANAGED INSTRUCTIONS -->"
CLI_DIR="$(cd "$(dirname "$0")" && pwd -P)"
MANDIBLE_ROOT="$(cd "$CLI_DIR/.." && pwd -P)"
CONTRACT_PATH="$CLI_DIR/instructions-contract.md"
BUN_RUNTIME="$(mandible_bun_runtime)"

usage() {
  mandible_command_help instructions
}

default_target() {
  printf '%s/.claude/CLAUDE.md' "${HOME:?HOME is required}"
}

render_fragment() {
  "$BUN_RUNTIME" --no-install "$CLI_DIR/command-syntax.cjs" render "$CONTRACT_PATH"
}

render_block() {
  printf '%s\n' "$BEGIN_MARKER"
  render_fragment
  printf '\n%s\n' "$END_MARKER"
}

settings_helper() {
  "$BUN_RUNTIME" --no-install - "$MANDIBLE_ROOT" "$@" <<'NODE'
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const [root, op, ...args] = process.argv.slice(2);
const SqliteDatabase = require(process.env.MANDIBLE_RELEASE_ROOT
  ? path.join(process.env.MANDIBLE_RELEASE_ROOT, "dist", "sqlite.js")
  : path.join(root, "src", "sqlite.ts")).default;

// Issue 24f0316 — the ledger database lives under the durable root, but this
// helper must never create one: an empty file there would be adopted by the
// daemon's startup copy-forward as though it were the relocated ledger.
const dbPath = process.env.MANDIBLE_DB
  || require(path.join(root, "cli", "mandible-paths.cjs")).liveDbPath();
// Issue 07edc0d — this helper opens the production DB directly (and writes to
// the settings table), bypassing openDb()'s guard. Apply the shared refusal so
// an instructions-CLI test invoked under vitest cannot mutate live settings.
require(path.join(root, "cli", "production-db-guard.cjs")).assertNotProductionDbUnderTest(dbPath);
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new SqliteDatabase(dbPath);
db.pragma("journal_mode = WAL");
db.prepare(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )
`).run();

const TARGETS_KEY = "instructions.targets";
const POST_EXPORT_KEY = "instructions.post_export";

function now() {
  return Date.now();
}

function getSetting(key, fallback = "") {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? String(row.value) : fallback;
}

function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value, now());
}

function readTargets() {
  const raw = getSetting(TARGETS_KEY, "[]");
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((target) => ({
        path: typeof target.path === "string" ? target.path : "",
        mode: target.mode === "standalone" ? "standalone" : "managed-block",
      }))
      .filter((target) => target.path.trim().length > 0);
  } catch {
    return [];
  }
}

function writeTargets(targets) {
  setSetting(TARGETS_KEY, JSON.stringify(targets));
}

function requirePath(value) {
  if (!value) {
    console.error("Target path is required");
    process.exit(2);
  }
  return path.resolve(value);
}

switch (op) {
  case "targets-list": {
    for (const target of readTargets()) {
      console.log(`${target.mode}\t${target.path}`);
    }
    break;
  }
  case "targets-add": {
    const targetPath = requirePath(args[0]);
    const mode = args[1] || "managed-block";
    if (!["managed-block", "standalone"].includes(mode)) {
      console.error(`Invalid mode: ${mode}`);
      process.exit(2);
    }
    const targets = readTargets().filter((target) => target.path !== targetPath);
    targets.push({ path: targetPath, mode });
    writeTargets(targets);
    console.log(`Added instruction target: ${mode}\t${targetPath}`);
    break;
  }
  case "targets-rm": {
    const targetPath = requirePath(args[0]);
    const before = readTargets();
    const after = before.filter((target) => target.path !== targetPath);
    writeTargets(after);
    if (after.length === before.length) {
      console.log(`Instruction target not configured: ${targetPath}`);
    } else {
      console.log(`Removed instruction target: ${targetPath}`);
    }
    break;
  }
  case "post-export-get": {
    const value = getSetting(POST_EXPORT_KEY, "");
    if (value) console.log(value);
    break;
  }
  case "post-export-set": {
    const command = args.join(" ").trim();
    if (!command) {
      console.error("post-export command is required");
      process.exit(2);
    }
    setSetting(POST_EXPORT_KEY, command);
    console.log(`Set instructions post-export hook: ${command}`);
    break;
  }
  case "post-export-clear": {
    setSetting(POST_EXPORT_KEY, "");
    console.log("Cleared instructions post-export hook");
    break;
  }
  default:
    console.error(`Unknown settings operation: ${op}`);
    process.exit(2);
}
NODE
}

absolute_path() {
  "$BUN_RUNTIME" --no-install - "$1" <<'NODE'
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

write_target_path() {
  "$BUN_RUNTIME" --no-install - "$1" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

function pathWithRealParent(target) {
  const parent = path.dirname(target);
  try {
    return path.join(fs.realpathSync.native(parent), path.basename(target));
  } catch {
    return target;
  }
}

function resolveWriteTarget(target) {
  const absolute = path.resolve(target);
  try {
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      const link = fs.readlinkSync(absolute);
      const linkedTarget = path.resolve(path.dirname(absolute), link);
      try {
        return fs.realpathSync.native(linkedTarget);
      } catch {
        return pathWithRealParent(linkedTarget);
      }
    }
  } catch {
    // Missing targets are created at the requested path.
  }

  try {
    return fs.realpathSync.native(absolute);
  } catch {
    return pathWithRealParent(absolute);
  }
}

process.stdout.write(resolveWriteTarget(process.argv[2]));
NODE
}

temp_for_target() {
  local target="$1"
  local dir
  dir="$(dirname "$target")"
  mkdir -p "$dir"
  mktemp "$dir/.mandible-instructions.XXXXXX"
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
  "$BUN_RUNTIME" --no-install - "$root" "$target" <<'NODE'
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
    "$BUN_RUNTIME" --no-install - "$target" "$block_file" <<'NODE' > "$output"
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
  local write_target tmp
  write_target="$(write_target_path "$target")"
  tmp="$(temp_for_target "$write_target")"
  write_desired_file "$target" "$tmp"
  if [[ -f "$write_target" ]] && cmp -s "$write_target" "$tmp"; then
    rm -f "$tmp"
    printf 'Mandible instructions already current: %s\n' "$target"
    return 0
  fi
  mv "$tmp" "$write_target"
  printf 'Installed Mandible instructions: %s\n' "$target"
}

install_standalone() {
  local target="$1"
  local write_target tmp
  write_target="$(write_target_path "$target")"
  tmp="$(temp_for_target "$write_target")"
  render_fragment > "$tmp"
  printf '\n' >> "$tmp"
  if [[ -f "$write_target" ]] && cmp -s "$write_target" "$tmp"; then
    rm -f "$tmp"
    printf 'Mandible instructions already current: %s\n' "$target"
    return 0
  fi
  mv "$tmp" "$write_target"
  printf 'Installed standalone Mandible instructions: %s\n' "$target"
}

cleanup_block() {
  local target="$1"
  if [[ ! -f "$target" ]]; then
    printf 'No managed Mandible instructions found: %s\n' "$target"
    return 0
  fi
  local write_target tmp
  write_target="$(write_target_path "$target")"
  tmp="$(temp_for_target "$write_target")"
  BEGIN_MARKER="$BEGIN_MARKER" END_MARKER="$END_MARKER" \
    "$BUN_RUNTIME" --no-install - "$target" <<'NODE' > "$tmp"
const fs = require("node:fs");
const target = process.argv[2];
const current = fs.readFileSync(target, "utf8");
const begin = process.env.BEGIN_MARKER;
const end = process.env.END_MARKER;
const start = current.indexOf(begin);
if (start < 0) {
  process.stdout.write(current);
  process.exit(0);
}
const endStart = current.indexOf(end, start);
if (endStart < 0) {
  process.stderr.write("managed instructions begin marker exists without end marker\n");
  process.exit(2);
}
let removeStart = start;
if (removeStart >= 2 && current.slice(removeStart - 2, removeStart) === "\n\n") {
  removeStart -= 1;
}
const endIndex = endStart + end.length + (current[endStart + end.length] === "\n" ? 1 : 0);
process.stdout.write(current.slice(0, removeStart) + current.slice(endIndex));
NODE
  if cmp -s "$write_target" "$tmp"; then
    rm -f "$tmp"
    printf 'No managed Mandible instructions found: %s\n' "$target"
    return 0
  fi
  mv "$tmp" "$write_target"
  printf 'Removed managed Mandible instructions: %s\n' "$target"
}

cleanup_standalone() {
  local target="$1"
  if [[ ! -f "$target" ]]; then
    printf 'No standalone Mandible instructions found: %s\n' "$target"
    return 0
  fi
  local tmp
  tmp=$(mktemp)
  render_fragment > "$tmp"
  printf '\n' >> "$tmp"
  if cmp -s "$target" "$tmp"; then
    rm -f "$target" "$tmp"
    printf 'Removed standalone Mandible instructions: %s\n' "$target"
    return 0
  fi
  rm -f "$tmp"
  printf 'Skipped standalone Mandible cleanup; target is not an exact generated file: %s\n' "$target"
}

cleanup_target() {
  local target="$1"
  local mode="$2"
  local force="$3"
  guard_install_target "$target" "$force"
  case "$mode" in
    managed-block) cleanup_block "$target" ;;
    standalone) cleanup_standalone "$target" ;;
    *)
      printf 'Invalid instructions target mode: %s\n' "$mode" >&2
      return 2
      ;;
  esac
}

install_target() {
  local target="$1"
  local mode="$2"
  local force="$3"
  guard_install_target "$target" "$force"
  case "$mode" in
    managed-block) install_block "$target" ;;
    standalone) install_standalone "$target" ;;
    *)
      printf 'Invalid instructions target mode: %s\n' "$mode" >&2
      return 2
      ;;
  esac
}

default_install_targets() {
  local default_target="${HOME:?HOME is required}/.claude/CLAUDE.md"
  local codex_target="${HOME}/.codex/AGENTS.md"
  printf 'managed-block\t%s\n' "$default_target"
  printf 'managed-block\t%s\n' "$codex_target"
}

hook_cwd_for_target() {
  local target="$1"
  local root
  root="$(git_root_for_path "$target")"
  if [[ -n "$root" ]]; then
    printf '%s\n' "$root"
  else
    pwd -P
  fi
}

run_post_export_hook() {
  local hook="$1"
  local first_target="$2"
  local hook_cwd
  [[ -n "$hook" ]] || return 0
  hook_cwd="$(hook_cwd_for_target "$first_target")"
  printf 'Running instructions post-export hook: %s\n' "$hook" >&2
  if ! (cd "$hook_cwd" && bash -lc "$hook"); then
    printf 'Instructions post-export hook failed but target refresh completed: %s\n' "$hook" >&2
  fi
}

install_configured_targets() {
  local force="$1"
  local configured_file targets_file mode target first_target hook
  configured_file="$(mktemp)"
  targets_file="$(mktemp)"
  settings_helper targets-list > "$configured_file"
  if [[ -s "$configured_file" ]]; then
    cp "$configured_file" "$targets_file"
  else
    printf 'No Mandible instruction targets configured; using default HOME targets. Configure persistent targets with `mandible instructions targets add <path> --mode <mode>`.\n' >&2
    default_install_targets > "$targets_file"
  fi

  first_target=""
  while IFS=$'\t' read -r mode target; do
    [[ -n "$target" ]] || continue
    if [[ -z "$first_target" ]]; then
      first_target="$target"
    fi
    install_target "$target" "$mode" "$force"
  done < "$targets_file"

  rm -f "$configured_file" "$targets_file"

  hook="$(settings_helper post-export-get)"
  if [[ -n "$hook" && -n "$first_target" ]]; then
    run_post_export_hook "$hook" "$first_target"
  fi
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
explicit_target=0

case "$subcommand" in
  cleanup)
    cleanup_mode="managed-block"
    cleanup_target_path=""
    binding=$(mandible_bind_main_arguments "instructions.cleanup" '{"cleanup_target_path":{"option":"target"},"cleanup_mode":{"option":"mode"},"force":{"option":"force","constant":"1"}}' "$@") || exit $?
    eval "$binding"
    if [[ -z "$cleanup_target_path" ]]; then
      printf 'cleanup requires --target <file>\n' >&2
      usage >&2
      exit 2
    fi
    cleanup_target "$cleanup_target_path" "$cleanup_mode" "$force"
    exit 0
    ;;
  targets)
    action="${1:-list}"
    shift || true
    case "$action" in
      list)
        binding=$(mandible_bind_main_arguments "instructions.targets.list" '{}' "$@") || exit $?
        eval "$binding"
        settings_helper targets-list
        ;;
      add)
        target_arg="${1:?targets add requires a path}"
        shift
        mode="managed-block"
        binding=$(mandible_bind_main_arguments "instructions.targets.add" '{"mode":{"option":"mode"}}' "$target_arg" "$@") || exit $?
        eval "$binding"
        settings_helper targets-add "$target_arg" "$mode"
        ;;
      rm|remove)
        target_arg=""
        binding=$(mandible_bind_main_arguments "instructions.targets.rm" '{"target_arg":{"position":0}}' "$@") || exit $?
        eval "$binding"
        settings_helper targets-rm "$target_arg"
        ;;
      -h|--help|help)
        usage
        ;;
      *)
        printf 'Unknown instructions targets action: %s\n' "$action" >&2
        usage >&2
        exit 2
        ;;
    esac
    exit 0
    ;;
  post-export)
    action="${1:-get}"
    shift || true
    case "$action" in
      get)
        binding=$(mandible_bind_main_arguments "instructions.post-export.get" '{}' "$@") || exit $?
        eval "$binding"
        settings_helper post-export-get
        ;;
      set)
        binding=$(mandible_bind_main_arguments "instructions.post-export.set" '{"command_parts":{"rest":0}}' "$@") || exit $?
        eval "$binding"
        settings_helper post-export-set "${command_parts[@]}"
        ;;
      clear|rm|remove)
        binding=$(mandible_bind_main_arguments "instructions.post-export.clear" '{}' "$@") || exit $?
        eval "$binding"
        settings_helper post-export-clear
        ;;
      -h|--help|help)
        usage
        ;;
      *)
        printf 'Unknown instructions post-export action: %s\n' "$action" >&2
        usage >&2
        exit 2
        ;;
    esac
    exit 0
    ;;
esac

binding=$(mandible_bind_main_arguments "@instructions ${subcommand}" '{"target":{"option":"target"},"explicit_target":{"option":"target","constant":"1"},"worktree":{"option":"worktree"},"force":{"option":"force","constant":"1"}}' "$@") || exit $?
eval "$binding"

if [[ -n "$worktree" ]]; then
  target="$(map_target_to_worktree "$target" "$worktree")"
fi

case "$subcommand" in
  diff) diff_block "$target" ;;
  install)
    if [[ "$explicit_target" == "1" ]]; then
      install_target "$target" managed-block "$force"
    else
      install_configured_targets "$force"
    fi
    ;;
  ""|-h|--help|help) usage ;;
  *)
    printf 'Unknown instructions subcommand: %s\n' "$subcommand" >&2
    usage >&2
    exit 2
    ;;
esac
