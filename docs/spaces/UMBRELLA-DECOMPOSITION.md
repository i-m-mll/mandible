# Mandible "Spaces" — Umbrella Decomposition Spec

> **Planning artifact only.** Nothing in this document has been written to the
> Mandible ledger: no issues created, no links made, no code changed. All issue
> IDs for the umbrella and its children are `TBD` placeholders to be filled at
> adoption time. This spec is derived from the finalized plan on branch
> `feature/spaces-planning-docs`:
> `docs/spaces/UMBRELLA-PLAN.md` (P1′) and `docs/spaces/DOCUMENT-CUSTODY-DESIGN.md`.
>
> **Canonical document format (settled here):** **Markdown + a small
> non-executable directive grammar (`spaces-doc.v1`)** — *not* full/executable
> MDX. Where the source plan still says "MDX", read it as Markdown + non-exec
> `spaces-doc.v1` directives rendered as data nodes through fixed Preact
> components (no code execution). This is the security-driven decision in the
> custody doc §1.
>
> **Adversarial-review reconciliation (this revision = Round 4).** This
> decomposition has now been reconciled across **three external adversarial
> reviews** (an Opus review, two `/tmp`-grounded codex reviews, and a third
> external GPT‑5.5‑pro review `review2.md`) plus this round's codex+Opus
> critiques and the coordinator's resolution decisions. The accepted findings —
> owned-surface file-pointer corrections, schema/migration fixes, sizing splits
> (the count grows from 19 to **28 children**), DAG/ownership corrections,
> standing acceptance criteria, and cross-link adjustments — are applied
> throughout. Round-3 false alarms (CASCADE-vs-RESTRICT and sidecar-vs-in-band)
> remain resolved: RESTRICT is final and the format is in-band `spaces-doc.v1`
> with no canonical sidecar. The Round-4 changelog is in `CODEX-REVIEW-NOTES.md`
> ("Round-4 reconciliation").

---

## 0. Sizing methodology

Each child must fit **one worker session**: one `feature/spaces-<lane>` branch
(sub-lanes use the `__` separator), one auth request, completable in roughly one
context window. The Round-4 reviews showed several Round-3 children were still
too large or crossed hidden integration surfaces. The final sizing applies these
splits and one new foundational child:

| Plan area | Round-3 | Round-4 decision | Result |
|---|---|---|---|
| **Shared contracts + client + CSS** | (implicit, unowned) | **NEW foundational child** — `src/contracts.ts` Spaces types, `ui/src/api.ts` client helpers, `ui/src/views/spaces/types.ts`, per-component CSS convention | +1 child (C3) |
| Core schema + backup | 1 | keep | C1 |
| Backend API + event enum + seed-evaluator | 1 | keep (gains unified resolver endpoint + idempotency + project-scope validation) | C2 |
| CLI | 1 | **SPLIT** core CLI / block-CLI sub-child (block CLI depends on C11) | C4, C4b |
| Transport + SSE | 1 | keep | C5 |
| Shared resource-ref parser FIX | 1 | keep (drop the C2 dependency) | C6 |
| Filter extraction + seeding + Add-to-Space | 1 | **SPLIT into 3** (predicate contract+evaluator / seed dialog / Add-to-Space) | C7a, C7b, C7c |
| Collection/list renderer | 1 | keep | C8 |
| SpaceCanvas | 2 | keep (nodes / edges) | C9a, C9b |
| Nav/route shell | 1 | keep — **now also owns the `route.tab==='spaces'` render branch + `SpacesViewShell`** | C10 |
| `space_blocks` schema + API | 1 | keep (gains CHECK invariant + cycle/sort-key + detach/degrade) | C11 |
| `spaces-doc.v1` serialization | 1 | **narrowed to grammar/serializer only** (UI rendering → C14b) | C12 |
| Document custody / export | 1 | **SPLIT into 4** (schema+identity / export backend+worktree / drift / dialog+repo-file UI) | C13a, C13b, C13c, C13d |
| Document renderer + block editor | 1 | **SPLIT into 3** (parser/sanitizer pipeline+deps / read-only renderer / block editor) | C14a, C14b, C14c |
| HumbleB ingest-as-source | 1 | keep (under a8fbc09) | C15 |
| Auth-merge / docs promotion | 1 | keep — **auth.ts is a regression TEST, real code is `cli/auth-merge.sh`** | C16 |
| Board/kanban | 1 | keep — **custom-column model resolved (metadata_json, no new table)** | C17 |
| Graph demotion + default-route flip | 1 | keep — **owned surfaces corrected (all fallbacks + nav demote)** | C18 |
| CLAUDE.md / contract reflection (dotfiles) | 1 | keep | C19 |

**Total: 28 children.**

**Round-4 move/ownership summary:**
- The `mandible space block` CLI is a **sub-child** `feature/spaces-cli__blocks`
  of the CLI lane (gated on C11), not folded into the early CLI work.
- Repo-file-as-document registration stays in the custody lane, now in **C13d**
  (the export/repo-file UI child).
- The UI document **rendering** moves out of serialization (C12) into **C14b**;
  C12 is the dependency-light shared grammar/serializer module.
- The promote-edge ledger write **reuses** the existing `POST
  /api/ledger/relationships` route (`src/routes/issues.ts:1160-1216`); no new
  relationship writer.

---

## 1. The umbrella

- **Title:** `Spaces: authored organizing surface for issues, artifacts, and documents`
- **Labels:** `umbrella`, `feature`
- **Repo:** `mandible` (the repo the work pertains to)

### Body (to write into the umbrella description at adoption)

> Spaces is an authored surface for organizing heterogeneous references —
> issues, comments, artifacts, and external docs — into intentional project
> groups, leading ultimately to writing a **document** that pulls results
> together. It is **complementary to Timeline, not a replacement**: Timeline is
> the chronological / global-time-axis view; Spaces is the user/agent-structured
> organizing surface. Both remain primary; any Timeline cross-links are
> shared-component / related, never "supersedes".
>
> **Design summary (settled; see `docs/spaces/UMBRELLA-PLAN.md` and
> `DOCUMENT-CUSTODY-DESIGN.md`):**
> - **One primitive, many renderers.** Canvas, document, board/kanban, and
>   collection/list are four renderers over **one** authored `Space` primitive —
>   not four independent features.
> - **P1′ schema.** Separate the *referenced thing* (`space_items`, canonical
>   membership) from its *visual/document occurrence* (`space_occurrences`), and
>   give document prose first-class blocks (`space_blocks`). Authored edges
>   (`space_edges`) are free-labeled and distinct from the four ledger/artifact
>   relationship systems; promotion to a ledger relationship is always explicit.
>   New tables land as new `MIGRATIONS` entries in `src/db.ts`, each using the
>   **next contiguous version assigned at integration in merge order** (the
>   migration sequence must stay contiguous — `assertMigrationSequence`,
>   `src/db.ts:2020`; main is at **v82**, `src/db.ts:2010`), with **inline
>   `UNIQUE`/composite-FK** constraints (so they survive backup/restore —
>   `src/ledger/backup.ts:153,172` emits table DDL + data but **no** standalone
>   index DDL) and are added to `METADATA_BACKUP_TABLES`. The three
>   migration-bearing children are **strictly serialized** (see §0.1 below).
> - **Document format: Markdown + non-executable `spaces-doc.v1` directives**,
>   fully in-band (no mandatory sidecar); directives render as data nodes through
>   fixed components, no code execution.
> - **Mandible-custody-until-explicit-commit.** A document is Mandible-owned by
>   default; committing to a repo is always an explicit user action via an export
>   dialog (no auto-track, no silent auto-commit).
> - **Docs-branch promotion via a short-lived proxy branch.** Routine doc commits
>   are agent-key linked commits on a long-lived docs branch (never the auth
>   queue); only explicit promotion to protected `main` uses the auth queue, via a
>   throwaway `promote/docs/<ts>` proxy branch so auth-merge cleanup cannot
>   destroy the docs worktree.
> - **HumbleB is deferred to ingest-as-source v1 only** (under umbrella a8fbc09);
>   live paragraph-level backrefs and `mandible.space_snapshot.v1` are explicitly
>   deferred.

### 0.1 Hard sequencing rule — migration-bearing children are serialized

`assertMigrationSequence` (`src/db.ts:2020`) requires the migration versions to
be **contiguous and non-duplicate** at load time; main currently ends at **v82**
(`src/db.ts:2010`). The three migration-bearing children — **C1** (core four),
**C11** (`space_blocks`), **C13a** (`space_exports`) — therefore **CANNOT be
developed or tested in parallel against pre-reserved version numbers**. They are
a **strictly serial chain**:

```
C1 (v83 spaces_core)  ──merge──>  C11 (v84 space_blocks)  ──merge──>  C13a (v85 space_exports)
```

Each migration child **starts only after the prior one has merged**, then takes
the **next contiguous version**. No "parallel migration branches" exist in this
umbrella; the version numbers above are illustrative of order, assigned at
integration, never hard-coded against a parallel branch. (This closes review2's
[Blocker] "migration versioning needs a worker-safe rule": the rule is **serial
chain**, not slot reservation.)

### Standing acceptance criteria (apply to all relevant children)

These are umbrella-wide ACs; each child's own AC list cites the ones that apply.

1. **Route write/auth boundaries (every `/api/spaces` route owner).** Every
   mutating route enforces project-scope validation, guards destructive ops, and
   the child that adds the route also adds its **own** `src/file-rpc-transport.ts`
   allowlist entry (read vs. write allowlisting is explicit and per-route, never
   blanket `/api/spaces*`). Homed in C2 (CRUD/seed/resolver), C11 (`/blocks*`),
   and C13b (export/drift/register routes); C5 owns the SSE plumbing + the
   *base* allowlist convention.
2. **Cross-child test strategy (named owners).** Migration/backup tests (C1, C11,
   C13a); route + per-route file-RPC tests (C2, C11, C13b); SSE-reconciliation
   tests (C5 emits; each renderer asserts no zoom/selection/filter reset on
   reconcile); UI-state-persistence tests (C8, C9a, C9b, C14c, C17);
   renderer-security (sanitizer/iframe) tests (C14a/C14b).
3. **dist/build hygiene (every UI child).** `git ls-files dist ui/dist` must be
   empty (project `CLAUDE.md`); no `dist/`/`ui/dist/` committed on any branch.
4. **Architectural-reflection mandate (backend/auth children: C1, C2, C11, C13a,
   C13b, C16).** Per the project `CLAUDE.md`, actively reflect on the global
   `~/.claude/CLAUDE.md` conventions and, if implicated, file a dotfiles issue.
   The contract-reflection child (C19) owns the dotfiles change itself.
5. **Accessibility / keyboard (both canvas children C9a/C9b and the board child
   C17).** The Dataful-UX a11y contract: keyboard navigation and selection,
   focus management, and accessible affordances on draggable/board surfaces.
6. **Docs-branch worktree lifecycle (export-backend child C13b).** Worktree
   provisioning + lock/serialized-writes + dirty-rejection + path identity +
   `docs_path`/settings storage are explicitly owned by C13b.
7. **Filing-prompt convention.** Child filing prompts say **"protected branch
   (develop if present, else main)"**, not a hardcoded branch — per the global
   `CLAUDE.md`. The live Mandible repo confirms protected = `main` (project
   `CLAUDE.md` "Repo conventions"), so `main` is correct **here** and is used in
   concrete command examples; the convention-correct phrasing is kept so the
   children's prompts are portable.

### Canonical Children table (umbrella body)

| issue | scope | branch | state |
|---|---|---|---|
| TBD | Core P1′ schema + backup (`spaces_core`: spaces/items/occurrences/edges) | `feature/spaces-schema` | pending |
| TBD | Spaces REST API (CRUD + batch + seed + unified ref resolver; owns `src/spaces/events.ts`) | `feature/spaces-api` | pending |
| TBD | Shared Spaces contracts + API client + CSS convention | `feature/spaces-contracts` | pending |
| TBD | `mandible space` core CLI (`cli/space.sh` + `bin/mandible` dispatch) | `feature/spaces-cli` | pending |
| TBD | `mandible space block` CLI sub-child | `feature/spaces-cli__blocks` | pending |
| TBD | File-RPC base allowlist convention + `space:*` SSE plumbing | `feature/spaces-transport-sse` | pending |
| TBD | Shared resource-ref parser FIX (`artifact:sha256:` bug) + unresolved-ref UI | `feature/spaces-ref-parser` | pending |
| TBD | Shared issue-predicate contract + backend evaluator extraction | `feature/spaces-predicate` | pending |
| TBD | Space seed dialog UI | `feature/spaces-seed-dialog` | pending |
| TBD | "Add to Space" affordances (issue/artifact/graph) | `feature/spaces-add-to-space` | pending |
| TBD | Collection/list renderer | `feature/spaces-collection` | pending |
| TBD | SpaceCanvas nodes (occurrences/canvas/shelf/drag/layout/SSE) | `feature/spaces-canvas__nodes` | pending |
| TBD | SpaceCanvas edges (`space_edges` UI + labels + promote-to-ledger) | `feature/spaces-canvas__edges` | pending |
| TBD | Spaces nav/route shell + `SpacesViewShell` + render branch | `feature/spaces-nav-shell` | pending |
| TBD | `space_blocks` schema + blocks API | `feature/spaces-blocks-schema` | pending |
| TBD | `spaces-doc.v1` grammar + serializer (+ ref-parser directive extension) | `feature/spaces-serialization` | pending |
| TBD | `space_exports` schema + repo identity + backup | `feature/spaces-exports-schema` | pending |
| TBD | Export/commit backend + docs-branch worktree + linked-commit + routes | `feature/spaces-export-backend` | pending |
| TBD | Drift / status detection | `feature/spaces-drift` | pending |
| TBD | Export dialog + repo-file-registration UI | `feature/spaces-export-ui` | pending |
| TBD | Directive parser/sanitizer pipeline + package deps | `feature/spaces-doc-pipeline` | pending |
| TBD | Read-only document renderer | `feature/spaces-document-renderer` | pending |
| TBD | Block editor | `feature/spaces-block-editor` | pending |
| TBD | Make Space documents ingestable as HumbleB sources | `feature/spaces-humbleb` | pending |
| TBD | Auth-merge / docs-branch promotion flow | `feature/spaces-docs-promotion` | pending |
| TBD | Board/kanban renderer | `feature/spaces-board` | pending |
| TBD | Graph demotion + default-route flip | `feature/spaces-graph-demotion` | pending |
| TBD | CLAUDE.md / Interface-Contract reflection (dotfiles) | `feature/spaces-contract-reflection` | pending |

