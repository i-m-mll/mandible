# Codex child-chat archive capability

The existing independent app-server client provides a demonstrated standalone
route for shared stored turn history, empty-queue reads, same-ID restoration
and archival of the disposable fixture. It requires no caller-chat
impersonation or direct owning-desktop IPC. An agent-context desktop bridge
also successfully archived and restored a loaded-idle fixture. The native
adapter reports explicit outcomes to the local archive policy. Both the CLI adapter and the
bundled independent app-server failed to archive the desktop-loaded idle
fixture; the latter explicitly rejected its active writer. Pending-input
coverage for a nonempty desktop queue remains unproved. Standalone reads and
unloaded-thread effects work, but the measured cross-process archive effects
cannot archive a thread while the desktop owns its writer.

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

### Existing independent client and execution hooks

A bounded read-only probe used the existing
`CodexAppServerClient.connect()` with its default bundled desktop executable,
spawning independent stdio app-server PID 79338. It issued no start, resume,
archive, unarchive or queue mutation, and closed with exit code 0.

- `thread/read` returned the disposable fixture's actual archived rollout path
  and paginated history mode. Its `notLoaded` status describes this independent
  server and is not evidence of desktop idleness.
- `thread/turns/list`, descending with a page size of 10, returned all three
  desktop-created turns from the table above, with their exact statuses,
  start/end timestamps and durations. `nextCursor` was null. Shared persisted
  turn-history access is therefore demonstrated through Mandible's existing
  daemon-compatible boundary without caller-chat impersonation or owning IPC.
- `thread/queue/list` rejected this archived fixture with an instruction to
  unarchive first. It returned no queue data. This proves the request reaches
  the fixture lookup, but does not establish shared pending-input visibility
  for a loaded, unarchived desktop chat.

A subsequent expressly authorized fixture-only probe used the same existing
client boundary, independent stdio app-server PID 83488:

| Public native operation | Result |
| --- | --- |
| `thread/unarchive({threadId})` | Restored the exact fixture ID to its `sessions/2026/10/26` path; returned process-local notLoaded. |
| `thread/read({threadId, includeTurns:false})` | Same ID and restored path; process-local notLoaded. |
| `thread/turns/list({threadId, limit:10, sortDirection:"desc", itemsView:"notLoaded"})` | Same three desktop-created turns and original start/end times; nextCursor null. |
| `thread/queue/list({threadId, limit:10})` | Empty data and nextCursor null. |
| `thread/archive({threadId})` | Success with an empty result; restored the fixture to archive custody. |

The server closed with code 0. A read-only native flag/path probe confirmed
`archived=1` and the original archived rollout path. This probe issued no
`thread/resume`, `turn/start`, user input, queue mutation or model turn.
It establishes a legitimate standalone history/empty-queue/restore/archive
boundary. It does not establish visibility of a nonempty desktop queue, nor
the archive effect while a different runtime retains a loaded writer.

The installed Codex hooks register SessionStart, UserPromptSubmit, Stop,
Interrupt and SessionEnd through Mandible's existing execution hook. The exact
fixture's `provider_session_execution` row records `codex_hook` SessionEnd at
1793034940060, state ended with reason other. The mapping treats a submitted
prompt as working, Stop as stopped, Interrupt as interrupted, SessionStart as
unknown and SessionEnd as ended. Atomic hook outbox entries carry exact
session/optional turn identity and observation time; the daemon drains them
in order and supersedes older observations.

That execution store retains the latest observation rather than a full event
history. Its stopped/ended row can corroborate current evidence, but cannot
alone exclude missed subsequent input or reconstruct the idle interval.
Native turn history supplies interval evidence; fresh hook/outbox
reconciliation can contribute current-state evidence. A managed controller
provides its own exact execution observation. These facts do not require any
change to global holder liveness.

The existing archive implementation invokes the independent `codex archive`
and `codex unarchive` CLI commands. The existing app-server client itself
currently has a typed unarchive request but no archive/turn-history/queue
request entries; the read-only probe exercised the public methods directly.
The native archive and restore requests succeeded for the fixture through that
same client boundary.

### Existing CLI adapter with a desktop-loaded idle fixture

