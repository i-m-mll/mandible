# Compact conversation cache implementation design

Delivery: [issue:fc18cb7], one integration branch and one protected approval. Baseline main 282088f8. Source transcripts and existing source/position-space identities remain authoritative; preserve the Chat behavior delivered by [auth:fd8ae8ad]. This design selects the engine and transition. Revisit them only if implementation supplies a specific contradictory result.

## Decision

Retain SQLite/WAL and replace renderer-shaped JSON with one typed, compact source/presentation index. Use the existing pinned Bun 1.4.3 and stock SQLite boundary. No new database or serialization dependency is needed.

SQLite directly supports the actual access patterns: ordered positions, parent and result-owner lookup, bounded vectors of source locations, complete presentation scans, atomic publication across related tables, and concurrent process snapshots. The observed waste comes from large JSON records stored as WITHOUT ROWID keys, rather than an established SQLite throughput limitation. Small typed rows remove that mismatch.

LMDB is a credible alternative: its primary implementation supports multi-process MVCC and sorted keys, and lmdb-js supports Bun. It would require explicit secondary-index/key encoding and another native runtime/package qualification, without a demonstrated capability or performance gap to close here. Custom binary/mmap files would require application-owned atomic publication, reader lifetime and reclamation; RocksDB introduces LSM compaction machinery for a workload not shown to need its write throughput. Neither is preferable for this delivery. Do not conduct a speculative engine bake-off.

## Canonical facts and storage boundary

The canonical persistent model is **source coordinates plus presentation facts**, not `DisplayActivityItem`, `ToolPresentation`, `ReadingPlanMember`, or another renderer object. Define it once in a conversation-index contract module. The source indexer and the v18 converter both produce that model; the SQLite writer accepts it; complete and bounded readers return it; presentation consumes it directly. A renderer object is constructed only when its body is hydrated. Do not expand compact rows into the old large objects merely to satisfy existing internal signatures.

| Ownership | Contract |
| --- | --- |
| Publication scope | Conversation/source version, parser/normalization/redaction epochs, provider/native session scope, counts and ready/building state. Scope values occur once per generation. Source ledger publication remains separate. |
| Block position | Extend the existing compact block row with required position facts. Keep position/type/role/parent/native offsets in one place; store the unchanged 32-byte revision digest as BLOB. Native item/tool/turn identity components, completion classification and usage are typed optional values; reference shared scope rather than persist JSON compound keys. No separate copy of position or speaker in position JSON. |
| Display fragment | Key is generation + source position + typed part kind/ordinal. Store only activity subtype, required status/detail/summary flags, identity/disclosure recipe and genuinely needed source-dependent semantic facts. Pair tool results through owner positions. Generate fragment IDs, source IDs, member keys, prefixes, icons, phrases, defaults and empty values at their consuming boundary. |
| Variable collections | Small typed child rows for real multi-valued facts: operation category/count, ordered execution forwarding/shell facts, genuine multiple native identity/disclosure components. Every owned child table carries generation ownership. Native strings remain lossless and opaque where the provider defines them; do not assume every ID is a UUID or replace exact identity with a truncated hash. |
| Derived plan | Build activity-run summaries, counts, speaker/action grouping and source membership from the compact index. Reuse one in-memory result per current publication as today. Retain a materialized ownership/scope field only when it enables a required bounded lookup; do not store a second complete renderer or plan. |

Retain the existing semantic content-hash algorithm, merely changing its storage from 64-character hex to its identical 32-byte digest. Recomputing hashes would require reading source bodies absent from the structural index; replacing the dependency-proof scheme is unnecessary for this delivery. Preserve externally observed key strings exactly by sharing identity/disclosure constructors across indexed, live and hydrated paths. Exceptional key forms must be represented from actual current provider cases and verified by round-trip equality; no guessed prefix stripping or opaque whole-object escape hatch.

