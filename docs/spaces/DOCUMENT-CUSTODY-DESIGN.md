# Mandible Spaces — Document Custody, Export & Track Lifecycle

> Companion to [`UMBRELLA-PLAN.md`](./UMBRELLA-PLAN.md). This doc designs the
> document serialization (canonical format: **Markdown + a small non-executable
> directive grammar (`spaces-doc.v1`)**), the export lifecycle and **export
> dialog**, custody transitions (**Mandible custody until an explicit user
> commit**), drift handling, and the auth tiers for document commits.
> Code references verified against `/tmp/mandible-ux-review.EixOws/mandible-repo/`
> and `/tmp/mandible-ux-review.EixOws/humbleb-repo/`.

> **Terminology (settled).** The artifact is a **document** (not "manuscript"),
> the renderer is the **document renderer**, and a **document** is either
> authored-in-Mandible prose **or** an existing tracked repo file registered as a
> canonical document (`UMBRELLA-PLAN.md` §3.5, issue 2dc97b8).

This is the **foundation** for the Phase 3 document renderer, Phase 4 custody, and
the Phase 6 HumbleB ingest-as-source work: the serialization is designed **once**
and consumed by all three.

---

## 1. Design order: serialization first

The single most load-bearing decision is the **canonical serialization** of a
document (the prose in `space_blocks` plus its references). **Decided: the
canonical format is Markdown + a small non-executable directive grammar
(`spaces-doc.v1`) — NOT full/executable MDX.** Everything downstream — export,
repo commits, HumbleB ingestion, drift detection — depends on it. Design it first.

> **Security rationale for rejecting full MDX.** Full MDX compiles directives to
> JavaScript and executes them inside the renderer. That would move executable
> content into Mandible's trusted UI tree, violating the app's security model
> (`marked` + DOMPurify + sanitized HTML, with HTML artifacts isolated in a
> sandboxed iframe). A recent `next-mdx-remote` RCE CVE is the cited failure
> mode. The `spaces-doc.v1` directives are rendered as **DATA nodes through fixed
> Mandible Preact components** — no code execution.

> **This supersedes the previous HTML-comment-anchor + mandatory-sidecar design
> (Codex review A3).** That earlier design moved block identity, ordering, and
> reference metadata into a separate machine-canonical **sidecar manifest** because
> HTML-comment anchors in plain markdown could not carry `parent_id`/`sort_key`
> reliably and were stripped/reflowed by external formatters. **The non-executable
> directive grammar resolves the root cause:** with `remark-directive` / CommonMark
> generic directive syntax, **block identity, references, embeds, and structure are
> first-class AST / directive nodes living IN the document text** — not strippable
> HTML comments. The document text is therefore itself the **single lossless source
> of truth**, and **no separate sidecar is required.** (See §1.3 for what survives
> of A3 and what is overridden.)

### 1.1 Requirements

A document Space (`space_blocks` tree + referenced `space_items`) serializes to a
**single canonical `spaces-doc.v1` file** (CommonMark/GFM prose + YAML
frontmatter + a whitelisted non-executable directive profile) such that:

1. **Faithful round-trip from the text alone.** `import(export(x)) == x` for the
   block tree (`parent_id` + `sort_key`), `block_type`, `item_id` embeds, and the
   prose body — all carried as `spaces-doc.v1` directive attributes / AST structure
   in the file itself. There is **no second authority** to reconcile against: the
   parsed AST *is* the block tree. (Pure positional canvas layout is **not**
   serialized into the document — it stays in `space_occurrences`; the document is
   the document projection, not the canvas projection.)
2. **First-class inline reference / embed syntax via non-executable directives.**
   References and embeds are directive nodes in the whitelisted profile (e.g.
   `:::figure{artifact="…"}` or `::figure[caption]{…}`), not comments. Each
   directive contains **normal-markdown fallback content** (image/link/caption) so
   the file degrades to something readable on GitHub/pandoc without a
   `spaces-doc.v1` renderer. Canonical IDs (carried in directive attributes or
   markdown-link hrefs):
   - Artifacts: `artifact:sha256:<hash>` (matches the repo's existing artifact ID
     form; see `artifact-links.ts` bracketed `[artifact:...]` convention).
   - Issues: `mandible://<repo>/issue/<id>` (matches the HumbleB source identity
     default `mandible://{repo_id}/issue/{issue_id}`,
     `humbleb-repo/humbleb/sources/mandible.py:158`).
   - Repo resources: `repo://<repo>@<ref>/<path>` (resolved via `artifact_aliases`).
