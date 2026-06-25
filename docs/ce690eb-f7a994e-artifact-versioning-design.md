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
