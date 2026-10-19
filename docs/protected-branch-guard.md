# Protected-branch guard

A protected branch moves only through an approved Mandible merge or a commit
signed with one of the operator's own keys. The Git `reference-transaction`
hook in [`hooks/git/reference-transaction`](../hooks/git/reference-transaction)
refuses anything else at the moment Git tries to update the ref, from any
command: commit, merge, fast-forward, reset, `update-ref`, `branch -f`, push
into a local repository, and branch creation or deletion.

## What counts as protected

Protection comes from Mandible's existing config: the global
`protected_branches` setting plus each registered checkout's default branch,
applied per repository. Repositories Mandible does not know are never checked.

## Signer rule

A protected branch may point only at a commit signed by an active signing
credential of the configured operator: `ssh_key` (the operator's hardware keys)
or `delegated_ssh_key` (the operator-owned key Mandible's delegated and
clearance merges sign with). Agent users hold neither. The hook accepts the
delegated key because it sees a ref update before Mandible records the merge.

The rule lives in
[`src/protected-branch-signers.ts`](../src/protected-branch-signers.ts), the one
implementation shared with the protected-base history audit. The audit differs
deliberately: it has Mandible's record of its merges, so a recorded merge
passes whatever key signed it, while a commit Mandible did not record passes
only with an operator `ssh_key`. A delegated-key signature on an unrecorded
commit means that key was used outside a Mandible merge, and the audit lists
it.

## Hook decisions

In the `prepared` state, for each update of a protected `refs/heads/<name>`:

| Update | Decision |
| --- | --- |
| New value equals the current value | allowed (no change) |
| Loose-ref prune by `git pack-refs` (same value already in `packed-refs`) | allowed |
| New tip is a commit signed by an operator key | allowed |
| Fast-forward to a commit the branch's remote-tracking upstream already contains | allowed |
| Deletion of an existing protected branch | refused |
| Anything else | refused |

A refusal names the branch and says to submit `mandible auth request`.

The upstream rule lets `git pull --ff-only` and similar syncs bring in
collaborators' or hosting-provider merges that the operator did not sign. It
applies only to a fast-forward, only to the branch's configured upstream under
`refs/remotes/<remote>/`, and only when that remote has a URL. A local process
can still forge a remote-tracking ref; the protected-history check of umbrella
0cda998 surfaces such commits when Mandible next reads the branch.

## Projection

The hook never calls the daemon. The production daemon writes two files under
`$MANDIBLE_HOME/git-guard/` (default `~/.mandible/git-guard/`) at startup and
whenever the `protected_branches` setting, a checkout's registration or default
branch, the operator identity, or an operator signing credential changes:

- `protected-refs`: a header line; `names<TAB><ref>...` listing every protected
  ref name; then `<git common dir><TAB>refs/heads/<name>` per protected branch.
  The Git common directory, with symlinks resolved, identifies a repository, so
  all of its worktrees match.
- `allowed_signers`: the operator's signing keys in ssh-keygen allowed-signers
  format.

Both are generated from the protection config and the user registry
(`src/protected-branch-guard.ts`) and are not edited by hand. Preview and copy
instances never write them.

## Failure behavior

- No `protected-refs` file: Mandible is not set up, so the update is allowed.
  The hook prints one warning line when the branch is `main` or `develop`, the
  shipped default of `protected_branches`.
- An error while checking a protected ref (missing signer list, no registered
  operator key, `/usr/bin/ssh-keygen` unavailable, repository not resolvable):
  that update is refused, except that an upstream fast-forward still passes.
- Updates of other refs and of unknown repositories return before any check
  and never fail.

## Cost

Git runs the hook in every transaction state, and a plain `git fetch` opens one
transaction per updated ref. The hook therefore reads small transactions with
shell builtins and dismisses non-protected branches using the projection's
`names` line, so its cost over an empty hook is well under a millisecond per
call. Checking a protected update runs `git` and `ssh-keygen` and takes tens of
milliseconds.

## Installation and limits

The global hooks directory owned by dotfiles (`~/.config/git/hooks`) runs this
guard from its `reference-transaction` dispatcher. Git hooks do not bind a
same-user process that overrides `core.hooksPath`, and Git's files backend
creates the target of `git branch -m <old> <new>` without a ref transaction, so
renaming a branch onto a missing protected name is not seen. The guard stops
mistakes; the protected-history check makes bypasses visible.
