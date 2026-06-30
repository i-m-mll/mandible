# Artifact identity and project associations

Issue: 2dc97b8

Status: proposed implementation spec

## Objective

Mandible should use artifact terminology that matches the domain model:

- `artifact` is the stable logical identity, such as "this repo file", "this
  generated report", or "this managed project document".
- `artifact_version` is one immutable observation/version of that artifact.
- `artifact_blob` is the content-addressed byte/reference record.

Project association and project canonicality should be explicit project memory,
not an overloaded artifact link, source repo locator, issue mention, or Space
membership. The implementation should add a dedicated project-artifact
association table and should keep contextual evidence links and authored Spaces
as separate concepts.

## Current state to preserve

The current implementation already contains most of the underlying concepts, but
the names and field placement do not match the target model.

- `artifact_series` is the current logical artifact identity.
- `artifact_versions` is the current version table.
- `artifacts` is the current content-addressed byte/reference table.
- `artifact_links` is the current contextual link table for issue evidence,
  comments, bundles, and living/pinned contextual artifact references.
- `home_repo_id` and `repo_locator_json` currently live on `artifacts`, but they
  describe source/provenance and materialization, not the byte identity itself.
- `space_items` records that a thing appears in a Space. It is authored
  organization/presentation state, not project canonicality.

The ref compatibility contract must also be preserved:

- `artifact:sha256:<hash>` remains an immutable content/blob ref.
- Existing `artifact-series:*` and `artifact-version:*` refs remain resolvable
  during and after the migration as compatibility aliases.
- Issue evidence links must not silently retarget when a newer artifact version
  is recorded.

## Reference compatibility

The table rename must not repurpose existing public ref namespaces in a way that
changes what old refs mean. In v1, the logical table is named `artifact`
internally, but the existing `artifact-series:*` public ref remains the
compatibility ref for logical artifacts until a non-conflicting logical-artifact
ref scheme is designed.

| accepted ref | resolves to | canonical output | behavior |
| --- | --- | --- | --- |
| `artifact:sha256:<hash>` | `artifact_blob` | `artifact:sha256:<hash>` | Immutable byte/blob ref. Never retargets. |
| `sha256:<hash>` | `artifact_blob` | `artifact:sha256:<hash>` | Existing shorthand. Never retargets. |
| bare hash or accepted hash prefix | `artifact_blob` | `artifact:sha256:<hash>` | Existing shorthand where currently supported. Never retargets. |
| `artifact:<hash>` | `artifact_blob` | `artifact:sha256:<hash>` | Legacy hash shorthand only. Do not use `artifact:<id>` for logical artifacts in v1. |
| `artifact-version:<id>` | `artifact_version` | `artifact-version:<id>` | Exact pinned version. |
| `artifact-series:<id>` | logical `artifact` latest | `artifact-series:<id>` | Compatibility logical-artifact ref; resolves latest with `series_latest_not_pinned` warning. |
| `artifact-series:<id>@latest` | logical `artifact` latest | `artifact-series:<id>@latest` | Same as above with explicit latest selector and warning. |
| `artifact-series:<id>@<n>` or `#<n>` | `artifact_version` | `artifact-version:<id>` if available | Exact pinned version selector. |
| `repo://...` | source locator / alias | resolved artifact/version/blob ref | Existing resolver behavior; repo source details move to version provenance. |

New public logical artifact refs are out of scope for this first migration. The
implementation may introduce display language that calls `artifact-series:*`
"artifact" in CLI/UI, but the parser must continue to treat `artifact:*` as a
hash/blob compatibility form when the suffix is hash-shaped.

## Target invariants

1. Every `artifact_version` belongs to exactly one `artifact`.
2. An `artifact` can have many versions, ordered by `version_no`.
3. A version points at exactly one `artifact_blob`.
4. A blob can be referenced by more than one version. Identical bytes in two
   different logical artifacts are shared as bytes but remain distinct artifact
   identities.
5. Repo/project source identity lives on `artifact` and `artifact_version`, not
   on `artifact_blob`.
6. `artifact_blob` is project-blind. It may know how bytes are stored or
   materialized, but it must not carry repo/project membership.
