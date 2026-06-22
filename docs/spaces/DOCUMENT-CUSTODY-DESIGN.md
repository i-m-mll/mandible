# Mandible Spaces — Document Custody, Export & Track Lifecycle

> Companion to [`UMBRELLA-PLAN.md`](./UMBRELLA-PLAN.md). This doc designs the
> manuscript serialization, the export-and-track lifecycle, custody transitions,
> auto-track defaults, drift handling, and the auth tiers for document commits.
> Code references verified against `/tmp/mandible-ux-review.EixOws/mandible-repo/`
> and `/tmp/mandible-ux-review.EixOws/humbleb-repo/`.

This is the **foundation** for the Phase 3 document renderer, Phase 4 custody, and
Phase 6 HumbleB bridge: the serialization is designed **once** and consumed by all
three.

---

## 1. Design order: serialization first

The single most load-bearing decision is the **canonical serialization** of a
manuscript (the prose in `space_blocks` plus its references) — a human-editable
**Markdown** file paired with a machine-canonical **sidecar manifest** (not a
single "lossless markdown" file; see §1.1 correction). Everything downstream —
export, repo commits, HumbleB ingestion, drift detection — depends on it. Design
it first.

### 1.1 Requirements

A manuscript Space (`space_blocks` tree + referenced `space_items`) has exactly
two coupled serialized artifacts:

- a **human-canonical Markdown** file (editable in a repo), and
- a **sidecar manifest** (machine-canonical block tree + reference metadata)

such that:

1. **Faithful round-trip via the sidecar, not the prose alone.** `import(export(x)) == x`
   for the block tree (`parent_id` + `sort_key`), `block_type`, `item_id`
   embeds, and the markdown body. The **sidecar manifest is the source of truth**
   for the exact block tree, ordering, and reference metadata; the Markdown is the
   editable human projection. (Pure positional canvas layout is **not** serialized
   into the document — it stays in `space_occurrences`; the manuscript is the
   document projection, not the canvas projection.)
2. **Portable inline reference syntax.** References survive **outside** Mandible
   and round-trip back in. Canonical IDs:
   - Artifacts: `artifact:sha256:<hash>` (matches the repo's existing artifact ID
     form; see `artifact-links.ts` bracketed `[artifact:...]` convention).
   - Issues: `mandible://<repo>/issue/<id>` (matches the HumbleB source identity
     default `mandible://{repo_id}/issue/{issue_id}`,
     `humbleb-repo/humbleb/sources/mandible.py:158`).
   - Repo resources: `repo://<...>` (resolved via `artifact_aliases`).
3. **Stable anchors for backrefs.** Each block carries a stable `block_id` so an
   external system (HumbleB) can attach a backref to a specific block, and so the
   serialization can be re-imported without losing block identity.

> **Correction (Codex review A3): "lossless markdown" was overclaimed.** The
> earlier draft claimed a single Markdown file losslessly round-trips
> (`serialize(deserialize(x)) == x`). It does **not**: an HTML-comment anchor line
> cannot carry `parent_id` and `sort_key` reliably (deep trees, re-ordering), and
> the format has no defined behavior for duplicate, missing, or malformed anchors,
> nor for external formatters (Prettier, `mdformat`, GitHub rendering) that strip
> or reflow HTML comments. The structure-bearing authority therefore moves to a
> **sidecar manifest**; the Markdown carries human-readable anchors that are a
> *hint*, reconciled against the manifest on import.

### 1.2 Recommended serialization shape

**Recommendation: human-canonical Markdown + a deterministic sidecar manifest.**

The Markdown carries a strict-grammar anchor per block; the **sidecar manifest**
at a deterministic path carries the authoritative block tree, order, and
reference metadata.

- **Sidecar manifest path (default):** `.mandible/spaces/<space-id>.json`,
  alongside the exported Markdown. (Finalizing this path/format is an open
  question — see §9.) It serializes the full `space_blocks` tree (`id`,
  `parent_id`, `sort_key`, `block_type`, `item_id`, body hash) and the resolved
  reference set.
