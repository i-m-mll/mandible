# Approved runtime updates

Mandible updates the installed application from the exact retained package selected by an approved publication. Initial delivery and continuation use the same reconciler in scripts/runtime-handoff.mjs. A journal records the approved target, one current attempt, its observed effects, its completion receipt, and cleanup.

## Publication and executable authority

Initial publication verifies the approved Git candidate, signature, approval snapshot, hook identity, and selected accepted release against the checkout. The signature is the approval key's signature on the merge commit, made in the Secure Enclave after one Touch ID match ([approvals](approvals.md)). It shows that a matching finger touched, not what the operator believed they approved, and it does not stop a same-user process that bypasses Mandible; it does make any publication without it detectable. The installed daemon runs the registered hook command in the request checkout. The built-in command, `bash cli/post-merge-build-dist.sh`, resolves that newly merged checkout and invokes its `scripts/runtime-handoff.mjs arm` entry point. The new admission producer therefore runs before app replacement; the old installed daemon supplies only the predecessor drain reader. Hook environment allowlisting prevents an inherited installed resource or CLI path from selecting an older producer. freezeRuntimeHandoffPublication appends a versioned credential-signature record to the existing attribution evidence store. The immutable journal binding records its evidence ID and digest before the helper can drain the running daemon. Freezing evidence does not change the request's execution pointer or hook outcome.

Continuing authority resolves that exact stored publication evidence and checks its request, hook, candidate, snapshot, selected package, and currently authorized signer. The historical checkout root is data. Moving, modifying, or removing the checkout does not revoke an already approved update. Continuing verification does not invoke Git or execute code from that checkout. Publication adoption attaches the same verified evidence through the request's existing compare-and-set path.

Executable authority is checked separately. The trusted accepted-release resolver validates retained package custody, its complete app digest, and its manifest before the helper executes the package's updater closure. The retained package supplies the helper, controller, publication verifier, runtime, and desktop relaunch script. The handoff directory holds journal and diagnostic evidence; it does not receive executable copies from a mutable checkout. Update execution never rebuilds the application or reinstalls dependencies.

## Attempts and effects

Fresh update admission requires the currently owned native application. Existing source-bootstrap records remain readable, but new updates do not replace a source runner or create a legacy bridge. Initial preparation, immutable publication material, the armed journal, and its active-owner pointer are produced under the same installation gateway and journal observation ownership as the worker.

Native admission completes its no-op bridge prerequisite before the helper can start. Helper registration and kickstart are serialized with closure, then the producer releases ownership and waits read-only. Replaying an interruption before bootstrap retains the same admitted attempt and deadline. A missing active pointer is recreated only for an unfinished initial publication; terminal, fenced, retired, or superseded admissions cannot recreate it or launch a helper.

The immutable binding identifies the approved target. journal.attempt identifies the current execution, actor, deadline, effect records, outcome, receipt, and mutation fence. The phase field projects current compatibility state for older predecessors; failure, recovery, and archived attempt records preserve history. Those records do not decide the current attempt's behavior. An attributed retry archives the preceding failed attempt before creating its successor.

Each effect records intent before execution and completion after observation:

1. Clone and verify the exact app at a staging path on the installation volume while the existing app still serves. Validate the generated gateway configuration with the staged Caddy binary. Launch the staged daemon's preflight against the existing ledger in read-only mode to check schema compatibility, without starting a listener or running migrations.
2. Wait for the captured daemon's drain, unregister the qualified native service definitions, and confirm their captured process incarnations have exited.
3. Replace or adopt the exact prepared app under the existing bundle-owner compare-and-set contract.
4. Reconcile native registration and start permission with qualified running services. A registration response alone does not establish readiness.
5. Restore the desktop if it was open, retaining the actual issued intent and confirmed installed-image process identity.
6. Confirm runtime readiness, service identities, and the daemon's log-file identity, then persist the current attempt's completion receipt.

Continuation observes the app and processes that actually exist. An installed accepted app is adopted without repeating its replacement. A completed drain is reused only while its captured process identities remain gone. A desktop launch that completed before interruption is recognized from its installed image and process identity. The reconciler does not roll back migrated data automatically.

## Time during go-live

A clock decides when the updater looks again; it never decides an outcome. A step ends in one of three ways: done, when its effect is observed; failed, when the thing itself reported failure (a nonzero exit with its diagnostic, a digest mismatch, an identity conflict, a service that exited); or pending, when a command or probe did not answer in time. Every external command on the go-live path runs through `runRuntimeCommand` in `scripts/runtime-observation.mjs`. Its timeout is what remains of the current budget, a command that times out or is killed is pending, and its exit status goes back to the caller to judge. No call site sets its own timeout.

