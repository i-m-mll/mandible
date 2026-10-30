#!/usr/bin/env bash
# Predict whether a protected checkout can move from <base> to <target>.
#
# Usage: checkout-sync-check.sh <checkout> <base> <target>
#
# <base> and <target> are commit or tree ids. The verdict is the dry run of
# the exact sync the merge executor performs (`git read-tree -m -u`), so it
# covers skip-worktree and assume-unchanged entries that `git status` hides,
# and untracked files the target would overwrite. Exit 0: the sync would
# succeed. Exit 1: it would not; stdout names each blocking path, why it
# blocks, and how to clear it. Nothing in the checkout is changed.
set -u
set -o pipefail

[[ $# -eq 3 ]] || { printf 'Usage: checkout-sync-check.sh <checkout> <base> <target>\n' >&2; exit 2; }
checkout=$1
base=$2
target=$3
g() { GIT_OPTIONAL_LOCKS=0 git -C "$checkout" "$@"; }

if dry_run=$(g read-tree -m -u -n "$base" "$target" 2>&1); then
  exit 0
fi

changed=$(g diff --name-only --no-renames "$base" "$target" | LC_ALL=C sort -u)
added=$(g diff --name-only --no-renames --diff-filter=A "$base" "$target")
blockers=()
fixes=()

flag_differs() {
  local path=$1 staged
  [[ -f "$checkout/$path" ]] || return 0
  staged=$(g rev-parse --verify --quiet ":$path") || return 0
  [[ "$(g hash-object -- "$path")" != "$staged" ]]
}

while IFS= read -r line; do
  [[ -n "$line" ]] || continue
  tag=${line%% *}
  path=${line#* }
  grep -qxF -- "$path" <<<"$changed" || continue
  flag_differs "$path" || continue
  if [[ "$tag" == S ]]; then
    blockers+=("$path: marked skip-worktree and differs on disk, and the merge changes it")
    fixes+=("git -C '$checkout' update-index --no-skip-worktree -- '$path', then commit, stash, or discard that change")
  else
    blockers+=("$path: marked assume-unchanged and differs on disk, and the merge changes it")
    fixes+=("git -C '$checkout' update-index --no-assume-unchanged -- '$path', then commit, stash, or discard that change")
  fi
done < <(g ls-files -v | grep -E '^(S|[a-z]) ')

while IFS= read -r path; do
  [[ -n "$path" ]] || continue
  grep -qxF -- "$path" <<<"$changed" || continue
  blockers+=("$path: has uncommitted changes, and the merge changes it")
  fixes+=("commit, stash, or discard the change to '$path'")
done < <(g diff --name-only --no-renames)

while IFS= read -r path; do
  [[ -n "$path" && -e "$checkout/$path" ]] || continue
  g ls-files --error-unmatch -- "$path" >/dev/null 2>&1 && continue
  blockers+=("$path: untracked file where the merge adds one")
  fixes+=("move or delete '$checkout/$path'")
done <<<"$added"

printf 'Checkout %s cannot be synced from %s to %s.\n' "$checkout" "${base:0:10}" "${target:0:10}"
if (( ${#blockers[@]} == 0 )); then
  printf 'git refused the sync: %s\n' "$dry_run"
  exit 1
fi
printf 'Blocking paths:\n'
printf '  %s\n' "${blockers[@]}"
printf 'To clear them:\n'
printf '  %s\n' "${fixes[@]}"
exit 1
