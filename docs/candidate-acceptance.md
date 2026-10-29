# Package/runtime acceptance

The approval view labels the existing candidate gate **Package/runtime
acceptance**. It checks exact package bytes and runtime behavior in an isolated
instance; a pass does not establish that an installed upgrade will converge.
The CLI command is `candidate-acceptance`; stored/API fields use
`candidate_acceptance`.

Run the bundled daemon and packaged desktop from one clean, committed candidate:

```sh
runtime=$(scripts/bun-runtime.sh)
PATH="$(dirname "$runtime"):$PATH" "$runtime" run candidate-acceptance -- \
  --project <canonical-project-id> --work-unit <canonical-delivery-work-unit-id>
```

The project and delivery work unit come from the live Mandible registry. The coordinator supplies its integration work unit for the final gate. No preview, installed application, LaunchAgent, or production database is restarted or replaced.

The bundle transaction assesses the exact signed complete shipped application
and its isolated bundled-runtime behavior. Full-corpus source-preview route
performance is a separate standalone `route-cost-sweep` diagnostic, tracked by
[issue:2a96e3d]. A bundle pass does not claim that corpus-performance assessment
passed. Its first/warm 100 ms contract remains unchanged; bundled-runtime live
health retains its 250 ms stall, lag, and memory checks.

The command builds the finalized application through the installed-release assembler, verifies its signature, resource inventory and candidate provenance, then starts the application's shipped Bun/daemon and Caddy directly. It does not register or upgrade SMAppService jobs. Daemon, gateway and GUI run with the checkout, dotfiles, Homebrew and developer runtime stores denied, and the application read-only. It verifies the exact instance, generation, startup commit and epoch. It creates an operator fixture through that daemon's private socket. The packaged webview uses an isolated, nonpersistent browser store, opens Settings, changes the app theme, and checks the persisted preference revision. The window remains open until a fresh observation from the same production collectors covers the actual end of the interaction, after one collector turn accounts for just-completed blocking work. The ordinary 30-second reporting sampler is unchanged; acceptance does not wait for that reporting tick. Daemon and native logs are assessed after owned processes stop, including shutdown.

The packaged app runs unattended: in acceptance mode its window is never shown, never takes focus, and the app has no Dock icon or menu bar (macOS activation policy `Prohibited`, set before launch). The webview still loads and drives the dashboard.

Candidate acceptance and the built-in post-merge rebuild apply to runtime self-update requests whose server-captured change report touches the production source paths declared in `scripts/build-revision.mjs`. These include the daemon, channel server, UI and its assets, native app, CLI, build and acceptance scripts, configuration, and dependency/runtime pins. Both old and new paths count for renames and deletions. Changes outside those paths, such as `README.md` and `docs/` screenshots, skip acceptance and the built-in rebuild, without opening a rebuild window or scheduling a restart. A request without a change report bound to its reviewed head remains gated. Other configured hooks still run, and existing durable hook plans retain their reviewed commands and execution history.

A held runtime handoff lock defers acceptance scheduling until the installation
is available. A lock appearing during a valid isolated run does not invalidate
its result. Acceptance does not inspect production service definitions: owned
drift neither fails a run nor invalidates a passing result.

Before approval and when queued execution takes its turn, publication checks
service ownership for requests that rebuild the runtime. Foreign jobs or files
and unreadable ownership evidence refuse publication with the affected service
and concrete reason. Entirely absent services are ready. Owned drift is
reconciled by the ordinary handoff. The request detail, queue and history expose
ownership refusals and the retained handoff-lock blocker, without repair
commands. Documentation-only exemptions remain unchanged.

Approval of a request within that scope requires a passing result for its exact retained candidate. The main daemon starts a run when such a request is submitted or superseded, whenever its candidate is re-pinned onto a moved base, and at startup for pending requests without a result for their current candidate. A failed result requires an explicit retry, including after restart. After a merge moves the base, the merge's finalizer re-pins every pending request's candidate. While a runtime handoff holds its lock the finalizer cannot, so the daemon's 30-second idle tick re-pins every stale candidate once no lock is held, as does startup. The tick never repeats a failed result. Approval and `mandible auth acceptance run` also re-pin a stale candidate first. Runs execute one at a time; each checks out the request's pin commit in the daemon's detached acceptance checkout, runs a frozen install, and runs this command there. The record binds the candidate tree, reviewed base and reviewed head, so a moved base or head makes it stale.

