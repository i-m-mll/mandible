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

The helper waits for the exact old process and its start identity to disappear.
It then unloads the owned backend definition, runs frozen install, build,
desktop installation and instruction export, and loads the candidate service
definitions. Desktop installation cannot start the backend during this
transition. A changed owned gateway definition is reloaded explicitly.

Starting the candidate services only starts them. The helper then awaits the
started daemon's readiness: it inspects the front door until it answers ready
and warm at the exact merge generation, bounded by the handoff deadline. Every
handoff health probe waits for the daemon's actual answer until that deadline
(or one observation window for a recovery that outlived it); a slow answer is
the daemon's state, not a failure. A refusal names the daemon's last answer.

Completion requires the pinned executable in loaded launchd arguments, the
exact applied merge generation through the production front door, matching
installed desktop provenance, and a full 31-second daemon health/log
observation. Each observation sample must answer from the same process and
definitions, ready at that generation, without event-loop or memory warnings,
and without a maximum event-loop delay of 250 ms or more. Diagnostic samples
carry a sequence and exact interval. The observer waits until a completed
sample covers the end of the 31-second window, within one fixed 62-second
deadline; a stale sampler cannot pass by returning the same snapshot. The
candidate hook manager verifies this receipt and publication
proof before settling convergence or releasing deferred delivery actions.
The log assessment fails on any `error` line from the current process and on
any one event or route that exceeds 100 lines in a 10-second window. That rate
rule detects runaway loops. Scheduled work that goes through a backlog, such as
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
visibly. Helper crash recovery has six attempts and a 30-minute deadline.
Failure preserves the journal and reports the failed phase as **merged, not
live**. It does not restore the old dependency graph or replay publication.

## Handoff lock

`MANDIBLE_HOME/config/local-sessions/handoff-active.json` names the one handoff
that owns the installation. While it is held, no other handoff is admitted, and
no protected merge may execute. Merge preflight and submission may prepare
later pending requests and report the lock as their publication blocker, but
candidate runtime launches stay deferred and every approval/execution path,
including documentation-only merges, refuses. This keeps the protected branch
at the exact generation needed to recover the failed publication. Releasing
the lock schedules one missing current-candidate acceptance without repeating
an unchanged failed result. A failed handoff keeps
the lock until `mandible auth handoff recover <request>` (verification-only
recovery, below) succeeds or the operator retires it with
`mandible auth handoff retire --binding-digest <digest> --reason <text>`.
Retirement boots out the exact idle helper job if one is still loaded and moves
the lock beside the journal as `retired-active.json` with a `retirement.json`
record. The journal, staged material and logs stay in place, and the failed
delivery stays failed.

A rebuild that ends without an admitted handoff, or whose handoff fails, is
reported once as `rebuild_failure` in health and as `mandible:rebuild-failed`,
with the message "The merge landed, but Mandible did not update: <reason>." A
rebuild hook that exited 75 belongs to its handoff and is pending, never a
failure, until that handoff's journal fails.

## Verification

Two provisioned tests cover the handoff on macOS. Each derives its inputs from
the machine and throws, naming the prerequisite, when one is missing.

```bash
bun run test:provisioned test/provisioned/runtime-handoff-launchd.test.ts
bun run test:provisioned test/provisioned/runtime-handoff-full.test.ts
```

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
failed handoff journal, receipt verifier, and convergence settlement. It never
runs a build, installer, merge, or restart. The failed journal remains failed
through a 31-second observation of the exact current daemon, installation,
loaded launchd definitions, and actual stderr writer. Hook acceptance commits
before the journal becomes complete; interrupted acknowledgment can be replayed.
Concurrent observers cannot replace a receipt after its hook acceptance commits.
The original failure and hook attempt history remain available. Initial
handoff acceptance remains strict from process startup through observation.
Recovery still reads and hashes the complete current-process log, following
rotated segments as described below, and lifetime
hard failures such as crashes, error rows, restarts and event storms remain
fatal. Timed lag, stall and memory-warning rows that precede a new recovery
observation are retained as historical diagnostics; untimed events and events
during the new interval fail. The recovery receipt records the exact interval,
initial and final samples, full log offset/digest/byte count, and bounded
historical diagnostics.
Refused recovery observations are kept separately under the handoff's
`recovery-attempts/` directory. Each immutable record includes the actor,
failed phase, reason and bounded evidence; the newest ten are retained without
rewriting the journal or an accepted recovery receipt.
This exception is limited to lag, stall and memory diagnostics whose later
samples prove the same process recovered. Generic lifetime error rows remain
fatal even when they are old. Existing liveness or performance faults can
therefore still refuse candidate acceptance or recovery; the handoff reports
that refusal rather than treating readiness alone as convergence.

The protected retry route accepts `mode: "verify-current"` and requires an
active durable credential with project write access and exact delivery custody
(or configured operator recovery). `mandible auth handoff recover <request>
[--operator-recovery]` calls it. Public routes accept ambiguity-safe short
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
their stderr, and the daemon logs each line as a `child_process_stderr` warning
with the child's attribution; `bun run check` refuses daemon code that lets a
child inherit the daemon's stderr. A rotated 16 MiB log takes about 15–50 ms of
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
