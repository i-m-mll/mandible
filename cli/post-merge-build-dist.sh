#!/usr/bin/env bash

set -euo pipefail

GIT_ENV_HELPER="${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/git-env.sh"
if [[ -f "$GIT_ENV_HELPER" ]]; then
  source "$GIT_ENV_HELPER"
else
  export GIT_OPTIONAL_LOCKS=0
fi

err() {
  printf '%s\n' "$*" >&2
}

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)"
cd "$repo_root"

dependency_command="${MANDIBLE_POST_MERGE_DEPENDENCY_COMMAND:-npm install --ignore-scripts --no-audit --no-fund}"
build_command="${MANDIBLE_POST_MERGE_BUILD_COMMAND:-npm run build}"
desktop_command="${MANDIBLE_POST_MERGE_DESKTOP_COMMAND:-bash cli/install-desktop-app.sh}"

build_needed=false
desktop_build_needed=false
instruction_install_needed=false
merge_base_sha="${MANDIBLE_AUTH_MERGE_BASE_SHA:-}"
merge_head_sha="${MANDIBLE_AUTH_MERGE_HEAD_SHA:-}"
if [[ -n "$merge_base_sha" || -n "$merge_head_sha" ]]; then
  if [[ -z "$merge_base_sha" || -z "$merge_head_sha" ]]; then
    err "[post-merge-build] original merge range requires both base and head revisions"
    exit 2
  fi
  git rev-parse --verify --quiet "${merge_base_sha}^{commit}" >/dev/null
  git rev-parse --verify --quiet "${merge_head_sha}^{commit}" >/dev/null
elif git rev-parse --verify --quiet HEAD^1 >/dev/null \
  && git rev-parse --verify --quiet HEAD^2 >/dev/null; then
  merge_base_sha="HEAD^1"
  merge_head_sha="HEAD"
fi

if [[ -n "$merge_base_sha" && -n "$merge_head_sha" ]]; then
  build_changes="$(git diff --name-only "$merge_base_sha" "$merge_head_sha" -- \
    package.json package-lock.json tsconfig.json \
    src channel-server ui/src ui/index.html ui/esbuild.config.js)"
  if [[ -n "$build_changes" ]]; then
    build_needed=true
  fi
  desktop_changes="$(git diff --name-only "$merge_base_sha" "$merge_head_sha" -- \
    package.json package-lock.json \
    src-tauri scripts/make-dist.sh cli/install-desktop-app.sh)"
  if [[ -n "$desktop_changes" ]]; then
    desktop_build_needed=true
  fi
  instruction_install_changes="$(git diff --name-only "$merge_base_sha" "$merge_head_sha" -- \
    package.json package-lock.json tsconfig.json \
    src channel-server ui/src ui/index.html ui/esbuild.config.js \
    cli/instructions.sh cli/instructions-contract.json)"
  if [[ -n "$instruction_install_changes" ]]; then
    instruction_install_needed=true
  fi
else
  build_needed=true
  desktop_build_needed=true
  instruction_install_needed=true
fi

if [[ "$build_needed" == "true" ]]; then
  err "[post-merge-build] aligning dependencies from package-lock.json"
  bash -lc "$dependency_command"
  err "[post-merge-build] running: ${build_command}"
  bash -lc "$build_command"
  err "[post-merge-build] generated local build artifacts"
else
  err "[post-merge-build] no Mandible source changes detected; skipping build"
fi

if [[ "$desktop_build_needed" == "true" ]]; then
  err "[post-merge-build] running native desktop deployment: ${desktop_command}"
  bash -lc "$desktop_command"
  err "[post-merge-build] installed native desktop bundle"
else
  err "[post-merge-build] no native desktop changes detected; skipping desktop deployment"
fi

if [[ "$instruction_install_needed" == "true" ]]; then
  bash cli/instructions.sh install
  err "[post-merge-build] installed managed instruction fragments"
fi

# A completed local-session cutover runs behind launchd from a stable runner.
# Only publish the protected checkout as runnable after every build/install
# step above succeeds; the daemon's self-merge exit then loads these bytes.
node scripts/local-session-production-runner.mjs mark-ready

# The origin transition is deterministic post-merge work. The command is a
# no-op without the completed old-origin cutover, and retries the same guarded
# registration and gateway reload after an interrupted hook attempt.
origin_journal="${MANDIBLE_HOME:-$HOME/.mandible}/config/local-sessions/origin-migration.json"
origin_manifest_added=false
if [[ -n "$merge_base_sha" && -n "$merge_head_sha" ]] \
  && [[ "$(git diff --diff-filter=A --name-only "$merge_base_sha" "$merge_head_sha" -- config/canonical-origin.json)" == "config/canonical-origin.json" ]]; then
  origin_manifest_added=true
fi
if [[ -f config/canonical-origin.json ]] && { [[ "$origin_manifest_added" == true ]] || [[ -f "$origin_journal" ]]; }; then
  node scripts/local-origin-migration.mjs converge-hook
fi
