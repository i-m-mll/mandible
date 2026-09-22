#!/usr/bin/env bash
source "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd -P)/command-syntax.sh"

set -u
set -o pipefail

CLIENT_HELPER="${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/ledger-client.sh"
source "$CLIENT_HELPER"

# Force the safer git-locks mode for all internal git invocations (matches the
# other Mandible CLI helpers). Sandboxed sessions can otherwise leave a stale
# index.lock that blocks host-side merges.
export GIT_OPTIONAL_LOCKS=0

usage() {
  cat <<'USAGE' | mandible_render_commands
Usage:
  {{command commit.trailer}}
  mandible commit linked --issue <id> [--issue <id> ...] -m <message> [opts]

`commit linked` is the linked-commit surface used by the Spaces export-and-track
docs-branch commit path (umbrella de56ffa, child 8730bf9). It is a deterministic
agent-key commit that ALWAYS carries `Mandible-Issue:` trailers, so every docs
commit passes the auth-merge promotion verification (every non-merge commit in
`main..<promote-branch>` must carry a `Mandible-Issue:` trailer). It is NEVER a
bare `git commit`.

Options for `linked`:
  --issue <id>        Issue ref for a `Mandible-Issue:` trailer (repeatable).
                      When omitted, falls back to the nearest `.issue` helper
                      file (same auto-discovery as `commit trailer`).
  -m, --message <s>   Commit subject/body (required).
  -C, --dir <path>    Run the commit in this working directory.
  --add <pathspec>    Stage this pathspec before committing (repeatable). When
                      no --add is given, the already-staged index is committed.
  --allow-empty       Pass through to `git commit --allow-empty`.
  --no-verify         Pass through to `git commit --no-verify`.

The commit is agent-key signed: signing is taken from the ambient git config
(`commit.gpgsign` + the agent signing key the dotfiles env installs when
CLAUDECODE=1). This helper never passes `--no-gpg-sign` and never disables
signing.
USAGE
}

commit_linked() {
  local -a issues=()
  local message=""
  local dir="$PWD"
  local -a add_paths=()
  local -a passthrough=()

  while (( $# > 0 )); do
    case "$1" in
      --issue)
        [[ -n "${2:-}" ]] || { mandible_ledger_err "--issue requires a value"; return 2; }
        issues+=("$2"); shift 2 ;;
      -m|--message)
        [[ -n "${2:-}" ]] || { mandible_ledger_err "$1 requires a value"; return 2; }
        message="$2"; shift 2 ;;
      -C|--dir)
        [[ -n "${2:-}" ]] || { mandible_ledger_err "$1 requires a value"; return 2; }
        dir="$2"; shift 2 ;;
      --add)
        [[ -n "${2:-}" ]] || { mandible_ledger_err "--add requires a pathspec"; return 2; }
        add_paths+=("$2"); shift 2 ;;
      --allow-empty) passthrough+=("--allow-empty"); shift ;;
      --no-verify) passthrough+=("--no-verify"); shift ;;
      -h|--help) usage; return 0 ;;
      *) mandible_ledger_err "Unknown commit linked option: $1"; usage >&2; return 2 ;;
    esac
  done

  if [[ -z "$message" ]]; then
    mandible_ledger_die "commit linked requires -m <message>" 2
    return $?
  fi
  if [[ ! -d "$dir" ]]; then
    mandible_ledger_die "commit linked: working directory not found: $dir" 2
    return $?
  fi

  # Resolve trailers from explicit issues (or .issue auto-discovery when none
  # were passed). This fails loudly when neither is available, so a docs commit
  # never silently lands without a Mandible-Issue trailer.
  local trailers
  if ! trailers="$( cd "$dir" && mandible_commit_trailers ${issues[@]+"${issues[@]}"} )"; then
    return 1
  fi
  if [[ -z "$trailers" ]]; then
    mandible_ledger_die "commit linked: no Mandible-Issue trailers resolved" 2
    return $?
  fi

  # Stage requested pathspecs (if any) inside the target worktree.
  local p
  for p in ${add_paths[@]+"${add_paths[@]}"}; do
    if ! ( cd "$dir" && git add -- "$p" ); then
      mandible_ledger_err "commit linked: git add failed for: $p"
      return 1
    fi
  done

  local full_message
  full_message="${message}"$'\n\n'"${trailers}"

  # Agent-key signed commit. Signing comes from ambient git config — never
  # --no-gpg-sign here. Expand the optional passthrough array safely under
  # `set -u` (empty arrays must not trip the nounset guard).
  ( cd "$dir" && git commit ${passthrough[@]+"${passthrough[@]}"} -m "$full_message" )
}

action="${1:-}"
shift || true

case "$action" in
  trailer|trailers) mandible_commit_trailers "$@" ;;
  linked) commit_linked "$@" ;;
  ""|-h|--help|help) usage ;;
  *) mandible_ledger_err "Unknown commit action: $action"; usage >&2; exit 2 ;;
esac
