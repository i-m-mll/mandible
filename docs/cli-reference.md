# Mandible CLI Cheatsheet (source-verified 2026-06-12)

```
## ISSUE
mandible issue new -t <title> -m <body> --kind bug|feature|umbrella|maintenance|experiment|tracker [--priority low|normal|high|urgent] [--label <label>]...
mandible issue list [--status open|closed|all] [--repo R]  # NO --json, NO --limit
mandible issue show <id>                                      # NO --json
mandible issue title <id> [--json] [--graceful]
mandible issue report <id> [--json]                          # exit 3 = NOT from this CLI (curl -sf exits 22 on HTTP err)
mandible umbrella status <id> [--deep] [--json]
mandible umbrella adopt <umbrella> <children...> [--json]
mandible umbrella manifest refresh <umbrella> [--json]
mandible issue parent-role status <umbrella> [--json]
mandible issue parent-role assume <umbrella> [--session S] [--mechanism M] [--override] [--json]
mandible issue triage [--status open|closed|all] [--resolution R] [--kind K] [--priority P] [--label L] [--repo R] [--stale-days N] [--limit N] [--json]
mandible issue search <words>... [--repo R] [--status open|closed|all] [--limit N] [--json]  # titles, bodies, comments; all projects
mandible issue heads <id>... [--json]
mandible issue changed --since-manifest <file> [--json]
mandible issue changed --since-issue <umbrella> [--kind delegation-manifest] [--checkpoint <id>] [--json]
mandible issue checkpoint add <id> --kind <kind> [--payload <json-or-> | --payload-file <file-or->]
mandible issue checkpoint show <id> --kind <kind> [--latest|--all] [--json]
mandible issue status <id> <none|in_progress|done|blocked|pivot-needed>
mandible issue branch add <id> <branch> [--role primary|superseded]
mandible issue link <src> <target...> [--type t] [--note n]
mandible issue unlink <src> <target...> [--type t]
mandible issue close <id> --resolution delivered|duplicate|wontfix [--commit <sha>]
mandible issue open <id>
mandible issue label add|rm <id> <label>
mandible issue comment add <id> -m <text> [--reopen]
mandible issue comment show <ref> [--json]        # ref: id, <issue>#<ordinal>, <issue>#last
mandible issue comment history <ref> [--json] [--with-body]
mandible issue description show <ref> [--json]
mandible issue description edit <ref> -m <body> [--base-revision <rev>] [--base-body-hash <hash>]
mandible issue description history <ref> [--json] [--with-body]
mandible issue work-notes show <ref> [--json]
mandible issue work-notes edit <ref> -m <text> [--base-revision <rev>]
mandible issue work-notes clear <ref> [--base-revision <rev>]
mandible issue work-notes history <ref> [--json] [--with-body]
mandible issue kind set <ref> bug|feature|umbrella|maintenance|experiment|tracker|unknown
mandible issue priority set <ref> low|normal|high|urgent
mandible issue revision show <rev-id> [--json]
mandible issue revision diff <old-rev-id> <new-rev-id> [--force]
mandible issue refs backfill [--dry-run] [--apply] [--repo R] [--issue I] [--since D] [--until D] [--json]
mandible issue markdown <audit|normalize|export> [opts]

## AUTH
mandible auth list [--json] [--repo R] [--head B] [--base B] [--status S] [--type T]
mandible auth check [--branch B] [--repo R] [--target B] [--cwd P] [--json]
mandible auth request <branch> --title <text> [--issue <id>]... [--closes-issue <id>]...
  (--message T | --message-file F) --verification T
mandible auth request --type <type> --command <command> --cwd <path> --repo <ref> --title <text> --issue <id>
  [--type merge|commit|force-push|branch-delete|config-change|data-delete]
  [--promote-briefing GROUP EXPECTED-BASE PROPOSAL]
  [--diff-summary T] [--spec T | --spec-file F] [--handoff T] [--repo R]
  [--cwd P] [--target B] [--depends-on ID] [--dirty-policy block|allow-untracked|stash|branch-off]
  [--supersedes ID] [--drop-superseded-action ORDINAL:REASON]...
  [--timeout N] [--no-watch] [--force|-f]
mandible auth withdraw <request-id> --reason <text> --expected-revision <n> --expected-custody-generation <n> [--json]
mandible auth merge <branch> [opts]    # executes the merge; invoked by daemon

## LEDGER MECHANISM CLIENT
source cli/ledger-client.sh
mandible work-unit claim --issue I --repo R [--branch B] [--parent-branch B] [--kind solo|partition|integration] [--expected-generation N] [--parent-role-checkpoint C] [--session S] [--graceful]
mandible work-unit activate --issue I --repo R [--branch B] [--session S] [--worker] [--graceful]
mandible work-unit find --repo R (--issue I | --branch B) [--state open|committed|resolved|abandoned] [--graceful]
mandible work-unit resolve --id WU --expected-generation N [--auth-request-id AR] [--graceful]
mandible work-unit release --repo R --branch B --expected-generation N [--graceful]
mandible issue title <id> [--json] [--graceful]
mandible issue-file path [cwd]
mandible issue-file read [cwd]
mandible issue-file write [--cwd P] I...
mandible session link-issue SESSION --issue I --repo R [--repo-name N] [--graceful]

## LOGS  (raw provider files, not DB)
mandible logs inventory [--provider codex|claude|gemini|all] [--since Nd|YYYY-MM-DD] [--limit N] [--json]
mandible logs inspect <path|session-id> [--provider ...] [--parse] [--head N] [--json]
  [--role R] [--type T] [--tool N] [--tool-kind K] [--since T] [--until T] [--content T] [--limit N]
mandible logs missing  [--provider ...] [--json]
mandible logs orphans  [--provider ...] [--json]
mandible logs capabilities [--provider codex|claude_code|gemini] [--json]

## CONVERSATIONS  (DB-backed)
mandible conversations list [--provider claude|codex|gemini|all] [--since Nd] [--limit N] [--json]
mandible conversations show <id|session-id> [--json] [--blocks]
mandible conversations blocks <id|session-id> [--type T] [--limit N] [--json]   # delegates to node
mandible conversations export <id|session-id> [--format json|markdown]           # NO --json flag here
mandible conversations search "<query>" [opts]   # alias for mandible search

## SEARCH  (content search across DB blocks)
mandible search "<query>" [--provider claude|gemini|codex|all] [--role user|assistant]
  [--since Nd] [--limit N] [--title]             # NO --json flag

## ARTIFACT
mandible artifact ingest <path...> [--project P] [--commit REF] [--artifact REF] [--issue <id>] [--role R] [--managed|--copy|--link]
  [--upload] [--allow-local-only] [--allow-dirty-link] [--dry-run] [--json]
mandible artifact move <artifact-ref> [--project P] [--path PATH] [--if-revision N] [--reconcile] [--json]
mandible artifact list [--repo R] [--issue <id>] [--role R] [--custody M] [--json]
mandible artifact show <ref> [--json]
mandible artifact resolve <ref> [--json]
mandible artifact check <ref...> [--json]
mandible artifact link <ref> --issue <id> [--role R] [--relation references|output|evidence|handoff] [--json]
mandible artifact content <ref> [--output <path>] [--json]
mandible artifact snapshot <path...> [--issue <id>] [--role R] [--upload] [--dry-run] [--json]
mandible artifact snapshot <artifact-ref> --from <path> [--issue <id>] [--role R] [--upload] [--json]
mandible artifact scan-repos [--repo R] [--max-depth N] [--register] [--dry-run] [--json]
mandible artifact bundle create --name N [--manifest F] [--issue <id>] [--role R] [--dry-run] [--json]
mandible artifact bundle add <bundle-ref> <path-or-ref...> [--allow-local-only] [--allow-dirty-link] [--json]
mandible artifact bundle show <bundle-ref> [--json]
mandible artifact bundle check <bundle-ref> [--json]

## INSTRUCTIONS
mandible instructions diff [--target <file>]
mandible instructions install [--target <file>] [--worktree <path>] [--force]
mandible instructions targets list
mandible instructions targets add <path> [--mode managed-block|standalone]
mandible instructions targets rm <path>
mandible instructions post-export get
mandible instructions post-export set <command>
mandible instructions post-export clear

## INBOX / TASK / MISC
mandible inbox [check|add "text"|ack <type> <id>|watch <request-id>]
mandible task "<description>" | --clear
mandible help | -h | --help
mandible auth help | -h | --help | ""   → shows auth subcommand list (does NOT error)
```