Use WITHOUT ROWID for genuinely small composite-key numeric rows, including the existing source directory. Use ordinary rowid storage for any remaining variable-length value table; do not put a large string/BLOB inside a WITHOUT ROWID record again. Long text is source material and stays outside this cache. Encode enum/flag domains centrally with exhaustive conversion; SQL constraints and schema revision protect invalid encodings. Null/default storage replaces repeated JSON keys and empty arrays. Avoid generic EAV/property bags, generic compression, universal string-interning frameworks, and a second schema definition in preview code.

Generalize shared activity summarization to consume typed semantic facts, with one projection from hydrated display items. Both complete manifests and bounded display-context reads use that same rule. UI reading rows, grouping, source targets, disclosure state, final-response classification, action scope, token accounting and live-to-persisted identity must remain equivalent. Changes to internal/wire type shape are permitted where both ends are updated together; stable user/source identity is the contract.

## Storage and publication APIs

Keep `ConversationStructureCache` as the engine boundary, retaining its source lookup/read-session operations. Replace its presentation read/write internals with the canonical facts contract. Expose one publication writer supporting begin, bounded batch append, validate/complete, and discard/restart of an incomplete generation. Readers select **ready** generations only. A generation's header and child rows become readable together when its ready marker commits. Normal fresh indexing, append publication and conversion share this writer and completeness checks.

For source appends, reuse the proven prefix through existing generation semantics and derive the changed tail once. Preserve late tool-result updates to prior owners, final-status changes, and their dependency revisions. The cache generation is committed before the existing guarded source-ledger pointer update. Do not pretend cache and ledger WAL files share one transaction: incomplete/unreferenced cache work is disposable; ledger publication must never reference an incomplete index. Keep admitted read snapshots through source hydration and close them promptly.

Publish a small cache-format manifest from the same storage module: schema version, owned table definitions/ownership, and generation-copy/projection operations. A shared projection helper selects exact source generations and copies only owned rows plus required scope metadata. The preview launcher and converter use that contract instead of maintaining their own table inventories. Existing preview extraction work on feature `codex/05e2ae3-preview-cache-projection` supplies relevant behavior; incorporate it once in the delivery, without taking its work-unit/session custody or mutating its running preview.

## One transition

Use one new physical format version, currently v19. There is no ledger schema migration, parser-epoch bump, source-version reassignment, position-space reset, or user-setting migration for this encoding change.

1. Create/validate the new-format schema cheaply. New runtime code reads and writes only the new format. It never serves a mixture of v18 and v19 rows.
2. Extend the existing serialized ingestion-worker preparation path with cache conversion. It reads v18 through a read-only WAL snapshot and converts exact compatible warmed generations into the new canonical facts. Conversion performs no transcript reparse and no source-ledger publication. Use bounded row/byte batches, cooperative scheduling, and incomplete-generation state so HTTP and higher-priority selected-chat work remain responsive.
3. Selected Chat preparation prioritizes conversion of its exact matching warmed generation ahead of background conversion. It waits for that generation's completion through existing readiness behavior, not for the entire cache. There is no “empty conversation” publication during preparation. If there is no compatible warmed generation, use normal source preparation because the necessary index genuinely does not exist. A converter defect is an explicit failure, not a reason silently to discard warmed data and reparse everything.
4. Background work converts remaining usable warmed generations. Persist a checkpoint tied to old format, exact source tuple and new format. On interruption, completed generations remain ready; incomplete work is resumed or replaced deterministically by the single preparation owner. Repeated commands are idempotent. New source ingestion can supersede an older conversion; a stale conversion must not overwrite a newer ready publication or change source pointers.
5. Retire the exact obsolete cache and its owned sidecars only after every usable current warmed generation has been converted or superseded by a complete new one, converter snapshots are closed, and the prior owning runtime/ingestion processes are quiescent under the existing runtime handoff. Defer retirement if an old-format owner is still active. Do not sweep arbitrary `.v*` files, another ledger, a preview directory, or another session's state. The one-time converter is not a permanent alternate read backend.

This is normal approved runtime transition work. Do not modify production now. Before any exceptional live ad-hoc repair, take the required fresh consistent full SQLite online backup into durable storage. All converter and interruption tests use private fixtures/copies; no raw live-file copy that ignores WAL. Qualification must report temporary peak storage as well as steady-state savings. No existing persistent preview is restarted or replaced as part of planning or validation without its explicit lifecycle authorization.

