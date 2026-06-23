# Mandible — Project / Document Organizing Surface: Problem & Options

> **Status: ORIGINAL REVIEWER BRIEF — partially superseded.** This is the
> point-in-time analysis sent to external reviewers; it is preserved as the
> historical input the GPT‑5.5‑pro and Codex reviews responded to. Where its
> details differ from the settled design, **the settled design wins**: see
> [`UMBRELLA-PLAN.md`](./UMBRELLA-PLAN.md), [`DOCUMENT-CUSTODY-DESIGN.md`](./DOCUMENT-CUSTODY-DESIGN.md),
> and [`CODEX-REVIEW-NOTES.md`](./CODEX-REVIEW-NOTES.md). In particular, this brief
> predates: the **P1′** three-table schema (`space_items` / `space_occurrences` /
> `space_blocks`) that replaces the `space_members` sketch below; the term
> **"document"** (this brief says "manuscript"); the **MDX-in-band** serialization
> (no sidecar); **RESTRICT** on `spaces.project_id`; **Mandible-custody-until-
> explicit-commit** (no auto-track); the **HumbleB v1 = ingest-as-source** scope;
> and the framing that **Spaces is complementary to Timeline, not a replacement.**
> Read this brief for problem framing only, not for the current schema or
> decisions.

> **Reviewer prompt:** This document is a self-contained brief for an external
> high-intelligence reviewer with no prior Mandible context. The repo clone
> lives in `mandible-repo/` next to this file. Please:
>
> 1. **Stress-test the central thesis**: that all four candidate features
>    (canvas, document, board, collection) are renderers over one missing
>    primitive (`Space`) rather than independent features. Where does this
>    decomposition break down?
> 2. **Challenge the Mandible-authors / HumbleB-associates boundary** in §6.
>    Is there work that belongs in Mandible that the brief assigns to HumbleB,
>    or vice versa?
> 3. **Sanity-check the P1 schema sketch** against the actual existing schema in
>    `mandible-repo/src/db.ts`. Does the proposed `spaces` +
>    `space_members` + `space_edges` design compose cleanly with
>    `ledger_relationship_edges`, `artifact_links`, and
>    `ledger_issue_checkpoints`? Are there foreign-key or constraint risks?
> 4. **Flag the highest-risk assumption** — the one thing most likely to make
>    the proposed approach fail or require a painful rework.

---

## 0. Context for the reviewer

**Mandible** is a local-first agent control plane and conversation browser. Key
facts:

- **Frontend:** Preact 10, built with esbuild, hash-based routing
  (`ui/src/routing.ts`). Tabs are declared in `ui/src/app.tsx` (primary:
  console/chat, graph, timeline, auth, issues, artifacts, inbox; secondary:
  work/projects, review, presets, logs).
- **Backend:** A Node.js daemon. SQLite via `better-sqlite3`. Schema migrations
  live in the `MIGRATIONS` array in `src/db.ts`. New columns/tables go in new
  migration entries — never in ad-hoc `ALTER TABLE` or `ensureSchema()` helpers.
- **Data model highlights:** issues, comments, artifacts (content-addressed,
  sha256), sessions, work-units. Artifacts use resource URIs (`repo://` and
  `artifact://`) resolved via `artifact_aliases`. Typed relationship edges
  between issues/comments. A return channel for an external knowledge system
  (HumbleB).
- **User:** sole developer. The immediate goal is a way to organize heterogeneous
  things — issues, comments, figures, external docs — into logical project
  groups, ultimately to support writing a *manuscript* that pulls together
  results. Two existing views exist but neither fills this role well: an
  auto-generated **GRAPH** view (issues + relationships as a node-link diagram)
  and a **TIMELINE** view (issues/events on a shared global time axis). The
  user has also been using, and dislikes, Obsidian for this organizing role.

---

## 1. The reframe (central thesis)

The user named several candidate features: canvas / mind-map, a generalized
graph, "canonical documents" (manuscript sections), kanban, collections. These
look like four independent features. They are not.

They are four **renderers** over one missing primitive: a user-authored **Space**
— a named collection of heterogeneous references (issues, comments, artifacts,
external docs) plus optional 2D layout plus optional ordered narrative.

> Decide the backing primitive first. Canvas / document / board / list are
> projections of it. Building them as separate features would duplicate
> membership management, persistence logic, and ref-rendering logic three or four
> times over.

