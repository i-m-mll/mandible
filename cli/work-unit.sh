#!/usr/bin/env bash
source "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd -P)/command-syntax.sh"

set -u
set -o pipefail

CLIENT_HELPER="${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/ledger-client.sh"
source "$CLIENT_HELPER"

usage() {
  mandible_command_help work-unit
}

action="${1:-}"
shift || true

case "$action" in
  claim) mandible_work_unit_claim "$@" ;;
  activate) mandible_work_unit_activate "$@" ;;
  find) mandible_work_unit_find "$@" ;;
  resolve) mandible_work_unit_resolve "$@" ;;
  release) mandible_work_unit_release "$@" ;;
  release-issue) mandible_work_unit_release_issue "$@" ;;
  custody-assume) mandible_work_unit_custody_assume "$@" ;;
  ""|-h|--help|help) usage ;;
  *) mandible_ledger_err "Unknown work-unit action: $action"; usage >&2; exit 2 ;;
esac