### Relationship to existing issues

| Target issue | Title | Edge type (umbrella → target unless noted) | Why |
|---|---|---|---|
| **a8fbc09** | Mandible-HumbleB document and knowledge boundary | `related` | The HumbleB ingest work is coordinated **under** a8fbc09; the deferred HumbleB children already filed there ([0fa21e4], [969781d] in mandible; HumbleB/88dafe5 cross-repo) belong to a8fbc09. Cross-repo links to the HumbleB repo are not supported by Mandible's link graph — reference them with bracket refs in body text only. |
| **de2f8ac** | Spec: Mandible graph workspace and provider/artifact substrate | `references` (+ `related`) | **Downgraded from `implements`.** Spaces *refines and diverges from* the graph-workspace direction de2f8ac specs; `implements` would overstate the fidelity. |
| **2dc97b8** | Project-canonical artifacts and documents for Timeline context | `related` | Registering an existing tracked repo file as a canonical document (UMBRELLA-PLAN §3.5; owned by the repo-file-registration UI child C13d) realizes part of 2dc97b8. **`related`, not `implements`** — no single child faithfully realizes 2dc97b8; the repo-file-registration capability is one facet. |
| **41d22a6** | Project Timeline workspace: shared-axis coordination narrative | `related` | Spaces reuses the Timeline filter component (§6.1) and is **complementary** — explicitly NOT superseding Timeline. |
| **dc87eb3** | Timeline view state, pinning, and saved workspace model | `related` | Same: shared view-state / filter patterns; complementary, never supersedes. |

> **Complementary-not-superseding note (record verbatim on the 41d22a6 and
> dc87eb3 edges):** Spaces does not replace or subsume Timeline. The shared filter
> component is **reuse** (a predicate/filter module consumed by both surfaces), not
> absorption. Timeline's global time axis and Spaces' authored layout are different
> products serving different intents; both remain primary.

> **No sibling `implements` edges.** Do **not** mint ledger `implements` edges
> between sibling children. Inter-child relationships are **DAG dependencies**
> (build order), not ledger relationship edges; the only ledger edges this umbrella
> creates are `parent_child` (umbrella → each child) and the cross-issue edges
> above.

---

## 2. Children (detailed)

> Branch names use the `feature/spaces-<lane>` convention; sub-lanes use the `__`
> separator (the two SpaceCanvas lanes and the block-CLI sub-child). Labels avoid
> `deferred` (these are active scope). `space_blocks` and `space_exports` ship in
> their **own** migrations, not the core `spaces_core` migration (plan §3.8). The
> three migration-bearing children are a **strictly serial chain** (§0.1).

---

### C1 — Core P1′ schema + backup

- **Title:** `Spaces core schema and backup inclusion (spaces_core)`
- **Labels:** `feature`
- **Branch:** `feature/spaces-schema`
- **Scope:** One sequential migration (the **next contiguous `src/db.ts` version
  after 82**, assigned at integration) adding the *core four* tables together —
  `spaces`, `space_items`, `space_occurrences`, `space_edges` — with the exact DDL
  in UMBRELLA-PLAN §3: inline `UNIQUE(...)` constraints and composite FKs (so
  uniqueness survives backup/restore, review B3), object-only `json_valid` CHECKs
  on every `metadata_json`, `ref_id`/`external_ref` CHECKs, the `renderer` CHECK
  that **excludes** `'document'`, and **RESTRICT** on `spaces.project_id` with
  space-internal CASCADE for items/occurrences/edges. All four tables are added to
  `METADATA_BACKUP_TABLES` in the same change. `space_blocks` and `space_exports`
  are explicitly NOT here.
- **Owned surfaces:** `src/db.ts` (one new `MIGRATIONS` entry, contiguous version
  assigned at integration); `src/ledger/backup.ts` (`METADATA_BACKUP_TABLES` at
  lines ~36-66); schema/migration + backup tests under `test/` (vitest).
