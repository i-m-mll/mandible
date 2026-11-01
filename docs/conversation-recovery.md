# Conversation recovery

Conversation text comes from provider-native transcripts or verified native custody copies. The ledger preserves conversation and session identity, user annotations, relationships, source bindings and custody evidence. Navigation and full-text search indexes are disposable. Sparse `cblk` anchors identify conversation positions; provider-native message identifiers remain the anchors for provider resume operations.

Restore a supported metadata backup (including schema 224) into a new database.
The restore applies the same forward migrations as startup:

```sh
mandible conversation-recovery restore \
  --metadata-sql /absolute/path/mandible-metadata.sql \
  --destination /absolute/path/recovered.db \
  --limit 50
```

The destination must not exist. Restoration preserves backed-up metadata, checks foreign keys, then invokes normal provider discovery and reconciliation through the ingestion actor. It uses the current user's configured source roots. It does not reconstruct provider transcripts from retained normalized bodies, take custody automatically, or modify provider originals. Native sources outside those roots remain unavailable until normal source discovery can locate them.

Inspect source readiness and verify native bytes for a bounded page:

```sh
mandible conversation-recovery inspect \
  --db /absolute/path/recovered.db --offset 0 --limit 50
```

Both commands print JSON. Inspection caps each page at 500 conversations and reports `truncated` when further pages remain. Missing or unsupported content is reported as unavailable; it is never represented as an empty transcript. Current sources with historical unsealed version metadata are resealed by normal reconciliation. Historical source identities and version evidence remain in the ledger.

Migration 226 removes retired normalized body rows, dense canonical navigation, old message-ID aliases, parser checkpoints and the navigation-kind discriminator. Historical retained-record exports are backups, not reconstructed provider originals.

Co-Authored-By: Codex (GPT) <codex@openai.com>
