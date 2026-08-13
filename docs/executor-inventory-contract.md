# Executor inventory contract v1

Issue `0bc2279`. Publisher-facing spec for `POST /api/tasks/inventory`.

Mandible does not run recurring tasks. An **executor** (the first one is
`agent-schedule`) does, and it is the authority on which tasks exist and what
state they are in. This contract is how an executor tells Mandible, and it is
the whole write surface: there are no command, edit, or create routes.

What Mandible guarantees about anything shown in the Tasks view: **the identity
of the publisher and the shape of the payload.** Not that a task ran, not that a
hash is real, not that a circuit is actually open. Every fact is reported by the
executor, and the UI says so.

---

## 1. Transport and auth

```
POST /api/tasks/inventory      Content-Type: application/json
GET  /api/tasks                (read projection, open like other dashboard reads)
```

The POST requires a **registered executor**: an active Mandible user (kind
`agent`) holding a revocable API token, mapped to the executor name it posts
under. The mapping lives in the setting `tasks.inventory.executors`:

```json
{ "agent-schedule": ["agent-schedule"] }
```

Keys are user slugs; values are exact executor names (no prefix matching). The
default seeds `agent-schedule`. The local operator is the administrative
principal and may post under any name.

- No token → `401 authentication_required`.
- A session-scoped ephemeral credential → `403 executor_credential_required`.
  Publication requires the executor's durable API token; an ordinary agent
  session does not inherit this authority.
- A mapped non-agent identity → `403 executor_agent_required`.
- Authenticated but unmapped → `403 executor_identity_forbidden`. Authenticating
  is not the same as being permitted to publish; an arbitrary agent session
  cannot post an inventory.
- The authenticated user id is recorded on every stored generation. Nothing in
  the payload can name or change the publisher.

`fileRpc` is allowed, so a sandboxed publisher can reach the route over the file
transport. A read-only Mandible instance rejects the POST like any other
operational mutation.

Mint a publisher token with `mandible user token mint <slug> --store`.

---

## 2. Atomicity

**One POST is one complete snapshot of every task the executor manages.** There
is no per-task upsert and no partial update. Omitting a task means the executor
is asserting it no longer manages it. The view projects the newest generation
whole, so it can never show halves of two observations. "Newest" is ordered by
`observed_at` first, then receipt time and receipt insertion order as
deterministic tie-breakers. A late-arriving snapshot with an older
`observed_at` never displaces a newer executor observation.

---

## 3. The `unknown` convention

Every field an executor might not be able to answer accepts the literal string
`"unknown"`.

**`null`, `undefined`, and omission are rejected with a 400.** A publisher that
does not know must say so explicitly. This is the point of the convention: a run
recorded before bundle bindings existed reports
`"bundle_commit": "unknown"`, which reads differently from a run that has no
bundle — and both read differently from a field the publisher forgot.

Two values are positive claims, not unknowns:

- `"never"` in `last_run` / `last_failure` — "this has not happened".
- `"none"` in `guards.retry_next_at` — "no retry is queued".

Because unknown is a string sentinel, a task whose genuine `commit` is the
literal text `unknown` cannot be distinguished from an unknown commit. Accepted.

---

## 4. Payload v1

`schema` must be exactly `"executor-inventory@1"`.

```json
{
  "schema": "executor-inventory@1",
  "executor": {
    "name": "agent-schedule",
    "version": "0.4.2",
    "capabilities": ["cron", "kill-switch", "circuit-breaker"]
  },
  "observed_at": 1786650839611,
  "tasks": [
    {
      "task_id": "daily-digest",
      "display_name": "Daily digest",
      "management_mode": "external",
      "bundle": {
        "commit": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
        "content_hash": "sha256:9f2c…",
        "execution_hash": "sha256:41ab…",
        "deployed_at": 1786600000000
      },
      "activation": {
        "config_enabled": true,
        "locally_activated": true
      },
      "guards": {
        "circuit": "closed",
        "retry_attempt": 0,
        "retry_next_at": "none",
        "kill_switch": "clear",
        "staleness": "fresh"
      },
      "last_run": {
        "run_id": "run-2026-08-13T06:00Z",
        "started_at": 1786593600000,
        "finished_at": 1786593742000,
        "outcome": "success",
        "bundle_commit": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
        "content_hash": "sha256:9f2c…",
        "execution_hash": "sha256:41ab…",
        "config_hash": "sha256:77de…",
        "detail": "unknown"
      },
      "last_failure": {
        "run_id": "run-2026-08-02T06:00Z",
        "started_at": 1786000000000,
        "finished_at": 1786000090000,
        "outcome": "timeout",
        "bundle_commit": "unknown",
        "content_hash": "unknown",
        "execution_hash": "unknown",
        "config_hash": "unknown",
        "detail": "exceeded 90s budget"
      }
    }
  ]
}
```

### Field semantics

| Path | Type | Meaning |
|---|---|---|
| `schema` | `"executor-inventory@1"` | Exact match. Any other value is a 400. |
| `executor.name` | string | Stable executor identity. The projection key: one latest generation per name. Must be a name the publisher is mapped to. |
| `executor.version` | string \| `unknown` | Executor build/version. |
| `executor.capabilities` | string[] | Non-empty free-form tokens. `[]` means "declared none" — it is not unknown. |
| `observed_at` | integer (epoch ms) | When the executor took the snapshot. Doubles as its heartbeat; Mandible's staleness judgment reads this and nothing else. |
| `tasks[]` | array | Complete task set. May be empty (the executor manages nothing). `task_id` must be unique within the generation. |