An attempt has two budgets:

- Before the captured daemon has drained, the budget is the attempt deadline. For an admitted attempt it is the journal deadline: 30 minutes from admission, or earlier if the daemon would kill the hook that waits for admission sooner. The daemon kills a hook `authHookTimeoutMs` after its recorded `started_at`; the predecessor's own value is the one that applies. Copy and hash get all of the remaining budget. When it runs out, the attempt fails with the old version still serving, and drain is never issued after it.
- Once drain has been issued and the captured daemon is observed gone (`effects.drain.exitedAt`), the attempt is committed. The first helper run observes it for `COMMITTED_OBSERVATION_WINDOW_MS` (one minute), and each consecutive pending run doubles the window, up to `COMMITTED_OBSERVATION_CAP_MS` (16 minutes), so a step that must restart from scratch, such as rehashing the installed app under load, eventually fits. A pending outcome leaves the attempt running and the helper exits 75, so launchd runs it again; each run continues from observed effects until the receipt is written. Only a failed outcome ends a committed attempt.

The attempt commits when the daemon exits rather than when drain permission is published. Until it exits the old version still serves, and the daemon checks the permission again just before it exits, so failing the attempt stops it. A helper started again while the daemon drains would publish a new permission, which the daemon refuses as a change of ownership; the wait for the exit therefore stays inside one helper run, under the pre-drain budget.

Commitment is an observation, not a flag set on one path. The daemon may exit on the permission it read just before the helper failed, so the helper looks again where it classifies the outcome, and an attempt that still fails after drain was issued, with its exit unrecorded, makes the helper exit 75 once. On that run, if the daemon is gone the same attempt resumes as committed; if it is still serving, the attempt records `effects.drain.servingAt` and stays failed.

The down window holds only renames, registration and readiness. Preparation runs Caddy and the daemon from the staged package while the old version serves. It records the gateway configuration digest as `effects.prepare.gatewayConfig`, and the daemon's schema verdict and timing in the same effect. After drain the gateway configuration is validated again if the generated bytes differ. A command that does not answer within the observation budget yields a pending observation.

Admission follows the same rule: `arm` retries a pending admission step while the journal deadline allows.

## Native ownership and availability

All paths use the same qualified service observations: expected bundle identity, owned launchd descriptor, final executable role, PID, process birth, and run count. The original installed-release@1 gateway used a Bun parent; its recognized manifest contract remains available for migration. New manifests declare backend Bun and gateway Caddy. The gateway execs its bundled Caddy executable so launchd supervises the actual listener. An unqualified xpcproxy, helper, or intermediate Bun process remains pending rather than becoming a ready service identity.

Native unregister uses qualified observations until both registration and the captured processes have drained. Migration also captures and drains the original Bun gateway's exact Caddy child. It never falls through to a raw launchd parser that interprets a BundleProgram job as an ordinary Program job.

The accepted updater calls the local-runtime operations directly with one explicit installation context and its live mutation assertion. Shared registration and gateway configuration finish before both native roles are registered. Actual process qualification captures PID, birth, executable, and launch count; readiness polls then read the registered generation and the HTTPS front door's exact installation, generation, database, and startup epoch. Detailed service and stderr ownership are inspected at the observation boundaries, rather than on every health poll. CLI environment setup belongs to the CLI entrypoint.

`release.json.serviceControlProtocol` identifies the native helper interface. Missing means the installed v1 one-role protocol. V2 accepts both roles in one invocation and completes unregister only after every native completion handler has answered, when re-registration is safe. V1 predecessors receive their supported one-role calls, followed by confirmation that captured jobs and processes have drained before exchange. A v2 error never selects the v1 path. The prior helper stops its registered app; the verified new installed helper starts the replacement.

The isolated native replacement fixture takes explicit `MANDIBLE_NATIVE_PROOF_PREDECESSOR_APP` and `MANDIBLE_NATIVE_PROOF_APP` inputs. It copies the predecessor's helper, at the service protocol its `release.json` declares, and the candidate's v2 helper into uniquely identified private bundles and re-signs those copies for the fixture descriptors. It proves native replacement, process continuity, registration completion and retained-package cleanup. Its small backend and desktop substitutes do not prove product GUI or publication behavior; those require the candidate and normal update qualification.

All generated Caddy configurations share a one-second HTTP shutdown grace, including production, preview hosts, candidate acceptance, and temporary CA setup. On SIGTERM, Caddy stops accepting connections, closes idle connections, allows finite responses to finish during that second, then closes remaining streams and cleans up its storage and modules. Event streams reconnect after the update; connection lifetime does not represent durable application work. Backend transactions and jobs retain their own drain contract; native service unregistration still waits for captured processes to exit. The HTTP grace also applies when a configuration reload removes an HTTP server.

