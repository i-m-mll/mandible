# Artifact version identity and custody history

Issue: f7a994e (umbrella ce690eb — control-plane hardening)

## Problem

Mandible artifact rows are immutable content/reference records keyed by
`artifact:sha256:<hash>` with `UNIQUE(algorithm, content_hash)`. Re-registering a
changed file produces a *new, unrelated* artifact row. Nothing expresses "the
old row and the new row are two versions of one logical artifact". This change
adds a logical **series** identity layered on top of the immutable rows, plus
**version** rows that pin specific immutable `artifacts.id` content rows, and a
read-only version-history + diff surface — without changing the immutability or
backward-compatibility of existing `artifact:sha256:<hash>` refs.

## Schema (migration v88, additive only)

Two new durable tables. Both are created with `CREATE TABLE IF NOT EXISTS` in a
sequential `MIGRATIONS` entry (version 88), so they materialize identically on
fresh DBs (the migration list is replayed by `migrate()`) and on existing DBs.
No existing table is altered; `artifacts` and its `UNIQUE(algorithm,
content_hash)` are untouched.

### `artifact_series` — stable logical identity

| column | meaning |
| --- | --- |
| `id` (PK) | `artifact-series:<32hex>` deterministic from `series_key` |
| `series_key` (UNIQUE) | stable logical key — the dedupe anchor for "same logical artifact" |
| `source_kind` | `tracked_repo` \| `local_only` \| `managed` \| `mixed` (CHECK) |
| `title`, `repo_id`, `logical_name` | descriptive/lookup metadata |
| `latest_version_id`, `version_count` | denormalized convenience, maintained on append |
| `metadata_json` | object blob |
| `created_at`, `updated_at` | ms epoch |

`series_key` is derived deterministically from the logical identity so that
re-registering the *same logical artifact* lands on the *same series*:

- tracked_repo: `repo:<repo_id>:<repo_path>`
- local_only: `local:<realpath>`
- managed: `managed:<logical_name>` (logical_name required)

A caller may also pass an explicit `series_key` to override the default.

### `artifact_versions` — version rows pinning immutable content

| column | meaning |
| --- | --- |
| `id` (PK) | `artifact-version:<32hex>` deterministic from `(series_id, source_kind, natural_key)` |
| `series_id` | FK → `artifact_series(id)` ON DELETE CASCADE |
| `artifact_id` | FK → `artifacts(id)` ON DELETE RESTRICT (the immutable content row) |
| `version_no` | sequential per series; `UNIQUE(series_id, version_no)` |
| `source_kind` | `tracked_repo` \| `local_only` \| `managed` (CHECK) |
| `content_hash` | denormalized sha256 for fast compare/dedupe |
| `commit_sha`, `repo_path` | tracked_repo provenance |
| `observed_path` | local_only provenance (realpath observed) |
| `custody_mode`, `label`, `note`, `metadata_json` | per-version state |
| `created_at` | ms epoch |

The version `id` is **deterministic** (`artifactRegistryId("artifact-version",
[series_id, source_kind, natural_key])`), giving idempotent re-records via
`ON CONFLICT(id) DO NOTHING`. Natural keys per kind:

- tracked_repo: `<commit_sha>:<repo_path>` — re-recording the same commit/path is a no-op.
- local_only: `<content_hash>` — identical bytes collapse; changed bytes append a new observation.
- managed: `<content_hash>` — re-snapshotting identical bytes is a no-op; new bytes append.

`version_no = max(version_no)+1` is computed before insert; a conflicting id
skips insertion and returns the existing row, so `UNIQUE(series_id, version_no)`
never collides on re-record.

## The three source kinds

- **tracked_repo** — `registerLocalArtifactPath` (link custody) classifies a
  clean tracked file as commit-pinned (`repo://repo_id@commit/path`). The version
  stores `commit_sha` + `repo_path`. Old versions remain materializable via
  `git show <commit>:<path>` (handled by existing `readRepoArtifactBytes`).
