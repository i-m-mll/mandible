# `test/` — the gate

`bun run test` runs `test/*.test.{ts,tsx}` in parallel forks and takes about a minute. A file is in the gate because it is in this directory. `test/provisioned/` holds tests that need a real browser, macOS `lockf` and launchd, or a daemon fleet (`bun run test:provisioned`, on demand and before a release). `test/quarantine/` holds red tests, each naming an open issue (`bun run test:quarantine`, must fail while it holds any file; it is normally empty). Per-route handler cost against a snapshot of the live ledger is not a test: `bun run route-cost-sweep` measures it, and candidate acceptance runs it ([daemon stall profiling](../docs/daemon-stall-profiling.md#route-cost-sweep)).

## Should this test exist?

Ask this before asking why a test fails. A test stays when both are true:

1. **It guards an invariant Mandible must keep.** Protected-merge custody, credential custody, ledger integrity, schema convergence, the transports and the Interface Contract, conversation and artifact custody, daemon isolation, permissions, and browser behaviour that preserves user intent or sanitizes content. The list is in the umbrella that set it, [issue:fec6f89].
2. **Its failure would name a defect.** If the likeliest cause of a red is that someone changed a string, a class, a pixel, a constant, a help line, a log message or a component tree, the test pins presentation or implementation and is deleted.

Any one of these is fatal, whatever the test claims to cover:

- It restates the code: a request-shape echo per CLI command, a store CRUD round-trip, field-by-field projection parity, an enum or lookup table asserted against itself.
- It reads a source or CSS file and asserts on its text. That is lint; put it in `bun run check`.
- It asserts a contract another gate test already asserts at a lower layer.
- It hand-rewinds the schema (`DROP TABLE`, `UPDATE meta SET value=...`) to fake a pre-migration database. Migration tests start from the floor fixture migrated forward to the version under test (`migrateFixtureThrough` in `test/helpers/schema-snapshot.ts`), and live in `test/db-migration-convergence.test.ts`, whose header gives the floor-bump procedure.
- It waits for a duration instead of a state, or sets a per-test timeout as a speed check.
- It writes outside its own temp root (`testRuntimeRoot` in `test/helpers/runtime-isolation.ts`). The timing reporter fails the run if the checkout is not clean afterwards.
- It is skipped. Delete it or fix it.

When a test fails, decide in this order: should it exist (above); is the fixture wrong; is the product wrong (fix through the owning issue). Changing an expectation is legitimate exactly when the new behaviour is the intended one; record why in the commit.

## Budget

Backend files use the Node environment inside pinned Bun forks. Browser/DOM consumers declare `// @vitest-environment jsdom`, including plain `.ts` files. Each file remains isolated. The runner creates one production-migrated, immutable schema seed under its private run root; ledger fixtures deserialize private memory copies or write private file copies, then apply connection pragmas and caller-specific users. Missing or mismatched run setup fails. Migration-convergence tests keep their independent floor fixtures and production migration path.

`bun run test` reports actual fork lifetimes through graceful shutdown, configured scheduling slots, peak live forks, shared work, and runner wall. A fork can still be shutting down after its scheduling slot is reused, so configured slots do not bound live forks. Total charged occupancy is the sum of fork lifetimes plus runner wall outside their interval union. Runtime qualification, schema preparation, child supervision, private-root cleanup, and final checkout verification count once. Per-file Vitest phases (environment, prepare, collect, setup, tests/hooks) and their diagnostic sum remain separately available in `MANDIBLE_TIMING_JSON=<path>`; the residual lifecycle overhead is unattributed, not an inferred teardown duration. Use an external timer for full `bun run test` shell startup and exit.

The relative outlier rule (a file over 30 s and more than twice the next) always fails the run. With `MANDIBLE_TIMING_GATE=1`, so does total charged occupancy over 600 s, a file lifetime over 25 s, or runner wall over 60 s. Full-command acceptance also requires external elapsed time within 60 s. Files are indivisible, so reduce their work or split independent contracts; never raise budgets or cap workers. Per-test timeouts are hang guards (60 s); tests await state through `test/helpers/wait-until.ts` and import Testing Library through `test/helpers/dom.ts`. `bun run check` refuses per-test/per-hook timeouts, `vi.waitFor`, and direct Testing Library imports in the gate.

Neither suite needs a build: tests that launch the daemon or a CLI entrypoint run the TypeScript source on the pinned Bun.