## Umbrella Coordination

`mandible umbrella adopt <umbrella> <children...> [--json]` explicitly adopts
the provided child refs into an umbrella. It sends one server-side adoption
request that creates any missing `parent_child` edges, refreshes the
`delegation-manifest` checkpoint, and returns the updated umbrella status
packet.

Umbrella membership is the `parent_child` edge graph created by `umbrella adopt`
or `mandible issue link <umbrella> <children...> --type parent_child`; there is
no body Children table and no reconcile command.

`mandible umbrella status <umbrella> --deep [--json]` keeps the default status
surface unchanged but inlines child issue bodies, latest closeout checkpoints,
latest comments, branch links, auth links, and issue state needed for parent
resumption anomaly checks.

`mandible umbrella manifest refresh <umbrella> [--json]` refreshes the latest
`delegation-manifest` checkpoint from the current linked child issue heads on
the server without changing child edges. Use it on parent resumption instead of
assembling `issue heads` plus `issue checkpoint add` client-side.

## Issue Relationship Types

`mandible issue link` and `mandible issue unlink` accept these `--type` values:
`parent_child`, `blocks`, `duplicate_of`, `related`, `references`, `fixed_by`,
`caused_by`, `implements`, and `tests`. Invalid type errors print this accepted
list. File-RPC callers may use the same link/unlink routes and will see the
transport status/body when a route is denied.

