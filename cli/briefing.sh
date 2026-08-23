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
  mandible briefing rename <briefing-ref> --title <text> [--json]
  mandible briefing archive <briefing-ref> [--json]
  mandible briefing restore <briefing-ref> [--json]
  mandible briefing bundle create --name <name> [<briefing-ref>...] [--json]
  mandible briefing bundle add <bundle-ref> <briefing-ref> [--json]
  mandible briefing bundle replace <bundle-ref> [<briefing-ref>...] [--layout <json>] [--json]
  mandible briefing bundle rename <bundle-ref> --name <text> [--json]
  mandible briefing bundle show <bundle-ref> [--json]
  mandible briefing group create --name <name> [--current <bundle-ref>] [<proposal-bundle-ref>...] [--json]
  mandible briefing group add <group-ref> <bundle-ref> [--json]
  mandible briefing group configure <group-ref> --current <bundle-ref|none> [<proposal-bundle-ref>...] [--json]
  mandible briefing group rename <group-ref> --name <text> [--json]
  mandible briefing group show <group-ref> [--json]

Creates a new logical Briefing whose first round is bound to exactly the named
artifact version. An optional comparison base is also resolved and pinned
exactly at creation time. This command never resolves a logical artifact or
series to latest and never adds a round to an existing Briefing.

A Briefing bundle is only a named, manually ordered association. Creating or
adding to one does not change member Briefings, rounds, artifacts, or review data.
EOF
}

cmd_archive_state() {
  local action="$1" briefing_ref="" json=0 response
  shift
  while (( $# > 0 )); do
    case "$1" in
      --json) json=1; shift ;;
      -*) die "Unknown option: $1" 2 ;;
      *) [[ -z "$briefing_ref" ]] || die "Unexpected argument: $1" 2; briefing_ref="$1"; shift ;;
    esac
  done
  [[ -n "$briefing_ref" ]] || die "Usage: mandible briefing $action <briefing-ref> [--json]" 2
  response="$(api_send POST "/api/briefings/$(urlencode "$briefing_ref")/$action" '{}')" \
    || die "Failed to ${action} Briefing." 1
  if (( json )); then
    printf '%s\n' "$response" | jq .
  else
    printf '%s\n' "$response" | api_jq_human \
      "\"${action}d briefing \\(.briefing_id | mandible_short_id)\""
  fi
}

cmd_rename() {
  local briefing_ref="" title="" json=0 response payload
  while (( $# > 0 )); do
    case "$1" in
      --title) [[ $# -ge 2 ]] || die "--title requires a value" 2; title="$2"; shift 2 ;;
      --json) json=1; shift ;;
      -*) die "Unknown option: $1" 2 ;;
      *) [[ -z "$briefing_ref" ]] || die "Unexpected argument: $1" 2; briefing_ref="$1"; shift ;;
    esac
  done
  [[ -n "$briefing_ref" && -n "${title//[[:space:]]/}" ]] \
    || die "Usage: mandible briefing rename <briefing-ref> --title <text> [--json]" 2
  command -v jq >/dev/null 2>&1 || die "jq not found" 1
  payload="$(jq -n --arg title "$title" '{title:$title}')"
  response="$(api_send PATCH "/api/briefings/$(urlencode "$briefing_ref")" "$payload")" \
    || die "Failed to rename Briefing." 1
  if (( json )); then
    printf '%s\n' "$response" | jq .
  else
    printf '%s\n' "$response" | api_jq_human \
      '"briefing:\(.briefing_id | mandible_short_id)  \(.title)"'
  fi
}

emit_bundle() {
  local response="$1" json="$2"
  if (( json )); then
    printf '%s\n' "$response" | jq .
  else
    printf '%s\n' "$response" | api_jq_human \
      '.bundle | "briefing-bundle:\(.id | mandible_short_id)  \(.name)\n\(
        if (.layout? | type) == "array" then
          [.layout[]? | if .kind == "briefing" then
            "  \(.position + 1). briefing:\(.briefing.id | mandible_short_id)  \(.briefing.title)"
          else
            "  \(.position + 1). \(.name)\n\([.briefings[]? |
              "    \(.position + 1). briefing:\(.briefing.id | mandible_short_id)  \(.briefing.title)"] | join("\n"))"
          end] | join("\n")
        else
          [.members[]? | "  \(.position + 1). briefing:\(.briefing.id | mandible_short_id)  \(.briefing.title)"] | join("\n")
        end
      )"'
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

