# Codex child-chat archive capability

Automatic archival through the installed owning desktop runtime is blocked:
its supported archive operation interrupts an active turn. Checking idle state
before calling that operation cannot preserve input arriving between the check
and the effect. No adapter or automatic archive effect is enabled by this
investigation.

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
No pre-existing chat was affected. Native SQLite was opened read-only solely
to verify that fixture's archive flag and rollout path.

| Operation | Owning-runtime observation |
| --- | --- |
| Initial fixture response | `FIXTURE_IDLE`; turn `01a17935-2f70-70a2-950d-b77c7e18a918` completed; thread idle. |
| `set_thread_archived({threadId, archived:true})` | Succeeded. Native `threads.archived=1`, rollout in `archived_sessions`. |
| `send_message_to_thread` while archived | Rejected: session is archived and must be unarchived first. No automatic restore. |
| `set_thread_archived({threadId, archived:false})`, then follow-up | Same thread completed `FIXTURE_RESUMED`, turn `01a17935-a2e5-73d0-a630-e81618ec959f`. Prior transcript remained present. |
| Follow-up requesting a 30-second `clock.sleep` | `wait_threads` reported active/inProgress, turn `01a17935-d371-7e90-93e4-5bd82649228d`. |
| Archive that active fixture | Returned `archived:true`. Next owning snapshot reported notLoaded and that same turn interrupted after 6,908 ms. Native archive flag was 1. |

The retained fixture rollout independently records the failure:

- Ordinal 37, 17:15:33.110 UTC: task started for the active fixture turn.
- Ordinal 43, 17:15:37.038 UTC: `clock.sleep` invoked with 30,000 ms.
- Ordinal 45, 17:15:39.978 UTC: sleep output reports abortion after 2.9 seconds.
- Ordinal 48, 17:15:40.019 UTC: `turn_aborted`, reason interrupted, duration
  6,908 ms, same turn ID.

The fixture remains archived with its transcript retained. This is the
authorized fixture cleanup, not a production cleanup policy.

## Effect scope and missing contract

The [official app-server archive contract](https://learn.chatgpt.com/docs/app-server#archive-a-thread)
accepts a thread ID and attempts to archive spawned descendants. Individual
descendant failure can coexist with overall success, with notifications for
threads actually archived. Descendant effects were not exercised here:
the active-input test already fails the implementation gate. An MCP-created
child marker alone would not establish the provider's spawned-descendant
effect set.

The supported desktop operation proves loaded-idle archival and same-ID
explicit restoration, but does not provide the automatic cleanup contract:

1. The owning runtime must condition the archive effect on current idle state
   and no admitted/queued input, or provide equivalent demonstrated semantics
   that preserve raced input and execution. The measured operation interrupts
   an active tool wait. A status read followed by archive cannot close that
   race.
2. The operation must expose a single-thread effect or a verifiable complete
   effect set that can exclude autonomous/successor descendants.
3. The daemon needs a supported owning-runtime attachment/API, without
   impersonating an agent executor. Resume dispatch must restore the original
   ID before input; the measured external follow-up path does not do that.

Do not substitute a separate app-server's notLoaded status, a writer lock, or
Mandible's cached liveness for these runtime guarantees. Do not change global
holder liveness to make loaded desktop threads appear stopped. Provenance work
can proceed independently of this archive capability.

Co-Authored-By: Codex (GPT) <codex@openai.com>
