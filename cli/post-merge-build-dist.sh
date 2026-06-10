#!/usr/bin/env bash

set -euo pipefail

err() {
  printf '%s\n' "$*" >&2
}

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)"
cd "$repo_root"

build_command="${MANDIBLE_POST_MERGE_BUILD_COMMAND:-npm run build}"

install_instruction_targets() {
  local default_target="${HOME:?HOME is required}/.claude/CLAUDE.md"
  local codex_target="${HOME}/.codex/AGENTS.md"
  local -a targets=("$default_target")
  local target

  if [[ -e "$codex_target" || -L "$codex_target" ]]; then
    targets+=("$codex_target")
  fi

  for target in "${targets[@]}"; do
    err "[post-merge-build] installing Mandible instructions: ${target}"
    bash cli/instructions.sh install --target "$target"
  done
}

source_changed=false
if git rev-parse --verify --quiet HEAD^1 >/dev/null \
  && git rev-parse --verify --quiet HEAD^2 >/dev/null; then
  if git diff --name-only HEAD^1 HEAD -- \
      package.json package-lock.json tsconfig.json \
      src channel-server ui/src ui/index.html ui/esbuild.config.js \
      | grep -q .; then
    source_changed=true
  fi
else
  source_changed=true
fi

if [[ "$source_changed" != "true" ]]; then
  err "[post-merge-build] no Mandible source changes detected; skipping build"
  exit 0
fi

err "[post-merge-build] running: ${build_command}"
bash -lc "$build_command"
err "[post-merge-build] generated local build artifacts"

install_instruction_targets
err "[post-merge-build] installed managed instruction fragments"
