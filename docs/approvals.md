# Approvals and the Touch ID gate

Mandible acts on an operator approval in one of two ways. A signed action takes a signature from the operator's approval key, which the Mac's Secure Enclave produces only after it has matched an enrolled fingerprint. A courtesy action takes one click. The interface labels each one, and the ledger records them differently.

## Signed actions

These need one Touch ID match each:

- A merge into a protected branch. The approval key signs the merge commit itself, so the protected history is checkable with stock `git verify-commit` against the approval key, and GitHub shows it as Verified if the key is registered there as a Signing key.
- A change to whom the gate trusts or what it covers: enrolling or replacing the approval key, adding or removing an external signer, and changing the `protected_branches` setting.

Mandible verifies every signature against the enrolled public key before it acts. A yes/no answer from macOS LocalAuthentication is never treated as authorization, because any process running as the operator can produce the same answer.

In the interface, a signed action says it will ask for Touch ID ("Approve with Touch ID", "Save with Touch ID"). A signed merge approval is shown afterwards as "Signed with Touch ID".

## Courtesy actions

Every other approval and operator action is a courtesy action: review dispositions, rejecting a request, approving a request that publishes no merge, hooks, users, tokens, and the remaining settings. It keeps its route's identity and capability checks, and its evidence records the caller as client authentication resolved it, with `verified: false`.

The interface labels these "Approve as courtesy" and, once approved, "Courtesy approval, not operator-verified". A courtesy approval is never shown as operator-verified: any process running as the operator can perform one through Mandible's local API, the socket, or the CLI. None of these actions lets such a process do anything it could not already do directly.

## One-touch merge approval

1. The operator clicks Approve. Mandible validates the request and builds the exact merge commit from the merge tree retained at submission. Nothing is written.
2. The Touch ID sheet appears, right after the click and at no other time.
3. The enclave signs the commit. Cancelling, or any refusal from the helper, leaves the request pending with nothing changed.
4. Mandible writes the signed commit object and the approval evidence. No branch refers to the commit yet.
5. The executor moves the protected branch to that commit by compare-and-swap and runs what follows a merge. If the branch moved in the meantime, the update is refused and the request can be approved again.

The approval dialog follows what the approval helper reports:

| State | Meaning |
| --- | --- |
| Waiting for Touch ID | The sheet is up. Mandible takes no focus; click the sheet if it is behind another window. |
| Cancelled | Nothing was signed or changed. |
| Touch ID unavailable | For example the lid is closed with no Touch ID keyboard. There is no password approval; approval waits until Touch ID is available. |
| Touch ID locked | macOS locked Touch ID after failed matches. Unlocking the Mac with the account password re-enables it. |
| No login session | The helper cannot show a sheet without a logged-in session. |
| Needs re-enrollment | The key file is missing, or the enrolled fingerprints changed and the enclave will not use the key again. Enroll a new key in Settings. |

## What the gate proves, and what it does not

- **It proves a matching finger touched, not what the operator believed they were approving.** An agent running as the operator can raise its own Touch ID sheet. If the operator touches it, the enclave signs whatever that agent asked for. A YubiKey has the same limit. Mandible's sheet appears immediately after the operator clicks and at no other time, so **cancel any Touch ID prompt you did not expect.**
- **The name on the sheet proves nothing.** The sheet names the requesting app, "Mandible", and the reason text Mandible supplies. Another program can show a sheet with the same name and text.
- **It does not stop a same-user process that bypasses Mandible.** Everything Mandible owns, and every repository, is writable by the operator's macOS user, and agents run as that user. A process that replaces Mandible's key list, guard files, or code, or moves a branch with plain git and hooks disabled, is not stopped by any local mechanism. The remaining gate is the remote: a push to GitHub needs a physical YubiKey touch, provided no token able to push exists. Forged history is still detectable, because no such process can produce the approval key's signature.
- **The approval key lives and dies with this Mac's enclave.** It cannot be exported or backed up. It does not survive erasing the Mac or moving to a new Mac, and macOS invalidates it when the enrolled fingerprints change. In each case the operator enrolls a new key in Settings. With no usable key to sign the change, the new enrollment is a recorded bootstrap event, shown in Settings under Trust changes. Someone who knows the account password can enroll a new fingerprint and then a new key; the bootstrap record is how the operator sees that it happened.

macOS offers no attestation that a public key is enclave-bound with a fingerprint rule, so trust in the approval key is established at enrollment. Every later change to the key set is either signed by the current approval key or recorded as a bootstrap event.

## Settings

Settings → Approvals shows:

- the approval key's state and fingerprint, and its public key as an OpenSSH line that GitHub accepts as a Signing key;
- external signers, which Mandible only verifies on protected branches and never signs with (a replaced approval key stays here as one);
- the history of trust changes, each marked Signed or Bootstrap.

See also [Protected-branch guard](protected-branch-guard.md) for the Git hook that refuses unsigned updates of protected branches, and [Approvals end to end](guides/auth-workflow.mdx) for the request lifecycle.
