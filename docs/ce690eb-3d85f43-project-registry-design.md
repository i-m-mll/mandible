# Project registry: canonical name-to-path resolution

Mandible issue `3d85f43` (umbrella `ce690eb`). Resolves the narrower phantom-repo
write bug `dba7c41` as a side effect.

This note is self-contained for an external reviewer who does not have the repo
loaded.

## Problem

Mandible has two overlapping identity systems:

1. **Canonical projects** (`ledger_projects`) — the issue namespace. Every
   `ledger_issues.project_id` points here. Until now a project had only an
   opaque ledger id (`prj_…`), a free-text `display_name`, and a
   `remote_identity` (normalized git remote, e.g. `github.com/mll/feedbax`).
2. **WorkScanner / `work_repos`** — local discovery. The scanner walks the
   filesystem and assigns each checkout a *path-derived* slug id
   (`computeRepoId`), e.g. the directory `~/Main/20 Feedbax/feedbax` yields
   `20-feedbax-feedbax`. `ledger_project_checkouts.work_repo_id` stores that id.

The bug: issue projections used the path-derived `work_repo_id` as if it were
the project identity, so a Feedbax issue surfaced as `20-feedbax-feedbax/64a04e0`
instead of `feedbax/64a04e0`. Worse (`dba7c41`), `POST /api/issues/:repoId`
called `resolveProjectForCheckout`, which **mints a new project + checkout as a
side effect** when the posted root is unknown. Running `issue new` from a
sandbox mount (a translated path) therefore created a phantom project silently.

## Registry model

We make the two layers explicit and give the canonical project a stable,
human-meaningful **`project_key`** that is independent of both the free-text
display name and the path-derived WorkScanner id.

```
ledger_projects
  id            prj_…                 opaque, stable, FK target (unchanged)
  project_key   feedbax               NEW — stable slug, route/display identity
  display_name  Feedbax               human label (may collide across projects)
  remote_identity github.com/mll/feedbax  normalized git remote
  ...

ledger_project_checkouts
  project_id    -> ledger_projects.id
  work_repo_id  20-feedbax-feedbax    LOCAL DISCOVERY METADATA ONLY
  root          /Users/.../feedbax    absolute checkout path (UNIQUE)
  ...
```

`project_key` rules (`deriveProjectKey`): lowercase, `[a-z0-9-]`, derived from
the remote-identity tail when present (`github.com/mll/feedbax` -> `feedbax`),
else the display name, else the checkout basename; empty/`repo` fallbacks are
avoided; collisions get a `-2`, `-3`, … suffix. Enforced by a partial UNIQUE
index (`WHERE project_key != ''`).

`work_repo_id` is now treated strictly as **local discovery metadata** — it
never becomes the canonical project identity in projections or routing.

## Resolution contract (`src/ledger/project-registry.ts`)

- `resolveProjectRef(db, ref)` — resolve an arbitrary string to one canonical
  project. Precedence: (1) ledger id `prj_…`; (2) exact `project_key`; (3)
  checkout `work_repo_id`; (4) checkout `root` (path-normalized); (5)
  `remote_identity`; (6) exact `display_name`. A display-name hit that is
  ambiguous returns an `ambiguous` result carrying the candidate keys, never a
  silent pick.
- `resolveCheckoutPath(db, root)` — resolve a filesystem path to a *registered*
  checkout -> project. Returns `null` when the path is not a registered checkout
  root. This is the cwd-inference gate: cwd only resolves a project when it is a
  known checkout, never by minting one.
- `listProjects(db)` — canonical project keys, display names, remotes,
  checkouts, and open/closed issue counts.
- `addOrUpdateProject` / `addOrUpdateCheckout` — intentional registry writes.
- `suggestProjectRefs(db, ref)` — near-match keys/display names for error help.
- `auditRegistry(db)` — read-only audit (see below).
- `repairRegistry(db, opts)` — guarded normalization (see below).

## Issue-creation guard (`POST /api/issues/:repoId`)

The route no longer calls `resolveProjectForCheckout` (the minting path).
Instead it resolves to an **already-registered** project:

1. `body.project` (explicit registry ref) if present, else
2. the `:repoId` param and `body.root` against the registry
   (`resolveProjectRef` then `resolveCheckoutPath`).

