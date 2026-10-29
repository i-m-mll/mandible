# Approved runtime updates

Mandible updates the installed application from the exact retained package selected
by an approved publication. Initial delivery and continuation use the same
reconciler in scripts/runtime-handoff.mjs. A journal records the approved target,
one current attempt, its observed effects, its completion receipt, and cleanup.

## Publication and executable authority

Initial publication verifies the approved Git candidate, signature, approval
snapshot, hook identity, and selected accepted release against the checkout.
The installed daemon runs the registered hook command in the request checkout.
The built-in command, `bash cli/post-merge-build-dist.sh`, resolves that newly
merged checkout and invokes its `scripts/runtime-handoff.mjs arm` entry point.
The new admission producer therefore runs before app replacement; the old
installed daemon supplies only the predecessor drain reader. Hook environment
allowlisting prevents an inherited installed resource or CLI path from selecting
an older producer.
freezeRuntimeHandoffPublication appends a versioned credential-signature record
to the existing attribution evidence store. The immutable journal binding records
its evidence ID and digest before the helper can drain the running daemon.
Freezing evidence does not change the request's execution pointer or hook outcome.

Continuing authority resolves that exact stored publication evidence and checks
its request, hook, candidate, snapshot, selected package, and currently authorized
signer. The historical checkout root is data. Moving, modifying, or removing the
checkout does not revoke an already approved update. Continuing verification does
not invoke Git or execute code from that checkout. Publication adoption attaches
the same verified evidence through the request's existing compare-and-set path.

Executable authority is checked separately. The trusted accepted-release resolver
validates retained package custody, its complete app digest, and its manifest
before the helper executes the package's updater closure. The retained package
supplies the helper, controller, publication verifier, runtime, and desktop
relaunch script. The handoff directory holds journal and diagnostic evidence;
it does not receive executable copies from a mutable checkout. Update execution
never rebuilds the application or reinstalls dependencies.

## Attempts and effects

Fresh update admission requires the currently owned native application. Existing
source-bootstrap records remain readable, but new updates do not replace a source
runner or create a legacy bridge. Initial preparation, immutable publication
material, the armed journal, and its active-owner pointer are produced under the
same installation gateway and journal observation ownership as the worker.

Native admission completes its no-op bridge prerequisite before the helper can
start. Helper registration and kickstart are serialized with closure, then the
producer releases both leases and waits read-only. Replaying an interruption
before bootstrap retains the same admitted attempt and deadline. A missing active
pointer is recreated only for an unfinished initial publication; terminal,
fenced, retired, or superseded admissions cannot recreate it or launch a helper.

The immutable binding identifies the approved target. journal.attempt identifies
the current execution, actor, deadline, effect records, outcome, receipt, and
mutation fence. The phase field projects current compatibility state for older
predecessors; failure, recovery, and archived attempt records preserve history.
Those records do not decide the current attempt's behavior. An attributed retry archives
the preceding failed attempt before creating its successor.

Each effect records intent before execution and completion after observation:

1. Prepare and validate the exact app at a staging path on the installation
   volume while the existing app still serves.
2. Wait for the captured daemon's drain, unregister the qualified native service
   definitions, and confirm their captured process incarnations have exited.
3. Replace or adopt the exact prepared app under the existing bundle-owner
   compare-and-set contract.
4. Reconcile native registration and start permission with qualified running
   services. A registration response alone does not establish readiness.
5. Restore the desktop if it was open, retaining the actual issued intent and
   confirmed installed-image process identity.
6. Observe actual runtime access, service continuity, logs, and health through
   activation, then persist the current attempt's completion receipt.

Continuation observes the app and processes that actually exist. An installed
accepted app is adopted without repeating its replacement. A completed drain is
reused only while its captured process identities remain gone. A desktop launch
that completed before interruption is recognized from its installed image and
process identity. The reconciler does not roll back migrated data automatically.

## Native ownership and availability

