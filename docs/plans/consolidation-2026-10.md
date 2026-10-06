# Consolidation implementation spec

## Outcome and scope

Implement the six concrete proposals from the 6 October 2026 source review, against Mandible main `2f8f36d3`, preserving current user-visible behavior, wire payloads, durable identities, digest bytes, and recovery safeguards. Success means fewer independently maintained behaviors. Source-line reduction is a measurement after implementation, not an acceptance target.

The parent owns issues, worktrees, dispatch, integration, and protected delivery. The prior failed runtime handoff belongs to its existing worker. Historical proof-script retirement, the old issue-context route, bulk test deletion, schema migrations, and broader state-management redesign are outside this change.

## 1. Shared issue-detail wire contract

**Decision:** establish one dependency-light TypeScript definition of the issue-detail JSON and its identity/attribution fields. Both server producers and browser consumers import it. Reuse the existing shared `src/contracts.ts` types for artifacts and work units; place the issue-detail family in a focused contract module instead of importing the database-backed projection builder into the browser. Move small prerequisite types when needed rather than copying them. Existing import locations may re-export the canonical declarations.

The actual emitted initial/full payload is authoritative. Reconcile the browser's optional or missing fields (`worker_status`, `issue_branches`, work notes, dependencies, project checkout identity, relationship fields, and artifact pin/version/warning metadata) with the producer. Include public artifact references added by `projectArtifactPublicValue`; do not merely choose one currently incomplete declaration. Keep wire field names, nullability and actual presence unchanged. Keep the initial/full stage distinction and partial-timeline semantics. Do not weaken required fields to accommodate incomplete test fixtures or erase enum types into strings.

**Acceptance:** daemon and browser typechecks use the same declarations; existing issue-detail projection/route and mounted detail tests pass. A representative initial/full projection with attribution and associated artifacts demonstrates the actual serialized contract, including public refs and stage metadata. Update existing fixtures to represent real payloads. No new runtime validation framework is required for this type consolidation.

**Starting points:** `src/ledger/issue-detail.ts`, `src/identity/read-projection.ts`, `src/contracts.ts`, `src/ledger/types.ts`, `ui/src/api.ts`.

## 2. One batch-capable issue-head digest engine

**Decision:** the ledger module owns batched subtree traversal, event collection, canonical ordering and hashing. Single-head reads delegate to that engine. Routes consume the result; remove their independent digest implementation. Preserve the current single-read missing-issue error and batch omission behavior.

Preserve the full digest domain: own events versus transitive descendant events; both relationship tables; deleted-comment filtering; relationship-event inclusion; cycle termination; shared-descendant and self-edge deduplication; cutoff and excluded checkpoint options; empty heads and latest-event fields. Cutoff continues to filter events, not reconstruct historical relationship topology. Preserve JSON field order, payload bytes, and SQLite BINARY-equivalent UTF-8 ordering for tied timestamps. Keep set-based SQL across requested roots rather than replacing the batch path with repeated single calls. Retain supported batch-size/binding behavior.

**Acceptance:** reuse `test/subtree-digests.test.ts` and manifest/cutoff coverage. Before replacing either implementation, capture fixed expected digest values from a deterministic fixture containing tied non-BMP IDs, a nested/shared descendant, a cycle, and an excluded checkpoint/cutoff. Retain those values as regression evidence: comparing the new single wrapper with its own batch engine cannot independently establish compatibility. One bounded query-count check or recorded representative measurement demonstrates that increasing root count does not introduce per-root event queries.

**Starting points:** `src/ledger/issue-heads.ts`, `src/routes/issues.ts:654`, `test/subtree-digests.test.ts`.

## 3. Remove the unmounted Spaces document wrapper

**Decision:** remove the obsolete `DocumentRenderer` fetching/SSE/state component and its exclusive imports, exports, types and CSS. `DocumentBlockEditor` remains the registered document renderer. Retain `DocumentBody`, rendering/parsing/sanitization, embedded-reference helpers and their styles: the editor and artifact preview consume them. Delete unused `space-view.css` after confirming no runtime imports; correct documentation pointing to deleted examples.

