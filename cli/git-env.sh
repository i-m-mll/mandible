#!/usr/bin/env bash

# Git optional locks are unsafe in create-only mounted sessions: a sandboxed git
# process can create index.lock but be unable to remove it. Force the safer mode
# for Mandible CLI internals regardless of caller environment.
export GIT_OPTIONAL_LOCKS=0

# The repository's protected branch: develop when it exists, otherwise main.
detect_protected_branch() {
  if git show-ref --verify --quiet refs/heads/develop 2>/dev/null; then
    echo "develop"
  else
    echo "main"
  fi
}
