#!/usr/bin/env bash

set -euo pipefail

err() {
  printf '%s\n' "$*" >&2
}

pgrep_command="${MANDIBLE_DESKTOP_PGREP:-/usr/bin/pgrep}"
ps_command="${MANDIBLE_DESKTOP_PS:-/bin/ps}"
kill_command="${MANDIBLE_DESKTOP_KILL:-/bin/kill}"
open_command="${MANDIBLE_DESKTOP_OPEN:-/usr/bin/open}"
sleep_command="${MANDIBLE_DESKTOP_SLEEP:-sleep}"

matching_installed_pids() {
  local install_path="$1"
  local executable_name="$2"
  local expected_command="${install_path}/Contents/MacOS/${executable_name}"
  local pid command

  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    command="$($ps_command -ww -p "$pid" -o command= 2>/dev/null || true)"
    case "$command" in
      "$expected_command"|"$expected_command "*) printf '%s\n' "$pid" ;;
    esac
  done < <("$pgrep_command" -x "$executable_name" 2>/dev/null || true)
}

relaunch_installed_app() {
  local install_path="$1"
  local executable_name="$2"
  local delay_seconds="$3"

  local attempt pid pids
  pids="$(matching_installed_pids "$install_path" "$executable_name")"
  if [[ -n "$pids" ]]; then
    while IFS= read -r pid; do
      [[ -n "$pid" ]] && "$kill_command" -TERM "$pid" >/dev/null 2>&1 || true
    done <<<"$pids"
  fi

  for attempt in {1..20}; do
    pids="$(matching_installed_pids "$install_path" "$executable_name")"
    if [[ -z "$pids" ]]; then
      break
    fi
    "$sleep_command" 0.25
  done
  if [[ -n "$pids" ]]; then
    while IFS= read -r pid; do
      [[ -n "$pid" ]] && "$kill_command" -KILL "$pid" >/dev/null 2>&1 || true
    done <<<"$pids"
  fi

  # Once the replacement bundle is installed, the old shell may already be
  # reconnecting to the newly restarted daemon and loading its new UI. Do not
  # leave that stale native process interactive during the relaunch delay: it
  # can briefly expose recovery affordances (including a redundant Log in)
  # against a transition that will disappear as soon as the new shell opens.
  "$sleep_command" "$delay_seconds"
  "$open_command" -n "$install_path"
}

if [[ "${1:-}" == "--relaunch" ]]; then
  shift
  if [[ "$#" -ne 3 ]]; then
    err "usage: $0 --relaunch <app-path> <executable> <delay-seconds>"
    exit 2
  fi
  relaunch_installed_app "$@"
  exit 0
fi

platform="${MANDIBLE_DESKTOP_PLATFORM:-$(uname -s)}"
if [[ "$platform" != "Darwin" ]]; then
  err "[desktop-install] native desktop deployment is macOS-only; skipping on ${platform}"
  exit 0
fi

GIT_ENV_HELPER="${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/git-env.sh"
if [[ -f "$GIT_ENV_HELPER" ]]; then
  source "$GIT_ENV_HELPER"
else
  export GIT_OPTIONAL_LOCKS=0
fi

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)"
cd "$repo_root"

runtime="$("$repo_root/scripts/bun-runtime.sh")"
export MANDIBLE_RUNTIME="$runtime"
export PATH="$("$runtime" "$repo_root/scripts/runtime-environment.mjs" "$runtime" "$repo_root")"

dependency_command="${MANDIBLE_DESKTOP_DEPENDENCY_COMMAND:-bun install --frozen-lockfile --force}"
build_command="${MANDIBLE_DESKTOP_BUILD_COMMAND:-bun run tauri:build -- --bundles app}"
built_app="${MANDIBLE_DESKTOP_BUNDLE_PATH:-$repo_root/src-tauri/target/release/bundle/macos/Mandible.app}"
install_app="${MANDIBLE_DESKTOP_INSTALL_PATH:-/Applications/Mandible.app}"
# Issue 24f0316 — app backups are durable state, so they live under the
# durable root with the rest of it rather than under Application Support.
backup_dir="${MANDIBLE_DESKTOP_BACKUP_DIR:-${MANDIBLE_HOME:-${HOME}/.mandible}/app-backups}"
expected_bundle_id="${MANDIBLE_DESKTOP_BUNDLE_ID:-bio.mll.mandible}"
expected_executable="${MANDIBLE_DESKTOP_EXECUTABLE:-mandible-app}"
runtime_command="${MANDIBLE_DESKTOP_RUNTIME:-bun}"
codesign_command="${MANDIBLE_DESKTOP_CODESIGN:-/usr/bin/codesign}"
ditto_command="${MANDIBLE_DESKTOP_DITTO:-/usr/bin/ditto}"
plist_command="${MANDIBLE_DESKTOP_PLISTBUDDY:-/usr/libexec/PlistBuddy}"

