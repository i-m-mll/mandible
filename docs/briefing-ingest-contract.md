# Briefing run publication contract

Recurring publication is an authenticated origin and run-policy boundary for
the one Briefing model. It does not create a separate product kind, renderer,
or response lifecycle. `POST /api/briefings/runs` accepts exactly
`mandible-briefing-run@1`; unknown fields fail closed.

## Publisher authorization

Publication requires a durable API token belonging to an active `agent` user.
Session credentials, human users, inactive users, and unmapped agents are
rejected. The operator setting `briefing.ingest.publishers` retains its exact
publisher, task-identity, and source allowlist shape. Prefixes and wildcards
have no meaning.

## Request

The top-level fields are:

- `schema`, `briefing_key`, `title`, `task_identity`, `run_id`, and `run_key`
- a non-empty `responder_user_ids` array of active human user IDs
- `evidence`: exact `series_ref`, non-negative `version`, and SHA-256 `digest`
- `source_health`: `source`, `status` (`healthy`, `degraded`, or `unavailable`),
  nullable `detail`, and integer `observed_at`
- exactly one of `document: { markdown }` or nonblank `quiet_reason`
- optional `occurrences`, each containing a document `directive_key`, SHA-256
  `evidence_digest`, integer `occurred_at`, and object `metadata`

A document must parse as `mandible-briefing.v1`. Every occurrence key must name
a directive in that exact document. A quiet run cannot contain occurrences.

## Identity and immutable binding

`briefing_key` resolves the stable logical Briefing. A document-bearing run
creates an immutable round and pins the exact managed artifact version,
directive definitions, and round-specific directive instances. Identical
Markdown may reuse artifact content identity while still creating a new round;
changed prose or directive definitions produce a new artifact version before
the round is bound.

Quiet runs store authenticated publisher, task, replay, evidence, and
source-health provenance without inventing a human-facing round. A Briefing
that has no round yet, such as a feed whose runs have all been quiet, is left
out of `GET /api/briefings` and of bundle layouts until its first round is
published. Archive and restore still reach it by its stored id.

## Replay and receipt

The server computes SHA-256 over the canonical parsed request. Replay identity
is `(authenticated publisher user, task_identity, run_key)`. The same identity
and digest returns the original receipt; a different digest returns `409`.
Publication, artifact and round binding, occurrences, and the stored receipt
commit in one immediate transaction.

The receipt contains `receipt_id`, `briefing_id`, publisher `run_id`, nullable
`round_id`, nullable `artifact_version_id`, and `quiet`.

## Response lifecycle

Human answers and annotations are actor-scoped events on one exact round.
Submissions freeze the exact effective event membership. Corrections supersede
an actor's prior submission without mutation; responses never carry forward to
a later round.
