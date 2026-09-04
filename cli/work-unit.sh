#!/usr/bin/env bash

set -u
set -o pipefail

CLIENT_HELPER="${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/ledger-client.sh"
source "$CLIENT_HELPER"

usage() {
  cat <<'USAGE'
Usage:
  mandible work-unit claim --issue <id> --repo <repo> [--branch <branch>] [--parent-branch <branch>] [--kind solo|partition|integration] [--session <id>] [--graceful]
  mandible work-unit activate --issue <id> --repo <repo> [--branch <branch>] [--session <id>] [--worker] [--graceful]
  mandible work-unit find --repo <repo> (--issue <id> | --branch <branch>) [--state <state>] [--graceful]
  mandible work-unit resolve --id <work-unit-id> [--auth-request-id <id>] [--graceful]
  mandible work-unit release --issue <id> --repo <repo> [--graceful]
  mandible work-unit custody-assume --id <work-unit-id> --expected-generation <n> --reason <text> [--parent-role-checkpoint <id>] [--graceful]
USAGE
}

action="${1:-}"
shift || true

case "$action" in
  claim) mandible_work_unit_claim "$@" ;;
  activate) mandible_work_unit_activate "$@" ;;
  find) mandible_work_unit_find "$@" ;;
  resolve) mandible_work_unit_resolve "$@" ;;
  release) mandible_work_unit_release "$@" ;;
  custody-assume) mandible_work_unit_custody_assume "$@" ;;
  ""|-h|--help|help) usage ;;
  *) mandible_ledger_err "Unknown work-unit action: $action"; usage >&2; exit 2 ;;
esac
