# Production runtime upgrade

The required Mandible rebuild hook uses one independent launchd worker for
every managed production self-update, including same-root updates with the
same pinned runtime. Standalone builds outside managed auth keep their existing
build guard.

Admission validates the exact hook execution and retained signed publication
proof before mutation. It stages the helper, storage facade, publication
verifier, and controller modules outside the changing checkout. The helper
acknowledges its journal before a dependency-free bridge replaces the old
managed runner. Hook status 75 means handoff pending; it never means convergence
is complete.

New developer deliveries freeze an exact passing acceptance row and immutable
package receipt through an ordinary signed checkpoint action. Acceptance binds
that action automatically before exposing readiness. See
[accepted package delivery](accepted-package-delivery.md) for the automatic path
and the first legacy upgrade's custodian bridge.
The helper waits for the exact old process and its start identity to disappear,
removes its owned legacy or native service definitions, and installs the retained
signed app without rebuilding. Native services start only after the durable
possible-launch boundary. Historical source-build journals retain their original
execution and recovery contract.

Starting the candidate services only starts them. The helper then awaits the
started daemon's readiness: it inspects the front door until it answers ready
and warm at the exact merge generation, within a bounded observation wait.
An unanswered probe, a normal starting response, or valid repeated diagnostics
without enough interval coverage leaves verification pending. These observations
retain the last actual evidence; they never fabricate a successful receipt.
A concrete startup exit, replaced process, wrong generation, invalid protocol,
malformed diagnostics, or hard log fault remains a failure even when the wait
is incomplete.
Readiness and observation inspect immediately, then pause one second after each
answered inspection. This shared cadence leaves room for ordinary clients when
each inspection probes both the backend and the front door.

Completion requires the pinned executable in loaded launchd arguments, the
exact applied merge generation through the production front door, matching
installed desktop provenance, and a full 31-second daemon health/log
observation. Each observation sample must answer from the same process and
definitions, ready at that generation, with valid diagnostics. Diagnostic
samples carry a sequence and exact interval, and consecutive samples must be
contiguous. The observer waits until a completed sample covers the end of the
31-second window, within one fixed 62-second deadline; a stale sampler cannot
pass by returning the same snapshot. The candidate hook manager verifies this
receipt and publication proof before settling convergence or releasing
deferred delivery actions.
The handoff judges convergence. The helper persists a possible-backend-launch
boundary before issuing `handoff-start`. Every later helper entry and current
verification is observation-only: it cannot unload, reinstall, rebuild or start
services again. The uninterrupted initial helper waits for backend readiness,
then may issue one owed desktop relaunch, recording its issued marker before
the action. Desktop installation records the prior process identities before
replacement. A later independent quit/reopen of the exact installed app can
satisfy desktop verification without inventing an issued or completed action.
An outstanding desktop remains pending with a quit/reopen instruction; an
observed desktop exit is a concrete failure. An originally closed app creates
no relaunch obligation. The observation covers cold-cache startup warmup.
Event-loop lag warnings, maximum event-loop delays of 250 ms or more, and
memory warnings, in samples and in the log, are recorded in the receipt's
`performance` (bounded) and never fail the handoff. Candidate acceptance, which
runs before the merge on an empty fixture database, fails on any of them.
The log assessment fails on any `error` line from the current process and on
any non-HTTP event that exceeds 100 lines in a 10-second window. HTTP method/route
volume aggregates independent callers and remains diagnostic evidence: bounded
route counts, peak windows and status distributions are retained in candidate
acceptance evidence and successful handoff receipts. Scheduled work that goes through a backlog, such as
reconciler passes, startup backfills, ingestion reconcile and full ingest,
therefore logs one summary event per pass, with counts and a bounded sample of
identifiers. The per-item record stays in its durable rows, such as
`worker_thread_archives`, source aliases, or `meta`. A pass that logged one
line per item would fail the handoff that first runs it. A refusal of a client
request (an authorization error) answers with its own status and is not logged
as a handler error.