All paths use the same qualified service observations: expected bundle identity,
owned launchd descriptor, final executable role, PID, process birth, and run count.
The original installed-release@1 gateway used a Bun parent; its recognized manifest
contract remains available for migration. New manifests declare backend Bun and
gateway Caddy. The gateway execs its bundled Caddy executable so launchd supervises
the actual listener. An unqualified xpcproxy, helper, or intermediate Bun process
remains pending rather than becoming a ready service identity.

Native unregister uses qualified observations until both registration and the
captured processes have drained. Migration also captures and drains the original
Bun gateway's exact Caddy child. It never falls through to a raw launchd parser
that interprets a BundleProgram job as an ordinary Program job.

The accepted updater calls the local-runtime operations directly with one explicit
installation context and its live mutation assertion. Shared registration and
gateway configuration finish before both native roles are registered. Actual
process qualification captures PID, birth, executable, and launch count; readiness
polls then read the registered generation and the HTTPS front door's exact
installation, generation, database, and startup epoch. Detailed service and stderr
ownership are inspected at the observation boundaries, rather than on every health
poll. CLI environment setup belongs to the CLI entrypoint.

`release.json.serviceControlProtocol` identifies the native helper interface.
Missing means the installed v1 one-role protocol. V2 accepts both roles in one
invocation and completes unregister only after every native completion handler has
answered, when re-registration is safe. V1 predecessors receive their supported
one-role calls, followed by confirmation that captured jobs and processes have
drained before exchange. A v2 error never selects the v1 path. The prior helper
stops its registered app; the verified new installed helper starts the replacement.

The isolated native replacement fixture takes explicit
`MANDIBLE_NATIVE_PROOF_PREDECESSOR_APP` and `MANDIBLE_NATIVE_PROOF_APP` inputs. It
copies the v1 and candidate v2 helpers into uniquely identified private bundles and
re-signs those copies for the fixture descriptors. It proves native replacement,
process continuity, registration completion and retained-package cleanup. Its
small backend and desktop substitutes do not prove product GUI or publication
behavior; those require the candidate and normal update qualification.

All generated Caddy configurations share a one-second HTTP shutdown grace,
including production, preview hosts, candidate acceptance, and temporary CA setup.
On SIGTERM, Caddy stops accepting connections, closes idle connections, allows
finite responses to finish during that second, then closes remaining streams and
cleans up its storage and modules. Event streams reconnect after the update;
connection lifetime does not represent durable application work. Backend
transactions and jobs retain their own drain contract; native service
unregistration still waits for captured processes to exit. The HTTP grace also
applies when a configuration reload removes an HTTP server.

A historical terminal update does not prevent ordinary use of its authorized
installed runtime. Service startup uses the current attempt's service intent and
ready observation rather than an old failed phase or lifetime exit status.

## Ownership, receipts, and cleanup

The existing installation gateway lease is acquired before the journal observation
lease. Nested lifecycle assertions retain ancestor ownership: losing the gateway
kernel guard stops effects even if the observation guard remains alive. Controller
children receive the same validated gateway delegation. Live or uncertain owners
block a contender. Only exactly proven stale owners are recovered.

Every journal writer requires both live leases scoped to that exact journal;
absence of an observation scope is an error. The worker waits for a short producer
lease outside either lock and rereads the journal after acquisition. Full journal
state comparisons remain strict within that ownership epoch.

Acknowledgment is published only after the worker verifies current authority,
validates the accepted package and prepared app, and records drain intent. Drain
permission binds the running, unfenced, prepared admission to the exact live
observation owner and its gateway guard, together with the captured predecessor
PID and birth. A different observer epoch or an exited helper cannot reuse it.
No gateway delegation token is persisted. Failure and closure clear readiness and
publish a non-armed phase before releasing ownership, also protecting the current
predecessor whose reader understands only the older phase/acknowledgment fields.

The reconciler covers actual activation and desktop restoration with live health
observations. A fresh current collector turn must cover completion. This does not
wait for an arbitrary 31-second window or an aligned periodic diagnostic interval.
Process continuity, retained startup-log coverage, health findings, and the existing
100 ms handler and 250 ms event-loop budgets remain intact.

