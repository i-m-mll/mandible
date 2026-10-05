# Extended behavior suite

`bun run test:extended` executes maintained behavior, state reconciliation,
security, format, custody, and layer-specific projection tests. A lower-layer
case does not replace a mounted-view case that protects a draft, selection,
request generation, or persisted user intent. `spaces-export.test.ts` and
`spaces-exports.test.ts` remain distinct export surfaces.

Source and CSS string scans, fixed geometry, class names, literal copy, and
helper restatements do not qualify by themselves. Selectors used to drive an
interaction are different from assertions whose sole result is today's selector.
A security or format configuration boundary is retained when it has no equivalent
executable proof; it must not be relabeled presentation to erase a failure.

The runner starts each ordinary file in an isolated process with one worker,
measures its aggregate process-tree memory, and stops it at 950,000 KiB. The IAB
launcher runs separately, one declaration per process, through
`scripts/run-iab-preview-tests.mjs`. It is excluded from ordinary Vitest only to
avoid duplicate execution. `local-ca-lockf.test.ts` runs on provisioned macOS
with Xcode Command Line Tools and the real `lockf`; the maintained runner omits
it on other platforms. Explicitly requesting it on an unsupported host fails.

The runtime handoff fixtures are explicit macOS upgrade gates.
`runtime-handoff-launchd.test.ts` skips when no legacy interpreter input is
provided; `runtime-handoff-full.test.ts` skips when its documented old checkout,
interpreter, candidate revision, trusted CA, build home, or runtime archive input is absent.
These are reported as skipped, never passing upgrade evidence. Provided invalid
inputs fail. Their provisioned commands and final gate are documented in
[runtime handoff](../../docs/runtime-handoff.md).

Every other kept file executes. Historical failures and content hashes do not
exclude tests. A failure needs a current verdict: repair a defective fixture,
fix the product through its owning issue, or retire an incidental assertion
with a recorded reason. Increasing a hash or changing an expectation merely to
make the gate green is not a verdict.

The per-file disposition is in [adjudication.md](adjudication.md). Deletion
counts exclude relocation; historical bytes remain in Git. No deletion or
coverage quota defines acceptance. Coordinated default, extended, and affected
browser runs establish behavior after the common runtime and worker inputs
stabilize. File-specific timeouts need observed current evidence; historical
contention alone does not justify raising the global timeout.

Co-Authored-By: Codex (GPT-5) <codex@openai.com>
