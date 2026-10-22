# `test/` — the gate

`bun run test` runs `test/*.test.{ts,tsx}` in parallel forks and takes about a minute. A file is in the gate because it is in this directory. `test/provisioned/` holds tests that need a real browser, macOS `lockf` and launchd, or a daemon fleet (`bun run test:provisioned`, on demand and before a release). `test/quarantine/` holds red tests, each naming an open issue (`bun run test:quarantine`, must fail).

## Should this test exist?

Ask this before asking why a test fails. A test stays when both are true:

1. **It guards an invariant Mandible must keep.** Protected-merge custody, credential custody, ledger integrity, schema convergence, the transports and the Interface Contract, conversation and artifact custody, daemon isolation, permissions, and browser behaviour that preserves user intent or sanitizes content. The list is in the umbrella that set it, [issue:fec6f89].
2. **Its failure would name a defect.** If the likeliest cause of a red is that someone changed a string, a class, a pixel, a constant, a help line, a log message or a component tree, the test pins presentation or implementation and is deleted.

Any one of these is fatal, whatever the test claims to cover:

- It restates the code: a request-shape echo per CLI command, a store CRUD round-trip, field-by-field projection parity, an enum or lookup table asserted against itself.
- It reads a source or CSS file and asserts on its text. That is lint; put it in `bun run check`.
- It asserts a contract another gate test already asserts at a lower layer.
- It hand-rewinds the schema (`DROP TABLE`, `UPDATE meta SET value=...`) to fake a pre-migration database. Migration tests start from the floor fixture migrated forward to the version under test (`migrateFixtureThrough` in `test/db-migration-convergence.test.ts`), and live in that file.
- It waits for a duration instead of a state, or sets a per-test timeout as a speed check.
- It writes outside its own temp root (`testRuntimeRoot` in `test/helpers/runtime-isolation.ts`). The timing reporter fails the run if the checkout is not clean afterwards.
- It is skipped. Delete it or fix it.

When a test fails, decide in this order: should it exist (above); is the fixture wrong; is the product wrong (fix through the owning issue). Changing an expectation is legitimate exactly when the new behaviour is the intended one; record why in the commit.

## Budget

`bun run test` prints a timing packet: wall, workers, per-file occupancy and its sum, the slowest files, and the bound `max(sum / workers, slowest file)`. The relative outlier rule (a file over 30 s and more than twice the next) always fails the run. With `MANDIBLE_TIMING_GATE=1`, so does a sum over 600 s, a file over 25 s, or a wall over 60 s. Files are indivisible, so the fix for a slow file is to split or shrink it, never to raise a timeout or cap workers. Per-test timeouts are hang guards (60 s); tests await the state they need through `test/helpers/wait-until.ts`.

Neither suite needs a build: tests that launch the daemon or a CLI entrypoint run the TypeScript source on the pinned Bun.