A mandible-runtime-receipt@1 receipt binds the approved target and current attempt
to installation, services, desktop, access, health, and log evidence. The daemon
verifies it once in its guarded operation, adopts publication evidence as needed,
and commits the exact receipt acceptance marker. Acknowledgment consumes an
opaque one-use verification result bound to that same observation owner and
receipt digest. It does not repeat package or health verification.

Acknowledgment unregisters the exact helper, confirms its captured process has
drained, persists its mutation fence, and releases only its exact active owner.
A retry after committed receipt acceptance uses the exact durable marker and digest
without repeating publication adoption or runtime probes. A foreign active owner
never grants mutation authority over this journal.

Cleanup has its own pending or complete state. It validates only the obsolete
objects it deletes, including previous app bytes and retained package ownership.
Cleanup failure preserves runtime success and can be retried after ownership has
been released. A successor can close an old mutator under the same ordered leases
by fencing its exact helper and preserving its historical outcome; an old failed
phase or a missing PID alone is not permission to release ownership.

## Verification

Focused source tests cover interruption and continuation, preparation failure,
receipt consumption and cleanup retry, native executable qualification, current
health coverage, process continuity, and ancestor lease loss:

The admission regression runs the actual producer and worker in separate Bun
processes against real journals and lifecycle locks. Explicit barriers cover
publication before bootstrap, replay of the same attempt, consumer preparation,
the read-only producer wait, live drain permission, failure and owner loss, and
fenced replay. Only package, native registration, authority, and health effects
are substituted; no separate lifecycle algorithm or full bootstrap is recreated.

```bash
bun run test test/runtime-handoff-admission.test.ts test/runtime-handoff.test.ts test/service-definition-handoff.test.ts test/bundle-service-start.test.ts test/lifecycle-lock.test.ts test/runtime-handoff-readiness.test.ts
```

The bounded macOS native fixture reuses executables from the candidate app already
built for ordinary [candidate acceptance](candidate-acceptance.md):

```bash
MANDIBLE_NATIVE_PROOF_APP='/absolute/path/to/candidate/Mandible.app' bun run test:provisioned test/provisioned/accepted-app-install.test.ts
```

It assembles two small signed private descriptors with unique service identities,
uses the production reconciler and its prepare/install/drain/start effects, and
continues one interruption after B is installed but before services launch. It
performs no additional Cargo or Tauri build. Its original 20-second command budget
includes runner startup and owned teardown; the launcher supplies the deadline.

Fixture authority and access adapters cover its private heartbeat and Caddy admin
endpoint. They do not certify product approval or the full product daemon. The
fixture also does not physically kill and relaunch the independent production
helper. Real signed publication evidence has separate source coverage, including
an unavailable checkout. Exact product package/runtime acceptance remains the
normal gate; the actual production transition is reported after human approval.

Co-Authored-By: Codex (GPT) <codex@openai.com>
## Failed delivery retirement

A failed builtin update that never acquired a publication intent or handoff
journal can be explicitly retired by its current delivery custodian or the
operator using recovery authority:

```bash
mandible auth retire-delivery <request> --reason <text> \
  --expected-revision <n> --expected-custody-generation <n> [--operator-recovery]
```

The request must record a successful finalized merge and an unchanged approved
acceptance selection. Every recorded attempt must be a settled nonzero failure;
timeout, interruption, missing settlement evidence, an admitted publication,
handoff/preparation material, live consumers or producers, installed ownership,
another live selection, and explicit investigations refuse the operation. An
exactly empty canonical pre-admission directory carries no payload reference.

Retirement preserves exit status, output and attempt history, keeps convergence
failed and issue closures withheld, and prevents retry or subsequent publication.
One audited lifecycle revision records the execution, command digest, accepted
reference, reason, actor and custody. The same guarded transaction releases only
that hook's operational reference and claims disposable custody. Recursive
cleanup runs through ordinary supervised storage maintenance after the commit.

The CLI reports retirement separately from pending or completed cleanup. A
replay with fresh lifecycle and custody preconditions resumes cleanup without
another retirement event; external cleanup receipts recover interruptions even
after root metadata disappeared. Immutable acceptance evidence remains readable.
Code delivery alone does not establish disposal: verify the supported operation
and actual cleanup before closing a retirement issue.