A historical terminal update does not prevent ordinary use of its authorized installed runtime. Service startup uses the current attempt's service intent and ready observation rather than an old failed phase or lifetime exit status.

## Ownership, receipts, and cleanup

Every journal writer requires the live installation gateway lease and an observation scope bound to that exact journal. The scope derives its authority from the installation lease; losing that lease stops effects and writes. Live or uncertain owners block a contender, and only proven stale owners are recovered. For a live protocol-v1 predecessor, the worker also acquires the predecessor's real observation lock inside the installation lease through preparation and drain. Protocol-v2 predecessors need no separate observation lock. Full journal state comparisons remain strict within the ownership epoch.

Acknowledgment is published only after the worker verifies current authority, validates the accepted package and prepared app, and records drain intent. Drain permission binds the running, unfenced, prepared admission to the exact live observation owner and its gateway guard, together with the captured predecessor PID and birth. A different observer epoch or an exited helper cannot reuse it. No gateway delegation token is persisted. Failure and closure clear readiness and publish a non-armed phase before releasing ownership, also protecting the current predecessor whose reader understands only the older phase/acknowledgment fields.

The reconciler confirms activation and desktop restoration, qualified service process identities, the daemon's stderr file identity, and front-door readiness for the intended installation, generation, database, and startup epoch. It does not assess the log contents or enforce the event-loop and handler budgets during the installed transition; those checks in package/runtime acceptance cover the isolated candidate run. Logs and performance monitoring remain available for diagnosis rather than determining installation success.

A `mandible-runtime-receipt@2` receipt binds the approved target and current attempt to the installed app, services, desktop intent, startup identity, and daemon log-file identity. Adoption verifies the terminal fence, attempt, binding, receipt digest, approved package and installed identity, with bounded process and readiness probes. The daemon commits an acceptance marker; acknowledgment uses the matching verified result or accepted receipt digest. Legacy v1 receipt verification additionally binds its one-use result to the observation owner.

The verified package's root identity, manifest digest and package digest are published in the bundle owner's verification receipt before service registration. The foreground launcher checks the root and manifest against that receipt at each boot. Full package inventory verification belongs to candidate acceptance, installation and handoff preparation. Daemon boot traces report phase times from process start on stderr and share a startup epoch with health.

The installation-wide handoff lock is derived from the journal, not from the existence of `handoff-active.json`. That file names the latest admitted journal, and the lock is held exactly while that journal still holds mutation authority: no attempt or mutation fence closed it, and it was neither acknowledged nor retired. A completed delivery writes its receipt and its terminal fence in one journal write, so it releases the lock at that moment; deleting the file later (during acknowledgment, cleanup or successor closure) is tidying that no decision depends on, and it never touches a file that names a successor. A failed or verification-pending attempt stays unfenced and keeps the lock until verification-only recovery fences it or the operator retires it. Every reader, including the lifecycle commands in `local-runtime.mjs`, goes through `readRuntimeHandoffLock`.

Legacy acknowledgment unregisters the exact helper, confirms its captured process has drained, and persists its mutation fence, which releases the lock. A retry after committed receipt acceptance uses the exact durable marker and digest without repeating publication adoption or runtime probes. A foreign active owner never grants mutation authority over this journal.

Cleanup has its own pending or complete state, and its failure never changes runtime success. It validates only the obsolete objects it deletes. It consists of independent obligations, and every attempt tries each of them: fence the exact helper, remove the previous app copy, dispose of the superseded accepted release, and remove a legacy bridge. Each blocked obligation records its own blocker in the journal. When the blocker is a set of running processes, the record lists them with the parent that started them, which is what the user has to quit or restart. `mandible auth handoff status` and the daemon's stuck-cleanup incident show that text.

A journal keeps an accepted release from disposal only while it still needs it. It needs its predecessor's release while it holds mutation authority. It needs its own release, which holds the helper that drives it, until that helper is fenced (`helperFencedAt`). The cleanups of successive updates therefore never wait on one another.

The daemon starts cleanup children one at a time. A blocked cleanup runs again only when its wake key changes: the key is the recorded blockers, with only the blocking processes that are still alive. A cleanup also runs again when another handoff's cleanup or outcome changes, when the daemon starts, or when someone asks for verification-only recovery. No timer retries it, so a cleanup waiting on a process never takes the installation gateway lock while it waits.

A successor can close an old mutator under the same ordered leases by fencing its exact helper and preserving its historical outcome; an old failed phase or a missing PID alone is not permission to release ownership.

## Verification

Focused source tests cover interruption and continuation, preparation failure, receipt consumption and cleanup retry, native executable qualification, current health coverage, process continuity, and ancestor lease loss:

