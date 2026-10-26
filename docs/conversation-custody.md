# Conversation custody and recovery

Conversation custody preserves provider-native bytes independently from the
normalized conversation index. The store defaults to
`$MANDIBLE_HOME/conversation-custody` (normally
`~/.mandible/conversation-custody`) and deliberately sits outside SQLite,
search/cache databases, SSE payloads, ordinary conversation exports, and
browser storage.

The custody root and every directory below it are mode `0700`; stored files
are mode `0600`. `ConversationCustodyStore` is the encryption-ready boundary:
encryption-at-rest can be added behind that service without teaching routes,
provider discovery, search, or the source reader how raw custody is encoded.

## State and immutability

A capture records the visible sequence
`requested -> capturing -> verified -> sealed`. A caller preparing an external
mirror may request `mirroring` instead of `sealed`. Failure records `error`
with the reason. Only `verified`, `mirroring`, or `sealed` identifies a version
whose manifest and exact bytes passed SHA-256 verification.

Version IDs are derived from the ordered path, byte count, and SHA-256 digest
of every captured dependency. Repeating a capture of unchanged provider bytes
converges on the existing immutable version. Existing version directories are
verified and reused; they are never rewritten.

Each provider adapter captures only root-relative, regular-file dependencies:

- Claude: the main transcript; the session-key subtree containing subagent,
  tool-result, and session artifacts; a filtered session-index entry; and,
  only when requested, that session's file-history checkpoints.
- Codex: the selected rollout, its complete discoverable `history_base` chain,
  a filtered title entry, and a versioned thread-state record. Provider-private
  UI state has no guaranteed thread-scoped export and is explicitly reported
  as unsupported.
- Gemini: the chat plus session-addressable activity, tool, plan, task,
  artifact, and subagent files, together with a filtered project-root mapping.
  Provider-global databases are never copied.

Capture rejects traversal, symlinks, non-regular files, files that change while
being read, duplicate archive destinations, and missing required history-base
rollouts.

## Archive and recovery promises

`custody archive` creates this exact layout:

```text
manifest.json
metadata.json
providers/<provider-relative native subtree>
metadata/<provider>/<thread-scoped provider metadata>
annotations/<conversation-id>.json
SHA256SUMS
```

`custody import` verifies every declared file before reconstructing the
immutable custody version. The recovery metadata and annotation sidecar are
retained at the manifest-backed repository seam for the canonical source-store
integration to apply. This is the Mandible recovery promise.

Provider reinjection is a separate, weaker promise. `custody stage-restore`
first verifies custody, refuses if any corresponding provider target already
exists, and writes a collision-free staging tree plus `restore-plan.json`. It
does not modify the provider root. Every manifest reports `supported`,
`partial`, or `unsupported` capability and concrete limitations; current
Claude, Codex, and Gemini adapters are deliberately `partial` because their
providers do not guarantee native resume after external reinjection.

## CLI

```bash
mandible conversations custody status <conversation>
mandible conversations custody capture <conversation> [--rewind] [--mirroring]
mandible conversations custody verify <conversation> [--version VERSION]
mandible conversations custody archive <conversation> --destination PATH
mandible conversations custody stage-restore <conversation> \
  --staging-root PATH --provider-root PATH
mandible conversations custody import <archive-root>
```

All commands accept `--json`. Capture, verify, export, import, and restore
staging are operator mutations. The API exposes the same operations beneath
`/api/conversations/:id/custody`; raw custody bytes are never returned by an
API route.

## Compressed Codex sources

Codex `.jsonl` and exact `.jsonl.zst` siblings share one canonical raw-path
identity. Raw takes precedence whenever present, including when its content is
invalid. Discovery, parser snapshots, ingestion checkpoints, freshness probes,
source ranges, native-log inspection, and custody capture resolve storage through
`src/conversations/logical-source.ts`.

Offsets, record hashes, source SHA-256, source-version IDs, and captured rollout
bytes describe decompressed JSONL. Filesystem device/inode/ctime and mtime describe
the selected physical representation. Changing representation preserves the
content version; resumed content changes pass through ordinary ingestion.

Compressed content streams into an owner-only seekable cache under
`$XDG_CACHE_HOME/mandible/logical-sources` (default `~/.cache/mandible/logical-sources`). Publication
requires a stable provider descriptor, complete decoded hash, and native Codex
session header. Cache files are content-addressed and read-only. Every lease
revalidates current provider identity; removing provider bytes makes the source
unavailable even while its cache survives. Changed physical generations require
fresh decoding. Warm range reads retain record-hash verification without repeating
full decoding or hashing.

The shared cache writer serializes cold publication across daemon and ingestion
processes. The default decoded-source ceiling is 1 GiB; cached payloads share a
2 GiB disk quota with a 256 MiB free-space reserve. Active process leases prevent
eviction. Errors remain visible when a source or resource budget cannot be
verified. Native inventory uses explicitly unsealed bounded prefixes after
physical-metadata filtering, so listing a few recent logs does not decode all
cold history.

Custody captures and verifies Codex dependencies by streaming logical bytes to
canonical `.jsonl` archive paths. Its manifests remain compatible with existing
captures and preserve no-overwrite restore semantics. The seekable cache itself
never constitutes custody.

Co-Authored-By: Codex (GPT) <codex@openai.com>
