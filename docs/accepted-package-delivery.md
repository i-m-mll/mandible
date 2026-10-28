# Accepted package delivery

Protected developer publication installs the application retained by candidate
acceptance. The candidate pin identifies shipped code; the operator-signed merge
identifies source publication. These are separate commits with the same reviewed
tree. Installed runtime execution requires neither Git nor its source checkout.
The registered source project remains an explicit input to developer publication.

Candidate acceptance automatically binds its exact retained package before
exposing a passing verdict. One ordinary `checkpoint_add` action has checkpoint
kind `accepted-release`, payload `{acceptanceId, reference}`, and the request-bound
delivery work unit's canonical issue as its target. The passing acceptance,
selection and system `revised` lifecycle event commit together. Approval validates
the compact receipt and evidence; whole-package verification stays in bounded
child processes.

An identical replay changes neither action nor revision. A new passing acceptance
updates an untouched system-derived selection in place. Manual edits, deletions
and vetoes remain user intent and require explicit reconciliation. Candidate,
lifecycle or custody changes during acceptance fail finalization. The action
must remain staged and non-vetoed when approval freezes it. It records accepted
release evidence; convergence and issue closure remain separate obligations.

The first upgrade from a legacy authority has one explicit bridge: a prearmed
custodian stages the exact selection after acceptance passes and before approval:

```sh
bun scripts/stage-accepted-release.mjs REQUEST ACCEPTANCE ISSUE REVISION CUSTODY_GENERATION
```

Use the request's current lifecycle revision and work-unit custody generation.
The old daemon cannot bind atomically, so this bridge has a brief pass-before-bind
window. The command validates the named passing acceptance and retained package, then
uses the existing authenticated `mandible auth action add` operation to stage
the selection with normal credential and compare-and-swap checks. Subsequent
deliveries under the upgraded authority bind automatically.

The frozen approval/execution snapshot, exact acceptance row and compact receipt
must agree on request and candidate pin/tree/base/head. The immutable receipt
owns package digest, target, signed inventory, provenance and custody. Delivery
never selects a newer row, rebuilds or rewrites shipped provenance.

The app includes precompiled handoff helper, publication verifier and SQLite
facade in its inventoried `handoff/` resources. Admission copies these modules
and freezes the controller import closure before draining the old daemon. It
retains the existing `mandible-runtime-handoff@1` envelope and whole-binding
digest. The legacy bridge or bundle startup guard prevents a replacement writer
before native installation. Database, authority, credentials, backend overrides,
launch mode and shared gateway configuration remain in installation custody.

After drain, the controller unregisters native services or removes captured
legacy definitions, copies and verifies the accepted signed app, replaces the
installed app and adopts its native service owner. The possible-launch journal
boundary precedes service registration. Every re-entry after that boundary is
observation-only. Readiness, continuous health/log coverage, process and native
service identities, installed package digest and any owed desktop relaunch must
converge before delivery actions close issues.

The retained accepted app belongs to its acceptance owned-run. Pending or failed
handoffs preserve it for recovery. Acknowledgment removes the scoped previous
installed app and disposes the superseded owner's retained package. The current
release retains one package for its pinned verification runtime. Immutable
acceptance receipts and evidence survive disposal. Abandoned requests use:

```sh
bun scripts/dispose-accepted-release.mjs REQUEST ACCEPTANCE 'Reason'
```

This refuses an installed release or unresolved handoff, and requires a rejected,
withdrawn, superseded or expired request. Retained packages are not cache material.
Whole-package verification and disposal run in bounded child processes so the
daemon continues serving requests during convergence.

## Qualification

Both delivery topologies use the same fixture phase budgets: approval to durable
helper admission, 60 seconds; admission to completion, 180 seconds; completion to
final acknowledgment, 60 seconds. Concrete failures stop the wait immediately.
These fixture budgets do not change the product's 31-second diagnostic coverage
requirement within its 62-second observation deadline. The deadline is a ceiling,
not a fixed observation duration. Preserving a failed fixture leaves its helper
running until its own bounded work exits; an explicit helper stop is an
interruption case.

The [managed qualification proof](https://app.mandible.localhost:19420/artifact/artifact-version:84f710aad45e?sidebar=hidden&agent_session=01a17e9c)
records both accepted app receipts, native deliveries, exact installed bytes,
superseded-package disposal, and automatic recovery after a test-induced helper
interruption. Its status is `functional-pass-after-fixture-timing-failure`: the
former second-delivery 120-second total wait failed and interrupted its helper.
The later acknowledgment proves recovery, not an uninterrupted pass of that
wait. The phase-only fixture correction has focused tests; the full native
fixture was not rebuilt for that test-only correction. Integration still requires
the repository's exact final-candidate acceptance gate.

Co-Authored-By: Codex (GPT) <codex@openai.com>
