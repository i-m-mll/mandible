# Source-backed conversation storage

Status: historical migration plan; sparse cutover decision updated 2026-08-21

> The original dual-read retention gates below describe the migration that led
> to source-backed reads. The current operator decision supersedes its legacy
> body/alias retention requirement: provider-native files and Mandible ledger
> metadata are authoritative, and dense normalized conversation projections are
> intentionally reclaimed. A disposable sparse cache now holds only bounded
> native-record navigation coordinates. Missing cache entries are reparsed from
> native files; old block aliases and dense replay history are not preserved.

## Decision

Provider-native conversation files are the veridical source material. Mandible
keeps durable identities, relationships, annotations, custody evidence, and
source state, but normalized bodies become derived data. Derived bodies and
search material may be cached; deleting the cache must never remove durable
Mandible state.

The rollout began as an additive dual-read migration. The sparse cutover now
makes verified provider files the default body reader and intentionally leaves
the dense compatibility tables empty in a freshly rebuilt database. Legacy
rows remain readable only for old databases and isolated compatibility data;
they are not regenerated for source-backed conversations.

## Durable and disposable boundaries

Durable canonical state:

- immutable Mandible conversation IDs;
- provider/native session identifiers without assuming they are unique;
- source aliases, immutable source versions, availability, and custody state;
- tags, notes, star/preservation intent, parent links, workflow links, and
  other user-authored relationships;
- custody manifests, integrity results, and restore evidence.

Disposable derived state:

- parser checkpoints that can be recreated from a verified source version;
- block-order/record-range coordinates and old block aliases;
- masked normalized hot bodies;
- masked FTS/trigram postings and snippets;
- ingestion telemetry and operational daemon logs.

Exact native custody bytes live outside the canonical SQLite database in a
content-addressed store. They are never indexed, emitted through SSE, placed in
ordinary exports, or written to browser caches.

## Source identity and locator contract

A provider session ID or content hash alone is not a conversation identity.
Each conversation may have several path aliases and source versions. An active
Codex rollout moving to `archived_sessions`, a provider rename, or an exact-byte
copy changes aliases without changing the Mandible conversation ID.

The disposable sparse cache records only:

```text
conversation_id
source_version_id
position
type_code
role_code
parent_position
record_offset
record_length
record_ordinal
sub_block_ordinal
parser_format
parser_version
normalization_version
redaction_epoch
```

For a sealed source, `source_version_id` is derived from a full cryptographic
content hash. A live appendable source may use a cryptographically attested
append generation, but the existing `append:<size>:<tail-hash>` marker is not a
content identity and must not key custody or cache correctness.

A source read must:

1. resolve only within an allowlisted provider root or managed custody root;
2. reject symlink escapes and non-regular files;
3. validate the opened descriptor and complete source generation;
4. read only the bounded native records and parent/tool context named by the
   sparse cache;
5. verify the source did not change during the read;
6. fail closed to reindex on any mismatch.

Missing sources produce `source_unavailable` tombstones. They do not delete
conversation rows, annotations, relationships, or other ledger metadata; no
dense fallback body is retained after sparse cutover.

## Shared source-store API

The schema/source lane owns these modules and their public types:

```text
src/conversations/source-store.ts
src/conversations/source-reader.ts
src/conversations/source-types.ts
```

The API must support:

- resolving a durable conversation to an available verified source version;
- reading one structural block by durable block ID;
- reading a bounded block page in stable order;
- streaming normalized blocks with explicit parser/redaction epochs;
- recording aliases, immutable versions, checkpoints, and unavailable state;
- returning a typed stale/unavailable/unsupported result rather than plausible
  but unverified content;
- invoking the existing legacy-body reader as an explicit fallback.

Only this lane edits `src/db-migrations.ts` and `src/db-baseline.ts`. It owns the
single additive canonical migration for all durable conversation source,
locator, alias, structural identity, and custody-state fields needed by sibling
lanes. Sibling lanes consume the API and do not create parallel canonical
schemas.

## Search and cache contract

The conversation cache is disposable and independently openable. Cache keys
include source version, parser version, normalization version, tokenizer
version, and redaction epoch. A cache miss or stale epoch is ordinary and must
not mutate durable identity.

Only text after the normal credential-masking boundary may enter the cache or
search index. Contentless FTS means content is not retrievable from the FTS
table; it does not mean the postings are secret-free.

FTS/trigram is a shortlist, not the semantic authority. Before returning a
match or snippet, Mandible rereads or obtains a verified masked normalization
and performs the exact existing lowercase-substring comparison. Short strings,
Unicode/tokenizer edge cases, punctuation, and newlines require a fallback
that has zero shortlist false negatives. Redaction-epoch changes rebuild or
rotate any index whose targeted erasure cannot be proven.

Cold parsing is concurrency- and memory-bounded. Performance acceptance is
measured separately for cold and hot detail reads and searches.

The normalized-body budget is not the disk budget: trigram postings can be
several times larger than input text. The cache therefore enforces both a 32
MiB normalized-body LRU budget and a 256 MiB cap over the complete SQLite file
family, rebuilding the disposable FTS file if tombstones prevent compaction.

