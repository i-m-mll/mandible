# Task disable command protocol

Issue `548bd73`. This is the publisher-facing contract for Mandible's first
task-control command. It defines one verb, `disable`; it does not define
`enable`, task execution, or executor-side application.

## Authority and lifecycle

Mandible records operator intent; the addressed executor records what happened
locally. A command is not a mutable task flag.

```text
requested -> accepted -> applied
    |            `----> rejected
    `-----------------> cancelled
```

- `requested`: the local operator durably recorded a disable request. It has
  not been acknowledged by the executor.
- `accepted`: the authenticated executor validated the address, task, verb,
  and payload and durably journaled the command locally.
- `applied`: the executor reports that its normal local mutation path left the
  task disabled. `no_op: true` means it was already disabled.
- `rejected`: a permanent refusal with a closed-vocabulary reason. Transport,
  unreadable-state, and transient database failures are not rejections; the
  command stays accepted and is retried.
- `cancelled`: the operator withdrew a request before executor acceptance.

Disable requests never expire. Requests are immutable and events are
append-only; lifecycle is projected from those records.

## Authentication

Creation, listing, and cancellation require the configured local operator.
Executor polling and event submission require all of:

1. a durable API token (ephemeral/session credentials are refused);
2. an active `agent` user;
3. an exact user-slug to executor-name mapping in
   `tasks.inventory.executors`.

The authenticated principal is persisted on every request or event. The same
boundary applies to bearer HTTP and file-RPC capability tokens. File RPC is
allowed only for executor polling and event submission, not operator actions.

## Operator routes

`POST /api/tasks/commands`

```json
{
  "schema": "task-command@1",
  "request_key": "operator-generated-idempotency-key",
  "executor": "agent-schedule",
  "task_id": "daily-digest",
  "verb": "disable",
  "payload": {}
}
```

Every object uses an exact key set. `payload` must be empty in v1. Replay of
the same operator, `request_key`, and canonical body returns the original
command with `stored: false`; the same key with a different body returns `409`
`request_key_conflict`.

`GET /api/tasks/commands?executor=<name>&task_id=<id>` lists commands for the
operator Tasks UI. `POST /api/tasks/commands/:id/cancel` appends cancellation
only while the command is requested; cancellation after acceptance returns
`409` `cancel_after_accept_refused`.

## Executor routes

`GET /api/tasks/commands/pending?executor=<exact-name>` returns requested and
accepted commands. Fetching is tick-aligned: executors poll once per scheduler
tick, before due work. There is no long poll. Accepted commands remain in this
response until an applied or rejected receipt is durable, permitting retries
after transient local failures. The pending safety queue is complete rather
than page-limited, so an older disable cannot be hidden by newer requests.

`POST /api/tasks/commands/:id/events` accepts one of these exact bodies:

```json
{"schema":"task-command-event@1","event":"accepted","event_digest":"<sha256>"}
{"schema":"task-command-event@1","event":"applied","no_op":false,"event_digest":"<sha256>"}
{"schema":"task-command-event@1","event":"rejected","reason":"unknown_task","event_digest":"<sha256>"}
```

Rejection reasons are exactly `unknown_task`, `unsupported_verb`,
`invalid_payload`, `stale_target`, `policy_refused`, or `unknown`.

The event digest is lowercase SHA-256 of UTF-8 `JSON.stringify` bytes for the
following insertion-ordered canonical object (compact JSON, no whitespace):

```text
accepted: {"command_id":"<id>","event":"accepted"}
applied:  {"command_id":"<id>","event":"applied","no_op":<boolean>}
rejected: {"command_id":"<id>","event":"rejected","reason":"<reason>"}
```

The server recomputes and verifies the digest. Reposting the same event returns
the original projection with `stored: false`. A different terminal result
returns `409` `terminal_event_conflict`. Applied or rejected before accepted
returns `409` `command_not_accepted`.

## UI wording

The Tasks view says that command fetching is tick-aligned and may take up to
one scheduler tick. It renders requested as "Requested, not yet seen by
executor" and never presents requested or accepted as applied.
