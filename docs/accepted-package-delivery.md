# Accepted package delivery

Protected developer publication installs the application retained by candidate
acceptance. The candidate pin identifies shipped code; the operator-signed merge
identifies source publication. These are separate commits with the same reviewed
tree. Installed runtime execution requires neither Git nor its source checkout.
The registered source project remains an explicit input to developer publication.

After candidate acceptance passes, stage its exact selection before approval:

```sh
bun scripts/stage-accepted-release.mjs REQUEST ACCEPTANCE ISSUE REVISION CUSTODY_GENERATION
```

Use the request's current lifecycle revision and work-unit custody generation.
The command validates the named passing acceptance and retained package, then
uses the existing authenticated `mandible auth action add` operation to stage
one `checkpoint_add` action with checkpoint kind `accepted-release` and payload
`{acceptanceId, reference}`. The action must remain staged and non-vetoed when
approval freezes it. It records accepted release evidence; convergence and issue
closure remain separate obligations.

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
handoffs preserve it for recovery. Retained packages are not cache material;
`disposeAcceptedRelease(reference, candidate, reason)` is the explicit owner
cleanup operation for abandoned or superseded releases. Immutable acceptance
receipts and evidence survive disposal. Current handoff runtime custody must
remain available until its journal no longer needs verification.

Co-Authored-By: Codex (GPT) <codex@openai.com>
