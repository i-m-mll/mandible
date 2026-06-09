# Artifact, Document, and Knowledge Boundary

Bug: a8fbc09
Bug: e16807c
Bug: d25bac5

Mandible owns operational provenance, issue/work/auth/session state, artifact
references, and optional artifact custody. HumbleB owns document snapshots,
chunks/spans, extracted claims, entities, confidence, and epistemic provenance.
Project/provider repos remain authoritative for source documents and native
provider artifacts when those objects naturally live in a repo.

## Ownership Matrix

| Role | Authoritative home | Mandible responsibility | HumbleB responsibility |
| --- | --- | --- | --- |
| Issue/comment | Mandible ledger | Canonical ID, status, text, links, operational provenance | May ingest snapshots as source documents |
| Provider manifest | Provider emits, Mandible indexes | Store manifest artifact, graph entities/edges, custody metadata | May ingest selected manifest snapshots |
| Artifact | Repo, provider store, external source, or Mandible CAS | Stable reference, custody mode, content identity, availability, retention | May reference as source evidence if ingested |
| Document/report | Repo, Mandible review packet, docs/wiki, or external source | Reference/custody metadata and operational edge to issue/session/provider | Snapshot, chunk/span provenance, extracted claims |
| Claim/entity | HumbleB | Store typed HumbleB refs only, not semantic truth | Canonical claim/entity graph and confidence |
| Projection | Producing system | Mark as projection/readout and keep regeneration provenance | May ingest only if snapshot is needed |

## Custody Vocabulary

- `link`: Mandible stores a stable locator and optional content identity; the
  source system keeps custody.
- `copy`: Mandible stores a copied snapshot while another system remains the
  editorial home.
- `managed`: Mandible content-addressed storage is the custody home.
- `external`: Mandible stores a locator to a source outside local repos/CAS.

Availability uses `present`, `missing`, `stale`, `unchecked`, `remote_only`, or
`pinned`. A path alone is not durable identity; audited references should carry
repo/ref/path and/or a content hash.

## Mandible-Managed Storage

Mandible-managed artifacts use content-addressed storage under
`sha256/<first-two-hex>/<hash>`. New installs default to
`~/.mandible/artifacts`, not a cache directory, because managed CAS content is
custody state rather than disposable build output.

The artifact root is configurable without code changes. Resolution order is:

1. `MANDIBLE_ARTIFACT_DIR`
2. Database setting `artifact_root` through the generic settings API
3. `MANDIBLE_HOME/artifacts`
4. `~/.mandible/artifacts`

`MANDIBLE_ARTIFACT_DIR` remains the strongest override for scripts and tests.
Stored `file://.../sha256/...` database URIs remain storage paths, not authored
artifact refs; authored artifact refs should use compact `artifact:<prefix>`
syntax.

## Examples

- Repo-local RLRMP report: `custody_mode=link`, `home_repo_id=rlrmp`,
  `repo_locator={repo_id, ref, path}`, optional `artifact:<prefix>`.
- RLRMP ignored bulk artifact: `custody_mode=link`, provider/local URI,
  content hash, `availability=unchecked` or `missing` until checked.
- Mandible review packet: `custody_mode=managed` when stored in Mandible CAS,
  or `copy` when snapshotted from a repo/source.
- Docs/wiki page: `custody_mode=link`, docs repo locator; HumbleB may ingest a
  document snapshot but does not become the editor.
- HumbleB snapshot/chunk/claim: Mandible records typed `humbleb:document` or
  `humbleb:claim` references only; claims remain HumbleB-owned.
- Feedbax provider manifest: Mandible stores the manifest artifact, indexes
  provider/model/run/spec/artifact graph nodes, and preserves provider detail
  JSON without validating Feedbax domain semantics.

## Out Of Scope

This phase is not a CMS, KG-native authoring environment, universal artifact
relocator, or bidirectional Markdown sync. HumbleB claim extraction does not
close Mandible issues or create Mandible semantic truth without a separate
reviewed workflow.