A record is written when a run starts, as `running`, and ends `passed` or `failed` with a reason. A newer candidate or a resolution of the request aborts the open run and fails it with the reason. A run a daemon restart interrupted is failed at the next start and runs again. The request view shows the state (`none`, `running`, `passed`, `failed` or `stale`) with any reason. `mandible auth acceptance show <request>` reports it with the local time the current run started, and `mandible auth acceptance run <request>` reruns a failed or stale result after a cause outside the candidate is fixed.

A passing result is a pre-merge package/runtime assessment. It does not attest
the SMAppService upgrade transition, installation adoption, delivery convergence,
native Connections setup, secure gateway trust, or every product workflow.
Exact unmodified package bytes are checked here and again during the actual
post-approval handoff. Upgrade lifecycle qualification uses the separate
[two-hop private fixture](runtime-handoff.md#verification), whose source is
transformed for private identities, homes and ports; it does not prove identical
unmodified source/package bytes.

For this bundle-service repair, before presenting approval the coordinator
requires a clean current-source two-hop upgrade witness retained as a managed
artifact. An earlier witness that needed recovery demonstrates recovery, not a
clean current-source upgrade. Keep this repair's pending request verification
explicit: **Upgrade qualification for this bundle-service repair: pending until
a clean current-source two-hop witness is retained as a managed artifact.** Once
that artifact exists, revise the request message through the normal guarded
revision before approval. Future affected upgrades after migration exercise the
ongoing bundle-to-bundle contract, without a permanent legacy-bootstrap
requirement. Upgrade qualification is separate from the automated package/runtime gate. See
[upgrade qualification](accepted-package-delivery.md#qualification)
for the command and evidence boundary.

Each run records its exact project, work-unit owner, instance and generated outputs before producing them. The shared owned-run lifecycle saves a compact receipt outside the scratch root and reclaims disposed raw material after assessment or failure. Unknown files, active consumers, identity drift and cleanup errors preserve the remaining bytes and fail the gate. The receipt contains source and executable hashes, the runtime, interaction evidence, log digest, shutdown results and cleanup outcome. Apparent unlinked bytes are reported separately from physical space recovery.

Generated storage is reconciled asynchronously at daemon startup, on committed
auth request/selection changes, on the existing idle tick, and before acceptance
or route-sweep allocation. Process lifetime and recorded process groups establish
whether interrupted scratch is abandoned; open-file inspection additionally
checks consumers. Cleanup saves its outcome outside the generated root, removes
only declared outputs, preserves unknown entries, and retries partial deletion
without repeating acceptance, publication, merge, or handoff.

Accepted applications remain while a live request selects them, the current
acceptance needs them, the installed bundle owns them, an unresolved delivery
references either predecessor or replacement, or an explicit investigation holds
them. Acquisition and disposal claims share a short SQLite write boundary;
inspection, application hashing and unlink run outside it. The existing handoff
owner can release its predecessor only after terminal convergence. Immutable
acceptance evidence and release receipts survive payload disposal. Legacy roots
without recorded producer lifetimes require explicit disposition; this preserves
existing recovery and investigation material during rollout. The reusable
acceptance checkout and unique writable previews are outside collection.

Inspect or apply the same retention decision with:

```bash
bun scripts/generated-storage.mjs --limit 1000
bun scripts/generated-storage.mjs --apply --limit 1000
```

The default bounded pass examines eight entries per category. Its returned
`cursors` can be supplied as `--cursor '<json>'` to continue; the daemon carries
them between idle passes. Optional `--home`, `--db` and `--cache` select an
isolated installation. Inventory opens the ledger read-only and changes no files.
`disposed` reports intentional payload removal with its durable cleanup outcome.
`cleanup-pending` retains the reason and is retried by maintenance.

Retain a run for investigation with `--apply --retain <metadata.json> --reason
<need> --review-by <ISO-date>`; release it with `--apply --release <metadata.json>
--reason <resolution>`. A review deadline never grants deletion authority.
Release removes the hold; operational references still determine payload lifetime.
Route sweeps using `--keep` additionally require `--project` and `--work-unit`
owner IDs, `--reason`, and `--review-by` within seven days. Ordinary disposable
sweeps use process ownership without inventing ledger work units.

Passing runs transfer the complete application that ran into durable owned-run
custody at `<authority-home>/accepted-releases/<run-id>/Mandible.app` before
scratch cleanup. The transfer checks every file, mode and symbolic link against
the pre-launch whole-app digest. No build or reassembly occurs during transfer.
Only a passing acceptance row authorizes selection of its receipt. A transfer
or cleanup failure fails the row; any preserved material remains owned by its
delivery work unit.

`scripts/accepted-release.mjs` and its declaration file define the single
`mandible-accepted-release@1` receipt and resolver. The immutable receipt binds:

- `acceptance`: unique owned-run ID and the daemon's acceptance row/request IDs
  when supplied by the authority;
- `candidate`: exact `pin_sha`, `tree_sha`, `base_sha` and `head_sha`;
- `target` and `shipped`: the finalized installed-release manifest;
- `package`: `owned-run` custody handle, `Mandible.app` relative path and whole
  app SHA-256;
- `retention`: canonical project, delivery work-unit owner and disposal policy;
- `evidence`: immutable bounded acceptance evidence file and its SHA-256.

The result's existing string `receipt` field carries
`accepted-release:<receipt-sha256>:<base64url-absolute-receipt-path>` (at most
512 characters). It survives the legacy authority's 64 KiB result compaction.
`resolveAcceptedRelease(reference, expectedCandidate)` verifies that exact
receipt, evidence, custody identity, whole app and shipped inventory/provenance;
it returns `{receipt, app, resources}` or refuses. It never selects a newer run
or rebuilds bytes.

The daemon binds a passing acceptance automatically as one `checkpoint_add`
action with `kind: accepted-release`, targeted at the request-bound delivery
work unit's canonical issue. The verdict, selection, and system `revised`
lifecycle event commit atomically before readiness is broadcast. The selection
is covered by the ordinary approval signature. Approval checks the exact
candidate, receipt and evidence without hashing the app in the daemon; frozen
execution verifies and installs the selected bytes without rebuilding.
Retries replace an untouched system-derived selection in place. A veto, manual
edit, or deletion is preserved and requires explicit reconciliation. Stale
request, candidate, lifecycle, or custody changes fail finalization.

For the first upgrade from a legacy authority only, a prearmed custodian uses
`scripts/stage-accepted-release.mjs` after acceptance passes, with the normal
credential, lifecycle revision and custody-generation checks. That old daemon
cannot bind atomically, and supplies null acceptance row/request IDs to the
harness. The helper binds its exact external row and `result.receipt` before
approval. Once upgraded, subsequent deliveries use automatic binding.

Retention is one app per passing acceptance, owned by the delivery work unit.
These directories are durable release material, not cache entries. Generic
owned-run cleanup refuses their unresolved interactive outputs. After delivery
or abandonment the owner calls `disposeAcceptedRelease(reference, candidate,
reason)`, which explicitly finalizes the retained run with a discard disposition
and uses ordinary owned-run cleanup. Pending approval never
expires retained bytes. Acceptance evidence and compact cleanup receipts remain
available after package disposal. The immutable accepted-release receipt also
remains in `<authority-home>/accepted-releases/.receipts/<run-id>-accepted-release.json`,
outside the package cleanup root; its original reference and hash do not change.

The command reports missing platform or candidate prerequisites as `unavailable`, and execution, interaction, log or cleanup failures as `failed`; the daemon records either as a failed run with the reason. Only `passed` exits successfully. An incomplete health observation never passes
this finite gate. Event-loop stalls, lag warnings, memory warnings, concrete
errors and non-HTTP event storms retain their acceptance policy. Aggregate HTTP
method/route volume is diagnostic: bounded counts, peaks and statuses remain in
the evidence without treating independent healthy clients as a feedback loop. A failed assessment never authorizes rerunning a protected merge.

## Bounded verification

Final verification budgets are source checks at most 10 seconds, the separate
native fixture at most 20 seconds, and automatic package/runtime acceptance at
most 60 seconds including a 5-second cleanup and receipt reserve. Their aggregate
budget is at most 90 seconds, with a roughly 60-second target. These are limits,
not measured timings or a claim that qualification has run.

The executor establishes one absolute 60-second deadline before checkout,
runtime resolution, and frozen dependency preparation. It passes that deadline
to the candidate's own script. Retained-package binding and acceptance-row
finalization after the script share that deadline; a binding overrun rolls back
the passing verdict and selection. Every nested command consumes the remaining
budget; the script stops active work before the cleanup reserve. A legacy
installed executor cannot retroactively bound preparation before it starts the
candidate script or binding after it exits: that first result explicitly
identifies its cap as candidate-script scope. Report the actual acceptance row's start-to-finish time
separately from the script elapsed time. A deadline, stale health reading,
incomplete required data, failed request, or incomplete cleanup fails the gate.

Retaining the finished package and finalizing and reclaiming its scratch run
execute in a supervised subprocess of the same candidate script, using the
existing owned-run and accepted-release helpers. The original deadline includes
copying, hashing, consumer inspection, descendants, and receipt writing. A
bounded evidence file is retained before that work starts; interruption leaves
owned material for inspection and fails acceptance. Nested supervisors allow
the inner TERM/KILL/join to finish before an outer process can be killed.

Acceptance builds and signs the application once through `tauri:build` and the
installed-release assembler. It verifies complete shipped inventory and source
provenance, then starts the isolated bundled runtime with checkout resources
denied. After exact instance/generation readiness, it exercises actual packaged
Settings persistence while observing the same production health collectors.
The source-preview route-performance benchmark is outside this transaction.
No incomplete benchmark is relabeled as passed, and standalone sweeps retain
all existing request, completeness, first/warm, and deadline behavior.

Starting at readiness, the observer reads current
production event-loop and memory diagnostics without resetting the collectors,
advancing completed sequence numbers, changing warning state, or logging on
GET. The health response also retains the last completed periodic window.
Checks enforce continuous coverage across a periodic reset, stable startup
epoch and exact generation, lag/stall classification, and current memory
thresholds. Settings completion wakes the abortable poll; one fresh request
begun after that actual completion lets the existing collector run for a turn before the final
read. The owned Settings report supplies its actual completion timestamp, and window
liveness and epoch remain checked through final coverage. The original active deadline still applies.

This proves contemporaneous workload responsiveness and current memory. A run
finishing before the first reporting tick does not exercise that periodic
callback; results record how many periodic windows actually completed during
observation. The collector contract regression separately checks that live
reads preserve completed evidence, periodic reset, and warning behavior.
Phase results, bounded stderr, cleanup outcome and the durable owned-run receipt remain
available on failure. The finished application that ran supplies exact package
evidence and retained release custody.

## Diagnostic replay

For an authorized investigation, the same packaged execution pipeline can reuse
an existing finalized app from a failed run:

```sh
bun scripts/candidate-acceptance.mjs --project <project> --work-unit <unit> \
  --diagnostic-receipt <failed-owned-run-receipt.json> --diagnostic-app <Mandible.app>
```

This verifies the failed run's package digest, candidate and shipped inventory,
then skips all builds. The unchanged GUI/setup/health checks
run with Bun CPU profiling and the private-socket stall probe/native sampler.
The same total 60-second deadline and cleanup reserve apply to the diagnostic runtime. Output always has schema
`mandible-candidate-diagnostic@1`, status `diagnostic`, and `qualifying: false`;
it exits nonzero and cannot supply passing candidate acceptance or an accepted
release. `observation_status` records the underlying check verdict.

Profiles, probe records and full fixture logs transfer to an evidence owned run
under `acceptance/diagnostics/<run-id>` before scratch is reclaimed. The owning
work unit retains this interactive evidence until it is registered as an
artifact or explicitly discarded with ordinary owned-run finalization/cleanup.
The original failed acceptance row and receipt remain unchanged.

Co-Authored-By: Codex (GPT-5) <codex@openai.com>
Co-Authored-By: Codex (GPT) <codex@openai.com>
