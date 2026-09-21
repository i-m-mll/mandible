# Artifact identity and custody

`artifact` is the stable logical document. `artifact_source` is its current update source, with a revision and explicit move history. `artifact_version` is a saved observation with immutable custody. `artifact_blob` is a shared SHA-256 content descriptor; optional `storage_uri` identifies verified Mandible bytes and never selects the authority of a version.

A version's required `custody_mode` is `git` or `managed`. Git authority is the version's canonical `source_project_id`, full `commit_sha`, normalized `repo_path`, and `content_hash`. Managed versions have null Git authority fields and read the blob's verified stored bytes. Both modes verify the expected hash on reads. No source, alias, metadata field, or equal-byte blob registration can override that choice.

Git registration verifies exact committed regular-file bytes and retains the commit at `refs/mandible/artifacts/<commit>` in a registered object store. This protects it from ordinary branch cleanup and Git garbage collection. Missing repositories remain visible failures; there is no implicit network fetch or managed fallback.

The original input can remain in `observed_path` or descriptive provenance. `source_kind` describes the observation. Neither is read authority. `parent_version_id` records history directly; it is not hidden in a locator envelope. Generic metadata retains user-authored descriptive values, not duplicate custody, recoverability, or repository authority fields.

## History and references

Logical IDs and version IDs survive source moves and recovery of the exact same bytes. Version numbering, labels, notes, timestamps, and review bindings remain independent of shared content hashes. Hash equality never merges logical identities. The content of a reviewed version cannot be replaced with newly discovered current bytes.

Authored logical, version, blob, and series references retain their identity meaning. Alias records preserve authored links and discovery evidence; they are not byte-read fallbacks. Display projections provide the chosen canonical version and shared content descriptor. The database has no legacy artifact/series/version tables and no blob custody mode.

## Ownership and access

The canonical owning project belongs to the logical document. Current source project, historical Git source project, and project associations are distinct facts. Reading and writing continue through canonical access checks. A source move cannot transfer ownership, and changing custody labels cannot bypass project rights.

Project associations target a logical artifact or an exact version, with explicit role, status, and association kind. Blob deduplication cannot widen access to a protected logical document. Briefings bind exact version IDs and frozen reviewed bytes; they do not resolve through the current source or latest version.

## Cutover

The v185 schema removes blob custody/availability/retention/reference envelopes and duplicate version repository aliases and locator JSON. Recovery must inventory every retained version, verify the original hash, stage durable bytes or Git retention first, and atomically normalize metadata before the strict schema transition. Irrecoverable records require explicit backed-up retirement that preserves unrelated user/review content. No legacy authority envelope remains active after cutover.

Co-Authored-By: Codex (GPT-5) <codex@openai.com>
