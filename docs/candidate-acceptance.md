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

The separate route-cost sweep measures handlers against a copied snapshot of the
live ledger. The packaged runtime phase uses a fresh isolated home and fixture
ledger. This gate therefore includes production-data coverage through the sweep,
while keeping packaged runtime state isolated.

The command builds the finalized application through the installed-release assembler, verifies its signature, resource inventory and candidate provenance, then starts the application's shipped Bun/daemon and Caddy directly. It does not register or upgrade SMAppService jobs. Daemon, gateway and GUI run with the checkout, dotfiles, Homebrew and developer runtime stores denied, and the application read-only. It verifies the exact instance, generation, startup commit and epoch. It creates an operator fixture through that daemon's private socket. The packaged webview uses an isolated, nonpersistent browser store, opens Settings, changes the app theme, and checks the persisted preference revision. The window remains open through a full event-loop diagnostics interval. Daemon and native logs are assessed after owned processes stop, including shutdown.

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

## Diagnostic replay

For an authorized investigation, the same packaged execution pipeline can reuse
an existing finalized app from a failed run:

```sh
bun scripts/candidate-acceptance.mjs --project <project> --work-unit <unit> \
  --diagnostic-receipt <failed-owned-run-receipt.json> --diagnostic-app <Mandible.app>
```

This verifies the failed run's package digest, candidate and shipped inventory,
then skips all builds and the route sweep. The unchanged GUI/setup/health checks
run with Bun CPU profiling and the private-socket stall probe/native sampler.
The runtime has a 90-second deadline. Output always has schema
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