7. Project canonicality is represented only by the project association table.
   Source repo identity, issue links, and Space membership do not imply
   canonicality.
8. Adding an artifact to a Space does not create a project association by
   default.
9. Migration must not infer canonical rows from `home_repo_id`,
   `repo_locator_json`, issue links, or Space membership.
10. Backup/restore must round-trip the new tables, inline uniqueness
    constraints, foreign keys, CHECK constraints, and secondary indexes.

## Target data model

### `artifact`

`artifact` replaces the role currently held by `artifact_series`.

It owns stable logical identity and source-level grouping. For a tracked repo
file, this is the repo/path identity. For a managed artifact, it is the explicit
managed namespace plus logical name. For local-only observations, it is the
declared local identity.

Conceptual columns:

| column | purpose |
| --- | --- |
| `id` | stable logical artifact id |
| `identity_key` | deterministic unique key for the logical identity |
| `source_kind` | `tracked_repo`, `local_only`, `managed`, `external`, or `mixed` |
| `title` | display title |
| `source_project_id` | optional FK to `ledger_projects(id)` when source resolves to a canonical Mandible project |
| `source_repo_id` | compatibility/display repo key when present |
| `logical_name` | human logical name, path, or managed name |
| `source_path` | repo path or local observed path when it is part of identity |
| `latest_version_id` | denormalized latest version cache |
| `version_count` | denormalized count |
| `metadata_json` | object metadata |
| `created_at`, `updated_at` | timestamps |

`identity_key` is the dedupe anchor and should be inline `UNIQUE`. Example
forms:

- `repo:<project-key>:<repo-path>` for a canonical tracked repo file.
- `repo:<repo-id>:<repo-path>` only when no canonical project id can be
  resolved; this should carry a migration warning and remain repairable.
- `managed:<namespace>:<logical-name>` for managed artifacts.
- `local:<stable-realpath-or-explicit-key>` for local-only artifacts.

Tracked repo artifacts should be unique by repo identity plus path through the
`identity_key`, not by content hash.

### `artifact_version`

`artifact_version` replaces the role currently held by `artifact_versions`.

It owns one immutable observation/version of a logical artifact. It stores the
source provenance required to understand and materialize that version.

Conceptual columns:

| column | purpose |
| --- | --- |
| `id` | stable version id |
| `artifact_id` | FK to `artifact(id)` ON DELETE CASCADE |
| `version_no` | sequential number within the artifact |
| `blob_id` | FK to `artifact_blob(id)` ON DELETE RESTRICT |
| `source_kind` | version source kind |
| `content_hash` | denormalized hash for fast compare/filtering |
| `source_project_id` | optional project FK for this version's source |
| `source_repo_id` | source repo key at observation time |
| `repo_path` | tracked repo path when applicable |
| `commit_sha` | commit-pinned source when applicable |
| `observed_path` | local observed path when applicable |
| `source_locator_json` | structured repo/local/provider locator |
| `custody_mode` | custody intent for this version |
| `label`, `note` | user/agent version annotations |
| `metadata_json` | object metadata |
| `created_at` | timestamp |

Required constraints:

- `UNIQUE(artifact_id, version_no)`.
- A version id must be deterministic for idempotent re-records.
- Version insert and artifact `latest_version_id` / `version_count` updates must
  be one immediate transaction.
- For tracked repo artifacts, version source project/repo/path must be
  consistent with the parent artifact source identity.
- Dirty tracked bytes must be recorded as snapshot/local-only provenance under
  the same logical artifact, not as if they were commit-pinned bytes.

### `artifact_blob`

`artifact_blob` replaces the role currently held by `artifacts`.

It owns byte/content identity and storage/materialization state. It does not own
repo identity, project association, or canonicality.

Conceptual columns:

| column | purpose |
| --- | --- |
| `id` | immutable blob id, preserving `artifact:sha256:<hash>` compatibility |
| `algorithm` | hash algorithm, default `sha256` |
| `content_hash` | content hash |
| `storage_uri` | CAS/external/provider storage locator, not repo provenance |
| `media_type` | MIME/media type |
| `role` | optional role retained for compatibility; project roles belong on associations |
| `size_bytes` | byte size |
| `provider_id`, `manifest_id` | provider/provenance pointers |
| `metadata_json` | object metadata |
| `custody_mode` | `copy`, `managed`, `external`, or compatibility `link` while old rows exist |
| `availability` | materialization status |
| `retention_json`, `reference_json` | durability/reference metadata |
| `created_at` | timestamp |

