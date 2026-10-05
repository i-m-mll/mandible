# Production runtime upgrade

The required Mandible rebuild hook uses an independent launchd worker when the
loaded backend executable differs from the selected pinned Bun executable.
An ordinary same-runtime rebuild keeps the existing synchronous hook path.

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

Completion requires the pinned executable in loaded launchd arguments, the
exact applied merge generation through the production front door, matching
installed desktop provenance, and a full 31-second daemon health/log
observation. The candidate hook manager verifies this receipt and publication
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

## Focused verification

The explicit macOS fixture uses the deployed legacy interpreter with a private
installation directory and unique launchd labels. It verifies independent
supervision, bridge ordering, helper crash recovery and repeated admission
without dependency mutation:

```bash
runtime="$(scripts/bun-runtime.sh)"
MANDIBLE_TEST_LEGACY_RUNTIME="/absolute/path/to/deployed/old/node" \
  "$runtime" node_modules/vitest/vitest.mjs run \
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
marker, clones its installed dependencies, and starts that actual daemon in a
private installation. It imports the selected candidate source into a signed
temporary test repository. The old daemon's existing finalizer sweep consumes
one fixture publication and runs the real hook. After admission, the fixture
sends SIGTERM to the exact bound private old daemon and exercises its existing
drain and exit path. Periodic finalizer recovery does not schedule the normal
execution path's self-merge exit; the receipt records this explicit trigger.
The candidate worker builds and installs a private desktop
bundle, starts candidate production, and waits for receipt reconciliation.
No request is submitted to the production ledger.

```bash
runtime="$(scripts/bun-runtime.sh)"
MANDIBLE_TEST_OLD_CHECKOUT="/absolute/path/to/deployed/old/checkout" \
MANDIBLE_TEST_LEGACY_RUNTIME="/absolute/path/to/deployed/old/node" \
MANDIBLE_TEST_CANDIDATE_REVISION="<committed candidate SHA>" \
MANDIBLE_TEST_CA_HOME="/absolute/path/to/existing/trusted/installation" \
MANDIBLE_RUNTIME_ARCHIVE="/absolute/path/to/verified/bun.zip" \
MANDIBLE_SQLITE_LIBRARY_ARCHIVE="/absolute/path/to/verified/sqlite.tar.gz" \
  "$runtime" node_modules/vitest/vitest.mjs run \
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

Compact success or failure evidence goes to the calling user's
`.cache/mandible/acceptance/upgrade-evidence`. Teardown stops only declared
fixture jobs and deletes their generated data. The separate paired daemon and
desktop gate still runs on the exact unmodified integration candidate; this
transition fixture does not claim identical source bytes after its necessary
port transforms.

Co-Authored-By: Codex (GPT-5) <codex@openai.com>