- **Anchor grammar (strict).** Each block is preceded by exactly one anchor of the
  form:

  ```
  <!-- mb:block id=<block_id> parent=<parent_id|root> sort=<sort_key> type=<block_type> item=<item_id|-> hash=<body_sha256> -->
  ```

  All keys are required and order-fixed; the importer rejects anchors that do not
  match the grammar.

```markdown
---
mandible_space: <space_id>
mandible_serialization: mandible.manuscript.v1
mandible_manifest: .mandible/spaces/<space_id>.json
mandible_exported_at: <iso8601>
---

<!-- mb:block id=b1 parent=root sort=a0 type=heading item=- hash=… -->
# Results

<!-- mb:block id=b2 parent=root sort=a1 type=paragraph item=- hash=… -->
The oracle run produced [artifact:sha256:abc123] which resolves the question
raised in [mandible://mandible/issue/e70757d].

<!-- mb:block id=b3 parent=root sort=a2 type=todo item=- hash=… -->
> TODO: decide whether the ablation belongs here.
```

**Import-conflict policy (explicit; no silent merges).**

| Situation | Behavior |
|---|---|
| **Duplicate block ID** (same `id` twice) | **conflict** — surfaced for resolution; never silently merged |
| **Missing anchor** (block of text with no `mb:block`) | imported as a **new generated-ID block**, marked `imported`/external-origin |
| **Changed `hash`** (anchor present, body differs) | **external-edit detected** — block content updated from the file, flagged for review |
| **Deleted anchor** (manifest has a block the file dropped) | **delete only after confirm/preview** — never auto-dropped |
| **Unknown reference** (ref not resolvable) | **unresolved placeholder** retained — never dropped |

**Trade-off vs. alternatives:**

- **vs. raw markdown with no anchors:** raw markdown is more human-portable but
  loses block identity, breaking re-import and block-level backrefs.
- **vs. anchors-only "lossless markdown" (the rejected earlier claim):** anchors
  alone cannot carry the full tree/order safely and break under external
  formatters. The manifest restores faithful reconstruction without giving up the
  editable Markdown surface.
- **vs. a JSON/AST file as the *only* canonical form:** a JSON AST round-trips
  perfectly but is not human-editable in a repo, defeating "export to a repo path
  and edit there." We keep Markdown human-canonical and the manifest
  machine-canonical, and treat the HumbleB packet
  (`mandible.space_snapshot.v1`, `UMBRELLA-PLAN.md` §10.1 contract (2)) as a
  separately versioned derived export.
- **mdx** is supported as an output flavor when embeds need component syntax, but
  the default canonical flavor is plain CommonMark + anchors + manifest for
  maximum portability.

The reference parser that reads this back is the **shared resource-ref parser**
called out in `UMBRELLA-PLAN.md` §8 (the current `ui/src/artifact-links.ts` only
linkifies bracketed `[artifact:...]` text and rewrites existing anchors whose
`href` is artifact-like; it does **not** linkify bare `repo://` / `mandible://`
text — it must be replaced by the shared parser for this).

---

## 2. Custody model — immutable snapshots reuse artifacts; mutable tracking needs `space_exports`

Mandible already has an artifact custody model, and the manuscript lifecycle
reuses it **for immutable snapshots only**. The relevant columns on `artifacts`
(set up in the v66/v67 post-migration helper at `src/db.ts:2602-2661`):

| Column | Values | Meaning |
|---|---|---|
| `custody_mode` | `'link' \| 'copy' \| 'managed' \| 'external'` | who owns the bytes |
| `repo_locator_json` | JSON | where the bytes live in a repo (path/commit) |
| `home_repo_id` | repo id | home repo for repo-locator custody |
| `availability` | `'present' \| 'missing' \| 'stale' \| 'unchecked' \| 'remote_only' \| 'pinned'` | freshness/reachability |

> Note: these columns live in a **post-migration `ensureSchema`-style helper**
> (v66/v67), not a plain `CREATE TABLE` DDL block. Any custody work that touches
> these must follow that existing pattern, and new custody-related columns must go
> in **new `MIGRATIONS` entries** (project rule), never ad-hoc.

### 2.0 Why `artifacts` alone cannot track a manuscript (Codex review A1)