Do not migrate the obsolete wrapper's request lifecycle into the editor or rename all shared document helpers merely to make filenames uniform. Move any still-relevant mounted behavioral coverage to the existing editor suite; delete wrapper-only assertions whose consumer is gone.

**Acceptance:** no mounted/imported consumer needs the deleted wrapper. Existing document rendering/security/reference tests and representative editor tests establish rendering, editing, collapse persistence, and reconciliation without loss of user state. Existing artifact preview coverage continues to exercise the retained text renderer. Build/typecheck catches stale imports. No snapshot of obsolete wrapper markup is required.

**Starting points:** `ui/src/views/spaces/DocumentRenderer.tsx:538`, `DocumentRenderer.css`, `space-view.css`, `renderers.tsx`, `test/extended/spaces-document-renderer.test.tsx`, `spaces-block-editor.test.tsx`.

## 4. Reuse the keyed-detail hook for artifact requests

**Decision:** use `useKeyedAsyncDetail` for version history, artifact record, content, and knowledge backrefs. It owns cancellation, generations, cache hydration and request state; the artifact view owns selection, deep links, sorting, domain identity checks and error presentation. Remove the four independent request counters/controllers/cache lifecycles.

Preserve the exact cache namespace/key bytes, newest-first version ordering, pinned-versus-latest selection, resolved-record request avoidance, and record/content identity checks for both cached and fetched data. Metadata and content requests remain parallel. A late response cannot replace the current selection. Same-key cached content stays visible during revalidation; navigation must not paint another artifact's content or reset the mounted pane/history state.

The existing hook converts failures to strings, while the view distinguishes a stale saved selection's 404 from a deep-link failure. Preserve that distinction through a small typed hook error channel or typed loader outcome; do not infer status by parsing error messages. Keep content and backref failures separately visible. Hook reuse may extend the hook for a demonstrated missing capability, but must not add a second loading abstraction. Preserve observable pre-paint coherence currently supplied by layout effects; request scheduling may change only if the mounted behavior remains equivalent. Stable loader dependencies must avoid accidental revalidation loops.

**Acceptance:** reuse the keyed-detail and artifact-view-state suites, especially late response rejection, removed saved selection versus explicit deep link, pinned history during sidebar refresh, parallel metadata/content requests, and mounted-pane preservation. Add only missing cases for malformed cache identity or structured errors. Check initial paint and cached revalidation through mounted behavior rather than hook-call timing assertions.

**Starting points:** `ui/src/views/artifacts.tsx:532`, `ui/src/hooks/useKeyedAsyncDetail.ts`, `ui/src/detail-cache.ts`, `test/extended/artifact-view-state.test.ts`, `use-keyed-async-detail.test.tsx`.

## 5. Consolidate artifact-recovery dependency scans

**Decision:** share schema enumeration, row capture, identity extraction, canonical deduplication/order and version fingerprint field selection. Keep explicit typed rules for the three targets: logical artifact, artifact version and blob. This is a local recovery mechanism, not a generic ORM or a schema migration.

Preserve the targets' different excluded tables, recognized column names, foreign-key discovery, polymorphic `target_type` filters, association ownership and derived/content-owning classification. Keep full captured row bytes and primary-key order used by recovery packets. Preserve rowid-less behavior explicitly: version/blob scans currently retry without rowid, whereas logical-artifact scan failure currently blocks through its error result. Consolidation must not silently broaden permission to retire data. Unknown references and incomplete scans remain visible and conservative. Original/current version fingerprints use one field projection with identical canonical bytes. Retain transactional drift checks, idempotent retry, backup material, and no-byte-deletion guarantees.

**Acceptance:** reuse `test/artifact-recovery.test.ts` and custody migration coverage. One compact schema fixture, if current coverage lacks it, exercises FK-only and polymorphic references, duplicate discovery, composite/rowid-less identity, logical association ownership, and scan failure. Compare captured dependency classification/identity and fingerprints; demonstrate that content-owning/unknown dependencies still block retirement and state drift still rejects application. No production recovery run is part of this refactor's verification.

