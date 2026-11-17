# Approvals and the Touch ID gate

Mandible acts on an operator approval in one of two ways. A signed action takes a signature from the operator's approval key, which the Mac's Secure Enclave produces only after it has matched an enrolled fingerprint. A courtesy action takes one click. The interface labels each one, and the ledger records them differently.

The Touch ID gate covers exactly three things: merges into protected branches through Mandible's merge path, the operator's direct commits to protected branches, and changes to the trust set (the approval key and which branches are protected). Nothing else is gated. A courtesy-approved request runs whatever command it carries, including one that runs `git update-ref` on a protected branch, and nothing run outside Mandible passes through the gate at all. The protected-branch guard and the base audit can show such changes afterwards; they cannot prevent them.

## Signed actions

These need one Touch ID match each:

- A merge into a protected branch. The approval key signs the merge commit itself, so the protected history is checkable with stock `git verify-commit` against the approval key, and GitHub shows it as Verified if the key is registered there as a Signing key.
- A direct commit to a protected branch with `mandible commit` (see [Committing directly](#committing-directly)). The approval key signs that commit in the same way.
- A change to whom the gate trusts or what it covers: enrolling the approval key, changing the `protected_branches` setting, and changing a registered checkout's default branch (which is protected).

Mandible verifies every signature against the enrolled public key before it acts. A yes/no answer from macOS LocalAuthentication is never treated as authorization, because any process running as the operator can produce the same answer.

The approval key is the operator's only signing key; Mandible trusts no key held elsewhere, such as a YubiKey. Buttons name the action ("Approve", "Save"); a signed merge approval is shown afterwards as "Signed". With no usable approval key, approving a protected merge is refused before Mandible does any work, and the interface says "Touch ID is not set up" with a link to Settings → Approvals.

One click opens one sheet. Mandible runs one signed action at a time: while a sheet is open, any other signed action is refused at once without a sheet. **Cancel any other Touch ID prompt.**

## Courtesy actions

Every other approval and operator action is a courtesy action: review dispositions, rejecting a request, approving a request that publishes no merge, hooks, users, tokens, and the remaining settings. It keeps its route's identity and capability checks, and its evidence records the caller as client authentication resolved it, with `verified: false`.

Once approved, the interface labels these "Courtesy approval". A courtesy approval is never shown as operator-verified: any process running as the operator can perform one through Mandible's local API, the socket, or the CLI. None of these actions lets such a process do anything it could not already do directly.

## One-touch merge approval

1. The operator clicks Approve, or runs `mandible auth approve <request> --revision <n>` in their own terminal (see [Approving from a terminal](#approving-from-a-terminal)). The approval carries the request revision the operator was shown; if the request has changed since, the approval is refused before any sheet. Mandible validates the request and builds the exact merge commit from the merge tree retained at submission, authored as the operator's name and email from Mandible's user record. Nothing is written.
2. The Touch ID sheet appears, right after the click or the command and at no other time. It names the branches, the repository and the request's short id.
3. The enclave signs the commit. Cancelling, any refusal from the helper, or leaving the sheet open past 60 seconds leaves the request pending with nothing changed.
4. Mandible writes the signed commit object and the approval evidence, which names that commit. No branch refers to the commit yet.
5. The executor moves the protected branch to that commit by compare-and-swap and runs what follows a merge. If the branch moved in the meantime, the update is refused and the request can be approved again. The request completes only if the published commit is the one the approval signed and its signature verifies against the approval key; any other commit, however signed, leaves it for recovery.

The approval dialog follows what the approval helper reports:

| State | Meaning |
| --- | --- |
| Waiting for Touch ID | The sheet is up. Mandible takes no focus; click the sheet if it is behind another window. |
| Cancelled | Nothing was signed or changed. |
| Touch ID unavailable | For example the lid is closed with no Touch ID keyboard. There is no password approval; approval waits until Touch ID is available. |
| Touch ID locked | macOS locked Touch ID after failed matches. Unlocking the Mac with the account password re-enables it. |
| No login session | The helper cannot show a sheet without a logged-in session. |
| Touch ID is not set up | No key is enrolled, the key file is missing, or the enrolled fingerprints changed and the enclave will not use the key again. Enroll in Settings → Approvals. |

## Approving from a terminal

`mandible auth approve <request> --revision <n>` is the operator's own approval from a terminal. It approves exactly what the button approves, protected merges and courtesy approvals alike. `<n>` is the revision `mandible auth show <request>` prints; the command never approves whatever the request has become since. A protected merge raises the same single Touch ID sheet, then the command waits for the request to settle and prints its result: exit 0 when it completed, 1 otherwise, 2 for a usage error. Interrupting it cancels the sheet and leaves the request pending.

`mandible auth deliver <branch> --title <text> --message <text> --verification <text>` is the operator's whole delivery of a branch from its checkout: it uses `--issue`, or the open issue with exactly that title, or files one (kind `feature` unless `--kind` says otherwise); activates the work unit; withdraws a pending request for the same branches; submits a request that closes the issue; and approves it with one touch. It ends merged, or with no pending request left and the issue open for a rerun.

Both commands refuse agent and managed sessions before they contact Mandible, and Mandible itself refuses approval from any agent identity, so an agent cannot approve through them. The touch remains the gate: without it nothing is signed.

## Committing directly

`mandible commit -m <message>`, run in a checkout of a protected branch with staged changes, is the operator's `git commit` there. It commits the index onto the branch after one Touch ID match and leaves the checkout on the new tip. Plain `git commit` cannot do this, because the protected-branch guard accepts only commits signed with the approval key.

1. Mandible builds the commit from the index, with the branch tip as its only parent, the message cleaned as `git commit -m` cleans it, and the operator's name and email from Mandible's user record as author and committer.
2. The Touch ID sheet names the direct commit, the repository, the branch, the message's subject and the number of files changed.
3. The approval key signs the commit, and Mandible checks the signature with `git verify-commit` against the enrolled key.
4. The branch moves to the signed commit by compare-and-swap from the tip it was built on. Unstaged and untracked changes are left as they were.

It refuses, with nothing committed and no sheet, when nothing is staged, when the branch is not protected (plain `git commit` works there), or when the checkout is not on a branch; and with nothing committed after the sheet when the touch is cancelled or the branch or HEAD moved in the meantime. Interrupting the command cancels the sheet. Commit hooks do not run, and nothing that follows a merge, such as approval hooks or a runtime rebuild, runs after it.

A published commit is recorded as a completed `commit` request with just its message, diff summary and resulting commit; it needs no issue, work unit, branch or verification text. Its signature evidence has the same shape as a signed merge's, so the protected-base audit and the base-transition check of pending merges count it as recorded protected history: a merge request pending when the operator commits directly can still be approved without being requeued. Like `auth approve`, the command refuses agent and managed sessions before it contacts Mandible, and Mandible refuses any caller but the operator.

## What the gate proves, and what it does not

- **It proves a matching finger touched, not what the operator believed they were approving.** An agent running as the operator can raise its own Touch ID sheet. If the operator touches it, the enclave signs whatever that agent asked for. A hardware key would have the same limit. Mandible's sheet appears immediately after the operator clicks Approve or runs `mandible auth approve`, `mandible auth deliver` or `mandible commit`, and at no other time, so **cancel any Touch ID prompt you did not expect.**
- **The name on the sheet proves nothing.** The sheet names the requesting app, "Mandible", and the reason text Mandible supplies. Another program can show a sheet with the same name and text.
- **It does not stop a same-user process that bypasses Mandible.** Everything Mandible owns, and every repository, is writable by the operator's macOS user, and agents run as that user. A process that replaces Mandible's key list, guard files, or code, or moves a branch with plain git and hooks disabled, is not stopped by any local mechanism. The remaining gate is the remote: a push to GitHub needs a physical YubiKey touch, provided no token able to push exists. Forged history is still detectable, because no such process can produce the approval key's signature.
- **The approval key lives and dies with this Mac's enclave.** It cannot be exported or backed up. It does not survive erasing the Mac or moving to a new Mac, and macOS invalidates it when the enrolled fingerprints change. In each case the operator enrolls a new key in Settings. With no usable key to sign the change, the new enrollment is a recorded bootstrap event. Someone who knows the account password can enroll a new fingerprint and then a new key; Settings → Approvals shows a warning for the latest bootstrap that replaced a key, and the record is how the operator sees that it happened.

macOS offers no attestation that a public key is enclave-bound with a fingerprint rule, so trust in the approval key is established at enrollment. Every later change to the key set is either signed by the current approval key or recorded as a bootstrap event.

## Settings

Settings → Approvals shows Touch ID as Enrolled, with a button that copies the approval key's OpenSSH public key (GitHub accepts it as a Signing key), or an Enroll button. A key that is missing or invalidated is not enrolled. Enrolling replaces any enrolled key, which is revoked; merges it signed before its revocation still verify. When the latest enrollment replaced a key without that key's signature (a bootstrap), one line says so. The trust-change history is returned by `GET /api/users/operator/signing-key`.

See also [Protected-branch guard](protected-branch-guard.md) for the Git hook that refuses unsigned updates of protected branches, and [Approvals end to end](guides/auth-workflow.mdx) for the request lifecycle.