## Remaining empirical choice

Cheap mapping, key construction, default elimination and lossless duplicate removal do not need performance experiments. Retain packed revision hashes and compact source locations/ownership: they avoid body reads and preserve current dependency proofs.

One bounded comparison in the core worker decides **which input-derived semantic facts to persist**. Use representative direct commands, actual nested wrapper scripts, text-dependent detail/summary cases and inline directives. Compare:

- deriving from already-available compact facts;
- deriving when it additionally requires source acquisition/parsing;
- reading the compact persisted fact, including decode and publication maintenance.

Include aggregate bytes and actual reuse during complete planning and bounded row acquisition. Distinguish field selection from Acorn parsing. Derive trivial cases. Persist only the small result that avoids meaningful additional acquisition/processing; a transient per-publication value is preferable when disk persistence adds no measurable benefit. Compare packed flags, not today's 89 MB JSON encoding, and never persist a whole activity object to keep a few facts. If two variants are indistinguishable at the consumer boundary, choose the simpler recomputation path. This comparison is part of implementation, not an additional research lane or engine selection gate.

## Evidence and sparse acceptance

Use one consistent private source-cache snapshot for old/new comparison. Reuse the deterministic provider/activity mix and longest conversations already identified; do not reopen broad corpus research. Before and after must cover the same source tuples and generation set.

- Report main/WAL/SHM bytes, actual allocated bytes, dbstat payload/overflow/unused, migration peak storage and time. Engineering target: at least 75% reduction from the same 4.23 GB corpus (about 1 GB or less). This is a verification target, not a prior measured promise; missing it calls for inspection of the remaining dominant representation, not dropping behavior.
- Measure old/new complete-manifest read+decode+plan, selected 128-row acquisition, generation publication/append, and selected-chat conversion admission. Retain phase timings, rows and source bytes so a faster path cannot hide less work. Use a few fixed repeats to distinguish noise; do not add timing-sensitive CI assertions.
- Compare semantic plans and hydrated rows on representative provider cases and the full available converted corpus where the old stored facts suffice: exact source/member/disclosure identities, grouping, aliases, flags, final-response ownership, usage and dependency behavior. Test outputs, not serialized object shape or UI wording.
- Exercise one concurrent old-reader/new-publication case including a late paired tool result; one interrupted/retried conversion; one stale conversion racing newer ingestion; and selected preview extraction with no unrelated generations. Completeness/readiness and foreign-key checks must hold.
- Reuse existing Chat behavioral tests and perform one real long-chat browser/native check covering initial open, targeted collapsed-member reveal, expanded tool/reasoning content, append and resize/restore continuity. Do not rerun the historical width-calibration experiment: presentation geometry must stay identical.
- Run required type/static/build checks and exact-candidate package/runtime acceptance once on the integrated final candidate. Submit one auth request covering code, conversion and retirement behavior; no per-lane approvals or live repair experiments.

## Minimum worker DAG

Use **two GPT-6.1 Sol medium workers**, each with one delivery. Coordinator owns integration, final evidence/qualification and the single approval; Planner reviews only new design evidence or the finished integrated contract.

**A — Compact source/presentation index, end to end.** Own canonical facts/identity constructors, schema and codecs, shared publication writer, source indexing, complete and bounded readers, and presentation consumers. Run the bounded semantic-fact comparison and include focused behavioral equivalence/append checks. Its first checkpoint fixes the contract, schema ownership manifest and writer/projector signatures so B can proceed; its final checkpoint is the working new-format runtime path.

**B — Version transition and selective projection.** Against A's contract checkpoint, own ingestion-worker conversion/admission/background completion, interruption/idempotence/retirement behavior, and the shared preview projection integration. Produce a private full-cache conversion/size report and the focused lifecycle/projection checks. Reuse the off-main extractor behavior once, with custody left to its original owner. Do not add a parallel projector or legacy runtime reader.

