# Daemon stall profiling

The daemon runs on one event loop, so any synchronous turn delays every
client. Self-update handoffs fail when a diagnostic window's `eventLoop.maxMs`
reaches 250 ms (`EVENT_LOOP_STALL_BUDGET_MS`, `src/runtime-health-contract.ts`).
The daemon's own `daemon_event_loop_stall` log reports only each window's maximum.
These tools say when each stall happens and which JS functions caused it.

| tool | answers |
|---|---|
| `scripts/daemon-stall-probe.mjs` | when each stall starts and how long it lasts, on any daemon, read-only |
| `scripts/replay-request-mix.mjs` | loads a preview with a logged production request mix |
| `scripts/cpuprofile-windows.mjs` | which JS functions were on the CPU during each stall |

macOS `sample` shows Bun's JS frames as unsymbolized `???` addresses, so it can
only separate a stall by its native leaf: a synchronous child process
(`kevent64` under a JS frame), SQLite, or pure CPU. Function names come from
Bun's own sampling profiler (`--cpu-prof`), which needs a daemon started with
the flag. Never restart production for this; use a preview.

Measure only when the machine is quiet: check `uptime` and require the 1-minute
load average to be below the core count (`sysctl -n hw.ncpu`). On a saturated
machine the daemon is starved and every timing is noise.

## Probe stalls on any daemon

```sh
bun scripts/daemon-stall-probe.mjs --duration 600 --json > probe.jsonl
```

The probe requests `/api/health` over the daemon's Unix socket every 20 ms.
Health is answered in about a millisecond, so a request slower than
`--threshold-ms` (default 150) was queued behind a blocked loop, and its start
time is the stall's phase.

On exit it prints to stderr the phases at which stalls recur every 30 s and
every 60 s. For each 2 s phase window it takes the worst stall in every
complete period and ranks phases by the median, so a timer that blocks in
every period stands out from load that blocks at random phases. Run at least
three periods (`--duration 300` gives nine 30 s periods). A timer's phase is
fixed when the daemon starts, so it moves on every restart. Example from
production on 2026-10-24, with a 30 s job stalling about 1 s at :19/:49
(excerpt):

```
9375 requests in 300 s; 157 over 150 ms; worst 1138 ms
recurring stalls (UTC second of the minute):
  every 30 s at :19/:49 (+1 s)  median 1002 ms over 9 periods (943, 1002, 1073, 1138, 843, 958, 1081, 1067, 844)
  every 30 s at :00/:30 (+1 s)  median 262 ms over 9 periods (0, 262, 286, 518, 245, 411, 241, 402, 233)
  every 60 s at :56 (+1 s)  median 248 ms over 4 periods (235, 248, 388, 0)
```

- `--socket <path>` selects the daemon; the default is `$MANDIBLE_SOCKET`,
  otherwise the production socket. A preview's socket is
  `health.local_socket_path` in the launcher's JSON.
- `--sample` runs `sample <pid> 1` while a request is still past the threshold,
  capturing the stall in progress (`--sample-max`, default 20). The pid
  defaults to the socket's listener, found with `lsof`; production's daemon is
  the `production-runner.mjs` process.

The probe only reads health, so it is safe against production.

## Symbolized CPU profile of a preview

1. Check resources: at least 8 GiB free (`df -h ~`; a preview copies about
   0.9 GB of ledger) and a quiet machine (`uptime`).

2. Start a preview of the worktree under test. The daemon runs from source, so
   only the UI bundle needs building, not the full typecheck build:

   ```sh
   bun run build:ui
   bun run iab-preview -- --no-build --json > preview.json
   ROOT=$(jq -r .previewRoot preview.json)
   SOCK=$(jq -r .health.local_socket_path preview.json)
   PIDFILE=$(jq -r .pidFile preview.json)
   PROF=$(mktemp -d)   # outside $ROOT, which finalize must account for
   ```