- **local_only** — an explicit *observation* of a mutable local file. The bytes
  are **snapshotted into Mandible CAS** (`snapshotArtifactBytes`, copy custody)
  so the observed version stays materializable after the file changes. The
  version stores `observed_path` + `content_hash`.
- **managed** — multiple full copy/managed snapshots under one logical identity.
  Each distinct content is a CAS copy; v1 and v2 both materialize independently
  from CAS.

## Recording is explicit (never from preview/check)

Version history is **only** written by the explicit entry points:
`recordArtifactVersion()` / `POST /api/artifacts/versions` / `mandible artifact
record`. The ordinary `ingest` / `snapshot` / `plan` / `check` / `content`
preview paths are unchanged and never touch the version tables. Recording a
local-only observation therefore requires the explicit `record` command (with
`--kind local_only`), satisfying the "ordinary preview/check must not mutate
history" rule.

## Diff derivation (derived, secondary)

Diffs are **derived from full snapshot bytes**, never stored as the canonical
representation (mirrors the issue/comment body-revision precedent —
`listBodyRevisions` stores full bodies and derives diffs). `diffArtifacts()`
(in `artifact-content.ts`, which already owns byte materialization) resolves
each ref to its immutable artifact, reads full bytes via the existing
`resolveRegisteredArtifactPath` / `readRepoArtifactBytes` plumbing, classifies
text-vs-binary (reusing `previewKind`), normalizes JSON (pretty-print both
sides) for stable semantic diffs, and emits a line-based LCS unified diff plus
add/remove stats. Binary or oversized content reports `diffable: false` with a
reason rather than dumping bytes.

## Ref resolution: backward-compat + no silent retarget

`resolveArtifactRef()` is extended at the top with a branch for the **new**
schemes only; every existing form (`artifact:sha256:<hash>`, bare/prefix hashes,
`repo://`, other URI aliases) is byte-for-byte unchanged and still immutable.

New ref forms:

- `artifact-version:<id>` → the version's pinned immutable artifact. **Pinned**, no warning.
- `artifact-series:<id>@<n>` (or `#<n>`) → that specific version. **Pinned**, no warning.
- `artifact-series:<id>` / `…@latest` → latest version's artifact, returned with
  `warnings: ["series_latest_not_pinned"]`.

`ArtifactResolveResult` gains optional `series`, `version`, and `warnings`
fields (additive; existing callers ignore them).

**No silent retarget:** issue evidence links pin a *concrete* immutable
`artifact:sha256:<id>` at link time (`resolveAndLinkArtifact` links
`resolution.artifact.id`, never a series). Recording a newer version into the
series creates a new `artifact_versions` row and never rewrites `artifact_links`.
A link made against an immutable version (or even a series-latest ref, which is
pinned to the concrete artifact at link time) continues to resolve to that exact
artifact after later versions are recorded. Series-latest resolution carries a
warning so any UI/CLI surfacing it can flag that it is not pinned.

## Backup / export coverage

`artifact_series` and `artifact_versions` are added to
`METADATA_BACKUP_TABLES` (`src/ledger/backup.ts`), placed after `artifact_links`
and before `knowledge_backrefs` so parents precede children. The metadata backup
emits each table's own DDL (including inline `UNIQUE`/FK/CHECK constraints) and
runs with `foreign_keys=OFF`, so constraints and rows round-trip through
backup/restore. (The deferred v87 standalone-partial-index restore gap is out of
scope; the new tables' uniqueness lives in inline table-level `UNIQUE`
constraints, which the backup already preserves.)

## Files changed

- `src/db.ts` — migration v88 (`artifact_versioning`): the two tables + indices.
- `src/types.ts` — `ArtifactSeriesRecord`, `ArtifactVersionRecord`,
  `ArtifactVersionSourceKind`; optional `series`/`version`/`warnings` on
  `ArtifactResolveResult`.
