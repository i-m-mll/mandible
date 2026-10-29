#!/usr/bin/env zsh
# mandible — unified CLI for the Mandible daemon
#
# Usage: mandible <command> [args...]
#
# Commands:
#   wrap [--app NAME] -- <cmd>      Session lifecycle wrapper
#   task <description>               Set session task status
#   reminder <subcommand>            Create, show, list, and cancel reminders
#   inbox [check|ack|watch|add]      Manage session inbox
#   issue <subcommand>               Issue operations (close, comment, show, refs, markdown)
#   changes --project <ref>          Read the bounded ledger change feed
#   umbrella status <id>             Print coordinator fact packet
#   description <subcommand>         Alias for issue description operations
#   auth list [opts]                 List active auth requests
#   auth action <subcommand>         Manage staged auth request actions
#   auth check [opts]                Check queued merge independence
#   auth clearance <subcommand>      Manage scoped protected-merge clearances
#   auth request [branch] [opts]     Submit an approval request
#   auth withdraw <id> --reason ... --expected-revision N --expected-custody-generation N
#   auth candidate-repair inspect|apply <id> [opts]
#   auth replay-archives <id>        Replay Codex archive attempts
#   auth acceptance run|show <id>    Run or show candidate acceptance of a self-update
#   auth retry-convergence <id>     Retry failed convergence hooks without merging
#   auth handoff status|recover|retire  Inspect, recover or retire the runtime handoff
#   auth merge <branch> [opts]       Execute authenticated merge
#   logs <subcommand>                Inspect source logs and retained daemon telemetry
#   conversations <subcommand>       Inspect DB-backed conversations
#   conversation-cutover <command>   Build and audit source-backed cutover proof
#   db <subcommand>                  Read-only SQL over the live ledger database
#   artifact <subcommand>            Register, resolve, link, and check artifacts
#   briefing create <version-ref>    Create a Briefing from one exact artifact version
#   briefing rename <briefing-ref>   Rename an existing Briefing in place
#   briefing describe <briefing-ref> Set or clear a Briefing description
#   briefing archive|restore <ref>   Hide or restore a Briefing organizationally
#   briefing bundle <subcommand>     Create, add to, replace, rename, and show review bundles
#   space <subcommand>               Authored organizing surfaces (create, items, edges, seed)
#   project <subcommand>             Canonical project registry (list, show, add, audit, repair)
#   user <subcommand>                User registry (setup, list, show, credential, token, binding)
#   credential redact <id>           Mask a leaked credential in stored transcripts
#   claude-integration <subcommand>  Install/uninstall Claude hook and statusline integration
#   instructions <subcommand>        Install or diff the Mandible instruction fragment
#   work-unit <subcommand>           Policy-free work-unit lifecycle client
#   trash <subcommand>               Reversible branch/worktree trash custody
#   issue-file <subcommand>          Read/write the .issue helper file
#   session link-issue <id> ...      Link sessions to issues
#   help                             Show this help

set -euo pipefail

export GIT_OPTIONAL_LOCKS=0

# Resolve script's own directory robustly — no realpath (not standard on macOS)
export MANDIBLE_CLI_DIR="$(cd "$(dirname "$0")" && pwd -P)"
case "${1:-}" in
  hook)
    shift
    case "${1:-}" in
      session-execution)
        shift
        source "$MANDIBLE_CLI_DIR/command-syntax.sh"
        exec "$(mandible_bun_runtime)" --no-install "$(mandible_cli_module cli/session-execution)" "$@" ;;
      session-start|session-end|subagent-start|subagent-stop) hook=$1; shift; exec "$MANDIBLE_CLI_DIR/../hooks/$hook.sh" "$@" ;;
      ingest-nudge|notification|statusline) hook=$1; shift; exec "$MANDIBLE_CLI_DIR/hooks/mandible-claude-$hook.sh" "$@" ;;
      *) echo "Usage: mandible hook <ingest-nudge|notification|statusline|session-execution|session-start|session-end|subagent-start|subagent-stop>" >&2; exit 2 ;;
    esac ;;
  channel) shift; exec "$("$MANDIBLE_CLI_DIR/../scripts/bun-runtime.sh")" --no-install "$MANDIBLE_CLI_DIR/../dist/channel-server/index.js" "$@" ;;
  git-guard) shift; exec "$MANDIBLE_CLI_DIR/../hooks/git/reference-transaction" "$@" ;;
esac
source "$MANDIBLE_CLI_DIR/canonical-origin.sh"
export MANDIBLE_PORT="${MANDIBLE_PORT:-$MANDIBLE_DEFAULT_BACKEND_PORT}"
# api.sh selects the private socket when no transport was explicitly chosen.
source "$MANDIBLE_CLI_DIR/api.sh"
# Every subcommand inherits the caller's own identity, never a parent agent's.
api_scope_inherited_identity

usage() {
  mandible_command_help
}

auth_usage() {
  mandible_command_help auth
}

