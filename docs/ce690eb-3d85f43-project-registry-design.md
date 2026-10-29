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
   (`computeRepoId`), e.g. the directory `~/Main/20 Widgets/widgets` yields
   `20-widgets-widgets`. `ledger_project_checkouts.work_repo_id` stores that id.

The bug: issue projections used the path-derived `work_repo_id` as if it were
the project identity, so a Feedbax issue surfaced under a path-derived checkout ref
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
  work_repo_id  20-widgets-widgets    LOCAL DISCOVERY METADATA ONLY
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

- `resolveProjectRef(db, ref)` — the one resolver from any project reference
  to one canonical project; every caller uses it. It returns the project (and
  the matched checkout, when the ref named one), or refuses the ref as
  `unknown` or `ambiguous` with candidate keys. At each tier a ref naming
  several projects is refused, never passed to a weaker tier.
  - An absolute path resolves through the checkout it names or lies in: an
    exact registered root (symlinks of the requested path followed), any
    working tree of a registered checkout's Git repository (linked worktrees
    included, by `git worktree list`), a clone whose `origin` is a registered
    remote, and finally the deepest registered root containing the path.
  - Any other ref is tried as a project or checkout id, `project_key`,
    checkout `work_repo_id`, checkout name, remote identity, and
    `display_name`; keys, names, and display names compare case-insensitively.
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
   (`resolveProjectRef`, root first).

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
`POST /api/projects/repair`. Each route declares its own file-transport policy.
Repair is operator-only registry administration and is denied over file-RPC.
Ordinary registry routes retain their declared non-administrative policies.

## Migration vs. repair (data safety)

The path-derived checkout-id symptom is two *separable* defects:

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

Registry repair requires the configured local operator, including dry runs. Local
human socket access retains its existing owner authority. Agent identities and
project-admin grants do not grant registry administration. File-RPC denies this
administrative route. The route preserves 401/403 authorization responses, uses
one strict request schema, and declares ledger-read for reports and ledger-write
for apply. Preview effect ceilings continue to apply.

`mandible project repair [--apply] [--merge src dst] [--json]` plans missing key
backfills and an optional namespace merge. Dry runs change no state or
notifications. Reports identify each reference policy, occurrence counts,
distinct affected rows, duplicate-grant survivors, and blocking conflicts. Apply
resolves admitted repository identities asynchronously with bounded concurrency
before taking a database write lock. It records registry, schema, and repository
reference inputs and revalidates those persisted facts under the final lock;
drift returns `observation_changed` without applying repair. The transaction
freshly inspects relational and typed JSON references, collisions, keys, and feed
state. It contains all key backfills,
namespace moves, grant coalescences, checkout history, feed changes, source
removal, target update, and attributed events. Failed constraints roll back every
change and discard after-commit notifications. Unknown, ambiguous, incomplete,
and same-project merge references fail explicitly. There is no force override.

The typed project-reference catalog is the shared authority for inspection,
execution, and residual checks. Live foreign keys to `ledger_projects` are
discovered by `PRAGMA foreign_key_list`, independent of column names and delete
actions; every FK requires exactly one policy, even on an empty table. Declared
locators must exist. The catalog also registers reconciliation references,
typed embedded project references, and operational repository identities.

Mutable namespace fields move without changing row identity or recorded content.
Checkout moves retain checkout and work-repo identity and signal protection-input
reconciliation after commit. Feed merging preserves target order and event IDs,
appends source events, and removes source state; broken continuity blocks repair.
Project grants union by subject type, subject ID, and permission: source-only rows
retain ID and creation time, exact duplicates retain the destination survivor
with an attributed coalescence event, and different roles remain independently
revocable. Global grants, memberships, operator settings, and approval authority
remain unchanged. Source and target restricted settings must match.