The `artifacts` table is **content-addressed and immutable**: it carries
`UNIQUE(algorithm, content_hash)` (`src/db.ts:915`). A row *is* a specific byte
sequence. A **mutable, tracked manuscript** — a file that keeps changing on a
docs branch while Mandible records authority and drift against it — cannot be a
single artifact row, because every edit is a different content hash and would be
a different artifact identity.

So the design splits cleanly:

- **Immutable snapshots** (pre-export history, finished renditions) stay as
  ordinary content-addressed `artifacts` rows.
- **The mutable tracking relationship** (which Space is tracked at which
  repo/branch/path, current authority, current drift status) lives in a new
  first-class **`space_exports`** table.

### 2.1 `space_exports` — the mutable tracking record

```sql
CREATE TABLE space_exports (
  id                            TEXT PRIMARY KEY,
  space_id                      TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  repo_id                       TEXT NOT NULL,
  branch                        TEXT NOT NULL,    -- the docs branch (see §4)
  path                          TEXT NOT NULL,    -- repo-relative export path
  authority                     TEXT NOT NULL DEFAULT 'mandible'
                                  CHECK(authority IN ('mandible','repo')),
  status                        TEXT NOT NULL DEFAULT 'clean'
                                  CHECK(status IN ('clean','stale','repo_changed','worktree_dirty','conflict')),
  last_export_artifact_id       TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
  pre_export_snapshot_artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
  last_export_commit            TEXT,             -- commit the last export landed on
  last_export_blob_sha          TEXT,             -- git blob sha of path at export
  last_export_content_sha256    TEXT,             -- content hash Mandible wrote
  last_seen_commit              TEXT,             -- HEAD commit at last drift check
  last_seen_content_sha256      TEXT,             -- working-tree content hash at last drift check
  created_at                    INTEGER NOT NULL,
  updated_at                    INTEGER NOT NULL
);

CREATE INDEX idx_space_exports_space   ON space_exports(space_id);
CREATE INDEX idx_space_exports_repo    ON space_exports(repo_id, branch, path);
CREATE UNIQUE INDEX idx_space_exports_identity
  ON space_exports(repo_id, branch, path);
```

- `authority` records who currently owns the bytes: `'mandible'` while working,
  `'repo'` after export-and-track (the docs branch wins, §6).
- `status` is the **drift state** (§6), set by comparing recorded vs. live
  repo/worktree hashes, **not** by reusing artifact materialization (§6 explains
  why that would miss drift).
- `last_export_artifact_id` / `pre_export_snapshot_artifact_id` point at the
  immutable `artifacts` rows; `space_exports` itself is the mutable authority/drift
  record.
- **Backup:** `space_exports` **MUST** be added to `METADATA_BACKUP_TABLES`
  (`src/ledger/backup.ts:36-66`) like the other Spaces tables — losing tracking
  state on backup/restore would orphan tracked manuscripts.

This table is part of the **document-custody child** (not the core `spaces_core`
migration); it ships with the export-and-track work that needs it. See
`UMBRELLA-PLAN.md` §12.

### 2.2 Custody states for a manuscript

| State | `space_exports.authority` | `space_exports.status` | Who owns the bytes |
|---|---|---|---|
| **Working (in Mandible)** | `mandible` (or no `space_exports` row yet) | n/a | Mandible owns the bytes (the `space_blocks` rows are the source of truth) |
| **Tracked on docs branch** | `repo` | `clean` / `stale` / `repo_changed` / `worktree_dirty` / `conflict` | the docs-branch git history is source of truth; Mandible holds an immutable pre-export snapshot artifact |

**`recoverability` stays a JSON convention for generic artifacts (Codex review
A6).** The pre-export snapshot artifact may carry `recoverability=repo_commit`
inside its `repo_locator_json` / `reference_json` like any other artifact, but the
**document lifecycle status is the `space_exports.status` column, not a new
`artifacts` column.** Do not add a `recoverability` column to `artifacts` for this
feature.

---

## 3. Export-and-track operation (deterministic)

`export-and-track` is a **deterministic** operation. Given a manuscript Space and
a target docs-branch path:

1. **Serialize** the manuscript to canonical Markdown + sidecar manifest (§1).
2. **Write** both to the managed **docs-branch worktree** (default path governed
   by the auto-track setting, §5).
