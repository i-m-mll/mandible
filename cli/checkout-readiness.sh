#!/usr/bin/env bash
set -u
set -o pipefail

[[ $# -eq 1 || $# -eq 4 ]] || { printf 'Usage: checkout-readiness.sh <checkout> [<base-branch> <base-sha> <candidate-tree>]\n' >&2; exit 2; }
checkout=$1
g() { GIT_OPTIONAL_LOCKS=0 git -C "$checkout" "$@"; }
root=$(g rev-parse --show-toplevel) || exit 2
if g rev-parse --verify --quiet MERGE_HEAD >/dev/null; then
  printf 'Checkout %q has a merge in progress. Resolve it separately, then refresh approval readiness.\n' "$root"
  exit 1
fi
status_file=$(mktemp) || exit 2
trap 'rm -f "$status_file"' EXIT
if ! g status --porcelain=v1 -z --untracked-files=no --ignore-submodules=none > "$status_file"; then
  printf 'Could not inspect tracked state in checkout %q. This readiness check changed no checkout files.\n' "$root"
  exit 2
fi
if [[ -s "$status_file" ]]; then
  printf 'Protected checkout %q: tracked worktree changes are present:\n' "$root"
  while IFS= read -r -d '' record; do
    state=${record:0:2}
    file=${record:3}
    index_state=${state:0:1}
    worktree_state=${state:1:1}
    if [[ "$state" == *U* || "$state" == AA || "$state" == DD ]]; then
      description=unmerged
    elif [[ "$index_state" != ' ' && "$worktree_state" != ' ' ]]; then
      description='staged and unstaged'
    elif [[ "$index_state" != ' ' ]]; then
      description=staged
    else
      description=unstaged
    fi
    printf '  %s [%s]: %q\n' "$description" "$state" "$file"
    if [[ "$index_state" == R || "$index_state" == C ]]; then
      IFS= read -r -d '' original || exit 2
    fi
  done < "$status_file"
  printf 'Preserve these edits in their intended worktree and restore a clean protected checkout, then refresh this request. This readiness check changed no checkout files.\n'
  exit 1
fi
if [[ $# -eq 4 ]]; then
  branch=$(g symbolic-ref --quiet --short HEAD || true)
  current_base=$(g rev-parse --verify "refs/heads/$2" 2>/dev/null || true)
  if [[ "$branch" == "$2" && "$current_base" == "$3" ]]; then
    script_dir="$(cd "$(dirname "$0")" && pwd)"
    bash "$script_dir/checkout-sync-check.sh" "$root" "$3" "$4" || exit $?
  fi
fi