- **Acceptance criteria:**
  - Migration creates all four tables with the DDL of §3 (inline constraints,
    composite FKs, CHECKs, RESTRICT project FK).
  - All four tables present in `METADATA_BACKUP_TABLES`; a backup-classification
    test **fails** if any of the four is omitted.
  - Migration tests assert: invalid JSON rejected on `metadata_json`; duplicate
    `space_items` (`UNIQUE(space_id, ref_type, ref_id)`) rejected; cross-space
    item/parent/edge refs rejected by composite FKs; deleting an item cascades its
    occurrences; `external_ref` without `ref_uri` rejected.
  - **Inline-UNIQUE-survives-restore:** a test confirms a restored schema
    (round-tripped through the metadata backup, which emits table DDL only) still
    enforces uniqueness — the uniqueness is **inline**, not external-index-only.
  - The migration uses the **next contiguous** version at integration; **first in
    the serial migration chain (§0.1)**, no version hard-coded against a parallel
    branch.
  - Relationship-semantics bright line (§4) documented in the migration comment.
  - **Standing AC:** architectural-reflection (#4).
- **Non-goals:** No `space_blocks`, no `space_exports`, no API/CLI/UI. No membership
  duplication into `artifact_links`.
- **Dependencies:** none (root of the DAG).
- **Sibling-ownership note:** Owns the migration framework entry and the backup list
  for the core four **only** — must NOT add `space_blocks` (C11) or `space_exports`
  (C13a) tables/backup entries; first link of the serial migration chain.

---

### C2 — Spaces REST API (CRUD + batch + seed + unified resolver)

- **Title:** `Spaces REST API: CRUD, batch occurrences, seed, unified ref resolver, and event enum`
- **Labels:** `feature`
- **Branch:** `feature/spaces-api`
- **Scope:** Implement the REST surface of UMBRELLA-PLAN §5.1: spaces CRUD; items
  CRUD; occurrences CRUD **plus** `POST /occurrences/batch` (bulk position writes);
  edges CRUD; and `POST /api/spaces/:id/seed` (accepts the shared predicate JSON,
  **evaluates it backend-side** via the C7a-extracted evaluator against project
  issues + their artifacts, creates `space_items` + optional shelf occurrences).
  Routes are registered via a new `registerSpacesRoutes(router)` exported from
  `src/routes/spaces.ts`, with an import + call wired into `src/index.ts` (~89–123,
  alongside the other `register*Routes(router)` calls — the analog is
  `registerProviderRoutes` imported at `src/index.ts:28`, called at `:106`).
  **Owns the shared event-name enum module `src/spaces/events.ts`** (the frozen
  `space:*` constant set C5 consumes for SSE, and the **event-enum extension
  convention** (§12-events): later route-adding children append their event names
  there — C11 → `space:block:changed`; C13b → `space:export:*`/`space:document:*`).
  **Also owns the unified resource-ref RESOLVER backend endpoint** (review2
  missing-scope [Blocker]): a `GET /api/spaces/resolve?ref=...` (or
  `/api/refs/resolve`) that resolves `mandible://`, `repo://`, artifact, issue,
  and comment refs to a typed resolution result, reusing the existing
  `/api/artifacts/resolve` (`src/routes/providers.ts:203`) and ledger routes
  internally; C6's unresolved-ref UI consumes this. **Project-scoping rules
  (review2 missing-scope):** validate that `issue`/`comment` refs added to a Space
  belong to the Space's `project_id`; `artifact`/`external_ref` may cross project
  boundaries (stated policy). **Idempotency (review2 C2 [Warning]):** seed/add are
  upserts given `UNIQUE(space_id, ref_type, ref_id)` — repeated adds return
  "already present", never a hard failure. Blocks routes are NOT here (C11). The
  graph-selection seed's DB read of `ledger_issue_relationships` is a **backend**
  read here (or a graph-adapter route), never a UI DB read.
  **Self-allowlists its own routes** in `src/file-rpc-transport.ts` per the
  per-route rule (standing AC #1), with destructive ops (DELETE) gated explicitly.
- **Owned surfaces:** `src/routes/spaces.ts` (new); the `registerSpacesRoutes`
  import/call in `src/index.ts` (~28/~106 region); `src/spaces/events.ts` (new —
  shared enum + extension convention); the unified-resolver route; query/data
  helpers (e.g. `src/ledger/spaces.ts`); the C2 routes' own
  `src/file-rpc-transport.ts` allowlist entries; route tests under `test/`.
  Consumes the C7a-extracted backend predicate evaluator and C3 Spaces contract
  types.
- **Acceptance criteria:**
  - All §5.1 routes except `/blocks*` implemented and tested (happy path +
    validation failures: cross-space refs, malformed metadata, missing space,
    cross-project issue/comment ref rejected).
  - `/occurrences/batch` writes N positions in one transaction; tested.
  - `/seed` evaluates the **C7a-extracted** predicate backend-side and produces
    `space_items` (+ optional shelf occurrences) deterministically and
    **idempotently**; tested against a fixture project.
  - The unified resolver resolves all five ref kinds and returns typed
    resolved/unresolved results; tested.
  - `src/spaces/events.ts` exports the frozen `space:*` enum **and** documents the
    extension convention C11/C13b follow; mutations reference it.
  - Routes register through `registerSpacesRoutes(router)` from `src/index.ts`;
    C2's routes self-allowlist in `src/file-rpc-transport.ts`.
  - **Standing ACs:** route write/auth boundaries (#1); architectural-reflection (#4).
- **Non-goals:** No CLI, no SSE plumbing internals (C5), no `/blocks*` routes (C11),
  no export/drift routes (C13b), no UI. Does **not** extract the predicate
  evaluator (C7a owns that; C2 consumes it).
- **Dependencies:** **C1** (core schema); **C3** (Spaces contract types); **C7a**
  (backend predicate evaluator module). Sequence C7a's evaluator-extraction so C2
  can import it (or land a thin internal evaluator and swap to C7a's module — but
  the canonical owner is C7a).
- **Sibling-ownership note:** Owns `src/routes/spaces.ts`, the `src/index.ts`
  registration, `src/spaces/events.ts`, the resolver route, and the C2 routes'
  allowlist entries; must NOT edit `src/sse.ts` internals (C5), add `/blocks*`
  (C11), or add export/drift routes (C13b).

---

### C3 — Shared Spaces contracts + API client + CSS convention

- **Title:** `Spaces shared contracts, API client helpers, and view CSS convention`
- **Labels:** `feature`
- **Branch:** `feature/spaces-contracts`
- **Scope:** **Foundational shared-contract child** (review2 owned-surface
  [Blocker]: the umbrella omitted `src/contracts.ts` + `ui/src/api.ts`). Owns the
  Spaces type/contract surface that most UI and backend children import:
  - `src/contracts.ts` — Spaces records (`Space`, `SpaceItem`, `SpaceOccurrence`,
    `SpaceEdge`, `SpaceBlock`, `SpaceExport`), request/response shapes, the seed
    predicate request/response, and block/export types. `src/contracts.ts` is the
    explicitly dependency-light shared API/UI module (`src/contracts.ts:1-2`).
  - `ui/src/api.ts` — Spaces client helper functions (the UI already centralizes
    API calls here and imports contract types from `../../src/contracts`,
    `ui/src/api.ts:1-25`).
  - `ui/src/views/spaces/types.ts` — UI-only view types (new `ui/src/views/spaces/`
    directory; it does not exist yet).
  - **CSS convention (review2 collision [Warning]):** establish per-component
    `ui/src/views/spaces/*.css` imports (each Spaces view imports its own
    stylesheet, the way `graph.tsx` imports `@xyflow/react/dist/style.css` at
    `ui/src/views/graph.tsx:9`) — **NOT** edits to the 16k-line global
    `ui/src/style.css` (imported once at `ui/src/app.tsx:82`). Document this as the
    Spaces styling rule so every UI child follows it instead of colliding on
    `style.css`.
  Phase this **right after the API contract is known** (early), so dependent
  children import stable types.
- **Owned surfaces:** the Spaces section of `src/contracts.ts`; the Spaces helpers
  in `ui/src/api.ts`; new `ui/src/views/spaces/types.ts`; the documented
  per-component CSS convention (a `README`/comment + the first `*.css` exemplar);
  contract/type tests where applicable.
- **Acceptance criteria:**
  - Spaces records/request-response/seed/block/export types exist in
    `src/contracts.ts` and round-trip type-check against the C2 route shapes.
  - `ui/src/api.ts` exposes typed Spaces client helpers consumed by the renderers.
  - The per-component CSS convention is documented and demonstrated; no Spaces
    child edits the global `ui/src/style.css`.
  - **Standing AC:** dist hygiene (#3).
- **Non-goals:** No routes (C2), no renderers, no migrations. Does not define the
  event enum (C2) or the directive grammar (C12).
- **Dependencies:** **C2** (the route shapes the contracts mirror) — or co-design
  with C2 and land just after the route signatures are frozen. Foundational for the
  UI children (C8, C9a/b, C10, C14b/c, C17) and the export UI (C13d).
- **Sibling-ownership note:** Sole owner of the Spaces contract types, the
  `ui/src/api.ts` Spaces helpers, and the CSS convention; must NOT add routes (C2)
  or edit `ui/src/style.css`.

---

### C4 — `mandible space` core CLI

- **Title:** `mandible space core CLI surface`
- **Labels:** `feature`
- **Branch:** `feature/spaces-cli`
- **Scope:** Implement the non-block `mandible space ...` subcommands of
  UMBRELLA-PLAN §5.2 as a **shell CLI** (the Mandible CLI is shell-based). Add a
  new `cli/space.sh` and a `space)` dispatch case in `bin/mandible` (dispatch
  table at `bin/mandible:84,112`), plus help/usage text. Subcommands: `create`,
  `list`, `show`, `add-item`, `rm-item`, `place`, `link`, `unlink`,
  `promote-edge`, `seed-from-filter`. **`promote-edge` calls the existing `POST
  /api/ledger/relationships` route** (`src/routes/issues.ts:1160-1216`) — it does
  NOT invent a parallel relationship writer — with `link_type` constrained to the
  9 valid types and issue/comment endpoints only (`src/db.ts:1148-1173`). **When a
  `space_edge` endpoint is an artifact/URI occurrence**, promotion is
  **disabled/skipped** for that edge (ledger edges allow only issue/comment
  endpoints), surfaced as a clear "not promotable" result. Deterministic `--json`
  output. Block subcommands are the **C4b** sub-child.
- **Owned surfaces:** `cli/space.sh` (new); `bin/mandible` dispatch + help
  (`bin/mandible:84,112`); CLI tests under `test/`.
- **Acceptance criteria:**
  - Each non-block subcommand calls the corresponding C2 REST route and round-trips
    deterministic output; `--json` paths tested.
  - `add-item` accepts canonical refs (`issue:<id>`, `artifact:sha256:<hash>`,
    `comment:<id>`, `uri:<...>`) and maps to the correct `ref_type`/`ref_id`.
  - `promote-edge` calls `POST /api/ledger/relationships` with a valid `link_type`;
    artifact/URI-endpoint edges return a "not promotable" result; tested.
  - Dispatch + help land in `bin/mandible` (NOT a `src/cli/space.ts`).
- **Non-goals:** No REST routes (consumes C2); no `block` subcommands (C4b); no
  contract-text edits (C19).
- **Dependencies:** **C2** (REST API for the non-block subcommands). Couples to
  **C9b** (promote-edge shares `link_type` semantics with the canvas promote UI).
- **Sibling-ownership note:** Owns `cli/space.sh` + `bin/mandible` dispatch/help;
  the `block` subcommands are C4b; must NOT add/change REST routes (C2/C11) or edit
  the contract text (C19).

---

### C4b — `mandible space block` CLI sub-child

- **Title:** `mandible space block CLI`
- **Labels:** `feature`
- **Branch:** `feature/spaces-cli__blocks`
- **Scope:** Add the `mandible space block add|edit|rm <space> ...` subcommands to
  `cli/space.sh`, calling the **C11** `/api/spaces/:id/blocks*` routes. Sub-lane of
  the CLI child, gated on C11's blocks API existing.
- **Owned surfaces:** the `block` subcommand handlers in `cli/space.sh` (disjoint
  region from C4's core subcommands); CLI tests for the block subcommands.
- **Acceptance criteria:**
  - `block add|edit|rm` call the C11 `/blocks*` routes and round-trip `--json`;
    tested.
  - Lands after C4's `cli/space.sh` scaffold and C11's blocks API.
- **Non-goals:** No core subcommands (C4); no blocks routes (C11).
- **Dependencies:** **C4** (the `cli/space.sh` scaffold), **C11** (blocks API).
- **Sibling-ownership note:** Owns only the `block` subcommands within
  `cli/space.sh`; coordinate the insertion region with C4.

---

### C5 — File-RPC base allowlist convention + `space:*` SSE

- **Title:** `Spaces SSE events and file-RPC allowlist convention`
- **Labels:** `feature`
- **Branch:** `feature/spaces-transport-sse`
- **Scope:** Wire the `space:*` SSE event family through the existing
  `broadcast(type, data)` helper (`src/sse.ts:185-204` already broadcasts
  arbitrary event strings — the real work is consuming the enum + tests, not new
  SSE infrastructure). **Consume** the shared event-name enum `src/spaces/events.ts`
  frozen by C2 (do not redefine it). Add `/api/knowledge-backrefs` to the
  file-RPC allowlist (needed for the Phase-6 HumbleB return channel; currently
  missing). **Establish the per-route allowlist convention** (standing AC #1): the
  allowlist uses method+path-specific checks (`src/file-rpc-transport.ts:176-235`),
  and **each `/api/spaces` route-adding child self-allowlists its own routes** —
  C5 does NOT blanket-allow `/api/spaces*`. C5 lands the base
  `/api/knowledge-backrefs` entry and the documented convention; C2/C11/C13b add
  their own entries.
- **Owned surfaces:** `src/sse.ts` (broadcast wiring of `space:*` events, ~185-204);
  the `/api/knowledge-backrefs` allowlist entry + the documented per-route
  convention in `src/file-rpc-transport.ts` (`isAllowedFileRpcRoute`, ~176-235);
  SSE + allowlist-convention tests. (Imports the enum from `src/spaces/events.ts`;
  does not own it.)
- **Acceptance criteria:**
  - `space:*` events (from the C2 enum) broadcast on mutations; an SSE-emission test
    asserts a mutation broadcasts the expected event.
  - `/api/knowledge-backrefs` is allowlisted; a sandboxed-route check passes for it
    and still rejects a non-allowlisted route.
  - The per-route allowlist convention is documented; a test asserts blanket
    `/api/spaces*` is NOT used (each route is enumerated by its owner).
  - **Standing AC:** route write/auth boundaries (#1).
- **Non-goals:** No route handlers (C2/C11/C13b), no UI subscription logic, no CLI.
  Does **not** define the event enum (C2) or allowlist the spaces CRUD/block/export
  routes (their owners self-allowlist).
- **Dependencies:** **C2** (the frozen `src/spaces/events.ts` enum + the first
  spaces routes to broadcast from). No cycle (C5 strictly consumes C2's enum).
- **Sibling-ownership note:** Owns SSE wiring + the base allowlist convention +
  `/api/knowledge-backrefs`; must NOT add route handlers or redefine the event enum.

---

### C6 — Shared resource-ref parser FIX + unresolved-ref UI

- **Title:** `Shared resource-ref parser: fix artifact:sha256: linkifier + unresolved-reference UI`
- **Labels:** `feature`, `error`
- **Branch:** `feature/spaces-ref-parser`
- **Scope:** **This is a FIX, not greenfield.** `ui/src/artifact-links.ts:3`'s
  `COMPACT_SHA_ARTIFACT_REF = /^artifact:([0-9a-f]{7,64})$/i` **cannot match**
  `artifact:sha256:<hash>` (the `sha256:` prefix fails the `[0-9a-f]` class) — a
  **live bug** (verified: the regex at `:3` and the bracketed-text-only linkifier
  at `:65-75`). Replace the bracket-only / compact-only linkifier with **one shared
  resource-ref parser** (UMBRELLA-PLAN §8, review A4) used by the renderer, import,
  issue detail, and artifacts UI. It must recognize: `artifact:sha256:<64hex>`
  **and** compact `artifact:<7-64hex>`; `repo://<repo>@<ref>/<path>`;
  `mandible://<repo>/issue/<primary-id>`; and markdown links whose href is any of
  those. It drives an **unresolved-reference UI** (visible placeholder +
  resolve/fix affordance) — refs never silently dropped, **resolving against the
  C2 unified resolver endpoint** (`/api/spaces/resolve`). **This child is a GATE
  before the document renderer (C14b)** and lands the shared parser module that
  C12's directive grammar extends. Directive-node recognition is **not** here — C12
  owns the directive-grammar extension to this same module; C6 only exposes a clean
  extension point.
- **Owned surfaces:** `ui/src/artifact-links.ts` (replaced) → a new shared module
  (e.g. `ui/src/resource-refs.ts`); call-site updates in
  `ui/src/components/ledger/IssueDetail.tsx` and `ui/src/views/artifacts.tsx`
  (**linkify call-site region only** — disjoint from C7c's "Add to Space" region;
  C6 sequences before C7c on these files); import paths; parser unit tests
  including a **regression test** for the `artifact:sha256:` bug.
- **Acceptance criteria:**
  - **Regression test:** `artifact:sha256:<64hex>` now linkifies (the bug is fixed);
    a test asserts the old regex would have failed and the new parser succeeds.
  - Parser recognizes all four ref forms (incl. compact artifact form) as text and
    as markdown-link hrefs; round-trip tests cover each.
  - Edited content prefers markdown links with canonical hrefs (label may change,
    href is authority); covered by a test.
  - Unresolved refs surface a placeholder + resolve affordance resolving against the
    C2 resolver; tested.
  - Existing artifact-link call sites migrated; no regression in artifact linkify.
  - The module exposes a clean **grammar-extension point** that C12 extends for
    `spaces-doc.v1` directive nodes.
  - **Standing AC:** dist hygiene (#3).
- **Non-goals:** No directive grammar (C12); no renderer-library swap (C14a/b); no
  backend resolver (C2 owns the resolver endpoint).
- **Dependencies:** **C2** (the unified resolver endpoint the unresolved-ref UI
  calls — this is the *only* reason C6 touches C2; the parser/linkifier fix itself
  is standalone). Foundational gate for **C12** and **C14b**.
- **Sibling-ownership note:** Owns the shared parser module + its linkify call
  sites; must NOT introduce the `spaces-doc.v1` directive grammar (C12) or adopt the
  document renderer library (C14a). **Sequences before C7c** on `IssueDetail.tsx` /
  `artifacts.tsx` (disjoint regions).

---

### C7a — Shared issue-predicate contract + backend evaluator extraction

- **Title:** `Shared issue-predicate contract and backend evaluator module`
- **Labels:** `feature`
- **Branch:** `feature/spaces-predicate`
- **Scope:** Fix the backend/UI `TimelineIssuePredicate` drift and extract a
  **shared, reusable backend evaluator** (review2 C2/C6 [Blocker]: backend and UI
  predicate types diverge; the evaluator is private). Concretely:
  - Reconcile the predicate **contract**: the backend `TimelineIssuePredicate`
    (`src/types.ts:292-300`) has `label.membership?: TimelineLabelMembershipMode`
    and `kind: LedgerIssueKind`; the UI copy (`ui/src/types/timeline.ts:6-14`)
    lacks `membership` and uses a bare `string` kind. Define one canonical shared
    predicate shape (preserving the Timeline's `TimelineFilterRowSpec` round-trip)
    and align both type sites.
  - Extract the currently-**private** `evaluatePredicate` (non-exported function at
    `src/ledger/timeline-projection.ts:890`, called at `:878/:1012/:1027/:1040/:1071`)
    into a reusable backend module, e.g. `src/ledger/issue-predicate.ts`, that both
    Timeline projection and the Spaces `/seed` endpoint (C2) import — **one
    implementation, not two**.
- **Owned surfaces:** new `src/ledger/issue-predicate.ts` (extracted evaluator);
  the `TimelineIssuePredicate` shape reconciliation across `src/types.ts` and
  `ui/src/types/timeline.ts`; the `timeline-projection.ts` call sites updated to
  import the extracted module; evaluator/contract tests (incl. a Timeline
  round-trip/regression test that the projection result is unchanged).
- **Acceptance criteria:**
  - `evaluatePredicate` lives in a shared module imported by both Timeline
    projection and C2's `/seed`; the Timeline projection output is unchanged
    (regression test).
  - The predicate contract is unified (backend `membership`/`kind` preserved); the
    UI type matches the canonical shape without losing Timeline round-trip.
  - **Standing AC:** dist hygiene (#3).
- **Non-goals:** No seed UI (C7b), no Add-to-Space (C7c), no `/seed` route (C2
  consumes this module). Does not change Timeline behavior beyond the extraction.
- **Dependencies:** none structural on Spaces tables (it is a Timeline refactor);
  lands **before C2's `/seed`** and **before C7b** so both consume the shared
  contract/evaluator.
- **Sibling-ownership note:** Owns the predicate contract + the extracted evaluator
  module; must NOT build the seed dialog (C7b), the Add-to-Space affordances (C7c),
  or the `/seed` route (C2).

---

### C7b — Space seed dialog UI

- **Title:** `Space seed dialog UI (filter-driven seeding)`
- **Labels:** `feature`
- **Branch:** `feature/spaces-seed-dialog`
- **Scope:** Build the Spaces **seed UI**: extract/reuse the shared
  issue-predicate/filter component from the Timeline (`TimelineFilterRowSpec` in
  `ui/src/types/timeline.ts:24-29` — chips + `scope: TimelineIssuePredicate` AST +
  chip-editing UI) into a shared UI module consumable by both the Timeline row-add
  UI and the Spaces seed dialog, **preserving the exact shape so it round-trips
  with Timeline** (predicate field is named `scope`, an AST — not `predicate`).
  Wire the seed dialog to the C2 `/seed` endpoint (backend evaluation lives in C2
  via the C7a evaluator; this child posts the shared predicate JSON). Offer the
  §6.2 seeds ("issue + its artifacts", "graph selection", "label X", "saved
  filter"). The **graph-selection seed reads the graph payload via a BACKEND
  endpoint** (C2 or a graph-adapter route reads `ledger_issue_relationships`,
  §4) — never a UI DB read (review2 C6 [Blocker]).
- **Owned surfaces:** new shared UI filter module (extracted from
  `ui/src/views/timeline.tsx` / `ui/src/types/timeline.ts`); the Spaces seed dialog
  components under `ui/src/views/spaces/`; component tests.
- **Acceptance criteria:**
  - The extracted UI filter module is consumed by **both** Timeline and the seed
    dialog; a test asserts the predicate shape round-trips unchanged for Timeline.
  - The seed dialog posts the shared predicate JSON to C2 `/seed`; covered by a test.
  - Graph-selection seed reads the relationship source via a backend endpoint
    (matches what the graph renders), never a direct UI DB read.
  - **Standing ACs:** UI-state-persistence (#2); dist hygiene (#3).
- **Non-goals:** No backend predicate evaluation (C2/C7a); no Add-to-Space
  affordances (C7c); no renderer/canvas; does not change Timeline view-state
  semantics.
- **Dependencies:** **C2** (`/seed` endpoint + the backend graph-selection read),
  **C7a** (shared predicate contract/evaluator), **C3** (api client + contracts),
  **C10** (nav shell to mount into).
- **Sibling-ownership note:** Owns the extracted UI filter module + the seed dialog;
  must NOT add the issue/artifact/graph Add-to-Space affordances (C7c) or own the
  backend `/seed` evaluator (C2/C7a).

---

### C7c — "Add to Space" affordances

- **Title:** `Add-to-Space affordances on issue, artifact, and graph surfaces`
- **Labels:** `feature`
- **Branch:** `feature/spaces-add-to-space`
- **Scope:** Add "Add to Space" affordances in issue detail, artifact detail, and
  graph node detail (§6.3) — the graph stays a picker, not an editor. **In
  `IssueDetail`, this must flip the action gating, not just add a menu item**
  (review2 C6 [Warning]): the menu only appears when `hasIssueActions` is true
  (`ui/src/components/ledger/IssueDetail.tsx:68-75`), and the current props lack an
  `onAddToSpace` handler (`:26-36`). This child adds the `onAddToSpace` prop to
  `LedgerIssueDetailProps` (`:26-36`) and includes it in the `hasIssueActions`
  boolean (`:68-75`) so Add-to-Space is visible on otherwise read-only issue panes.
- **Owned surfaces:** `ui/src/components/ledger/IssueDetail.tsx` (the `onAddToSpace`
  prop at `:26-36`, the `hasIssueActions` gating at `:68-75`, the menu item — **the
  "Add to Space" region, disjoint from and after C6's linkify call-site region**);
  `ui/src/views/artifacts.tsx` (Add-to-Space header action — disjoint from C6's
  linkify region and C14b's doc-render region); `ui/src/views/graph.tsx` (add
  selected node[s] to the active Space — **before the late graph-demotion child
  C18**); component tests.
- **Acceptance criteria:**
  - "Add to Space" present on issue/artifact/graph surfaces; on `IssueDetail` it is
    visible even on read-only panes because `hasIssueActions` now includes
    `onAddToSpace`; tested.
  - Graph addition targets the active Space without turning graph into the editor.
  - **Standing AC:** dist hygiene (#3).
- **Non-goals:** No seed dialog (C7b); no predicate extraction (C7a); no canvas
  editing (C9a/C9b); no default-route/graph demotion (C18).
- **Dependencies:** **C2** (items API), **C3** (api client), **C6** (sequences
  before C7c on `IssueDetail.tsx`/`artifacts.tsx`), **C10** (nav shell — picking an
  active Space). **Sequences before C18** on `graph.tsx`.
- **Sibling-ownership note:** Owns the Add-to-Space call sites + the `IssueDetail`
  gating flip; must NOT modify the linkifier call sites (C6) or the doc-render path
  (C14b); adds only a "send to space" action in `graph.tsx`.

---

### C8 — Collection/list renderer

- **Title:** `Spaces collection/list renderer`
- **Labels:** `feature`
- **Branch:** `feature/spaces-collection`
- **Scope:** The first usable renderer: a list/tree view that renders **collection
  OCCURRENCES** — `space_occurrences` with `renderer='collection'`, ordered by
  `parent_id`/`sort_key`/`section_id` — with item-only membership (a `space_item`
  with no collection occurrence) shown as an **unplaced shelf** (review2 C7
  [Warning]: ordering/tree state lives on occurrences, not items). Previews,
  add/remove, missing-ref handling (via the C6 parser / unresolved-ref UI), and
  project scoping. View-state (active space, filter UI) follows the Timeline
  localStorage + URL pattern; canonical state stays in SQLite.
- **Owned surfaces:** new `ui/src/views/spaces/` collection view + components (+ its
  own `*.css` per the C3 convention); routing/mount wiring is provided by C10 —
  this child registers its view into the shell; view tests.
- **Acceptance criteria:**
  - Renders collection occurrences (tree via `parent_id`/`sort_key`) with add/remove;
    item-only membership appears as an unplaced shelf, not lost; tested.
  - Missing/unresolved refs render via the shared unresolved-ref UI (C6), never
    silently dropped.
  - View-state persists across tab switch/refresh per the Dataful-UX contract; SSE
    events reconcile without resetting selection.
  - **Standing ACs:** UI-state-persistence (#2); dist hygiene (#3).
- **Non-goals:** No canvas, no document editor, no board; no nav/default-route change
  (C10/C18).
- **Dependencies:** **C2** (API), **C3** (contracts/client), **C6** (unresolved-ref
  UI), **C10** (nav shell). Parallel to C9a/C9b.
- **Sibling-ownership note:** Owns the collection view; must NOT add the top-level
  Spaces nav item or change the default route (C10/C18).

---

### C9a — SpaceCanvas nodes

- **Title:** `SpaceCanvas nodes: occurrences, shelf, drag persistence, layout reuse`
- **Labels:** `feature`
- **Branch:** `feature/spaces-canvas__nodes`
- **Scope:** A **new** editable React Flow canvas (NOT a mutation of
  `ui/src/views/graph.tsx`) — the **node half**: persisted `space_occurrences`
  (x/y/size/z), a **shelf/tray** for unplaced occurrences (`x`/`y` NULL),
  auto-arrange seed via the existing `layoutGraph()` (`ui/src/graph/layout.ts:615`)
  for *initial arrange / re-layout selected / seed-from-graph only* (never on every
  render — the existing graph recomputes layout per render and disables dragging,
  `ui/src/views/graph.tsx:1285` `nodesDraggable={false}`, so the separation is
  load-bearing), optimistic drag + debounced batch write to `/occurrences/batch`
  with an autosave indicator and graceful failure, and **SSE reconciliation that
  does NOT reset zoom or selection**. Persisted positions are the source of truth;
  zoom/scroll/selection are ephemeral (localStorage/URL).
- **Owned surfaces:** new `ui/src/views/spaces/SpaceCanvas.tsx` (node rendering +
  drag + shelf) + node components (+ own `*.css`); may **read**
  `ui/src/graph/layout.ts` (`layoutGraph`) and reuse visual node components, but
  does not modify `graph.tsx`; canvas node tests.
- **Acceptance criteria:**
  - New canvas renders occurrences from the API; drag persists via
    `/occurrences/batch` (optimistic + autosave indicator); tested.
  - Unplaced occurrences render in the shelf, not at the origin.
  - `layoutGraph()` is used only for initial/seed/re-layout, never per-render after
    user moves; covered by a test or assertion.
  - SSE `space:occurrence:moved` reconciles **without resetting zoom/selection**;
    tested.
  - **Standing ACs:** accessibility/keyboard (#5); UI-state-persistence (#2); dist
    hygiene (#3).
- **Non-goals:** Does NOT modify the existing graph view; does NOT demote the graph
  or touch nav (C10/C18); no edges UI (C9b); no document/board.
- **Dependencies:** **C2** (API), **C3** (contracts/client), **C10** (nav shell).
  Parallel to C8; **C9b builds on this lane's canvas shell.**
- **Sibling-ownership note:** Owns the canvas node surface; must NOT edit
  `ui/src/views/graph.tsx` beyond reading shared components; the `space_edges` UI is
  C9b's.

---

### C9b — SpaceCanvas edges

- **Title:** `SpaceCanvas edges: space_edges UI, free labels, promote-to-ledger`
- **Labels:** `feature`
- **Branch:** `feature/spaces-canvas__edges`
- **Scope:** The **edge half** of SpaceCanvas: create/edit/delete `space_edges` with
  **free labels**, and a **promote-to-ledger affordance** that writes a
  `ledger_relationship_edges` row by calling the existing **`POST
  /api/ledger/relationships`** route (`src/routes/issues.ts:1160-1216`) — same
  `link_type` mapping (9 valid types, issue/comment endpoints, `src/db.ts:1148-1173`)
  as the C4 CLI `promote-edge`. For artifact/URI-endpoint edges promotion is
  disabled (not a ledger endpoint). Builds on the C9a canvas shell.
- **Owned surfaces:** edge components within `ui/src/views/spaces/` (edge layer of
  the canvas owned by C9a); edge-editing + promote-to-ledger UI; edge tests.
- **Acceptance criteria:**
  - `space_edges` created/edited with free labels via the C2 edges routes; tested.
  - Promote-to-ledger calls `POST /api/ledger/relationships` with a valid `link_type`
    and issue/comment endpoints; artifact/URI-endpoint edges are not promotable;
    mapping matches the C4 `promote-edge` CLI semantics; tested.
  - SSE `space:edge:created` reconciles without resetting canvas state.
  - **Standing ACs:** accessibility/keyboard (#5); UI-state-persistence (#2); dist
    hygiene (#3).
- **Non-goals:** No node/drag/shelf logic (C9a); no graph demotion/nav (C10/C18);
  no new relationship-writer backend (reuses `/api/ledger/relationships`).
- **Dependencies:** **C9a** (canvas shell), **C2** (edges API), **C3**
  (contracts/client). Couples to **C4** (promote-edge semantics) and reuses the
  existing `/api/ledger/relationships` route.
- **Sibling-ownership note:** Owns the edge layer + promote-to-ledger UI; coordinates
  the `link_type` mapping with the C4 CLI; must NOT own node/drag logic (C9a) or
  write a parallel relationship writer.

---

### C10 — Spaces nav/route shell + `SpacesViewShell` + render branch

- **Title:** `Spaces navigation, route shell, and view render branch`
- **Labels:** `feature`
- **Branch:** `feature/spaces-nav-shell`
- **Scope:** The **early** nav/routing scaffold so the collection+canvas milestone is
  reachable — and, per review2's highest-confidence [Blocker], **the actual
  renderable shell**, not just route+nav. Concretely:
  - Add `'spaces'` to the `Route['tab']` type union (`ui/src/routing.ts:2`) **and**
    the duplicated runtime allow-array (`ui/src/routing.ts:52` — the
    `['auth','artifacts',...]` list used to validate the parsed path).
  - Add a top-level `Spaces` nav item to `primaryNavItems` (`ui/src/app.tsx:990`,
    with the `NavItem` type at `ui/src/app.tsx:150-159`).
  - Add Spaces to `VIEW_SIDEBAR_TABS` (`ui/src/app.tsx:160-168`) if Spaces uses the
    same sidebar mechanics (review2 C10 [Warning]).
  - Add a content-class entry for the Spaces tab at `ui/src/app.tsx:1285` if a
    Spaces-specific content class is needed.
  - **Create `SpacesViewShell`** (new `ui/src/views/spaces/SpacesViewShell.tsx`)
    and add the **`route.tab === 'spaces'` render branch** in `app.tsx` (the render
    branches are at `ui/src/app.tsx:1375-1391` and currently have no Spaces branch)
    that mounts the shell and exposes mount points for collection/canvas/document/
    board (C8, C9a, C14b, C17 register into it).
  **This child does NOT change the default route** and does NOT demote the graph —
  that is C18 (late).
- **Owned surfaces:** `ui/src/routing.ts` (union `:2` + allow-array `:52` — the
  `'spaces'` ADDITIONS only, not the `'graph'` defaults); `ui/src/app.tsx`
  (`primaryNavItems` Spaces ADD at `:990`, `VIEW_SIDEBAR_TABS` Spaces ADD at
  `:160-168`, content-class Spaces ADD at `:1285`, the new `route.tab === 'spaces'`
  render branch near `:1375-1391` — **disjoint ADD regions, co-owned with C18 via
  §5 region split**); new `ui/src/views/spaces/SpacesViewShell.tsx` (+ `*.css`);
  routing/nav/shell tests.
- **Acceptance criteria:**
  - `'spaces'` is a valid `Route['tab']`; both the union (`:2`) and the runtime
    allow-array (`:52`) include it; a routing test asserts `#/spaces` parses.
  - A top-level `Spaces` nav item is present in `primaryNavItems` and routes to a
    **rendering `SpacesViewShell`** (the `route.tab === 'spaces'` branch renders it).
  - The shell exposes mount points consumed by the renderer children; a smoke test
    renders the shell.
  - The **default route is unchanged** (still `graph`); no graph demotion here.
  - **Standing AC:** dist hygiene (#3).
- **Non-goals:** No renderer logic (C8/C9a/C9b/C14b/C17 mount into the shell); no
  default-route flip and no graph demotion (C18).
- **Dependencies:** **C2** (so the shell points at a real backend), **C3**
  (contracts/client + CSS convention). Foundational for **C8** and **C9a**.
  Sequence **C10 before C18**.
- **Sibling-ownership note:** Owns the route-union/allow-array ADD, the nav-item +
  sidebar + content-class ADDs, and the shell + render branch; must NOT flip the
  default route or demote the graph (C18). Co-owns `app.tsx`/`routing.ts` with C18
  via the explicit §5 disjoint-region split (C10 = Spaces ADDs; C18 = Graph
  demote + default flip).

---

### C11 — `space_blocks` schema + blocks API

- **Title:** `space_blocks schema and blocks API`
- **Labels:** `feature`
- **Branch:** `feature/spaces-blocks-schema`
- **Scope:** Ship the `space_blocks` table in its **own** migration (**second link
  of the serial migration chain (§0.1)** — next contiguous version after the core
  migration merges): DDL with composite FKs, `item_id` `ON DELETE RESTRICT` +
  required `item_snapshot_json`, `block_type` CHECK, object `json_valid` CHECKs,
  inline `UNIQUE(space_id, id)`; **add the invariant
  `CHECK(item_id IS NULL OR item_snapshot_json IS NOT NULL)`** to enforce
  "assigning `item_id` requires a snapshot" at the DB level (review2 + codex
  [Blocker]: the Round-3 DDL only validated the snapshot if present — see
  UMBRELLA-PLAN §3.5, now corrected; convention precedent at `src/db.ts:2602-2607`).
  Add `space_blocks` to `METADATA_BACKUP_TABLES`. Implement the
  `/api/spaces/:id/blocks*` REST routes (deferred from C2), registered through the
  C2-owned `registerSpacesRoutes`/`src/routes/spaces.ts` extension, and
  **self-allowlist them in `src/file-rpc-transport.ts`** (standing AC #1). Block
  mutations emit `space:block:changed` using the C2-owned `src/spaces/events.ts`
  enum (appended per the C2 extension convention). **Owns block parent-cycle
  validation, sort-key generation/normalization, and the detach/degrade operation
  for deleting an item embedded in a block** (ON DELETE RESTRICT + placeholder
  preservation from `item_snapshot_json` — review2 missing-scope: "deleting items
  embedded in blocks needs an API/UX path"). **Block identity / `item_snapshot_json`
  / manifest must agree with the C12 serialization** (HARD dependency, not
  coordination — see DAG).
- **Owned surfaces:** `src/db.ts` (new `MIGRATIONS` entry for `space_blocks`,
  contiguous version at integration); `src/ledger/backup.ts` (add `space_blocks`);
  `/blocks*` handlers in `src/routes/spaces.ts` + their `src/file-rpc-transport.ts`
  allowlist entries; the `space:block:changed` enum append; migration + route +
  backup + cycle/sort-key tests.
- **Acceptance criteria:**
  - `space_blocks` migration with the §3.5 DDL **including
    `CHECK(item_id IS NULL OR item_snapshot_json IS NOT NULL)`**; added to
    `METADATA_BACKUP_TABLES`; backup-classification test fails if omitted; inline
    `UNIQUE(space_id, id)` survives restore (tested).
  - Migration/route tests: cross-space block/parent refs rejected; **assigning
    `item_id` without `item_snapshot_json` is rejected by the new CHECK**; a parent
    cycle is rejected by the API; sort-key generation/normalization is deterministic;
    deleting an embedded item is RESTRICTed and the detach/degrade path preserves
    `item_snapshot_json` as a placeholder.
  - `/blocks*` routes implemented, tested, and self-allowlisted; mutations emit
    `space:block:changed`.
  - **Block identity model agrees with C12** (round-trip), via the hard C12→C11 edge.
  - **Standing AC:** route write/auth boundaries (#1); architectural-reflection (#4).
- **Non-goals:** No document editor/renderer UI (C14b/c); no serialization format
  (C12); no `block` CLI (C4b); no export/custody (C13*).
- **Dependencies:** **C1** (serial migration predecessor — C11 starts after C1
  merges), **C2** (routes scaffold + event enum). **HARD dependency on C12** for the
  frozen block-identity grammar (block id / sort / parent / `item_snapshot_json`
  must match the frozen `spaces-doc.v1` grammar — not "coordination").
- **Sibling-ownership note:** Owns the `space_blocks` table, its backup entry,
  `/blocks*` routes + allowlist, cycle/sort-key/detach logic; second link of the
  serial migration chain; must NOT touch the core-four migration (C1), the `block`
  CLI (C4b), or the serialization format (C12).

---

### C12 — `spaces-doc.v1` grammar + serializer (+ ref-parser directive extension)

- **Title:** `spaces-doc.v1 canonical grammar, serializer, and directive ref parsing`
- **Labels:** `feature`
- **Branch:** `feature/spaces-serialization`
- **Scope:** **Grammar + serializer only — dependency-light, shared backend module**
  (UI rendering moved to C14b). Design and implement the canonical document
  serialization: **Markdown + a small non-executable directive grammar
  (`spaces-doc.v1`)**, fully in-band (no mandatory sidecar). Define the directive
  profile carrying block identity (`id`/`parent`/`sort`/`type`), references, and
  embeds as **data nodes** (no code execution), each with normal-markdown fallback
  content. Implement faithful round-trip `import(export(x)) == x` for the block tree
  + embeds + prose; implement the import-conflict policy (the 5 rows of custody-doc
  §1.3). **Owns the `spaces-doc.v1` directive-grammar EXTENSION to the shared
  resource-ref parser module landed by C6** — extends C6's module to recognize
  refs/embeds as directive nodes. **Publishes a frozen grammar** that C11 (block
  identity) and C14b (renderer) consume.
- **Owned surfaces:** new shared serialization/grammar module (e.g.
  `src/spaces/serialize.ts` and/or a shared `spaces-doc` grammar module);
  directive-grammar definition; the `spaces-doc.v1` extension of the C6 shared
  parser module; round-trip + import-conflict tests. **No UI renderer code** (C14b).
- **Acceptance criteria:**
  - Round-trip test: `import(export(tree)) == tree` for `parent_id`, `sort_key`,
    `block_type`, `item_id` embeds, and prose body.
  - Import-conflict matrix (the 5 rows of custody-doc §1.3) each covered by a test.
  - Directives are non-executable data nodes (no JS eval path); a test confirms no
    executable directive path exists.
  - The C6 shared ref parser recognizes refs both as markdown links and as
    `spaces-doc.v1` directive nodes after this child's extension; tested.
  - The **frozen directive grammar** is published so C14b and C11 consume a stable
    grammar.
  - **Standing AC:** architectural-reflection (#4 — serialization is backend-shaped).
- **Non-goals:** No UI renderer/editor (C14b/c); no `space_blocks` table (C11); no
  export/commit/custody (C13*); no MDX/JSX execution; no parser/sanitizer pipeline
  package deps (C14a).
- **Dependencies:** **C6** (extends the shared parser module C6 landed). **HARD
  dependency edge to C11** (C11 block identity must match this frozen grammar);
  informs **C13b** (custody serializes via this) and **C14b** (renderer consumes the
  frozen grammar).
- **Sibling-ownership note:** Owns the serialization format + the directive-grammar
  extension to C6's parser; must NOT create the `space_blocks` table (C11), the
  parser/sanitizer pipeline + deps (C14a), or the document renderer UI (C14b).

---

### C13a — `space_exports` schema + repo identity + backup

- **Title:** `space_exports schema, repo identity, and backup inclusion`
- **Labels:** `feature`
- **Branch:** `feature/spaces-exports-schema`
- **Scope:** Ship the `space_exports` table (custody-doc §2.1) in its **own**
  migration (**third link of the serial migration chain (§0.1)** — next contiguous
  version after `space_blocks` merges), added to `METADATA_BACKUP_TABLES`, with
  **inline `UNIQUE(repo_id, branch, path)` inside the `CREATE TABLE`** (NOT an
  external `CREATE UNIQUE INDEX` — that DDL is lost on backup/restore,
  `src/ledger/backup.ts:153,172`). **Repo identity = `ledger_project_checkouts.id`**
  (project-scoped, backed up, with root/name/default-branch/remote-url at
  `src/db.ts:1014-1024`) — **NOT `work_repos.id`** (excluded from backup as
  reproducible/runtime state, `src/ledger/backup.ts:70-77`). The `repo_id` column
  references the backed-up checkout identity (and/or stores the full repo locator
  inline); the inline `UNIQUE` is retained (review2 + codex [Blocker]:
  backup-survival of the tracking identity).
- **Owned surfaces:** `src/db.ts` (new `MIGRATIONS` entry for `space_exports`,
  contiguous version at integration); `src/ledger/backup.ts` (add `space_exports`);
  migration + backup tests.
- **Acceptance criteria:**
  - `space_exports` migration with the custody §2.1 DDL using **inline
    `UNIQUE(repo_id, branch, path)`** and `repo_id` keyed to a backed-up identity
    (`ledger_project_checkouts.id`); added to `METADATA_BACKUP_TABLES`; backup test
    fails if omitted.
  - **Inline-UNIQUE-survives-restore** test asserts a duplicate `(repo_id, branch,
    path)` row is rejected after a backup round-trip.
  - Third link of the serial migration chain; no version hard-coded against a
    parallel branch.
  - **Standing AC:** architectural-reflection (#4).
- **Non-goals:** No export/commit backend (C13b); no drift (C13c); no UI (C13d).
- **Dependencies:** **C11** (serial migration predecessor — C13a starts after C11
  merges), **C1** (transitively). Feeds **C13b/C13c/C13d**.
- **Sibling-ownership note:** Owns the `space_exports` table + backup entry only;
  third link of the serial migration chain; must NOT add export/drift/UI logic
  (C13b/c/d) or touch the core/blocks migrations (C1/C11).

---

### C13b — Export/commit backend + docs-branch worktree + linked-commit + routes

- **Title:** `Export-and-track backend: docs-branch worktree, linked commits, and export routes`
- **Labels:** `feature`
- **Branch:** `feature/spaces-export-backend`
- **Scope:** Implement the custody/export **backend**: the deterministic
  `export-and-track` op (custody-doc §3) — serialize to `spaces-doc.v1` (C12), write
  to the managed docs-branch worktree, **commit via the agent-key linked-commit
  path**, record/refresh the `space_exports` row, retain an immutable pre-export
  snapshot artifact. Implement **default custody = Mandible custody until an explicit
  user commit** (no `space_exports` row until then; no auto-track). Implement
  untracked export-of-copy. **Own the docs-branch worktree lifecycle** (provisioning
  + lock/serialized-writes + dirty-rejection + path identity + `docs_path`/settings
  storage — standing AC #6). **Add the export/register/untracked ROUTE surface** to
  `src/routes/spaces.ts` (review2 + codex [Blocker]: C13 omitted routes), registered
  through C2's `registerSpacesRoutes`, **self-allowlisted in
  `src/file-rpc-transport.ts`**, and append `space:export:*`/`space:document:*`
  events to `src/spaces/events.ts` per the C2 extension convention.
  **Linked-commit mechanism (review2 + codex [Warning]):** the repo exposes a
  `mandible commit trailer` helper (`bin/mandible:25` → `cli/ledger-client.sh:317-332`,
  `mandible_commit_trailers`), but there is **no existing `commit-linked`/
  `agent-commit` CLI/API surface in this clone** — this child **owns creating that
  linked-commit surface** (a `commit-linked`/`agent-commit` helper that emits
  `Mandible-Issue:` trailers via `mandible_commit_trailers` and agent-key signs),
  used as the docs-branch commit path. C16 depends on **this child's docs-branch /
  linked-commit contract** (not the dialog or repo-file UI).
- **Owned surfaces:** export/custody backend module (e.g. `src/spaces/export.ts`);
  the docs-branch worktree provisioning/locking + settings storage; the new
  linked-commit helper (`commit-linked`/`agent-commit` surface); the
  export/register/untracked routes in `src/routes/spaces.ts` + their
  `src/file-rpc-transport.ts` allowlist entries; the `space:export:*` event appends;
  export + worktree-lifecycle tests.
- **Acceptance criteria:**
  - No `space_exports` row exists for a document until an explicit user commit; tested.
  - `export-and-track` produces an **agent-key linked commit** carrying a
    `Mandible-Issue:` trailer (via the new linked-commit surface, never bare
    `git commit`); tested.
  - Untracked export-of-copy creates no `space_exports` row; surfaces a `local_only`
    warning if written untracked inside a repo.
  - Commit is blocked when the docs worktree has dirty unrelated changes; serialized
    writes / lock on the managed worktree (standing AC #6).
  - Export/register/untracked routes registered, self-allowlisted, and emit
    `space:export:*` events.
  - **Standing ACs:** route write/auth boundaries (#1); architectural-reflection
    (#4); docs-branch worktree lifecycle (#6).
- **Non-goals:** No `space_exports` migration (C13a); no drift detection (C13c); no
  export dialog / repo-file-registration UI (C13d); no `cli/auth-merge.sh` /
  promotion flow (C16); no serialization format (C12).
- **Dependencies:** **C13a** (the `space_exports` table), **C12** (serialization),
  **C14b** (the renderer it commits from — needs a rendered document; if C14b is not
  ready, the export op can target the serialized form directly, but the editor-driven
  export path needs C14c). **C2** (route scaffold + event enum).
- **Sibling-ownership note:** Owns export-and-track, the docs-branch worktree
  lifecycle, the linked-commit surface, and the export routes; must NOT modify
  `cli/auth-merge.sh` / the promotion proxy-branch flow (C16) or build the export
  dialog UI (C13d).

---

### C13c — Drift / status detection

- **Title:** `Document export drift and status detection`
- **Labels:** `feature`
- **Branch:** `feature/spaces-drift`
- **Scope:** Implement drift detection by inspecting the **live** docs-branch
  worktree/HEAD/path (NOT artifact materialization — `src/artifact-content.ts:473`
  `git show <commit>:<path>` returns pinned export-time bytes and would always
  report "clean", review A5). Implement the 4-step live comparison and the
  `space_exports.status` mapping (custody-doc §6): `clean`/`repo_changed`/
  `worktree_dirty`/`conflict`/`stale`; record `last_seen_commit`/
  `last_seen_content_sha256` on each check. Expose a drift/status read (route added
  in C13b's route surface, or a thin status route this child registers + self-
  allowlists).
- **Owned surfaces:** drift-check backend logic (e.g. `src/spaces/drift.ts`); the
  drift/status read path (coordinated with C13b's route module); drift tests for each
  status transition.
- **Acceptance criteria:**
  - Drift detection reads live worktree/HEAD (not pinned artifact bytes) and sets
    `status` per the §6 table; tested for each status transition.
  - `last_seen_commit`/`last_seen_content_sha256` recorded on each check.
  - **Standing AC:** dist hygiene (#3) where UI is touched (status is read-only here).
- **Non-goals:** No export/commit op (C13b); no schema (C13a); no dialog/repo-file UI
  (C13d).
- **Dependencies:** **C13a** (schema), **C13b** (the export records + worktree it
  inspects). 
- **Sibling-ownership note:** Owns drift/status detection; must NOT own
  export-and-track (C13b), schema (C13a), or UI (C13d).

---

### C13d — Export dialog + repo-file-registration UI

- **Title:** `Export dialog and repo-file-as-document registration UI`
- **Labels:** `feature`
- **Branch:** `feature/spaces-export-ui`
- **Scope:** Build the **export dialog** (custody-doc §5): global default
  repo-relative path + per-repo overrides + per-export confirm/override, resolving
  the location the C13b `export-and-track` writes to. Build the **repo-file
  registration UI + its glue** (moved from the renderer child): register an existing
  tracked repo file as a document with `authority='repo'` / link custody + a
  `repo://<repo>@<ref>/<path>` source ref (custody-doc §1.4, ties to 2dc97b8). **Own
  the custody-aware editor UX rule** (review2 missing-scope): when `authority='repo'`
  and drift is non-clean, the block editor is **read-only/stale** with an explicit
  re-import or fork affordance (this child defines the rule; C14c implements the
  editor gating against it).
- **Owned surfaces:** export-dialog UI + repo-file-registration UI under
  `ui/src/views/spaces/` (+ own `*.css`); `ui/src/api.ts` Spaces export/register
  client calls (added via C3's helper surface — coordinate with C3); the
  custody-aware editor-UX contract doc/flag consumed by C14c; UI tests.
- **Acceptance criteria:**
  - Export dialog resolves global-default + per-repo override + per-export confirm;
    re-export to the same path is idempotent (against C13b).
  - An existing tracked repo file can be registered as a document with
    `authority='repo'` / link custody and a `repo://...` source; tested.
  - The custody-aware read-only/stale rule (authority='repo' + non-clean drift) is
    defined and exposed for C14c.
  - **Standing ACs:** UI-state-persistence (#2); dist hygiene (#3).
- **Non-goals:** No export/commit backend (C13b); no drift logic (C13c); no schema
  (C13a); no block-editor internals (C14c consumes the custody-UX rule).
- **Dependencies:** **C13b** (export op + register glue), **C13c** (drift status the
  UX rule reads), **C3** (api client/contracts), **C10** (nav shell).
- **Sibling-ownership note:** Owns the export dialog + repo-file-registration UI + the
  custody-aware editor-UX rule; must NOT own the export backend (C13b) or the block
  editor internals (C14c).

---

### C14a — Directive parser/sanitizer pipeline + package deps

- **Title:** `Secure non-executable directive parser/sanitizer pipeline (remark-directive)`
- **Labels:** `feature`
- **Branch:** `feature/spaces-doc-pipeline`
- **Scope:** Build the **secure non-executable** document parse/sanitize pipeline:
  a `remark-directive` / `unified` parse path that renders `spaces-doc.v1` directives
  as **data nodes** (no MDX/JSX execution), feeding sanitized HTML via DOMPurify
  (the existing `ui/src/sanitize.ts` is **pure DOMPurify with no `marked` import** —
  `ui/src/sanitize.ts:1-17`; it stays the sanitizer). **This child OWNS
  `package.json` + `package-lock.json`** — it is where the `remark-directive` /
  `unified` dependency is added (review2 + codex [Blocker]: the package has `marked`
  at `package.json:31` and no `remark*`/`unified` deps). Script-enabled iframes stay
  reserved for the standalone artifact preview only.
- **Owned surfaces:** `package.json` + `package-lock.json` (the `remark-directive` /
  `unified` dependency addition — **sole owner**); a new parse/sanitize pipeline
  module (e.g. `ui/src/spaces/doc-pipeline.ts`) consuming the C12 frozen grammar;
  sanitizer/iframe-security tests.
- **Acceptance criteria:**
  - `remark-directive` / `unified` added to `package.json`/`package-lock.json`; the
    pipeline parses `spaces-doc.v1` to data nodes + sanitized HTML.
  - A **security-oriented test** asserts no script execution from a document
    directive (sanitizer/iframe security — standing AC #2); no executable directive
    path exists.
  - **Standing ACs:** renderer-security test (#2); dist hygiene (#3).
- **Non-goals:** No renderer view (C14b); no block editor (C14c); no serialization
  grammar (C12 — this consumes the frozen grammar); no custody (C13*).
- **Dependencies:** **C12** (the frozen directive grammar the pipeline parses), **C6**
  (the shared ref parser). Foundational for **C14b**.
- **Sibling-ownership note:** Sole owner of the package-dependency change and the
  parse/sanitize pipeline; must NOT build the renderer view (C14b) or the editor
  (C14c).

---

### C14b — Read-only document renderer

- **Title:** `Read-only document renderer (consumes spaces-doc.v1 grammar)`
- **Labels:** `feature`
- **Branch:** `feature/spaces-document-renderer`
- **Scope:** Build the **read-only** document renderer over `space_blocks`:
  embedded previews (issue/artifact/comment embeds) rendered through fixed Preact
  components via the C14a pipeline; renders refs (markdown links **and** directive
  nodes) via the C6 parser + C12 grammar, with unresolved refs showing placeholders.
  **Replaces the `marked.parse` document-render call at
  `ui/src/views/artifacts.tsx:687`** with the C14a non-executable pipeline (the
  codex correction: `sanitize.ts` has no `marked`; the `marked.parse` to replace is
  `artifacts.tsx:687`; the ~13 other `marked` callers are out of scope). Also renders
  **repo-authoritative documents** (review2 C14/C13 boundary: a registered repo file
  that is Markdown / `spaces-doc.v1` renders directly).
- **Owned surfaces:** new `ui/src/views/spaces/DocumentRenderer.tsx` (+ own `*.css`);
  the document-render-path change at `ui/src/views/artifacts.tsx:687` (disjoint from
  C6's linkify region and C7c's header-action region); renderer tests.
- **Acceptance criteria:**
  - Renders a `space_blocks` document (read-only) with embeds and prose through the
    C14a pipeline; tested.
  - The `marked.parse` call at `artifacts.tsx:687` is replaced by the non-executable
    pipeline on the document path; a security test asserts no script execution from a
    document directive.
  - Renders refs (markdown links + directive nodes) via the shared parser + C12
    grammar; unresolved refs show placeholders.
  - Repo-authoritative Markdown/`spaces-doc.v1` documents render directly.
  - **Standing ACs:** renderer-security (#2); UI-state-persistence (#2); dist hygiene
    (#3).
- **Non-goals:** No block editing (C14c); no `space_blocks` migration/API (C11); no
  serialization grammar (C12); no parser/sanitizer pipeline deps (C14a); no
  export/custody/repo-file registration (C13*).
- **Dependencies:** **C14a** (parse/sanitize pipeline), **C12** (frozen grammar),
  **C6** (ref parser), **C11** (blocks schema/API for the read), **C3**
  (contracts/client), **C10** (shell mount). Informs **C13b** (export renders this).
- **Sibling-ownership note:** Owns the read-only renderer + the `artifacts.tsx:687`
  swap; must NOT own the pipeline/deps (C14a), the editor (C14c), the serialization
  format (C12), or the blocks API (C11).

---

### C14c — Block editor

- **Title:** `Spaces document block editor`
- **Labels:** `feature`
- **Branch:** `feature/spaces-block-editor`
- **Scope:** Build the block **editor** over `space_blocks`: create/edit/reorder
  blocks, embed issue/artifact/comment items, via the C11 blocks API, rendering
  through the C14b renderer. **Implement the custody-aware editor gating** defined by
  C13d: when `authority='repo'` and drift is non-clean, the editor is
  **read-only/stale** with the re-import/fork affordance. **Embed-on-delete behavior
  is DEFERRED: the implementing agent MUST prompt the user for that decision when it
  becomes relevant — do not pick it unilaterally** (`space_blocks.item_id` is
  `ON DELETE RESTRICT` + `item_snapshot_json` so a placeholder is always *possible*;
  the chosen behavior is the open part).
- **Owned surfaces:** new block-editor components under `ui/src/views/spaces/` (+ own
  `*.css`); editor + custody-gating tests.
- **Acceptance criteria:**
  - Block editor reads/writes `space_blocks` via the C11 API; renders embeds and
    prose through the C14b renderer; tested.
  - Custody-aware gating: when `authority='repo'` + non-clean drift, the editor is
    read-only/stale with a re-import/fork affordance (per C13d's rule); tested.
  - Embed-on-delete is left as a user-prompted decision point, not hardcoded.
  - **Standing ACs:** UI-state-persistence (#2); dist hygiene (#3).
- **Non-goals:** No read-only renderer internals (C14b); no pipeline/deps (C14a); no
  `space_blocks` API/migration (C11); no export/custody backend (C13*).
- **Dependencies:** **C14b** (renderer), **C11** (blocks API), **C13d** (the
  custody-aware editor-UX rule), **C3** (contracts/client), **C10** (shell mount).
- **Sibling-ownership note:** Owns the block editor + custody gating; must NOT own the
  renderer (C14b), the pipeline (C14a), or the export/custody backend (C13*).

---

### C15 — Make Space documents ingestable as HumbleB sources

- **Title:** `Make Space documents ingestable as HumbleB sources`
- **Labels:** `feature`
- **Branch:** `feature/spaces-humbleb`
- **Scope:** **v1 SHRUNK, coordinated under HumbleB umbrella a8fbc09.** Render/export
  a Space document as a SOURCE and feed it through the **existing** Mandible→HumbleB
  bridge (`humbleb-repo/humbleb/sources/mandible.py`,
  `docs/mandible_document_bridge.md`) so its extracted triples enter RAG queries —
  contract (1): `source_type='artifact'`, repo-authoritative exported snapshot.
  Parameterize the hard-coded `mandible_companion_issue = d25bac5`
  (`humbleb-repo/humbleb/sources/mandible.py:285,:368`). **DEFER** live
  paragraph-level backref display and the `mandible.space_snapshot.v1` packet.
- **Owned surfaces:** HumbleB-side adapter changes (`humbleb-repo/humbleb/sources/
  mandible.py`, generalize beyond issue packets, parameterize companion issue;
  `humbleb-repo/tests/test_mandible_adapter.py`); Mandible-side export-as-source glue
  (consuming C13b's export); `knowledge-backrefs` return-channel wiring (allowlisted
  by C5). **Cross-repo:** subagent must read the HumbleB repo's own
  CLAUDE.md/instructions before editing it.
- **Acceptance criteria:**
  - A Space document exports as a repo-authoritative snapshot and ingests through the
    existing bridge as a `source_type='artifact'` source; tested.
  - `d25bac5` is parameterized; HumbleB adapter tests updated.
  - No `mandible.space_snapshot.v1` apparatus and no live block-level backref UI.
  - **Standing AC:** architectural-reflection (#4 — cross-repo bridge).
- **Non-goals:** No `space_snapshot.v1`; no live paragraph-level backrefs; no new
  HumbleB apparatus beyond generalizing the existing bridge.
- **Dependencies:** **C13b** (the repo-authoritative export), **C12**
  (serialization), **C5** (`/api/knowledge-backrefs` allowlisted). Coordinated under
  **a8fbc09** (cross-repo; bracket refs only for the HumbleB-side child).
- **Sibling-ownership note:** Owns the bridge generalization + export-as-source glue;
  must NOT build the deferred snapshot packet or block-level backref UI.

---

### C16 — Auth-merge / docs-branch promotion flow

- **Title:** `Docs-branch promotion via short-lived proxy branch`
- **Labels:** `feature`, `maintenance`
- **Branch:** `feature/spaces-docs-promotion`
- **Scope:** Implement promotion of the long-lived docs branch into the protected
  branch (**develop if present, else main**; verified here = `main`) **without
  destroying the docs worktree**: on explicit promotion, cut a throwaway
  `promote/docs/<ts>` branch from the docs-branch head and submit **that** to the
  auth queue, so `cleanup_merged_worktrees` (`cli/auth-merge.sh:410`, called after
  every successful merge) tears down only the disposable proxy worktree. Optionally
  implement `--preserve-head-branch` (recorded alternative). **Promotion mechanism =
  a `cli/space.sh promote-docs` subcommand** (the helper that cuts the proxy branch
  and submits the auth request). **The `Mandible-Issue:` trailer gate in
  `src/routes/auth.ts` ALREADY rejects bare-commit branches** (verified: the auth
  route's `git log --no-merges` at ~871 and the `Mandible-Issue:` scan at ~893
  reject commits missing the trailer). So **C16's `src/routes/auth.ts` work is a
  REGRESSION TEST, not a code change** — the test asserts a bare-commit docs branch
  is rejected by the existing gate. **The real code change is the
  `cli/auth-merge.sh` proxy/cleanup half** + the `promote-docs` subcommand. **This
  child MODIFIES auth/merge infrastructure (`cli/auth-merge.sh`), so per the global
  rule it submits its OWN auth request from the protected-branch (`main`) checkout**
  so the stored merge command exists on the target branch at merge time. (The
  `cli/space.sh promote-docs` subcommand is owned by the CLI child / C4 surface; C16
  owns the auth-merge half + the regression test and coordinates the subcommand.)
- **Owned surfaces:** `cli/auth-merge.sh` (proxy-branch handling / optional
  `--preserve-head-branch`, `cleanup_merged_worktrees:410` interaction — the **code
  change** half); a **regression test** asserting the existing `src/routes/auth.ts`
  gate rejects a bare-commit docs branch (test only — no `auth.ts` code change); the
  `cli/space.sh promote-docs` subcommand (coordinated with C4); auth-merge tests.
- **Acceptance criteria:**
  - Promotion cuts `promote/docs/<ts>` from the docs-branch head and submits that
    branch; the long-lived docs branch + worktree survive a successful merge (tested
    against the cleanup path).
  - A **regression test** asserts a bare-commit docs branch is rejected by the
    existing `src/routes/auth.ts` `Mandible-Issue:` gate (no `auth.ts` code change).
  - The child's own delivery auth request is submitted from the protected-branch
    (`main`) checkout (documented procedure).
  - **Standing AC:** architectural-reflection (#4 — auth/merge infra).
- **Non-goals:** No custody/export logic (C13*); no document UI; no contract-text
  edits (C19); **no `src/routes/auth.ts` code change** (regression test only).
- **Dependencies:** **C13b** (the docs-branch / linked-commit backend contract — not
  all of C13). Couples to **C4** for the `promote-docs` subcommand surface.
- **Sibling-ownership note:** Sole owner of `cli/auth-merge.sh` changes in this
  umbrella + the auth.ts regression test; must NOT change `src/routes/auth.ts` code
  or duplicate custody/export logic (C13*). **Special handling: the only child whose
  own auth request is submitted from the protected-branch checkout.**

---

### C17 — Board/kanban renderer

- **Title:** `Spaces board/kanban renderer`
- **Labels:** `feature`
- **Branch:** `feature/spaces-board`
- **Scope:** A real board/kanban renderer (NOT a throwaway probe): columns /
  swimlanes / WIP via `section_id` + `sort_key` on `space_occurrences`. **Default
  columns derive from issue `worker_status`.** **Custom columns** are defined either
  by a filter predicate (reusing the C7b shared filter) or by manually adding
  specific issues to a column, and they **PERSIST in `spaces.metadata_json`** — a
  per-Space column-definition object inside the existing `spaces.metadata_json`
  column, **NO new table** (resolves review2's [Blocker] open data-model question;
  `section_id` on occurrences holds the column key, the column *definitions* live in
  `spaces.metadata_json`). This model is fixed now so the child is dispatchable.
- **Owned surfaces:** new `ui/src/views/spaces/SpaceBoard.tsx` + board components (+
  own `*.css`); the `spaces.metadata_json` custom-column read/write (via the C2
  spaces PATCH route — no schema change); board tests.
- **Acceptance criteria:**
  - Default columns derive from issue `worker_status`; tested.
  - Custom columns are filter-defined (via the C7b shared filter) or manual, and
    persist in `spaces.metadata_json` (no new table); membership persists across
    refresh per the Dataful-UX contract.
  - Drag between columns writes `section_id`/`sort_key` via the API; SSE reconciles
    without resetting board state.
  - **Standing ACs:** accessibility/keyboard (#5); UI-state-persistence (#2); dist
    hygiene (#3).
- **Non-goals:** No canvas/document; no nav change (C10/C18); no new column-model
  table.
- **Dependencies:** **C2** (API), **C7b** (shared filter for filter-defined columns),
  **C3** (contracts/client), **C10** (nav shell). Reuses (does not re-extract) the
  C7b shared filter.
- **Sibling-ownership note:** Owns the board view + the `spaces.metadata_json`
  column model; reuses the C7b filter; must NOT re-extract it or add a column table.

---

### C18 — Graph demotion + default-route flip

- **Title:** `Graph demotion to drill-down and default-route change to Spaces`
- **Labels:** `feature`
- **Branch:** `feature/spaces-graph-demotion`
- **Scope:** The **late** nav work: demote the global auto-graph from an always-on
  primary tab to an on-demand drill-down, keeping its debugging perspectives intact
  (`src/routes/graph.ts:31-73`), and **change the default route away from `graph`**
  to Spaces — **only after Spaces is useful** (collection + canvas landed). Per the
  codex correction, the default-`graph` fallbacks are spread across several
  `routing.ts` sites, not a single `:35`:
  - `hashWithSidebarParam` default `'#/graph'` / `'/graph'` (`ui/src/routing.ts:14`
    and `:23`);
  - `parseRouteFromHash` default `'#/graph'` (`:35`), `path ... || 'graph'` (`:37`),
    and the final `: 'graph'` fallback after the allow-array (`:54`).
  - Demote Graph in `primaryNavItems` (`ui/src/app.tsx:990-1044`).
  The nav item + route union already exist (C10); this child flips **all** the
  default fallbacks and demotes the Graph nav item.
- **Owned surfaces:** `ui/src/routing.ts` (the default-`graph` fallbacks at `:14`,
  `:23`, `:35`, `:37`, `:54` — flipped to the Spaces default; **disjoint from C10's
  `'spaces'` union/allow-array ADDs**); `ui/src/app.tsx` (demote the Graph
  `primaryNavItems` entry at `:990-1044` — **disjoint from C10's Spaces nav ADD**);
  graph entry-point demotion in `ui/src/views/graph.tsx` (nav/positioning only —
  **sequences after C7c**, which adds the graph "Add to Space" action); routing tests.
- **Acceptance criteria:**
  - Default route changes to Spaces **only after** collection + canvas exist
    (sequenced last among UI lanes); all of `routing.ts:14/23/35/37/54` reflect the
    new default; a routing test asserts empty/unknown hash → Spaces.
  - Graph demoted to on-demand drill-down in `primaryNavItems`; debugging
    perspectives preserved.
  - The default-route flip is a final, separable commit so it can be held back if
    Spaces isn't yet ready.
  - **Standing AC:** dist hygiene (#3).
- **Non-goals:** No renderer logic; no nav-item/route-union ADD (C10 did that); no
  removal of graph debugging perspectives.
- **Dependencies:** **C8** + **C9a** (Spaces must be useful), **C10** (nav shell +
  the Spaces union/nav ADDs it co-owns), **C7c** (sequences before this on
  `graph.tsx`). **Sequence C10 before C18.**
- **Sibling-ownership note:** Owns the default-route flip (all `routing.ts`
  fallbacks) + the Graph nav demotion + graph entry-point demotion; must NOT re-add
  the Spaces nav item/route union (C10). Co-owns `app.tsx`/`routing.ts` with C10 via
  the §5 disjoint-region split. **Sequences after C7c** on `graph.tsx`.

---

### C19 — CLAUDE.md / Interface-Contract reflection (dotfiles)

- **Title:** `Document the mandible space CLI and docs-branch commit flow`
- **Labels:** `feature`, `maintenance`
- **Branch:** `feature/spaces-contract-reflection` (**dotfiles repo**)
- **Scope:** Propose the `~/.claude/CLAUDE.md` + **Mandible Interface Contract**
  updates implied by Spaces: the `mandible space ...` command surface (contract
  version bump + command list, incl. `block` and `promote-docs`) and the decided
  docs-branch document-commit flow (agent-key linked commits on a docs branch; auth
  queue only on explicit promotion via a proxy branch). Filed in the **dotfiles
  repo**, not Mandible. Do NOT edit the compiled `~/.claude/CLAUDE.md` directly — it
  is a dotfiles change requiring its own feature worktree + auth. **This child owns
  the dotfiles change itself** (standing AC #4: backend/auth children reflect and
  file dotfiles issues; this is where those land).
- **Owned surfaces:** dotfiles-repo source for the Mandible Interface Contract
  fragment and the global `CLAUDE.md` module (the source that compiles into
  `~/.claude/CLAUDE.md`); no Mandible-repo files.
- **Acceptance criteria:**
  - A dotfiles-repo Mandible issue + branch proposes the `mandible space` contract
    additions and the docs-branch commit-flow wording.
  - Contract version is bumped to include the `space` command family.
- **Non-goals:** No Mandible-repo code; no compiled-file direct edits.
- **Dependencies:** **C4/C4b** (CLI surface to document), **C16** (promotion flow +
  `promote-docs` to document). Parallel-able once those are designed.
- **Sibling-ownership note:** The only **dotfiles-repo** child; must NOT edit any
  Mandible-repo file. Cross-repo: read the dotfiles repo's own instructions first.

---

## 3. Dependency DAG

```
C1 spaces-schema (root, migration chain link 1)
 └─> C2 spaces-api  (owns events.ts + resolver; consumes C3 types + C7a evaluator)
      ├─> C3  spaces-contracts        (shared types/client/CSS; co-designed w/ C2)
      ├─> C4  spaces-cli              (core; promote-edge → /api/ledger/relationships)
      │    └─> C4b spaces-cli__blocks (needs C11 blocks API)
      ├─> C5  spaces-transport-sse    (consumes C2 enum; base allowlist convention)
      ├─> C6  spaces-ref-parser (FIX) (resolves vs C2 resolver endpoint)
      │     └─> C12 spaces-serialization (grammar/serializer; extends C6 parser)
      │           ├─> C11 spaces-blocks-schema (HARD edge: block id == frozen grammar)
      │           ├─> C14a spaces-doc-pipeline (parser/sanitizer + package deps)
      │           │     └─> C14b spaces-document-renderer (read-only; swaps artifacts.tsx:687)
      │           │           └─> C14c spaces-block-editor (custody gating from C13d)
      │           └─> C13b spaces-export-backend (serializes via C12)
      ├─> C7a spaces-predicate        (extract evaluator; reconcile predicate types)
      │     ├─> C7b spaces-seed-dialog (posts to C2 /seed)
      │     └─> (C2 consumes the evaluator)
      ├─> C7c spaces-add-to-space     (after C6 on shared files; before C18 on graph.tsx)
      ├─> C8  spaces-collection        (renders collection OCCURRENCES; needs C3,C6,C10)
      ├─> C9a spaces-canvas__nodes     (needs C3, C10)
      │     └─> C9b spaces-canvas__edges (promote → /api/ledger/relationships; couples C4)
      └─> C10 spaces-nav-shell         (early; shell + render branch; C8/C9a mount in)

Migration chain (strictly serial):  C1 ──merge──> C11 ──merge──> C13a

C11 spaces-blocks-schema (chain link 2; needs C1+C2; HARD C12 edge)
 └─> {C4b, C14b, C14c}

C13a spaces-exports-schema (chain link 3; needs C11)
 └─> C13b spaces-export-backend (needs C13a, C12, C14b; owns routes + linked-commit)
      ├─> C13c spaces-drift
      │     └─> C13d spaces-export-ui (dialog + repo-file reg; defines custody-UX rule)
      │           └─> C14c spaces-block-editor (consumes custody-UX rule)
      ├─> C15 spaces-humbleb  (also needs C12, C5 allowlist; under a8fbc09)
      └─> C16 spaces-docs-promotion (auth-merge cleanup half + auth.ts regression test; from main)

C7b ──> C17 spaces-board (custom columns in spaces.metadata_json)
{C8, C9a, C10, C7c} ──> C18 spaces-graph-demotion
{C4, C4b, C16} ──> C19 spaces-contract-reflection (dotfiles)
```

Edge list (X → Y means Y depends on X):
C1→C2; C1→C11 (migration chain); C11→C13a (migration chain);
C2→{C3,C4,C5,C6,C7a,C7b,C7c,C8,C9a,C10,C11}; C3→{C7b,C7c,C8,C9a,C9b,C10,C13d,C14b,C14c,C17};
C4→C4b; C11→C4b; C5→{C15}; C6→C12; C6→{C7c}(file-serialize); C6→C8(unresolved-ref UI);
C7a→{C2(consumes),C7b}; C12→C11(HARD); C12→{C14a,C13b}; C14a→C14b; C14b→{C14c,C13b};
C9a→C9b; C4→C9b(coord); C10→{C8,C9a,C18}; C13a→C13b; C13b→{C13c,C15,C16};
C13c→C13d; C13d→C14c; C7b→C17; {C8,C9a,C7c}→C18; {C4,C4b,C16}→C19.

**Acyclicity:** the former soft C2↔C4 event-name cycle is removed (C2 sole owner of
`src/spaces/events.ts`; C5 strict consumer). **The C3↔C8b bidirectional edge from a
prior draft is removed** — the promote-edge helper is owned by C4 (CLI) and reused
via the existing `POST /api/ledger/relationships`; C9b (canvas edges) and C4 both
*consume* that route, so the relationship is two independent consumers of one shared
route, not a cycle. C11↔C12 is a single HARD directed edge (C12 → C11), not a cycle.
No directed cycles remain.

---

## 4. Suggested phase ordering for dispatch

| Phase | Children | Notes |
|---|---|---|
| **P0** | C1 (migration chain link 1) | Strictly first; the rest of P1 waits on the schema. |
| **P1** | C2; then (C3, C4, C5, C7a, C10 in parallel after C2) | API backbone (events + resolver + seed), contracts/client, CLI core, transport/SSE, predicate extraction, early nav+shell. C3 co-designed with C2. |
| **P2** | C6 (FIX); C7b, C7c (after C6 on shared files); then C8, C9a (parallel, the "usable whole"); C9b after C9a | Ref-parser fix + seed dialog + Add-to-Space; collection + canvas nodes ship together; canvas edges follow. |
| **P3** | C12 (after C6); **C11 (migration chain link 2, after C1 merges + C12 frozen)**; C14a (after C12); C14b (after C14a+C11) | Serialization grammar; blocks schema; parser pipeline + read-only renderer. |
| **P4** | **C13a (migration chain link 3, after C11 merges)**; C13b (after C13a+C12+C14b); C13c; C14c (after C14b+C13d); C13d (after C13c); C16 (after C13b, **from `main` checkout**) | Custody schema/backend/drift/UI; block editor; promotion flow. |
| **P5** | C4b (after C11); C17 (after C7b) | Block CLI sub-child; board renderer. |
| **P6** | C15 (after C13b, under a8fbc09) | HumbleB ingest-as-source v1. |
| **P7 (parallel)** | C18 (after C7c, C8, C9a, C10); C19 (after C4/C4b+C16) | Graph demotion + default-route flip; dotfiles contract reflection. |

The three migration children (C1, C11, C13a) are the spine: **C1 → C11 → C13a**, each
starting only after the prior merges (§0.1). C4b, C17 are parallel-able earlier than
their phase number; the ordering matches plan phasing for reviewer continuity.

---

## 5. Ownership-collision matrix

Shared files touched by more than one child, with the serialization/region rule:

| File | Children | Resolution |
|---|---|---|
| `src/db.ts` (MIGRATIONS) | C1, C11, C13a | **Serial chain** — C1 then C11 then C13a, each takes the next contiguous version after the prior **merges** (`assertMigrationSequence`, `:2020`; main v82, `:2010`). No parallel migration branches. |
| `src/ledger/backup.ts` (`METADATA_BACKUP_TABLES`) | C1, C11, C13a | Serial with the migration chain; each adds only its own table(s). |
| `src/contracts.ts` (Spaces types) | C3 (owns) | Sole owner of the Spaces contract section; others import. |
| `ui/src/api.ts` (Spaces helpers) | C3 (owns), C13d (adds export/register calls via C3 surface) | C3 owns the Spaces helper surface; C13d's export/register calls coordinate through it. |
| `ui/src/views/spaces/*.css` (per-component) | C3 (convention), C8/C9a/C9b/C10/C13d/C14b/C14c/C17 (own files) | **Per-component CSS** convention (C3) — each view imports its own `*.css`; **no child edits the global `ui/src/style.css`**. |
| `src/routes/spaces.ts` | C2 (creates), C11 (`/blocks*`), C13b (export/drift/register routes) | C2 creates + registers via `src/index.ts`; C11 extends `/blocks*`; C13b extends export routes. Each self-allowlists its routes. C11 after C2; C13b after C13a. |
| `src/file-rpc-transport.ts` | C5 (base convention + `/api/knowledge-backrefs`), C2/C11/C13b (each self-allowlists its own routes) | Per-route rule: **each route-adding child adds its own enumerated entries**; C5 owns the documented convention + the base `/api/knowledge-backrefs` entry. No blanket `/api/spaces*`. |
| `src/spaces/events.ts` | C2 (owns + extension convention), C5 (consumes), C11 (`space:block:changed`), C13b (`space:export:*`/`space:document:*`) | C2 creates + freezes the enum + the extension convention; C5 imports; C11/C13b append their event names per that convention. |
| `src/ledger/issue-predicate.ts` (extracted) + `src/types.ts` / `ui/src/types/timeline.ts` (predicate shape) | C7a (owns) | C7a extracts the evaluator and reconciles the backend/UI predicate shape; C2 + C7b consume it. |
| `src/routes/issues.ts` `POST /api/ledger/relationships` | C4 (CLI promote-edge), C9b (canvas promote) | **Reused, not modified** — both call the existing route; no new relationship writer. |
| `src/routes/auth.ts` | C16 (regression test only) | The `Mandible-Issue:` gate already rejects bare-commit branches; C16 adds a regression test, **no code change**. |
| `cli/auth-merge.sh` | C16 | Sole owner (cleanup / proxy-branch half — the real code change). |
| `bin/mandible` + `cli/space.sh` | C4 (core + dispatch), C4b (`block` subcommands), C16 (`promote-docs` subcommand, coordinated) | C4 owns `space)` dispatch + core `cli/space.sh`; C4b adds `block` subcommands (disjoint region); the `promote-docs` subcommand is coordinated between C4 and C16. |
| `ui/src/artifact-links.ts` → `ui/src/resource-refs.ts` | C6 | C6 replaces it; C12 extends the resulting module (grammar only). |
| `ui/src/components/ledger/IssueDetail.tsx` | C6 (linkify call site), C7c (Add-to-Space + `hasIssueActions`/`onAddToSpace` at `:26-36`,`:68-75`) | **C6 before C7c** — disjoint regions: linkify call (C6), Add-to-Space + gating flip (C7c). |
| `ui/src/views/artifacts.tsx` | C6 (linkify call), C7c (header action), C14b (doc render path `:687`) | Disjoint regions: linkify (C6), header action (C7c), `marked.parse:687` swap (C14b). C6 before C7c. |
| `ui/src/views/graph.tsx` | C7c (Add-to-Space action), C18 (demote entry point) | **C7c before C18** — C7c adds the action; C18 demotes the graph entry point. |
| `ui/src/routing.ts` | C10 (union `:2` + allow-array `:52` — Spaces ADDs), C18 (default `graph` fallbacks `:14/:23/:35/:37/:54` — flip to Spaces) | **Disjoint regions; C10 before C18.** C10 adds `'spaces'`; C18 flips every default-`graph` fallback. |
| `ui/src/app.tsx` | C10 (Spaces nav ADD `:990`, `VIEW_SIDEBAR_TABS` ADD `:160-168`, content-class ADD `:1285`, `route.tab==='spaces'` render branch `~:1375-1391`), C18 (demote Graph nav `:990-1044`) | **Co-owned via disjoint regions:** C10 = Spaces ADDs + render branch; C18 = Graph nav demote. C10 before C18. |
| `ui/src/sanitize.ts` | (none — stays pure DOMPurify) | The `marked` swap is at `artifacts.tsx:687` (C14b), **not** `sanitize.ts`. `sanitize.ts` has no `marked` import; no Spaces child edits it. |
| `package.json` / `package-lock.json` | C14a | Sole owner of the `remark-directive`/`unified` dependency addition. |
| `ui/src/spaces/doc-pipeline.ts` + `DocumentRenderer.tsx` | C14a (pipeline), C14b (renderer), C14c (editor) | C14a pipeline → C14b renderer → C14c editor; disjoint modules. |
| `ui/src/views/spaces/SpaceCanvas.tsx` | C9a (nodes), C9b (edges) | C9a lands the canvas shell + node layer; C9b adds the edge layer. C9b after C9a. |
| `humbleb-repo/...` | C15 | Cross-repo, sole owner; read HumbleB CLAUDE.md first. |
| dotfiles `CLAUDE.md` / contract | C19 | Cross-repo, sole owner. |

---

## 6. Cross-link edges to create at adoption

**Umbrella → each child:** `parent_child` (27 in-repo edges + 1 dotfiles). The 27
in-repo children are direct `parent_child` of the Spaces umbrella. C19 is in the
**dotfiles** repo — link by `parent_child` if Mandible supports cross-repo
parent_child for dotfiles; otherwise track it via a bracket ref in the umbrella body
and an `mandible:` namespaced label (cross-repo HumbleB-style limitation).

**Do NOT mint `implements` edges between sibling children.** Inter-child edges are
DAG dependencies (build order), not ledger relationship edges.

**Umbrella ↔ existing issues:**

| Source → Target | Type | Direction note |
|---|---|---|
| Spaces umbrella → a8fbc09 | `related` | a8fbc09 is the HumbleB boundary umbrella; the HumbleB ingest child (C15) is coordinated under a8fbc09. The already-filed deferred HumbleB children [0fa21e4], [969781d] (mandible) live under a8fbc09; HumbleB/88dafe5 is cross-repo (bracket ref only). |
| Spaces umbrella → de2f8ac | `references` (+ `related`) | **Downgraded from `implements`** — Spaces refines/diverges from the graph-workspace spec. |
| Spaces umbrella → 2dc97b8 | `related` | Repo-file-as-document registration (C13d) realizes one facet of 2dc97b8 — `related`, not `implements`. |
| Spaces umbrella → 41d22a6 | `related` | **COMPLEMENTARY, not superseding** — shared filter (C7a/C7b). |
| Spaces umbrella → dc87eb3 | `related` | **COMPLEMENTARY, not superseding** — shared view-state/filter patterns. |

> The C15 HumbleB child should additionally be linked under a8fbc09 (`parent_child`
> or `related`) at its own filing, mirroring the umbrella-level `related` edge.

---

## 7. Open risks / scrutiny points

1. **Migration chain is the critical path (C1 → C11 → C13a).** The three
   migration-bearing children are serialized (§0.1); they cannot parallelize. This
   is the longest must-be-serial spine; everything downstream of a migration child
   waits on its merge. Mitigation: keep each migration child small and
   fast-to-review.

2. **Backend split (C2/C4/C5) coupling.** C2 owns + freezes `src/spaces/events.ts`
   and the per-route allowlist convention; C5 strictly consumes (cycle removed). C4
   is shell-based; its `block` subcommands are the C4b sub-child gated on C11.

3. **Predicate sharing (C7a) is now a real contract child.** The backend/UI
   `TimelineIssuePredicate` drift (`src/types.ts:292-300` has `membership`/typed
   `kind`; `ui/src/types/timeline.ts:6-14` lacks them) and the private evaluator
   (`src/ledger/timeline-projection.ts:890`) are fixed by C7a extracting one shared
   `src/ledger/issue-predicate.ts`; C2 `/seed` and C7b both consume it. A Timeline
   round-trip regression test guards the extraction.

4. **Document lane (C11/C12/C14a/C14b/C14c) + custody (C13a–d).** C12 is
   grammar/serializer only (dependency-light); C14a owns the parser/sanitizer
   pipeline + package deps; C14b is read-only render; C14c is the editor. The
   C12→C11 block-identity edge is **HARD**, not coordination. Custody is split into
   schema (C13a) / backend+worktree+linked-commit+routes (C13b) / drift (C13c) /
   dialog+repo-file UI (C13d).

5. **C16 special handling (auth/merge infra).** The `src/routes/auth.ts`
   `Mandible-Issue:` gate **already** rejects bare-commit branches — C16's auth.ts
   work is a **regression test**, and the real code is the `cli/auth-merge.sh`
   proxy/cleanup half + the `cli/space.sh promote-docs` subcommand. Its own delivery
   auth request is submitted **from the protected-branch (`main`) checkout**.

6. **C15 cross-repo (HumbleB) + a8fbc09.** C15 edits the HumbleB repo; cross-repo
   `parent_child` links unsupported (bracket refs only); needs
   `/api/knowledge-backrefs` allowlisted by C5; reconcile against the existing
   deferred HumbleB children.

7. **Nav/route split (C10 vs C18) co-ownership.** C10 (early) lands the route union
   + nav item + the **render branch + `SpacesViewShell`** (review2's top blocker);
   C18 (late) flips **all** the default-`graph` fallbacks (`routing.ts:14/23/35/37/54`)
   + demotes the Graph nav item. They co-own `app.tsx`/`routing.ts` via the §5
   disjoint-region split. C10 before C18; C18 after C7c on `graph.tsx`.

8. **Ref-parser is a FIX (C6); the resolver is a backend endpoint (C2).** C6 fixes
   the live `artifact:sha256:` linkifier bug (regression test) and consumes the C2
   unified resolver endpoint for the unresolved-ref UI; the parser fix itself is
   otherwise standalone (the C2 dependency is only the resolver endpoint).

9. **`space_exports` identity backup-survival.** `repo_id` is keyed to
   `ledger_project_checkouts.id` (backed up; `src/db.ts:1014-1024`), **not**
   `work_repos.id` (excluded from backup; `src/ledger/backup.ts:70-77`), with inline
   `UNIQUE(repo_id, branch, path)` so the tracking identity survives restore.

10. **Membership-duplication temptation.** Do not mirror membership into
    `artifact_links` (plan §3.2). Membership is queried only from `space_items` via
    `idx_space_items_by_ref`.

---

## 8. Resolved false alarms (noted, not actioned)

Two prior codex findings remain **stale false alarms** from grading earlier `/tmp`
plan copies and are NOT actioned:

- **CASCADE-vs-RESTRICT.** RESTRICT on `spaces.project_id` is **final/settled**
  (Spaces are precious authored state; the space-internal cascade stays CASCADE).
- **Sidecar-vs-in-band.** The canonical format is **in-band `spaces-doc.v1`** with
  **no canonical sidecar** (settled). The "mandatory sidecar manifest" was the
  superseded A3 design.

See `CODEX-REVIEW-NOTES.md` "Round-4 reconciliation" for the full Round-4 changelog
(review2 + codex + Opus) and the review2 findings judged inapplicable.