cmd_bundle_replace() {
  local bundle_ref="" layout="" json=0 response payload
  local -a briefing_refs
  briefing_refs=()
  while (( $# > 0 )); do
    case "$1" in
      --json) json=1; shift ;;
      --layout) [[ $# -ge 2 ]] || die "--layout requires a JSON value" 2; layout="$2"; shift 2 ;;
      -*) die "Unknown option: $1" 2 ;;
      *)
        if [[ -z "$bundle_ref" ]]; then bundle_ref="$1"
        else briefing_refs+=("$1")
        fi
        shift ;;
    esac
  done
  [[ -n "$bundle_ref" ]] \
    || die "Usage: mandible briefing bundle replace <bundle-ref> [<briefing-ref>...] [--layout <json>] [--json]" 2
  [[ -z "$layout" || ${#briefing_refs[@]} -eq 0 ]] \
    || die "bundle replace accepts either flat Briefing refs or --layout, not both" 2
  command -v jq >/dev/null 2>&1 || die "jq not found" 1
  if [[ -n "$layout" ]]; then
    payload="$(printf '%s' "$layout" | jq -ce 'if type == "array" then {layout:.} else error("layout must be an array") end')" \
      || die "--layout must be valid JSON containing an array" 2
  else
    payload="$(jq -n --args '{briefing_refs:$ARGS.positional}' -- "${briefing_refs[@]}")"
  fi
  response="$(api_send PATCH "/api/briefing-bundles/$(urlencode "$bundle_ref")" "$payload")" \
    || die "Failed to replace Briefing bundle membership." 1
  emit_bundle "$response" "$json"
}

emit_group() {
  local response="$1" json="$2"
  if (( json )); then
    printf '%s\n' "$response" | jq .
  else
    printf '%s\n' "$response" | api_jq_human \
      '.group | "briefing-group:\(.id | mandible_short_id)  \(.name)\n  current: \(
        if .current == null then "none" else "\(.current.id | mandible_short_id)  \(.current.name)" end
      )\n\([.updates[]? | "  proposal: \(.id | mandible_short_id)  \(.name)"] | join("\n"))"'
  fi
}

cmd_group_create() {
  local name="" current_bundle_ref="" json=0 response payload
  local -a bundle_refs=()
  while (( $# > 0 )); do
    case "$1" in
      --name) [[ $# -ge 2 ]] || die "--name requires a value" 2; name="$2"; shift 2 ;;
      --current) [[ $# -ge 2 ]] || die "--current requires a value" 2; current_bundle_ref="$2"; shift 2 ;;
      --json) json=1; shift ;;
      -*) die "Unknown option: $1" 2 ;;
      *) bundle_refs+=("$1"); shift ;;
    esac
  done
  [[ -n "${name//[[:space:]]/}" ]] || die "group create requires --name <name>" 2
  command -v jq >/dev/null 2>&1 || die "jq not found" 1
  payload="$(jq -n --arg name "$name" --arg current "$current_bundle_ref" --args \
    '{name:$name,bundle_refs:$ARGS.positional} + (if $current == "" then {} else {current_bundle_ref:$current} end)' \
    -- "${bundle_refs[@]}")"
  response="$(api_send POST "/api/briefing-groups" "$payload")" || die "Failed to create Briefing group." 1
  emit_group "$response" "$json"
}

cmd_group_configure() {
  local group_ref="" current_bundle_ref="" current_set=0 json=0 response payload
  local -a bundle_refs=()
  while (( $# > 0 )); do
    case "$1" in
      --current) [[ $# -ge 2 ]] || die "--current requires a value" 2
        current_bundle_ref="$2"; current_set=1; shift 2 ;;
      --json) json=1; shift ;;
      -*) die "Unknown option: $1" 2 ;;
      *) if [[ -z "$group_ref" ]]; then group_ref="$1"; else bundle_refs+=("$1"); fi; shift ;;
    esac
  done
  [[ -n "$group_ref" && $current_set -eq 1 ]] \
    || die "Usage: mandible briefing group configure <group-ref> --current <bundle-ref|none> [<proposal-bundle-ref>...] [--json]" 2
  [[ -n "${current_bundle_ref//[[:space:]]/}" ]] || die "--current requires a nonblank bundle ref or none" 2
  command -v jq >/dev/null 2>&1 || die "jq not found" 1
  payload="$(jq -n --arg current "$current_bundle_ref" --args \
    '{current_bundle_ref:(if $current == "none" then null else $current end),bundle_refs:$ARGS.positional}' \
    -- "${bundle_refs[@]}")"
  response="$(api_send PUT "/api/briefing-groups/$(urlencode "$group_ref")/configuration" "$payload")" \
    || die "Failed to configure Briefing group." 1
  emit_group "$response" "$json"
}

cmd_group_add() {
  local group_ref="" bundle_ref="" json=0 response payload
  while (( $# > 0 )); do
    case "$1" in
      --json) json=1; shift ;;
      -*) die "Unknown option: $1" 2 ;;
      *) if [[ -z "$group_ref" ]]; then group_ref="$1"; elif [[ -z "$bundle_ref" ]]; then bundle_ref="$1";
         else die "Unexpected argument: $1" 2; fi; shift ;;
    esac
  done
  [[ -n "$group_ref" && -n "$bundle_ref" ]] || die "Usage: mandible briefing group add <group-ref> <bundle-ref> [--json]" 2
  command -v jq >/dev/null 2>&1 || die "jq not found" 1
  payload="$(jq -n --arg bundle_ref "$bundle_ref" '{bundle_ref:$bundle_ref}')"
  response="$(api_send POST "/api/briefing-groups/$(urlencode "$group_ref")/updates" "$payload")" \
    || die "Failed to add update to Briefing group." 1
  emit_group "$response" "$json"
}

cmd_group_rename() {
  local group_ref="" name="" json=0 response payload
  while (( $# > 0 )); do
    case "$1" in
      --name) [[ $# -ge 2 ]] || die "--name requires a value" 2; name="$2"; shift 2 ;;
      --json) json=1; shift ;;
      -*) die "Unknown option: $1" 2 ;;
      *) [[ -z "$group_ref" ]] || die "Unexpected argument: $1" 2; group_ref="$1"; shift ;;
    esac
  done
  [[ -n "$group_ref" && -n "${name//[[:space:]]/}" ]] || die "Usage: mandible briefing group rename <group-ref> --name <text> [--json]" 2
  command -v jq >/dev/null 2>&1 || die "jq not found" 1
  payload="$(jq -n --arg name "$name" '{name:$name}')"
  response="$(api_send PATCH "/api/briefing-groups/$(urlencode "$group_ref")" "$payload")" \
    || die "Failed to rename Briefing group." 1
  emit_group "$response" "$json"
}

cmd_group_show() {
  local group_ref="" json=0 response
  while (( $# > 0 )); do
    case "$1" in
      --json) json=1; shift ;;
      -*) die "Unknown option: $1" 2 ;;
      *) [[ -z "$group_ref" ]] || die "Unexpected argument: $1" 2; group_ref="$1"; shift ;;
    esac
  done
  [[ -n "$group_ref" ]] || die "Usage: mandible briefing group show <group-ref> [--json]" 2
  response="$(api_get "/api/briefing-groups/$(urlencode "$group_ref")")" || die "Failed to show Briefing group." 1
  emit_group "$response" "$json"
}

cmd_group() {
  local subcommand="${1:-}"
  case "$subcommand" in "" ) usage; exit 2 ;; -h|--help|help) usage; exit 0 ;; esac
  shift
  case "$subcommand" in
    create) cmd_group_create "$@" ;; add) cmd_group_add "$@" ;; configure) cmd_group_configure "$@" ;;
    rename) cmd_group_rename "$@" ;;
    show) cmd_group_show "$@" ;; *) die "Unknown briefing group subcommand: $subcommand" 2 ;;
  esac
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