Required constraints:

- `UNIQUE(algorithm, content_hash)`.
- No `home_repo_id`.
- No `repo_locator_json`.
- Blob materialization may use CAS/provider storage directly. If a version is
  materialized from a repo commit/path, that path comes from
  `artifact_version.source_locator_json`, not from the blob.

Custody split:

- `artifact_blob.custody_mode` describes actual byte-storage/materialization
  state: CAS copy, managed CAS, external/provider store, or compatibility link
  while old rows exist.
- `artifact_version.custody_mode` describes the observation/provenance intent
  for that version: commit-pinned repo version, dirty/local snapshot, managed
  snapshot, provider observation, and so on.
- When a new version shares an existing blob, the version may add provenance,
  but it must not overwrite the blob's storage state with repo/project source
  details.
- Project-blind alternate storage locations for the same blob may live in
  `artifact_blob.reference_json.locations` in v1. If that becomes operationally
  important, add a separate `artifact_blob_locations` table later. Repo checkout
  paths, repo refs, local observed paths, and source project ids do not belong in
  blob locations; they belong on `artifact_version`.

## Project association table

Add a dedicated table, tentatively `project_artifact_associations`.

This table owns project memory: "this project should remember this artifact" and
"this artifact is canonical for this project". It must not replace source
identity or issue evidence.

Conceptual columns:

| column | purpose |
| --- | --- |
| `id` | association id |
| `project_id` | FK to `ledger_projects(id)` ON DELETE RESTRICT |
| `target_type` | `artifact` or `artifact_version` |
| `target_id` | logical artifact id or exact version id |
| `association_kind` | `associated` or `canonical` |
| `role` | normalized role, default empty string |
| `title` | project-specific display title override |
| `description` | project-specific explanation |
| `rank` | optional sort rank |
| `status` | `active`, `superseded`, or `archived` |
| `source` | `user`, `agent_explicit`, `space_rule`, `migration`, or `system` |
| `source_ref_type`, `source_ref_id` | optional provenance pointer |
| `metadata_json` | object metadata |
| `created_at`, `updated_at` | timestamps |

Required constraints:

- `CHECK(target_type IN ('artifact','artifact_version'))`.
- `CHECK(association_kind IN ('associated','canonical'))`.
- `CHECK(status IN ('active','superseded','archived'))`.
- `CHECK(source IN ('user','agent_explicit','space_rule','migration','system'))`.
- `role TEXT NOT NULL DEFAULT ''`.
- Inline `UNIQUE(project_id, target_type, target_id, role)` so backup/restore
  preserves uniqueness.

Association semantics:

- `canonical` implies `associated`; do not store duplicate broad and canonical
  rows for the same project/target/role.
- Upserting `canonical` over an existing `associated` row upgrades that row in
  place.
- Upserting `associated` over an existing `canonical` row must not downgrade it
  unless the caller explicitly requests a status/kind change.
- A logical `artifact` association follows the artifact across versions.
- An `artifact_version` association pins an exact version.
- `artifact_blob` is intentionally not a target type. If a blob must be shown to
  a project, it should first be represented by an artifact/version.
- Migration should create rows only from explicit pre-existing project
  associations if any exist. It should not infer rows from repo source identity,
  issue links, comments, bundles, or Spaces.

Referential integrity:

- `project_id` should use a real FK to `ledger_projects(id)` with
  `ON DELETE RESTRICT`.
- Because `target_type` is polymorphic, target existence must be enforced by the
  write path and covered by tests. SQLite triggers may also be used if the
  implementation keeps them readable and migration-safe.
- Active associations must not dangle. Deleting an associated artifact or
  version should be blocked while an active association exists, or should first
  archive/supersede the association through an explicit service operation.
- `superseded` and `archived` rows remain historical project memory and should
  stay queryable.

## Source identity versus project association

There are two separate questions:

1. Where did this artifact/version come from?
2. Should this project remember or canonize it?

The first question is source identity. It belongs on `artifact` and
`artifact_version`.

The second question is project memory. It belongs in
`project_artifact_associations`.

Project artifact queries should use an intentional read model:

- "Artifacts sourced from this project" comes from `artifact.source_project_id`
  or compatible source repo fields.
- "Artifacts associated with this project" comes from
  `project_artifact_associations`.
- "Canonical artifacts for this project" comes only from association rows with
  `association_kind='canonical'` and `status='active'`.
- A broad "show me artifacts for this project" UI may union sourced artifacts
  with associated artifacts, but should label the reason for inclusion.

## `artifact_links`

`artifact_links` remains the contextual evidence/linkage table. It should not be
the project association table.

It continues to serve:

- issue/comment evidence links,
- bundle membership,
- handoff/output links,
- pinned contextual links,
- living contextual links where allowed.

The implementation should migrate `artifact_links` target fields so their names
match the new model. The target schema should be concrete rather than a
free-form reinterpretation of the old `artifact_id` column.

Target columns:

| column | purpose |
| --- | --- |
| `target_type` | `artifact_version` for pinned links, `artifact` for living links |
| `target_id` | exact version id or logical artifact id |
| `fallback_version_id` | pinned version retained for living links and compatibility display |
| `legacy_blob_id` | old content/blob id during compatibility migration |
| `link_kind` | existing `pinned` or `living` semantics |
| existing entity fields | contextual owner: issue, comment, bundle, etc. |

The intended target behavior is:

- Pinned contextual evidence should resolve to an exact `artifact_version` when
  possible.
- Living contextual links should point at a logical `artifact` plus retain a
  pinned fallback version for display/recoverability.
- `target_id` may use normal FKs when the table is split or when triggers can
  enforce polymorphic integrity clearly. If the implementation keeps a single
  polymorphic link table, target existence must be validated in the write path
  and covered by migration tests.
- `fallback_version_id` should FK to `artifact_version(id)` when present.
- `legacy_blob_id` is a compatibility field, not a semantic target.
- Existing `artifact_id` values that currently name content rows must remain
  resolvable through compatibility logic until all callers are migrated.
- Living issue evidence remains disallowed. Issue evidence must be pinned.
- Old blob/content links migrate through the deterministic one-version wrapper
  created by the current orphan backfill. A pinned old link should become a
  pinned `artifact_version` link when the version can be identified.
- No link row may retarget merely because a newer version is recorded.
- If a link cannot be migrated unambiguously, preserve `legacy_blob_id`, keep the
  old ref resolvable through compatibility code, and emit a migration diagnostic.
- Backup order must place `artifact_blob`, `artifact`, and `artifact_version`
  before any link table that FK-references them.

## Spaces

Spaces and project associations are separate concepts.

`space_items` records that a reference appears in a Space. It is user-facing
organization and presentation state. It can include issues, comments, artifacts,
external refs, and linked Spaces. It should not be duplicated into
`artifact_links` or `project_artifact_associations`.

Rules:

- Adding an artifact to a project-owned Space does not automatically create a
  project association.
- Seeding a Space from issues and their linked artifacts does not create project
  associations.
- A UI action such as "Promote to project artifacts" may create or update a
  `project_artifact_associations` row.
- A Space may explicitly opt into a project-index/canonical rule in metadata or
  a future typed-Space setting. Only that explicit rule may create associations
  from Space membership, and the association row must record `source='space_rule'`
  plus a source pointer to the Space/item.
- Space document export and drift tracking remain owned by `space_exports`.
  Canonical documents should be represented as artifacts/versions unless a
  first-class document identity is added later.

## API and CLI surface

The API should move toward logical artifacts as the primary user-facing object
while preserving old ref resolution.

Required API work:

- Update shared contracts to expose `Artifact`, `ArtifactVersion`,
  `ArtifactBlob`, and `ProjectArtifactAssociation` types.
- Keep `/api/artifacts/resolve` compatible with existing refs.
- Make `/api/artifacts` list logical artifacts, or introduce a parallel logical
  artifact list endpoint before changing the existing response shape.
