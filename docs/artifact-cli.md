# Artifact CLI and Runtime Contract

Mandible-Issue: 44074ed
Mandible-Issue: 58316eb
Mandible-Issue: f094416

Mandible artifact commands are a thin interface over the artifact registry. They
should create structured artifact records and links, not just paste paths into
issue comments. Durable references should prefer `repo://...` and canonical
compact `artifact:<unique-hash-prefix>` refs over absolute local paths.

User-facing hash references may use compact SHA-256 prefixes when the prefix is
long enough to identify exactly one artifact, for example
`artifact:ad46ed88a9e8`. SHA-prefixed URI forms are not valid authored refs.
Prefix resolution must report `ambiguous` when multiple artifacts match and
`unresolved` when none match; it must not guess or create a new hash-only
artifact from a short prefix.

Living logical artifact links should use `artifact:<prefix>` once the logical
artifact prefix is long enough to resolve unambiguously. Compatibility readers
also accept `artifact-series:<prefix>`, `artifact-series:<prefix>@<n>`, and
`artifact-series:<prefix>@latest`. Pinned selected versions should use
`artifact-version:<prefix>`. Immutable byte references should use
`artifact:<unique-hash-prefix>`. Current producers must not emit
`artifact:sha256:<hash>`; `artifact-blob:<hash>` is retained only as an explicit
legacy/read boundary or an ambiguity-safe full fallback.

## Repo-Local Artifacts

Tracked, clean repo files are recoverable from Git when the ref is immutable and
the commit remains reachable. For these files, CLI output should use link
custody with a commit-pinned repo locator:

```bash
mandible artifact ingest results/run-7/report.md --json
```

Expected JSON shape:

```json
{
  "custody_mode": "link",
  "availability": "present",
  "recoverability": "repo_commit",
  "ref": "repo://rlrmp@abcdef1234567890/results/run-7/report.md",
  "sha256": "..."
}
```

Ignored or untracked repo-local files are different. A hash identifies the bytes
that were observed, but it does not make those bytes recoverable in the future.
The CLI may register them as link-custody artifacts when explicitly requested,
but it must preserve a `local_only` warning:

```bash
mandible artifact ingest _artifacts/run-7/checkpoint.eqx \
  --allow-local-only \
  --role model_checkpoint \
  --json
```

Expected JSON shape:

```json
{
  "custody_mode": "link",
  "availability": "present",
  "recoverability": "local_only",
  "ref": "artifact:...",
  "warnings": ["local_only"]
}
```

Do not turn ignored files into durable-looking issue evidence unless they are
copied into Mandible custody, promoted to a provider/object store, or paired
with a tracked regeneration path.

When the CLI talks to Mandible through `MANDIBLE_BASE=file://<spool>`, path
names belong to the client namespace, not the daemon namespace. In that mode,
path-based `artifact ingest` defaults to copy custody and sends file bytes plus
the client-computed SHA-256 in the request body. The same upload path can be
forced over any transport with `--upload`. Explicit `--link` remains a
host-path contract and is rejected in upload mode because link custody requires
a daemon-visible path.

## Feature Branches

Branch names are mutable aliases. They are useful for humans, but they are not
durable artifact identities. When an artifact is tracked and clean, Mandible
should register the commit hash that currently contains the bytes:

```bash
mandible artifact ingest results/run-7/report.md --issue 44074ed --json
```

A normal merge preserves the original commit object, so deleting the feature
branch does not invalidate a `repo://repo@<commit>/path` artifact ref as long as
that commit remains reachable from the protected branch or another retained ref.
Squash merges and rebases are different: the original feature commit may become
unreachable after branch deletion and garbage collection. If a branch is going
to be squashed or rebased, either register the final protected-branch commit
after merge, snapshot the artifact into Mandible custody, or register a tracked
regeneration manifest.

