# Briefing ingest contract

Recurring Briefing publication is an authenticated agent boundary. It accepts
`briefing-ingest@1` and `briefing-ingest@2`; every object is validated against
the exact key set for its declared version. Unknown keys are rejected rather
than ignored, including v2 keys sent under v1.

## Publisher authorization

Publication requires a durable API token belonging to an active `agent` user.
Session credentials, human users, inactive users, and unmapped agents are
rejected identically over HTTP and file-RPC. Every stored publication records
the authenticated user ID.

The operator setting `briefing.ingest.publishers` is JSON with this exact
shape:

```json
{
  "agent-schedule": [
    {
      "task_identity": "agent-schedule/daily-digest",
      "sources": ["arxiv-scan"]
    },
    {
      "task_identity": "agent-schedule/task-health",
      "sources": ["task-health"]
    }
  ]
}
```

User slugs, task identities, and source names match exactly. Prefixes and
wildcards have no meaning. A blank, malformed, partially malformed, or
unknown-key setting override fails the whole override closed. Before a batch
writes anything, every distinct item source must be allowed by one binding.

An independent code-owned task gate admits only
`agent-schedule/daily-digest` and `agent-schedule/task-health`. Deployed task
bundles cannot widen this gate.

## Version 1

The v1 request keys are `schema`, `task_identity`, `run_id`, `digest`,
`batch_key`, and `items`. Its digest object contains only `series_ref` and
`version`. A v1 item contains only `candidate_key`, `source`, `ref`, `title`,
`why_notable`, `refs`, `evidence_hash`, `evidence_kind`, `captured_at`, and
`rank`. Existing v1 revision JSON remains encoded and decoded as v1.

## Version 2 groups and advisories

V2 has the same request and digest keys. Its item key set adds `item_kind`,
`parent`, and `publisher_advisory`.

- `item_kind` is `item` (the default) or `group`.
- A group is top-level and has no parent.
- An item's `parent`, when present, is the exact `candidate_key` of a group in
  the same source collection. A group cannot contain another group, and a leaf
  cannot be a parent.
- Leaf response type remains `verdict`. Groups have no response type.
- `publisher_advisory`, when present, is exactly
  `{"code":"admission_gate_rejected","reason":"..."}`.

Advisories are immutable publisher metadata on the item revision. They never
create `feedback_response_events`, never decide an item, and every leaf arrives
pending for a human decision. The UI labels the advisory as publisher-reported
and places advisory items in a collapsed, explicitly untrusted quarantine.

## Replay identity

The server computes SHA-256 over the parser-reconstructed request. Replay
identity is `(authenticated publisher user, exact task_identity, batch_key)`.
The same identity and digest returns the original result without writing;
the same identity with a different digest returns `409`. The replay check,
request ledger insert, publications, items, revisions, and stored result execute
in one SQLite immediate transaction.