- Add blob-specific read endpoints only for low-level custody/debug views.
- Add project association endpoints, for example:
  - `GET /api/projects/:ref/artifacts`
  - `POST /api/projects/:ref/artifact-associations`
  - `PATCH /api/projects/:ref/artifact-associations/:id`
  - `DELETE /api/projects/:ref/artifact-associations/:id`
- Add filters for project inclusion reason:
  - sourced from project,
  - associated with project,
  - canonical for project.
- Ensure file-RPC allowlists include the new read/write routes deliberately.

Required CLI work:

- Keep existing `mandible artifact` commands compatible.
- Add explicit project association commands instead of overloading `--repo`.
  Example command family:
  - `mandible artifact associate <artifact-ref> --project <project> [--role <role>]`
  - `mandible artifact canon <artifact-ref> --project <project> [--role <role>]`
  - `mandible artifact associations [--project <project>] [--canonical]`
- `--repo` remains source/repo filtering or source provenance. It does not mean
  project canonicality.

## UI surface

Required UI work:

- Artifact list/detail should present logical artifacts first, with version
  history and blob details as secondary/debug information.
- Artifact detail should show source identity separately from project
  associations.
- Artifact detail should support explicit "Associate with project" and "Mark
  canonical" actions.
- Project-scoped artifact views should show why each item is included:
  `source`, `associated`, or `canonical`.
- Timeline can show canonical project artifacts in a header, sidecar, or row
  group, but canonicality itself is not Timeline layout state.
- Spaces can show association/canonical badges, but Space membership remains
  independent.
- The current artifact Add-to-Space project heuristic should prefer explicit
  project associations or source project identity once available, rather than
  deriving the project only from the first issue link.

## Migration plan

The implementation should use an expand/migrate/switch/contract sequence rather
than a single blind rename. This keeps compatibility and makes data validation
explicit.

### Phase 1: preflight and expand

1. Verify the current artifact versioning schema and the v89 orphan backfill
   post-condition.
2. Add new tables in `src/db.ts` migrations:
   - `artifact_blob`
   - `artifact`
   - `artifact_version`
   - `project_artifact_associations`
3. Add schema verifiers for all new tables, including CHECK constraints and
   inline UNIQUE constraints.
4. Add the new tables to `METADATA_BACKUP_TABLES` in parent-before-child order.
5. Update `tableColumnNames`/schema helpers and tests for the new table names.

### Phase 2: data backfill

Backfill should run inside a transaction and should be idempotent.

1. Copy current `artifacts` rows into `artifact_blob`.
   - Preserve ids as `artifact:sha256:<hash>`.
   - Preserve content hash, media, size, provider, manifest, custody,
     availability, retention, reference, and metadata.
   - Do not copy `home_repo_id` or `repo_locator_json` into blob source fields.
   - Classify old `uri` values:
     - CAS paths and provider/external byte-store locators become
       `artifact_blob.storage_uri` or project-blind blob reference metadata.
     - `repo://...`, checkout file paths, and local observed paths become
       candidate version source locators, not blob storage locators.
     - Ambiguous, stale, or missing locations become migration diagnostics and
       compatibility metadata rather than false blob provenance.
2. Copy current `artifact_series` rows into `artifact`.
   - Preserve stable ids or install compatibility aliases if ids change.
   - Convert `series_key` to `identity_key`.
   - Resolve `repo_id` to `source_project_id` through the project registry when
     possible.
   - Preserve unresolved repo strings as compatibility metadata for later repair.
3. Copy current `artifact_versions` rows into `artifact_version`.
   - `artifact_id` becomes the logical artifact FK.
   - old `artifact_id` becomes `blob_id`.
   - Existing `commit_sha`, `repo_path`, and `observed_path` become version
     source provenance.
   - Source-provenance precedence is:
     1. current `artifact_versions.commit_sha`, `repo_path`, and
        `observed_path`;
     2. current `artifact_series.repo_id` and `logical_name` when they match the
        version row;
     3. current blob-row `home_repo_id`, `repo_locator_json`, or repo/local
        `uri`, only when they match the parent artifact identity or when this is
        the only migrated version for that blob/logical artifact;
     4. otherwise, store legacy locator data as compatibility metadata and emit a
        repair diagnostic.