This distinction mostly matters for tracked artifacts. Ignored, untracked, and
dirty worktree artifacts do not have a stable Git object in the first place, so
they must be treated as `local_only`, copied into Mandible custody, promoted to a
provider store, or paired with a tracked regeneration path.

## Recoverability

Custody says who owns bytes. Availability says whether bytes can currently be
materialized. Recoverability says what future guarantee the record provides.

| Recoverability | Meaning |
| --- | --- |
| `repo_commit` | Bytes are recoverable from a repo at an immutable commit and path. |
| `repo_worktree` | Bytes are present in a checkout but not pinned to committed bytes. |
| `local_only` | Bytes were observed on this machine only. |
| `mandible_cas` | Bytes are present in Mandible copy or managed content storage. |
| `provider_store` | Bytes are recoverable through a provider/object-store locator. |
| `external_remote` | Bytes are referenced by an external remote URI. |
| `regenerable` | A tracked spec or manifest records how to regenerate the bytes. |

`mandible artifact check` should distinguish missing bytes from stale or
mismatched bytes. A missing file is an availability problem. A hash mismatch is
an identity problem and should not be served as if it were the registered
artifact.

`mandible artifact snapshot` promotes observed bytes into Mandible copy/managed
custody. This is the right escape hatch for hash-only external references or
local-only files that need durable issue evidence:

```bash
mandible artifact snapshot artifact:<unique-hash-prefix> --from ./external.txt --json
```

For a local path that should be copied directly into Mandible custody, use:

```bash
mandible artifact snapshot _artifacts/run-7/checkpoint.eqx \
  --issue 44074ed \
  --role model_checkpoint \
  --json
```

For sandboxed clients using file RPC, this command uploads the bytes directly
and Mandible verifies the SHA-256 before storing them in content-addressed
custody. The daemon does not need to read the client path.

## Issue Links

Passing `--issue` should create an artifact link row. It should not rely on
free-text issue comments.

```bash
mandible artifact link repo://mandible@<commit>/results/report.md \
  --issue 44074ed \
  --relation evidence \
  --role report \
  --json
```

The linked artifact may be repo-local, Mandible-managed, provider-owned, or an
external/hash reference. If the issue reference is ambiguous across projects,
the command should fail instead of guessing.

## Bundles

Batch registration and bundle creation are not the same operation.

Use batch registration when several files only need individual artifact records:

```bash
mandible artifact ingest results/run-7/run.json results/run-7/report.md --json
```

Use a bundle when the files form one logical packet with its own identity:

```bash
mandible artifact bundle create \
  --name run-7-packet \
  results/run-7/run.json \
  _artifacts/run-7/checkpoint.eqx \
  --allow-local-only \
  --json
```

A bundle should have a first-class Mandible identity, usually a small managed
manifest plus bundle-member links. Members remain separate artifact records. A
tracked `results/run-7/run.json` member can have `repo_commit` recoverability
while an ignored `_artifacts/run-7/checkpoint.eqx` member keeps `local_only` or
is explicitly snapshotted into Mandible custody.

Bundle membership can be appended later:

```bash
mandible artifact bundle add artifact:<bundle-hash-or-prefix> \
  _artifacts/run-7/weights.safetensors \
  --allow-local-only \
  --json
```

The bundle identity remains the Mandible bundle artifact. The authoritative live
membership is the set of bundle-member links returned by
`mandible artifact bundle show`; the original manifest is the creation snapshot,
not proof that every later member was content-addressed inside the manifest.

`--managed` on a bundle means the bundle manifest is managed. It must not
silently copy every member into Mandible CAS unless the command exposes that as
an explicit member-level choice.

## Repo Scanning

Discovery should be read-only:

```bash
mandible artifact scan-repos --repo rlrmp --dry-run --json
```

Mutation should be explicit:

```bash
mandible artifact scan-repos --repo rlrmp --register --json
```

Scan output should report discovered, skipped, and failed paths. It should not
register arbitrary source files just because they exist; paths should be
artifact-like by convention or explicitly registered by the user.