An expressly authorized test restored the same fixture through the owning
desktop tool, then opened that fixture with the app's navigation tool. Opening
it loaded it without input or a new turn. Owning `wait_threads` reported idle
with the same prior interrupted turn; `lsof` confirmed desktop app-server PID
68080 held the exact fixture writer-lock descriptor (FD 377).

The exact existing `new CodexCliThreadArchiver().archive(threadId)` invocation
failed. It executes PATH `codex` version 0.160.0; the returned error was
`Command failed: codex archive ...` followed by `Error: failed to archive
session`. This test establishes failure of that adapter under the measured
condition, without establishing its internal cause.

While that fixture remained desktop-loaded and idle, a new independent
bundled app-server (PID 33780) successfully read `thread/queue/list`: empty
data, nextCursor null, then closed with code 0. Loaded-thread empty-queue
reads therefore work across this existing API boundary. Visibility of a
nonempty desktop queue was not exercised.

The supported owning desktop archive tool then archived the idle fixture for
cleanup, and app focus returned to the worker chat. No model turn, new input
or active-turn archive test was performed.

### Bundled independent native archive with a desktop-loaded idle fixture

A separately authorized, once-only test exercised the bundled
0.163.0-alpha.10.2 app-server's distinct `thread/archive` effect. The same
fixture was restored and opened without input. Immediately before the call,
owning `wait_threads` reported idle with the unchanged prior turn
`01a17935-d371-7e90-93e4-5bd82649228d`; desktop PID 68080 held its exact
writer-lock descriptor (FD 76).

The existing `CodexAppServerClient` spawned independent stdio server PID
42269. Its `thread/archive({threadId})` request rejected with:

> thread 01a17935-2e1a-77c0-b8ba-6f011db56615 already has an active writer

The independent server closed with code 0. After rejection, owning status was
still idle on the same unchanged turn; a read-only native probe returned
`archived=0` and the original `sessions/2026/10/26` path. The supported
owning desktop tool archived the idle fixture for cleanup, and app focus
returned to the worker chat. No new turn or input was submitted.

This establishes a concrete cross-process writer-ownership restriction on
the independent native effect, even for a proven desktop-idle thread. It is
separate from residual check-then-archive race policy and does not justify
reclassifying writer ownership as active execution. A Mandible-local chat
archive projection is a separate effect that can implement local visibility
policy without claiming the rejected Codex-native operation succeeded.

### Direct desktop bridge

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

`CodexNativeArchiveAdapter` uses the existing bundled app-server public API.
Archive returns `archived`, `already_archived`, `deferred` with reason
`desktop_writer_owned`, or `failed` with a reason. Success requires exact
native identity and verified native archive location. Restore returns
`restored`, `already_restored`, or `failed`; the managed controller uses the
same restore helper before resuming the original ID. Queue reads distinguish
known pending/empty from unknown, including incomplete pages and native errors.
Eligibility, canonical selected-ingestion freshness, local visibility and
scheduling remain the caller's responsibility. Native deferral does not erase
Mandible-local archive state or claim native success.

The [official app-server archive contract](https://learn.chatgpt.com/docs/app-server#archive-a-thread)
accepts a thread ID and attempts to archive spawned descendants. Individual
descendant failure can coexist with overall success, with notifications for
threads actually archived. Descendant effects were not exercised here. An MCP-created
child marker alone would not establish the provider's spawned-descendant
effect set.

The existing independent API supplies a legitimate daemon boundary, without
borrowing or inventing an agent executor identity. Its shared native history
and execution-hook evidence support the practical workflow; direct owning IPC
is not mandatory. The measured loaded-writer restriction prevents the
independent native effect from implementing desktop cleanup while the desktop
owns the writer. Assessment of a legitimate owning-runtime effect or a
Mandible-local visibility projection must preserve this distinction.
Reconcile fresh
continuous-activity history and current execution/queue evidence, then archive.
Review the remaining input/effect race proportionately to this recoverable
visibility operation. Verify a single-thread effect or the complete effect
set so autonomous/successor descendants can be excluded. Resume dispatch must
restore the original ID before input; the measured external follow-up path
does not do that automatically.

Do not substitute a separate app-server's notLoaded status, a writer lock, or
Mandible's cached liveness for owning-runtime evidence. Do not change global
holder liveness to make loaded desktop threads appear stopped. Provenance work
can proceed independently of this archive capability.

Co-Authored-By: Codex (GPT) <codex@openai.com>
