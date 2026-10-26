# Codex child-chat archive capability

The supported standalone daemon-to-owning-desktop transport is **unestablished**.
The installed runtime has native status, turn-history, queue, archive and
restore operations, and an agent-context desktop bridge successfully archived
and restored a disposable loaded-idle chat. This investigation has not
demonstrated a supported way for Mandible's standalone daemon to use those
operations against that same owning desktop. No adapter or automatic archive
effect is enabled.

A fresh history, status and queue check followed by archive is the selected
practical visibility workflow. Atomic conditional archival is not required.
Archiving an active fixture interrupted its turn, which establishes the
residual race risk for ordinary merge review; it does not independently block
that workflow.

## Environment

Measured on 2026-10-26 at 13:14–13:16 America/Toronto, for issue `b14e168`
under `8290dca`, against Mandible base `3a22c5ac`.

- Owning desktop: ChatGPT PID 67929, app-server PID 68080, bundled Codex CLI
  `0.163.0-alpha.10.2`. The PATH CLI reports `0.160.0`.
- Both installed CLIs expose `app-server proxy --sock`. The default
  `~/.codex/app-server-control/app-server-control.sock` does not exist;
  `codex app-server proxy` and `codex app-server daemon version` fail with
  ENOENT. The owning app-server's Unix socket descriptors have unnamed peers;
  no attachable app-server listener was demonstrated. Starting a separate
  daemon would not establish ownership of desktop turns.
- The desktop exposes the installed `codex-app-tools` MCP bridge through
  `CODEX_APP_TOOLS_PIPE_PATH`. Its supported tools include `wait_threads`,
  `set_thread_archived`, and `send_message_to_thread`. The measurements below
  use those tools against the owning desktop, rather than a separate server.
  The bridge's request protocol carries executor thread/turn metadata; this
  investigation does not establish a standalone daemon API for it.
- Installed `app.asar` SHA-256:
  `5ddc4e48259aa6f979e04529b1a5a4ae54b0f5c4ad6db5c6e004924c10916ddb`.
- Installed `codex-app-tools/0.1.6/server.mjs` SHA-256:
  `8f27bf615fdf972cdaaf06b6b909edb24d63e4493938bd75a04ad94e812270f3`.

## Disposable fixture

Only fixture thread `01a17935-2e1a-77c0-b8ba-6f011db56615` was archived or
restored. It was created expressly for this test, with child lineage to worker
`01a17932-d491-7e12-9c10-99ecf2b47ff6`, in a new projectless output directory.
No pre-existing chat was affected. Native SQLite row reads were limited to
that fixture's archive flag and rollout path. Subsequent read-only schema
inspection examined native thread and queue table definitions without reading
user queue contents.

| Operation | Owning-runtime observation |
| --- | --- |
| Initial fixture response | `FIXTURE_IDLE`; turn `01a17935-2f70-70a2-950d-b77c7e18a918` completed; thread idle. |
| `set_thread_archived({threadId, archived:true})` | Succeeded. Native `threads.archived=1`, rollout in `archived_sessions`. |
| `send_message_to_thread` while archived | Rejected: session is archived and must be unarchived first. No automatic restore. |
| `set_thread_archived({threadId, archived:false})`, then follow-up | Same thread completed `FIXTURE_RESUMED`, turn `01a17935-a2e5-73d0-a630-e81618ec959f`. Prior transcript remained present. |
| Follow-up requesting a 30-second `clock.sleep` | `wait_threads` reported active/inProgress, turn `01a17935-d371-7e90-93e4-5bd82649228d`. |
| Archive that active fixture | Returned `archived:true`. Next owning snapshot reported notLoaded and that same turn interrupted after 6,908 ms. Native archive flag was 1. |

The retained fixture rollout independently records the interruption:

- Ordinal 37, 17:15:33.110 UTC: task started for the active fixture turn.
- Ordinal 43, 17:15:37.038 UTC: `clock.sleep` invoked with 30,000 ms.
- Ordinal 45, 17:15:39.978 UTC: sleep output reports abortion after 2.9 seconds.
- Ordinal 48, 17:15:40.019 UTC: `turn_aborted`, reason interrupted, duration
  6,908 ms, same turn ID.

The fixture remains archived with its transcript retained. This is the
authorized fixture cleanup, not a production cleanup policy.

## Native activity and queue evidence

The installed desktop CLI's `app-server generate-json-schema --experimental`
exports the following operations. Schema generation starts no server and
does not establish a connection to the owning desktop.