4. Preserve the invariant that every migrated logical artifact has at least one
   version.
5. Preserve the invariant that every migrated existing blob is referenced by at
   least one migrated version, unless a row is explicitly classified as a
   low-level orphan/custody record with a diagnostic.
6. Do not create project association rows from inferred source repo identity.
7. If explicit legacy project links exist, migrate only those into
   `project_artifact_associations` with `source='migration'`.
8. Migrate `artifact_links` targets after artifacts/versions/blobs exist, using
   the target schema and ambiguity rules above.

### Phase 3: switch code

1. Update provider artifact storage/read APIs to use the new names and field
   ownership.
2. Update materialization so repo reads use `artifact_version.source_locator_json`.
3. Update resolve/list/version/diff routes.
4. Update issue detail artifact extraction/link resolution.
5. Update Spaces resolvers and artifact detail embedding.
6. Update UI API types and Artifact/Spaces/Timeline consumers.
7. Update CLI commands and help text.
8. Update backup/restore tests before relying on the migration in production.

### Phase 4: compatibility and contract cleanup

1. Keep old refs working:
   - `artifact:sha256:<hash>`
   - `artifact:<hash>` shorthand where currently accepted
   - `artifact-series:*`
   - `artifact-version:*`
2. Decide whether old table names become temporary views or are removed after
   all code paths move to the new tables.
3. Keep UI language on "artifact" for logical artifacts. Use "blob" only in
   custody/debug views.
4. Add migration diagnostics for unresolved source projects and ambiguous link
   target migration.

## Testing and verification

Required tests:

- Migration from a pre-redesign database with:
  - tracked repo artifacts,
  - dirty/local-only versions,
  - managed versions,
  - old orphan content rows,
  - issue evidence links,
  - bundle links,
  - living links,
  - Space items referencing artifacts.
- Fresh database schema convergence.
- Backup/restore round trip for new tables and constraints.
- Ref resolution compatibility for old and new refs.
- Materialization from:
  - commit-pinned repo version,
  - CAS-backed blob,
  - provider/external reference,
  - missing bytes with clear diagnostics.
- Association table uniqueness and status transitions.
- Proof that Space membership alone does not create associations.
- Proof that source repo identity alone does not create canonical associations.
- UI tests for artifact list/detail project association display.
- CLI tests for explicit association/canonical commands.

Recommended focused commands once implemented:

```bash
npx vitest run test/artifact-versions.test.ts test/artifact-link-typed.test.ts test/artifact-series-backfill.test.ts
npx vitest run test/provider-artifacts.test.ts test/spaces-routes.test.ts
npx vitest run test/db-migration-*.test.ts
npx tsc --noEmit --pretty false
git diff --check
```

## Agent and policy updates

After the Mandible implementation is ready, the agent policy files should be
updated to match the new model.

Required policy points:

- Agents may record source project identity only when Mandible resolves it
  through the canonical project registry.
- Agents must not use branch names, worktree basenames, path-derived repo ids,
  or free-form strings as project identity.
- Agents must not mark artifacts canonical by default merely because an issue,
  comment, Space, or repo path mentions them.
- Agents may create project associations only after explicit user request or a
  documented workflow rule.
- Canonical association is a stronger project-memory action than ordinary
  source/provenance recording.
- Mandible custody of bytes remains independent from project association.
- Space membership remains user-facing organization unless an explicit
  project-index/canonical Space rule says otherwise.

## Open implementation decisions

The implementation should settle these before code changes begin:

1. Whether the first migration uses compatibility views for old table names or
   updates all code paths in one branch.
2. Whether new public logical artifact refs are introduced immediately, or
   whether `artifact-series:*` stays as the external logical artifact ref during
   the first migration.
3. Whether canonical documents in v1 are always represented as artifacts, or
   whether `project_artifact_associations.target_type` should reserve a future
   `document` target.
4. Whether low-level blob rows may exist without a logical artifact/version
   after the migration, or whether normal registry APIs must always create the
   logical artifact/version wrapper.
5. Whether CAS byte backup/restore is in scope for this redesign or remains a
   separate custody durability issue.
