# Conversation cutover proof tool

`mandible conversation-cutover` is the non-destructive proof surface for the
source-backed conversation migration. It does not change the default reader,
delete legacy bodies, modify the source database, or claim adapter support from
the source, cache, or custody lanes.

## Commands

```bash
mandible conversation-cutover rebuild \
  --source /explicit/source.sqlite \
  --destination /explicit/fresh.sqlite \
  --json

mandible conversation-cutover restore-drill \
  --metadata-sql /explicit/metadata.sql \
  --custody-root /explicit/custody-archive \
  --destination-root /explicit/empty-restore-root \
  --json

mandible conversation-cutover audit \
  --source /explicit/source.sqlite \
  --evidence /explicit/adapter-evidence.json \
  --rebuild-report /explicit/rebuild-report.json \
  --restore-report /explicit/restore-one.json \
  --restore-report /explicit/restore-two.json \
  --json
```

The rebuild refuses the source path, same-file aliases, both known production
database aliases, an existing destination, and an unowned partial file. An
interrupted run leaves a marker naming its partial output; the next run removes
only that partial and rebuilds from the unchanged source. Tables matching the
source-backed cache/search naming contract are excluded. Additional cache
tables can be named with repeated `--exclude-table` arguments.

The restore drill executes a metadata SQL backup in a fresh SQLite database,
checks integrity and foreign keys, verifies every `SHA256SUMS` entry, rejects
absolute/traversal/symlink/non-file or unlisted inputs, then copies and re-verifies custody
without consulting provider roots. Its destination must not exist, which makes
provider-file collision overwrite impossible. Two independent passing drill
reports are required by the audit.

## Adapter evidence packet

The audit consumes one JSON object. This is the integration seam for sibling
lanes; absent or incomplete evidence fails closed.

```json
{
  "conversation_evidence": [
    {
      "conversation_id": "durable-id",
      "classification": "verified-live-source",
      "verified": true,
      "projection": {
        "identity": {
          "id": "durable-id",
          "source": "codex",
          "session_id": "provider-id",
          "parent_conversation_id": null,
          "is_sidechain": 0,
          "agent_id": null
        },
        "blocks": [
          {
            "id": "durable-block-id",
            "type": "message",
            "role": "user",
            "content_sha256": "hex-sha256",
            "metadata": {},
            "position": 0,
            "parent_id": null,
            "dag_uuid": null,
            "dag_parent_uuid": null
          }
        ],
        "annotations": [],
        "relationships": []
      }
    }
  ],
  "search": {
    "adapter_verified": true,
    "comparisons": [
      { "query": "x", "legacy_results": ["block-id"], "source_results": ["block-id"] }
    ]
  },
  "performance": {
    "cold_detail": { "p95_ms": 1, "budget_ms": 2, "peak_rss_bytes": 1, "rss_budget_bytes": 2 },
    "hot_detail": { "p95_ms": 1, "budget_ms": 2, "peak_rss_bytes": 1, "rss_budget_bytes": 2 },
    "cold_search": { "p95_ms": 1, "budget_ms": 2, "peak_rss_bytes": 1, "rss_budget_bytes": 2 },
    "hot_search": { "p95_ms": 1, "budget_ms": 2, "peak_rss_bytes": 1, "rss_budget_bytes": 2 }
  },
  "gates": {
    "locator_refresh": { "pass": true, "adapter": "source-adapter-version", "evidence": {} },
    "security_redaction": { "pass": true, "adapter": "cache-adapter-version", "evidence": {} },
    "rollback_kill_switch": {
      "pass": true,
      "adapter": "runtime-version",
      "evidence": {
        "retention_days": 31,
        "legacy_database_verified": true,
        "kill_switch_tested": true,
        "default_reader_unchanged": true
      }
    }
  }
}
```

Valid coverage classes are `verified-live-source`,
`verified-managed-custody`, and `legacy-body-only`. A conversation with no
verified adapter evidence is classified as `legacy-body-only` only while at
least one legacy block remains. Verified source/custody projections compare
stable conversation identity, block identity/type/role/content hash/metadata,
order and DAG fields, annotations, and relationships. Exact search result
arrays compare in returned order.

The audit returns one deterministic JSON result with `decision`, `pass`, and
`failed_gates`. A landing report of `NO-GO` is the expected result until every
external adapter gate, compact rebuild, performance budget, and both restore
drills have supplied passing evidence.

---
Co-Authored-By: Codex (GPT-5) <codex@openai.com>
