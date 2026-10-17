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
that owns the installation. A failed handoff keeps it until verification-only
recovery succeeds or the operator retires it. While it is held, admission of any
other handoff refuses, and so do the merge check, submission and every approval
path for a runtime self-update request. Each refusal names the lock, its
request, phase and error.

`mandible auth handoff status` shows the lock.
`mandible auth handoff recover <request>` runs verification-only recovery (see
below) for a failed handoff whose exact merge generation is already live. It
requires the request's delivery work-unit credential, or the configured operator
with `--operator-recovery`.
`mandible auth handoff retire --binding-digest <digest> --reason <text>` retires
a lock whose journal phase is `failed`. It is operator-only through the
protected operator gate. It boots out the exact idle helper job if one is still
loaded, then moves the lock beside the journal as `retired-active.json` with a
`retirement.json` record. The journal, staged material and logs stay in place.
Retirement neither restores the old runner nor makes the failed delivery live.

When a rebuild window closes without an admitted handoff, or the handoff that
owns a rebuild fails, the daemon clears the active restart-availability window,
broadcasts `mandible:rebuild-failed` with the hook's reason, and reports
`rebuild_failure` in health. The dashboard splash then says the rebuild failed.
A rebuild hook that exited 75 belongs to its handoff: it is pending, never a
failure, and convergence sweeps do not open a rebuild window for it. Its
failure is reported once, when the handoff's journal fails. Completed
convergence for that request withdraws its rebuild failure.

## Focused verification

The explicit macOS fixture uses the deployed legacy interpreter with a private
installation directory and unique launchd labels. It verifies independent
supervision, bridge ordering, helper crash recovery and repeated admission
without dependency mutation:

```bash
runtime="$(scripts/bun-runtime.sh)"
MANDIBLE_TEST_LEGACY_RUNTIME="/absolute/path/to/deployed/old/node" \
  "$runtime" scripts/run-vitest.js run \
  --config vitest.extended.config.ts \
  test/extended/runtime-handoff-launchd.test.ts
```

This fixture runs a minimal old-interpreter process. It does not replace the
integrated acceptance gate using the actual old daemon, candidate daemon and
packaged desktop. The coordinator runs that gate after all source inputs
stabilize. The isolated candidate command is documented in
[candidate acceptance](candidate-acceptance.md).

## Full daemon transition gate

The full fixture archives the deployed old source revision from its build
marker, clones its installed dependencies, and starts the actual old daemon in
a private installation. It creates a candidate checkout through `wt`, builds
its complete daemon and desktop package, drains the exact old backend, and
installs the candidate using the existing local installer. This bootstrap
includes the candidate's ordinary database migrations.

The candidate service has an explicit reviewed PATH starting at its retained
CLI. A poisoned old shim proves that this selection overrides an older CLI.
A durable private agent then submits one issue-linked request through the
normal HTTP API, and the private configured operator approves it through the
ordinary action-bound signing challenge. The exact configured native Git hook
bytes are copied into the private repository and must finish before the build
hook. The executor must produce the atomic preparation, application and result
receipts; no auth row or receipt is manually published.

The build hook independently supervises the retained candidate source to
canonical destination transition. Admission binds one installation, canonical
project and Git common directory, the reviewed source head, verified build
marker, every generated daemon module and installed dependency, and exact
runtime and CLI bytes. The source checkout and its independent dependencies
remain intact until the request and convergence receipt are terminal. Final
readiness proves the canonical root, actual merge generation and canonical
CLI PATH. No request is submitted to the production ledger.

```bash
runtime="$(scripts/bun-runtime.sh)"
MANDIBLE_TEST_OLD_CHECKOUT="/absolute/path/to/deployed/old/checkout" \
MANDIBLE_TEST_LEGACY_RUNTIME="/absolute/path/to/deployed/old/node" \
MANDIBLE_TEST_CANDIDATE_REVISION="<committed candidate SHA>" \
MANDIBLE_TEST_CA_HOME="/absolute/path/to/existing/trusted/installation" \
MANDIBLE_TEST_BUILD_HOME="/absolute/path/to/existing/build/user/home" \
MANDIBLE_RUNTIME_ARCHIVE="/absolute/path/to/verified/bun.zip" \
MANDIBLE_SQLITE_LIBRARY_ARCHIVE="/absolute/path/to/verified/sqlite.tar.gz" \
  "$runtime" scripts/run-vitest.js run \
  --config vitest.extended.config.ts \
  test/extended/runtime-handoff-full.test.ts
```

Pass the qualified stock SQLite library inputs when required by its canonical
startup contract. `MANDIBLE_TEST_OLD_REVISION` may explicitly select the retained
old commit; otherwise the old build marker supplies it. The old checkout must
retain its compatible dependencies. The fixture clones the qualified Bun
dependency cache into its private home and references the existing Cargo and
Rustup toolchain directories. These prerequisites come from the established
frozen dependency install and native build setup; the fixture does not edit
user toolchain configuration. The candidate revision must include every
runtime, storage and handoff source change being qualified.

Isolation transforms only the fixture copies: generated frontend/backend
ports, the generator's exact expected frontend port, and the Caddy admin port.
The fixture copies the existing trusted CA snapshot into private storage and
preserves its certificate and key digests; it changes no OS trust store.
Unique installation-directory hashes produce distinct launchd labels. Its
native install path is private and explicitly frozen in the fixture hook
command. Provider secrets and test-mode variables are absent from subprocess
environments. The receipt records both source revisions and the transforms.

Compact success or failure evidence goes to the explicit build home's
`.cache/mandible/acceptance/upgrade-evidence`. Teardown stops only declared
fixture jobs and deletes their generated data. The separate paired daemon and
desktop gate still runs on the exact unmodified integration candidate; this
transition fixture does not claim identical source bytes after its necessary
port transforms.

For the next update from an installed canonical-root Bun daemon, use the same
fixture with `MANDIBLE_TEST_INSTALLED_UPDATE=1` and set
`MANDIBLE_TEST_LEGACY_RUNTIME` to that installation's pinned Bun. This mode
keeps the old protected-root executor serving until the ordinary reviewed
request merges the candidate. It skips candidate bootstrap and the preliminary
native build, then verifies the canonical independent handoff, exact new
health generation, loaded service definition, durable acknowledgment, and native
`xattr` precedence under the real launchd executor. Same-root admission has no
separate source-checkout binding. Every managed self-update uses this sequence;
standalone builds outside managed auth retain their existing build guard.
The default mode retains coverage of the feature-checkout to canonical-root
handoff. Evidence records the topology that actually ran.

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
