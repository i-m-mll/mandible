# Mandible "Spaces" — Umbrella Plan (P1′)

> Status: planning. This document is the basis for a Mandible **Spaces** umbrella
> (a multi-issue implementation effort). It encodes settled decisions; it is not
> an invitation to relitigate the direction. Code references are verified against
> the clones at `/tmp/mandible-ux-review.EixOws/mandible-repo/` and
> `/tmp/mandible-ux-review.EixOws/humbleb-repo/`; cited paths are the equivalent
> real repo paths (e.g. `src/db.ts:NNNN`).

---

## 1. Problem recap

Mandible needs an authored surface for organizing heterogeneous references —
issues, comments, artifacts, external docs — into logical project groups, leading
ultimately to writing a **document** that pulls results together. Two existing
views fail this role: the auto-generated **Graph** (a derived node-link diagram of
everything, "a big mess") and the **Timeline** (events on a global time axis).
Full analysis, including the candidate-feature decomposition and the
Mandible-authors / HumbleB-associates boundary, is in
[`PROBLEM-AND-OPTIONS.md`](./PROBLEM-AND-OPTIONS.md). That analysis also went
through an external GPT‑5.5‑pro review (held outside this repo); we adopt most
of it, especially its schema critique.

The central thesis (kept): **canvas, document, board/kanban, and
collection/list are four renderers over one missing primitive — an authored
`Space`** — not four independent features. Building them separately would
duplicate membership, persistence, and ref-rendering logic three or four times.

> **Spaces is COMPLEMENTARY to Timeline, not a replacement.** Spaces does **not**
> replace or subsume the Timeline view. **Timeline** is the chronological / global
> time-axis view; **Spaces** is the user/agent-structured organizing surface. They
> are different products serving different intents and both remain primary. Any
> cross-links to Timeline (issues 41d22a6, dc87eb3) are **shared-component /
> related**, never "supersedes." The shared filter component (§6.1) is **reuse**,
> not absorption: extracting a predicate/filter component for both surfaces does
> not fold one into the other.

> **Terminology.** Throughout these docs the renderer is the **document
> renderer** and the exportable artifact is a **document** (formerly "manuscript",
> which was too narrow). "Space" is the container; "document" is one of its
> renderers / exportable artifact types. A **document** includes both
> authored-in-Mandible prose **and** existing tracked repo files (READMEs, design
> specs, whitepapers) registered as canonical documents — see §3.5 and §10.

---

## 2. Settled direction

These are decided. Encode them; do not reopen.

1. **Build the authored `Space` primitive (P1) in the reviewer's refined form
   P1′.** P1′ separates the *referenced thing* (`space_items`) from its
   *visual/document occurrence* (`space_occurrences`), and gives document prose
   first-class blocks (`space_blocks`). This avoids the highest-risk schema trap:
   one `space_members` row trying to be membership, canvas node, document block,
   annotation, and board card at once.

2. **Authored vs. derived split.** Spaces are **authored** (small, intentional,
   user/agent-placed). The existing auto-graph is **derived**. Do **not** evolve
   `ui/src/views/graph.tsx` into the canvas — build a new `SpaceCanvas` /
   `SpacesView`. Reuse visual components and the layout function for *initial*
   placement only.

3. **Graph demotion.** Demote the global graph from an always-on primary tab to an
   on-demand drill-down ("relationships/lineage of THIS entity"). Add a top-level
   `Spaces` nav item. Change the default route away from graph **only after**
   Spaces is useful. Keep the graph's debugging perspectives (activity, issue,
   work, provider-lineage, artifact-lineage, provenance —
   `src/routes/graph.ts:31-73`) intact. The default route is `graph` for
   empty/unknown hashes today via several fallbacks — `hashWithSidebarParam`
   (`ui/src/routing.ts:14,23`) and `parseRouteFromHash` (`:35,:37`, allow-array
   `:52`, final `: 'graph'` at `:54`); the new `Spaces` nav item joins the `Route`
   tab union (`ui/src/routing.ts:2`) and `primaryNavItems` (`ui/src/app.tsx:990-1044`).

4. **Layout durability.** Occurrences (node positions), items, and edges are
   **durable, DB-backed canonical project state** (single user; agents place nodes
   authoritatively; must be backed up). Only ephemeral view bits — zoom, scroll,
   current selection, active renderer — live in localStorage/URL, following the
   existing Timeline view-state pattern.

5. **No Phase 0 validation probe.** See §11 (Reconciliation). The first milestone
   is a usable whole (backend + collection list + canvas), shipped together. The
   board becomes a real renderer built later, not a throwaway probe.

---

## 3. The P1′ schema

New tables land as **new `MIGRATIONS` entries in `src/db.ts`** (the latest version
is currently **82**; new entries take the **next contiguous version**). Per project
convention, schema changes go in the `MIGRATIONS` array — never ad-hoc `CREATE
TABLE IF NOT EXISTS` in modules, and never in `ensureSchema()` helpers (those are
fresh-DB fallbacks only). Each migration carries its `CREATE TABLE` + `CREATE
INDEX` statements in the `statements` array, mirroring `artifact_links`
(migration 67) and `knowledge_backrefs` (migration 68) at `src/db.ts:1592-1648`.

> **No pre-reserved version numbers across parallel branches.**
> `assertMigrationSequence` (`src/db.ts:2020`) requires the migration versions to be
> **contiguous**. The three migration-bearing children (core schema; `space_blocks`;
> `space_exports`) must be **serialized**: each uses the **next contiguous version,
> assigned at integration in merge order** — do NOT hard-code `v83`/`v84`/`v85`
> against parallel branches (a later-merging branch would collide or leave a gap).
> The version labels used below (e.g. "v83 `spaces_core`") are illustrative of the
> *ordering*, not reservations.

> **Codex P1′-schema verdict (review B1): the three-table split is justified, not
> over-engineered.** A single flat `space_members` table collapsing membership,
> canvas node, document block, annotation, and board card into one row would be
> "nullable soup" — most columns NULL most of the time, with no integrity story.
> Separating `space_items` (canonical membership) from `space_occurrences` (visual
> appearance) and `space_blocks` (document structure) is the correct shape.
> **However** `space_blocks` is largely independent and ships with the document
> renderer, not necessarily in the initial core migration (see §3.8 migration
> strategy).

> **Note on `json_valid` CHECK.** The DDL below uses
> `CHECK(json_valid(metadata_json) AND json_type(metadata_json)='object')` on
> every `metadata_json` column where callers treat metadata as a JSON **object**
> (review B9). The existing `artifact_links` / `knowledge_backrefs` tables do
> **not** carry this CHECK (`src/db.ts:1602`, `1637`); the reviewer recommends it
> for the new tables and we adopt it. This is a deliberate refinement over the
> existing pattern, not a copy of it.