case "$install_app" in
  /*.app) ;;
  *)
    err "[desktop-install] install target must be an absolute .app path: ${install_app}"
    exit 2
    ;;
esac

validate_bundle() {
  local app_path="$1"
  local label="$2"
  local info_plist="$app_path/Contents/Info.plist"

  if [[ ! -d "$app_path" || ! -f "$info_plist" ]]; then
    err "[desktop-install] ${label} is not a complete app bundle: ${app_path}"
    return 1
  fi

  local actual_bundle_id actual_executable
  actual_bundle_id="$($plist_command -c 'Print :CFBundleIdentifier' "$info_plist" 2>/dev/null)" || {
    err "[desktop-install] ${label} has no readable CFBundleIdentifier"
    return 1
  }
  actual_executable="$($plist_command -c 'Print :CFBundleExecutable' "$info_plist" 2>/dev/null)" || {
    err "[desktop-install] ${label} has no readable CFBundleExecutable"
    return 1
  }
  if [[ "$actual_bundle_id" != "$expected_bundle_id" ]]; then
    err "[desktop-install] ${label} bundle id ${actual_bundle_id} does not match ${expected_bundle_id}"
    return 1
  fi
  if [[ "$actual_executable" != "$expected_executable" ]]; then
    err "[desktop-install] ${label} executable ${actual_executable} does not match ${expected_executable}"
    return 1
  fi
  if [[ ! -x "$app_path/Contents/MacOS/$actual_executable" ]]; then
    err "[desktop-install] ${label} executable is missing or not executable"
    return 1
  fi
  if ! "$codesign_command" --verify --deep --strict "$app_path" >/dev/null 2>&1; then
    err "[desktop-install] ${label} failed code-signature verification"
    return 1
  fi
}

err "[desktop-install] aligning dependencies from bun.lock"
bash -c "$dependency_command"
err "[desktop-install] running: ${build_command}"
if [[ "${CI:-}" == "1" ]]; then
  CI=true bash -c "$build_command"
else
  bash -c "$build_command"
fi
validate_bundle "$built_app" "built app"

install_parent="$(dirname "$install_app")"
mkdir -p "$install_parent" "$backup_dir"
staging_app="${install_parent}/.$(basename "$install_app").install.$$"
rollback_app="${install_parent}/.$(basename "$install_app").rollback.$$"
backup_app=""
new_bundle_moved=false

cleanup_install_paths() {
  local status=$?
  trap - EXIT
  if [[ "$status" -ne 0 && "$new_bundle_moved" == "true" && -e "$install_app" ]]; then
    rm -rf -- "$install_app"
  fi
  if [[ "$status" -ne 0 && -d "$rollback_app" ]]; then
    mv "$rollback_app" "$install_app" || true
  fi
  if [[ -e "$staging_app" ]]; then
    rm -rf -- "$staging_app"
  fi
  if [[ "$status" -eq 0 && -e "$rollback_app" ]]; then
    rm -rf -- "$rollback_app"
  fi
  exit "$status"
}
trap cleanup_install_paths EXIT

"$ditto_command" "$built_app" "$staging_app"
validate_bundle "$staging_app" "staged app"

was_running=false
if [[ "${MANDIBLE_DESKTOP_ASSUME_RUNNING:-}" == "1" ]] \
  || [[ -n "$(matching_installed_pids "$install_app" "$expected_executable")" ]]; then
  was_running=true
fi

if [[ -d "$install_app" ]]; then
  backup_stamp="${MANDIBLE_DESKTOP_BACKUP_STAMP:-$(date '+%Y%m%dT%H%M%S')}"
  backup_app="${backup_dir}/Mandible-${backup_stamp}-$$.app"
  "$ditto_command" "$install_app" "$backup_app"
  validate_bundle "$backup_app" "backup app"
  mv "$install_app" "$rollback_app"
fi

mv "$staging_app" "$install_app"
new_bundle_moved=true
validate_bundle "$install_app" "installed app"

if [[ -n "$backup_app" ]]; then
  err "[desktop-install] installed ${install_app}; previous bundle preserved at ${backup_app}"
else
  err "[desktop-install] installed ${install_app}"
fi

# Register the built checkout as the source named by the user's persistent
# LaunchAgents. This prepares ownership without restarting a healthy service.
"$runtime_command" "$repo_root/scripts/local-runtime.mjs" install --root "$repo_root"
err "[desktop-install] installed persistent Mandible runtime LaunchAgents"

if [[ "$was_running" == "true" && -z "${MANDIBLE_RUNTIME_HANDOFF_JOURNAL:-}" ]]; then
  if [[ -n "${MANDIBLE_DESKTOP_RELAUNCH_COMMAND:-}" ]]; then
    bash -lc "$MANDIBLE_DESKTOP_RELAUNCH_COMMAND"
  else
    # Keep relaunch inside the convergence process. A detached helper can be
    # reaped when the self-merge daemon exits, falsely reporting success while
    # the old desktop shell remains alive.
    relaunch_installed_app \
      "$install_app" "$expected_executable" \
      "${MANDIBLE_DESKTOP_RELAUNCH_DELAY_SECONDS:-4}"
  fi
  err "[desktop-install] restarted the running desktop shell"
fi