3. **Commit** with the **agent key** via the **linked-commit path**
   (`commit-linked` / `agent-commit` auto-discovery) — **not** plain
   `git commit`. This is routine agent-key git (the same key used for
   feature/integration commits when `CLAUDECODE=1`), **no YubiKey**. The
   linked-commit requirement is load-bearing for promotion: see §3.2.
4. **Record/refresh the `space_exports` row** (§2.1): set `authority='repo'`,
   `status='clean'`, `last_export_commit`, `last_export_blob_sha`,
   `last_export_content_sha256`, `last_seen_commit`, and the artifact pointers.
5. **Retain an immutable snapshot** of the **pre-export revision history** as a
   content-addressed `artifacts` row (`pre_export_snapshot_artifact_id`), so the
   authoring history is not lost when authority moves to the repo.

**After export, the docs-branch git history is the source of truth.** Mandible
holds the `space_exports` tracking row plus the immutable pre-export snapshot
artifact.

### 3.2 Linked commits are mandatory on the docs branch (Codex review A2)

`cli/auth-merge.sh`'s promotion path verifies that every non-merge commit in
`main..<promote-branch>` carries a `Mandible-Issue:` trailer (the auth-merge
verification surface). A docs branch full of **plain** `git commit` snapshots
would fail that verification at promotion time. Therefore **routine document
commits MUST use the linked-commit path** (`commit-linked --issue <id>` or
`agent-commit` `.issue` auto-discovery), so every docs commit carries a
`Mandible-Issue:` trailer. This is enforced as an acceptance criterion on the
export-and-track op: the commit it produces is a linked commit, never a bare
`git commit`.

### 3.3 Untracked export-of-copy (one-shot, "local file export")

Also support a plain **export-of-copy**: a one-shot rendered-Markdown write to a
path with **no ongoing custody** — no `space_exports` row, no authority/drift
tracking, no recovery snapshot (Codex review A8). This is a **local file
export**: "give me a Markdown copy" without committing Mandible to tracking it.
The manuscript stays Mandible-owned (no `space_exports` row).

- It creates **no** custody, drift, or recovery relationship unless the file is
  **separately** snapshotted/registered as an artifact.
- If the copy is written **inside a repo working tree but left untracked**, show a
  `local_only`-style warning (mirroring the artifact `custody_mode` story): the
  bytes are not a durable, recoverable Git object.

---

## 4. Auth tiers for document commits

### 4.0 Decision: manuscripts live on a docs branch, not protected `main`

**Decided (was an open question).** Manuscripts live on a dedicated, long-lived
**docs branch** (e.g. `docs/<...>`), **NOT** protected `main`. Concretely:

- **Routine document commits are agent-key signed** and **never hit the auth
  queue.** Writing, saving, and exporting a manuscript is ordinary agent-key git
  on the docs branch — no YubiKey in the writing loop.
- **The auth queue is invoked ONLY when the user explicitly asks to promote the
  docs branch into protected `main`.** Promotion is a deliberate, user-initiated
  protected-branch merge through `mandible auth request`.

This replaces the previously open "main vs. docs branch" question. It is mirrored
in `UMBRELLA-PLAN.md` (§9, §13 phasing) and the contract-reflection child, and it
interacts with the global `~/.claude/CLAUDE.md` "Branches, Worktrees, and
Signing" and "Mandible Auth Requests" sections.

### 4.1 The two tiers

| Action | Key | Mechanism |
|---|---|---|
| **Routine doc commits** (save → commit a tracked manuscript on the docs branch) | **agent key** (`id_ed25519_agents`) | direct agent-key **linked** commit (§3.2); **no YubiKey, never the auth queue** |
| **Promote docs branch → protected `main`** (explicit user request only) | **YubiKey (user)** | the existing **auth queue** (`mandible auth request <branch> ...`) |

**Edits accumulate in Mandible working state and commit on an explicit
user-initiated save/export action** — not on every keystroke. This keeps the
YubiKey out of the routine writing loop while preserving the protected-branch
guarantee for anything promoted to `main`.

### 4.2 Promotion must not destroy the long-lived docs branch (Codex review A2)