case "${1:-}" in
  identity)
    if [[ "${2:-}" != exec || "${3:-}" != -- || $# -lt 4 ]]; then
      printf 'Usage: mandible identity exec -- <command> [args...]\n' >&2; exit 2
    fi
    shift 3
    exec "$@" ;;
  settings)
    if [[ $# != 2 || "${2:-}" != read ]]; then
      mandible_command_help settings >&2; exit 2
    fi
    api_get /api/settings ;;
  wrap)    shift; exec "$MANDIBLE_CLI_DIR/wrap.sh" "$@" ;;
  task)    shift; exec "$MANDIBLE_CLI_DIR/task.sh" "$@" ;;
  reminder) shift; exec "$MANDIBLE_CLI_DIR/reminder.sh" "$@" ;;
  inbox)   shift; exec "$MANDIBLE_CLI_DIR/inbox.sh" "$@" ;;
  issue)   shift; exec "$MANDIBLE_CLI_DIR/issue.sh" "$@" ;;
  changes) shift; exec "$MANDIBLE_CLI_DIR/changes.sh" "$@" ;;
  umbrella) shift; exec "$MANDIBLE_CLI_DIR/umbrella.sh" "$@" ;;
  description) shift; exec "$MANDIBLE_CLI_DIR/issue.sh" description "$@" ;;
  auth)
    shift
    case "${1:-}" in
      ""|-h|--help|help) auth_usage ;;
      list)    shift; exec "$MANDIBLE_CLI_DIR/auth-list.sh" "$@" ;;
      show)    shift; exec "$MANDIBLE_CLI_DIR/auth-show.sh" "$@" ;;
      action)  shift; exec "$MANDIBLE_CLI_DIR/auth-action.sh" "$@" ;;
      check)   shift; exec "$MANDIBLE_CLI_DIR/auth-check.sh" "$@" ;;
      clearance) shift; exec "$MANDIBLE_CLI_DIR/auth-clearance.sh" "$@" ;;
      request) shift; exec "$MANDIBLE_CLI_DIR/auth-request.sh" "$@" ;;
      withdraw) shift; exec "$MANDIBLE_CLI_DIR/auth-withdraw.sh" "$@" ;;
      candidate-repair) shift; exec "$MANDIBLE_CLI_DIR/auth-candidate-repair.sh" "$@" ;;
      replay-archives) shift; exec "$MANDIBLE_CLI_DIR/auth-replay-archives.sh" "$@" ;;
      acceptance) shift; exec "$MANDIBLE_CLI_DIR/auth-acceptance.sh" "$@" ;;
      retry-convergence) shift; exec "$MANDIBLE_CLI_DIR/auth-retry-convergence.sh" "$@" ;;
      retire-delivery) shift; exec "$MANDIBLE_CLI_DIR/auth-retire-delivery.sh" "$@" ;;
      handoff) shift; exec "$MANDIBLE_CLI_DIR/auth-handoff.sh" "$@" ;;
      merge)   shift; exec "$MANDIBLE_CLI_DIR/auth-merge.sh" "$@" ;;
      *) echo "Unknown auth subcommand: ${1:-}" >&2; usage >&2; exit 1 ;;
    esac
    ;;
  logs)    shift; exec "$MANDIBLE_CLI_DIR/logs.sh" "$@" ;;
  conversations) shift; exec "$MANDIBLE_CLI_DIR/conversations.sh" "$@" ;;
  conversation-cutover) shift; exec "$MANDIBLE_CLI_DIR/conversation-cutover.sh" "$@" ;;
  db)      shift; exec "$MANDIBLE_CLI_DIR/db.sh" "$@" ;;
  artifact) shift; exec "$MANDIBLE_CLI_DIR/artifact.sh" "$@" ;;
  briefing) shift; exec "$MANDIBLE_CLI_DIR/briefing.sh" "$@" ;;
  space) shift; exec "$MANDIBLE_CLI_DIR/space.sh" "$@" ;;
  project) shift; exec "$MANDIBLE_CLI_DIR/project.sh" "$@" ;;
  user) shift; exec "$MANDIBLE_CLI_DIR/user.sh" "$@" ;;
  credential) shift; exec "$MANDIBLE_CLI_DIR/credential.sh" "$@" ;;
  claude-integration) shift; exec "$MANDIBLE_CLI_DIR/claude-integration.sh" "$@" ;;
  instructions) shift; exec "$MANDIBLE_CLI_DIR/instructions.sh" "$@" ;;
  work-unit) shift; exec "$MANDIBLE_CLI_DIR/work-unit.sh" "$@" ;;
  trash) shift; exec "$MANDIBLE_CLI_DIR/trash.sh" "$@" ;;
  issue-file) shift; exec "$MANDIBLE_CLI_DIR/issue-file.sh" "$@" ;;
  session) shift; exec "$MANDIBLE_CLI_DIR/session.sh" "$@" ;;
  help) shift; if (( $# )); then mandible_command_help "$@"; else usage; fi ;;
  -h|--help) usage ;;
  "") usage >&2; exit 1 ;;
  *) echo "Unknown command: $1" >&2; usage >&2; exit 1 ;;
esac
