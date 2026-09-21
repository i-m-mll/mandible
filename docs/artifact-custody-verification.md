# Two-custody verification boundaries

The artifact contract permits only verified Git versions and Mandible-stored versions. Test fixtures must create that authority before asserting behavior. Unknown external references remain provenance, not artifacts. Identity and authored aliases remain supported.

## Maintained evidence

- `artifact-source` protects source moves, ownership and source-project access, stale-source rejection, immutable versions, exact Git reads, retained abandoned commits after Git GC, equal-byte cross-custody isolation, and corruption rejection.
- `artifact-write-routes` and `artifact-cli` protect canonical planning, atomic multi-path ingestion, access enforcement, upload boundaries, and single-path parity.
- `artifact-identity`, `artifact-link-typed`, `artifact-versions`, and `artifact-content-address` protect aliases, prefix ambiguity, version history, pinned versus living links, and exact content identity.
- `provider-artifacts` protects media previews, bounded/off-thread previews, provider lineage, verified repository scanning, and managed input survival after symlink and original-path deletion.
- Extended open, series-list, canonical-consumer, draft, and media-type tests protect selected-version routing, OS-open filename and symlink boundaries, filtering, pagination, editing, and media inference.

## Removed-contract mapping

The following obsolete fixtures were replaced within their maintained suites; no failing tests were moved to extended or quarantine:

| Retired assertion | Replacement boundary |
| --- | --- |
| Mutable local-link previews, drift-tolerant reads, alias-file fallback, symlink link custody | Managed snapshot survives input deletion; corrupt bytes fail; Git cannot fall back to managed bytes |
| Hash-only external artifact registration and promotion | Unknown references stay unresolved/provenance; registration requires verified bytes |
| Blob-level custody promotion, copy/link/external modes, authority from locator metadata | Mandatory version custody, shared descriptor isolation, obsolete-mode rejection |
| Duplicate local/offline CLI classification and link scaffolding | Daemon-owned canonical planner, atomic path ingestion and dry-run transport |
| Legacy blob IDs as the selected version's content route | Exact version IDs in resolver and history projections; historical open reads committed bytes |
| Duplicate compact hash/prefix and repo registration assertions in provider fixtures | Identity/prefix suite and source/write-route canonical-project boundary tests |

The historical v158 retirement corpus explicitly runs through v184. The source-migration proof script similarly applies only its declared v183-to-v184 transition. It contains intentionally unmaterializable descriptors to verify the older table-retirement ports and authored-reference preservation. It does not assert that those rows satisfy v185 custody. The separate recovery lane must execute the v184 recovery and strict v185 schema proof, including guarded retirement, before integration is accepted.

## Delivery boundary

Worker verification does not establish live migration, packaged-desktop health, or protected delivery. Integration must run recovery before applying v185 and run the required production daemon plus packaged desktop gate from the exact final candidate. Recovery failure must stop startup before v185.

Co-Authored-By: Codex (GPT-5) <codex@openai.com>
