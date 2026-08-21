#!/usr/bin/env zsh
# mandible briefing: supported Briefing creation over the authenticated daemon API.

set -euo pipefail

API_HELPER="${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/api.sh"
source "$API_HELPER"

die() {
  printf '%s\n' "$1" >&2
  exit "${2:-1}"
}

usage() {
  cat <<'EOF'
Usage:
  mandible briefing create <artifact-version-ref> --title <text> [--json]

Creates a new logical Briefing whose first round is bound to exactly the named
artifact version. This command never resolves a logical artifact or series to
latest and never adds a round to an existing Briefing.
EOF
}

cmd_create() {
  local artifact_version_ref="" title="" json=0 response payload
  while (( $# > 0 )); do
    case "$1" in
      --title) [[ $# -ge 2 ]] || die "--title requires a value" 2; title="$2"; shift 2 ;;
      --json) json=1; shift ;;
      -*) die "Unknown option: $1" 2 ;;
      *) [[ -z "$artifact_version_ref" ]] || die "Unexpected argument: $1" 2; artifact_version_ref="$1"; shift ;;
    esac
  done
  [[ "$artifact_version_ref" == artifact-version:* ]] \
    || die "create requires one exact artifact-version:<id> ref" 2
  [[ -n "${title//[[:space:]]/}" ]] || die "create requires --title <text>" 2
  command -v jq >/dev/null 2>&1 || die "jq not found" 1
  payload="$(jq -n --arg artifact_version_ref "$artifact_version_ref" --arg title "$title" \
    '{artifact_version_ref:$artifact_version_ref,title:$title}')"
  response="$(api_send POST "/api/briefings" "$payload")" || die "Failed to create Briefing from exact artifact version." 1
  if (( json )); then
    printf '%s\n' "$response" | jq .
  else
    printf '%s\n' "$response" | api_jq_human \
      '"created briefing \(.briefing_id | mandible_short_id) round \(.round_id | mandible_short_id) from \(.artifact_version_id | mandible_typed_short_ref)"'
  fi
}

if [[ $# -eq 0 || "${1:-}" == "-h" || "${1:-}" == "--help" || "${1:-}" == "help" ]]; then
  usage
  [[ $# -eq 0 ]] && exit 2 || exit 0
fi

subcommand="$1"
shift
case "$subcommand" in
  create) cmd_create "$@" ;;
  *) die "Unknown briefing subcommand: $subcommand" 2 ;;
esac