Acknowledgment removes only this helper's scoped job and regenerated files;
the compact journal and receipt remain. Interrupted cleanup is retried without
another merge, build, or hook attempt.

The journal has schema `mandible-runtime-handoff@1` and lives at
`MANDIBLE_HOME/config/local-sessions/handoff/<request>-<execution>/journal.json`.
It binds installation, process, service definitions, runtime bytes, approved
candidate and actual merge. A conflicting owner or changed checkout fails
visibly. Initial mutation execution has six attempts and a 30-minute budget.
After the possible-launch boundary, that budget does not imply runtime failure
or approval expiry. A bounded incomplete wait records `verification-pending`
and `lastObservation`, exits normally, and keeps its installation lock, staged
actions, publication binding and logs. Failure preserves the journal and reports the failed phase as **merged, not
live**. It does not restore the old dependency graph or replay publication.

## Installation-owned services

`start`, `restart`, `install`, and `configure-launch-mode` render service definitions
from the registered checkout and installation configuration. The checkout's
`scripts/bun-runtime.sh` selects and verifies Bun using the OS account runtime
store. The invoking executable, `HOME`, `PATH`, and ambient runtime or archive
overrides do not select the production executable or service environment.
Read-only inspection never selects or installs a runtime or writes receipts.

Both jobs use a deduplicated PATH ordered as the pinned Bun directory, checkout
`bin`, native system tools, explicit installation tool directories, account-home
`.local/bin`, `.dotfiles/bin`, `.cargo/bin` and `bin`, then Homebrew and
`/usr/local` directories. Build and hook environments retain their separate PATH
policy.

`MANDIBLE_HOME/config/local-sessions/service-config.json` owns deliberate backend
overrides and tool directories. For example:

```json
{
  "environment": { "MANDIBLE_DB": "/absolute/path/mandible.db" },
  "toolDirectories": ["/absolute/path/tools"]
}
```

Allowed overrides are `MANDIBLE_DB`, `MANDIBLE_PID_FILE`,
`MANDIBLE_STDERR_LOG_PATH`, `MANDIBLE_SQLITE_LIBRARY`,
`MANDIBLE_SQLITE_LIBRARY_ARCHIVE`, `MANDIBLE_SECURITY_BIN`, and `NODE_OPTIONS`.
Paths must be absolute and literal; tool directories cannot contain empty PATH
components or shell expansions. Apply an explicit JSON file with
`bun scripts/local-runtime.mjs configure-launch-mode --service-config /absolute/config.json`
or pass `--service-config` to `install`. This replaces the configuration; omit
it to preserve existing configuration. Initial migration imports allowlisted
overrides and tool directories from the loaded backend environment. When the
backend is unloaded, lifecycle configuration may import its installed plist.
Runtime and checkout PATH entries are derived again rather than imported.
The login mode is preserved unless `--launch-mode` explicitly changes it.

One reconciler validates both services before changing them. Changed jobs are
booted out and observed until both the definition and old process disappear,
then replacement plists and runner files are published. Bootstrap is followed by
comparison of loaded arguments, environment, working directory, logs, and
KeepAlive against the installed definitions. Unchanged `start` does not restart
the backend; unchanged `restart` uses `kickstart -k` and confirms a new startup
epoch. A changed gateway definition is reloaded too. A bootstrap refusal leaves
the replacement installed and unloaded and fails the command. An unload refusal
preserves the old files and reports unresolved drift.

`stop` does not rewrite definitions and preserves the gateway while previews use
it. `reload-gateway` never republishes the backend. Lifecycle mutation refuses
while a handoff owns the installation. Candidate installation within that handoff
leaves the backend unloaded, and unloads any changed gateway before replacement;
`handoff-start` starts them. Owned drift is reconciled during this handoff and
does not require a separate repair or retry command.

