#!/usr/bin/env bash
# Bring a checkout's submodules to the gitlinks a merge records.
#
# Usage: submodule-sync.sh fetch|update <checkout> <base> <target> <head-branch>
#
# `git read-tree -m -u` moves gitlinks in the index but never moves a
# submodule's checkout. For each gitlink that differs between <base> and
# <target> and whose submodule is initialized in <checkout>:
#   fetch   makes the target commit present in the submodule, fetching it from
#           the same submodule in <head-branch>'s worktree when it is missing.
#           No checkout changes.
#   update  fetches, then detaches the submodule at the target commit. A
#           submodule at neither the base nor the target commit is left alone
#           and reported.
# Uninitialized submodules are skipped; git status does not report them.
# Exit 0: done. Exit 1: stdout names each submodule that could not be synced.
set -u
set -o pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/git-env.sh"

if [[ $# -ne 5 || ( $1 != fetch && $1 != update ) ]]; then
  printf 'Usage: submodule-sync.sh fetch|update <checkout> <base> <target> <head-branch>\n' >&2
  exit 2
fi
mode=$1
checkout=$2
base=$3
target=$4
head_branch=$5
# An unborn base (Git's null object id, issue c8817ff) has the empty tree.
[[ ! $base =~ ^0+$ ]] || base=$(git -C "$checkout" hash-object -t tree /dev/null)

diff=$(git -C "$checkout" diff-tree -r -z --no-renames "$base" "$target" | tr '\0' '\n') || {
  printf 'Could not list gitlinks changed from %s to %s in %s.\n' "${base:0:10}" "${target:0:10}" "$checkout"
  exit 1
}

failed=0
source_root=""
while IFS= read -r meta && IFS= read -r path; do
  read -r _ new_mode old_sha new_sha _ <<<"${meta#:}"
  [[ $new_mode == 160000 ]] || continue
  submodule="$checkout/$path"
  [[ -e "$submodule/.git" ]] || continue
  if ! git -C "$submodule" cat-file -e "${new_sha}^{commit}" 2>/dev/null; then
    [[ -n $source_root ]] || source_root=$(branch_worktree "$head_branch" "$checkout") || source_root=""
    if [[ -z $source_root || ! -e "$source_root/$path/.git" ]]; then
      printf 'Submodule %s: commit %s is missing, and branch %s has no worktree with this submodule initialized to fetch it from.\n' "$path" "$new_sha" "$head_branch"
      failed=1
      continue
    fi
    if ! output=$(git -C "$submodule" fetch --quiet --no-tags --no-write-fetch-head "$source_root/$path" "$new_sha" 2>&1); then
      printf 'Submodule %s: fetching commit %s from %s failed: %s\n' "$path" "$new_sha" "$source_root/$path" "$output"
      failed=1
      continue
    fi
  fi
  [[ $mode == update ]] || continue
  current=$(git -C "$submodule" rev-parse --verify HEAD 2>/dev/null || true)
  [[ $current == "$new_sha" ]] && continue
  if [[ $current != "$old_sha" ]]; then
    printf 'Submodule %s: checkout is at %s, neither the base commit %s nor the merged commit %s; it was left unchanged.\n' "$path" "${current:-no commit}" "$old_sha" "$new_sha"
    failed=1
    continue
  fi
  if ! output=$(git -C "$submodule" checkout --quiet --detach "$new_sha" 2>&1); then
    printf 'Submodule %s: checking out merged commit %s failed: %s\n' "$path" "$new_sha" "$output"
    failed=1
  fi
done <<<"$diff"
exit "$failed"
