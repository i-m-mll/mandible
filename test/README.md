# `test/` — the default gate

`bun run test` runs exactly the flat `test/*.test.{ts,tsx}` directory. That
directory **is** the whitelist: a file is in the gate because it is here, and
nothing else marks it. There is no annotation to keep in sync and no list to
drift.

Build the daemon before running the default gate in a fresh checkout or after
server source changes: `bun run build:server`. The daemon auto-start boundary
launches `dist/index.js`, so an absent or stale build cannot test the current
source. The full `bun run build` used by candidate packaging also satisfies
this prerequisite.

| Suite | Command | Must |
| --- | --- | --- |
| `test/` | `bun run test` | pass |
| `test/extended/` | `bun run test:extended` | pass |
| `test/quarantine/` | `bun run test:quarantine` | **fail** |
| `test/browser/` | `bun run test:browser` | pass, on a provisioned machine |

## What earns a place here

A file stays when a reader answers yes to both questions within thirty seconds.

**Does it exercise a boundary Mandible actually exposes?** Exhaustively:
protected-merge and clearance; credential and custody handling; SQLite schema
and durable ledger records; the HTTP API; the CLI grammar pinned by the
Mandible Interface Contract, which agents in other repos depend on and which a
silent change breaks with no local signal; provider log parsers and ingestion;
daemon start/stop/readiness and SSE. Browser-facing URL routing, sanitized prose, API requests, SSE reduction, and
user-intent reconciliation are also boundaries. Component geometry, theme
tokens, class names, and fixed copy do not by themselves name a defect.

**Would the failure name a defect?** If the likeliest cause of a red is
"someone changed a string, a class name, a pixel, or a component tree", no. If
it is "the daemon now accepts something it must refuse", "a record no longer
round-trips", "a documented flag stopped working", yes.

Any one of these is fatal:

- The file's only input is `readFileSync` of a source or CSS file asserted with
  a regex or `toContain`. That is lint written as a test.
- It duplicates a fact already asserted at a lower layer by a file in this
  directory.
- It pins presentation.

## UI behavior boundaries

Pure routing, SSE reduction, API handling, Markdown sanitization, and rail-order
normalization run here. Rendered state reconciliation and interaction belong in
`test/extended/`; real focus, paint, and browser integration belong in
`test/browser/`. Layered cases stay when they prove distinct behavior: a pure
normalizer cannot prove a mounted view preserves a draft or rejects a stale reply.

There is no global coverage threshold. A line-coverage floor is a proxy metric
that contradicts a whitelist: it rewards adding tests for whatever is cheapest
to reach, which is exactly the pressure this directory exists to resist.

## The timing contract

`bun run test` prints a timing packet at the end of every run: wall time, worker
count, per-file occupancy, their sum, the slowest two files, the true lower
bound `max(sum / workers, slowest file)`, and the ratio of wall time to that
bound. `test/helpers/timing-reporter.ts` owns it, and it is registered on the
default suite only.

Read the bound, not the throughput floor. Files are indivisible: Vitest runs
each in its own fork and never parallelises within one. `sum / workers` alone
is what the gate could cost if work could be divided arbitrarily, and
differencing against it produced the claim that a 102.7s run was "3.1x the
floor" when it was in fact within 1% of optimal for the task graph it had. One
6,122-line file was 98.9% of the wall clock; the scheduler had twelve idle
forks and nothing it was allowed to give them.

The run fails when the slowest file is over 30 seconds and more than twice the
second-slowest — the shape of that failure, and hardware-independent, so it
holds on CI's variable runners. With `MANDIBLE_TIMING_GATE=1` on a controlled
machine it also fails over a 60-second wall clock or a 45-second file.

The fix for a violation is to split the file. Raising a timeout or capping
workers hides it.

### If you beat the throughput floor, you have changed the regime

Today the slowest file is the binding term: it is around 39s against a
throughput floor near 34s, so wall time tracks that one file. Two things follow
from that and *both* stop being true together.

