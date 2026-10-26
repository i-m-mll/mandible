# Native mutation origin

Ledger mutations retain an available native session as `request_origin`:

```json
{"provider":"codex","provider_session_id":"native-thread-id"}
```

Origin is claimed provenance. It does not authenticate a caller, identify the
human operator, authorize an effect, or change the recorded actor or credential.
Two native sessions using the same credential remain distinguishable. Missing,
invalid, conflicting, and historical unknown origins remain unknown.

The router captures origin once for each handler dispatch from the normalized
ambient transport identity. The local socket can also resolve an exact registered
session or managed-console native binding. Conflicting exact bindings produce
unknown origin. The daemon never supplies its launch environment as a caller's
identity. HTTP, local socket, file-RPC, and internal router dispatch use the same
context. A request without origin clears any enclosing request context.

`src/request-origin.ts` owns the contract. `currentRequestOrigin()` reads the
current optional envelope. `withRequestOriginMetadata(metadata)` replaces the
reserved `request_origin` metadata field; caller payloads cannot supply it.
`requestOriginJson()` supplies the same envelope for authoritative records with
a dedicated nullable JSON column. `requestOriginFromMetadata(metadata)` reads
existing JSON metadata without inferring missing identities.

Common `ledger_events.payload_json` and `ledger_body_revisions.metadata_json`
retain origin in the transaction that records the mutation. Revision reads,
ledger change-feed records and generic ledger-event SSE messages expose
`request_origin`. Existing event payload reads retain the same envelope.
No second audit journal or historical backfill is used.

For entities whose authoritative changes use the common event boundary,
`LedgerStore.recordEvent()` accepts a nullable or omitted `project_id`.
Unscoped changes remain in `ledger_events` and do not enter any project's
change feed. Never invent a project sentinel. Enclose the actual mutation and
`recordEvent({ ...input, notify: false })` in one database transaction, then call
`store.notifyEvent(event)` after that transaction commits. It refuses publication
while a transaction is still open. Mutation payloads identify the operation,
changed field names and actual owner IDs; they need not copy bodies or secrets.

Durable tasks must capture and serialize `currentRequestOrigin()` when enqueued,
then enter `withRequestOrigin(savedOrigin, action)` when executing. Record the
actual executing actor separately. Async-local context propagates within a
request but does not replace persistence across queue boundaries or restarts.

The existing Claude lifecycle hook installation invokes `hooks/session-start.sh`.
Hooks use the exact native `.session_id` payload, clear inherited provider
markers, and SessionStart writes the ID to `CLAUDE_ENV_FILE` for subsequent Bash
commands. A nested session also clears an inherited Mandible wrapper ID when it
belongs to another process. Managed launches project only an actual resumed
native ID or the Claude SDK's reserved native UUID. No per-command session flag
or manual issue/session link is needed.

Co-Authored-By: Codex (GPT) <codex@openai.com>