3. **Stable in-band block identity for backrefs.** Each block carries a stable
   `block_id` **as a directive attribute** so an external system (HumbleB, later /
   deferred) can attach a backref to a specific block, and so the file re-imports
   without losing block identity. No sidecar is needed to hold this.

### 1.2 Canonical serialization shape (`spaces-doc.v1`, in-band)

The format is:
- **CommonMark/GFM prose** as the base layer.
- **YAML frontmatter** for document-level fields, with a `mandible_format:
  spaces-doc.v1` marker identifying the format version.
- A **whitelisted inline directive profile** (remark-directive / CommonMark
  generic directives, e.g. `:::figure{artifact="…"}` or `::figure[caption]{…}`)
  for structured embeds. Each directive contains **normal-markdown fallback
  content** (image/link/caption) so the file degrades gracefully on
  GitHub/pandoc.
- **Canonical-URI links** for every Mandible reference:
  `mandible://<repo>/issue/<id>`, `repo://<repo>@<ref>/<path>`,
  `artifact:sha256:<hash>`.

Block-bearing structure carries its identity and tree position as directive
attributes (e.g. a container/leaf directive with `id` / `parent` / `sort` /
`type` / `item`); references and embeds are directive nodes (or markdown links
with canonical hrefs). Illustrative (the exact directive grammar is an open
question — see §9 and `UMBRELLA-PLAN.md` §14 Q2):

```markdown
---
mandible_format: spaces-doc.v1
mandible_space: <space_id>
mandible_serialization: mandible.document.v1
mandible_exported_at: <iso8601>
---

:::block{id=b1 parent=root sort=a0 type=heading}
# Results
:::

:::block{id=b2 parent=root sort=a1 type=paragraph}
The oracle run produced :ref[abc123]{href="artifact:sha256:abc123"} which
resolves the question raised in :ref[e70757d]{href="mandible://mandible/issue/e70757d"}.
:::

:::block{id=b3 parent=root sort=a2 type=todo}
> TODO: decide whether the ablation belongs here.
:::
```

Because identity and structure are directive nodes in the AST, a remark-directive
/ micromark parser reconstructs the block tree directly; there is no
anchor/manifest reconciliation step.

**Renderer/implementation note.** The UI adopts a **remark-directive /
micromark parse path** feeding sanitized HTML + fixed Preact components, **NOT**
an MDX compiler/runtime. This is lower cost than full MDX and eliminates the
JavaScript execution surface. The `marked` path in `ui/src/sanitize.ts` /
`ui/src/views/artifacts.tsx` is replaced by this remark-directive renderer. The
specific remark/micromark library is TBD (see §9 Q2).

**Portability trade-off (state it honestly).** `spaces-doc.v1` directives render
correctly in a `spaces-doc.v1`-aware renderer. In GitHub, pandoc, and bare
CommonMark renderers, the directive containers appear as raw text — but the
mandatory **markdown fallback content inside each directive** (image/link/caption)
ensures the file remains readable and navigable even without a `spaces-doc.v1`
renderer. This is meaningfully better portability than full MDX (which would show
raw JSX).

**In-band / no sidecar (kept).** Directives are in-band, so the single tracked
file remains the source of truth; no canonical sidecar. Out-of-band data (parsed
ref index, render cache, HumbleB ingestion snapshots) is only derived/cache state
— rebuildable from the tracked file. Keep at most an **optional** minimal sidecar,
and **only** if some metadatum genuinely cannot be expressed in-band. We currently
**believe none is needed.**

### 1.3 What survives of Codex review A3, and what is overridden

A3 is **PARTIALLY OVERRIDDEN** (format: Markdown + non-executable `spaces-doc.v1` directives; full MDX rejected on security grounds):