This document is structured around that thesis: §3 picks the primitive, §4
defines the renderers, §5–6 resolve where the global graph fits and who owns
what.

---

## 2. What already exists in Mandible (grounding — verified against the clone)

### 2.1 Frontend (`ui/src/`)

**Framework and routing.** Preact 10. Build: esbuild. Hash-based routing in
`ui/src/routing.ts`. Tabs registered in `ui/src/app.tsx` (primary nav: lines
990-1044; secondary nav: lines 1046-1076).

**GRAPH view** (`ui/src/views/graph.tsx`). Uses **@xyflow/react v12** (imported
at line 8; pinned at `^12.10.2` in `package.json`). React Flow is a library
whose native model is user-arrangeable, draggable nodes. Mandible uses it
**read-only**: `nodesDraggable={false}` (line 1285), deterministic hierarchical
auto-layout computed in `ui/src/graph/layout.ts` (a bespoke column-layout
engine; no external layout library like dagre or ELK), positions recomputed
every render, **never persisted**. The graph has multiple modes toggled via a
`GraphMode` type: `issue`, `work`, `activity`, `provenance`, `provider-lineage`,
`artifact-lineage`. Data arrives via `GET /api/graph?mode=...`.

**TIMELINE view** (`ui/src/views/timeline.tsx`). Shared global time axis (treated
as a contract — changing row visibility never changes the meaning of horizontal
time coordinates). Rich per-project view-state persistence: localStorage prefix
`mandible_timeline_view_state:v1`, with full key
`mandible_timeline_view_state:v1:<projectId>` plus URL parameter mirroring. This
is the **pattern to copy** for any new persisted view.

**Markdown and artifact rendering.** `marked` for Markdown-to-HTML conversion
(called by individual components); `DOMPurify` for sanitization (via
`ui/src/sanitize.ts`, which exports `sanitizeHtml` / `sanitizeMarkdown` wrappers
over `DOMPurify.sanitize` — callers invoke `marked` themselves before passing
HTML here). Artifact previews in `ui/src/views/artifacts.tsx` (content types:
json, markdown, text, html, binary, bundle). **Artifact URI linkifier** at
`ui/src/artifact-links.ts`: rewrites inline `artifact:sha256:...` and `repo://`
refs into clickable cross-links. So "a document with embedded artifact previews"
is already mostly assembling existing primitives.

### 2.2 Backend / data model (`src/db.ts`)

All schema facts are from the `MIGRATIONS` array.

**Core entities.** `ledger_issues` (status: open/closed; resolution; kind;
priority; worker_status: none/in_progress/done/blocked/pivot-needed),
`ledger_comments` (ordinal-ordered).

**Relationship edges.** `ledger_relationship_edges` — first introduced in
migration 55 (line 1148); the migration named `structured_relationship_edges`
(version 75, line 1767) is its canonical definition (lines 1769-1805). Key
constraints:

- `source_entity_type` and `target_entity_type` are each `CHECK(...IN
  ('issue','comment'))` — **artifacts cannot be endpoints**.
- `link_type` is `CHECK(link_type IN ('parent_child','blocks','duplicate_of',
  'related','references','fixed_by','caused_by','implements','tests'))` — **9
  fixed types, no free labels**.

**Artifact links** (`artifact_links`). Migration 67 (`artifact_aliases_and_links`,
line 1567). Table defined at lines 1592-1605. Much more flexible: links an
artifact to any `entity_type` / `entity_id` (no type constraint), with arbitrary
`link_type` and `role` fields plus `metadata_json`. This is the flexible join
table for artifact-to-anything membership.

**Artifacts** (content-addressed, sha256), `artifact_aliases` (resolves `repo://`
and `artifact://` URI schemes). No single central URI parser; resolution is via
`artifact_aliases`.

