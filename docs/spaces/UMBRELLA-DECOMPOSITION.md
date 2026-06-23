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
> **Adversarial-review reconciliation (this revision).** This decomposition has
> been reconciled across three adversarial reviews (an Opus review, a
> `/tmp`-grounded codex review, and a corrected-grounding codex review). The
> accepted findings — owned-surface file-pointer corrections, schema/migration
> fixes, sizing splits, DAG/ownership corrections, standing acceptance criteria,
> and cross-link adjustments — are applied throughout. Two codex "findings"
> (CASCADE-vs-RESTRICT and sidecar-vs-in-band) were **stale false alarms** from
> grading earlier `/tmp` plan copies; RESTRICT is final and the format is in-band
> `spaces-doc.v1` with no canonical sidecar. The `/tmp` plan copies have been
> refreshed from the corrected worktree versions so the packet is coherent.

---

## 0. Sizing methodology

Each child must fit **one worker session**: one `feature/spaces-<lane>` branch
(sub-lanes use the `__` separator), one auth request, completable in roughly one
context window. I sized against the plan's §12 Children table (13 rows) and the
reconciled review findings, producing the following adjustments:

| Plan row | Decision | Result |
|---|---|---|
| Core schema + backup | keep | 1 child |
| Backend API + CLI + transport + SSE | **SPLIT into 3** (REST routes / CLI / transport+SSE) | 3 children |
| Shared resource-ref parser | keep — reframed as a **FIX + regression test** (live `artifact:sha256:` linkifier bug) | 1 child |
| Shared filter extraction + seeding + Add-to-Space | keep (cohesive) | 1 child |
| Collection/list renderer | keep | 1 child |
| SpaceCanvas | **SPLIT into 2** (`__nodes` / `__edges`) | 2 children |
| Document renderer + serialization (+ `space_blocks`) | **SPLIT into 3** (serialization/parser-extension; `space_blocks` schema+API; renderer+block-editor) — **repo-file registration MOVED to doc-custody** | 3 children |
| Document custody / export (+ `space_exports`) | keep — **gains repo-file registration + docs-branch worktree lifecycle** | 1 child |
| Auth-merge / docs-branch promotion | keep (special handling) | 1 child |
| Board/kanban renderer | keep | 1 child |
| HumbleB ingest-as-source | keep (under a8fbc09) | 1 child |
| Graph demotion + Spaces nav | **SPLIT into 2** (early nav/route shell / late graph-demotion + default-route flip) | 2 children |
| CLAUDE.md / Interface-Contract reflection | keep (dotfiles repo) | 1 child |

**Total: 19 children** (13 plan rows → 19 after 4 splits of +1 each, plus moves
that re-home block-CLI into the CLI child and repo-file registration into the
custody child without changing the count).

**Move summary (review §D):**
- `mandible space block` CLI moves **out of** the blocks-schema child **into** the
  CLI child (so blocks-schema = migration + blocks API only). Choice stated:
  **moved** (the CLI child owns all `mandible space` dispatch + `cli/space.sh`).
- Repo-file-as-document registration (+ artifact-document-path concern) moves
  **out of** the document-renderer child **into** the doc-custody child (it is a
  custody/authority concern, not a rendering concern).

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
>   `src/db.ts:2020`), with **inline `UNIQUE`/composite-FK** constraints (so they
>   survive backup/restore — `src/ledger/backup.ts:153,172` emits table DDL +
>   data but **no** standalone index DDL) and are added to
>   `METADATA_BACKUP_TABLES`.
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

### Standing acceptance criteria (apply to all relevant children)

These are umbrella-wide ACs; each child's own AC list cites the ones that apply.

1. **Route write/auth boundaries (API + transport children).** Every mutating
   route enforces project-scope validation, guards destructive ops, and exposes
   file-RPC **WRITE** access deliberately (read vs. write allowlisting is
   explicit, not blanket). Homed in C2 (API) and C4 (transport).
2. **Cross-child test strategy (named owners).** Migration/backup tests (C1, C11,
   C12); route + file-RPC tests (C2, C4); SSE-reconciliation tests (C4 emits;
   each renderer asserts no zoom/selection/filter reset on reconcile); UI-state-
   persistence tests (C7, C8a, C8b, C13, C16); renderer-security (sanitizer/iframe)
   tests (C14 document renderer).
3. **dist/build hygiene (every UI child).** `git ls-files dist ui/dist` must be
   empty (project `CLAUDE.md`); no `dist/`/`ui/dist/` committed on any branch.
4. **Architectural-reflection mandate (backend/auth children: schema C1, API C2,
   blocks-schema C11, doc-custody C13, docs-promotion C16).** Per the project
   `CLAUDE.md`, actively reflect on the global `~/.claude/CLAUDE.md` conventions and,
   if implicated, file a dotfiles issue. The contract-reflection child (C19) owns the
   dotfiles change itself.
5. **Accessibility / keyboard (both canvas children C8a/C8b and the board child
   C17).** The Dataful-UX a11y contract: keyboard navigation and selection,
   focus management, and accessible affordances on draggable/board surfaces.
6. **Docs-branch worktree lifecycle (doc-custody child C13).** Worktree
   provisioning + lock/serialized-writes + dirty-rejection + path identity +
   `docs_path`/auto-track settings storage are explicitly owned by C13.
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
| TBD | Spaces REST API (CRUD + batch + seed; owns `src/spaces/events.ts` enum) | `feature/spaces-api` | pending |
| TBD | `mandible space` CLI surface (`cli/space.sh` + `bin/mandible` dispatch) | `feature/spaces-cli` | pending |
| TBD | File-RPC transport allowlist + `space:*` SSE plumbing | `feature/spaces-transport-sse` | pending |
| TBD | Shared resource-ref parser FIX (`artifact:sha256:` bug) + unresolved-ref UI | `feature/spaces-ref-parser` | pending |
| TBD | Shared filter extraction + seeding UI + Add-to-Space | `feature/spaces-seed-filter` | pending |
| TBD | Collection/list renderer | `feature/spaces-collection` | pending |
| TBD | SpaceCanvas nodes (occurrences/canvas/shelf/drag/layout/SSE) | `feature/spaces-canvas__nodes` | pending |
| TBD | SpaceCanvas edges (`space_edges` UI + labels + promote-to-ledger) | `feature/spaces-canvas__edges` | pending |
| TBD | Early Spaces nav/route shell | `feature/spaces-nav-shell` | pending |
| TBD | `space_blocks` schema + blocks API | `feature/spaces-blocks-schema` | pending |
| TBD | `spaces-doc.v1` serialization + ref-parser directive grammar extension | `feature/spaces-serialization` | pending |
| TBD | Document custody / export (+ `space_exports`) + repo-file registration | `feature/spaces-doc-custody` | pending |
| TBD | Document renderer + block editor (+ sanitizer/iframe security) | `feature/spaces-document` | pending |
| TBD | Make Space documents ingestable as HumbleB sources | `feature/spaces-humbleb` | pending |
| TBD | Auth-merge / docs-branch promotion flow | `feature/spaces-docs-promotion` | pending |
| TBD | Board/kanban renderer | `feature/spaces-board` | pending |
| TBD | Graph demotion + default-route flip | `feature/spaces-graph-demotion` | pending |
| TBD | CLAUDE.md / Interface-Contract reflection (dotfiles) | `feature/spaces-contract-reflection` | pending |

### Relationship to existing issues

| Target issue | Title | Edge type (umbrella → target unless noted) | Why |
|---|---|---|---|
| **a8fbc09** | Mandible-HumbleB document and knowledge boundary | `related` | The HumbleB ingest work is coordinated **under** a8fbc09; the deferred HumbleB children already filed there ([0fa21e4], [969781d] in mandible; HumbleB/88dafe5 cross-repo) belong to a8fbc09. Cross-repo links to the HumbleB repo are not supported by Mandible's link graph — reference them with bracket refs in body text only. |
| **de2f8ac** | Spec: Mandible graph workspace and provider/artifact substrate | `references` (+ `related`) | **Downgraded from `implements`.** Spaces *refines and diverges from* the graph-workspace direction de2f8ac specs; `implements` would overstate the fidelity. `references`/`related` captures the relationship without claiming faithful realization. |
| **2dc97b8** | Project-canonical artifacts and documents for Timeline context | `related` | Registering an existing tracked repo file as a canonical document (UMBRELLA-PLAN §3.5; now owned by the doc-custody child C13) realizes part of 2dc97b8. **`related`, not `implements`** — no single child faithfully realizes 2dc97b8; the repo-file-registration capability is one facet. |
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
> separator (used for the two SpaceCanvas lanes). Labels avoid `deferred` (these
> are active scope). `space_blocks` and `space_exports` ship in their **own**
> migrations, not the core `spaces_core` migration (plan §3.8). **No migration
> version is pre-reserved across parallel branches** — each migration-bearing child
> uses the next contiguous `src/db.ts` version, assigned at integration in merge
> order (`assertMigrationSequence` requires contiguous versions, `src/db.ts:2020`).

