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
definitions, ready at that generation, without event-loop or memory warnings. The candidate hook manager verifies this receipt and publication
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
the merge check, submission and every approval path for a runtime self-update
refuse, naming the lock, its request, phase and error. A failed handoff keeps
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
The original failure and hook attempt history remain available.

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

Log discovery and complete current-process coverage each have a 16 MiB bound.
Missing startup identity, changed process, rotated or truncated logs, or excess
coverage fails visibly. Recovery preserves logs and does not restart a healthy
daemon to satisfy that bound. A fresh launch requires separate authorization.
Packaging uses the pinned runtime and canonical CLI, then native macOS tools,
then Cargo and inherited tools; a Homebrew `xattr` cannot replace `/usr/bin/xattr`.

Co-Authored-By: Codex (GPT-5) <codex@openai.com>
