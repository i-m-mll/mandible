# `test/` — the default gate

`npm test` runs exactly the flat `test/*.test.{ts,tsx}` directory. That
directory **is** the whitelist: a file is in the gate because it is here, and
nothing else marks it. There is no annotation to keep in sync and no list to
drift.

| Suite | Command | Must |
| --- | --- | --- |
| `test/` | `npm test` | pass |
| `test/extended/` | `npm run test:extended` | pass |
| `test/quarantine/` | `npm run test:quarantine` | **fail** |
| `test/browser/` | `npm run test:browser` | pass, on a provisioned machine |

## What earns a place here

A file stays when a reader answers yes to both questions within thirty seconds.

**Does it exercise a boundary Mandible actually exposes?** Exhaustively:
protected-merge and clearance; credential and custody handling; SQLite schema
and durable ledger records; the HTTP API; the CLI grammar pinned by the
Mandible Interface Contract, which agents in other repos depend on and which a
silent change breaks with no local signal; provider log parsers and ingestion;
daemon start/stop/readiness and SSE. Component composition, pane geometry,
theme tokens, hover behaviour and copy are not boundaries — they are
presentation.

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

## What this deliberately does not cover

UI interaction has no net in the default gate. Type-checking covers component
shape, `test/browser/` covers paint, and `visible-first-boot` covers mount, so
an interaction regression reaches a browser before it reaches CI. That is a
deliberate, reversible trade, not an oversight.

There is no global coverage threshold. A line-coverage floor is a proxy metric
that contradicts a whitelist: it rewards adding tests for whatever is cheapest
to reach, which is exactly the pressure this directory exists to resist.

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
