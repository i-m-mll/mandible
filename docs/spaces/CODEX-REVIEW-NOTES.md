# Codex Review Integration — Changelog

Changelog of the two Codex review passes (A: custody/export/auth lifecycle; B: P1′
schema) plus one resolved decision, integrated into `UMBRELLA-PLAN.md` and
`DOCUMENT-CUSTODY-DESIGN.md`. Code claims were verified against the clone at
`/tmp/mandible-ux-review.EixOws/mandible-repo/`.

Legend: **Accepted** / **Partially** / **Rejected**.

---

## Resolved decision (was Open Question)

**Documents live on a docs branch, not protected `main`.** Routine document
commits are agent-key-signed linked commits and never hit the auth queue; the auth
queue is invoked only on explicit user-requested promotion of the docs branch into
`main`. **Applied** as a stated decision in `DOCUMENT-CUSTODY-DESIGN.md` §4.0/§4.1,
removed from both docs' Open Questions, and reflected in `UMBRELLA-PLAN.md` §9
(auth flow), §13 (phasing), §14 (resolved note).

---

## Settled design decisions (post-review revision)

These were baked into both planning docs after the reviews, superseding earlier
draft choices where noted:

1. **`spaces.project_id` FK = RESTRICT** (was CASCADE / open). Deleting a project
   must not silently delete its Spaces — Spaces are precious authored state. The
   space-internal cascade (`spaces → items/occurrences/edges/blocks`) stays
   CASCADE. `UMBRELLA-PLAN.md` §3.1, §11.1, §14 (resolved); removed from Open
   Questions.
2. **"manuscript" → "document" everywhere.** The renderer is the **document
   renderer**; the artifact is a **document**. "Space" stays the container term.
3. **Canonical format = MDX (markdown + custom directives), in-band, no mandatory
   sidecar** — **supersedes** the A3 sidecar-manifest design. Block identity,
   refs, embeds, and structure are first-class directive/AST nodes in the text, so
   the text is the single lossless source of truth. Trade-off recorded: MDX is not
   plain-markdown-portable and the UI must adopt an MDX/`remark-directive` renderer
   (`ui/src/sanitize.ts`, `ui/src/views/artifacts.tsx`). Custody §1; A3 marked
   PARTIALLY OVERRIDDEN.
4. **Document location on export** = global default repo-relative path + per-repo
   overrides + an **export dialog** that confirms/overrides the location on
   commit/export. Replaces the slug-only `<space-id>.md` scheme. Custody §5.
5. **Custody default = Mandible custody until an explicit user commit.** The
   "auto-track all documents for a repo" feature is **removed**; committing is
   always an explicit user action (the export dialog). Custody §2.2/§3/§5.
6. **HumbleB v1 SHRUNK** = a Space document can be ingested as a HumbleB **source**
   via the existing bridge (contract (1)), under existing umbrella **a8fbc09**.
   Live paragraph-level backrefs + `mandible.space_snapshot.v1` **DEFERRED** to a
   later item. A9 re-scoped; UMBRELLA §10.1, custody §7.
7. **Board columns** = default reuse issue `worker_status`, **plus** custom columns
   defined by a filter predicate or by manually adding specific issues. UMBRELLA
   §12 board child, §14 Q4.
8. **Embed-on-delete behavior = DEFERRED** — not decided now; the document-renderer
   implementer **must prompt the user** when it becomes relevant. UMBRELLA §12
   document child + §14 Q1, custody §9 Q1.
9. **"Document" includes existing repo files** (READMEs, design specs, whitepapers)
   registered as canonical documents (link custody, `repo://<repo>@<ref>/<path>`
   source), not only Mandible-authored prose. Ties to issue **2dc97b8**.
   UMBRELLA §3.5, custody §1.4/§2.2.
