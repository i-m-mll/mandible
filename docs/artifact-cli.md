# Artifact CLI

Every saved version has exactly one authority:

- `git`: bytes from a canonical registered project, a full commit SHA, and a repository-relative path. Registration verifies the SHA-256 and retains the commit at `refs/mandible/artifacts/<commit>` so branch removal and ordinary Git garbage collection do not discard it.
- `managed`: verified bytes stored in Mandible's content-addressed store. The input path is an observation or update source, never a fallback for reading a saved version.

There is no copy mode, mutable-file custody, remote-only authority, or registration of a hash without available bytes. Descriptive metadata and source observations do not override custody. New URL references cannot create artifacts; ingest their actual bytes deliberately if they belong in Mandible.

## Register versions

```bash
mandible artifact ingest report.md --json
mandible artifact ingest report.md --managed --json
mandible artifact ingest report.md --git --json
mandible artifact ingest reports/a.md reports/b.md --project research --commit HEAD~2 --json
mandible artifact ingest reports/a.md --project research --commit HEAD~2 --managed --json
```

By default, clean tracked files use Git custody; other files use managed custody. `--git` requires exact committed bytes and rejects a dirty, untracked, or outside-repository file. `--managed` stores a snapshot, including when the input came from a historical commit. A Git project's object store must remain available; Mandible does not fetch from remote repositories.

`--commit` resolves the revision once and reads tracked regular files directly from Git, without checking out that commit. Paths are repository-relative; `--project` accepts an unambiguous registered project reference. Historical registration preserves the current source. When a historical path belongs to multiple artifacts, select the identity with `--artifact`.

Host-visible paths use one atomic metadata request. Every input and access requirement is validated before writes. Uploaded/file-RPC paths and `--blob-only` use per-item delivery; they are not an atomic batch. Uploads always use managed custody. `--blob-only` deliberately registers stored bytes without a logical document or version history.

Exact retries reuse a version. A changed hash, commit, custody choice, label, note, or descriptive metadata creates a new observation. Hash equality does not merge logical documents or change another version's authority.

## Identity and source changes

```bash
mandible artifact move artifact:REF --project research --path reports/renamed.md --if-revision 3 --json
mandible artifact ingest reports/renamed.md --artifact artifact:REF --json
```

A source move changes the registered update location, not files on disk, ownership, prior versions, or reviewed bytes. It requires write access to the artifact, owner, old source, and destination. Occupied locations and stale revisions fail. Reusing an old location may create a different logical artifact.

## References, reads, and history

- `artifact:<id>` identifies a logical document.
- `artifact-version:<id>` pins one saved version.
- `artifact-blob:<hash>` identifies shared bytes, without borrowing an arbitrary version's Git authority.
- Authored `artifact-series:<id>` references still name a living document; a numbered selector pins its historical version.

User-facing artifact links use `/artifact/<typed-short-ref>` on the Mandible origin for the web view, or `/r/artifact/<typed-short-ref>` for the desktop app; `mandible artifact format <ref>` resolves a long or untyped ref. Resolve, show, history, preview, check, download, open, and diff operate on registered identities. Reads never create placeholder artifacts. An unavailable authority or hash mismatch is explicit failure; neither a current checkout nor an alias silently substitutes bytes.

`mandible artifact snapshot` creates managed bytes. Bundles retain ordered membership and manifests; a membership link does not alter member custody. Project associations express ownership/access and grouping independently of byte custody.

## API

`POST /api/artifacts/ingest` accepts host paths, a bounded `paths` batch, optional `project`/`commit`, and `custody_mode: git|managed`. `POST /api/artifacts/versions` records a version from a path, uploaded bytes, or already materializable reference. `POST /api/artifacts/source/move` applies a guarded source change. Authorization uses canonical project identity, never user-provided custody metadata.

Co-Authored-By: Codex (GPT-5) <codex@openai.com>