- `src/provider-artifacts.ts` — series/version CRUD (`ensureArtifactSeries`,
  `appendArtifactVersion`, `recordArtifactVersion`, `listArtifactVersions`,
  `getArtifactSeries`, `getArtifactVersion`), row mappers, and the
  `resolveArtifactRef` version/series branch.
- `src/artifact-content.ts` — `readArtifactBytesFull`, `diffArtifacts`.
- `src/routes/providers.ts` — `GET /api/artifacts/series/:ref/versions`,
  `GET /api/artifacts/diff`, `POST /api/artifacts/versions`.
- `src/file-rpc-transport.ts` — allowlist the two new GET read routes and the
  POST record route.
- `cli/artifact.sh` — `versions`, `diff`, `record` subcommands + help.
- `test/artifact-versions.test.ts` — new; `test/provider-artifacts.test.ts`,
  `test/artifact-cli.test.ts` — extended.

## Architectural reflection (global "Mandible Artifacts" conventions)

The global CLAUDE.md "Mandible Artifacts" rules say tracked clean artifacts get
link custody + a commit-pinned repo ref; ignored/untracked/dirty bytes are not
durable Git artifacts and need explicit local-only policy or a CAS snapshot; and
issue evidence should resolve to durable bytes. This design follows those rules:
tracked_repo versions reuse the commit-pinned link path; local_only and managed
versions snapshot durable bytes into CAS; and issue links stay pinned to
immutable content so evidence never silently drifts. No CLAUDE.md change is
required — the conventions already anticipate "specific immutable version" issue
evidence, which the no-silent-retarget rule enforces. If a future UI exposes
series-latest links as first-class evidence, the "Mandible Artifacts" section
should gain a sentence requiring an explicit pin step, but that is out of scope
here.

## Codex adversarial-review revisions

An external Codex review found correctness bugs in the first pass. The series /
version model is unchanged; these are corrections.

- **HIGH — dirty/staged tracked files (`tracked_repo`).** Previously a dirty
  tracked file was recorded as a commit-pinned `tracked_repo` version with only a
  warning, so two dirty records at the same HEAD/path collapsed by
  `commit:path` even with different bytes, and diff/materialization read
  committed bytes via `git show`. Now `recordArtifactVersion` classifies the
  path read-only first (`planLocalArtifactPath`): only `recoverability ===
  "repo_commit"` is stored as a commit-pinned `tracked_repo` version. A
  dirty/staged/untracked file is instead snapshotted into CAS and recorded as a
  **content-hash-keyed `local_only`** version under the same repo-derived series
  (warning `tracked_repo_dirty_recorded_as_local_only`), so different dirty bytes
  are distinct versions and diff/materialization read the recorded bytes, never
  HEAD.
- **HIGH — managed `ref` did not snapshot.** The managed `ref` path now reads the
  resolved artifact's full bytes (`readArtifactBytesFull`) and writes a real CAS
  snapshot via `snapshotArtifactBytes(custody_mode: "managed")`. Because content
  is hash-addressed, snapshotting bytes that already exist as a `link`/repo row
  dedups to that row (one row per content hash); durability is still guaranteed
  because (a) the CAS copy is written and (b) materialization now has a **CAS
  fallback** (`resolveCasArtifact`): when an artifact's registered location is
  gone but a hash-addressed CAS copy exists, it materializes from CAS. The
  version row records `custody_mode: "managed"` to reflect the managed intent.
- **HIGH — non-atomic `version_no` allocation.** `appendArtifactVersion` now runs
  the MAX(version_no) read + insert + series-counter update inside one
  `db.transaction(...).immediate()` (BEGIN IMMEDIATE takes the write lock before
  the MAX read, so a concurrent writer cannot pick the same number; within one
  process better-sqlite3 is already serialized). It detects `db.inTransaction` to
  avoid nested-transaction errors, and `recordArtifactVersion` wraps
  `ensureArtifactSeries` + append in one immediate transaction so the series,
  version, and counters are all-or-nothing. The deterministic version id keeps
  re-records idempotent.
