# Cowork Integration

Cowork sessions can drive Mandible without loopback access by mounting the
host cache directory and using the daemon's file-RPC spool. The durable target
is one mount and no machine-specific repo path knowledge:

```text
~/.cache/mandible
```

The daemon watches `~/.cache/mandible/agent-rpc/` for request files and writes
responses next to them. On startup it also writes a version-matched CLI copy to
`~/.cache/mandible/cli/`, including the bash CLI scripts and
`docs/cli-reference.md`.

## Current Workflow

In a Cowork session, request the cache mount and then configure:

```bash
export MANDIBLE_CACHE_DIR=<mounted ~/.cache/mandible path>
export MANDIBLE_BASE="file://${MANDIBLE_CACHE_DIR}/agent-rpc"
export MANDIBLE_CLI_DIR="${MANDIBLE_CACHE_DIR}/cli"
```

Use the bash scripts directly:

```bash
bash "${MANDIBLE_CLI_DIR}/issue.sh" triage --json --limit 20
bash "${MANDIBLE_CLI_DIR}/issue.sh" new -t "Title" -m "Rendered Markdown body" --label feature
bash "${MANDIBLE_CLI_DIR}/auth-request.sh" feature/name --title "Merge feature/name" --issue abc1234 --no-watch
```

Run commands from the target repository cwd when repo inference matters. If the
target repo is not mounted, use commands that accept explicit repo/cwd options
or fall back to raw file-RPC calls for read-only inspection.

The command reference in the cache is:

```text
${MANDIBLE_CLI_DIR}/docs/cli-reference.md
```

## Skill Bundle

The generic Cowork skill lives in `integrations/cowork/`. It has no usernames
or absolute host paths. Package it reproducibly as a `.skill` archive by zipping
the directory contents in sorted order:

```bash
cd integrations/cowork
LC_ALL=C find . -type f | sort | zip -X -@ ../mandible-cowork.skill
```

The bundled `scripts/mandible_file_rpc.py` helper is a raw fallback for sessions
that have only the spool mount and no usable CLI copy.

## Sandbox Pitfalls

- Cowork cannot reach `127.0.0.1:19420`; use `MANDIBLE_BASE=file://...`.
- Do not mutate `.git` through mounted directories. Branch creation, worktree
  operations, commits, ref updates, and lockfile cleanup must happen host-side.
- Auth request submission is allowed through file-RPC, but approval and merge
  execution remain user actions in Mandible.
- Do not blind-retry writes after a timeout or nonzero exit. Verify first with
  `issue report`, `comment show`, `auth list`, or an artifact lookup.
- Issue bodies and comments must be rendered Markdown with real newline
  characters, not literal `\n` escapes.

## Approval Boundaries

The file transport allows issue, artifact, and auth-submission routes needed
for agent coordination. It denies approval, merge, admin, and configuration
routes. A Cowork session may prepare or submit an auth request only after the
branch exists with host-side commits; the user still approves with their normal
Mandible workflow.

## Distributed Install State

Implemented for distributed installs:

- The daemon materializes `cli/*.sh` and `docs/cli-reference.md` into
  `~/.cache/mandible/cli/` on startup.
- `integrations/cowork/` provides the generic skill and raw file-RPC fallback.
- `integrations/cowork/SKILL.md` carries the managed Mandible interface block
  so the skill can be refreshed with `mandible instructions install --target`.

Out of scope for this pass: non-Cowork sandbox conventions, Windows/Linux
cache path variants, and app-store-style skill distribution.
