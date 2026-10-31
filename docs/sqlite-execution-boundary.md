# SQLite execution and publication boundary

Issue: [issue:0a46100]. Native ingestion repair: [issue:f2ef717].

## Outcome

Interactive ledger writes and conversation reads remain responsive during
native transcript ingestion. Parsing, compression, derived index construction,
and cache maintenance execute outside the request thread. Canonical ledger
transactions publish bounded metadata, not a temporary copy of every block.

The representative failure is a 26,343-block synthetic Claude transcript: a
worker held the ledger writer lock for 1,623 ms, causing a trivial concurrent
daemon write to block 1,664 ms. The same ingestion without the competing write
left the caller responsive. The retained diagnosis is
[artifact-version:1e6c64213b99]; its reproducer is
[artifact-version:3c4b8f949edd].

## Storage ownership

Provider sources and explicitly managed custody own transcript bytes. The
ledger owns conversation identity, source descriptors and versions, the current
publication pointer, user-authored metadata, and actual durable references.
The existing structure cache owns rebuildable block navigation and parser
state. Its location is derived from the owning ledger unless explicitly
overridden; independent ledgers must not silently share a writable cache.

Prepare a validated source descriptor and complete version-qualified structure
outside a ledger write transaction. Publish canonical source/conversation
metadata and append progress together after preparation succeeds. Publish
events and follow-up work from that committed outcome. A source race or failed
preparation leaves the old publication and progress intact. Reject a stale
publisher against the version it prepared from.

Native ingestion must no longer insert compressed bodies and dense structural
rows into the ledger, copy them into the cache, then delete them. First ingest,
append, forced re-ingest, truncation and middle rewrite use one publication
contract. Reuse parser/source abstractions rather than adding a competing fast
path. Preserve actual historical/custodied data and durable references; remove
only the ordinary native staging mechanism. Existing migration/repair tooling
may retain explicit legacy conversion where real legacy bytes still exist.

Cache generations are qualified by source version and parser, normalization,
and redaction epochs. A reader admitted against one publication must not read
another version's positions. Preparation must not overwrite the only complete
old generation before publication. Cache loss rebuilds through the existing
worker/source-readiness path from validated source bytes; it must not report an
unverified empty conversation or make cache bytes authoritative. Retain bounded
generations using the existing maintenance owner; do not grow an unbounded
history of disposable indexes.

Request reads perform no synchronous cache write for access accounting. Cache
schema initialization and pruning must likewise not introduce a bulk writer
on the request path. Preserve the established stable references, parent/tool
relationships, model context, source availability and user-visible read result
contracts.

## Execution boundary

The ingestion worker owns preparation and derived storage. Its ledger commit
contains only necessary canonical metadata and actual durable reference
updates. Keep work proportional to transcript size outside that transaction.
Do not hide contention by increasing the busy timeout, turn it into failures
by decreasing it, or delay ingestion solely to move a stall beyond readiness.

This work does not convert roughly two thousand synchronous query sites to an
asynchronous storage API. It removes the measured bulk lock holder and hidden
cache writes. If representative canonical writes still exceed the existing
response budget, diagnose that remaining necessary transaction and introduce
an asynchronous owner at its actual boundary before declaring this delivered.
A worker changes where a wait executes; it does not remove SQLite's one-writer
limit or prove acceptable write latency.

## Work partition

1. Native publication and cache: one worker owns the coherent source-store,
   structure-cache, reader/readiness, and ingestion change. It incorporates the
   committed-outcome portion of [issue:dd12c79].
2. Worker-state ownership: a separate worker repairs the bounded ACP ingestion
   suppression bug [issue:311d396], coordinating edits in ingestion.ts with the
   first worker. This need not change the storage design.
3. Regression evidence: a worker replaces the obsolete contention tests and
   maintains a bounded representative performance witness. It coordinates test
   ownership with the first worker and validates the combined change once.

All implementation workers use GPT-6.1 Sol medium. The coordinator owns the
design, integration, related issue reconciliation, broad checks, and protected
merge request. No worker changes production state or runs candidate acceptance
independently.

## Sparse verification

Retain tests only when their failure establishes a product invariant defect.
Remove source-text checks, duplicated projection/CRUD assertions, and tests
whose sole purpose was the retired dense staging representation. Adapt existing
source-readiness and ingestion tests rather than multiplying parallel suites.

The compact behavioral gate must prove a real ledger/comment write and health
read can complete while derived ingestion work is in progress, with committed
comment/reference semantics intact. Coordinate by worker state, not sleeps.
The existing test that deliberately accepts a 900 ms main-thread busy wait is
obsolete. A bounded measurement outside the default unit gate checks actual
delay under representative native ingestion and re-ingestion. It measures both
main-loop delay and ledger write completion against the existing 100 ms handler
and 250 ms stall budgets; it records source/runtime/fixture identities.

Reuse meaningful existing fixtures for append, middle rewrite, source loss,
parser epochs, tool relationships and preserved metadata. Add only missing
publication-failure and concurrent-generation cases: failure before publication
keeps the old state; successful publication exposes a complete matching state;
cache eviction cannot lose canonical identity or authored data. Tests and
measurements isolate HOME, state, ledger, cache, source roots, and sockets.

Run focused checks while implementing; then one integrated default suite and
the required exact-candidate acceptance. Repeat only for changed inputs or a
specific unresolved failure. Do not increase budgets or restore tests that
merely encode an obsolete implementation.

## Related work and delivery

Review open database issues for overlap, but close them only on evidence that
their full acceptance contract is satisfied. The old source/custody/search
umbrella includes broader backup, redaction, and restore work which this change
does not imply complete. Operational log migration and durable-settings backup
have independent contracts. Record larger affected work explicitly.

The protected merge remains the user's action through Mandible. The historical
go-live issue [issue:2c6c87a] stays open until production delivery evidence can
attribute and exclude remaining early stalls. PostgreSQL is a conditional
future option in [issue:1c273c3], with no further planning in this delivery.

The global workflow conventions remain valid: issue-linked worktrees, immutable
source/custody evidence, signed commits and protected merge approval are
unchanged. No agent instruction change is required.

Co-Authored-By: Codex (GPT) <codex@openai.com>
