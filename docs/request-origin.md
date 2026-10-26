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

An explicit `request_origin` transport field takes precedence over native
ambient capture. The CLI forwards `MANDIBLE_REQUEST_ORIGIN` JSON through
`X-Mandible-Request-Origin` on HTTP/local socket requests and `request_origin`
on file-RPC requests. This channel supplies metadata only: it does not enter
agent enrollment, managed-client detection, credential selection or attribution.
An explicit null or malformed envelope produces unknown origin without falling
back to ambient identity. Omitting the field preserves native ambient capture.
Child processes overwrite inherited `MANDIBLE_REQUEST_ORIGIN` with their saved
initiating envelope, including the literal `null` when origin is unknown.

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

## Authored Spaces and conversation metadata

| Canonical boundary | Origin history | Verification |
| --- | --- | --- |
| Space create/edit/delete; item membership and metadata | `ledger_events`: `space`, `space_item` | `test/authored-origin.test.ts` covers create/edit/delete, idempotent membership and unknown origin. |
| Occurrence positioning, batches, edges and predicate seeding | `ledger_events`: `space_occurrence`, `space_edge`; shared storage helpers | Authored structure sequence and existing Spaces route tests cover actual changes and transactional batches. |
| Block content/tree changes, detach and deletion | `ledger_events`: `space_block` | Authored structure sequence checks rollback, failed history insertion and notification after outer commit. |
| Managed, Git and historical document import | Space/block events inside the import transaction | Publication tests verify imported origins and rollback without an orphan Space or history. |
| Publication preparation, worktree/commit/version changes and auth binding | `ledger_events`: `space_publication`; destination checkout owns the project feed | Publication and auth-publication tests verify native origin, frozen content, partial progress and atomic binding. |
| Conversation tags, notes, star and archive state | `ledger_events`: `conversation_metadata` | Metadata tests cover authenticated authority, distinct native sessions, no-op/failure and reservation archive/unarchive. |

Events contain entity/owner identifiers, operation and changed field names. Bodies,
titles, tags, notes, embedded snapshots and publication content are compared only
in memory. Existing legacy document history retains its original provenance;
migration does not identify a historical author from the current request.

Conversation archive state remains `conversation_archive_states`, including
accepted spawn reservations. Archive does not delete transcript content. The
existing metadata route emits `conversation:updated` with `archived_at` after
commit. `setConversationArchiveState` in `src/conversations/metadata.ts` shares
this boundary with PATCH and accepts an exact canonical/reservation ID,
`archived`, and a `manual`, `retention`, `resolved-worker`, or `observed-provider`
cause. Its event retains the archive action and cause even after unarchive.
No-op actions leave the marker, history and notifications unchanged.
Provider transcript ingestion, index reconciliation, FTS/cache updates,
telemetry, local view preferences and filesystem-only document exports do not
create authored-content history.

Publication subprocesses clear inherited daemon provider markers. A claimed
request origin is not projected as a subprocess's agent enrollment identity.
Their initiating envelope travels through the independent metadata-only channel;
existing explicit credentials retain authority over downstream CLI writes.

Co-Authored-By: Codex (GPT) <codex@openai.com>
