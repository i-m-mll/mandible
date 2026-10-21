---
name: mandible-cowork
description: Drive a host Mandible ledger from a sandboxed Cowork session through the daemon file-RPC transport. Use for Mandible issues, comments, labels, auth requests, artifacts, coordination umbrellas, status archaeology, and implementation work that needs ledger state.
---

# Mandible from Cowork

Cowork sessions cannot reach the host daemon loopback address. Use the mounted
Mandible cache directory instead: the daemon watches an `agent-rpc/` spool
there, and it materializes a version-matched CLI copy in `cli/`.

## Required Mount

Request one directory:

```text
~/.cache/mandible
```

Inside the sandbox, set:

```bash
export MANDIBLE_CACHE_DIR=<mounted ~/.cache/mandible path>
export MANDIBLE_BASE="file://${MANDIBLE_CACHE_DIR}/agent-rpc"
export MANDIBLE_CLI_DIR="${MANDIBLE_CACHE_DIR}/cli"
```

The host daemon must be running. If `daemon.pid` exists in the mounted cache but
commands time out, ask the user to check the host Mandible daemon.

## CLI Mode

Prefer the daemon-materialized CLI when it exists:

```bash
bash "${MANDIBLE_CLI_DIR}/issue.sh" triage --json --limit 20
bash "${MANDIBLE_CLI_DIR}/issue.sh" triage --repo /mounted/repo --json --limit 20
bash "${MANDIBLE_CLI_DIR}/conversations.sh" list --json --limit 20
bash "${MANDIBLE_CLI_DIR}/conversations.sh" blocks <session-id> --json
bash "${MANDIBLE_CLI_DIR}/issue.sh" new -t "Title" -m "Rendered Markdown body" --label feature
bash "${MANDIBLE_CLI_DIR}/auth-request.sh" feature/name --title "Merge feature/name" --issue abc1234 --no-watch
```

Run commands from the target repo cwd when the CLI needs repo inference. If that
repo is not mounted, pass explicit repo/cwd options where the command supports
them or use raw mode for read-only inspection.

The command reference is at:

```text
${MANDIBLE_CLI_DIR}/docs/cli-reference.md
```

## Mounted-Repo Fallback

If `${MANDIBLE_CLI_DIR}/issue.sh` is missing but the Mandible repo is mounted,
set `MANDIBLE_CLI_DIR` to that repo's `cli/` directory and run the same bash
scripts. Do not run the top-level `bin/mandible` dispatcher from Cowork unless
the sandbox has `zsh`.

## Raw Mode

If only the cache mount is available and no CLI copy exists, use the bundled
helper:

```bash
python3 scripts/mandible_file_rpc.py "${MANDIBLE_CACHE_DIR}/agent-rpc" GET /api/issues
python3 scripts/mandible_file_rpc.py "${MANDIBLE_CACHE_DIR}/agent-rpc" GET /api/conversations
python3 scripts/mandible_file_rpc.py "${MANDIBLE_CACHE_DIR}/agent-rpc" GET /api/conversations/<conversation-id>/blocks
python3 scripts/mandible_file_rpc.py "${MANDIBLE_CACHE_DIR}/agent-rpc" POST /api/ledger/issues/abc/comments body.json
```

The request body file must contain JSON. The helper writes request files
atomically and leaves cleanup to the daemon.

## Boundaries

- Do not mutate `.git` state through mounted directories. No branch creation,
  commits, ref updates, worktree operations, or lockfile cleanup through mounts.
- Signing and merge approval are host-only. Submit auth requests only after the
  branch already exists with host-side commits; approval remains a user action.
- Do not blind-retry writes after a timeout or nonzero CLI exit. Verify with an
  issue report, comment lookup, auth list, or artifact lookup first.
- Issue bodies and comments must be valid rendered Markdown with real newline
  characters, not literal `\n` escapes.
- The skill contains only Mandible interface facts. User policy lives in the
  host user's own policy files; ask for those mounts only when the task needs
  user-specific workflow rules.

## Managed Mandible Contract

<!-- BEGIN MANDIBLE MANAGED INSTRUCTIONS -->
# Mandible Interface Contract

Version: 3

This section is Mandible's interface contract. It describes daemon and CLI behavior that is the same for every install. It deliberately excludes user policy such as signing key names, branch naming schemes, editor preferences, and worktree tooling.

## Commands