10. **Spaces is COMPLEMENTARY to Timeline, not a replacement.** Timeline =
    chronological/time-axis; Spaces = user/agent-structured organizing surface.
    Cross-links to Timeline (41d22a6, dc87eb3) are shared-component/related, never
    "supersedes." UMBRELLA §1, §12 relationships.

---

## Codex Review A — custody / export / auth lifecycle (accept all)

| # | Finding | Verdict | Rationale / doc section |
|---|---|---|---|
| **A1** | Add first-class `space_exports` table; `artifacts` (`UNIQUE(algorithm, content_hash)`) can't model a mutable tracked manuscript | **Accepted** | Verified `artifacts` has `UNIQUE(algorithm, content_hash)` at `src/db.ts:915`. Added `space_exports` DDL (custody §2.1) adapted to Mandible conventions (id/created_at/updated_at, json CHECKs, indexes, explicit ON DELETE, `UNIQUE(repo_id, branch, path)`); added to `METADATA_BACKUP_TABLES`; folded into the document-custody child. UMBRELLA §3.7/§12. |
| **A2** | Docs-branch promotion conflicts with auth-merge branch cleanup; promote via short-lived proxy branch + require linked docs commits | **Accepted** | Verified `cleanup_merged_worktrees` runs after every successful merge (`cli/auth-merge.sh:410`, called at `:630,:744,:757,:807`) and tears down the merged branch's worktree via `dwt`. Specified `promote/docs/<ts>` proxy branch + `--preserve-head-branch` alternative; mandated linked-commit docs commits so promotion trailer verification passes. Added a dedicated promotion-flow child (modifies auth/merge infra → auth request from protected-`main` checkout). Custody §3.2/§4.2, UMBRELLA §9/§12. |
| **A3** | "Lossless markdown" is not lossless; replace with human-canonical Markdown + sidecar manifest; strict anchor grammar; explicit import-conflict policy | **PARTIALLY OVERRIDDEN** (see note below) | **Superseded in part by the MDX decision.** The canonical format is now **MDX (markdown + custom directives)**, fully in-band: block identity, references, embeds, and structure are first-class AST/directive nodes living IN the document text, so the text is itself the single lossless source of truth and **no mandatory sidecar is required** (custody §1/§1.2/§1.3). The **mandatory sidecar manifest** and the `<!-- mb:block … -->` HTML-comment anchor grammar are **overridden** — the round-trip fragility that motivated the sidecar (anchors stripped/reflowed by external formatters; comments can't carry the tree) is resolved by in-band directives. **Still kept:** A3's **import-conflict policy** for externally-edited files (dup id → conflict; new external node → imported block; changed body → external-edit; dropped id → confirm/preview; unknown ref → placeholder), restated against MDX in custody §1.3. |
| **A4** | One shared resource-ref parser (renderer/import/issue-detail/artifacts), supporting `artifact:sha256:`, compact `artifact:`, `repo://`, `mandible://`, markdown links; prefer markdown links with canonical hrefs | **Accepted** | Verified `ui/src/artifact-links.ts` linkifies only bracketed `[artifact:...]` text (`CUSTOM_URI_PATTERN`, line 1) and rewrites existing artifact-like anchor hrefs (`isArtifactLikeRef`, lines 14-22/42-63); does **not** linkify bare `repo://`/`mandible://` text. Specified the shared parser (UMBRELLA §8) and added a foundational `feature/spaces-ref-parser` child (§12). |
| **A5** | Drift detection must check the docs-branch worktree/HEAD/path directly, not reuse commit-pinned artifact materialization | **Accepted** | Verified `src/artifact-content.ts:473` uses `git show <commit>:<path>` for a 40-64-hex pinned ref — returns export-time bytes, never live edits. Rewrote custody §6 with the 4-step live comparison and `space_exports.status` mapping. |
| **A6** | `recoverability` stays a JSON convention; document lifecycle status lives on `space_exports`, not a new artifacts column | **Accepted** | Custody §2.2 states `recoverability` stays in the snapshot artifact's `repo_locator_json`/`reference_json`; lifecycle status is `space_exports.status`. Removed the "first-class `recoverability` column?" open question. |
| **A7** | Auto-track safety: opt-in per repo/project; stable `<space-id>.md` + title in frontmatter; commit only on explicit save/export; block when docs worktree dirty; one managed worktree per repo/branch with serialized writes/lock | **Accepted** | Custody §5 made auto-track opt-in (default off), stable path identity, the three safety rules, and slug collision/rename caveat. |
| **A8** | Untracked export-of-copy = "local file export"; no custody/drift/recovery unless separately snapshotted; `local_only` warning if untracked inside a repo | **Accepted** | Custody §3.3 retitled and restated: no `space_exports` row, `local_only`-style warning for untracked-in-repo. |
| **A9** | HumbleB identity contract: `source_type='artifact'` now, `'document'` only with a logical identity; define `space_snapshot.v1` before live backrefs; parameterize `d25bac5`; ingest repo-authoritative snapshot | **Accepted (v1 scope SHRUNK)** | Custody §7/§7.1 + UMBRELLA §10.1 updated. **v1 HumbleB scope is now SHRUNK** (decided): v1 is **only** "make Space documents ingestable as HumbleB **sources**" through the **existing** Mandible→HumbleB bridge (`humbleb-repo/humbleb/sources/mandible.py`, `docs/mandible_document_bridge.md`) so extracted triples enter RAG queries — contract (1), `source_type='artifact'`, repo-authoritative snapshot, parameterize `d25bac5`; coordinated under the **existing HumbleB umbrella a8fbc09**. The **live paragraph-level backref display** and the `mandible.space_snapshot.v1` apparatus (path (2)) are **DEFERRED to a later, explicitly-deferred item — NOT v1.** A9's identity guidance still holds for that deferred work. Verified `mandible_companion_issue` hard-coded at `humbleb-repo/humbleb/sources/mandible.py:285,:368`. |

---

## Codex Review B — P1′ schema (accept all)

| # | Finding | Verdict | Rationale / doc section |
|---|---|---|---|
| **B1** | Three-table split is justified, not over-engineered; but `space_blocks` ships with the document renderer, not the core migration | **Accepted** | UMBRELLA §3 preamble (verdict block) + §3.8 migration strategy: `space_blocks` deferred to the document-renderer child. |
| **B2** | Apply the same cross-space integrity fix to item/parent refs: composite FKs + inline `UNIQUE(space_id, id)` on items, occurrences, blocks | **Accepted** | UMBRELLA §3.2/§3.3/§3.5: inline `UNIQUE(space_id, id)` on all three; composite FKs `(space_id, item_id)` and self-FK `(space_id, parent_id)` on occurrences and blocks. |
| **B3** | Use INLINE/table-level `UNIQUE` for composite-FK targets, not external `CREATE UNIQUE INDEX` — backup emits table DDL + data but not index DDL | **Accepted** | **Verified** `src/ledger/backup.ts:153-184`: per table it emits only `sqlite_master.sql` (CREATE TABLE, line 155/172) + INSERTs; no standalone index DDL. Converted all uniqueness to inline `UNIQUE(...)`; kept non-unique perf indexes as separate `CREATE INDEX`. UMBRELLA §3 preamble, §3.6, §11.3. |
| **B4** | `space_items` `UNIQUE(space_id, ref_type, ref_id)` so canonical membership can't duplicate | **Accepted** | UMBRELLA §3.2 inline UNIQUE; multiple appearances go via `space_occurrences`. |
| **B5** | `ref_id NOT NULL CHECK(!='')` for all types; external_ref uses normalized URI string (or existing external-ref table IF one exists — verify, don't invent); `CHECK(external_ref ⇒ ref_uri NOT NULL)` | **Accepted (no table repurposed)** | **Verified** `ledger_external_refs` exists (`src/db.ts:1222-1240`) but is an **adapter-sync** table (git-bug import: `entity_type`/`external_id`/`adapter`), not a general external-URI registry. Per the brief's "verify, do NOT invent," I did **not** repurpose it: `external_ref` stores a normalized URI in `ref_id`. Added `CHECK(ref_id != '')` and `CHECK(ref_type != 'external_ref' OR ref_uri IS NOT NULL)`. UMBRELLA §3.2, §11.3, §14 Q6. |
| **B6** | Restrict `space_occurrences.renderer` to `('canvas','board','collection')`; `space_blocks` is the sole document structure; `spaces.default_renderer` may still be `'document'` | **Accepted** | UMBRELLA §3.3 renderer CHECK dropped `'document'`; doc layout goes on `space_blocks.metadata_json`. |
| **B7** | Block item deletion: `ON DELETE RESTRICT` + required `item_snapshot_json` so embeds degrade to resolvable placeholders, not bare SET NULL | **Accepted** | UMBRELLA §3.5: `item_id` FK is `ON DELETE RESTRICT`; added `item_snapshot_json` (object CHECK) populated by the API on embed; replaces the prior `ON DELETE SET NULL`. |
| **B8** | Add query-shaped indexes: `space_items(ref_type, ref_id, space_id)`; partial `(space_id, item_id) WHERE item_id IS NOT NULL` on occurrences/blocks; parent/sort indexes; `space_edges(space_id, source)`/`(space_id, target)` | **Accepted** | UMBRELLA §3.2/§3.3/§3.4/§3.5 + §3.6 index table. Replaced bare `(source)`/`(target)` edge indexes with composite `(space_id, source)`/`(space_id, target)`. |
| **B9** | JSON checks `CHECK(json_valid(x) AND json_type(x)='object')` where metadata is an object | **Accepted** | Applied to every `metadata_json` column and to `item_snapshot_json`. UMBRELLA §3 preamble + all DDL. |
| **B10** | Migration strategy: v83 `spaces_core` (spaces, items, occurrences, edges) together; `space_blocks` in a later migration; all in `METADATA_BACKUP_TABLES`; backup test fails if omitted; add migration tests | **Accepted** | UMBRELLA §3.8 (new) + §12 children: core-four in v83; `space_blocks` with the document child; `space_exports` with custody; migration tests (invalid JSON, dup items, cross-space refs, item-delete cascade, block-delete placeholder, backup classification). |

---

## Claims found inaccurate / nuanced against the clone

Nothing was outright wrong, but two findings were **refined** by verification:

- **B5 — "existing external-ref table."** `ledger_external_refs` *does* exist
  (`src/db.ts:1222-1240`), but it is an **adapter-sync** table, not a general
  external-URI registry. Per the brief, I did **not** repurpose it; `external_ref`
  items store the normalized URI directly in `ref_id`. Recorded as an open question
  (UMBRELLA §14 Q6) rather than an assumed dependency.
- **A4 — linkifier scope.** The doc's phrasing "only handles bracketed
  `[artifact:...]` + existing anchors" is accurate. Note that `isArtifactLikeRef`
  (`ui/src/artifact-links.ts:14-22`) *would* accept a `repo://`/`mandible://` href
  **inside an existing anchor**, but **bare** `repo://`/`mandible://` text is never
  linkified — so the shared-parser need stands as stated.

All other code claims (A1 `UNIQUE(algorithm, content_hash)` at `src/db.ts:915`;
A2 `cleanup_merged_worktrees` at `cli/auth-merge.sh:410`; A5 `git show <commit>:<path>`
at `src/artifact-content.ts:473`; A9 hard-coded `d25bac5` at
`humbleb-repo/humbleb/sources/mandible.py:285,:368`; B3 backup emits table DDL + data
only at `src/ledger/backup.ts:153-184`) were **verified true**.