DAG: A contract checkpoint → A implementation and B transition in parallel → one integration → one qualification → one auth request. B may inventory existing worker/projection seams while A fixes the contract. No separate benchmark worker, engine spike, UI redesign lane, or broad review cycle is needed. If the empirical comparison changes a fact's persistence choice, A updates the contract before B freezes the converter; do not create successive production format bumps.

## Primary precedents

- SQLite WAL snapshots, concurrent readers and one writer, including the limit on multi-database atomicity: https://www.sqlite.org/wal.html
- SQLite WITHOUT ROWID guidance and large-row tradeoff: https://www.sqlite.org/withoutrowid.html#when_to_use_without_rowid
- SQLite payload/overflow storage: https://www.sqlite.org/fileformat.html#b_tree_pages
- LMDB's ordered map, MVCC and multiple-process support: https://www.symas.com/lmdb.php
- lmdb-js Bun/Node-API support and transaction interface: https://github.com/kriszyp/lmdb-js
- RocksDB LSM/compaction architecture: https://github.com/facebook/rocksdb/wiki/RocksDB-Overview

Co-Authored-By: Codex (GPT) <codex@openai.com>

## Retirement integration ruling

Use the existing terminal-handoff cleanup mechanism. Add one independent `conversation-cache` obligation to `cleanupHandoff` in `scripts/runtime-handoff.mjs:806`; do not pass a trusted-looking drain Boolean into ingestion and do not give the ingestion worker runtime-lifecycle authority.

The ingestion worker owns conversion coverage. After finishing conversion, it closes every legacy-cache read session, stops scheduling legacy reads, and publishes a small persisted completion receipt: exact owning ledger/cache paths, old-format/file identity and source-generation coverage identity, target format, and checkpoint revision. All usable current warmed generations must be converted or superseded by ready new-format generations. This is cache evidence, not authorization to unlink.

The existing external cleanup helper owns retirement. `cleanupRuntimeHandoff` already acquires installation/observation ownership and verifies an accepted terminal receipt (`:851`). Within that scope, the cache obligation revalidates the journal-bound drain evidence, including the exact old daemon and drained service process identities and their exit. Recovery may reuse the already-verified drain record from its bound prior attempt; do not invent a new requirement that only the latest attempt contain a fresh drain. Combine that evidence with the cache completion receipt, exact installation/ledger/path binding, unchanged old cache identity and completed coverage. Use the existing process-consumer inspection approach for the exact legacy DB/sidecar paths before unlink, rather than scanning an entire directory. Missing coverage or a live reader is pending cleanup, not success. The helper closes its own verification handles and idempotently removes only the exact obsolete owned files. A crash after removal is settled on retry.

**Automatic retry is required.** Extend `runtimeHandoffCleanupWake` (`:833`) with the cache transition's small checkpoint revision/state, in addition to its existing process identity observations. Currently its wake hash only observes process/reason changes; leaving that unchanged would permanently suppress a retry when conversion later completes. The existing auth-hook reconciliation scheduler then reruns cleanup after coverage changes, including across daemon restart. Read one status record for wake calculation; do not rescan the corpus on the daemon event loop. Preserve independent cleanup obligations and their existing journal blockers so cache work does not delay app/package disposal or approved runtime availability.

No new ownership manager, approval, permanent dual-store reader, or separate cleanup daemon is needed. B owns this small worker-evidence → existing-handoff-cleanup seam and its tests: pending coverage later wakes and retires; live old identity/reader defers then wakes; repeat/restart after deletion is unchanged; mismatched ledger/cache identity refuses deletion.

## Checkpoint 90eb81cc boundary clarification

The string-rich `PositionFacts` and `FragmentFacts` shapes are acceptable as derived presentation/read views. They must not force the persistent writer to reverse-engineer strings it just created. Before conversion freezes, distinguish the authoritative write batch containing structured native identity and disclosure recipes from that derived view. Fresh ingestion supplies primitives; `legacyDisplayIndexBatch` is the one conversion-only decoder from v18 strings and proves exact key reconstruction. B calls this adapter and does not duplicate prefix decomposition. Public/member/disclosure strings remain identical at consuming boundaries. No other material issue was identified in this bounded contract review.