---

### C1 — Core P1′ schema + backup

- **Title:** `Spaces core schema and backup inclusion (spaces_core)`
- **Labels:** `feature`
- **Branch:** `feature/spaces-schema`
- **Scope:** One sequential migration (next contiguous `src/db.ts` version,
  assigned at integration in merge order) adding the *core four* tables together —
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
  - **Inline-UNIQUE-survives-restore:** a test or assertion confirms a restored
    schema (round-tripped through the metadata backup, which emits table DDL only)
    still enforces uniqueness — the uniqueness is **inline**, not external-index-only.
  - The migration uses the **next contiguous** version at integration; no version
    number is hard-coded in advance against a parallel branch.
  - Relationship-semantics bright line (§4) documented in the migration comment.
  - **Standing AC:** architectural-reflection (#4).
- **Non-goals:** No `space_blocks`, no `space_exports`, no API/CLI/UI. No membership
  duplication into `artifact_links`.
- **Dependencies:** none (root of the DAG).
- **Sibling-ownership note:** Owns the migration framework entry and the backup list
  for the core four **only** — must NOT add `space_blocks` (C11) or `space_exports`
  (C13) tables/backup entries.

---

### C2 — Spaces REST API (CRUD + batch + seed)

- **Title:** `Spaces REST API: CRUD, batch occurrences, seed endpoint, and event enum`
- **Labels:** `feature`
- **Branch:** `feature/spaces-api`
- **Scope:** Implement the REST surface of UMBRELLA-PLAN §5.1: spaces CRUD; items
  CRUD; occurrences CRUD **plus** `POST /occurrences/batch` (bulk position writes);
  edges CRUD; and `POST /api/spaces/:id/seed` (accepts the shared predicate JSON,
  **evaluates it backend-side** against project issues + their artifacts, creates
  `space_items` + optional shelf occurrences — `/seed` stays here, the API child is
  **not** CRUD-only; UMBRELLA-PLAN ~537/622). Routes are registered via a new
  `registerSpacesRoutes(router)` exported from `src/routes/spaces.ts`, with an
  import + call wired into `src/index.ts` (~84–127, alongside the other
  `register*Routes(router)` calls — the analog is `registerProviderRoutes` in
  `src/routes/providers.ts`). **This child creates and owns the shared event-name
  enum module `src/spaces/events.ts`** (the frozen `space:*` constant set that C4
  consumes for SSE plumbing + the file-RPC allowlist, and that C11 reuses for
  `space:block:changed`). Blocks routes are NOT here (C11). Route handlers + a
  data/query layer over the core-four tables.
- **Owned surfaces:** `src/routes/spaces.ts` (new); the `registerSpacesRoutes`
  import/call in `src/index.ts` (~84–127); `src/spaces/events.ts` (new — shared
  event-name enum, frozen in this child's spec); query/data helpers (e.g.
  `src/ledger/spaces.ts` or equivalent); the **backend predicate-evaluator** used by
  `/seed` (shared with C6's UI filter-extraction — see note); route tests under
  `test/`.
- **Acceptance criteria:**
  - All §5.1 routes except `/blocks*` implemented and tested (happy path +
    validation failures: cross-space refs, malformed metadata, missing space).
  - `/occurrences/batch` writes N positions in one transaction; tested.
  - `/seed` evaluates the shared predicate **backend-side** and produces
    `space_items` (+ optional shelf occurrences) deterministically; tested against a
    fixture project.
  - `src/spaces/events.ts` exports the frozen `space:*` event-name enum; mutations
    reference it; the enum is documented as the contract C4 consumes.
  - Routes register through `registerSpacesRoutes(router)` called from
    `src/index.ts` (NOT a route table in `src/server.ts`, which is the generic
    router impl).
  - **Standing ACs:** route write/auth boundaries (#1: project-scope validation +
    destructive-op guards); architectural-reflection (#4).
- **Non-goals:** No CLI, no transport allowlist, no SSE plumbing internals (C4), no
  `/blocks*` routes, no UI. Does **not** own the UI filter-extraction (C6) — only
  the backend predicate-evaluator that `/seed` calls.
- **Dependencies:** **C1** (core schema).
- **Sibling-ownership note:** Owns `src/routes/spaces.ts`, the `src/index.ts`
  registration line, and the `src/spaces/events.ts` enum; must NOT edit
  `src/file-rpc-transport.ts` or `src/sse.ts` internals (C4); must NOT add
  `/blocks*` routes (C11).

---

### C3 — `mandible space` CLI

- **Title:** `mandible space CLI surface`
- **Labels:** `feature`
- **Branch:** `feature/spaces-cli`
- **Scope:** Implement the `mandible space ...` subcommands of UMBRELLA-PLAN §5.2 as
  a **shell CLI** (the Mandible CLI is shell-based, NOT TypeScript). Add a new
  `cli/space.sh` and a `space)` dispatch case in `bin/mandible` (the dispatch table
  at `bin/mandible:84,112`), plus help/usage text. Subcommands: `create`, `list`,
  `show`, `add-item`, `rm-item`, `place`, `link`, `unlink`, `promote-edge`,
  `seed-from-filter`, **and `block add|edit|rm`** (the block-CLI is **owned here**,
  moved out of the blocks-schema child — review §D). Each maps to the C2/C11 REST
  routes via the existing CLI→daemon transport. Deterministic `--json` output for
  agent consumption. These are Interface-Contract additions (the actual contract
  text lands in C19).
- **Owned surfaces:** `cli/space.sh` (new); `bin/mandible` dispatch + help updates
  (`bin/mandible:84,112`); CLI tests under `test/`.
- **Acceptance criteria:**
  - Each subcommand calls the corresponding REST route and round-trips deterministic
    output; `--json` paths tested.
  - `add-item` accepts canonical refs (`issue:<id>`, `artifact:sha256:<hash>`,
    `comment:<id>`, `uri:<...>`) and maps to the correct `ref_type`/`ref_id`.
  - `promote-edge` performs the explicit ledger-relationship promotion (§4) with a
    `link_type` constrained to the 9 valid types — **couples to C8b's promote-to-
    ledger affordance** (same semantics; coordinate the `link_type` mapping).
  - `block add|edit|rm` calls the C11 `/blocks*` routes; tested (depends on C11's
    blocks API existing).
  - Dispatch + help updates land in `bin/mandible` (NOT a `src/cli/space.ts`).
- **Non-goals:** No REST routes (consumes C2/C11); no contract-text edits (C19).
- **Dependencies:** **C2** (REST API for non-block subcommands); **C11** (blocks API
  for `block` subcommands — sequence the `block` subcommand work after C11, or land
  the non-block subcommands first and the block ones once C11 merges).
- **Sibling-ownership note:** Owns `cli/space.sh` + `bin/mandible` dispatch/help;
  must NOT add or change REST routes (C2/C11) and must NOT edit `~/.claude/CLAUDE.md`
  or the Interface Contract text (C19, dotfiles).

---

### C4 — File-RPC transport allowlist + `space:*` SSE

- **Title:** `Spaces transport allowlist and SSE events`
- **Labels:** `feature`
- **Branch:** `feature/spaces-transport-sse`
- **Scope:** Add `/api/spaces*` (GET/POST/PATCH/DELETE + batch) **and**
  `/api/knowledge-backrefs` to the file-RPC allowlist so sandboxed agents can
  read/write spaces (and so the Phase-6 HumbleB return channel works); wire the
  `space:*` SSE event family through the existing `broadcast(type, data)` helper.
  **Consume** the shared event-name enum `src/spaces/events.ts` created and frozen
  by C2 (do not redefine it here) for both SSE plumbing and the file-RPC allowlist
  identity. WRITE exposure through file-RPC is deliberate (read vs. write
  allowlisting is explicit).
- **Owned surfaces:** `src/file-rpc-transport.ts` (`isAllowedFileRpcRoute`, lines
  ~176-235); `src/sse.ts` (broadcast wiring, lines ~185-204); transport-allowlist +
  SSE tests. (Imports the enum from `src/spaces/events.ts`; does not own it.)
- **Acceptance criteria:**
  - `/api/spaces*` and `/api/knowledge-backrefs` are allowlisted; tests assert a
    sandboxed-route check passes for them and still rejects a non-allowlisted route.
  - `space:*` events (from the C2-owned enum) are broadcast on mutations; an
    SSE-emission test asserts a mutation broadcasts the expected event.
  - UI consumers treat these events as reconciliation inputs (documented contract;
    enforcement lands in the renderer children).
  - **Standing AC:** route write/auth boundaries (#1: careful file-RPC WRITE
    exposure).
- **Non-goals:** No route handlers (C2), no UI subscription logic (renderer
  children), no CLI. Does **not** define the event enum (C2 owns it).
- **Dependencies:** **C2** (the routes to allowlist, the mutations to broadcast
  from, and the frozen `src/spaces/events.ts` enum). The event-name enum being owned
  by C2 removes the former soft C2↔C4 cycle: C4 strictly consumes C2's frozen enum.
- **Sibling-ownership note:** Owns transport allowlist + SSE wiring; must NOT add or
  change route handlers (C2) or redefine the event enum (C2 owns
  `src/spaces/events.ts`).

---

### C5 — Shared resource-ref parser FIX + unresolved-ref UI

- **Title:** `Shared resource-ref parser: fix artifact:sha256: linkifier + unresolved-reference UI`
- **Labels:** `feature`, `error`
- **Branch:** `feature/spaces-ref-parser`
- **Scope:** **This is a FIX, not greenfield.** `ui/src/artifact-links.ts:3`'s
  `COMPACT_SHA_ARTIFACT_REF = /^artifact:([0-9a-f]{7,64})$/i` **cannot match**
  `artifact:sha256:<hash>` (the `sha256:` prefix fails the `[0-9a-f]` class) — a
  **live bug**: the canonical artifact ID form is silently un-linkified. Replace the
  bracket-only / compact-only linkifier with **one shared resource-ref parser**
  (UMBRELLA-PLAN §8, review A4) used by the renderer, import, issue detail, and
  artifacts UI. It must recognize: `artifact:sha256:<64hex>` **and** compact
  `artifact:<7-64hex>`; `repo://<repo>@<ref>/<path>`;
  `mandible://<repo>/issue/<primary-id>`; and markdown links whose href is any of
  those. It must drive an **unresolved-reference UI** (visible placeholder +
  resolve/fix affordance) — refs never silently dropped. **This child is a GATE
  before the document renderer (C14)** and lands the shared parser module that C12's
  directive grammar extends. Directive-node recognition (refs/embeds inside
  `spaces-doc.v1` directives) is **not** here — C12 owns the directive-grammar
  extension to this same module; this child only needs to expose a clean extension
  point.
- **Owned surfaces:** `ui/src/artifact-links.ts` (replaced) → a new shared module
  (e.g. `ui/src/resource-refs.ts`); call-site updates in
  `ui/src/components/ledger/IssueDetail.tsx` and `ui/src/views/artifacts.tsx`
  (**collision with C6 — see DAG note: C5 sequences before C6, or disjoint insertion
  regions**); import paths; parser unit tests including a **regression test** for the
  `artifact:sha256:` bug.
- **Acceptance criteria:**
  - **Regression test:** `artifact:sha256:<64hex>` now linkifies (the bug is fixed);
    a test asserts the old regex would have failed and the new parser succeeds.
  - Parser recognizes all four ref forms (incl. compact artifact form) as text and
    as markdown-link hrefs; round-trip tests cover each.
  - Edited content prefers markdown links with canonical hrefs (label may change,
    href is authority); covered by a test.
  - Unresolved refs surface a placeholder + resolve affordance; tested.
  - Existing artifact-link call sites migrated; no regression in artifact linkify.
  - The module exposes a clean **grammar-extension point** that C12 extends for
    `spaces-doc.v1` directive nodes (the shared resource-ref parser module is landed
    here; C12 owns only the directive-grammar extension to it).
  - **Standing AC:** dist hygiene (#3).
- **Non-goals:** No directive grammar (C12 extends the parser for `spaces-doc.v1`
  nodes); no renderer-library swap (C14); no backend.
- **Dependencies:** **C2** (resolution targets the spaces API). Foundational gate for
  **C12** and **C14**.
- **Sibling-ownership note:** Owns the shared parser module + its call sites; must
  NOT introduce the `spaces-doc.v1` directive grammar (C12) or adopt the new
  markdown/document renderer library (C14). **Sequences before C6** on the shared
  files `IssueDetail.tsx` / `artifacts.tsx` (or uses disjoint insertion regions).

---

### C6 — Shared filter extraction + seeding UI + Add-to-Space

- **Title:** `Shared issue-predicate filter, Space seeding UI, and Add-to-Space affordances`
- **Labels:** `feature`
- **Branch:** `feature/spaces-seed-filter`
- **Scope:** Extract the shared issue-predicate/filter component from the Timeline
  (`TimelineFilterRowSpec` in `ui/src/types/timeline.ts:24-29` — chips +
  `scope: TimelineIssuePredicate` AST + chip-editing UI) into a shared module
  consumable by both the Timeline row-add UI and the Spaces seed UI, **preserving
  the exact shape so it round-trips with Timeline**. Wire the Spaces **seed UI** to
  the C2 `/seed` endpoint (the backend predicate-evaluation lives in C2; this child
  owns only the **UI filter-extraction + the Add-to-Space affordances**, posting the
  shared predicate to `/seed`). Add "Add to Space" affordances in issue detail,
  artifact detail, and graph node detail (§6.3) — the graph stays a picker, not an
  editor. "Create Space from current graph selection" must read from the source the
  graph adapter actually renders (`ledger_issue_relationships`, §4).
- **Owned surfaces:** new shared filter module (extracted from
  `ui/src/views/timeline.tsx` / `ui/src/types/timeline.ts`); Spaces seed UI;
  `ui/src/components/ledger/IssueDetail.tsx` (Add to Space — **after C5**);
  `ui/src/views/artifacts.tsx` (Add to Space header action — **after C5**);
  `ui/src/views/graph.tsx` (add selected node[s] to active Space — **before the late
  graph-demotion child C18**); component tests.
- **Acceptance criteria:**
  - Extracted filter module is consumed by **both** Timeline and Spaces; a test
    asserts the predicate shape round-trips unchanged for the Timeline.
  - Seed UI posts the shared predicate JSON to the C2 `/seed` endpoint (backend does
    the evaluation); covered by a test. **The shared predicate-evaluator is the one
    both this child and C2 depend on** — UI extracts/edits the predicate, C2
    evaluates it.
  - "Add to Space" present on issue/artifact/graph surfaces; graph addition targets
    the active Space without turning graph into the editor.
  - Graph-selection seed reads `ledger_issue_relationships` (matches what the graph
    renders).
  - **Standing AC:** dist hygiene (#3).
- **Non-goals:** No backend predicate evaluation (C2 owns `/seed`); no new renderer;
  no canvas; does not change Timeline behavior beyond the extraction (Dataful-UX
  contract: no resets).
- **Dependencies:** **C2** (seed endpoint + shared predicate-evaluator); **C5**
  (sequences before C6 on `IssueDetail.tsx` / `artifacts.tsx`). **Sequences before
  C18** (late graph-demotion) on `graph.tsx` (seed-from-graph-selection touches it).
- **Sibling-ownership note:** Owns the extracted filter module + the Add-to-Space
  call sites; must NOT modify Timeline's view-state semantics, own the canvas
  graph-editing logic (C8a/C8b), or own the backend `/seed` evaluator (C2). Adds only
  a "send to space" action in `graph.tsx`.

---

### C7 — Collection/list renderer

- **Title:** `Spaces collection/list renderer`
- **Labels:** `feature`
- **Branch:** `feature/spaces-collection`
- **Scope:** The first usable renderer: a membership list/tree view over
  `space_items` with previews, add/remove, missing-ref handling (via the C5 parser /
  unresolved-ref UI), and project scoping. This is the Phase-1 "usable whole"
  renderer. View-state (active space, filter UI) follows the Timeline localStorage +
  URL pattern; canonical state stays in SQLite.
- **Owned surfaces:** new `ui/src/views/spaces/` collection view + components;
  routing entry wiring is **provided by C10 (the nav/route shell)** — this child
  registers its view into the shell C10 lands; view tests.
- **Acceptance criteria:**
  - Lists/trees `space_items` for the active space with add/remove; tested.
  - Missing/unresolved refs render via the shared unresolved-ref UI (C5), never
    silently dropped.
  - View-state (active space, filters) persists across tab switch/refresh per the
    Dataful-UX contract; SSE events reconcile without resetting selection.
  - **Standing ACs:** UI-state-persistence test (#2); dist hygiene (#3).
- **Non-goals:** No canvas, no document editor, no board; no nav/default-route
  change (C10 lands the nav shell; C18 flips the default route).
- **Dependencies:** **C2** (API), **C5** (unresolved-ref UI), **C10** (nav/route
  shell to mount into). Parallel to C8a/C8b.
- **Sibling-ownership note:** Owns the collection view; must NOT add the top-level
  Spaces nav item or change the default route (C10 owns the nav shell; C18 owns the
  default-route flip).

---

### C8a — SpaceCanvas nodes

- **Title:** `SpaceCanvas nodes: occurrences, shelf, drag persistence, layout reuse`
- **Labels:** `feature`
- **Branch:** `feature/spaces-canvas__nodes`
- **Scope:** A **new** editable React Flow canvas (NOT a mutation of
  `ui/src/views/graph.tsx`) — the **node half**: persisted `space_occurrences`
  (x/y/size/z), a **shelf/tray** for unplaced occurrences (`x`/`y` NULL),
  auto-arrange seed via the existing `layoutGraph()` (`ui/src/graph/layout.ts:615`)
  for *initial arrange / re-layout selected / seed-from-graph only* (never on every
  render), optimistic drag + debounced batch write to `/occurrences/batch` with an
  autosave indicator and graceful failure, and **SSE reconciliation that does NOT
  reset zoom or selection**. Persisted positions are the source of truth;
  zoom/scroll/selection are ephemeral (localStorage/URL).
- **Owned surfaces:** new `ui/src/views/spaces/SpaceCanvas.tsx` (node rendering +
  drag + shelf) + node components; may **read** `ui/src/graph/layout.ts`
  (`layoutGraph`) and reuse visual node components, but does not modify `graph.tsx`;
  canvas node tests.
- **Acceptance criteria:**
  - New canvas component renders occurrences from the API; drag persists via
    `/occurrences/batch` (optimistic + autosave indicator); tested.
  - Unplaced occurrences render in the shelf, not at the origin.
  - `layoutGraph()` is used only for initial/seed/re-layout, never per-render after
    user moves (persisted positions win); covered by a test or assertion.
  - SSE `space:occurrence:moved` reconciles **without resetting zoom/selection**;
    tested.
  - **Standing ACs:** accessibility/keyboard (#5); UI-state-persistence (#2); dist
    hygiene (#3).
- **Non-goals:** Does NOT modify the existing graph view; does NOT demote the graph
  or touch nav (C10/C18); no edges UI (C8b); no document/board.
- **Dependencies:** **C2** (API), **C10** (nav shell). Parallel to C7; **C8b builds
  on this lane's canvas shell.**
- **Sibling-ownership note:** Owns the canvas node surface; must NOT edit
  `ui/src/views/graph.tsx` beyond reading shared components; the `space_edges` UI is
  C8b's.

---

### C8b — SpaceCanvas edges

- **Title:** `SpaceCanvas edges: space_edges UI, free labels, promote-to-ledger`
- **Labels:** `feature`
- **Branch:** `feature/spaces-canvas__edges`
- **Scope:** The **edge half** of SpaceCanvas: create/edit/delete `space_edges` with
  **free labels**, and a **promote-to-ledger affordance** that turns a `space_edge`
  into an explicit `ledger_relationship_edges` row (§4). The promote affordance
  **couples to the C3 CLI's `promote-edge` semantics** — same `link_type` mapping
  (9 valid types, issue/comment endpoints), surfaced as UI. Builds on the C8a canvas
  shell.
- **Owned surfaces:** edge components within `ui/src/views/spaces/` (edge layer of
  the canvas owned by C8a); edge-editing + promote-to-ledger UI; edge tests.
- **Acceptance criteria:**
  - `space_edges` are created/edited with free labels via the C2 edges routes;
    tested.
  - Promote-to-ledger is an explicit affordance that writes a
    `ledger_relationship_edges` row constrained to the 9 types with issue/comment
    endpoints; mapping matches the C3 `promote-edge` CLI semantics; tested.
  - SSE `space:edge:created` reconciles without resetting canvas state.
  - **Standing ACs:** accessibility/keyboard (#5); UI-state-persistence (#2); dist
    hygiene (#3).
- **Non-goals:** No node/drag/shelf logic (C8a); no graph demotion/nav (C10/C18).
- **Dependencies:** **C8a** (canvas shell), **C2** (edges API). Couples to **C3**
  (promote-edge semantics).
- **Sibling-ownership note:** Owns the edge layer + promote-to-ledger UI; coordinates
  the `link_type` mapping with the C3 CLI; must NOT own node/drag logic (C8a).

---

### C9 — *(folded)*

> *Renumbering note: there is no standalone C9. The early SpaceCanvas split produced
> C8a/C8b; the next child is C10 (nav shell). This placeholder keeps cross-reference
> numbering legible.*

---

### C10 — Early Spaces nav/route shell

- **Title:** `Spaces navigation and route shell`
- **Labels:** `feature`
- **Branch:** `feature/spaces-nav-shell`
- **Scope:** The **early** nav/routing scaffold so the collection+canvas milestone is
  reachable: add `'spaces'` to the `Route['tab']` type union
  (`ui/src/routing.ts:2`) **and** the duplicated runtime allow-array (~`:35` — the
  `['auth','artifacts',...]` list used to validate the parsed path), and add a
  top-level `Spaces` nav item to `primaryNavItems` (`ui/src/app.tsx:990`-ish, with
  the `NavItem` type at `ui/src/app.tsx:151`). **This child does NOT change the
  default route** and does NOT demote the graph — it only lands the route + nav
  entry point that C7/C8a mount into. The default-route flip and graph demotion are
  C18 (late).
- **Owned surfaces:** `ui/src/routing.ts` (the `Route['tab']` union at `:2` + the
  duplicated path-allow array at ~`:35`); `ui/src/app.tsx` (`NavItem` use at
  `:151` + `primaryNavItems` at ~`:990`); routing/nav tests.
- **Acceptance criteria:**
  - `'spaces'` is a valid `Route['tab']`; both the type union (`:2`) and the runtime
    allow-array (`:35`) include it; a routing test asserts `#/spaces` parses.
  - A top-level `Spaces` nav item is present in `primaryNavItems` and routes to the
    Spaces view shell.
  - The **default route is unchanged** (still `graph`); no graph demotion here.
  - **Standing AC:** dist hygiene (#3).
- **Non-goals:** No renderer logic (C7/C8a/C8b/C14/C17); no default-route flip and no
  graph demotion (C18).
- **Dependencies:** **C2** (so the shell points at a real backend). Foundational for
  **C7** and **C8a** (they mount into the shell). Parallel-able early.
- **Sibling-ownership note:** Sole owner of the route-union + nav-item edits; must NOT
  flip the default route or demote the graph (C18 owns those edits on
  `ui/src/routing.ts:35` default + `graph.tsx` demotion).

---

### C11 — `space_blocks` schema + blocks API

- **Title:** `space_blocks schema and blocks API`
- **Labels:** `feature`
- **Branch:** `feature/spaces-blocks-schema`
- **Scope:** Ship the `space_blocks` table in its **own** migration (next contiguous
  `src/db.ts` version, assigned at integration after the core migration — UMBRELLA-
  PLAN §3.5/§3.8): DDL with composite FKs, `item_id` `ON DELETE RESTRICT` + required
  `item_snapshot_json`, `block_type` CHECK, object `json_valid` CHECKs, inline
  `UNIQUE(space_id, id)`; add `space_blocks` to `METADATA_BACKUP_TABLES`. Implement
  the `/api/spaces/:id/blocks*` REST routes (deferred from C2), registered through
  the C2-owned `registerSpacesRoutes`/`src/routes/spaces.ts` extension. **The
  `block` CLI is NOT here — it moved to C3** (review §D); this child is
  migration + blocks API only. Block mutations emit `space:block:changed` using the
  C2-owned `src/spaces/events.ts` enum. **Block identity / `item_snapshot_json` /
  manifest must agree with the C12 serialization** (see dependency edge).
- **Owned surfaces:** `src/db.ts` (new `MIGRATIONS` entry for `space_blocks`,
  contiguous version at integration); `src/ledger/backup.ts` (add `space_blocks`);
  `/blocks*` handlers in `src/routes/spaces.ts`; migration + route + backup tests.
- **Acceptance criteria:**
  - `space_blocks` migration with the §3.5 DDL; added to `METADATA_BACKUP_TABLES`;
    backup-classification test fails if omitted; inline `UNIQUE(space_id, id)`
    survives restore (tested).
  - Migration tests: cross-space block/parent refs rejected; assigning `item_id`
    requires `item_snapshot_json`; deleting an embedded item is RESTRICTed and the
    placeholder data (`item_snapshot_json`) is preserved.
  - `/blocks*` routes implemented and tested; mutations emit `space:block:changed`
    (reusing the C2 enum).
  - **Block identity model agrees with C12** (`spaces-doc.v1` block id / sort /
    parent / `item_snapshot_json` round-trip); coordinated via the C12→C11 edge.
  - **Standing AC:** architectural-reflection (#4).
- **Non-goals:** No document editor/renderer UI (C14); no serialization format (C12);
  no `block` CLI (C3); no export/custody (C13).
- **Dependencies:** **C1** (migration precedent / sequencing), **C2** (routes scaffold
  + event enum to extend). The `space_blocks` migration sequences **after** the core
  migration. **Coordinates with C12** on block identity (the C12 serialization and
  this schema's block identity / `item_snapshot_json` / manifest must agree).
- **Sibling-ownership note:** Owns the `space_blocks` table, its backup entry, and
  `/blocks*` routes; must NOT touch the core-four migration (C1), the `block` CLI
  (C3), or the serialization format (C12).

---

### C12 — `spaces-doc.v1` serialization + ref-parser directive extension

- **Title:** `spaces-doc.v1 canonical serialization and directive ref parsing`
- **Labels:** `feature`
- **Branch:** `feature/spaces-serialization`
- **Scope:** Design and implement the canonical document serialization: **Markdown +
  a small non-executable directive grammar (`spaces-doc.v1`)**, fully in-band (no
  mandatory sidecar). Define the directive profile carrying block identity
  (`id`/`parent`/`sort`/`type`), references, and embeds as **data nodes** (no code
  execution), each with normal-markdown fallback content. Implement faithful
  round-trip `import(export(x)) == x` for the block tree + embeds + prose; implement
  the import-conflict policy (the 5 rows of custody-doc §1.3). **This child owns the
  `spaces-doc.v1` directive-grammar EXTENSION to the shared resource-ref parser
  module landed by C5** — it extends C5's module to recognize refs/embeds as
  directive nodes. (The parser-ownership chain is explicit: C5 lands the shared
  resource-ref parser; C12 owns only the directive-grammar extension to that same
  module; C14 depends on C12 for the grammar.)
- **Owned surfaces:** new serialization module (e.g. `src/spaces/serialize.ts` /
  `ui/src/spaces/spaces-doc.ts` as appropriate); directive-grammar definition; the
  `spaces-doc.v1` extension of the C5 shared parser module; round-trip +
  import-conflict tests.
- **Acceptance criteria:**
  - Round-trip test: `import(export(tree)) == tree` for `parent_id`, `sort_key`,
    `block_type`, `item_id` embeds, and prose body.
  - Import-conflict matrix (the 5 rows of custody-doc §1.3) each covered by a test.
  - Directives are non-executable data nodes (no JS eval path); a test/assertion
    confirms no executable directive path exists.
  - The shared ref parser (C5's module) recognizes refs both as markdown links and as
    `spaces-doc.v1` directive nodes after this child's extension; tested.
  - The **frozen directive grammar** is published so C14 (renderer) and C11 (block
    identity) consume a stable grammar — C14 needs only the frozen grammar from this
    child, not a broad parser dependency.
  - **Standing AC:** architectural-reflection (#4 — serialization is backend-shaped).
- **Non-goals:** No UI renderer/editor (C14); no `space_blocks` table (C11); no
  export/commit/custody (C13); no MDX/JSX execution.
- **Dependencies:** **C5** (extends the shared parser module C5 landed). Informs
  **C11** (block identity must agree), **C13** (custody serializes via this), and
  **C14** (renderer consumes the frozen grammar).
- **Sibling-ownership note:** Owns the serialization format + the directive-grammar
  extension to C5's parser; must NOT create the `space_blocks` table (C11) or the
  document editor UI / renderer-library swap (C14). The C5→C12 chain: C5 owns the
  base parser, C12 owns the `spaces-doc.v1` grammar extension.

---

### C13 — Document custody / export (+ `space_exports`) + repo-file registration

- **Title:** `Document custody, export dialog, space_exports tracking, and repo-file registration`
- **Labels:** `feature`
- **Branch:** `feature/spaces-doc-custody`
- **Scope:** Ship the `space_exports` table (custody-doc §2.1) in its **own**
  migration (next contiguous `src/db.ts` version at integration), added to
  `METADATA_BACKUP_TABLES`, with **inline `UNIQUE(repo_id, branch, path)` inside the
  `CREATE TABLE`** (NOT an external `CREATE UNIQUE INDEX` — that DDL is lost on
  backup/restore, `src/ledger/backup.ts:153,172`). Implement the custody model:
  **default custody = Mandible custody until the user explicitly requests a commit**
  (no `space_exports` row until then; no auto-track, no silent auto-commit). Build
  the **export dialog** (global default repo-relative path + per-repo overrides +
  per-export confirm/override). Implement the deterministic `export-and-track` op:
  serialize to `spaces-doc.v1` (C12), write to the managed docs-branch worktree,
  **commit via the agent-key linked-commit path** (`commit-linked`/`agent-commit`,
  never bare `git commit`), record/refresh the `space_exports` row, retain an
  immutable pre-export snapshot artifact. Implement drift detection by inspecting the
  **live** docs-branch worktree/HEAD/path (NOT artifact materialization). Implement
  untracked export-of-copy. **Own the docs-branch worktree lifecycle** (provisioning
  + lock/serialized-writes + dirty-rejection + path identity + `docs_path`/auto-track
  settings storage — standing AC #6). **Own repo-file registration** (moved from the
  document-renderer child, review §D): register an existing tracked repo file as a
  document with `authority='repo'`/link custody + a `repo://<repo>@<ref>/<path>`
  source ref (custody-doc §1.4, ties to 2dc97b8) — this is the
  artifact-document-path concern.
- **Owned surfaces:** `src/db.ts` (new `MIGRATIONS` entry for `space_exports`,
  contiguous version at integration); `src/ledger/backup.ts` (add `space_exports`);
  export/custody backend module (e.g. `src/spaces/export.ts`); drift-check logic;
  export-dialog UI; **repo-file-registration UI + backend** (link custody,
  `repo://...` source); docs-branch worktree provisioning/locking; settings storage
  for global/per-repo default path; migration + export + drift + repo-file-
  registration tests.
- **Acceptance criteria:**
  - `space_exports` migration with §2.1 DDL using **inline `UNIQUE(repo_id, branch,
    path)`**; added to `METADATA_BACKUP_TABLES`; backup test fails if omitted; an
    **inline-UNIQUE-survives-restore** test asserts the constraint holds after a
    backup round-trip.
  - No `space_exports` row exists for a document until an explicit user commit;
    tested (custody default).
  - `export-and-track` produces an **agent-key linked commit** carrying a
    `Mandible-Issue:` trailer (never bare `git commit`); tested.
  - Drift detection reads live worktree/HEAD (not pinned artifact bytes) and sets
    `status` per the §6 table; tested for each status transition.
  - Export dialog resolves global-default + per-repo override + per-export confirm;
    re-export to the same path is idempotent.
  - Untracked export-of-copy creates no `space_exports` row; surfaces a `local_only`
    warning if written untracked inside a repo.
  - Commit is blocked when the docs worktree has dirty unrelated changes; serialized
    writes / lock on the managed worktree (standing AC #6).
  - **Repo-file registration:** an existing tracked repo file can be registered as a
    document with `authority='repo'`/link custody and a `repo://...` source; tested.
  - **Standing ACs:** architectural-reflection (#4); docs-branch worktree lifecycle
    (#6).
- **Non-goals:** Does NOT touch `cli/auth-merge.sh` or the promotion flow (C16); no
  HumbleB ingestion (C15); no renderer/block-editor UI (C14); no serialization
  format (C12).
- **Dependencies:** **C12** (serialization), **C14** (document renderer — the editor
  it commits from). Feeds **C15** and **C16**.
- **Sibling-ownership note:** Owns `space_exports`, the export dialog, custody/drift
  logic, repo-file registration, docs-branch worktree lifecycle, and routine
  docs-branch linked commits; must NOT modify `cli/auth-merge.sh` or the promotion
  proxy-branch flow (C16 owns that, and submits from `main`).

---

### C14 — Document renderer + block editor

- **Title:** `Document renderer, block editor, and sanitizer/iframe security`
- **Labels:** `feature`
- **Branch:** `feature/spaces-document`
- **Scope:** Build the document renderer/editor over `space_blocks`: a block editor,
  embedded previews (issue/artifact/comment embeds), and **adoption of a Markdown +
  `remark-directive` (non-executable) renderer** in the UI, replacing the bare
  `marked` path (`ui/src/sanitize.ts`, `ui/src/views/artifacts.tsx`) — directives
  render as data nodes through fixed Preact components (no MDX/JSX execution;
  sanitized HTML via DOMPurify; script-enabled iframes reserved for the standalone
  artifact preview only). Uses the C5/C12 shared parser + frozen directive grammar.
  **Repo-file registration is NOT here — it moved to C13.** **Embed-on-delete
  behavior is DEFERRED: the implementing agent MUST prompt the user for that decision
  when it becomes relevant — do not pick it unilaterally.**
- **Owned surfaces:** new `ui/src/views/spaces/DocumentRenderer.tsx` + block-editor
  components; the markdown/`remark-directive` renderer adoption in `ui/src/sanitize.ts`
  and the document render path of `ui/src/views/artifacts.tsx`; renderer + editor +
  **sanitizer/iframe-security** tests.
- **Acceptance criteria:**
  - Block editor reads/writes `space_blocks` via the C11 API; renders embeds and
    prose; tested.
  - The new non-executable renderer replaces `marked` on the document path; sanitized
    HTML only; no executable directive path; a **security-oriented test** asserts no
    script execution from a document directive (sanitizer/iframe security — standing
    AC #2).
  - Renders refs (markdown links **and** directive nodes) via the shared parser +
    C12 grammar; unresolved refs show placeholders.
  - Embed-on-delete is left as a user-prompted decision point, not hardcoded.
  - **Standing ACs:** renderer-security test (#2); UI-state-persistence (#2); dist
    hygiene (#3).
- **Non-goals:** No `space_blocks` migration/API (C11); no serialization format (C12);
  no export/commit/custody/`space_exports`/repo-file registration (C13); no HumbleB
  (C15).
- **Dependencies:** **C5** (ref parser), **C12** (frozen directive grammar — needs
  only the grammar, not a broad parser dep), **C11** (blocks schema + API). Informs
  **C13**.
- **Sibling-ownership note:** Owns the renderer/editor UI + the renderer-library swap +
  sanitizer/iframe security; must NOT own the serialization format (C12), the
  `space_blocks` table/API (C11), or any export/custody/repo-file logic (C13).

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
  Parameterize the hard-coded `mandible_companion_issue = d25bac5` so it does not
  survive generalized space/document ingestion. **DEFER** live paragraph-level
  backref display and the `mandible.space_snapshot.v1` packet to a later item.
- **Owned surfaces:** HumbleB-side adapter changes (`humbleb-repo/humbleb/sources/
  mandible.py`, generalize beyond issue packets, parameterize companion issue;
  `humbleb-repo/tests/test_mandible_adapter.py`); Mandible-side export-as-source glue
  (consuming C13's export); `knowledge-backrefs` return-channel wiring (transport
  allowlist provided by C4). **Cross-repo:** subagent must read the HumbleB repo's own
  CLAUDE.md/instructions before editing it.
- **Acceptance criteria:**
  - A Space document exports as a repo-authoritative snapshot and ingests through the
    existing bridge as a `source_type='artifact'` source; tested.
  - `d25bac5` is parameterized; HumbleB adapter tests updated to not assert the
    fixture value for generalized sources.
  - No `mandible.space_snapshot.v1` apparatus and no live block-level backref UI in
    this child (deferred-item boundary respected).
  - **Standing AC:** architectural-reflection (#4 — touches cross-repo bridge).
- **Non-goals:** No `space_snapshot.v1`; no live paragraph-level backrefs; no new
  HumbleB apparatus beyond generalizing the existing bridge.
- **Dependencies:** **C13** (export/custody — the repo-authoritative snapshot),
  **C12** (serialization), **C4** (`/api/knowledge-backrefs` allowlisted — the
  return channel needs the transport child's allowlist). Coordinated under **a8fbc09**
  (cross-repo; bracket refs only for the HumbleB-side child).
- **Sibling-ownership note:** Owns the bridge generalization + export-as-source glue;
  must NOT build the deferred snapshot packet or block-level backref UI; depends on
  C4 having allowlisted `/api/knowledge-backrefs`.

---

### C16 — Auth-merge / docs-branch promotion flow

- **Title:** `Docs-branch promotion via short-lived proxy branch`
- **Labels:** `feature`, `maintenance`
- **Branch:** `feature/spaces-docs-promotion`
- **Scope:** Implement promotion of the long-lived docs branch into the protected
  branch (**develop if present, else main**; verified here = `main` per Mandible repo
  conventions) **without destroying the docs worktree**: on explicit promotion, cut a
  throwaway `promote/docs/<ts>` branch from the docs-branch head and submit **that**
  to the auth queue, so `cleanup_merged_worktrees` (`cli/auth-merge.sh:410`) tears
  down only the disposable proxy worktree. Optionally implement
  `--preserve-head-branch` to skip cleanup for flagged persistent branches (recorded
  alternative). **Verify the `Mandible-Issue:` trailer gate so routine docs commits
  pass promotion verification — that gate is in `src/routes/auth.ts`** (the auth-merge
  route at ~109; `git log --no-merges base..head` at ~868; the `Mandible-Issue:` scan
  at ~892), **NOT `cli/auth-merge.sh`.** This child owns the `src/routes/auth.ts`
  verification path for any verification change, and owns `cli/auth-merge.sh` only for
  the cleanup / proxy-branch half (`cleanup_merged_worktrees:410`,
  `--preserve-head-branch`). **This child MODIFIES auth/merge infrastructure, so per
  the global rule it submits its OWN auth request from the protected-branch checkout
  (here `main`)** so the stored merge command exists on the target branch at merge
  time.
- **Owned surfaces:** `src/routes/auth.ts` (the `Mandible-Issue:` verification path:
  route ~109, `git log --no-merges` ~868, trailer scan ~892 — verification change
  half); `cli/auth-merge.sh` (proxy-branch handling / optional
  `--preserve-head-branch`, `cleanup_merged_worktrees:410` interaction — cleanup
  half); promotion helper (CLI or daemon route that cuts the proxy branch and submits
  the auth request); auth-merge + verification tests.
- **Acceptance criteria:**
  - Promotion cuts `promote/docs/<ts>` from the docs-branch head and submits that
    branch; the long-lived docs branch + worktree survive a successful merge (tested
    against the cleanup path).
  - Promotion verification (in `src/routes/auth.ts`) passes only when docs commits
    carry `Mandible-Issue:` trailers; **a test asserts a bare-commit docs branch is
    rejected by the `src/routes/auth.ts` verification path.**
  - The child's own delivery auth request is submitted from the protected-branch
    (`main`) checkout (documented procedure; the auth/merge code change lives on the
    target branch at merge time).
  - **Standing AC:** architectural-reflection (#4 — auth/merge infra).
- **Non-goals:** No custody/export logic (C13); no document UI; no contract-text edits
  (C19).
- **Dependencies:** **C13** (doc custody — the docs branch and linked-commit contract
  it produces).
- **Sibling-ownership note:** Sole owner of `cli/auth-merge.sh` changes and the
  `src/routes/auth.ts` verification-path change in this umbrella; must NOT duplicate
  custody/export logic (C13). **Special handling: this is the only child whose own
  auth request is submitted from the protected-branch checkout.**

---

### C17 — Board/kanban renderer

- **Title:** `Spaces board/kanban renderer`
- **Labels:** `feature`
- **Branch:** `feature/spaces-board`
- **Scope:** A real board/kanban renderer (NOT a throwaway probe): columns /
  swimlanes / WIP via `section_id` + `sort_key` on `space_occurrences`. **Default
  column dimension = reuse issue `worker_status`; PLUS custom columns defined either
  by a filter predicate (reusing the shared filter, C6) or by manually adding specific
  issues to a column.** Persist the custom-column model (open question §14 Q4 — likely
  `section_id` holds the column key + a per-Space column-definition record).
- **Owned surfaces:** new `ui/src/views/spaces/SpaceBoard.tsx` + board components;
  board column-definition persistence (per-Space metadata or column record); board
  tests.
- **Acceptance criteria:**
  - Default columns derive from issue `worker_status`; tested.
  - Custom columns can be filter-defined (via the shared filter) or manual; membership
    persists across refresh per the Dataful-UX contract.
  - Drag between columns writes `section_id`/`sort_key` via the API; SSE reconciles
    without resetting board state.
  - **Standing ACs:** accessibility/keyboard (#5); UI-state-persistence (#2); dist
    hygiene (#3).
- **Non-goals:** No canvas/document; no nav change (C10/C18).
- **Dependencies:** **C2** (API), **C6** (shared filter for filter-defined columns),
  **C10** (nav shell). Reuses (does not re-extract) the C6 shared filter.
- **Sibling-ownership note:** Owns the board view + column model; reuses the C6 shared
  filter module; must NOT re-extract it.

---

### C18 — Graph demotion + default-route flip

- **Title:** `Graph demotion to drill-down and default-route change to Spaces`
- **Labels:** `feature`
- **Branch:** `feature/spaces-graph-demotion`
- **Scope:** The **late** half of the nav work: demote the global auto-graph from an
  always-on primary tab to an on-demand drill-down ("relationships/lineage of THIS
  entity"), keeping its debugging perspectives intact (`src/routes/graph.ts:31-73`),
  and **change the default route away from `graph`** (`ui/src/routing.ts:35`) to
  Spaces — **only after Spaces is useful** (collection + canvas landed). The nav item
  + route union already exist (C10); this child flips the default and performs the
  graph-view demotion.
- **Owned surfaces:** `ui/src/routing.ts` (default-route flip at `:35`); graph
  entry-point demotion in `ui/src/views/graph.tsx` (nav/positioning only, not the
  editing logic — **sequences after C6**, which adds the graph "Add to Space"
  action); routing tests.
- **Acceptance criteria:**
  - Default route changes to Spaces **only after** collection + canvas exist
    (sequenced last among UI lanes).
  - Graph demoted to on-demand drill-down; debugging perspectives preserved.
  - The default-route flip is a final, separable commit so it can be held back if
    Spaces isn't yet ready.
  - **Standing AC:** dist hygiene (#3).
- **Non-goals:** No renderer logic (C7/C8a/C8b/C14/C17); no nav-item/route-union add
  (C10 did that); no removal of graph debugging perspectives.
- **Dependencies:** **C7** + **C8a** (Spaces must be useful before the default-route
  change), **C10** (nav shell), **C6** (sequences before this on `graph.tsx`).
- **Sibling-ownership note:** Owns the default-route flip + graph demotion; must NOT
  re-add the nav item/route union (C10) or alter renderer internals. **Sequences after
  C6** on `graph.tsx`.

---

### C19 — CLAUDE.md / Interface-Contract reflection (dotfiles)

- **Title:** `Document the mandible space CLI and docs-branch commit flow`
- **Labels:** `feature`, `maintenance`
- **Branch:** `feature/spaces-contract-reflection` (**dotfiles repo**)
- **Scope:** Propose the `~/.claude/CLAUDE.md` + **Mandible Interface Contract**
  updates implied by Spaces: the `mandible space ...` command surface (contract
  version bump + command list) and the decided docs-branch document-commit flow
  (agent-key linked commits on a docs branch; auth queue only on explicit promotion
  via a proxy branch). Filed in the **dotfiles repo**, not Mandible. Do NOT edit the
  compiled `~/.claude/CLAUDE.md` directly — it is a dotfiles change requiring its own
  feature worktree + auth. **This child owns the dotfiles change itself** (standing AC
  #4: backend/auth children reflect and file dotfiles issues; this is where those land).
- **Owned surfaces:** dotfiles-repo source for the Mandible Interface Contract fragment
  and the global `CLAUDE.md` module (the source that compiles into `~/.claude/CLAUDE.md`);
  no Mandible-repo files.
- **Acceptance criteria:**
  - A dotfiles-repo Mandible issue + branch proposes the `mandible space` contract
    additions and the docs-branch commit-flow wording.
  - Contract version is bumped to include the `space` command family.
- **Non-goals:** No Mandible-repo code; no compiled-file direct edits.
- **Dependencies:** **C3** (CLI surface to document), **C16** (promotion flow to
  document). Parallel-able once those are designed.
- **Sibling-ownership note:** The only **dotfiles-repo** child; must NOT edit any
  Mandible-repo file. Cross-repo: read the dotfiles repo's own instructions before
  editing.

---

## 3. Dependency DAG

```
C1 spaces-schema (root)
 └─> C2 spaces-api  (owns src/spaces/events.ts enum; owns backend /seed evaluator)
      ├─> C3  spaces-cli                 (also needs C11 for `block` subcommands)
      ├─> C4  spaces-transport-sse       (consumes C2 event enum; no cycle)
      ├─> C5  spaces-ref-parser  (FIX)
      │     └─> C12 spaces-serialization (owns spaces-doc.v1 grammar ext to C5's module)
      │           ├─> C14 spaces-document   (needs frozen grammar from C12, + C5, C11)
      │           └─> C13 spaces-doc-custody (needs C12 + C14)
      ├─> C6  spaces-seed-filter         (after C5 on shared files; before C18 on graph.tsx)
      │     ├─> C17 spaces-board
      │     └─> C18 spaces-graph-demotion (also needs C7, C8a, C10)
      ├─> C7  spaces-collection          (needs C2 + C5 + C10)
      ├─> C8a spaces-canvas__nodes       (needs C2 + C10)
      │     └─> C8b spaces-canvas__edges (couples to C3 promote-edge)
      ├─> C10 spaces-nav-shell           (early; C7/C8a mount into it)
      └─> C11 spaces-blocks-schema       (needs C1 + C2; coordinates with C12 on block id)
            └─> C14 spaces-document
C13 spaces-doc-custody
 ├─> C16 spaces-docs-promotion (auth.ts verification + auth-merge cleanup; submits from main)
 └─> C15 spaces-humbleb        (also needs C12, C4 allowlist)
{C3, C16} ──> C19 spaces-contract-reflection (dotfiles)
```

Edge list (X → Y means Y depends on X):
C1→C2; C2→{C3,C4,C5,C6,C7,C8a,C10,C11}; C5→C12; C5→C6 (file-serialize); C12→{C11(coord),C14,C13}; C11→C14; C11→C3 (block CLI); C14→C13; C13→{C15,C16}; C4→C15; C6→{C17,C18}; {C7,C8a,C10}→C18; C8a→C8b; C3↔C8b (promote-edge coord); {C3,C16}→C19.

**Cycle removal:** the former soft C2↔C4 event-name cycle is removed by making C2
the sole owner of `src/spaces/events.ts` and C4 a strict consumer of that frozen
enum.

---

## 4. Suggested phase ordering for dispatch

| Phase | Children | Notes |
|---|---|---|
| **P1** | C1 → C2 → (C3, C4, C10 in parallel after C2) | Schema + API backbone (incl. event enum + `/seed`) + CLI + transport/SSE + early nav shell. C1 strictly serial first. C10 early so the UI milestone is reachable. |
| **P2** | C5 (FIX), C6 (after C5 on shared files); then C7, C8a (parallel, the "usable whole"); C8b after C8a | Ref-parser fix + filter; collection + canvas nodes ship together (plan §13); canvas edges follow. |
| **P3** | C12 (after C5); C11 (after C2, coord C12 on block id); then C14 (after C5+C12+C11) | Serialization + blocks schema + document renderer. |
| **P4** | C13 (after C12+C14); C16 (after C13, **from `main` checkout**) | Custody/export + repo-file registration + promotion flow. |
| **P5** | C17 (after C6) | Board renderer — parallel-able earlier; placed here to match plan phasing. |
| **P6** | C15 (after C13, under a8fbc09) | HumbleB ingest-as-source v1. |
| **P7 (parallel)** | C18 (after C6, C7, C8a, C10); C19 (after C3+C16) | Graph demotion + default-route flip; dotfiles contract reflection. |

C17 and C18 are parallel-able earlier than their phase number; the ordering matches
the plan's Phase numbering for reviewer continuity.

---

## 5. Ownership-collision matrix

Shared files touched by more than one child, with the serialization/region rule:

| File | Children | Resolution |
|---|---|---|
| `src/db.ts` (MIGRATIONS) | C1, C11, C13 | **Serialize** — each takes the next contiguous version at integration in merge order (`assertMigrationSequence`, `:2020`). No pre-reserved version numbers. |
| `src/ledger/backup.ts` (`METADATA_BACKUP_TABLES`) | C1, C11, C13 | Serialize with the migrations; each adds only its own table(s). |
| `src/routes/spaces.ts` | C2 (creates), C11 (`/blocks*`) | C2 creates + registers via `src/index.ts`; C11 extends with `/blocks*`. C11 after C2. |
| `src/spaces/events.ts` | C2 (owns), C4 (consumes), C11 (consumes) | C2 creates + freezes the enum; C4/C11 import only. Removes the C2↔C4 cycle. |
| `src/routes/auth.ts` | C16 | Sole owner (the `Mandible-Issue:` verification path). |
| `cli/auth-merge.sh` | C16 | Sole owner (cleanup / proxy-branch half). |
| `bin/mandible` + `cli/space.sh` | C3 | Sole owner of `space)` dispatch + `cli/space.sh` (incl. the moved `block` subcommands). |
| `ui/src/artifact-links.ts` → `ui/src/resource-refs.ts` | C5 | C5 replaces it; C12 extends the resulting module (grammar only). |
| `ui/src/components/ledger/IssueDetail.tsx` | C5, C6 | **C5 before C6** (or disjoint insertion regions). C5 migrates the linkifier call site; C6 adds "Add to Space". |
| `ui/src/views/artifacts.tsx` | C5, C6, C14 | **C5 before C6** (linkifier call site vs. "Add to Space"); C14 changes the document render path (DOMPurify/remark). Disjoint regions: linkify call (C5), header action (C6), doc render path (C14). |
| `ui/src/views/graph.tsx` | C6, C18 | **C6 before C18** — C6 adds the "Add to Space" action; C18 demotes the graph entry point. |
| `ui/src/routing.ts` | C10 (union `:2` + allow-array `:35`), C18 (default route `:35`) | C10 adds `'spaces'` to the union + allow-array; C18 flips the default. C10 before C18. |
| `ui/src/app.tsx` | C10 | Sole owner of the `primaryNavItems` + `NavItem` edits. |
| `ui/src/sanitize.ts` | C14 | Sole owner of the `marked`→remark-directive swap. |
| `ui/src/views/spaces/SpaceCanvas.tsx` | C8a (nodes), C8b (edges) | C8a lands the canvas shell + node layer; C8b adds the edge layer. C8b after C8a. |
| `humbleb-repo/...` | C15 | Cross-repo, sole owner; read HumbleB CLAUDE.md first. |
| dotfiles `CLAUDE.md` / contract | C19 | Cross-repo, sole owner. |

---

## 6. Cross-link edges to create at adoption

**Umbrella → each child:** `parent_child` (19 edges). The 18 in-repo children are
direct `parent_child` of the Spaces umbrella. C19 is in the **dotfiles** repo — link
by `parent_child` if Mandible supports cross-repo parent_child for dotfiles;
otherwise track it via a bracket ref in the umbrella body and an `mandible:`
namespaced label (cross-repo HumbleB-style limitation).

**Do NOT mint `implements` edges between sibling children.** Inter-child edges are
DAG dependencies (build order), not ledger relationship edges.

**Umbrella ↔ existing issues:**

| Source → Target | Type | Direction note |
|---|---|---|
| Spaces umbrella → a8fbc09 | `related` | a8fbc09 is the HumbleB boundary umbrella; the HumbleB ingest child (C15) is coordinated under a8fbc09. The already-filed deferred HumbleB children [0fa21e4], [969781d] (mandible) live under a8fbc09; HumbleB/88dafe5 is cross-repo (bracket ref only). |
| Spaces umbrella → de2f8ac | `references` (+ `related`) | **Downgraded from `implements`** — Spaces refines/diverges from the graph-workspace spec; `implements` overstates fidelity. |
| Spaces umbrella → 2dc97b8 | `related` | Repo-file-as-document registration (C13) realizes one facet of 2dc97b8 — `related`, not `implements`; no single child faithfully realizes it. |
| Spaces umbrella → 41d22a6 | `related` | **COMPLEMENTARY, not superseding** — shared filter (C6). |
| Spaces umbrella → dc87eb3 | `related` | **COMPLEMENTARY, not superseding** — shared view-state/filter patterns. |

> The C15 HumbleB child should additionally be linked under a8fbc09 (`parent_child`
> or `related`) at its own filing, mirroring the umbrella-level `related` edge.

---

## 7. Open risks / scrutiny points

1. **Backend split (C2/C3/C4) coupling.** The plan's single "backend" lane is split
   into REST API / CLI / transport+SSE. **Mitigation (applied):** C2 owns and freezes
   `src/spaces/events.ts`; C4 strictly consumes it (cycle removed). C3 is shell-based
   (`cli/space.sh` + `bin/mandible` dispatch), and its `block` subcommands wait on C11.

2. **Document lane split (C11/C12/C14) + custody (C13).** Split into serialization
   (C12), blocks schema+API (C11), renderer+editor (C14), and custody+repo-file
   registration (C13). Parser-ownership chain is explicit: C5 lands the shared parser;
   C12 owns the `spaces-doc.v1` grammar extension; C14 needs only the frozen grammar.
   Block identity must agree between C11 and C12 (coordination edge).

3. **Migration ordering (C1, C11, C13).** Three children touch `src/db.ts` migrations.
   They must land in contiguous version sequence (`assertMigrationSequence:2020`); **no
   version is pre-reserved** — each takes the next contiguous version at integration in
   merge order. `space_exports` (C13) uses **inline `UNIQUE(repo_id, branch, path)`**
   (external index DDL is lost on backup/restore).

4. **C16 special handling (auth/merge infra).** C16 modifies both the `src/routes/auth.ts`
   `Mandible-Issue:` **verification** path (route ~109, `git log` ~868, scan ~892) and
   the `cli/auth-merge.sh` **cleanup** path. Its own delivery auth request must be
   submitted **from the protected-branch (`main`) checkout**. The "bare-commit docs
   branch is rejected" AC targets the `src/routes/auth.ts` verification path.

5. **C15 cross-repo (HumbleB) + a8fbc09.** C15 edits the HumbleB repo (own CLAUDE.md, own
   umbrella). Cross-repo `parent_child` links unsupported (bracket refs only). C15 needs
   `/api/knowledge-backrefs` allowlisted by C4. Reconcile against existing deferred
   HumbleB children ([0fa21e4], [969781d], HumbleB/88dafe5).

6. **C6 filter extraction risk to Timeline.** Preserve `TimelineFilterRowSpec` shape
   (predicate field is `scope`, an AST). A round-trip-with-Timeline test guards it. C17
   reuses (does not re-extract). **`/seed` evaluation stays in C2** (backend); C6 owns
   only UI extraction + Add-to-Space; both depend on the shared predicate-evaluator.

7. **Nav/route split (C10 vs C18).** C10 (early) lands the route union + nav item so the
   collection+canvas milestone is reachable; C18 (late) flips the default route + demotes
   the graph only after Spaces is useful. C18 sequences after C6 on `graph.tsx`.

8. **Ref-parser is a FIX, not greenfield (C5).** `ui/src/artifact-links.ts:3`'s
   `/^artifact:([0-9a-f]{7,64})$/i` cannot match `artifact:sha256:<hash>` — a live bug.
   C5 fixes it with a regression test and gates the document renderer (C14).

9. **`mandible space` CLI as contract surface (C3 ↔ C19).** CLI lands in Mandible (C3,
   shell); contract text is a dotfiles change (C19). Sequence C19 after C3's design.

10. **Membership-duplication temptation.** Do not mirror membership into `artifact_links`
    (plan §3.2). Membership is queried only from `space_items` via `idx_space_items_by_ref`.

---

## 8. Resolved false alarms (noted, not actioned)

Two codex findings were **stale false alarms** from grading earlier `/tmp` plan copies
and are NOT actioned:

- **CASCADE-vs-RESTRICT.** RESTRICT on `spaces.project_id` is **final/settled** (Spaces
  are precious authored state; the space-internal cascade stays CASCADE). The codex
  flag came from a stale copy that predated the RESTRICT decision.
- **Sidecar-vs-in-band.** The canonical format is **in-band `spaces-doc.v1`** with **no
  canonical sidecar** (settled). The "mandatory sidecar manifest" the codex flagged was
  the superseded A3 design, present only in a stale `/tmp` copy.

As part of this reconciliation, the `/tmp/mandible-ux-review.EixOws/UMBRELLA-PLAN.md`
and `DOCUMENT-CUSTODY-DESIGN.md` copies were **refreshed** from the corrected worktree
versions so the review packet is internally coherent.
