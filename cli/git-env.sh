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

# Issue c8817ff — a target branch with no commits yet is unborn. Its base is
# Git's null object id, the old value `git update-ref` takes to require that
# the ref does not exist.
is_unborn() {
  [[ "$1" =~ ^0+$ ]]
}

# The commit refs/heads/<branch> names in <checkout> (default: the current
# directory), the null object id when that checkout has <branch> checked out
# with no commits, or nothing.
target_branch_sha() {
  local branch="$1" checkout="${2:-.}" sha
  if sha=$(git -C "$checkout" rev-parse --verify --quiet "refs/heads/${branch}^{commit}"); then
    printf '%s' "$sha"
    return 0
  fi
  [[ "$(git -C "$checkout" symbolic-ref --quiet HEAD 2>/dev/null || true)" == "refs/heads/${branch}" ]] || return 0
  ! git -C "$checkout" show-ref --verify --quiet "refs/heads/${branch}" || return 0
  if [[ "$(git -C "$checkout" rev-parse --show-object-format)" == "sha256" ]]; then
    printf '%064d' 0
  else
    printf '%040d' 0
  fi
}

# The worktree that has refs/heads/<branch> checked out, per <checkout>'s
# repository (default: the current directory). Fails when there is none. The
# listing is read whole, so git never writes into a closed pipe (issue 9904147).
branch_worktree() {
  local branch="$1" checkout="${2:-.}" listing
  listing=$(git -C "$checkout" worktree list --porcelain) || return
  awk -v want="branch refs/heads/$branch" '/^worktree /{w=substr($0,10)} $0==want{print w; found=1} END{exit !found}' <<<"$listing"
}