- `thread/read({threadId, includeTurns?})` returns current runtime status;
  `includeTurns` is deprecated for paginated history. Status distinguishes
  active, idle, notLoaded and systemError. Active flags include approval and
  user-input waits.
- `thread/turns/list({threadId, cursor?, limit?, sortDirection?, itemsView?})`
  returns `data`, `nextCursor` and `backwardsCursor`, descending by default.
  A turn has an ID, status and nullable `startedAt`, `completedAt`,
  `durationMs` and `rootTurnId`. Timestamps are Unix seconds. A fresh history
  read detects execution that started and completed between two idle
  snapshots. A terminal time before the retention cutoff with no later turn
  supports inactivity over that interval with respect to recorded turns;
  missing timestamps or incomplete history cannot supply that evidence.
- `thread/queue/list({threadId, cursor?, limit?})` returns queued submissions
  and a next-page cursor. Each submission has `id`, `clientUserMessageId`
  and `input`. The response supplies no queue revision or timestamp.
- Notifications include `turn/started`, `turn/completed`,
  `thread/status/changed` and `thread/queue/changed`. A connected owning
  stream can trigger reconciliation; reconnection needs fresh history and
  queue reads. A complete replay cursor has not been established.

Native rollouts also retain timestamped, ordered `user_message`,
`task_started`, `task_complete` and `turn_aborted` events. Mandible already
projects these lifecycle records with their provider turn IDs. A rollout
ordinal is an event-history position, not a proven universal input generation.
Generic thread `updatedAt` and recency fields describe updates or ordering,
not specifically meaningful input.

Read-only inspection found native `queue_1.sqlite` tables
`queued_items(id, thread_id, payload_json, queue_order, created_at_ms,
updated_at_ms)` and `queued_thread_revisions(revision, thread_id)`. These
are internal records. All-input coverage and revision behavior for every
queue mutation have not been verified, so they do not establish a supported
daemon queue API.

## Standalone transport verdict

The installed app-tools MCP wrapper obtains its socket from
`CODEX_APP_TOOLS_PIPE_PATH`. Requests use length-prefixed JSON-RPC frames.
Its `tools/call` resolves a caller chat ID from `--interaction-client-id` or
executor metadata and rejects calls without it. The caller chat ID is
separate from the target chat ID in tool arguments.

The native bridge call schema requires `arguments`, `callerSource`
(`codex` or `chatgpt`), `callId`, `namespace`, caller `threadId`, `tool`
and `turnId`, with an optional/defaulted host. There is no daemon/system
caller kind or caller-free call variant in the inspected schema. Turn and
call IDs may be generated by the MCP wrapper, so an authenticated active-turn
requirement is not established. Caller-free `tools/list` exists. The desktop
creates an owner-only randomized socket and can apply macOS peer
authorization; neither mechanism establishes a standalone daemon identity
contract.

The exposed `wait_threads` tool provides owning desktop status, latest turn
and tool markers. Its contract does not expose the native queue-list operation
or a complete history/queue generation. Agent-context status and fixture
archive/restore are demonstrated; a legitimate standalone daemon path for the
whole status/history/queue plus archive/restore workflow is not.

The desktop parent's `~/.codex/ipc/ipc.sock` was observed as a listener.
No documented daemon operation or protocol for that socket was established.
No broader control-plane search or additional archive fixture was performed.
The verdict is **unestablished**, not technically impossible.

## Effect scope and implementation conditions

The [official app-server archive contract](https://learn.chatgpt.com/docs/app-server#archive-a-thread)
accepts a thread ID and attempts to archive spawned descendants. Individual
descendant failure can coexist with overall success, with notifications for
threads actually archived. Descendant effects were not exercised here. An MCP-created
child marker alone would not establish the provider's spawned-descendant
effect set.

Implementation awaits a supported owning-runtime daemon attachment/API,
without borrowing or inventing an agent executor identity. Through that
boundary, reconcile fresh continuous-activity history and current status/queue,
then archive. Review the remaining input/effect race proportionately to this
recoverable visibility operation. Verify a single-thread effect or the complete
effect set so autonomous/successor descendants can be excluded. Resume dispatch
must restore the original ID before input; the measured external follow-up
path does not do that automatically.

Do not substitute a separate app-server's notLoaded status, a writer lock, or
Mandible's cached liveness for owning-runtime evidence. Do not change global
holder liveness to make loaded desktop threads appear stopped. Provenance work
can proceed independently of this archive capability.

Co-Authored-By: Codex (GPT) <codex@openai.com>
