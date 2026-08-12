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

build_needed=false
instruction_install_needed=false
if git rev-parse --verify --quiet HEAD^1 >/dev/null \
  && git rev-parse --verify --quiet HEAD^2 >/dev/null; then
  build_changes="$(git diff --name-only HEAD^1 HEAD -- \
    package.json package-lock.json tsconfig.json \
    src channel-server ui/src ui/index.html ui/esbuild.config.js)"
  if [[ -n "$build_changes" ]]; then
    build_needed=true
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
  instruction_install_needed=true
fi

if [[ "$build_needed" == "true" ]]; then
  err "[post-merge-build] running: ${build_command}"
  bash -lc "$build_command"
  err "[post-merge-build] generated local build artifacts"
else
  err "[post-merge-build] no Mandible source changes detected; skipping build"
fi

if [[ "$instruction_install_needed" == "true" ]]; then
  bash cli/instructions.sh install
  err "[post-merge-build] installed managed instruction fragments"
fi