The shared typed inspector is `inspectServiceDefinitions(context)` in
`scripts/service-definitions.mjs`. It asynchronously observes three separate
facts: installed plist paths, bytes and digests; loaded launchd definitions and
process identity; and optional desired definitions supplied by the controller.
Owned differences and entirely absent services are successful observations.
Differences remain observation data; they never block approval or acceptance.
`serviceOwnershipReady` is the ownership-only admission predicate;
`runtimeHandoffReadiness` also requires a running backend to drain before
approval and capture. An absent gateway is captured without prior definition
evidence and is installed and started during convergence.
`matchingServiceDefinitions` is the strict lifecycle and handoff postcondition.
The controller-only synchronous entry point uses the same classifier.

Ownership requires exact installation runner or gateway configuration paths
and recognisable executable arguments. The label or generated comment alone
proves nothing. Conflicting installation identity, foreign jobs or files, and
unavailable ownership evidence refuse mutation and identify the affected
service. Owned duplicates are consolidated at the desired location; a missing
plist can be recreated when the loaded job establishes ownership. An unloaded
owned service or an entirely absent service can be published and loaded when
the operation requires it. Unreadable launchd state remains a refusal with the
concrete reason and no repair command.

Handoff admission captures the loaded backend and gateway definitions as prior
state evidence. Installed snapshots and digests are retained separately and do
not describe the running job. Launch mode and daemon-log provenance come from
the loaded backend. The journal also binds configuration migration inputs: an
existing `service-config.json` stays authoritative; otherwise overrides and
tool directories are derived from the loaded environment. After the handoff
owns the installation, the staged controller publishes those captured inputs
before unloading. A changed configuration or loaded definition after capture
refuses mutation. Gateway reload compares loaded state with the candidate's
desired definition even when the plist on disk already contains desired bytes.
Completion still requires exact installed/loaded equality, publication proof,
process and generation identity, desktop provenance and the health/log window.
Prior-state capture does not provide rollback of binaries or dependencies.

Private fixtures pass an explicit installation context. Controllers also accept
`MANDIBLE_SERVICE_ACCOUNT_HOME` for a nondefault `MANDIBLE_HOME`, so fixture
LaunchAgent directories remain private; the default production installation
ignores that override. Fixture labels always include the installation hash.

## Handoff lock

`MANDIBLE_HOME/config/local-sessions/handoff-active.json` names the one handoff
that owns the installation. While it is held, no other handoff is admitted, and
no protected merge may execute. Merge preflight and submission may prepare
later pending requests and report the lock as their publication blocker, but
candidate runtime launches stay deferred and every approval/execution path,
including documentation-only merges, refuses. This keeps the protected branch
at the exact generation needed to recover the failed publication. Releasing
the lock schedules one missing current-candidate acceptance without repeating
an unchanged failed result. A failed or verification-pending handoff keeps
the lock until `mandible auth handoff recover <request>` (verification-only
recovery, below) succeeds or the operator retires it with
`mandible auth handoff retire --binding-digest <digest> --reason <text>`.
Retirement boots out the exact idle helper job if one is still loaded and moves
the lock beside the journal as `retired-active.json` with a `retirement.json`
record. Retirement requires an idle exact helper and idle observer, and is
terminal for reconciliation. The original journal bytes, staged material and
logs remain; retirement confirms no delivery and releases no issue closures.
If an exact observation acceptance already committed, retirement refuses and
completion/acknowledgment must finish. A persisted observation whose DB
transaction rolled back remains retireable; unreadable or inconsistent DB
acceptance refuses retirement.

A rebuild that ends without an admitted handoff, or whose handoff fails, is
reported once as `rebuild_failure` in health and as `mandible:rebuild-failed`,
with the message "The merge landed, but Mandible did not update: <reason>." A
rebuild hook that exited 75 belongs to its handoff and is pending, never a
failure, until that handoff's journal fails.

Pending and failed current-runtime verification reuse the daemon's reconciliation
sweep. An unchanged incomplete health window retries after five minutes;
changed evidence permits an immediate retry. A cheap read-only precheck still
checks concrete defects during that backoff. Pending owners bypass settled
caches. The exact handoff's observation lease spans the health window, guarded
DB acceptance, receipt recheck, completion and acknowledgment, and excludes
retirement. Pending verification consumes no hook attempt and emits no
rebuild-failed incident.