`cli/auth-merge.sh` runs `cleanup_merged_worktrees` after **every** successful
merge (`cli/auth-merge.sh:630,744,757,807` → `cleanup_merged_worktrees`,
defined at `:410`). It calls the vendored `dwt` on the merged source branch (and
its `__`-delimited children) to tear down the branch's worktree. Submitting the
**long-lived docs branch** itself to the auth queue would therefore get its
worktree cleaned up on a successful merge — destroying the persistent authoring
checkout.

**Fix (primary): promote via a short-lived proxy branch.** On an explicit
promotion request, cut a throwaway `promote/docs/<ts>` branch from the docs-branch
**head** and submit **that** to the auth queue. Cleanup then tears down only the
disposable `promote/docs/<ts>` worktree, leaving the long-lived docs branch +
worktree intact.

**Alternative (recorded): a `--preserve-head-branch` flag** in the auth
metadata / auth-merge CLI that skips `cleanup_merged_worktrees` for branches
flagged as persistent. This is more invasive (auth-merge code change) but avoids
the proxy-branch indirection.

Either path is an **auth-merge / promotion-flow code change**, so it is its own
umbrella child (`UMBRELLA-PLAN.md` §12). Per the global `~/.claude/CLAUDE.md` rule
"If a branch modifies the auth-request or merge infrastructure itself, submit the
request from the protected-branch checkout," that child's own auth request is
submitted from the protected-`main` checkout so the stored merge command exists on
the target branch at merge time.

---

## 5. Auto-track default (per-repo/project setting)

A per-repo/project setting controls automatic tracking. Auto-track is
**opt-in per repo/project** (Codex review A7) — never on by default for a repo
that has not asked for it.

- **`docs_auto_track`** (bool, **default off**): when on, documents associated with
  the repo are auto-tracked at a **configurable docs path** (`docs_path`, e.g.
  `docs/`) on the docs branch (§4).
- When off, manuscripts stay Mandible-owned until an explicit export-and-track or
  export-of-copy.

**Stable path identity (Codex review A7).** The export path is
`<space-id>.md` with the human title carried in the Markdown **frontmatter**, so
renaming a Space never moves its file. If a human-readable slug is used instead,
define explicit **collision and rename behavior** (slug clashes, title edits) —
otherwise prefer the stable `<space-id>.md`.

**Auto-track safety rules (Codex review A7):**

- **Commit only on an explicit save/export action**, never on every keystroke or
  background tick.
- **Block auto-track when the docs worktree has dirty unrelated changes** — do not
  commit on top of unrelated uncommitted work; surface it instead.
- **One managed docs worktree per repo/branch**, with **serialized writes / a
  lock** so concurrent exports cannot race on the same checkout.

Store the setting on the project/repo settings surface (the existing `settings`
table is in the backup list at `src/ledger/backup.ts:38`; project-scoped settings
can hang off `ledger_projects` or a settings row). The path identity must be
deterministic so re-export is idempotent (re-exporting the same Space writes the
same path).

---

## 6. Drift handling (tracked file edited externally)

After export-and-track, the docs-branch file can change outside Mandible (manual
edit, new commit, dirty working tree). Drift detection sets
**`space_exports.status`**, and it must inspect the **docs-branch
worktree/HEAD/path directly** — not by re-materializing an artifact.

> **Why not reuse artifact materialization (Codex review A5).** Artifact content
> resolution pins a commit: `src/artifact-content.ts:473` runs
> `git show <ref>:<relativePath>` for a 40–64-hex `ref`. That returns the **bytes
> at the recorded commit** — i.e. the bytes Mandible *already exported* — so it can
> never observe a later external edit. Reusing it for drift would always report
> "clean." Drift must compare against the **live** repo state.

**Drift check (per `space_exports` row):**

1. Hash `git show <last_export_commit>:<path>` — the bytes we exported.
2. Hash `git show <current docs-branch HEAD>:<path>` — committed-but-newer bytes.
3. Hash the **working-tree** file at `<path>` — uncommitted bytes.
4. Inspect dirty/staged status of `<path>` (`git status` / `git diff`).

Then set `status`:

| Observation | `space_exports.status` |
|---|---|
| HEAD path hash == last-export hash, working tree clean | `clean` |
| HEAD path hash differs from last-export hash | `repo_changed` |
| working-tree path hash differs from HEAD (dirty/staged) | `worktree_dirty` |
| our content hash and the repo's both moved divergently | `conflict` |
| Mandible-side edits pending against a tracked export | `stale` |