First, the gate is roughly insensitive to other load on the machine, because its
critical path is a single fork and foreign work lands on the other cores.
Second, making any file other than the slowest one faster does nothing to wall
time.

Drive the slowest file below the floor and `sum / workers` binds instead. Every
fork joins the critical path, total occupancy starts to matter more than any
single file, and the gate becomes load-sensitive — timings will scatter under
contention in a way they do not now.

### The bound holds within a worker count, never across them

`max(sum / workers, slowest file)` is a lower bound only when `sum` was measured
*at that worker count*. It is not a formula you can evaluate at other counts,
because occupancy is not invariant: forks contend with each other for subprocess
spawning, so adding workers inflates every file's occupancy and removing them
deflates it.

Measured here, across the same suite:

| workers | sum of occupancies | floor | slowest file | wall |
|---------|--------------------|-------|--------------|------|
| 13      | ~443s              | ~34s  | ~38.6s       | ~38.7s |
| 10      | ~360s              | ~36s  | ~31.9s       | ~36.5s |
| 8       | 335s               | 41.8s | 28.2s        | 43.1s |

Fewer workers made the binding file *faster* — 38.6s to 28.2s — while raising
the floor. Roughly 30% of total occupancy at 13 workers is contention the
parallelism inflicts on itself. Note also that the binding term changes: at 13
the slowest file binds, at 10 and below the floor does.

Taking the 13-worker sum and dividing by 10 predicts 44.7s. The measured
10-worker run was 39.7s — below a number derived as a lower bound. The
prediction was not merely imprecise; it was invalid, because it evaluated the
formula outside the conditions its inputs came from.

So do not extrapolate from the numbers in this file after such a change.
Re-derive them at the worker count you actually intend to run. The reporter
prints both terms on every run so the crossover is visible when it happens
rather than inferred afterwards.

## Readmissions

A test returns from `test/extended/` only when it names a defect that actually
escaped or covers a boundary no file here covers, its failure would name that
defect rather than report a changed string, and it adds under one second to the
wall clock. Each readmission gets one line below naming the incident or
boundary that justified it. A test that cannot be justified in one line does
not come back.

- `trash-service` — the only cover for `mandible trash` preserving untracked,
  ignored, and submodule bytes before a worktree is removed. `trash-cli` pins
  the grammar against a stub and asserts nothing about the bytes.

- `instructions` — rendered and installed Interface Contract syntax is an external agent interface.
- `briefing-directives` — frozen review directive grammar, exact byte digests, and UTF-16 ranges.
- `resource-refs` — typed, pinned, and historical reference parsing retains identity.
- `spaces-doc-pipeline` — imported prose and directives remain sanitized, inert data.
- `spaces-doc-serialize` — document identity and directives survive serialization.
- `conversation-block-filters` — filtering and envelopes preserve position and metadata.
- `git-read-transport` — read transport policy never changes the push destination.
- `transport-lane` — persisted lane defaults and explicit selection reach the owning service.
- `startup-ingestion-order` — ingestion waits for initial scan and respects cancellation.
- `ingestion-scheduler` — bounded watcher deduplication and exact-read ownership prevent lost work.
- `app-rail-order` — versioned preference reconciliation preserves surviving user order.
- `ui-routing` — external deep links preserve page bindings and route-owned identity.
- `ui-sse-state` — stream reduction bounds output, strips ANSI, and refetches canonical auth projections.
- `ui-api-client` — mutation errors and boolean payloads preserve the HTTP client contract.
- `ui-markdown-security` — dangerous markup, URL schemes, and transcript form controls stay inert.

Readmission timing is checked on the coordinated candidate run; syntax parsing
alone does not establish the under-one-second budget.

The test launchers pass Bun's public `--smol` flag to the runner and actual test
forks. The process-tree RSS watchdog remains authoritative; this flag encourages
collection and does not raise or replace the memory limit. On macOS, the launcher
resolves the hash-verified stock SQLite archive before isolating HOME, then passes
that exact archive to private child runtimes. No ambient library fallback is used.
