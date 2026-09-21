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

The historical v158 retirement corpus explicitly runs through v184. The source-migration proof script similarly applies only its declared v183-to-v184 transition. It contains intentionally unmaterializable descriptors to verify the older table-retirement ports and authored-reference preservation. It does not assert that those rows satisfy v185 custody. The integrated recovery/migration tests exercise populated v184 recovery through the actual v185 entry point, including metadata audit custody, managed historical-source access, source reconciliation, and collision disposition. Recovery fixtures explicitly construct v184 rather than depending on the current fresh-schema baseline.

## Whole-store rehearsal

A fresh consistent v184 backup was recovered and migrated using the exact v185 SQL with a recording-only Git-retention callback. The isolated populated migration test separately executes the real guarded Git-retention helper in a disposable repository.

| Boundary | Result |
| --- | --- |
| Versions | 927 inventoried; 236 Git and 633 managed retained; 58 retired with exact packet |
| Blobs | 1,503 inventoried; 1,385 retained; 118 retired with exact packet |
| Logical artifacts | 724 retained |
| Source reconciliation | 11 unique Git sources, 6 managed identities, 4 explicitly recorded collision-managed identities |
| Remaining source ambiguity | 0 |
| Integrity | SQLite integrity check passed; no new foreign-key violations |
| Existing unrelated violations | Three unchanged `console_session_usage` rows reference absent `console_sessions` |

Recovery plan digest: `d03e43bf2d59523b0b70e9ef2d4727c7419a973fce2e07e107ad9ac3cea2ff9b`.
The preserved rehearsal directory is `~/.cache/mandible/rehearsals/38aa695-bw8Xnz`: `before.db` is the original consistent backup; `candidate.db` is the isolated result; `final-recovery.json`, `final-retirements.json`, `source-reconciliation.json`, and `final-proof.json` preserve evidence. The rehearsal made no live ledger changes or Git ref writes in registered repositories. Prior recovery-worker rehearsal side effects are recorded separately by that lane.

## Delivery boundary

Worker verification does not establish live migration, packaged-desktop health, or protected delivery. Integration must run recovery before applying v185 and run the required production daemon plus packaged desktop gate from the exact final candidate. Recovery failure must stop startup before v185.

Co-Authored-By: Codex (GPT-5) <codex@openai.com>
