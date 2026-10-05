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

Co-Authored-By: Codex (GPT-5) <codex@openai.com>