- **Overridden:** the **mandatory sidecar manifest** as the structure authority,
  the HTML-comment `<!-- mb:block … -->` anchor grammar, and the framing that "a
  single editable file cannot losslessly round-trip." Non-executable `spaces-doc.v1`
  directives make the single file lossless, so the round-trip fragility that
  motivated the sidecar is **resolved in-band**. Full MDX was also rejected on
  security grounds: it compiles to and executes JavaScript, violating Mandible's
  `marked` + DOMPurify + sandboxed-iframe security model.
- **Still relevant (kept):** the **import-conflict policy** for externally-edited
  files. Even with `spaces-doc.v1` directives, a repo file can be hand-edited,
  reformatted, or partially corrupted between exports, so re-import must still
  define explicit, no-silent-merge behavior:

| Situation | Behavior |
|---|---|
| **Duplicate block `id`** (same `id` twice) | **conflict** — surfaced for resolution; never silently merged |
| **Block node with no `id`** (new prose added externally) | imported as a **new generated-ID block**, marked `imported`/external-origin |
| **Body changed under a known `id`** | **external-edit detected** — block content updated from the file, flagged for review |
| **Known `id` dropped from the file** | **delete only after confirm/preview** — never auto-dropped |
| **Unknown / unresolvable reference** | **unresolved placeholder** retained — never dropped |

The reference parser that reads this back is the **shared resource-ref parser**
(`UMBRELLA-PLAN.md` §8), extended to recognize `spaces-doc.v1` directive ref/embed
nodes (the current `ui/src/artifact-links.ts` only linkifies bracketed
`[artifact:...]` text and existing artifact-like anchor hrefs, not bare
`repo://`/`mandible://` text or directives — it must be replaced by the shared
parser). The parser must handle `artifact:sha256:<hash>`, `repo://`, and
`mandible://` correctly and not misroute them (the current linkifier treats many
non-HTTP `://` schemes as artifact-like — the typed ref parser must be precise).

### 1.4 Existing repo files as documents (link custody)

A document is not only authored-in-Mandible prose. An **existing tracked repo
file** (README, design spec, whitepaper) can be **registered as a canonical
document** with **link custody** and a `repo://<repo>@<ref>/<path>` source ref
(`UMBRELLA-PLAN.md` §3.5, issue 2dc97b8). For such a document:

- the **canonical bytes are the repo file**; Mandible does not own or rewrite them
  (link custody, like a registered repo artifact);
- it starts with `space_exports.authority='repo'` (§2.2) — there was never a
  Mandible-custody phase to commit out of;
- if the file is already `spaces-doc.v1` or plain Markdown it renders directly;
  if it is some other document format, the renderer treats it as a referenced
  source, not an editable `space_blocks` tree, unless/until the user explicitly
  pulls it into authored Mandible custody.

---

## 2. Custody model — immutable snapshots reuse artifacts; mutable tracking needs `space_exports`

Mandible already has an artifact custody model, and the document lifecycle
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

### 2.0 Why `artifacts` alone cannot track a document (Codex review A1)

The `artifacts` table is **content-addressed and immutable**: it carries
`UNIQUE(algorithm, content_hash)` (`src/db.ts:915`). A row *is* a specific byte
sequence. A **mutable, tracked document** — a file that keeps changing on a
docs branch while Mandible records authority and drift against it — cannot be a
single artifact row, because every edit is a different content hash and would be
a different artifact identity.

So the design splits cleanly:

- **Immutable snapshots** (pre-export history, finished renditions) stay as
  ordinary content-addressed `artifacts` rows.