Immutable clearance scopes (all lifecycle states), Git artifact custody,
registered repo sources and source-move lineage, frozen spawn/reminder records,
and work-unit/approval repository identities pin the source. Pins report their
kind, count, and reason; repair does not rewrite frozen payloads, digests, signed
material, or custody identity. Project redirects and historical rebasing require
a separate product decision.

Issue short IDs, every alias unique key, artifact-association unique keys, and
open singleton issue kinds are checked before changes. No alias or association
row is silently discarded. Before deleting the source, the executor verifies
that no catalogued source reference remains. Foreign-key enforcement must
already be enabled and stays enabled, rejecting newly invalid writes. Repair
does not run a whole-database `foreign_key_check`: unrelated pre-existing orphans
remain untouched and do not block an otherwise valid merge. The response states
that enforcement is enabled; it makes no whole-database cleanliness claim.

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
  absent). This is the projection behind the affected Feedbax issue
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

## Codex adversarial-review revisions

An external review before integration found real gaps; the corrections (design
intact):

1. **Project-reference policy.** Namespace moves, domain merges, and immutable
   pins use the shared typed catalog and atomic repair contract above.
2. **Operational/relationship resolution understands `project_key`.**
   `candidateProjectIds()`/`resolveOperationalIssueRef()` (operational-links) and
   `LedgerStore.resolveProjectId()` now accept `project_key` case-insensitively,
   so `work-unit claim --repo <key>`, auth-ref linking, and cross-project text
   refs (`[issue:Feedbax/abc123]`) resolve.
3. **Canonical key round-trips.** The key the issue-detail surface emits is now
   accepted everywhere it lands: the `/api/issues?repo=` filter matches a new
   (additive, optional) `IssueRepoSummary.project_key`; the `/r/issue/:ref`
   redirect builder prefers `project_key` for its `repo` param; and auth-list's
   `?repo=` alias lookup (which piggybacks on `/api/issues?repo=`) now collects
   `project_key`. Both the canonical key AND the legacy `work_repo_id` resolve.
4. **Scanner sync is the single audited discovery-write path.** git-bug sync
   (`runGitBugSyncForRepos`) now resolves a scanned root through the registry
   (exact registered root) FIRST and reuses an already-registered
   checkout/project instead of re-minting; genuinely-new checkouts still get
   discovered (and now get a `project_key`). Phantom/duplicate minting for paths
   that already resolve to a registered checkout is prevented without blocking
   legitimate local discovery; `auditRegistry` flags discovery-created projects
   via `numbered_repo_ids` + `local_projects`.
5. **Generic key fallback.** `deriveProjectKeyBase` treats `repo`, `project`,
   `local-project`, etc. as non-identifying: a generic basename is qualified with
   the parent directory (`/x/myproj/repo` -> `myproj-repo`); the interactive
   `mandible project add` path requires an explicit `--key`.
6. **Blank-root rejection.** `addOrUpdateCheckout` validates the trimmed raw root
   BEFORE `path.resolve` (which turns `""` into the daemon cwd), rejecting
   empty/whitespace roots.

## Open questions / deferred

- **Backup index recreation (DEFERRED).** A blank-DB metadata restore in
  `src/ledger/backup.ts` does not yet recreate the partial unique index
  `idx_ledger_projects_project_key`. Restore is currently unimplemented, and
  `backup.ts` is concurrently owned by a sibling artifact-versioning lane, so it
  is intentionally NOT touched here — recreate the index when restore lands.
- Promoting `project_key` to the *sole* canonical `repo_id` in repo summary
  grouping and every route param (currently additive — both key and
  `work_repo_id` are accepted; round-trip works) — deferred to avoid
  destabilizing sibling lanes mid-umbrella.
- A dashboard surface for the registry (list/add/repair UI) — backend + CLI
  only here.
- Auto-suggesting a merge target during `repair` (currently the operator picks
  `--merge src dst`; `auditRegistry.mergeable_local_projects` already surfaces
  the single-remote-target candidates).