## Preservation, archive, and restore contract

Preservation is a visible state machine:

```text
requested -> capturing -> verified -> mirroring | sealed
                       \-> error
```

A star may request preservation, but `verified` is the only state that promises
custody. A live multi-file provider session is captured as an immutable,
checksummed version; it is not described as an atomic provider snapshot unless
the adapter actually proves one.

The archive format contains:

```text
manifest.json
metadata.sqlite or metadata.json
providers/<provider-relative native subtree>
annotations/<conversation-id>.json
SHA256SUMS
```

The manifest records archive format, provider and adapter versions, canonical
conversation ID, every native identity, root-relative paths, dependency role,
size, digest, capture consistency, source/custody version, and restoration
limitations. It never embeds a private absolute home path.

Provider adapters capture at least:

- Claude: main transcript, opaque session subkeys, subagent transcripts,
  spilled tool results, relevant session index material, and file-history
  checkpoints only when rewind is promised;
- Codex: selected rollout, every required `history_base` rollout, title entry,
  and a versioned per-thread export of state held outside the rollout;
- Gemini: chat files, project-root mapping, activity logs, tool output, plans,
  tasks, session artifacts, and nested subagent material.

Two promises remain distinct:

1. Mandible recovery reconstructs durable Mandible metadata and every verified
   custody version with checksums.
2. Provider reinjection is a staged, collision-safe, provider/version-specific
   adapter. It never overwrites an existing provider file and may report that
   exact native resume is unsupported even when custody is complete.

## Operational log split

`daemon_log` moves behind a dedicated operational-log database and lifecycle.
The move is independent of conversation cutover. Copy-forward is idempotent,
resumable, and query-deduplicated while both stores coexist. Startup never
performs an unbounded blocking rewrite.

The old canonical table remains rollback evidence until an explicit verifier
proves row coverage and query parity. Reclaim is a separate explicit operation;
feature work does not delete or vacuum production rows. Log retention and
backup classification apply to the log database independently.

## Migration and cutover

Rollout order:

1. add durable source identities, locators, structural IDs, aliases, and source
   status;
2. shadow-index provider files and retain legacy-body reads;
3. add source-backed dual reads and compare them against stored bodies;
4. add disposable search/cache and prove exact search parity;
5. capture and verify preserved-conversation custody;
6. prove metadata-plus-custody fresh-machine restore;
7. build a fresh compact destination database from explicit inputs;
8. retain the old database and a kill switch for at least one configured
   provider-retention horizon, never less than 31 days;
9. flip the default only in a later reviewed change after every gate passes.

The compact rebuild command accepts explicit source and destination paths,
refuses production destinations under tests, and never mutates its source. It
reports integrity, foreign keys, row counts, annotation/relationship parity,
source coverage, legacy-only conversations, and cache exclusion.

## Go/no-go gates

Body removal or default-reader cutover is **NO-GO** until all are true:

- Coverage: every conversation is `verified-live-source`,
  `verified-managed-custody`, or `legacy-body-only`; legacy-only bodies remain.
- Identity: conversation IDs, parent/workflow links, DAG resume points, old
  block URLs, leak-alert references, annotations, and duplicate-session cases
  survive rebuild.
- Locator: append, partial line, truncation, middle rewrite, prepend, CRLF
  rewrite, rename, replacement, and active/archive movement fail or refresh
  correctly for every provider.
- Parser/performance: historical/current golden corpora pass; parser changes
  have explicit diffs; cold parsing has enforced RSS and concurrency ceilings;
  cold/hot p95 budgets are met.
- Search: randomized parity covers Unicode, punctuation, newlines, and one- or
  two-character queries with zero false negatives; the UI reaches the actual
  full-search route.
- Security: canary secrets are absent from durable metadata, cache, search,
  snippets, SSE, ordinary exports, and browser storage; redaction invalidates
  every derived epoch; custody path and symlink tests pass.
- Recovery: two independent fresh-machine Mandible restores pass without the
  original provider roots; checksums and corruption detection are exercised;
  staged provider reinjection never overwrites collisions.
- Rollout: dual-read parity mismatches are zero or individually reviewed; the
  fresh compact database passes integrity and coverage checks; the legacy
  database remains a working rollback.

## Lane ownership

| Issue | Owned surfaces | Must not own |
|---|---|---|
| `8342ff5` | canonical migration/baseline, source-store/reader/types, structural identity and fallback | FTS/cache DB, custody adapters, log DB, destructive cutover |
| `b04cb64` | disposable cache/search DB, exact verification, search API/CLI/UI | canonical migrations, custody, logs, body deletion |
| `acbd195` | custody store, manifests, archive/export/verify/restore adapters and CLI | canonical migrations, FTS, logs, body deletion |
| `cb49400` | operational log DB, copy-forward, dual-query, retention and reclaim verification | canonical migrations, conversation storage |
| `2389894` | classification, parity audit, compact rebuild, restore drills, reports and kill-switch proof | canonical migrations, live deletion/vacuum, premature default flip |

The integration parent resolves cross-lane API adaptations and runs the full
test suite once after the combined diff stabilizes.

---
Co-Authored-By: Codex (GPT-5) <codex@openai.com>