- **The mutable tracking relationship** (which Space document is tracked at which
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
  state on backup/restore would orphan tracked documents.

This table is part of the **document-custody child** (not the core `spaces_core`
migration); it ships with the export-and-track work that needs it. See
`UMBRELLA-PLAN.md` §12.

### 2.2 Custody states for a document

**Default custody is Mandible custody.** A newly authored document has **no
`space_exports` row at all** — it is Mandible-owned, and it stays that way until
the user **explicitly** requests a commit via the export dialog (§3, §5). There is
**no auto-track and no silent auto-commit.** A document that originates as an
existing repo file (§1.4) is the exception: it starts at `authority='repo'`.

| State | `space_exports.authority` | `space_exports.status` | Who owns the bytes |
|---|---|---|---|
| **Working (in Mandible)** — the default | no `space_exports` row yet (Mandible custody) | n/a | Mandible owns the bytes (the `space_blocks` rows are the source of truth) |
| **Tracked on docs branch** (after an explicit user commit) | `repo` | `clean` / `stale` / `repo_changed` / `worktree_dirty` / `conflict` | the docs-branch git history is source of truth; Mandible holds an immutable pre-export snapshot artifact |
| **Registered existing repo file** (§1.4) | `repo` | drift states as above | the repo file is source of truth from the start (link custody); no Mandible-custody phase preceded it |

**`recoverability` stays a JSON convention for generic artifacts (Codex review
A6).** The pre-export snapshot artifact may carry `recoverability=repo_commit`
inside its `repo_locator_json` / `reference_json` like any other artifact, but the
**document lifecycle status is the `space_exports.status` column, not a new
`artifacts` column.** Do not add a `recoverability` column to `artifacts` for this
feature.

> The `space_exports.path` is the **repo-relative export path chosen in the export
> dialog** (§5): a global default, optionally overridden per repo, and confirmable
> per-export. It is no longer a slug-only / `<space-id>.md` identity scheme.

---

## 3. Export-and-track operation (deterministic, always explicit)

**Committing a document to a repo is always an explicit user action.** It is
triggered by the user through the **export dialog** (§5) — never automatically,
never on a background tick. Given the dialog's confirmed/overridden target path:

`export-and-track` is then a **deterministic** operation. Given a document Space
and the chosen docs-branch path:

1. **Serialize** the document to canonical **`spaces-doc.v1`** format (§1) — a
   single in-band Markdown + non-executable directive file, no separate sidecar.
2. **Write** it to the managed **docs-branch worktree** at the path the user
   confirmed in the export dialog (§5).
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
artifact. **Before** the user takes this explicit action, the document remains in
Mandible custody (§2.2) — no repo file, no `space_exports` row.

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

Also support a plain **export-of-copy**: a one-shot rendered `spaces-doc.v1`
write to a path with **no ongoing custody** — no `space_exports` row, no
authority/drift tracking, no recovery snapshot (Codex review A8). This is a
**local file export**: "give me a copy" without committing Mandible to tracking
it.
The document stays Mandible-owned (no `space_exports` row).

- It creates **no** custody, drift, or recovery relationship unless the file is
  **separately** snapshotted/registered as an artifact.
- If the copy is written **inside a repo working tree but left untracked**, show a
  `local_only`-style warning (mirroring the artifact `custody_mode` story): the
  bytes are not a durable, recoverable Git object.

---

## 4. Auth tiers for document commits

### 4.0 Decision: documents live on a docs branch, not protected `main`

**Decided (was an open question).** When a document **is** committed (an explicit
user action, §3), it lands on a dedicated, long-lived **docs branch** (e.g.
`docs/<...>`), **NOT** protected `main`. Concretely:

- **Routine document commits are agent-key signed** and **never hit the auth
  queue.** Saving and exporting a committed document is ordinary agent-key git
  on the docs branch — no YubiKey in the writing loop.
- **The auth queue is invoked ONLY when the user explicitly asks to promote the
  docs branch into protected `main`.** Promotion is a deliberate, user-initiated
  protected-branch merge through `mandible auth request`.

Note this is **downstream of the custody default**: a document is Mandible-owned
until the user explicitly commits it (§2.2, §3); the docs branch is where commits
land *once that explicit action happens*, not a place documents are written to
automatically.

This replaces the previously open "main vs. docs branch" question. It is mirrored
in `UMBRELLA-PLAN.md` (§9, §13 phasing) and the contract-reflection child, and it
interacts with the global `~/.claude/CLAUDE.md` "Branches, Worktrees, and
Signing" and "Mandible Auth Requests" sections.

### 4.1 The two tiers

| Action | Key | Mechanism |
|---|---|---|
| **Routine doc commits** (save → commit a tracked document on the docs branch) | **agent key** (`id_ed25519_agents`) | direct agent-key **linked** commit (§3.2); **no YubiKey, never the auth queue** |
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

## 5. Export location and the export dialog (no auto-track)

**Decided: there is no auto-track feature.** The earlier "auto-track all documents
for a repo by default" idea is **removed and superseded.** Default custody is
**Mandible custody until the user explicitly requests a commit** (§2.2, §3), and
**committing to a repo is always an explicit user action.** There is no
`docs_auto_track` setting, no silent auto-commit, and no background tracking of
documents a user has not chosen to commit.

### 5.1 Document location on export

When the user does choose to commit/export, the **target location** is resolved
from three layers:

1. **Global default repo-relative path.** A single global default (e.g. a
   `docs/` location) used when nothing more specific is set.
2. **Per-repo overrides.** If the user has set a per-repo export path for a repo,
   it overrides the global default for that repo.
3. **The export dialog.** On every commit/export, an **export dialog** opens
   letting the user **confirm the resolved default or pick a different
   location**. The chosen path is what `export-and-track` writes to and what
   `space_exports.path` records (§2.1, §3).

This **replaces any slug-only / `<space-id>.md` path-identity scheme.** Path is a
user-chosen, user-confirmable export location, not a derived slug. (The concrete
default path string, per-repo override storage, and any collision/rename policy
are not finalized — §9 and `UMBRELLA-PLAN.md` §14 Q5.)

### 5.2 Export safety rules (Codex review A7, retained)

These apply to the explicit export-and-track action (they are no longer
"auto-track" rules, but the safety constraints still hold):

- **Commit only on the explicit user save/export action**, never on every
  keystroke or background tick.
- **Block the commit when the docs worktree has dirty unrelated changes** — do not
  commit on top of unrelated uncommitted work; surface it instead.
- **One managed docs worktree per repo/branch**, with **serialized writes / a
  lock** so concurrent exports cannot race on the same checkout.

Store the global default and per-repo override on the project/repo settings
surface (the existing `settings` table is in the backup list at
`src/ledger/backup.ts:38`; project-scoped settings can hang off `ledger_projects`
or a settings row). Re-exporting the **same** document to the **same** confirmed
path is idempotent.

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

## 7. HumbleB tie-in (v1 = ingest-as-source via the existing bridge)

The canonical serialization (§1) is **also** what HumbleB ingests. The HumbleB
side already defines a document-provenance contract `humbleb.document_provenance.v1`
with `DocumentRecord` / `DocumentVersion` / `DocumentChunk` / `SourceSpan` /
`ClaimSourceLink` (`humbleb-repo/docs/mandible_document_bridge.md:11-29`), keyed on
a stable logical identity like `mandible://<repo>/issue/<id>`.

**v1 scope (SHRUNK, decided — `UMBRELLA-PLAN.md` §10.1).** v1 is **only**:
a Space document can be **snapshotted/exported as a SOURCE that HumbleB ingests**,
reusing the **existing** Mandible→HumbleB document bridge
(`humbleb-repo/humbleb/sources/mandible.py`,
`humbleb-repo/docs/mandible_document_bridge.md`), so the document's extracted
triples enter RAG queries. This is path (1) below and is the **whole** of v1.
It is coordinated under the **existing HumbleB umbrella a8fbc09**, reframed as
"make Space documents ingestable as HumbleB sources."

1. **(v1) Finished snapshot → Mandible artifact / repo export → HumbleB ingests it
   via the existing bridge.** Fits `knowledge_backrefs.source_type='artifact'`
   (`src/db.ts:1629`). The exported document, registered as an artifact, becomes a
   `DocumentVersion` with deterministic chunks/spans, fed through the same adapter
   that already ingests `# Mandible Issue …` packets, generalized to accept a
   Space document. **This is the v1 ingest-as-source path.**
2. **(DEFERRED — not v1) Live-while-writing → `mandible.space_snapshot.v1` packet**
   carrying stable `space_id` / `block_id` / `item_id` + rendered source spans, so
   HumbleB `SourceSpan`/`ClaimSourceLink` backrefs land on **editable blocks**, and
   the **live paragraph-level backref display** in the document renderer. The
   in-band block `id` directive attributes from §1.2 would supply the stable span
   identity. **Explicitly deferred to a later item; do not build in v1.**

### 7.1 HumbleB identity contract (Codex review A9)

- **Use `source_type='artifact'` now (v1).** Finished snapshots ingest as
  artifacts; this is the path that works against the schema today
  (`source_type IN ('artifact','document')`, `src/db.ts:1627-1648`). There is
  **no Mandible `documents` table**.
- **Allow `source_type='document'` only once a logical document identity
  exists.** That means a stable `mandible://<repo>/space/<space_id>` identity plus
  version metadata. Do not adopt `'document'` before that identity is defined.
- **`mandible.space_snapshot.v1` is part of the DEFERRED item, not v1.** When the
  deferred live-backref work is taken up, **define `mandible.space_snapshot.v1`
  before implementing** it. Its keys are `space_id`, `block_id`, `item_id`,
  character offsets, text hash, and source version — the span identity HumbleB
  `SourceSpan`/`ClaimSourceLink` rows attach to. The deferred path (2) is blocked
  on this packet being specified.
- **Parameterize the hard-coded companion issue (v1).** The adapter hard-codes
  `mandible_companion_issue = "d25bac5"` (`humbleb-repo/humbleb/sources/
  mandible.py:285`, also `:368`) and tests assert it
  (`humbleb-repo/tests/test_mandible_adapter.py`). Fine as a fixture; it **must be
  parameterized** as part of generalizing the bridge to Space-document sources.
- **HumbleB ingests the repo-authoritative snapshot, not stale Mandible working
  state.** After export, authority is `'repo'` (§6); the bytes HumbleB ingests are
  the exported/committed docs-branch rendition, never an unexported in-progress
  Mandible buffer.

The HumbleB return channel is `knowledge_backrefs` (`provider_id='humbleb'`,
`source_type IN ('artifact','document')`, `src/db.ts:1627-1648`). The v1 path (1)
avoids needing a `documents` table; the deferred path (2) would use space/block IDs
as the document identity without a new table.

---

## 8. Best-practice assessment

The user's design is, on balance, **best-practice**. Specific assessments:

| Decision | Assessment |
|---|---|
| Prose starts in Mandible custody, committed only on explicit user action | **Sound.** Local-first authoring; **default custody = Mandible until the user explicitly commits** (the export dialog), no auto-track. A clean, explicit handoff to repo custody. |
| Canonical serialization designed first | **Sound and the right priority.** Everything downstream depends on it. **Decided as Markdown + non-executable `spaces-doc.v1` directives (NOT full MDX), in-band, single source of truth — no mandatory sidecar** (supersedes the A3 sidecar-manifest design; in-band non-executable directives resolve the round-trip fragility that motivated the sidecar; full MDX rejected on security grounds). |
| Portable inline reference syntax with canonical IDs | **Sound.** Block identity, references, embeds, and structure are **first-class `spaces-doc.v1` directive AST nodes in the document text**, so the text is itself lossless. Trade-off: the directive containers appear as raw text in GitHub/pandoc — mitigated by mandatory markdown fallback content inside each directive. The UI adopts a remark-directive / micromark renderer (NOT an MDX compiler/runtime). |
| Mutable tracking via a first-class `space_exports` table | **Strong.** The content-addressed `artifacts` table (`UNIQUE(algorithm, content_hash)`) cannot model a mutable tracked document; `space_exports` carries authority/drift while artifacts hold immutable snapshots (Codex review A1). |
| Agent-key linked commits on a docs branch; auth queue only on explicit promotion | **Sound and consistent** with the existing two-key model. Linked commits are mandatory so promotion verification passes (§3.2). |
| Export dialog (global default + per-repo override) + untracked export-of-copy as separate paths | **Sound.** Committing is an explicit user action with a confirmable location; the one-shot local file export is a genuinely different intent and stays distinct. |
| Drift sets `space_exports.status` by inspecting the live worktree, repo wins post-export | **Sound.** Drift must read live repo/worktree state, not pinned artifact materialization (Codex review A5). Keeping a pre-export immutable snapshot is the right safety net. |
| Serialization shared with HumbleB (v1 = ingest-as-source via existing bridge) | **Sound.** Designing the serialization once for both export and ingestion avoids divergence; v1 ingests the exported document as a `source_type='artifact'` source through the existing bridge; `'document'` and live block-level backrefs are deferred (§7). |

**Caveats / refinements:**

- **`recoverability` stays a JSON convention (resolved, Codex review A6).** It is
  encoded in the snapshot artifact's `repo_locator_json` / `reference_json`; the
  document lifecycle status is `space_exports.status`, not a new `artifacts`
  column.
- **Idempotent re-export depends on a deterministic chosen path** (§5). The path
  is user-confirmed in the export dialog (global default + per-repo override);
  re-exporting the same document to the same path is idempotent.
- **Pre-export snapshot storage.** Decide where the immutable pre-export history
  lives: `space_blocks` body-revisions (if blocks have revision history like
  `ledger_body_revisions`) vs. a snapshot artifact in custody. A snapshot artifact
  is simpler and reuses content-addressing (and is the `pre_export_snapshot_artifact_id`
  target in `space_exports`).
- **Directive visibility / portability.** The `spaces-doc.v1` block/ref
  directives are rendered by the remark-directive renderer but appear as **raw
  text** in GitHub, pandoc, and bare CommonMark renderers — mitigated by the
  mandatory markdown fallback content inside each directive (§1.2). Confirm the
  chosen directive grammar is the one the shared ref parser and the UI renderer
  both implement (§9, `UMBRELLA-PLAN.md` §14 Q2). No sidecar file leaks into the
  repo because there is no mandatory sidecar.

---

## 9. Open questions

> **Resolved (no longer open):**
> - **Document branch placement** — documents live on a **docs branch** with
>   agent-key linked commits; the auth queue is invoked only on explicit
>   user-requested promotion to `main` (§4.0).
> - **`recoverability`** — drift status lives on `space_exports.status`, not a new
>   `artifacts` column (§2.2); `recoverability` stays a generic-artifact JSON
>   convention.
> - **Serialization format / sidecar** — canonical format is **Markdown +
>   non-executable `spaces-doc.v1` directives (NOT full MDX)**, fully in-band; the
>   HTML-comment-anchor + mandatory-sidecar design is **superseded** (§1, supersedes
>   Codex A3). Full MDX rejected on security grounds (executes JavaScript; violates
>   `marked` + DOMPurify security model). No sidecar is required (at most an
>   optional minimal one, currently believed unnecessary).
> - **Auto-track default** — **removed.** Default custody is **Mandible custody
>   until an explicit user commit** via the export dialog (§2.2, §3, §5); no
>   auto-track, no silent auto-commit.

1. **Embed-on-delete behavior — DEFERRED (implementer must surface to user).**
   What happens to a document embed/reference block when the embedded item is
   deleted is **not decided now**; the document-renderer implementing agent **MUST
   prompt the user** for this decision when it becomes relevant (`UMBRELLA-PLAN.md`
   §14 Q1, §12). `space_blocks.item_id` is `ON DELETE RESTRICT` + `item_snapshot_json`
   so a placeholder is always *possible*; the chosen behavior is the open part.
2. **Which specific remark/micromark library.** The format is resolved: Markdown
   + non-executable `spaces-doc.v1` directives rendered via **remark-directive /
   micromark** (NOT a full MDX compiler/runtime). The open part is which concrete
   remark/micromark library and plugin combination replaces the bare `marked` path
   (`ui/src/sanitize.ts`, `ui/src/views/artifacts.tsx`), and the finalized
   `spaces-doc.v1` directive grammar (block identity / ref / embed node forms). —
   cross-ref `UMBRELLA-PLAN.md` §14 Q2.
3. **Exact global/per-repo default export path scheme.** The export dialog (§5)
   resolves a **global default repo-relative path** plus optional **per-repo
   overrides**; the concrete default path string, per-repo override storage, and
   any collision/rename policy are not finalized. — cross-ref `UMBRELLA-PLAN.md`
   §14 Q5.
4. Pre-export snapshot storage: block body-revisions vs. snapshot artifact? — §8
   (leaning snapshot artifact, reuses content-addressing).
5. Does the canonical serialization need an `external_ref` alias mechanism so
   external references resolve deterministically on re-import? Note
   `ledger_external_refs` (`src/db.ts:1222`) exists but is an **adapter-sync**
   table (git-bug import), not a general external-URI registry — do not repurpose
   it without verifying fit. — cross-ref `UMBRELLA-PLAN.md` §14.
6. **(DEFERRED item)** For the deferred HumbleB live-backref path, the canonical
   `mandible.space_snapshot.v1` schema and whether it versions independently of
   `mandible.document.v1` (the text serialization). Not a v1 question (§7).