- `mandible issue report <id> [--json]` - Print deterministic issue context for handoff and planning.
- `mandible umbrella status <id> [--deep] [--json]` - Print one deterministic coordinator fact packet: umbrella body/revision/head, latest delegation manifest, child summaries, parent-role holder state, and repo auth queue summary. --deep includes child bodies, latest closeouts/comments, branch/auth links, and issue state for parent resumption.
- `mandible umbrella adopt <umbrella> <children...> [--json]` - Idempotently adopt explicit children into an umbrella, create missing parent_child edges, refresh the delegation-manifest checkpoint server-side, and return the updated umbrella status fact packet. This command and `mandible issue link --type parent_child` are the only ways to establish umbrella membership.
- `mandible umbrella manifest refresh <umbrella> [--json]` - Refresh the umbrella delegation-manifest checkpoint from current linked child issue heads server-side without changing parent_child edges, and return the updated umbrella status fact packet.
- `mandible issue parent-role status|assume <umbrella> [--session <id>] [--mechanism <name>] [--override] [--json]` - Inspect or record advisory parent-role holder state. --session accepts a registered Mandible session id or a registered provider session/thread id; the daemon resolves the alias to its canonical session, stores both identities, and rejects an unknown or unregistered id with an actionable error. Liveness comes from the canonical session-liveness rule: a live holder conflict requires an explicit override while a stale holder is informational.
- `mandible issue heads <id>... [--json]` - Print issue state digests for delegation manifests and resume checks.
- `mandible issue changed --since-manifest <file> [--json]` - Compare current issue digests with a legacy saved delegation manifest file.
- `mandible issue changed --since-issue <umbrella> [--kind delegation-manifest] [--checkpoint <id>] [--json]` - Compare current issue digests and the umbrella's own head with a structured checkpoint on an umbrella issue; omit --checkpoint to use the latest checkpoint.
- `mandible issue checkpoint add <issue-ref> --kind <kind> [--payload <json-or-> | --payload-file <file-or->]` - Append kind-tagged structured issue state outside the comment stream. Use --payload - or --payload-file - to read JSON from stdin.
- `mandible issue checkpoint show <issue-ref> --kind <kind> [--latest|--all] [--json]` - Read kind-tagged structured issue state without parsing comments.
- `mandible issue status <id> <none|done|blocked|pivot-needed>` - Store an explicit worker status without changing open/closed lifecycle status. `in_progress` is derived from an open or committed work unit and is not stored.
- `mandible issue branch add <id> <branch> [--role primary|superseded]` - Link a branch that has no work unit, or mark a branch superseded. Work-unit branches are listed without a link.
- `mandible issue link <src> <target...> [--type t] [--note n]` - Create deliberate structured issue/comment relationship edges with shared action grouping for multi-target links. Accepted types: parent_child, blocks, duplicate_of, related, references, fixed_by, caused_by, implements, tests.
- `mandible issue unlink <src> <target...> [--type t]` - Tombstone deliberate structured issue/comment relationship edges and emit relationship removal events. Accepted types: parent_child, blocks, duplicate_of, related, references, fixed_by, caused_by, implements, tests.
- `mandible issue comment add <issue-ref> -m <text> [--reopen]` - Append rendered Markdown comments with real newline characters and return the issue lifecycle status; --reopen atomically reopens and comments.
- `mandible issue description edit <issue-ref> -m <text>` - Edit issue descriptions while preserving body revision history.
- `mandible issue label add|rm <id> <label>` - Mirror portable issue facts such as mandible:status:<value> labels.
- `mandible auth list [--repo <repo>] [--head <branch>] [--base <branch>] [--status <status>] [--json]` - Find existing auth requests before submitting duplicates.
- `mandible auth check [--branch <branch>] [--repo <repo>] [--target <branch>] [--json]` - Report whether a merge is clean against the target and queued pairwise-independent requests.
- `mandible auth request <branch> --title <text> --issue <id> [--closes-issue <id>] (--message <text> | --message-file <file>) --verification <text> [--spec <text>] [--no-watch]` - Submit protected-branch auth work. The change message and verification text are required. Use --issue for reference context and --closes-issue only for intended closure.
- `mandible instructions install [--target <file>] [--worktree <path>] [--force]` - Refresh configured instruction targets, or update one explicit target. Configured targets support managed-block and standalone modes; tracked protected-branch writes are refused unless --force is explicit.
- `mandible instructions targets list|add|rm <path> [--mode managed-block|standalone]` - Configure where the generated Mandible instruction fragment is written.
- `mandible instructions post-export get|set|clear <command>` - Configure an optional command to run after instruction targets refresh, such as a module compiler.

## Auth Requests

- Protected-branch merges are asynchronous: submit an auth request, stop, and let the user approve in Mandible.
- Approval and merge execution are user actions. Agents do not approve, merge, or bypass the auth queue.
- Multiple pending merge requests may coexist when they are pairwise independent. Run `mandible auth check` before submitting when unsure; submission rejects clashes with file-level conflict context. Planned related branches still integrate first.

## Coordination

- The umbrella issue is the coordinator; sessions are disposable role holders.
- Umbrella membership is the set of `parent_child` relationship edges from the umbrella to its children, created by `mandible umbrella adopt` or `mandible issue link --type parent_child` and removed by `mandible issue unlink`. Umbrella bodies carry the plan and rationale, not a membership table; read children and their live state from `mandible umbrella status` or the issue's children shelf in the Mandible app.
- Delegation manifests are stored as `delegation-manifest` checkpoints; refresh digests with `mandible umbrella manifest refresh <umbrella>` before resuming.
- `mandible issue changed --since-issue` compares the umbrella's own issue head as well as child manifest entries. Parent sessions that need their own baseline should pass `--checkpoint <id>` instead of relying on the latest shared checkpoint.
- Worker closeout records `worker_status`, branch/auth pointers, blockers, and recommended next action in the child issue.
- Mutating work-unit requests may carry allowlisted ambient provider identity as `{provider, provider_session_id}`; Mandible persists only those fields on work units and never stores the caller environment.
- Successful auth merges archive reliably linked terminal Codex worker threads for closed child issues. Resolved work units with `provider=codex` and a provider session id can archive directly without `console_sessions`; legacy console-session links still work. Live parent-role holders and active sessions are not archived. Codex resume dispatch unarchives the provider thread before sending follow-up work.
- Use `worker_status` and issue-branch links for coordination state; open/closed issue lifecycle remains separate.

## Transports

- Default CLI transport is loopback HTTP via `MANDIBLE_BASE=http://127.0.0.1:<port>`.
- Sandboxed agents without loopback can use `MANDIBLE_BASE=file:///path/to/spool` for issue, auth submission/listing, work-unit mutation, coordinator, conversation index, repo listing, and daemon-indexed log routes.
- The file transport denies approval, merge, admin, and config routes; auth approval remains a user/dashboard action.

<!-- END MANDIBLE MANAGED INSTRUCTIONS -->
