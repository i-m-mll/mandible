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

Qualification combines one exact finished-package acceptance with one focused
real macOS bundle-to-bundle service replacement proof. The package gate owns
the product daemon, packaged interaction and diagnostic coverage. The native
replacement proof covers the separate installation and SMAppService boundary;
it does not repeat package acceptance, a route sweep, or a diagnostic soak.

The earlier [managed recovery witness](https://app.mandible.localhost:19420/artifact/artifact-version:84f710aad45e?sidebar=hidden&agent_session=01a17e9c)
records both accepted app receipts, native deliveries, exact installed bytes,
superseded-package disposal, and automatic recovery after a test-induced helper
interruption. Its status is `functional-pass-after-fixture-timing-failure`: the
former second-delivery 120-second total wait failed and interrupted its helper.
The later acknowledgment proves recovery, not an uninterrupted pass of that
wait. The phase-only fixture correction has focused tests; the full native
fixture was not rebuilt for that test-only correction. This witness does not
qualify a clean upgrade from current source.

The focused current-source proof extends the retained installer fixture:

```sh
bun run test:provisioned test/provisioned/accepted-app-install.test.ts
```

It builds the current checkout's small native service helper once and stages
two tiny ad-hoc signed bundles with a bundled Bun runtime. Both roles start
through the production native-control, inspector and registration reconciler.
Per-role generation and PID heartbeats agree with qualified process identities.
The first generation's writers must stop before the production retained-app
installer replaces it; the second generation must start with exact retained
package bytes, matching installation authority and release ownership. Previous
package disposal and final service teardown are checked. Provisioning, signing,
helper process cleanup and disposal are counted in the emitted phase costs.
An unconfirmed service stop preserves the app and evidence.

Isolation uses a random private bundle identity, account home, app path and
heartbeat payload through the existing native helper's fixture namespace. The
expected identity comes from that app's Info.plist; observed jobs cannot select
their own trusted identity. No production service, ledger, GUI, protected merge
API or full application build participates in this proof, and production source
is not rewritten to substitute the namespace. It does not establish exact
unmodified product package bytes. [Package/runtime acceptance](candidate-acceptance.md)
and the actual post-approval handoff retain that obligation.

Retain the source-bound native proof before creating the canonical request and
reference it in that request's initial review message. The request links its
automatic exact-package acceptance result directly; passing acceptance requires
no prose edit, manual package binding or rebuild. The ordinary
warm-toolchain verification design targets 60 seconds with a 90-second whole-path
ceiling, including source/package preparation, proofs and a teardown reserve.
That is a design budget, not a measured result; one proof's local deadline is
not an additional allocation beyond the shared verification schedule.
The allocation is at most 10 seconds for source checks, 20 seconds for the
native replacement fixture including a five-second teardown reserve, and
60 seconds for automatic acceptance including its five-second cleanup reserve.
The native fixture's clock starts in the existing provisioned launcher before
private runtime and Vitest startup; the test consumes the remaining allowance.
Installation, registration observation and retained-package disposal share that
original deadline rather than starting new per-operation budgets.

The legacy-to-bundle bootstrap remains historical migration coverage. Repeating
its old-source build and two full package acceptances is not a prerequisite for
subsequent bundle-to-bundle repair qualification.

Co-Authored-By: Codex (GPT) <codex@openai.com>
