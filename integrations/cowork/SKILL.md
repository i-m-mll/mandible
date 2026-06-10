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

Version: 2

This section is Mandible's interface contract. It describes daemon and CLI behavior that is the same for every install. It deliberately excludes user policy such as signing key names, branch naming schemes, editor preferences, and worktree tooling.

## Commands

- `mandible issue report <id> [--json]` - Print deterministic issue context for handoff and planning.
- `mandible issue heads <id>... [--json]` - Print issue state digests for delegation manifests and resume checks.
- `mandible issue changed --since-manifest <file> [--json]` - Compare current issue digests with a legacy saved delegation manifest file.
- `mandible issue changed --since-issue <umbrella> [--kind delegation-manifest] [--json]` - Compare current issue digests with the latest structured checkpoint on an umbrella issue.
- `mandible issue checkpoint add <issue-ref> --kind <kind> [--payload-file <file>]` - Append kind-tagged structured issue state outside the comment stream.
- `mandible issue checkpoint show <issue-ref> --kind <kind> [--latest|--all] [--json]` - Read kind-tagged structured issue state without parsing comments.
- `mandible issue status <id> <none|in_progress|done|blocked|pivot-needed>` - Set worker coordination status without changing open/closed lifecycle status.
- `mandible issue branch add <id> <branch> [--role primary|superseded]` - Link a branch to an issue as structured coordination state.
- `mandible issue comment add <issue-ref> -m <text>` - Append rendered Markdown comments with real newline characters.
- `mandible issue description edit <issue-ref> -m <text>` - Edit issue descriptions while preserving body revision history.
- `mandible issue label add|rm <id> <label>` - Mirror portable issue facts such as mandible:status:<value> labels.
- `mandible auth list [--repo <repo>] [--head <branch>] [--base <branch>] [--status <status>] [--json]` - Find existing auth requests before submitting duplicates.
- `mandible auth check [--branch <branch>] [--repo <repo>] [--target <branch>] [--json]` - Report whether a merge is clean against the target and queued pairwise-independent requests.
- `mandible auth request <branch> --title <text> --issue <id> [--closes-issue <id>] [--spec <text>] [--no-watch]` - Submit protected-branch auth work. Use --issue for reference context and --closes-issue only for intended closure.
- `mandible instructions diff [--target <file>] | install [--target <file>] [--worktree <path>] [--force]` - Show or update the managed Mandible interface block in an agent-instruction file. Installs into tracked protected-branch files are refused unless --force is explicit; use --worktree to target a feature-worktree copy.

## Commit Trailers

- `Mandible-Issue: <ref>` is a work-tracking reference link.
- `Closes-Mandible-Issue: <ref>` is an explicit closure signal.
- Commit trailers are optional interface metadata; commits without trailers are valid but unlinked.

## Auth Requests

- Protected-branch merges are asynchronous: submit an auth request, stop, and let the user approve in Mandible.
- Approval and merge execution are user actions. Agents do not approve, merge, or bypass the auth queue.
- Multiple pending merge requests may coexist when they are pairwise independent. Run `mandible auth check` before submitting when unsure; submission rejects clashes with file-level conflict context. Planned related branches still integrate first.

## Coordination

- The umbrella issue is the coordinator; sessions are disposable role holders.
- Delegation manifests are stored as `delegation-manifest` checkpoints; refresh digests with `mandible issue heads` before resuming.
- Worker closeout records `worker_status`, branch/auth pointers, blockers, and recommended next action in the child issue.
- Use `worker_status` and issue-branch links for coordination state; open/closed issue lifecycle remains separate.

## Transports

- Default CLI transport is loopback HTTP via `MANDIBLE_BASE=http://127.0.0.1:<port>`.
- Sandboxed agents without loopback can use `MANDIBLE_BASE=file:///path/to/spool` for issue and auth submission/listing routes.
- The file transport denies approval, merge, admin, and config routes; auth approval remains a user/dashboard action.

<!-- END MANDIBLE MANAGED INSTRUCTIONS -->
