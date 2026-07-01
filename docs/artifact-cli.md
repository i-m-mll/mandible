# Artifact CLI and Runtime Contract

Mandible-Issue: 44074ed
Mandible-Issue: 58316eb
Mandible-Issue: f094416

Mandible artifact commands are a thin interface over the artifact registry. They
should create structured artifact records and links, not just paste paths into
issue comments. Durable references should prefer `repo://...` and
compact `artifact-blob:<sha-or-prefix>` refs over absolute local paths.

User-facing hash references may use compact SHA-256 prefixes when the prefix is
long enough to identify exactly one artifact, for example
`artifact-blob:ad46ed88a9e8`. SHA-prefixed URI forms are not valid authored refs.
Prefix resolution must report `ambiguous` when multiple artifacts match and
`unresolved` when none match; it must not guess or create a new hash-only
artifact from a short prefix.

Living logical artifact links should use `artifact:<prefix>` once the logical
artifact prefix is long enough to resolve unambiguously. Pinned selected
versions should use `artifact-version:<prefix>`. Immutable byte references
should use `artifact-blob:<hash-prefix>`.

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
mandible artifact snapshot artifact-blob:<hash-or-prefix> --from ./external.txt --json
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