Lifecycle ownership uses the shared macOS process-lifetime `lockf` guard also
used by secure local connection setup. The kernel guard keeps a stable inode
and spans the owned operation. Complete process identity is prepared before
the owner directory is published; release and recovery recheck its exact
generation under that guard. A crashed observer releases the kernel guard,
allowing the next observer to recover a proven stale owner. Uncertain legacy
owner records remain pending and are never stolen. Loss of the guard stops
further observation writes and acceptance effects. A verified ready response
is persisted as an established serving fact; a later concrete connection
refusal cannot be reclassified as normal startup.

## Verification

Three provisioned tests cover lifecycle reconciliation and handoff on macOS. Each derives its inputs from
the machine and throws, naming the prerequisite, when one is missing.

```bash
bun run test:provisioned test/provisioned/service-definition-reconciliation.test.ts
bun run test:provisioned test/provisioned/runtime-handoff-launchd.test.ts
bun run test:provisioned test/provisioned/runtime-handoff-full.test.ts
```

`service-definition-reconciliation` exercises real launchd capture before
repairing owned drift, loaded configuration migration, strict convergence,
gateway-only reload, foreign-job preservation and bootstrap refusal.

`runtime-handoff-launchd` arms the independent helper under launchd with a
private installation directory and unique labels, using a stub old daemon and a
stub rebuild hook. It verifies supervision, bridge ordering, helper crash
recovery and repeated admission without dependency mutation.

`runtime-handoff-full` is the one pre-merge run of the real post-merge handoff.
It archives the deployed revision named by the canonical root's
`dist/build-revision.json`, clones that root's installed dependencies, and
starts the actual old daemon on the pinned Bun in a private installation. The
candidate is `HEAD` of the checkout under test, committed on a `wt` branch of
the private canonical root. A durable private agent submits one issue-linked
request through the normal HTTP API, candidate acceptance runs, and the
private operator approves through the ordinary action-bound signing challenge.
Both private plists are drifted after acceptance and before approval; the
ordinary update must reconcile them and acknowledge its receipt.
The old protected-root executor keeps serving until the reviewed request merges
the candidate; then `cli/post-merge-build-dist.sh` hands off independently
under launchd. The test verifies the canonical independent handoff, the exact
new health generation, the loaded service definition, durable acknowledgment,
native `xattr` precedence over a poisoned PATH entry, and that a poisoned old
CLI shim is never used. Every managed self-update follows this sequence.

The operator's installation and toolchain are read, never changed: the trusted
CA snapshot under `~/.mandible` is copied into private storage with its digests
preserved, the Bun dependency cache is cloned, and the Cargo and Rustup
directories are referenced. The configured native Git hooks are copied into
the private repository. Isolation transforms only the fixture copies: the
generated frontend and backend ports, the generator's expected frontend port,
and the Caddy admin port. Unique installation-directory hashes give distinct
launchd labels, the desktop install path is private, and the OS trust store and
Keychain search list are unchanged. Teardown stops only the fixture's jobs and
deletes its data. Compact success or failure evidence goes to
`~/.cache/mandible/acceptance/upgrade-evidence`. The paired production daemon
and desktop gate still runs on the exact unmodified candidate; this fixture
does not claim identical source bytes after its port transforms.

Verification-only recovery uses the same retained hook row, publication proof,
pending or failed handoff journal, receipt verifier, and convergence settlement. It never
runs a build, installer, merge, or restart. An existing failed journal remains failed
through a 31-second observation of the exact current daemon, installation,
loaded launchd definitions, and actual stderr writer. Hook acceptance commits
before the journal becomes complete; interrupted acknowledgment can be replayed.
Concurrent observers cannot replace a receipt after its hook acceptance commits.
The original failure and hook attempt history remain available. Recovery
applies the same convergence rule as the handoff: it reads and hashes the
complete current-process log, following rotated segments as described below,
and lifetime hard failures such as crashes, error rows, restarts and non-HTTP event
storms remain fatal even when they are old. The recovery receipt records the
exact interval, initial and final samples, full log offset/digest/byte count,
and bounded performance findings.
Refused recovery observations are kept separately under the handoff's
`recovery-attempts/` directory. Each immutable record includes the actor,
failed phase, reason and bounded evidence; the newest ten are retained without
rewriting the journal or an accepted recovery receipt.