cmd_bundle_rename() {
  local bundle_ref="" name="" json=0 response payload
  while (( $# > 0 )); do
    case "$1" in
      --name) [[ $# -ge 2 ]] || die "--name requires a value" 2; name="$2"; shift 2 ;;
      --json) json=1; shift ;;
      -*) die "Unknown option: $1" 2 ;;
      *) [[ -z "$bundle_ref" ]] || die "Unexpected argument: $1" 2; bundle_ref="$1"; shift ;;
    esac
  done
  [[ -n "$bundle_ref" && -n "${name//[[:space:]]/}" ]] \
    || die "Usage: mandible briefing bundle rename <bundle-ref> --name <text> [--json]" 2
  command -v jq >/dev/null 2>&1 || die "jq not found" 1
  payload="$(jq -n --arg name "$name" '{name:$name}')"
  response="$(api_send PATCH "/api/briefing-bundles/$(urlencode "$bundle_ref")" "$payload")" \
    || die "Failed to rename Briefing bundle." 1
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
    replace) cmd_bundle_replace "$@" ;;
    rename) cmd_bundle_rename "$@" ;;
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
  rename) cmd_rename "$@" ;;
  archive) cmd_archive_state archive "$@" ;;
  restore) cmd_archive_state restore "$@" ;;
  bundle) cmd_bundle "$@" ;;
  group) cmd_group "$@" ;;
  *) die "Unknown briefing subcommand: $subcommand" 2 ;;
esac