If nothing resolves, the route returns `400` with `suggestions` (near-match
project keys) and creates **nothing**. Project/checkout creation is now only
possible through the explicit `mandible project add` / `add-checkout` surface
(or the scanner's git-bug sync path, which is discovery, not issue writes).

This fixes `dba7c41` end to end: a sandbox-mount root that is not a registered
checkout is rejected with suggestions rather than minting a phantom bucket.

## CLI

`mandible project` (new `cli/project.sh`, dispatched from `bin/mandible`):

- `list [--json]`
- `show <ref> [--json]`
- `add --key <k> [--display <name>] [--remote <url>] [--root <path>] [--namespace remote|upstream|local]`
- `update <ref> [--key …] [--display …] [--remote …] [--namespace …]`
- `add-checkout <ref> --root <path> [--work-repo-id <id>] [--default-branch <b>]`
- `update-checkout <root> [--project <ref>] [--work-repo-id …] [--default-branch …]`
- `audit [--json]`
- `repair [--apply] [--merge <src-ref> <dst-ref>] [--json]` (dry-run by default)

`mandible issue new` gains `--project <ref>` / `--repo <ref>`. When neither is
given it still posts the cwd root, but the route now rejects an unregistered
root with suggestions instead of minting.

## API routes (`src/routes/projects.ts`)

`GET /api/projects`, `GET /api/projects/:ref`, `POST /api/projects`,
`PATCH /api/projects/:ref`, `POST /api/projects/:ref/checkouts`,
`PATCH /api/projects/checkouts` (by root), `GET /api/projects/audit`,
`POST /api/projects/repair`. Each is self-allowlisted for the file transport in
`isAllowedFileRpcRoute` (no blanket prefix allow), staying within the file
transport's non-privileged write boundary (no approval/merge/admin/config).

## Migration vs. repair (data safety)

The `20-feedbax-feedbax` symptom is two *separable* defects:

- **(a) Projection used the wrong field.** Pure read bug — fixed by adding
  `project_key` and having projections prefer it. No rows move.
- **(b) Possible duplicate / mis-keyed project rows.** Genuinely destructive to
  fix (it moves issues between `project_id`s). Gated behind an explicit command.

Accordingly:

### Migration 87 (`ledger_project_key`) — additive, in-transaction, safe

```sql
ALTER TABLE ledger_projects ADD COLUMN project_key TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX idx_ledger_projects_project_key
  ON ledger_projects(project_key) WHERE project_key != '';
```

No FK column is touched and no row moves, so there is no foreign-key risk. The
key **backfill** runs as an idempotent post-migration Node step
(`backfillProjectKeys`, only rows with `project_key = ''`), deterministic and
collision-safe. Because `project_key` is brand new and referenced by no FK, the
additive migration plus the projection change alone correct the live Feedbax
display **without any destructive data move**.

### `mandible project repair` — explicit, guarded, dry-run by default

Handles the destructive normalization:

- backfills any missing keys (safe);
- optionally **merges** a source project into a target (`--merge src dst`),
  moving every project-scoped row (`ledger_issues`, `ledger_issue_aliases`,
  `ledger_comments` via issue cascade, `ledger_body_revisions`,
  `ledger_relationship_edges.{source,target}_project_id`, `ledger_external_refs`,
  `ledger_outbox`, `ledger_conflicts`, `spaces.project_id`) from src to dst.

The merge runs in a single transaction with `foreign_keys = ON`, **pre-checks
short-id and alias collisions between src and dst BEFORE moving any rows**
(aborting with a report if an issue short-id or alias would collide), and runs
`PRAGMA foreign_key_check` after the move; any violation rolls the whole thing
back. The command always returns an explicit report (counts moved / would move,
conflicts, audit categories). `--apply` is required to execute; default is a
dry run.

There is **no requirement to preserve** bad names like `20-feedbax-feedbax`; the
only invariant is DB integrity — no broken FKs, no orphans, no lost issue
history, no unresolved canonical refs.

## Audit (`auditRegistry`) — read-only

Reports: duplicate `display_name` across projects; local-only projects
(`namespace_policy = local` / `local:` identity); checkouts whose `work_repo_id`
is a numbered path-derived id (`/^\d+-/` or duplicate-suffixed); ambiguous
aliases/roots (a root mapped by multiple checkouts, a key/display collision);
and local projects that cannot be safely merged (a merge target ambiguity or a
short-id collision blocking consolidation).

## Projection change

- `getProjectInfo` (issue *detail* projection, `src/ledger/issue-detail.ts`):
  now surfaces `project_key` and `display_name`, and prefers `project_key` for
  the legacy `repo_id` field (falling back to `work_repo_id` only when a key is
  absent). This is the projection behind the `20-feedbax-feedbax/64a04e0`
  screenshot.
- `findCheckoutByRepoRef` / `resolveCheckout`
  (`src/ledger/issue-migration.ts`): additionally accept a `project_key` as a
  valid repo ref, so links and routes that now carry the canonical key resolve.
- The repo-summary grouping `repo_id` in `listCheckouts` is left on its existing
  derivation to avoid destabilizing the many sibling-owned summary/timeline/graph
  tests; consumers that want the canonical identity read the new `project_key`.
  Full migration of summary/route identity off `work_repo_id` is a deferred
  follow-up (see Open questions).

## Interaction with global workflow conventions (`~/.claude/CLAUDE.md`)

This is a backend-architecture change to project/repo identity, so per the
"Architectural reflection" rule:

- **Issue tracking / redirects.** Global conventions render issue IDs through
  `localhost:19420/r/issue/<id>`. Those use ledger ids / short ids and are
  unaffected by `project_key`; the key changes only the *project* label shown
  next to an issue, not the issue's own redirectable id.
- **Repo identity in commits/auth.** Auth requests and `.issue`/work-unit
  mechanism calls key off repo *paths* and branch names, not the project_key, so
  they are unaffected. The registry makes "which project does this checkout
  belong to" explicit, which strengthens (does not change) the existing
  worktree/issue-file discovery.
- **Proposed dotfiles follow-up.** Agents filing issues from sandbox mounts now
  get an explicit rejection with suggestions instead of a silent phantom repo.
  If we want the global "Mandible and Issue Tracking" section to tell agents to
  pass `--project`/`--repo` from sandboxes, that is a dotfiles `CLAUDE.md`
  change and should be filed as a Mandible issue in the dotfiles repo rather
  than edited here.

## Open questions / deferred

- Promoting `project_key` to the canonical `repo_id` in repo **summaries** and
  in route params everywhere (currently additive only) — deferred to avoid
  destabilizing sibling lanes mid-umbrella.
- A dashboard surface for the registry (list/add/repair UI) — backend + CLI
  only here.
- Auto-suggesting a merge target during `repair` (currently the operator picks
  `--merge src dst`).