A failed convergence hook can be executed again with
`mandible auth retry-convergence <request> [--hook <id>]`. This retries the hook
without publishing the merge again. Pending means convergence has not been
confirmed; a failed or unconfirmed result is not completion. Inspect `mandible auth show
<request>` before taking another action after a connection loss.

The protected retry route accepts `mode: "verify-current"` and requires an
active durable credential with project write access and exact delivery custody
(or configured operator recovery). `mandible auth handoff recover <request>
[--operator-recovery]` calls it. Its response carries a separate typed
`verification.outcome` (`confirmed` or `pending`), reason, and retained-failure
flag alongside the actual convergence state. The CLI reports pending as
unconfirmed and retains the earlier failure reason. Public routes accept ambiguity-safe short
request references. When the deployed daemon predates this capability, the
candidate-owned `scripts/verify-current-convergence.ts` is a finite one-shot:
pass the full exact request ID and optionally `--operator-recovery`, with the
durable credential on stdin. It opens the existing database without migrations,
background sweeps, global request expiry, or merge-finalizer enqueue. Tokens
must not appear in command arguments, environment, output, or retained evidence.
Packaging uses the pinned runtime and canonical CLI, then native macOS tools,
then Cargo and inherited tools; a Homebrew `xattr` cannot replace `/usr/bin/xattr`.

### Log coverage across rotation

The daemon rotates its own stderr log once it reaches
`stderr_rotation_max_bytes` (16 MiB by default), keeping
`stderr_rotation_keep_segments` (5) older segments. Rotation copies the live
file into `<log>.1` until its size stops changing, truncates the live file in
place (the inode stays the same), and appends a `stderr_log_rotated` record to
the live file with that segment's byte count and sha256. Each file therefore
names the exact bytes of the segment before it. A byte appended between the
final size check and the truncate would be lost, so rotation's thread is the
file's only writer. The daemon's stderr writes are synchronous and run on that
thread, and Bun relays worker-thread output through it. Child processes pipe
their stderr, and the daemon logs it as `child_process_stderr` warnings with
the child's attribution, one row per pipe read of whole lines, capped at 16 Ki
characters with the omitted count recorded. A stack trace or warning dump is
therefore one or two rows; only a child that keeps writing approaches the storm
rule. `bun run check` refuses daemon code that lets a child inherit the
daemon's stderr. A rotated 16 MiB log takes about 15–50 ms of
that thread.

Observation locates the newest `server_started` line, walking back from the live
file through `.1`, `.2` and so on, and checks each segment's size and digest
against the record in the next newer file. That line must identify the current
process. Coverage runs from that line through every newer segment to the live
file's end, and the receipt records the startup offset, each segment's path,
byte count and digest, and the digest of the covered bytes. Reading, hashing
and assessment proceed in chunks that yield, so a recovery observation does not
stall the daemon it is observing. One coverage walk reads at most 128 MiB.

A live file that is truncated or shrinks during the window fails as a changed
log. The final read also re-hashes the live file's prefix as first resolved and
every covered segment, so a rotation the samples missed fails as well. Coverage
also fails when the current startup line is missing, when it names another
process, when a rotation record is missing or malformed, when a segment differs
from its record, when the startup segment has already aged out of the retained
segments, and when the walk exceeds its bound. A rotation that predates rotation
records has no verifiable link. Recovery preserves logs and does not restart a
healthy daemon to satisfy coverage. A fresh launch requires separate
authorization.

Co-Authored-By: Codex (GPT-5) <codex@openai.com>

Co-Authored-By: Codex (GPT) <codex@openai.com>