## Stable identity and explicit source moves

A logical artifact keeps its identity when its source moves. Ordinary `ingest`
resolves the registered source; an unbound path creates a new artifact. Use
`--artifact <artifact-ref>` with one input path to update an exact existing
artifact. `record` accepts the same option. It must match the registered source;
`--series-key` cannot override that check or change ownership.

Move its registered source with ordinary project and path arguments:

```bash
mandible artifact move abc1234 --path reports/renamed.md
mandible artifact move abc1234 --project research
mandible artifact move abc1234 --project research --path reports/final.md
mandible artifact ingest reports/final.md --artifact abc1234
```

Omitted fields retain their current values. Project names, keys and other
unambiguous registry refs are accepted. Repository paths are relative to the
repository root; local sources use absolute paths. At least one field is
required. Defaults, actor identity, permissions and the change are resolved in
one server transaction. `--if-revision 3` optionally rejects a stale move;
no preliminary source lookup is needed for ordinary use.

Moves change metadata only. Move the actual file separately. Ownership and old
versions stay unchanged. Write access to the artifact, its owner and current
and destination source projects is required. Occupied destinations fail without
mutation. Repeating a move to the same source returns `unchanged` without
advancing the revision. Reusing the former path with ordinary ingest creates a
separate document.

### Import a committed path without checkout

```bash
mandible artifact ingest reports/old-name.md --project research --commit release-1
mandible artifact ingest reports/a.md reports/b.md --project research --commit HEAD~2 --copy
mandible artifact ingest reports/old-name.md --project research --commit release-1 --artifact abc1234
```

The daemon resolves the Git ref once and reads regular-file blobs directly
from an available registered repository. Commit paths are repository-relative;
without `--project`, the CLI's working repository selects the project. Neither
the path nor the requested commit needs to be checked out. Versions retain the
canonical project, full commit, path and content hash. `--copy` or `--managed`
stores the same bytes in Mandible custody.

Historical imports leave the current source unchanged. Current sources, prior
moves and recorded version provenance establish lineage. One matching artifact
is selected automatically; multiple candidates (including a reused old path)
require `--artifact`. An explicit artifact must have lineage for that exact
project/path. No candidate creates a new document. A different commit, custody
choice or version metadata creates a distinct version; identical evidence
returns the same version, including versions recorded before this extension.

### Batch and advanced contracts

Host-visible multi-path ingestion sends one request. Every path is validated
and authorized before custody or metadata writes, and metadata commits in one
transaction. A denied or invalid batch changes nothing. Upload, file-RPC and
blob-only modes accept one path per command; requesting an unsupported batch
fails before sending any writes. Commit ingestion requires host HTTP access to
the registered repository. `--dry-run` plans without mutation.

Human output reports `created`, `updated` or `unchanged`, with the artifact and
pinned version. Use `--json` for structured details.

`POST /api/artifacts/ingest` accepts `paths`, optional `project`, `commit`,
`artifact_id`, and custody options. `POST /api/artifacts/source/move` accepts
`artifact_id`, optional `project`, `path`, and `expected_revision`. Both resolve
authorization through the canonical lifecycle. The advanced
`artifact source move --expected-revision N --source JSON` contract remains for
explicit source-kind changes, such as a managed producer key. `source show`
exposes the current source and revision. Source JSON uses canonical project
IDs and normalized paths.

Uploaded file bytes use Mandible custody with an explicit source descriptor.
The source identifies the document; it does not claim that uploaded bytes are
committed in Git. A named managed snapshot retains the artifact's registered
source when no replacement source is supplied.

When `source show` reports `reconciliation_reason`, inspect the retained versions
and choose the correct source explicitly. `move ... --reconcile` (or the advanced source command) clears
that requirement for the named artifact under the same revision, destination,
and permission guards. It never merges identities or infers historical lineage.
