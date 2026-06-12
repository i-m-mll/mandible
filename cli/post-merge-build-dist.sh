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

bash cli/instructions.sh install
err "[post-merge-build] installed managed instruction fragments"
