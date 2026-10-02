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
    src-tauri scripts/make-dist.sh scripts/local-runtime.mjs scripts/local-session-production-runner.mjs \
    scripts/build-revision.mjs scripts/canonical-origin.mjs \
    scripts/local-front-door.mjs scripts/local-ca-trust.mjs scripts/pinned-caddy.mjs \
    cli/install-desktop-app.sh)"
  if [[ -n "$desktop_changes" ]]; then
    desktop_build_needed=true
  fi
  instruction_install_changes="$(git diff --name-only "$merge_base_sha" "$merge_head_sha" -- \
    package.json package-lock.json tsconfig.json \
    src channel-server ui/src ui/index.html ui/esbuild.config.js \
    cli/instructions.sh cli/instructions-contract.md cli/command-syntax.json cli/command-syntax.cjs cli/command-syntax.sh)"
  if [[ -n "$instruction_install_changes" ]]; then
    instruction_install_needed=true
  fi
else
  build_needed=true
  desktop_build_needed=true
  instruction_install_needed=true
fi

# Keep the daemon-selected runtime PATH. A login shell can silently switch
# Node versions and invalidate the native modules used by production.
if [[ "$build_needed" == "true" ]]; then
  err "[post-merge-build] aligning dependencies from package-lock.json"
  bash -c "$dependency_command"
  err "[post-merge-build] running: ${build_command}"
  bash -c "$build_command"
  err "[post-merge-build] generated local build artifacts"
else
  err "[post-merge-build] no Mandible source changes detected; skipping build"
fi

if [[ "$desktop_build_needed" == "true" ]]; then
  err "[post-merge-build] running native desktop deployment: ${desktop_command}"
  bash -c "$desktop_command"
  err "[post-merge-build] installed native desktop bundle"
else
  err "[post-merge-build] no native desktop changes detected; skipping desktop deployment"
fi

if [[ "$instruction_install_needed" == "true" ]]; then
  bash cli/instructions.sh install
  err "[post-merge-build] installed managed instruction fragments"
fi

# Do not kickstart a service from its own merge finalizer. The daemon completes
# its drain and exits through its existing self-merge boundary; launchd then
# starts the built revision from the persistent production LaunchAgent.
err "[post-merge-build] runtime restart remains with the production LaunchAgent"
