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

build_command="${MANDIBLE_POST_MERGE_BUILD_COMMAND:-npm run build}"
desktop_command="${MANDIBLE_POST_MERGE_DESKTOP_COMMAND:-bash cli/install-desktop-app.sh}"

build_needed=false
desktop_build_needed=false
instruction_install_needed=false
if git rev-parse --verify --quiet HEAD^1 >/dev/null \
  && git rev-parse --verify --quiet HEAD^2 >/dev/null; then
  build_changes="$(git diff --name-only HEAD^1 HEAD -- \
    package.json package-lock.json tsconfig.json \
    src channel-server ui/src ui/index.html ui/esbuild.config.js)"
  if [[ -n "$build_changes" ]]; then
    build_needed=true
  fi
  desktop_changes="$(git diff --name-only HEAD^1 HEAD -- \
    package.json package-lock.json \
    src-tauri scripts/make-dist.sh cli/install-desktop-app.sh)"
  if [[ -n "$desktop_changes" ]]; then
    desktop_build_needed=true
  fi
  instruction_install_changes="$(git diff --name-only HEAD^1 HEAD -- \
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