The admission regression runs the actual producer and worker in separate Bun processes against real journals and lifecycle locks. Explicit barriers cover publication before bootstrap, replay of the same attempt, consumer preparation, the read-only producer wait, live drain permission, failure and owner loss, and fenced replay. Only package, native registration, authority, and health effects are substituted; no separate lifecycle algorithm or full bootstrap is recreated.

```bash
bun run test test/runtime-go-live-time.test.ts test/runtime-handoff-admission.test.ts test/runtime-handoff.test.ts test/service-definition-handoff.test.ts test/bundle-service-start.test.ts test/lifecycle-lock.test.ts test/runtime-handoff-readiness.test.ts
```

The bounded macOS native fixture requires a clean, committed source checkout and a configured native app signing identity. It reuses executables from the candidate app already built for ordinary [candidate acceptance](candidate-acceptance.md) and an explicitly retained predecessor app, normally the accepted release of the installed version. The fixture stages the predecessor at the service protocol its `release.json` declares and records that protocol in its evidence:

```bash
MANDIBLE_NATIVE_PROOF_APP='/absolute/path/to/candidate/Mandible.app' \
MANDIBLE_NATIVE_PROOF_PREDECESSOR_APP='/absolute/path/to/predecessor/Mandible.app' \
  bun run test:provisioned test/provisioned/accepted-app-install.test.ts
```

It assembles two small signed private descriptors with unique service identities, uses the production reconciler and its prepare/install/drain/start effects, and continues one interruption after B is installed but before services launch. B's gateway configuration is validated before drain with the candidate's Caddy, through the same runner and budget as the product. It performs no additional Cargo or Tauri build. Its original 20-second command budget includes runner startup and owned teardown; the launcher supplies the deadline. The launcher also runs it a second time as the `slow gateway` unit, whose Caddy answers only after 6 seconds; that delay is what the unit verifies, so its budget is 26 seconds, outside the ordinary proof's allocation.

Fixture authority and access adapters cover its private heartbeat and Caddy admin endpoint. They do not certify product approval or the full product daemon. The fixture also does not physically kill and relaunch the independent production helper. Real signed publication evidence has separate source coverage, including an unavailable checkout. Exact product package/runtime acceptance remains the normal gate; the actual production transition is reported after human approval.

## Failed delivery retirement

A failed builtin update that never acquired a publication intent or handoff journal can be explicitly retired by its current delivery custodian or by the user:

```bash
mandible auth retire-delivery <request> --reason <text> \
  --expected-revision <n> --expected-custody-generation <n>
```

The request must record a successful finalized merge and an unchanged approved acceptance selection. Every recorded attempt must be a settled nonzero failure; timeout, interruption, missing settlement evidence, an admitted publication, handoff/preparation material, live consumers or producers, installed ownership, or another live selection refuse the operation. An exactly empty canonical pre-admission directory carries no payload reference.

Once an exact handoff retirement is archived, the daemon reconciles the corresponding hook to retired. Retirement preserves exit status, output and attempt history, keeps convergence failed and issue closures withheld until a later go-live supersedes it (below), and prevents retry or subsequent publication. One audited lifecycle revision records the execution, command digest, accepted reference, reason, actor and custody. The same guarded transaction releases only that hook's operational reference and claims disposable custody. Recursive cleanup runs through ordinary supervised storage maintenance after the commit.

The CLI reports retirement separately from pending or completed cleanup. A replay with fresh lifecycle and custody preconditions resumes cleanup without another retirement event; external cleanup receipts recover interruptions even after root metadata disappeared. Immutable acceptance evidence remains readable. Code delivery alone does not establish disposal: verify the supported operation and actual cleanup before closing a retirement issue.

## Superseded go-live

A self-update whose own go-live was never confirmed — its rebuild failed, is still pending, or was retired — is live once a later self-update in the same repository goes live with a merge commit that contains its merge commit. A later go-live is one whose rebuild completed after the earlier request merged: a verified receipt for a runtime handoff, or a completed rebuild hook. The daemon records the earliest such successor against the earlier request (`auth_go_live_supersessions`, plus one lifecycle revision naming the successor). From then on the earlier request's convergence counts its rebuild as complete, and its withheld actions apply. Their outcome notes the successor. An `issue_close` whose issue is already closed applies as a no-op and keeps the existing resolution.

This happens without anyone running a command: when a successor's convergence completes, and at daemon startup for requests that still have withheld actions. `mandible auth handoff recover` and `mandible auth retry-convergence` on a superseded request report the successor and the actions it settled instead of verifying the request's own receipt, which the later install has replaced. If the running version went live without the request's merge, recovery is still refused, and the refusal names that later go-live.