Record `last_seen_commit` / `last_seen_content_sha256` on each check.

- **Post-export authority: the docs branch wins** (`authority='repo'`). Mandible
  holds the `space_exports` tracking row + the immutable pre-export snapshot, not
  the authoritative bytes. A non-`clean` status prompts the user to either
  re-import the repo's version into Mandible working state or re-export Mandible's
  version over the file (explicit, user-initiated — never silent).
- The pre-export immutable snapshot (§3 step 5) remains available for diff/recovery
  regardless of drift.

---

## 7. HumbleB tie-in (serialization is shared)

The canonical serialization (§1) is **also** what HumbleB ingests. The HumbleB
side already defines a document-provenance contract `humbleb.document_provenance.v1`
with `DocumentRecord` / `DocumentVersion` / `DocumentChunk` / `SourceSpan` /
`ClaimSourceLink` (`humbleb-repo/docs/mandible_document_bridge.md:11-29`), keyed on
a stable logical identity like `mandible://<repo>/issue/<id>`.

Two ingestion paths (from `UMBRELLA-PLAN.md` §10.1):

1. **Finished snapshot → Mandible artifact → HumbleB ingests the artifact.** Fits
   `knowledge_backrefs.source_type='artifact'` (`src/db.ts:1629`). The exported
   manuscript markdown, registered as an artifact, becomes a `DocumentVersion`
   with deterministic chunks/spans. **Recommended for finished snapshots.**
2. **Live-while-writing → `mandible.space_snapshot.v1` packet** carrying stable
   `space_id` / `block_id` / `item_id` + rendered source spans, so HumbleB
   `SourceSpan`/`ClaimSourceLink` backrefs land on **editable blocks**. The block
   anchors from §1.2 supply the stable span identity. **Recommended for
   live-while-writing backrefs.**

### 7.1 HumbleB identity contract (Codex review A9)

- **Use `source_type='artifact'` now.** Finished snapshots ingest as artifacts;
  this is the path that works against the schema today
  (`source_type IN ('artifact','document')`, `src/db.ts:1627-1648`). There is
  **no Mandible `documents` table**.
- **Allow `source_type='document'` only once a logical document identity
  exists.** That means a stable `mandible://<repo>/space/<space_id>` identity plus
  version metadata. Do not adopt `'document'` before that identity is defined.
- **Define `mandible.space_snapshot.v1` before implementing live-writing
  backrefs.** Its keys are `space_id`, `block_id`, `item_id`, character offsets,
  text hash, and source version — this is the span identity HumbleB
  `SourceSpan`/`ClaimSourceLink` rows attach to. Path (2) is blocked on this
  packet being specified.
- **Parameterize the hard-coded companion issue.** The adapter hard-codes
  `mandible_companion_issue = "d25bac5"` (`humbleb-repo/humbleb/sources/
  mandible.py:285`, also `:368`) and tests assert it
  (`humbleb-repo/tests/test_mandible_adapter.py`). Fine as a fixture; it **must be
  parameterized** before generalized space/manuscript integration.
- **HumbleB ingests the repo-authoritative snapshot, not stale Mandible working
  state.** After export, authority is `'repo'` (§6); the bytes HumbleB ingests are
  the exported/committed docs-branch rendition, never an unexported in-progress
  Mandible buffer.

The HumbleB return channel is `knowledge_backrefs` (`provider_id='humbleb'`,
`source_type IN ('artifact','document')`, `src/db.ts:1627-1648`). Option (1)
avoids needing a `documents` table; option (2) uses space/block IDs as the
document identity without a new table.

---

## 8. Best-practice assessment

The user's design is, on balance, **best-practice**. Specific assessments:

| Decision | Assessment |
|---|---|
| Prose starts in Mandible custody (Mandible-owned) | **Sound.** Local-first authoring with a clean later handoff to repo custody. |
| Canonical serialization designed first | **Sound and the right priority.** Everything downstream depends on it. **Refined** from "lossless markdown" to Markdown + sidecar manifest after Codex review A3 (anchors alone are not lossless). |
| Portable inline reference syntax with canonical IDs | **Sound.** Survival outside Mandible + round-trip is the correct portability bar. Block identity now rests on the **sidecar manifest** with anchors as a reconciliation hint, not on anchors alone. |
| Mutable tracking via a first-class `space_exports` table | **Strong.** The content-addressed `artifacts` table (`UNIQUE(algorithm, content_hash)`) cannot model a mutable tracked manuscript; `space_exports` carries authority/drift while artifacts hold immutable snapshots (Codex review A1). |
| Agent-key linked commits on a docs branch; auth queue only on explicit promotion | **Sound and consistent** with the existing two-key model. Linked commits are mandatory so promotion verification passes (§3.2). |
| Auto-track (opt-in) + untracked export-of-copy as separate paths | **Sound.** Two genuinely different intents (durable tracking vs. one-shot local file export) deserve distinct operations. |
| Drift sets `space_exports.status` by inspecting the live worktree, repo wins post-export | **Sound.** Drift must read live repo/worktree state, not pinned artifact materialization (Codex review A5). Keeping a pre-export immutable snapshot is the right safety net. |
| Serialization shared with HumbleB | **Sound.** Designing the serialization once for both export and ingestion avoids divergence; `source_type='artifact'` now, `'document'` only once a logical identity exists (§7.1). |

**Caveats / refinements:**

- **`recoverability` stays a JSON convention (resolved, Codex review A6).** It is
  encoded in the snapshot artifact's `repo_locator_json` / `reference_json`; the
  document lifecycle status is `space_exports.status`, not a new `artifacts`
  column.
- **Idempotent re-export depends on a deterministic path identity** (§5). Default
  `<space-id>.md` is collision-free; slug-based paths need an explicit policy.
- **Pre-export snapshot storage.** Decide where the immutable pre-export history
  lives: `space_blocks` body-revisions (if blocks have revision history like
  `ledger_body_revisions`) vs. a snapshot artifact in custody. A snapshot artifact
  is simpler and reuses content-addressing (and is the `pre_export_snapshot_artifact_id`
  target in `space_exports`).
- **Anchor + manifest leakage.** The `<!-- mb:block … -->` anchors are invisible
  in rendered markdown but visible in raw source, and the sidecar manifest is a
  committed file; confirm both are acceptable in repo-committed manuscripts (the
  anchors are standard; the manifest path is an open question, §9).

---

## 9. Open questions

> **Resolved (no longer open):** manuscript branch placement — manuscripts live on
> a **docs branch** with agent-key linked commits; the auth queue is invoked only
> on explicit user-requested promotion to `main` (§4.0). Drift status now lives on
> `space_exports.status`, not a new `artifacts` column (§2.2), so the former
> "`recoverability` column vs. JSON" question is settled: `recoverability` stays a
> generic-artifact JSON convention.

1. **Sidecar manifest path/format finalization.** Default is
   `.mandible/spaces/<space-id>.json` (§1.2), but the exact on-disk schema, whether
   it lives beside the `.md` or in a `.mandible/` tree, and how it is committed
   relative to the Markdown are not finalized.
2. **Does `space_snapshot.v1` ship in v1?** The HumbleB live-while-writing packet
   (`mandible.space_snapshot.v1`, §7.1) is required only for path (2)
   block-level backrefs. Whether it is in the first manuscript release or deferred
   to the HumbleB phase is open.
3. Pre-export snapshot storage: block body-revisions vs. snapshot artifact? — §8
   (leaning snapshot artifact, reuses content-addressing).
4. **Stable path identity if slugs are used.** Default is `<space-id>.md` with the
   title in frontmatter (§5); if a human-readable slug is preferred, the
   collision/rename policy is open.
5. Does the canonical serialization need an `external_ref` alias mechanism so
   external references resolve deterministically on re-import? Note
   `ledger_external_refs` (`src/db.ts:1222`) exists but is an **adapter-sync**
   table (git-bug import), not a general external-URI registry — do not repurpose
   it without verifying fit. — cross-ref `UMBRELLA-PLAN.md` §14.
6. For HumbleB contract (2), the canonical `space_snapshot.v1` schema and whether
   it versions independently of `mandible.manuscript.v1` (the text serialization).