3. Restart that preview daemon under the profiler. `run.sh` is the preview's
   own launch script; it passes the environment through, and Bun reads extra
   flags from `BUN_OPTIONS`:

   ```sh
   kill -TERM "$(cat "$PIDFILE")"
   while kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; do sleep 0.2; done
   BUN_OPTIONS="--cpu-prof --cpu-prof-dir=$PROF" nohup /bin/zsh "$ROOT/run.sh" >/dev/null 2>&1 &
   until curl -sf --unix-socket "$SOCK" http://localhost/api/health >/dev/null; do sleep 0.5; done
   ```

   The default 1 ms sampling interval is as fine as JSC delivers in practice
   (a requested 250 µs measured 1.2–1.3 ms).

4. Drive load and record stalls together:

   ```sh
   bun scripts/replay-request-mix.mjs --socket "$SOCK" --loop & REPLAY=$!
   bun scripts/daemon-stall-probe.mjs --socket "$SOCK" --duration 300 --json > probe.jsonl
   kill -INT $REPLAY; wait $REPLAY
   ```

   `replay-request-mix.mjs` replays the GETs that production logged
   (`http_request` lines in `~/.cache/mandible/production-stderr.log`, about
   20 minutes per 16 MiB segment; older segments are `.1` … `.5`) at their
   original relative times, with at most `--concurrency` (default 6) in flight.
   It skips `/api/health`, which is mostly other probes. `--from`/`--to` select
   the window and `--loop` repeats it. If the preview is slower than
   production, requests queue and the replay reports how far it fell behind;
   the load then exceeds production's. To profile one route, call it directly
   instead, for example
   `curl --unix-socket "$SOCK" http://localhost/api/work/repos/mandible/audit`.

   Watch the daemon's memory (`ps -o rss= -p "$(cat "$PIDFILE")"`). On main at
   20579683 a sustained sidebar replay grew a profiled preview past 13 GB RSS.

5. Stop the daemon. Bun writes the profile when the process exits, which can
   take 15 s after SIGTERM:

   ```sh
   P=$(cat "$PIDFILE"); kill -TERM "$P"; while kill -0 "$P" 2>/dev/null; do sleep 0.2; done
   ls "$PROF"   # CPU.<date>.<time>.<pid>.0.001.cpuprofile
   ```

6. Attribute the stalls:

   ```sh
   bun scripts/cpuprofile-windows.mjs "$PROF"/*.cpuprofile --stalls probe.jsonl --min-ms 250
   ```

   For each stall it prints the functions on the CPU (inclusive and self, with
   `file:line`) and the hottest complete stacks. Without `--stalls` it summarizes
   the whole profile. Samples carry wall-clock timestamps, so `--window
   <iso>,<ms>` also accepts times read from the daemon's log. The `.cpuprofile`
   also opens in Chrome DevTools or speedscope. On main at 20579683 the whole
   profile under the production mix read:

   ```
   whole profile: 118952 samples (~152496 ms on CPU)
     inclusive
        95%  113208  (anonymous) src/routes/conversations.ts:873
        71%   84577  buildConversationSidebar src/conversations/sidebar-projection.ts:165
        69%   82657  resolveCanonicalProject src/conversations/sidebar-projection.ts:72
        47%   55505  normalize
        26%   31149  sqliteCall src/sqlite.ts:54
   ```

7. Finalize the preview as soon as the measurement is done:

   ```sh
   bun scripts/iab-preview.mjs finalize --root "$ROOT" --revision "$(jq -r .ownership.revision "$ROOT/metadata.json")" \
     --outcome assessed --disposition discard --summary 'CPU profile for <issue>' --json
   ```

## Limits

- A preview runs the code under test on a projected copy of production's data
  (conversations active in the last 7 days, starred, session-linked or
  referenced), not its effects. The auth queue skips host work
  (`allowExternalEffects` is false), background maintenance is off, routes
  that need `process:external` (such as the Work audit's git scan) refuse, and
  no live agents ingest into it. A stall that depends on any of these shows on
  production only: find its phase there with the probe and confirm the native
  leaf with `--sample`.
- JSC inlines hot callees, so a small method may be charged to its caller.
- The profiler samples only while JS or native code runs on the loop thread;
  idle time has no samples. The printed CPU milliseconds are estimates
  (`samples × median interval`).