**Starting points:** `src/artifact-recovery.ts:876–1108`.

## 6. Shared supervised test-phase execution

**Decision:** extract one test-phase executor around the existing `ProcessGroupSupervisor` and isolated test runtime. Share process-tree RSS collection, monitoring, settlement, cleanup and outcome classification. Runners retain their suite/shard selection, command arguments, labels and reporting conventions.

Keep one caller-owned supervisor across sequential phases. Keep the 950,000 KiB limit and 100 ms sampling defaults. Ordinary phases count the child tree; IAB phases also count parent RSS. Represent this as an explicit measurement input, preserving the existing injectable test seam. Each acquired runtime/timer/process resource must be cleaned up on spawn failure, monitoring failure, interruption and normal completion. A failed `ps` sample is an actionable failure, not zero usage. Preserve process-group termination/escalation, and never start the next phase while prior descendants remain active.

**Acceptance:** extend the existing `test/extended/process-group-supervisor.test.ts` boundary tests to use the shared executor. Cover normal completion/nonzero exit, interruption, RSS termination with a stubborn descendant, and cleanup after spawn/measurement failure. A small fake measurement case distinguishes parent-inclusive accounting. Exercise representative ordinary and IAB entry paths without rerunning the entire extended suite solely to prove extraction. Production handoff supervision is not being redesigned.

**Starting points:** `scripts/run-extended-tests.mjs`, `scripts/run-iab-preview-tests.mjs`, `scripts/process-group-supervisor.mjs`, `scripts/test-runtime-isolation.mjs`.

## Ownership and delivery

Five independently ownable worker lanes are sufficient:

| Lane | Owns | Coordination boundary |
| --- | --- | --- |
| Issue contract | Proposal 1 and producer/consumer fixture corrections | Announces shared exports; owns any changes to `ui/src/api.ts`. |
| Issue heads | Proposal 2 and digest/manifest evidence | Owns ledger head engine and route head consumers. |
| Detail UI | Proposals 3 and 4 with their mounted tests | One owner for document helpers used by artifact preview; requests API type edits from Issue contract if needed. |
| Recovery scans | Proposal 5 and data-preservation evidence | Owns recovery implementation; no live recovery or runtime handoff work. |
| Test phases | Proposal 6 and process-boundary evidence | Keeps production supervisor consumers stable; coordinates any necessary shared-supervisor change with the runtime worker. |

The contract and digest lanes have first priority. The other lanes can proceed independently against the agreed behavior. Workers own implementation choices within these boundaries and return removed independent behaviors, verification results, and residuals. They use user-visible threads and issue-linked `wt` worktrees. The parent integrates all lanes into one candidate and resolves any shared-file changes.

After integration stabilizes, run repository-required type/build/default gates and the relevant retained extended tests once. The parent owns the required exact-candidate production daemon plus packaged desktop gate, including representative interaction and launch-log assessment. Record the exact tested revision and convergence/operator requirements before protected auth submission. This planning pass ran no tests and changed no repository or live runtime state.

## Dependency and precedent decisions

The installed TypeScript, Preact, SQLite wrapper and process supervisor already supply the needed mechanisms; add no dependency for these six changes. Type-only imports permit shared declarations without introducing runtime imports ([TypeScript](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-3-8.html)). Recursive `UNION` provides deduplicated traversal ([SQLite](https://www.sqlite.org/lang_with.html)); schema introspection and rowid-less identity remain SQLite concerns ([PRAGMA](https://www.sqlite.org/pragma.html), [WITHOUT ROWID](https://www.sqlite.org/withoutrowid.html)). Preact distinguishes pre-paint layout effects from ordinary effects, which makes observable artifact paint coherence an acceptance boundary ([Preact](https://preactjs.com/guide/v10/hooks/)). Child-process exit, close and error events have distinct semantics; the existing supervisor remains the authority for process-group settlement ([Node child-process API](https://nodejs.org/download/release/v26.8.2/docs/api/child_process.html)).

Co-Authored-By: Codex (GPT-5) <codex@openai.com>
