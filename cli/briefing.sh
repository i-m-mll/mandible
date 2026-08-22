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
  mandible briefing create <artifact-version-ref> --title <text> [--comparison-base <artifact-version-ref>] [--json]
  mandible briefing bundle create --name <name> [<briefing-ref>...] [--json]
  mandible briefing bundle add <bundle-ref> <briefing-ref> [--json]
  mandible briefing bundle show <bundle-ref> [--json]

Creates a new logical Briefing whose first round is bound to exactly the named
artifact version. An optional comparison base is also resolved and pinned
exactly at creation time. This command never resolves a logical artifact or
series to latest and never adds a round to an existing Briefing.

A Briefing bundle is only a named, manually ordered association. Creating or
adding to one does not change member Briefings, rounds, artifacts, or review data.
EOF
}

emit_bundle() {
  local response="$1" json="$2"
  if (( json )); then
    printf '%s\n' "$response" | jq .
  else
    printf '%s\n' "$response" | api_jq_human \
      '.bundle | "briefing-bundle:\(.id | mandible_short_id)  \(.name)\n\([.members[]? | "  \(.position + 1). briefing:\(.briefing.id | mandible_short_id)  \(.briefing.title)"] | join("\n"))"'
  fi
}

cmd_create() {
  local artifact_version_ref="" comparison_base="" title="" json=0 response payload
  while (( $# > 0 )); do
    case "$1" in
      --title) [[ $# -ge 2 ]] || die "--title requires a value" 2; title="$2"; shift 2 ;;
      --comparison-base) [[ $# -ge 2 ]] || die "--comparison-base requires a value" 2; comparison_base="$2"; shift 2 ;;
      --json) json=1; shift ;;
      -*) die "Unknown option: $1" 2 ;;
      *) [[ -z "$artifact_version_ref" ]] || die "Unexpected argument: $1" 2; artifact_version_ref="$1"; shift ;;
    esac
  done
  [[ "$artifact_version_ref" == artifact-version:* ]] \
    || die "create requires one exact artifact-version:<id> ref" 2
  [[ -z "$comparison_base" || "$comparison_base" == artifact-version:* ]] \
    || die "--comparison-base requires one exact artifact-version:<id> ref" 2
  [[ -n "${title//[[:space:]]/}" ]] || die "create requires --title <text>" 2
  command -v jq >/dev/null 2>&1 || die "jq not found" 1
  payload="$(jq -n --arg artifact_version_ref "$artifact_version_ref" --arg comparison_base "$comparison_base" --arg title "$title" \
    '{artifact_version_ref:$artifact_version_ref,title:$title}
     + (if $comparison_base == "" then {} else {comparison_base_artifact_version_ref:$comparison_base} end)')"
  response="$(api_send POST "/api/briefings" "$payload")" || die "Failed to create Briefing from exact artifact version." 1
  if (( json )); then
    printf '%s\n' "$response" | jq .
  else
    printf '%s\n' "$response" | api_jq_human \
      '"created briefing \(.briefing_id | mandible_short_id) round \(.round_id | mandible_short_id) from \(.artifact_version_id | mandible_typed_short_ref)"'
  fi
}

cmd_bundle_create() {
  local name="" json=0 response payload
  local -a briefing_refs
  briefing_refs=()
  while (( $# > 0 )); do
    case "$1" in
      --name) [[ $# -ge 2 ]] || die "--name requires a value" 2; name="$2"; shift 2 ;;
      --json) json=1; shift ;;
      -*) die "Unknown option: $1" 2 ;;
      *) briefing_refs+=("$1"); shift ;;
    esac
  done
  [[ -n "${name//[[:space:]]/}" ]] || die "bundle create requires --name <name>" 2
  command -v jq >/dev/null 2>&1 || die "jq not found" 1
  payload="$(jq -n --arg name "$name" --args '{name:$name,briefing_refs:$ARGS.positional}' -- "${briefing_refs[@]}")"
  response="$(api_send POST "/api/briefing-bundles" "$payload")" || die "Failed to create Briefing bundle." 1
  emit_bundle "$response" "$json"
}

cmd_bundle_add() {
  local bundle_ref="" briefing_ref="" json=0 response payload
  while (( $# > 0 )); do
    case "$1" in
      --json) json=1; shift ;;
      -*) die "Unknown option: $1" 2 ;;
      *)
        if [[ -z "$bundle_ref" ]]; then bundle_ref="$1"
        elif [[ -z "$briefing_ref" ]]; then briefing_ref="$1"
        else die "Unexpected argument: $1" 2
        fi
        shift ;;
    esac
  done
  [[ -n "$bundle_ref" && -n "$briefing_ref" ]] \
    || die "Usage: mandible briefing bundle add <bundle-ref> <briefing-ref> [--json]" 2
  command -v jq >/dev/null 2>&1 || die "jq not found" 1
  payload="$(jq -n --arg briefing_ref "$briefing_ref" '{briefing_ref:$briefing_ref}')"
  response="$(api_send POST "/api/briefing-bundles/$(urlencode "$bundle_ref")/briefings" "$payload")" \
    || die "Failed to add Briefing to bundle." 1
  emit_bundle "$response" "$json"
}

cmd_bundle_show() {
  local bundle_ref="" json=0 response
  while (( $# > 0 )); do
    case "$1" in
      --json) json=1; shift ;;
      -*) die "Unknown option: $1" 2 ;;
      *) [[ -z "$bundle_ref" ]] || die "Unexpected argument: $1" 2; bundle_ref="$1"; shift ;;
    esac
  done
  [[ -n "$bundle_ref" ]] || die "Usage: mandible briefing bundle show <bundle-ref> [--json]" 2
  command -v jq >/dev/null 2>&1 || die "jq not found" 1
  response="$(api_get "/api/briefing-bundles/$(urlencode "$bundle_ref")")" \
    || die "Failed to show Briefing bundle." 1
  emit_bundle "$response" "$json"
}

cmd_bundle() {
  local subcommand="${1:-}"
  case "$subcommand" in
    "") usage; exit 2 ;;
    -h|--help|help) usage; exit 0 ;;
  esac
  shift
  case "$subcommand" in
    create) cmd_bundle_create "$@" ;;
    add) cmd_bundle_add "$@" ;;
    show) cmd_bundle_show "$@" ;;
    *) die "Unknown briefing bundle subcommand: $subcommand" 2 ;;
  esac
}

if [[ $# -eq 0 || "${1:-}" == "-h" || "${1:-}" == "--help" || "${1:-}" == "help" ]]; then
  usage
  [[ $# -eq 0 ]] && exit 2 || exit 0
fi

subcommand="$1"
shift
case "$subcommand" in
  create) cmd_create "$@" ;;
  bundle) cmd_bundle "$@" ;;
  *) die "Unknown briefing subcommand: $subcommand" 2 ;;
esac