Per task:

| Path | Type | Meaning |
|---|---|---|
| `task_id` | string | Stable id in the executor's namespace. |
| `display_name` | string | Human label. Untrusted text. |
| `management_mode` | `"external"` | v1 admits `external` only: the executor owns the task, Mandible observes it. |
| `bundle` | object \| `unknown` | The deployed code the task currently executes; `unknown` for the whole binding when the executor cannot resolve it. |
| `bundle.commit` | string \| `unknown` | Commit the bundle was built from. |
| `bundle.content_hash` | string \| `unknown` | Hash of the deployed bundle content. |
| `bundle.execution_hash` | string \| `unknown` | Hash of the executable form actually invoked. |
| `bundle.deployed_at` | integer ms \| `unknown` | When the bundle became active. |
| `activation.config_enabled` | boolean \| `unknown` | What the checked-in configuration asks for. |
| `activation.locally_activated` | boolean \| `unknown` | What this host is actually running now. |
| `guards.circuit` | `closed` \| `open` \| `half_open` \| `unknown` | Circuit-breaker state. |
| `guards.retry_attempt` | non-negative int \| `unknown` | Retry attempts already spent on the pending run; `0` means none. |
| `guards.retry_next_at` | integer ms \| `"none"` \| `unknown` | Scheduled retry time. |
| `guards.kill_switch` | `engaged` \| `clear` \| `unknown` | Operator kill switch. |
| `guards.staleness` | `fresh` \| `stale` \| `unknown` | The **executor's own** judgment about this task. Distinct from Mandible's view-age freshness (§6). |
| `last_run` | run object \| `"never"` \| `unknown` | Most recent run of any outcome. |
| `last_failure` | run object \| `"never"` \| `unknown` | Most recent failing run. |

Run object (same shape for `last_run` and `last_failure`):

| Path | Type | Meaning |
|---|---|---|
| `run_id` | string \| `unknown` | Executor-local run identity. |
| `started_at` / `finished_at` | integer ms \| `unknown` | Run window. |
| `outcome` | `success` \| `failure` \| `timeout` \| `cancelled` \| `unknown` | |
| `bundle_commit`, `content_hash`, `execution_hash`, `config_hash` | string \| `unknown` | **The binding identities the run actually executed under.** These are the reason the run record exists: a failure that cannot name its bundle reports `unknown` rather than being silently attributed to whatever is deployed today. |
| `detail` | string \| `unknown` | Free text the executor logged. Untrusted; rendered as text, never HTML. |

### Activation is deliberately two facts

A single mutable `enabled` flag would conflate desired state with deployed
state. `config_enabled` and `locally_activated` are reported separately so
"enabled in config but not running on this host" is visible as exactly that.

---

## 5. Validation, idempotency, receipts

Validation is **strict and fail-closed**:

- An unrecognized key anywhere in the payload is a 400 naming the path and the
  offending field(s). Mandible never silently drops a field a publisher sent, so
  a publisher can never believe a fact is on record when it is not.
- A wrong `schema` is a 400 naming both the received and expected values.
- A duplicate `task_id` within a generation is a 400.

Storage is **append-only**. Each generation is one row carrying the full payload,
the authenticated principal, and a SHA-256 **content digest** over the canonical
(field-order-normalized) generation.

**Idempotency is by `(executor name, digest)`.** Re-posting the same canonical
generation writes nothing and returns the original receipt with `stored: false`
— safe to retry blindly. Scoping uniqueness to the executor prevents a
digest collision in one executor's namespace from suppressing another
executor's authenticated receipt:

```json
{
  "generation_id": "6f1c…",
  "digest": "3a9b…",
  "stored": true,
  "executor": "agent-schedule",
  "task_count": 4,
  "observed_at": 1786650839611
}
```

Because `observed_at` is part of the digest, a fresh heartbeat with otherwise
identical task state is a new generation (as it should be — the picture is
newer), while a retried POST of the same snapshot is not.

---

## 6. What Mandible derives

Exactly one thing: **freshness**, from `observed_at` against a
`stale_after_ms` horizon (3 hours by default; `GET /api/tasks` reports the
horizon it applied so no client has to guess).

- `current` — observed within the horizon.
- `stale` — older than the horizon. The executor has missed several cycles.
- `unknown` — no timestamp, or a timestamp in the future (a clock Mandible
  cannot reason about is not evidence of freshness).

Freshness is a claim about the **age of the picture**, not about the tasks. It
is distinct from `guards.staleness`, which is the executor's claim about a task.

`GET /api/tasks` returns `{ executors, tasks, stale_after_ms }`, where `tasks`
is the flattened newest generation of every executor, each entry keyed
`"<executor>/<task_id>"`. An empty `executors` array means no executor has ever
posted — the view states that plainly rather than showing an empty task list as
though the tasks had vanished.

---

## 7. Out of scope for v1

No runner in the daemon. No ops commands. No editable task specs. No
multi-executor claiming of the same task. No mutable `enabled` flag. Mandible
does not read the executor's database and does not invoke its CLI.