- **MEDIUM — global managed series key.** The default managed key is now scoped
  by an explicit namespace: `managed:<provider_id|repo_id|issue>:<role?>:<logical_name>`.
  If neither a namespace nor an explicit `series_key` is provided, the record is
  rejected, so two unrelated artifacts named `report` cannot silently share a
  series. `provider_id`/`repo_id`/`issue` were added to the record input and the
  `record` CLI.
- **MEDIUM — "read-only" endpoints could mutate.** `GET /api/artifacts/versions`
  and `GET /api/artifacts/diff` now resolve refs through a new non-mutating
  `resolveArtifactRefReadonly` (version/series refs + already-registered
  artifact/alias lookups only). They never call the materializing
  `resolveArtifactRef`, so a GET with an unregistered hash/URI ref creates no
  rows and returns a clean not-found/empty.
- **MEDIUM — migration could mask a divergent table.** The v88 DDL stays
  `CREATE TABLE IF NOT EXISTS` (idempotent for fresh DBs and the schema-rewind
  re-runs some migration tests perform — plain `CREATE TABLE` would throw
  "table already exists" on those re-runs). To close the masking risk, a
  post-migration `verifyArtifactVersioningSchema` runs whenever v88 is freshly
  applied and fails loudly if either table lacks its expected columns, its UNIQUE
  index, or (for `artifact_versions`) its FKs to `artifact_series` and
  `artifacts`.
- **LOW — selector parsing.** Series version selectors now require
  `^[1-9][0-9]*$`; `@2abc`, `@2.5`, `@0`, `@01` are rejected (status
  `unsupported`, `invalid_series_version_selector`) instead of truncating to 2.
- **LOW — `latest_version_id` has no FK.** It is intentionally a denormalized
  cache (an FK to `artifact_versions(id)` would create a series↔version cycle
  that complicates the foreign_keys=OFF restore). It is maintained atomically by
  `appendArtifactVersion` and covered by a test asserting it equals the actual
  latest version and survives a backup round-trip.

### Focused re-review hardening (round 2)

A second Codex pass confirmed the three HIGH fixes and flagged four smaller
items on the durability path; all are corrected.

- **MEDIUM — CAS read integrity.** `readArtifactBytesFull` now hash-verifies the
  bytes whenever the resolved path is the content-addressed CAS blob — reached
  directly, via a file-scheme alias to the CAS path, or via the CAS fallback
  (the path is matched by realpath, not just the fallback locator). A tampered/
  corrupt CAS blob returns a loud `cas blob hash mismatch` failure instead of
  feeding wrong bytes into a diff or a managed re-snapshot (which then refuses).
- **MEDIUM — schema verifier missed the CHECK.** `verifyArtifactVersioningSchema`
  now also reads each table's stored DDL from `sqlite_master` and requires the
  `CHECK(source_kind IN ...)` clause, so a divergent pre-existing v88 table
  without the CHECK fails verification.
- **LOW — managed series-key escaping.** Default managed-key components
  (namespace, role, logical_name) are percent-escaped (`%`→`%25`, `:`→`%3A`)
  before being joined with `:`, so `namespace "a:b" + name "c"`
  (`managed:a%3Ab:c`) cannot collide with `namespace "a" + role "b" + name "c"`
  (`managed:a:b:c`).
- **LOW — dirty-file provenance.** When a dirty/staged tracked file is routed to
  a `local_only` CAS snapshot, the version (and artifact) metadata records the
  current HEAD commit as `head_commit`/`dirty_at_commit` provenance. The
  commit-pinned `commit_sha` column stays null (these bytes are NOT the committed
  bytes at that commit).