> **Inline UNIQUE, not external-index-only, for composite-FK targets (review
> B3).** The metadata backup at `src/ledger/backup.ts:153-184` emits, per table,
> only the table's own DDL (`SELECT name, sql FROM sqlite_master WHERE
> type='table'`, line 155, emitted at line 172) plus `INSERT` rows — it does
> **not** emit standalone `CREATE INDEX` DDL. **Verified against the clone.** A
> uniqueness constraint that exists *only* as an external `CREATE UNIQUE INDEX`
> would therefore be **lost on backup/restore**, silently allowing the very
> duplicate/cross-space rows the constraint was meant to forbid. So every
> composite-FK target and every membership-uniqueness rule below uses an
> **inline table-level `UNIQUE(...)`**, captured in the `CREATE TABLE` DDL. Only
> non-unique **performance** indexes remain as separate `CREATE INDEX` statements
> (their loss on restore is a perf regression, not a correctness bug).

### 3.1 `spaces`

```sql
CREATE TABLE spaces (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES ledger_projects(id) ON DELETE RESTRICT,
  title            TEXT NOT NULL,
  default_renderer TEXT NOT NULL DEFAULT 'canvas'
                     CHECK(default_renderer IN ('canvas','document','board','collection')),
  description      TEXT,
  metadata_json    TEXT NOT NULL DEFAULT '{}'
                     CHECK(json_valid(metadata_json) AND json_type(metadata_json)='object'),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE INDEX idx_spaces_project_updated
  ON spaces(project_id, updated_at DESC);
```

**`ON DELETE` choice — RESTRICT (decided).** Core ledger entities use
`ON DELETE RESTRICT` on `project_id` (e.g. `ledger_issues` at `src/db.ts:1031`,
`ledger_project_checkouts` at `src/db.ts:1016`), while some lighter project-local
tables use CASCADE (e.g. `src/db.ts:1061`). **Spaces are precious authored
state** — they carry the documents, canvas layouts, and organizing structure a
user/agent built by hand. Deleting a project must **not** silently delete its
Spaces. We choose **RESTRICT** on `spaces.project_id`, matching `ledger_issues`:
a project with Spaces cannot be deleted until those Spaces are explicitly removed
first, surfacing the data rather than discarding it. State it explicitly in the
migration comment so a future reader does not assume CASCADE by analogy with
lighter project-local tables.

Note the asymmetry, and that it is intentional: **only the outer `project →
spaces` FK is RESTRICT.** The space-internal cascade — `spaces → space_items /
space_occurrences / space_edges / space_blocks` — stays `ON DELETE CASCADE`
(deleting a Space deliberately tears down its own contents). RESTRICT protects
the Space as a whole from incidental project deletion; CASCADE inside the Space
is the intended cleanup when a user explicitly deletes that Space.

### 3.2 `space_items` — canonical "this thing is referenced in this space"

```sql
CREATE TABLE space_items (
  id            TEXT NOT NULL,
  space_id      TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  ref_type      TEXT NOT NULL
                  CHECK(ref_type IN ('issue','comment','artifact','external_ref')),
  ref_id        TEXT NOT NULL CHECK(ref_id != ''),
  ref_uri       TEXT,
  title         TEXT,            -- cached display title; refreshed on read/sync
  metadata_json TEXT NOT NULL DEFAULT '{}'
                  CHECK(json_valid(metadata_json) AND json_type(metadata_json)='object'),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (id),
  -- Composite-FK target so occurrences/blocks can reference (space_id, item_id)
  -- and SQLite can enforce same-space integrity (review B2):
  UNIQUE (space_id, id),
  -- Canonical membership cannot be duplicated within a space (review B4):
  UNIQUE (space_id, ref_type, ref_id),
  -- external_ref items must carry a display/normalized URI (review B5):
  CHECK (ref_type != 'external_ref' OR ref_uri IS NOT NULL)
);

CREATE INDEX idx_space_items_lookup
  ON space_items(space_id, ref_type, ref_id);
-- "Which spaces contain THIS artifact/ref?" starts from the ref, not space_id (review B8):
CREATE INDEX idx_space_items_by_ref
  ON space_items(ref_type, ref_id, space_id);
```

**Canonical IDs (decided).** `ref_id` is **NOT NULL and non-empty for all
types** (review B5); `external_ref` puts a normalized URI string in `ref_id`, with
`ref_uri` carrying the optional display form.

| `ref_type`     | `ref_id` (always set, non-empty)             | `ref_uri`                                  |
|----------------|----------------------------------------------|--------------------------------------------|
| `issue`        | ledger **primary** id (NOT `short_id`)       | `mandible://<repo>/issue/<id>` (optional)  |
| `comment`      | ledger comment **primary** id                | optional                                   |
| `artifact`     | `artifact:sha256:<hash>`                     | `artifact://...` (optional)                |
| `external_ref` | normalized canonical external URI string     | **required** (display URI; `CHECK` enforced)|

Issues carry both a primary `id` and a display `short_id` (`src/db.ts:1029-1030`).
Membership must use the **primary id**, never the display short id, to stay stable
across short-id collisions/renumbering.

> **No invented external-ref table (review B5, verified).** `ledger_external_refs`
> exists (`src/db.ts:1222-1240`) but is an **adapter-sync** table (git-bug import:
> `entity_type`/`external_id`/`adapter`), not a general external-URI registry. We
> do **not** repurpose it; `external_ref` items store the normalized URI directly
> in `ref_id`. If a first-class external-URI alias mechanism is later wanted, that
> is an Open Question (§14), not an assumption here.

**`UNIQUE(space_id, ref_type, ref_id)` forbids duplicate canonical membership**;
the same thing appearing multiple times visually happens via `space_occurrences`,
never via duplicate `space_items` rows (review B4).

`space_items` is the canonical membership record. **Do not duplicate membership
into `artifact_links`** (`src/db.ts:1592-1605`). "Which spaces contain this
artifact?" is a direct query against `idx_space_items_by_ref`:
`SELECT space_id FROM space_items WHERE ref_type='artifact' AND ref_id = :artifact_id`.

### 3.3 `space_occurrences` — a visual/document APPEARANCE of an item

```sql
CREATE TABLE space_occurrences (
  id            TEXT NOT NULL,
  space_id      TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  item_id       TEXT,
  renderer      TEXT NOT NULL DEFAULT 'canvas'
                  -- 'document' is NOT a valid occurrence renderer: space_blocks is
                  -- the sole document structure (review B6).
                  CHECK(renderer IN ('canvas','board','collection')),
  parent_id     TEXT,
  x             REAL,            -- null => unplaced; renders in the shelf/tray
  y             REAL,
  width         REAL,
  height        REAL,
  z_index       INTEGER,
  sort_key      TEXT,            -- ordering within a list/board column/section
  section_id    TEXT,           -- board column / document section grouping
  note          TEXT,           -- per-occurrence annotation (NOT the document prose)
  metadata_json TEXT NOT NULL DEFAULT '{}'
                  CHECK(json_valid(metadata_json) AND json_type(metadata_json)='object'),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (id),
  -- Composite-FK target so space_edges can reference (space_id, id) (3.4, review B2):
  UNIQUE (space_id, id),
  -- Same-space item membership (review B2):
  FOREIGN KEY (space_id, item_id)
    REFERENCES space_items(space_id, id) ON DELETE CASCADE,
  -- Same-space occurrence tree; cannot nest across spaces (review B2):
  FOREIGN KEY (space_id, parent_id)
    REFERENCES space_occurrences(space_id, id) ON DELETE CASCADE
);

CREATE INDEX idx_space_occurrences_render
  ON space_occurrences(space_id, renderer, sort_key);
-- Partial index for item-resolution joins (review B8):
CREATE INDEX idx_space_occurrences_item
  ON space_occurrences(space_id, item_id) WHERE item_id IS NOT NULL;
-- Tree walk (review B8):
CREATE INDEX idx_space_occurrences_tree
  ON space_occurrences(space_id, parent_id, sort_key);
```

> **Composite self-FK and item-FK (review B2).** The original draft only applied
> the composite-FK fix to `space_edges`. The same cross-space hole exists for an
> occurrence's `item_id` and `parent_id`: a plain `REFERENCES space_items(id)` /
> `space_occurrences(id)` would let an occurrence in Space A reference an item or
> parent in Space B. The composite FKs `(space_id, item_id) → space_items(space_id,
> id)` and `(space_id, parent_id) → space_occurrences(space_id, id)`, backed by the
> inline `UNIQUE(space_id, id)` on both tables, close it. `item_id`/`parent_id`
> remain nullable (unparented / item-less occurrences); the composite FK is only
> enforced when non-NULL.

> **`renderer` excludes `'document'` (review B6).** This resolves the main
> blocks/occurrences drift risk: `space_blocks` is the **sole** document structure.
> `spaces.default_renderer` may still be `'document'` (a space *opens* in the doc
> renderer), but no `space_occurrences` row is a document row. Any document visual
> layout lives on `space_blocks.metadata_json`, never a parallel occurrence row.

**Multiple occurrences of one item are allowed and intended.** The same artifact
can appear in two clusters (once as "evidence", once as "open problem"). **Do not
add a uniqueness constraint** on `(space_id, item_id)` — that was the reviewer's
central warning against the original `space_members` design. (The `UNIQUE(space_id,
id)` above is on the occurrence's own `id`, not on `item_id`.)

**Unplaced occurrences** (`x`/`y` NULL) render in a **shelf/tray**, not at the
origin. Agent-added nodes default to the shelf (see §6).

### 3.4 `space_edges` — authored, freely-labeled canvas/mind-map edges

These are **authored local/rhetorical edges**, **NOT** ledger semantic
relationships (see §4). Free `label`, unlike the 9 fixed `link_type` values in
`ledger_relationship_edges`. Edges connect occurrences within **one** space.

```sql
CREATE TABLE space_edges (
  id            TEXT PRIMARY KEY,
  space_id      TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  source        TEXT NOT NULL,   -- space_occurrences.id within the same space
  target        TEXT NOT NULL,
  label         TEXT,
  style         TEXT,            -- short style hint; rich style in metadata_json
  metadata_json TEXT NOT NULL DEFAULT '{}'
                  CHECK(json_valid(metadata_json) AND json_type(metadata_json)='object'),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  -- Composite FK referential integrity: an edge cannot span two spaces.
  FOREIGN KEY (space_id, source)
    REFERENCES space_occurrences(space_id, id) ON DELETE CASCADE,
  FOREIGN KEY (space_id, target)
    REFERENCES space_occurrences(space_id, id) ON DELETE CASCADE
);

CREATE INDEX idx_space_edges_source ON space_edges(space_id, source);
CREATE INDEX idx_space_edges_target ON space_edges(space_id, target);
```

**The referential-integrity hole this closes.** With a plain
`source REFERENCES space_occurrences(id)`, SQLite would happily let an edge in
Space A point at occurrences in Space B. The composite FK
`(space_id, source) → space_occurrences(space_id, id)` plus the supporting inline
`UNIQUE(space_id, id)` on `space_occurrences` (§3.3) makes a cross-space edge a
constraint violation. (SQLite requires the referenced columns to be the target of
a unique constraint/index for a composite FK; the **inline** `UNIQUE(space_id,
id)` in §3.3 — not an external index — satisfies that and survives backup/restore,
review B3.) The `(space_id, source)` / `(space_id, target)` indexes serve edge
queries in both directions (review B8).

> Edges connect **occurrences**. If a future need arises to edge *items* directly,
> add it as a separate authored relation rather than overloading `space_edges`.

### 3.5 `space_blocks` — first-class document prose/structure

Prose lives **here**, NOT only in `space_occurrences.note`. This is the foundation
of the document renderer (Phase 3) and what gets serialized/exported (Phase 4)
and ingested by HumbleB as a source (Phase 6).

> **A document has two sources (decided; ties to issue 2dc97b8 "Project-canonical
> artifacts and documents").** The document concept unifies (a) **authored-in-
> Mandible** prose (a `space_blocks` tree, managed Mandible custody → an optional
> *explicit* commit, custody doc §2/§3) and (b) an **existing tracked repo file**
> (README, design spec, whitepaper) **registered as a canonical document** with
> **link custody** and a `repo://<repo>@<ref>/<path>` source ref. Both are
> "documents" in the document renderer. For source (b), the canonical bytes live
> in the repo file (link custody, like a registered repo artifact), referenced via
> a `repo://…` source on the document; Mandible does not own or rewrite those bytes
> unless the user explicitly pulls the file into authored Mandible custody. The
> document renderer (§12) must support registering an existing repo file as a
> document; the custody model (custody doc §2) must support a document whose
> `authority` is the repo file from the start.

```sql
CREATE TABLE space_blocks (
  id                 TEXT NOT NULL,
  space_id           TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  parent_id          TEXT,
  block_type         TEXT NOT NULL
                       CHECK(block_type IN ('heading','paragraph','reference',
                             'artifact_embed','issue_embed','comment_embed','todo')),
  item_id            TEXT,
  -- Resolvable placeholder when the embedded item is later deleted (review B7):
  item_snapshot_json TEXT
                       CHECK(item_snapshot_json IS NULL
                             OR (json_valid(item_snapshot_json)
                                 AND json_type(item_snapshot_json)='object')),
  sort_key           TEXT NOT NULL,
  markdown           TEXT,
  metadata_json      TEXT NOT NULL DEFAULT '{}'
                       CHECK(json_valid(metadata_json) AND json_type(metadata_json)='object'),
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  PRIMARY KEY (id),
  UNIQUE (space_id, id),
  -- Assigning an item_id REQUIRES a snapshot, enforced at the DB level so the
  -- embed can always degrade to a resolvable placeholder (review2 / codex Blocker;
  -- convention precedent at src/db.ts:2602-2607):
  CHECK (item_id IS NULL OR item_snapshot_json IS NOT NULL),
  -- Same-space item embed; RESTRICT keeps the embed resolvable (review B7):
  FOREIGN KEY (space_id, item_id)
    REFERENCES space_items(space_id, id) ON DELETE RESTRICT,
  -- Same-space block tree (review B2):
  FOREIGN KEY (space_id, parent_id)
    REFERENCES space_blocks(space_id, id) ON DELETE CASCADE
);

CREATE INDEX idx_space_blocks_tree
  ON space_blocks(space_id, parent_id, sort_key);
-- Partial index for item-resolution joins (review B8):
CREATE INDEX idx_space_blocks_item
  ON space_blocks(space_id, item_id) WHERE item_id IS NOT NULL;
```

`block_type='reference'` / `*_embed` rows link an `item_id`. Pure prose
(`heading`, `paragraph`, `todo`) needs no item.

> **Item deletion: snapshot, not silent null (review B7).** An `ON DELETE SET
> NULL` would leave a block with no ref and no content — a vanished embed. Instead:
> `item_id` is `ON DELETE RESTRICT`, and the **inline
> `CHECK(item_id IS NULL OR item_snapshot_json IS NOT NULL)`** enforces at the DB
> level that assigning an `item_id` requires `item_snapshot_json` (a JSON object
> with the item's ref/title/kind at embed time). This is a Round-4 correction:
> the earlier DDL only validated the snapshot *if present* (nullable check), which
> did not satisfy the stated "item_id implies snapshot" migration test (review2 +
> codex Blocker). Deleting an item then either is blocked while a block references
> it, or — once the caller chooses to detach (the detach/degrade operation owned by
> the blocks-API child) — the embed degrades to a **resolvable placeholder**
> rendered from `item_snapshot_json`, never empty prose. (RESTRICT + required
> snapshot is the recommended combination; do not fall back to bare SET NULL.)

### 3.6 Constraints + indexes summary

**Inline (table-level) constraints — must be in the `CREATE TABLE` DDL** so they
survive backup/restore (review B3):

| Constraint | Table | Purpose |
|---|---|---|
| `UNIQUE (space_id, id)` | `space_items` | composite-FK target for occurrences/blocks |
| `UNIQUE (space_id, ref_type, ref_id)` | `space_items` | no duplicate canonical membership |
| `UNIQUE (space_id, id)` | `space_occurrences` | composite-FK target for edges/self-tree |
| `UNIQUE (space_id, id)` | `space_blocks` | composite-FK target for self-tree |
| composite FKs `(space_id, item_id)` / `(space_id, parent_id)` | occurrences, blocks | same-space integrity |
| composite FKs `(space_id, source)` / `(space_id, target)` | `space_edges` | edge cannot span spaces |
| `UNIQUE (repo_id, branch, path)` | `space_exports` | tracking identity — **inline**, not an external index (lost on restore otherwise; review B3) |
| `CHECK(ref_id != '')`, `CHECK(external_ref ⇒ ref_uri)` | `space_items` | well-formed refs |
| `CHECK(item_id IS NULL OR item_snapshot_json IS NOT NULL)` | `space_blocks` | item embed implies a resolvable snapshot (Round-4) |
| `CHECK(json_valid(x) AND json_type(x)='object')` | all `*_json` columns | object metadata only |

**Performance indexes — separate `CREATE INDEX` (loss on restore is perf-only):**

| Index | Table | Purpose |
|---|---|---|
| `(project_id, updated_at DESC)` | `spaces` | space list, recency |
| `(space_id, ref_type, ref_id)` | `space_items` | membership lookups |
| `(ref_type, ref_id, space_id)` | `space_items` | "which spaces contain this ref?" (starts from ref) |
| `(space_id, renderer, sort_key)` | `space_occurrences` | per-renderer ordering |
| `(space_id, item_id) WHERE item_id IS NOT NULL` | `space_occurrences` | item-resolution joins (partial) |
| `(space_id, parent_id, sort_key)` | `space_occurrences` | occurrence tree walk |
| `(space_id, parent_id, sort_key)` | `space_blocks` | document tree walk |
| `(space_id, item_id) WHERE item_id IS NOT NULL` | `space_blocks` | item-resolution joins (partial) |
| `(space_id, source)`, `(space_id, target)` | `space_edges` | edge queries both directions |
| `(space_id)`, `(repo_id, branch, path)` | `space_exports` | tracking lookups (non-unique perf only) |

### 3.7 Backup inclusion (acceptance criterion on the schema child)

All Spaces tables — `spaces`, `space_items`, `space_occurrences`, `space_edges`,
`space_blocks`, and the later `space_exports` (custody child, §12) — **MUST** be
added to `METADATA_BACKUP_TABLES` in `src/ledger/backup.ts:36-66` (the list that
already includes `artifact_links` and `knowledge_backrefs`). Omitting them would
be a **durability bug**: Spaces are the document/project-organizing surface and
their bytes are canonical, agent-authored state. This is an explicit acceptance
criterion on each schema-bearing child, with a test asserting the tables are
present in the backup list.

> Because the metadata backup emits **only table DDL + INSERTs, not standalone
> index DDL** (verified at `src/ledger/backup.ts:153-184`), the
> backup-classification test does double duty here: it fails if a new table is
> omitted from `METADATA_BACKUP_TABLES`, and the **inline** `UNIQUE`/composite-FK
> constraints (not external indexes) are what guarantee uniqueness survives a
> restore.

### 3.8 Migration strategy (review B10)

- **`spaces_core`** — one sequential migration (the **next contiguous version**
  after 82, assigned at integration) shipping the *core four* together: `spaces`,
  `space_items`, `space_occurrences`, `space_edges`. All four are added to
  `METADATA_BACKUP_TABLES` in the same change.
- **`space_blocks`** ships in a **later** migration tied to the **blocks-schema
  child** — it is largely independent of the canvas/collection core (review
  B1/B10). It uses the **next contiguous version after the core migration**, assigned
  at integration in merge order (not a pre-reserved `v84`). Added to
  `METADATA_BACKUP_TABLES` in that migration.
- **`space_exports`** ships in the **`space_exports` schema child (C13a)** (§2 of the
  custody doc), again using the **next contiguous version at integration** (not a
  pre-reserved `v85`), also added to `METADATA_BACKUP_TABLES`. Its
  `(repo_id, branch, path)` identity is an **inline `UNIQUE`**, not an external
  `CREATE UNIQUE INDEX` (which would be lost on backup/restore — review B3). Its
  **`repo_id` references the backed-up `ledger_project_checkouts.id`**
  (`src/db.ts:1014-1024`), **not** `work_repos.id` (excluded from backup as
  reproducible/runtime state, `src/ledger/backup.ts:70-77`), so the tracking
  identity survives restore (Round-4 fix).
- **Serialization constraint (HARD).** Because `assertMigrationSequence`
  (`src/db.ts:2020`) requires contiguous, non-duplicate versions and main is at
  **v82** (`src/db.ts:2010`), these three migration-bearing children form a
  **strictly serial chain — C1 → C11 → C13a** — each starting only after the prior
  one **merges** and taking the next contiguous version. They **cannot be developed
  or tested in parallel**; no version number is pre-reserved across parallel
  branches.
- **Migration tests** (acceptance criteria): invalid JSON rejected; duplicate
  `space_items` (`UNIQUE(space_id, ref_type, ref_id)`) rejected; cross-space
  item/block/parent/edge refs rejected by the composite FKs; item deletion
  cascades its occurrences; **block** item deletion preserves placeholder data
  (`item_snapshot_json`, RESTRICT path); and the backup-classification test fails
  if any new table is omitted.

Timestamps (`created_at`/`updated_at`) are on **all** new tables (needed for
autosave UX, SSE refresh, backup/debugging, and future export/versioning).

---

## 4. Relationship-semantics bright line

State this explicitly in the schema child and in code comments. These four edge
systems are distinct and must not be silently merged:

| System | Owns |
|---|---|
| `ledger_issue_relationships` / `ledger_relationship_edges` | **operational/semantic** issue relationships (the 9 fixed `link_type` values; endpoints are issues/comments only) |
| `artifact_links` | artifact **custody/context** links |
| `space_items` / `space_occurrences` | **authored** organizing membership + presentation |
| `space_edges` | **authored** local/rhetorical canvas edges (free labels) |

**A `space_edge` becomes a ledger relationship ONLY via an explicit "promote to
ledger relationship" action — never silent mirroring.** Promotion writes a
`ledger_relationship_edges` row (constrained to the 9 types, issue/comment
endpoints) and is a deliberate user/agent action with its own affordance.

**Implementation reality to account for:** the active issue graph projection still
reads the *older* `ledger_issue_relationships` table, not only the newer
`ledger_relationship_edges` (`src/ledger/graph-adapter.ts:375-379`, `754`). Any
"seed Space from current graph selection" feature must read from the same source
the graph actually renders, or its selection will not match what the user sees.

---

## 5. API + CLI + transport + SSE surface

### 5.1 REST routes

```text
GET    /api/spaces?project_id=...
POST   /api/spaces
GET    /api/spaces/:id
PATCH  /api/spaces/:id
DELETE /api/spaces/:id

POST   /api/spaces/:id/items
PATCH  /api/spaces/:id/items/:item_id
DELETE /api/spaces/:id/items/:item_id

POST   /api/spaces/:id/occurrences
POST   /api/spaces/:id/occurrences/batch     -- bulk position writes (drag, re-layout, seed)
PATCH  /api/spaces/:id/occurrences/:occurrence_id
DELETE /api/spaces/:id/occurrences/:occurrence_id

POST   /api/spaces/:id/blocks
PATCH  /api/spaces/:id/blocks/:block_id
DELETE /api/spaces/:id/blocks/:block_id

POST   /api/spaces/:id/edges
PATCH  /api/spaces/:id/edges/:edge_id
DELETE /api/spaces/:id/edges/:edge_id

POST   /api/spaces/:id/seed                  -- seed-from-filter (shared predicate; see §6)
```

The **batch occurrences** endpoint is required for drag persistence and
re-layout/seed: a single write of N positions rather than N round-trips.

### 5.2 `mandible space ...` CLI

Agents need a deterministic CLI to manage spaces ("add this to the project's intro
space and link it to `<node>`"). Candidate subcommands:

| Subcommand | Purpose |
|---|---|
| `mandible space create --project <p> --title <t> [--renderer <r>] [--description <d>]` | create a space |
| `mandible space list [--project <p>] [--json]` | list spaces |
| `mandible space show <space> [--json]` | space + items/occurrences/edges/blocks fact packet |
| `mandible space add-item <space> --ref <ref>` | add an item by canonical ref (`issue:<id>`, `artifact:sha256:<hash>`, `comment:<id>`, `uri:<...>`) |
| `mandible space rm-item <space> --item <id>` | remove an item |
| `mandible space place <space> --item <id> [--occurrence <id>] [--x <n> --y <n>] [--renderer <r>] [--section <s>] [--sort <k>]` | create/update an occurrence (omit x/y → shelf) |
| `mandible space link <space> --source <occ> --target <occ> [--label <l>]` | create a `space_edge` |
| `mandible space unlink <space> --edge <id>` | remove an edge |
| `mandible space promote-edge <space> --edge <id> --type <link_type>` | promote a space_edge to a ledger relationship (explicit, §4) |
| `mandible space seed-from-filter <space> --spec <json|->` | seed membership from a shared filter predicate (§6) |
| `mandible space block add\|edit\|rm <space> ...` | document block CRUD (Phase 3+) |

These commands are **interface-contract additions** and imply updates to the
Mandible Interface Contract and possibly the global `~/.claude/CLAUDE.md` — see
§9 and the reflection child.

### 5.3 File-RPC transport allowlist

Mediated/sandboxed agents reach the daemon through
`src/file-rpc-transport.ts` (`isAllowedFileRpcRoute`, lines ~176-235). It
currently allowlists artifact routes (`/api/artifacts*` at lines 221-226) but
**not** `/api/spaces*` and **not** `/api/knowledge-backrefs`. The backend child
must add `/api/spaces*` routes (GET/POST/PATCH/DELETE + batch) to the allowlist so
sandboxed agents can read/write spaces. Add `/api/knowledge-backrefs` as well
(needed for the HumbleB return channel in Phase 6, and currently missing).

### 5.4 SSE

Broadcast `space:*` events on every mutation, like other tables, via the
`broadcast(type, data)` helper in `src/sse.ts:185-204` (e.g.
`space:created`, `space:item:added`, `space:occurrence:moved`,
`space:edge:created`, `space:block:changed`). The Preact UI subscribes and treats
these as **reconciliation inputs**, not as reasons to reset selection, collapse
panes, or lose zoom/scroll (per the project's Dataful UX state contract). Drag
persistence is optimistic local state + `onNodeDragStop` (or a debounced batch
write to `/occurrences/batch`), with an autosave status indicator and graceful
failure handling. Local-first SQLite/WAL means no collaboration machinery is
needed.

---

## 6. Seeding, filter-sharing, shelf, and "Add to Space"

### 6.1 Shared filter component (hard requirement)

Membership must be **seedable from a filter**, and the filter component must be
**shared with the Timeline's existing row-add filter**. The Timeline filter type
is `TimelineFilterRowSpec` in `ui/src/types/timeline.ts:24-29`:

```ts
type TimelineFilterChip = { field: TimelineFilterField; values: string[]; negated: boolean };
type TimelineFilterRowSpec = {
  id: string;
  title: string;
  chips: TimelineFilterChip[];
  scope: TimelineIssuePredicate;  // <- the predicate is named `scope`, an AST
};
```

`TimelineFilterField` is `'label' | 'kind' | 'referenced-by' | 'subtree'`
(`ui/src/types/timeline.ts:16`); `TimelineIssuePredicate` is a recursive AST with
`and`/`or`/`not`/`label`/`kind`/`referenced_by`/`parent_subtree`/`residual`
(`ui/src/types/timeline.ts:6-14`).

> **Correction to the brief.** The prompt described the shape as "chips
> `{field, values[], negated}` + predicate." The chips match exactly, but the
> predicate field is named `scope` (a `TimelineIssuePredicate` AST), not
> `predicate`. The extraction must preserve this shape so it round-trips with the
> Timeline.

**Action:** extract a shared issue-predicate/filter component (chips + predicate
AST + the chip-editing UI) into a shared module consumable by both the Timeline
row-add UI and the Spaces seed UI. The Spaces `seed` endpoint (§5.1) accepts the
same predicate JSON, evaluates it against the project's issues (and their
artifacts), and creates `space_items` (+ optional shelf occurrences).

### 6.2 Seeds offered

- "Create Space from **this issue + its associated artifacts**."
- "Create Space from **current graph selection/filter**." (Must read from the
  source the graph adapter actually renders — `ledger_issue_relationships`, §4.)
- "Create Space from **all issues with label X**."
- "Create Space from **a saved filter**."

### 6.3 "Add to Space" affordances everywhere

| Surface | File | Action |
|---|---|---|
| Issue detail action menu | `ui/src/components/ledger/IssueDetail.tsx` | "Add to Space" → pick/create space |
| Artifact detail | `ui/src/views/artifacts.tsx` | "Add to Space" from artifact header |
| Graph node detail | `ui/src/views/graph.tsx` | add selected node(s) to the **active** Space; graph does **not** become the editor |

### 6.4 Default positioning heuristic

Non-manually-placed occurrences (e.g. agent-added, seeded) default to the
**shelf** (`x`/`y` NULL). Auto-arrange uses the existing `layoutGraph()`
(`ui/src/graph/layout.ts`) **only** for "initial arrange", "re-layout selected",
and "seed from graph" — **never** on every render after the user has moved nodes.
Persisted positions are the source of truth. (`layoutGraph` is exported at
`ui/src/graph/layout.ts:615`; the graph view calls it and disables dragging via
`nodesDraggable={false}` at `ui/src/views/graph.tsx:1285`.)

---

## 7. Layout-durability decision

| State | Storage | Rationale |
|---|---|---|
| Occurrences (x/y/size/z), items, edges, blocks | **SQLite (canonical, backed up)** | single user; agents place authoritatively; must survive machine change and be in backup |
| Active space, active renderer, sidebar filter UI | localStorage + URL mirror | per-project view intent; follows Timeline pattern (`ui/src/views/timeline.tsx`, localStorage prefix `mandible_timeline_view_state:v1` + URL mirroring) |
| Zoom, scroll, current selection | localStorage/URL (ephemeral) | view-only; never canonical |

This follows the project Dataful-UX-state contract: backend refreshes/SSE are
reconciliation inputs, not reasons to reset user-visible state.

---

## 8. UX / safety specifics

- **Empty-state seeding.** A blank infinite canvas is intimidating. The
  empty-state offers the "Create Space from …" menu (§6.2) plus "blank canvas",
  "blank document", "blank board".
- **One shared resource-ref parser (review A4).** The current linkifier
  `ui/src/artifact-links.ts` only linkifies **bracketed** `[artifact:...]` text
  (the `CUSTOM_URI_PATTERN` at `ui/src/artifact-links.ts:1`) and rewrites existing
  anchors whose `href` is artifact-like (`isArtifactLikeRef`,
  `ui/src/artifact-links.ts:14-22`, `42-63`); it does **not** linkify bare
  `repo://...` / `mandible://...` text. **Verified against the clone.** Replace it
  with **one shared resource-ref parser** used by the **renderer, import, issue
  detail, and the artifacts UI** so all four agree on what a ref is. It must
  support:
  - `artifact:sha256:<64hex>` and compact `artifact:<7-64hex>`,
  - `repo://<repo>@<ref>/<path>`,
  - `mandible://<repo>/issue/<primary-id>`,
  - normal markdown links whose `href` is any of the above.

  **Edited documents prefer markdown links with canonical hrefs**
  (`[label](artifact:sha256:...)`): the **label may change, the href is the
  authority**. The parser also drives an **unresolved-reference UI** (a visible
  placeholder + "resolve/fix" affordance) for refs that do not currently resolve —
  never silently dropped. This shared parser is **foundational for the document
  renderer**; it has its own Children row (§12).

  > **`spaces-doc.v1` directive interplay.** With the canonical document format
  > being **Markdown + non-executable `spaces-doc.v1` directives (NOT full MDX)**
  > (custody doc §1), references / embeds / structure can also be **first-class
  > directive nodes** in the document AST (e.g. `:::figure{artifact="…"}` /
  > `::figure[caption]{…}`), not only markdown links. The shared ref parser must
  > therefore recognize canonical refs whether they arrive as markdown links **or**
  > as directive nodes. Because the document renderer adopts a **remark-directive /
  > micromark renderer** (NOT an MDX compiler/runtime; replacing the bare `marked`
  > path in `ui/src/sanitize.ts` / `ui/src/views/artifacts.tsx`, custody doc §1),
  > the parser and that renderer must agree on the directive grammar.
  >
  > **Linkifier gotcha (explicit requirement).** The current
  > `ui/src/artifact-links.ts` linkifier matches `artifact:<hex>` but NOT
  > `artifact:sha256:<hash>`, and treats many non-HTTP `://` schemes as
  > artifact-like — the new typed document ref parser must handle
  > `artifact:sha256:<hash>`, `repo://`, and `mandible://` correctly and not
  > misroute them.
- **HTML artifact transclusion safety.** Artifact HTML preview currently uses an
  iframe with `sandbox="allow-scripts"` (`ui/src/views/artifacts.tsx`). Do **NOT**
  inline arbitrary script-enabled HTML artifacts into a document surface. For
  in-document embeds, render sanitized HTML (DOMPurify via `ui/src/sanitize.ts`)
  or a static rendition; reserve script-enabled iframes for the standalone
  artifact preview only.

---

## 9. Architectural reflection (Mandible project mandate)

Adding Spaces + an agent `mandible space` CLI + auth-for-documents touches the
worktree/issue/auth conventions, so per the Mandible "Architectural reflection"
mandate this must be reflected against the global conventions:

- **New `mandible space ...` commands** are additions to the **Mandible Interface
  Contract** (the contract currently enumerates `mandible issue/auth/work-unit/...`
  but no `space` surface). The contract version and command list need updating.
- **Document-commit auth flow (decided).** The **default custody of an authored
  document is Mandible custody** — a document stays Mandible-owned until the user
  **explicitly** requests a commit (the export dialog, custody doc §3/§5). There is
  **no silent auto-commit and no "auto-track all documents for a repo" default.**
  When the user *does* commit, the document lands on a dedicated **docs branch**,
  not protected `main`. Routine document commits are **agent-key signed linked
  commits** (`commit-linked` / `agent-commit`) and **never hit the auth queue**;
  the auth queue is invoked **only** when the user explicitly asks to promote the
  docs branch into protected `main`. Promotion goes through a **short-lived
  `promote/docs/<ts>` proxy branch** so auth-merge cleanup does not destroy the
  long-lived docs worktree (see `DOCUMENT-CUSTODY-DESIGN.md` §4.2,
  `cli/auth-merge.sh:410` `cleanup_merged_worktrees`). This interacts with the
  global "Branches, Worktrees, and Signing" and "Mandible Auth Requests" sections.
- **Auth/merge infra change → protected-branch checkout.** The promotion-flow
  child (proxy branch and/or `--preserve-head-branch`) **modifies auth/merge
  infrastructure**, so per the global `~/.claude/CLAUDE.md` rule it must submit its
  own auth request **from the protected-`main` checkout** (so the stored merge
  command exists on the target branch at merge time).
- **Recommendation:** file a **dotfiles-repo** Mandible issue proposing the
  `~/.claude/CLAUDE.md` + Interface-Contract updates (the `mandible space`
  commands and the docs-branch document-commit flow), tracked as an **umbrella
  child** (§12). Do not edit the compiled `~/.claude/CLAUDE.md` directly; it is a
  dotfiles change requiring its own feature worktree + auth.

> **Architectural-reflection note (RESTRICT on `spaces.project_id`).** Because
> deleting a project is now **blocked** while it has Spaces (RESTRICT, §3.1), any
> project-deletion affordance in the dashboard or CLI must surface the blocking
> Spaces and require the user to delete them first — it cannot quietly cascade. No
> global `~/.claude/CLAUDE.md` change is implied (Spaces are local view/authoring
> state, not ledger coordination state), but the UI/CLI delete paths inherit a new
> failure mode to handle gracefully.

---

## 10. Document custody, export, and HumbleB

These are large enough to warrant their own treatment:

- **Document custody / export dialog / custody-until-explicit-commit / auth tiers**
  → [`DOCUMENT-CUSTODY-DESIGN.md`](./DOCUMENT-CUSTODY-DESIGN.md).
- **HumbleB ingestion** is summarized below; the document serialization it consumes
  is designed once in the custody doc.

### 10.1 HumbleB ingestion (v1 SHRUNK) — boundary and contract

**Boundary:** Mandible **authors**; HumbleB **associates/retrieves/extracts**.

**v1 scope (shrunk, decided).** v1 is **only**: a Space document can be
**snapshotted/exported as a SOURCE that HumbleB ingests**, reusing the **existing
Mandible→HumbleB document bridge** (`humbleb-repo/humbleb/sources/mandible.py`,
`humbleb-repo/docs/mandible_document_bridge.md`), so the document's extracted
triples enter RAG queries. **Nothing more.** Concretely: render the document to a
Mandible artifact (or repo-authoritative export), and feed it through the existing
bridge as a source document — the same mechanism that already ingests
`# Mandible Issue …` packets, generalized to accept a Space document. This is
contract **(1)** below and is the whole of the v1 HumbleB story.

**Coordination.** This work is reframed as **"make Space documents ingestable as
HumbleB sources,"** coordinated under the **existing HumbleB umbrella a8fbc09**
(the Spaces `spaces-humbleb` child is a child of, or linked under, a8fbc09 — it is
not a standalone new HumbleB apparatus). It depends on the Spaces document
renderer + serialization (custody doc §1) and the existing bridge; it does **not**
require any new `space_snapshot` packet.

**DEFERRED (explicitly out of v1).** The live, **paragraph-level backref display**
in the document renderer and the `mandible.space_snapshot.v1` apparatus (stable
`space_id`/`block_id`/`item_id` spans for block-level backrefs) are **deferred to a
later, explicitly-deferred item** — not v1. Do not build them as part of the v1
ingest-as-source work.

**Candidate contracts (for context; only (1) is in v1):**

| Option | What | Trade-off | Status |
|---|---|---|---|
| **(1)** Render document as a **Mandible artifact / repo export**, HumbleB ingests it via the existing bridge | Fits `knowledge_backrefs.source_type='artifact'` directly; simplest; reuses the shipped bridge; clean content-addressed boundary | Backrefs land on the whole source snapshot, not on editable blocks | **v1 — the entire v1 HumbleB scope** |
| **(2)** Define `mandible.space_snapshot.v1` export packet + live paragraph-level backref display | Stable `space_id`/`block_id`/`item_id` + rendered source spans; backrefs land on editable blocks | More work; requires extending HumbleB's adapter beyond issue packets | **DEFERRED — later item, NOT v1** |
| **(3)** `source_type='document'` | Requires defining a real Mandible **document identity** (no `documents` table today) | Highest schema cost; revisits whether Spaces or a documents table is the canonical doc | Only if a first-class document entity is independently warranted |

`knowledge_backrefs` (`src/db.ts:1627-1648`, `provider_id` default `'humbleb'`,
`source_type IN ('artifact','document')`, `ref_type IN ('document','entity',
'claim')`) remains the **return channel**; there is **no Mandible `documents`
table** in the schema. Per `DOCUMENT-CUSTODY-DESIGN.md` §7.1: use
`source_type='artifact'` now; `source_type='document'` only once a logical
`mandible://<repo>/space/<space_id>` identity + version metadata exists; and
HumbleB ingests the **repo-authoritative** exported snapshot, never stale Mandible
working state. The deferred item (2) is what would later define
`mandible.space_snapshot.v1` (space/block/item IDs, char offsets, text hash,
source version) **before** implementing block-level backrefs.

**Smell to fix (still relevant for v1).** The HumbleB adapter hard-codes
`mandible_companion_issue = d25bac5` and tests assert that fixture value
(`humbleb-repo/humbleb/sources/mandible.py`, `humbleb-repo/tests/
test_mandible_adapter.py`). Fine as a fixture; it **must not survive** generalized
space/document ingestion. The `spaces-humbleb` child parameterizes this as part of
generalizing the bridge to Space-document sources.

---

## 11. Reconciliation

This section records my original analysis, the GPT‑5.5‑pro review, and the user's
overrides, with conflicts flagged.

### 11.1 What we adopt from the GPT review

- **P1′ over literal P1.** Separate referenced thing (`space_items`) from
  occurrence (`space_occurrences`); add first-class `space_blocks`. (Review §
  "Schema changes I would make".)
- **No uniqueness on occurrences** — same item may appear many times.
- **Composite-FK fix** so an edge cannot span two spaces.
- **Explicit `ON DELETE`** on `spaces.project_id` (the review left this open; we
  choose **RESTRICT**, not CASCADE — Spaces are precious authored state and must
  not be silently deleted with a project; §3.1).
- **All new tables in metadata backup** (durability).
- **Indexes** the review lists.
- **`json_valid` CHECK** on `metadata_json`.
- **Bright line** between the four edge/membership systems; promotion is explicit.
- **Do not evolve `graph.tsx`**; build `SpaceCanvas`. Account for the graph adapter
  still reading `ledger_issue_relationships`.
- **API/CLI/transport/SSE** surface; batch occurrences; optimistic drag + autosave.
- **UX/safety**: stronger ref parser + unresolved-ref UI; HTML transclusion
  caution; "Add to Space" everywhere; empty-state seeding.

### 11.2 Conflicts flagged

- **Phase 0 board (OVERRULED by the user — doubled-up recommendation).** Both the
  original `PROBLEM-AND-OPTIONS.md` (§7 Phase 0) **and** the GPT review (Phase 0
  "Issue Board / saved issue view") recommended a cheap throwaway board to
  validate appetite. **The user rejects validation-probe framing** ("won't know if
  I like it until more feature-complete"). **Resolution:** NO validation-only
  phase. The first milestone is a usable whole (backend + collection list +
  canvas, shipped together — see §13). The **board becomes a real renderer built
  later** (Phase 5), not a probe. Recorded here as a deliberate override of a
  recommendation that both reviewers made.
- **Reviewer's "document-first" and "minimal-first" alternatives (NOTED, not
  chosen).** The review offered "document-first with Markdown artifact as source
  of truth" and a minimal-first path. We do not choose them, for the same reason:
  the user wants enough of the whole to judge it. They remain on record as fallback
  options if Phase 1+2 prove too heavy.
- **"Just remove `nodesDraggable={false}`" (CORRECTED).** The original
  `PROBLEM-AND-OPTIONS.md` (§4.1) implied the canvas is one flag flip on the graph.
  The review correctly notes the graph computes positions every render, remounts on
  structural change, disables dragging, and draws custom edges outside native React
  Flow. We adopt the review's position: **new `SpaceCanvas`, not a mutated graph.**

### 11.3 Where the inputs contradicted the actual code

- The original doc said `artifact-links.ts` rewrites bare `repo://` text; the code
  only handles bracketed `[artifact:...]` and existing anchors. Captured in §8.
- The brief described the shared filter type as "chips + predicate"; the actual
  field is `scope` (a `TimelineIssuePredicate` AST). Captured in §6.1.
- Artifact custody columns live in a **post-migration `ensureSchema`-style helper**
  (v66/v67, `src/db.ts:2602-2661`), not a plain DDL block; `custody_mode IN
  ('link','copy','managed','external')` and `availability IN ('present','missing',
  'stale','unchecked','remote_only','pinned')`. (Detail used in
  `DOCUMENT-CUSTODY-DESIGN.md`.)
- **Codex review B3 verified:** the metadata backup emits only per-table
  `CREATE TABLE` DDL + `INSERT`s and **no standalone `CREATE INDEX` DDL**
  (`src/ledger/backup.ts:153-184`, the `SELECT name, sql FROM sqlite_master WHERE
  type='table'` at line 155 emitted at line 172). So uniqueness/composite-FK
  targets must be **inline `UNIQUE(...)`** in the `CREATE TABLE`, not external
  indexes, or they are lost on restore. Captured in §3 and §3.6.
- **Codex review A5 verified:** `src/artifact-content.ts:473` resolves artifact
  bytes via `git show <commit>:<path>` for a pinned 40–64-hex commit — i.e. the
  bytes at the export commit, not the live working tree. Reusing it for drift would
  always report "clean," so drift detection must read live repo/worktree state.
  Captured in `DOCUMENT-CUSTODY-DESIGN.md` §6.
- **Codex review A1 verified:** `artifacts` carries `UNIQUE(algorithm,
  content_hash)` (`src/db.ts:915`) — content-addressed and immutable, so it cannot
  represent a mutable tracked document; hence the new `space_exports` table
  (`DOCUMENT-CUSTODY-DESIGN.md` §2.1).
- **Codex review B5 verified:** `ledger_external_refs` exists
  (`src/db.ts:1222-1240`) but is an adapter-sync table, **not** a general
  external-URI registry; `external_ref` items store a normalized URI in `ref_id`
  rather than repurposing it.

---

## 12. Proposed umbrella Children decomposition

Issue IDs are **TBD** (the umbrella is not yet filed). One row per child unit,
scoped to independent worktree lanes where possible. Branches are
`feature/<name>` (sub-branches use `__`). The full dispatch-ready decomposition
(corrected owned-surfaces, acceptance criteria, non-goals, dependency DAG, and
the ownership-collision matrix) is in
[`UMBRELLA-DECOMPOSITION.md`](./UMBRELLA-DECOMPOSITION.md); this table is the
canonical Children summary kept consistent with it (**28 children** after the
Round-4 reconciliation: a new foundational shared-contracts/client child; the
backend lane split into API/CLI(+block sub-child)/transport-SSE; SpaceCanvas split
into nodes/edges; the filter lane split into predicate-contract / seed-dialog /
add-to-space; the document lane split into serialization(grammar-only) /
blocks-schema / parser-pipeline / read-only-renderer / block-editor; the custody
lane split into exports-schema / export-backend / drift / export-UI; the nav work
split into an early nav-shell(+render branch) and a late graph-demotion/default-route
flip). **The three migration-bearing children (core schema, `space_blocks`,
`space_exports`) are a strictly serial chain** — each uses the next contiguous
`src/db.ts` version assigned at integration in merge order, starting only after the
prior one merges (`assertMigrationSequence`, `src/db.ts:2020`; main at v82,
`src/db.ts:2010`). No migration version is pre-reserved against a parallel branch.

| issue | scope | branch | state |
|---|---|---|---|
| TBD | **C1 Core P1′ schema + backup (`spaces_core`)**: migration-chain link 1 (next contiguous version after v82) for `spaces`, `space_items`, `space_occurrences`, `space_edges` (DDL per §3 — inline `UNIQUE`s, composite FKs, object `json_valid` CHECKs, `ref_id`/`external_ref` CHECKs, renderer CHECK excluding `'document'`, **RESTRICT** `project_id` FK + space-internal CASCADE); add all four to `METADATA_BACKUP_TABLES`; migration/backup tests. | `feature/spaces-schema` | TBD |
| TBD | **C2 Spaces REST API + events + resolver**: `/api/spaces*` CRUD incl. batch occurrences + backend-evaluated `/seed` (via C7a evaluator) + **unified ref RESOLVER endpoint**; idempotent seed/add; project-scope validation; routes via `registerSpacesRoutes(router)` in `src/routes/spaces.ts` from `src/index.ts` (~28/~106, analog `registerProviderRoutes`); **owns `src/spaces/events.ts` + the event-extension convention**; self-allowlists its routes. *Depends on C1, C3, C7a.* | `feature/spaces-api` | TBD |
| TBD | **C3 Shared contracts + API client + CSS convention**: Spaces types in `src/contracts.ts`; Spaces helpers in `ui/src/api.ts`; `ui/src/views/spaces/types.ts`; per-component `ui/src/views/spaces/*.css` convention (NOT global `ui/src/style.css`). *Depends on C2 (co-designed).* | `feature/spaces-contracts` | TBD |
| TBD | **C4 `mandible space` core CLI** (shell): `cli/space.sh` + `space)` dispatch (`bin/mandible:84,112`); `create/list/show/add-item/rm-item/place/link/unlink/promote-edge/seed-from-filter`; `promote-edge` → existing `POST /api/ledger/relationships`. *Depends on C2.* | `feature/spaces-cli` | TBD |
| TBD | **C4b `mandible space block` CLI sub-child**: `block add\|edit\|rm` → C11 `/blocks*` routes. *Depends on C4, C11.* | `feature/spaces-cli__blocks` | TBD |
| TBD | **C5 Transport SSE + base allowlist convention**: broadcast `space:*` via `src/sse.ts` consuming the C2 enum; allowlist `/api/knowledge-backrefs`; document the per-route allowlist convention (each route-owner self-allowlists; no blanket `/api/spaces*`). *Depends on C2.* | `feature/spaces-transport-sse` | TBD |
| TBD | **C6 Shared resource-ref parser FIX**: `ui/src/artifact-links.ts:3` `/^artifact:([0-9a-f]{7,64})$/i` cannot match `artifact:sha256:<hash>`. Replace with one shared parser (4 ref forms + markdown hrefs); unresolved-ref UI → C2 resolver; regression test; clean grammar-extension point for C12. *Depends on C2 (resolver only); before C7c on shared files.* | `feature/spaces-ref-parser` | TBD |
| TBD | **C7a Shared issue-predicate contract + evaluator extraction**: extract private `evaluatePredicate` (`src/ledger/timeline-projection.ts:890`) into `src/ledger/issue-predicate.ts`; reconcile backend/UI `TimelineIssuePredicate` drift (`src/types.ts:292-300` vs `ui/src/types/timeline.ts:6-14`); Timeline round-trip regression test. *Consumed by C2 `/seed` + C7b.* | `feature/spaces-predicate` | TBD |
| TBD | **C7b Space seed dialog UI**: extract shared UI filter (`TimelineFilterRowSpec`, predicate field `scope`); seed dialog posts to C2 `/seed`; §6.2 seeds; graph-selection seed reads via a backend endpoint (never UI DB read). *Depends on C2, C7a, C3, C10.* | `feature/spaces-seed-dialog` | TBD |
| TBD | **C7c Add-to-Space affordances**: issue/artifact/graph "Add to Space"; **flips `IssueDetail` `hasIssueActions` + adds `onAddToSpace` prop** (`:26-36`,`:68-75`). *Depends on C2, C3, C6 (before, shared files), C10; before C18 on `graph.tsx`.* | `feature/spaces-add-to-space` | TBD |
| TBD | **C8 Collection/list renderer**: renders collection **occurrences** (`parent_id`/`sort_key`/`section_id`, `renderer='collection'`) with item-only membership as an unplaced shelf; previews; missing-ref via C6; project scoping; mounts in shell. *Depends on C2, C3, C6, C10.* | `feature/spaces-collection` | TBD |
| TBD | **C9a SpaceCanvas nodes**: new React Flow canvas — occurrences, shelf, `layoutGraph()` seed only, optimistic drag + autosave, SSE reconcile without zoom/selection reset. *Depends on C2, C3, C10.* | `feature/spaces-canvas__nodes` | TBD |
| TBD | **C9b SpaceCanvas edges**: `space_edges` UI + free labels + promote-to-ledger via existing `POST /api/ledger/relationships` (couples C4 semantics). *Depends on C9a, C2, C3.* | `feature/spaces-canvas__edges` | TBD |
| TBD | **C10 Spaces nav/route shell + render branch**: add `'spaces'` to `Route['tab']` union (`ui/src/routing.ts:2`) + allow-array (`:52`); `Spaces` `primaryNavItems` (`ui/src/app.tsx:990`) + `VIEW_SIDEBAR_TABS` (`:160-168`) + content-class (`:1285`); **create `SpacesViewShell` + the `route.tab==='spaces'` render branch (`~:1375-1391`)**. Does NOT flip default route or demote graph. *Depends on C2, C3.* | `feature/spaces-nav-shell` | TBD |
| TBD | **C11 `space_blocks` schema + blocks API**: migration-chain link 2 (after C1 merges); DDL incl. **`CHECK(item_id IS NULL OR item_snapshot_json IS NOT NULL)`**, composite FKs, inline `UNIQUE(space_id, id)`, backup; `/blocks*` routes (self-allowlisted) + `space:block:changed`; parent-cycle + sort-key + detach/degrade. **`block` CLI not here (C4b).** HARD C12 block-identity edge. *Depends on C1 (chain), C2, C12 (HARD).* | `feature/spaces-blocks-schema` | TBD |
| TBD | **C12 `spaces-doc.v1` grammar + serializer**: grammar/serializer **only** (UI moved to C14b); in-band, NO sidecar, NOT MDX; round-trip `import(export(x))==x`; import-conflict policy (custody §1.3); owns the directive-grammar EXTENSION to C6's parser; publishes the frozen grammar. *Depends on C6; HARD edge → C11; informs C13b, C14a/b.* | `feature/spaces-serialization` | TBD |
| TBD | **C13a `space_exports` schema + repo identity + backup**: migration-chain link 3 (after C11 merges); custody §2.1 DDL with **inline `UNIQUE(repo_id, branch, path)`**; **`repo_id` → `ledger_project_checkouts.id`** (backed up; `src/db.ts:1014-1024`), NOT `work_repos.id` (excluded; `backup.ts:70-77`); add to `METADATA_BACKUP_TABLES`; inline-UNIQUE-survives-restore test. *Depends on C11 (chain).* | `feature/spaces-exports-schema` | TBD |
| TBD | **C13b Export/commit backend + worktree + linked-commit + routes**: `export-and-track` (serialize via C12, write docs-branch worktree, **agent-key linked commit** — owns creating the `commit-linked`/`agent-commit` surface using `mandible_commit_trailers` `cli/ledger-client.sh:317-332`); custody-until-explicit-commit; untracked export-of-copy; docs-branch worktree lifecycle (lock/dirty-rejection/settings); export/register/untracked routes (self-allowlisted) + `space:export:*` events. *Depends on C13a, C12, C14b, C2.* | `feature/spaces-export-backend` | TBD |
| TBD | **C13c Drift / status detection**: live worktree/HEAD/path comparison (NOT artifact materialization, review A5); 4-step → `space_exports.status` (custody §6); record `last_seen_*`. *Depends on C13a, C13b.* | `feature/spaces-drift` | TBD |
| TBD | **C13d Export dialog + repo-file-registration UI**: export dialog (global default + per-repo override + per-export confirm); register existing repo file as document (`authority='repo'`, link custody, `repo://...`, ties 2dc97b8 §3.5); **owns the custody-aware editor-UX rule** (authority='repo' + non-clean drift ⇒ read-only/stale + re-import/fork). *Depends on C13b, C13c, C3, C10.* | `feature/spaces-export-ui` | TBD |
| TBD | **C14a Directive parser/sanitizer pipeline + deps**: `remark-directive`/`unified` parse path → data nodes + DOMPurify; **owns `package.json`/`package-lock.json`** dep addition; security test. (`ui/src/sanitize.ts` stays pure DOMPurify.) *Depends on C12, C6.* | `feature/spaces-doc-pipeline` | TBD |
| TBD | **C14b Read-only document renderer**: read-only render over `space_blocks` + embeds via C14a; replaces `marked.parse` at **`ui/src/views/artifacts.tsx:687`** (the ~13 other `marked` callers out of scope); renders repo-authoritative Markdown/`spaces-doc.v1`. *Depends on C14a, C12, C6, C11, C3, C10.* | `feature/spaces-document-renderer` | TBD |
| TBD | **C14c Block editor**: editor over `space_blocks` via C11; renders through C14b; custody-aware gating per C13d; **embed-on-delete DEFERRED — implementer MUST prompt the user** (§14). *Depends on C14b, C11, C13d, C3, C10.* | `feature/spaces-block-editor` | TBD |
| TBD | **C15 Make Space documents ingestable as HumbleB sources** (v1 SHRUNK, under **a8fbc09**): export Space doc as SOURCE through the existing bridge (`humbleb-repo/humbleb/sources/mandible.py`) — `source_type='artifact'`, repo-authoritative; parameterize `d25bac5` (`:285,:368`). **DEFER live backrefs + `space_snapshot.v1`.** *Depends on C13b, C12, C5 allowlist.* | `feature/spaces-humbleb` | TBD |
| TBD | **C16 Auth-merge / docs-branch promotion** (**modifies auth/merge infra**): `promote/docs/<ts>` proxy branch leaving the long-lived docs worktree intact; `cleanup_merged_worktrees` (`cli/auth-merge.sh:410`) tears down only the proxy; promotion via `cli/space.sh promote-docs`. **The `src/routes/auth.ts` `Mandible-Issue:` gate ALREADY rejects bare commits — C16's auth.ts work is a REGRESSION TEST, not code**; the code change is the `cli/auth-merge.sh` half. **Submits its own auth request from the protected (`main`) checkout.** *Depends on C13b.* | `feature/spaces-docs-promotion` | TBD |
| TBD | **C17 Board/kanban renderer**: columns/swimlanes/WIP via `section_id`/`sort_key`; **default columns = issue `worker_status`; custom columns (filter or manual) PERSIST in `spaces.metadata_json` (NO new table)**. *Depends on C2, C7b, C3, C10.* | `feature/spaces-board` | TBD |
| TBD | **C18 Graph demotion + default-route flip**: demote graph (`src/routes/graph.ts:31-73` perspectives kept); flip ALL default-`graph` fallbacks (`ui/src/routing.ts:14,23,35,37,54`) to Spaces + demote Graph nav (`ui/src/app.tsx:990-1044`) **only after Spaces is useful**. *Depends on C8, C9a, C10, C7c (before, on `graph.tsx`).* | `feature/spaces-graph-demotion` | TBD |
| TBD | **C19 CLAUDE.md / Interface-Contract reflection** (**dotfiles**): propose `mandible space` commands + docs-branch commit flow; owns the dotfiles change. *Depends on C4/C4b, C16.* | `feature/spaces-contract-reflection` (dotfiles) | TBD |

Dependency summary: core schema (C1) → API (C2, owns `src/spaces/events.ts` +
unified resolver) → {contracts C3, core CLI C4, transport-SSE C5, ref-parser-FIX
C6, predicate-extract C7a, seed-dialog C7b, add-to-space C7c, collection C8,
canvas-nodes C9a, nav-shell+render-branch C10, blocks-schema C11}; canvas-edges
C9b depends on C9a; block CLI C4b on C4+C11; C7a's evaluator feeds C2 `/seed` and
C7b; ref-parser C6 → serialization C12 (grammar-only, owns the directive extension
to C6's module) → {blocks-schema C11 (HARD block-identity edge), parser-pipeline
C14a → read-only-renderer C14b → block-editor C14c, export-backend C13b}; custody
splits exports-schema C13a → export-backend C13b → {drift C13c → export-UI C13d →
editor C14c, promotion C16, HumbleB C15}; the nav shell is early (collection/canvas
reachable) and the graph-demotion + default-route flip C18 is late. **The three
migration-bearing children (C1 → C11 → C13a) are a STRICTLY SERIAL chain** — each
takes the next contiguous `src/db.ts` version assigned at integration, starting
only after the prior merges; no version is pre-reserved against a parallel branch.

**Cross-umbrella / cross-issue relationships** (typed links to record on the
umbrella when filed):

| Target | Relationship | Why |
|---|---|---|
| **a8fbc09** (HumbleB umbrella) | `related` | the `spaces-humbleb` ingest-as-source child is coordinated **under** the existing HumbleB umbrella, not a new HumbleB apparatus (§10.1) |
| **de2f8ac** (graph-workspace spec) | `references` (+ `related`) | **Downgraded from `implements`** — Spaces refines and diverges from that graph-workspace direction; `implements` would overstate the fidelity |
| **2dc97b8** (Project-canonical artifacts and documents) | `related` | registering an existing repo file as a canonical document (now owned by the export-UI child C13d) realizes one facet of 2dc97b8 (§3.5); **`related`, not `implements`** — no single child faithfully realizes it |
| **41d22a6**, **dc87eb3** (Timeline) | `related` — **shared filter component, COMPLEMENTARY** | Spaces reuses the Timeline filter component (§6.1) and is complementary to Timeline; **never** "supersedes" (§1) |

> **No sibling `implements` edges.** The only ledger edges this umbrella creates
> are `parent_child` (umbrella → each child) and the cross-issue edges above.
> Inter-child relationships are **DAG dependencies** (build order), recorded in
> `UMBRELLA-DECOMPOSITION.md`, not ledger relationship edges.

---

## 13. Revised phasing (no Phase 0 probe)

| Phase | Content |
|---|---|
| **1** | Space P1′ schema + backend API + CLI + transport allowlist + SSE + backup inclusion; collection/list renderer; "Add to Space" + seed-from-filter (shared Timeline filter). The first usable whole's backbone. |
| **2** | Canvas renderer (`SpaceCanvas`, React Flow editable, persisted positions, shelf, auto-arrange seed, freely-labeled `space_edges`). |
| **3** | Shared resource-ref parser; document renderer (`space_blocks` migration, embedded previews, unresolved-ref UI) + **canonical `spaces-doc.v1` serialization (Markdown + non-executable directives, NOT full MDX), in-band, no mandatory sidecar**; remark-directive / micromark renderer adoption (NOT an MDX compiler/runtime); register-existing-repo-file-as-document. |
| **4** | Document custody / export (`space_exports`): **Mandible custody until explicit commit**, **export dialog** with global/per-repo default paths (**no auto-track**), agent-key linked commits on a **docs branch**; drift via live worktree; the auth-merge **docs-branch promotion flow** (proxy branch). |
| **5** | Board/kanban renderer (default `worker_status` columns + custom filter/manual columns). |
| **6** | Make Space documents ingestable as HumbleB **sources** via the existing bridge (under a8fbc09) + parameterize hard-coded companion issue. *(Live paragraph-level backrefs + `space_snapshot.v1` deferred to a later item.)* |
| **7** (parallel-able) | Graph demotion + Spaces nav + default-route change; CLAUDE.md / Interface-Contract reflection issue (dotfiles). |

**Ship Phase 1 + Phase 2 together as the first thing the user evaluates** — per
the user's "feature-complete before judging" point. Do not ask the user to judge
Spaces on the collection renderer alone. **Spaces ships alongside Timeline as a
complementary surface, not in place of it** (§1).

---

## 14. Open questions

> **Resolved (no longer open):**
> - **Document branch/auth** — documents live on a **docs branch** with agent-key
>   linked commits; the auth queue is invoked only on explicit user-requested
>   promotion to `main` via a short-lived proxy branch (§9, §13,
>   `DOCUMENT-CUSTODY-DESIGN.md` §4).
> - **`spaces.project_id` `ON DELETE`** — **RESTRICT** (Spaces are precious; a
>   project with Spaces cannot be silently deleted; §3.1). Space-internal
>   `spaces → items/occurrences/edges/blocks` stays CASCADE.
> - **Serialization format / sidecar** — canonical format is **Markdown +
>   non-executable `spaces-doc.v1` directives (NOT full MDX)**, fully in-band;
>   the previous HTML-comment-anchor + mandatory sidecar design is **superseded**
>   (custody doc §1). Full MDX was rejected on security grounds (compiles to and
>   executes JavaScript; violates `marked` + DOMPurify + sandboxed-iframe security
>   model). No sidecar is required (at most an optional minimal one, currently
>   believed unnecessary).
> - **Auto-track default** — **removed.** Default custody is **Mandible custody
>   until an explicit user commit** (the export dialog); there is no
>   "auto-track all documents for a repo" feature (custody doc §3/§5).

1. **Embed-on-delete behavior — DEFERRED (implementer must surface to user).**
   What happens to a document **embed/reference block** when the embedded item is
   deleted (block the delete? degrade to a placeholder from `item_snapshot_json`?
   offer both?). **Not decided now.** The document-renderer implementing agent
   **MUST prompt the user for this decision** when it becomes relevant rather than
   choosing unilaterally (§12). (`space_blocks.item_id` is `ON DELETE RESTRICT` +
   `item_snapshot_json` so a resolvable placeholder is always *possible*; the
   chosen behavior is the open part.)
2. **Which specific remark/micromark library.** The format is resolved: Markdown +
   non-executable `spaces-doc.v1` directives rendered via **remark-directive /
   micromark** (NOT a full MDX compiler/runtime; full MDX rejected on security
   grounds). The open part is which concrete remark/micromark library and plugin
   combination replaces the bare `marked` path (`ui/src/sanitize.ts` /
   `ui/src/views/artifacts.tsx`), and the finalized `spaces-doc.v1` directive
   grammar (block identity / ref / embed node forms).
3. **External-ref canonicalization.** What is the canonical `ref_uri`/`ref_id`
   scheme for `external_ref` items, and does it need a first-class alias mechanism?
   (`ledger_external_refs` exists but is adapter-sync-specific, §3.2/§11.3 — not a
   general URI registry.)
4. **Board custom-column persistence model.** Default columns reuse issue
   `worker_status`; custom columns can be **filter-defined** (a shared-filter
   predicate, §6.1) or **manual** (specific issues added by hand). Where/how is a
   custom column set persisted — per-Space metadata, a column-definition record,
   `section_id` values? (Pick a model; `section_id` can hold the column key.)
5. **Exact global/per-repo default document path scheme.** The export dialog
   (custody doc §5) confirms a location from a **global default repo-relative
   path** plus optional **per-repo overrides**; the concrete default path string,
   per-repo override storage, and any collision/rename policy are not finalized.
6. **Occurrence vs. item identity in the document renderer.** Should a document
   embed reference an `item_id` (canonical thing) or its own block? P1′ uses
   `space_blocks.item_id` + `item_snapshot_json`; confirm this granularity (it also
   feeds the deferred block-level HumbleB backrefs, §10.1).
7. **Promote-to-ledger UX.** When a `space_edge` is promoted, what `link_type`
   mapping and confirmation does the user see, given endpoints must be
   issues/comments (artifacts can't be ledger endpoints)?
8. **Seed predicate scope.** The shared filter predicate targets issues; how are
   an issue's **artifacts** pulled in on "issue + its artifacts" seeds — via
   `artifact_links` join at seed time?