**Knowledge backrefs.** `knowledge_backrefs` — migration 68, line 1623. Table at
lines 1627-1648. A return channel designed so an external knowledge system
(HumbleB) can hand back "this artifact/document is referenced by these
claims/entities." Column `provider_id` defaults to `'humbleb'`; `source_type IN
('artifact','document')`; `ref_type IN ('document','entity','claim')`. Migration
comment (line 1624-1625): _"Bug: c9531c — keep HumbleB KG ids as typed external
references from artifacts/documents; Mandible does not own document chunks,
entities, or claims."_

**Issue checkpoints.** `ledger_issue_checkpoints` — migration 72, line 1715.
Table at lines 1718-1732. Kind-tagged, arbitrary `payload_json` attached to an
issue. Could host structured view/document data, but is **issue-scoped** — not
reusable as a general Space primitive.

**`ledger_projects`.** Scoping unit; essentially the git-repo-as-project.

**Schema gap for canvas/layout.** There is **no x/y position, canvas layout, or
saved arrangement anywhere** in the schema. This is the single largest structural
gap.

---

## 3. The backing-primitive options (pick one before building renderers)

Three options, ordered from most to least recommended.

### P1 — New first-class `Space` entity (recommended)

New tables:

```sql
-- spaces: named collections with a default renderer hint
CREATE TABLE spaces (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES ledger_projects(id),
  title       TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'canvas'
              CHECK(kind IN ('canvas','document','board','collection')),
  description TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- space_members: heterogeneous references with optional 2D layout
CREATE TABLE space_members (
  id          TEXT PRIMARY KEY,
  space_id    TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL  -- 'issue','comment','artifact','external_ref'
              CHECK(entity_type IN ('issue','comment','artifact','external_ref')),
  entity_id   TEXT NOT NULL,
  x           REAL,          -- null if not placed on a canvas
  y           REAL,
  ordinal     REAL,          -- null if not in a document/list
  section     TEXT,          -- document section heading
  note        TEXT,          -- per-member annotation
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

-- space_edges: user-authored relationships inside a Space
-- FREE labels (unlike the 9 constrained types in ledger_relationship_edges)
CREATE TABLE space_edges (
  id            TEXT PRIMARY KEY,
  space_id      TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  source_member TEXT NOT NULL REFERENCES space_members(id) ON DELETE CASCADE,
  target_member TEXT NOT NULL REFERENCES space_members(id) ON DELETE CASCADE,
  label         TEXT,
  style_json    TEXT NOT NULL DEFAULT '{}'
);
```

Approximately 3 migrations, a handful of API routes, and one new top-level view.
The design supports all four renderers without schema changes between them. Clean
separation from the issue ledger: Space is an authoring layer, not a
coordination layer.

**Recommended.**

### P2 — Reuse umbrella issue + issue checkpoints

Treat an existing umbrella issue as the "project/Space." Store canvas layout as a
`kind='canvas-layout'` checkpoint on that issue. Use existing `parent_child`
edges for membership. No new tables.

**Cons:**

- Conflates "issue" semantics (coordination, lifecycle open/closed) with
  "project/manuscript" semantics (authoring, archival).
- Checkpoint is issue-scoped — one issue, one layout.
- `ledger_relationship_edges` cannot have artifact endpoints, so artifact
  membership would have to piggyback on `artifact_links` with a different query
  path — two membership systems.
- Hacky: query semantics ("give me Space members") require interpreting
  checkpoint blobs rather than relational joins.

**Viable as a proof-of-concept only.**

### P3 — Saved graph views + artifact_links

Add a "saved view" record (filter preset + per-node position map) on top of the
existing GRAPH view. Store positions in localStorage or a small table. Use
`artifact_links` for membership.

**Cons:**

- localStorage positions are not durable or shareable across machines.
- The existing graph auto-layout regenerates positions every render; saved
  positions would require overriding that, tangling with `graph/layout.ts`.
- No document renderer path.
- Still two membership systems (relationship_edges for issues, artifact_links for
  artifacts).

**Not recommended** except as a stopgap.

---

## 4. The renderers (projections over the Space primitive)

All four renderers read from `space_members` and `space_edges`. Switching
renderers on a Space does not change membership — it changes how members are
displayed.

### 4.1 Canvas / mind-map

Enable React Flow node dragging (already the library; just remove
`nodesDraggable={false}` and wire `onNodesChange` to persist `space_members.x/y`
and `space_edges`). The canvas is **curated** — only what the user has explicitly
placed — as opposed to the auto-graph, which shows everything. User-drawn edges
use `space_edges.label` (free text), unlike the constrained `link_type` set in
`ledger_relationship_edges`. Directly addresses the complaint that "the graph is
a big mess": the mess is a derived-everything view; the canvas is an
authored-selected view.

### 4.2 Document / manuscript

Ordered `space_members` rows (sort by `ordinal`, group by `section`). Narrative
prose lives in `note` fields or as an artifact (a markdown file registered with
Mandible). Resource URIs in prose (`repo://...`, `artifact://...`) render as
inline cross-links or embedded artifact previews, reusing the existing
`artifact-links.ts` linkifier and the preview logic from `artifacts.tsx`. The
manuscript itself can be registered as a Mandible artifact, giving it
content-address identity and making it ingestible by HumbleB.

### 4.3 Board / kanban

Group `space_members` (or, as a shortcut, issue rows directly) by a column
dimension: `worker_status`, a label, or a per-Space column definition. Cheapest
renderer — could ship before the full Space primitive using only the issue
table, as a Phase 0 validation step (see §7).

### 4.4 List / collection

The trivial membership view: render `space_members` as a flat or tree list with
expandable previews. The backbone all other renderers fall back to when layout
data is absent.

### Cross-renderer operations

"Select a region of the mind-map and convert it into a document" = take a subset
of `space_members` (those in a bounding box on the canvas), assign `ordinal` and
`section` values, switch the Space kind to `'document'`. Trivially expressible
once the primitive is shared. This is impossible if canvas and document are
separate features with separate backing tables.

---

## 5. Should Mandible keep the global graph view?

The auto-graph is "a big mess" precisely because it attempts to be an
**associative / derived** graph of everything — which is HumbleB's job (§6), not
an authoring surface. The fix is to **split derived from authored**:

**Demote the global auto-graph.** Move it from an always-on primary tab to a
focused, on-demand drill-down ("show lineage/relationships for this
issue/artifact"). Keep it as a debugging tool for artifact-lineage,
provider-lineage, and provenance modes. A scoped graph over 10 nodes is useful;
a global graph over 500 nodes is the mess.

**Promote the authored Space/canvas** to the top-level organizing surface. Small,
intentional, user-placed. The authoring surface and the derived-everything surface
are different products and should not share a mode toggle.

Do not try to make the auto-graph into the manuscript tool. That path leads to a
more complicated auto-graph that is still not an authoring surface.

---

## 6. Repo ownership / HumbleB integration

HumbleB (verified in its own repo) is a Temporal-Associative Graph RAG system
(Python, KuzuDB, rustworkx, MCP). A one-way bridge already exists:
`humbleb/sources/mandible.py` + `docs/mandible_document_bridge.md`. Mandible is
authoritative for issues, artifacts, sessions, and provenance. HumbleB ingests a
Mandible export as an immutable source snapshot, extracts statements/claims into
its knowledge graph. The `knowledge_backrefs` table (§2.2) is the return channel.

**Clean division of responsibility:**

| Layer | Owns |
|---|---|
| **Mandible** | Authored structure + control plane: issues, artifacts, resource URIs, Space/canvas/document/board primitives + their UI, manuscript authoring |
| **HumbleB** | Derived / associative structure + retrieval: extracted statements, temporal knowledge graph, associative "what relates to what" queries |

Under this division:

- A manuscript authored in Mandible is just another source document HumbleB can
  ingest on its next sync.
- HumbleB can return citations via `knowledge_backrefs` ("this figure is cited
  by these KG claims"), which the document renderer can surface as
  margin annotations or hover previews.
- "Automatically surface related items" is a HumbleB query result, not a Mandible
  auto-graph. This resolves §5: stop building an associative graph in Mandible;
  Mandible should author.

**Anti-goal:** do not build a second knowledge graph or RAG inside Mandible. The
Mandible canvas is small, intentional, user-placed. HumbleB does associative
reasoning at scale.

---

## 7. Recommended phasing

Each phase is independently shippable and validates appetite before the next.

**Phase 0 — Board/kanban over existing issues (cheap win).** No new schema.
Group issues by `worker_status` or label in a new tab. Validates whether a
structural organizing view is useful before committing to the Space primitive.

**Phase 1 — Space primitive + Collection list + Canvas renderer.** ~3 migrations
(`spaces`, `space_members`, `space_edges`). API routes: CRUD for spaces and
members. UI: enable React Flow dragging, persist positions, wire member add/remove
from existing issue/artifact detail panes. Reuse the Timeline per-project
persistence pattern (localStorage + URL mirroring) for the non-positional state
(active Space, renderer mode, sidebar filters).

**Phase 2 — Document / manuscript renderer.** Narrative ordering (ordinal +
section), markdown prose attached as notes or as a registered artifact, resource
URI transclusion via the existing linkifier. Register the finished manuscript as a
Mandible artifact so HumbleB can ingest it.

**Phase 3 — Cross-renderer operations + HumbleB backref surfacing.** Canvas
region → document conversion. Surface `knowledge_backrefs` returns as
citation/reference annotations in the document renderer.

---

## 8. Trade-offs table

| Approach | Effort | Reuses existing code | Addresses manuscript goal | Addresses mind-map goal | Durability / shareability | HumbleB fit | Main risk |
|---|---|---|---|---|---|---|---|
| **Generalize auto-graph into canvas** | Medium | High (xyflow already in use) | Weak — derived graph ≠ authoring surface | Partial — but no membership curation | Poor — positions not persisted | Poor — wrong layer | Makes the "big mess" worse; conflates derived/authored |
| **New Space primitive (P1) + renderers** | Medium-High | High (xyflow, linkifier, artifact previews, timeline persistence pattern) | Strong | Strong | Strong — DB-backed | Strong — manuscripts become ingestible artifacts | Schema/API investment up front; needs discipline to not duplicate relationship edges |
| **Document-first (skip canvas initially)** | Medium | High | Strong | Weak initially | Good — markdown artifacts are durable | Strong | Defers the canvas; mind-map use case waits |
| **Board-first (Phase 0)** | Low | High | Weak initially | None | Medium — could be localStorage | Neutral | Validates appetite but doesn't address manuscript |
| **Obsidian plugin / external editor** | Low | None (external tool) | Partial — prose editing works | Weak (no artifact transclusion) | External — files outside the control plane | Poor — no `knowledge_backrefs` path; no artifact previews | State lives outside Mandible; no artifact-preview transclusion; user dislikes Obsidian |

---

## 9. Open questions for the user

1. **Prose location.** Is the manuscript's source-of-truth prose meant to live
   *inside* Mandible (as a registered markdown artifact with
   `artifact://sha256:...` identity) or in an external file the Space merely
   references?

2. **Multiplicity.** Single shared Space per project, or many named Spaces per
   project (e.g., one per manuscript chapter, one per experiment)? The P1 schema
   supports many; the UI affordances differ.

3. **Membership seeding.** Should Space membership be explicit-only (the user
   adds each member by hand), or should it be seedable from a filter/query (e.g.,
   "all issues with label `experiment` become initial members")? The latter
   requires a saved-search concept Mandible doesn't currently have.

4. **Position durability.** Is per-member canvas layout meant to be
   shareable/durable (→ DB, which P1 gives) or personal/ephemeral (→ localStorage
   only, which is cheaper but lost on machine change)?

5. **Global graph retirement.** What is the appetite for demoting the global
   graph tab to a drill-down, or hiding it behind a settings toggle, once a
   canvas view exists?

---

## Appendix: Key file locations in the clone

All paths are relative to `mandible-repo/`.

| File | What to look at |
|---|---|
| `src/db.ts` | `MIGRATIONS` array — the authoritative schema; all table definitions |
| `src/db.ts` lines 1148-1184 | `ledger_relationship_edges` first definition (migration 55) |
| `src/db.ts` lines 1567-1619 | `artifact_aliases` + `artifact_links` (migration 67) |
| `src/db.ts` lines 1623-1648 | `knowledge_backrefs` stub (migration 68) |
| `src/db.ts` lines 1716-1733 | `ledger_issue_checkpoints` (migration 72) |
| `src/db.ts` lines 1767-1806 | `ledger_relationship_edges` canonical definition (migration 75) |
| `ui/src/app.tsx` lines 990-1076 | Tab registration (primaryNavItems + secondaryNavItems) |
| `ui/src/views/graph.tsx` | Graph view — note `nodesDraggable={false}` at line 1285, `GraphMode` type, mode labels |
| `ui/src/graph/layout.ts` | Bespoke column-layout engine; positions computed, not persisted |
| `ui/src/views/timeline.tsx` line 54 | localStorage prefix `mandible_timeline_view_state:v1` — persistence pattern to copy |
| `ui/src/artifact-links.ts` | URI linkifier for `artifact:sha256:...` and `repo://` refs |
| `ui/src/sanitize.ts` | DOMPurify wrappers; `marked` is called by callers before passing HTML here |
| `ui/src/views/artifacts.tsx` | Artifact preview rendering (json/markdown/text/html/binary/bundle) |
| `docs/mandible_document_bridge.md` | HumbleB bridge design doc |