## Checkpoint Payloads

`mandible issue checkpoint add` accepts `--payload '<json>'`, `--payload -` for
JSON on stdin, and the existing `--payload-file <file-or->` form. Omitting a
payload still records `{}`.

## Ledger Mechanism Client

`cli/ledger-client.sh` is the sourceable Mandible-owned client for policy-free
ledger mechanism operations. It routes through `cli/api.sh`, so the same
functions work over loopback HTTP and `MANDIBLE_BASE=file://...` file-RPC. The
supported sourceable functions are `mandible_work_unit_claim`,
`mandible_work_unit_activate`, `mandible_work_unit_find`,
`mandible_work_unit_resolve`, `mandible_work_unit_release`,
`mandible_issue_title`, `mandible_session_link_issue`,
`mandible_issue_file_path`, `mandible_issue_file_read`,
and `mandible_issue_file_write`.

The client takes explicit mechanism inputs such as issue, repo, branch, session,
and work-unit IDs. It does not encode worktree layout, branch naming, signing,
attribution, model, or profile policy. Callers that should continue when the
daemon or file-RPC spool is unavailable can pass `--graceful` or set
`MANDIBLE_LEDGER_GRACEFUL=1`.

`.issue` files are newline-delimited issue refs at the git root. Blank lines and
`#` comments are ignored when reading. Issue relationships are structured ledger records; commit prose is not interpreted.

## Does NOT Exist (confirmed absent from source)

- `mandible issue list --json` — `cmd_list` has no `--json` case; only `--status`
- `mandible issue list --limit N` — no `--limit` in `cmd_list`
- `mandible issue show --json` — `cmd_show` takes one positional arg only
- `mandible search ... --json` — no `--json` in search.sh parser
- `mandible conversations search ... --json` — search is delegated to search.sh, which has no `--json`
- `mandible conversations search ... --limit` — search.sh uses `--limit` but `conversations search` alias strips no args; however `--limit` IS supported in search.sh (so `mandible search ... --limit N` works; `mandible conversations search ... --limit N` also passes through)
- `mandible logs inventory --until` — `inventory` subparser has only `--since`, not `--until` (`--until` exists only under `logs inspect --parse`)
- `mandible auth --help` as a lone flag — does NOT error; dispatcher matches `""|-h|--help|help` and prints auth usage (was previously reported as "Unknown auth subcommand")

## `--help` behavior per top-level command

- `mandible help|--help|-h` → prints usage, exits 0
- `mandible auth ""|-h|--help|help` → prints auth subcommand list, exits 0 (does NOT error)
- `mandible issue -h|--help` → prints issue usage, exits 0
- `mandible logs -h|--help|help` → prints logs usage, exits 0
- `mandible conversations -h|--help|help` → prints conversations usage, exits 0
- `mandible search -h|--help` → prints search usage, exits 0
- `mandible artifact -h|--help|help` → prints artifact usage, exits 0
- `mandible inbox --help|-h` → prints inbox usage, exits 0

## `issue report` exit codes

The script itself only uses `die` (exit 1) or `die ... 2` for bad args. A "not found"
issue ID causes `curl -sf` to exit nonzero (HTTP 404 → curl exit 22), which propagates
as exit 1 (pipefail). Exit 3 is NOT emitted by this script — if a session saw exit 3,
it came from the shell environment, not from `mandible issue report`.
