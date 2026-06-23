#!/usr/bin/env zsh
# mandible space: authored-organizing-surface CLI over the Mandible daemon API.
#
# Non-block subcommands of the Spaces surface (UMBRELLA-PLAN §5.2). The `block`
# subcommands are owned by C4b and are intentionally absent here.
#
# All write paths consume the C2 REST routes (`/api/spaces...`) — this CLI does
# NOT touch the database directly. `promote-edge` reuses the existing ledger
# relationship writer (`POST /api/ledger/relationships`); it never mints a
# parallel relationship edge, and it refuses edges whose endpoints are
# artifact/URI occurrences (ledger edges allow only issue/comment endpoints).

set -euo pipefail

API_HELPER="${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/api.sh"
source "$API_HELPER"

RESET=$'\033[0m'
RED=$'\033[31m'

# The 9 ledger relationship link types accepted by POST /api/ledger/relationships
# (see src/db.ts ledger_relationship_edges CHECK constraint). promote-edge
# constrains --link-type to this set before calling the route.
LEDGER_LINK_TYPES=(parent_child blocks duplicate_of related references fixed_by caused_by implements tests)

err() {
  printf "%b\n" "$*" >&2
}

die() {
  err "$1"
  exit "${2:-1}"
}

usage() {
  cat <<'EOF'
Usage:
  mandible space create --project <id> --title <text> [--renderer <r>] [--description <text>] [--json]
  mandible space list --project <id> [--json]
  mandible space show <space-id> [--json]
  mandible space add-item <space-id> <ref> [--title <text>] [--json]
  mandible space rm-item <space-id> <item-id> [--json]
  mandible space place <space-id> [--item <item-id>] [--renderer <r>] [--x N] [--y N] [--width N] [--height N] [--parent <occ-id>] [--section <id>] [--note <text>] [--json]
  mandible space link <space-id> --source <occ-id> --target <occ-id> [--label <text>] [--style <text>] [--json]
  mandible space unlink <space-id> <edge-id> [--json]
  mandible space promote-edge --source <ref> --target <ref> [--link-type <type>] [--space <id>] [--edge <id>] [--note <text>] [--json]
  mandible space seed-from-filter <space-id> --predicate <json> [--with-shelf] [--no-artifacts] [--json]

Refs (add-item, promote-edge):
  issue:<id>                  ref_type=issue
  comment:<id>                ref_type=comment
  artifact:sha256:<hash>      ref_type=artifact   (not ledger-promotable)
  artifact:<hash>             ref_type=artifact   (not ledger-promotable)
  uri:<...>                   ref_type=external_ref (not ledger-promotable)

Link types (promote-edge --link-type, default references):
  parent_child blocks duplicate_of related references fixed_by caused_by implements tests
EOF
}

require_tools() {
  api_is_file_rpc || command -v curl >/dev/null 2>&1 || die "curl not found." 1
  command -v jq >/dev/null 2>&1 || die "jq not found." 1
}

api_post() {
  api_send POST "$1" "$2"
}

emit() {
  # $1 = json result, $2 = json flag, $3 = human jq filter
  local result="$1" json="$2" human="$3"
  if (( json )); then
    printf '%s\n' "$result" | jq .
  else
    printf '%s\n' "$result" | jq -r "$human"
  fi
}

# Parse a canonical ref (`issue:`/`comment:`/`artifact:`/`uri:` or bare) into a
# `{ref_type, ref_id, ref_uri}` JSON object matching the C2 item contract.
# external_ref carries the raw URI in ref_id and ref_uri; issue/comment/artifact
# carry the entity id in ref_id.
parse_item_ref() {
  local ref="$1"
  local prefix rest
  case "$ref" in
    issue:*)
      rest="${ref#issue:}"
      [[ -n "$rest" ]] || die "issue ref requires an id: issue:<id>" 2
      jq -n --arg id "$rest" '{ref_type:"issue", ref_id:$id, ref_uri:null}'
      ;;
    comment:*)
      rest="${ref#comment:}"
      [[ -n "$rest" ]] || die "comment ref requires an id: comment:<id>" 2
      jq -n --arg id "$rest" '{ref_type:"comment", ref_id:$id, ref_uri:null}'
      ;;
    artifact:*)
      rest="${ref#artifact:}"
      [[ -n "$rest" ]] || die "artifact ref requires a hash: artifact:sha256:<hash>" 2
      # Preserve the canonical artifact id form as ref_id.
      jq -n --arg id "$ref" '{ref_type:"artifact", ref_id:$id, ref_uri:null}'
      ;;
    uri:*)
      rest="${ref#uri:}"
      [[ -n "$rest" ]] || die "uri ref requires a target: uri:<...>" 2
      jq -n --arg uri "$rest" '{ref_type:"external_ref", ref_id:$uri, ref_uri:$uri}'
      ;;
    *)
      die "Unrecognized ref '${ref}'. Use issue:<id>, comment:<id>, artifact:sha256:<hash>, or uri:<...>." 2
      ;;
  esac
}

# Classify a ref for promote-edge: issue/comment endpoints are ledger-promotable;
# artifact/external_ref endpoints are not. Echoes the ref_type.
ref_kind() {
  case "$1" in
    issue:*) printf 'issue' ;;
    comment:*) printf 'comment' ;;
    artifact:*) printf 'artifact' ;;
    uri:*) printf 'external_ref' ;;
    *) printf 'unknown' ;;
  esac
}

cmd_create() {
  local project="" title="" renderer="" description="" json=0
  while (( $# > 0 )); do
    case "$1" in
      --project) project="$2"; shift 2 ;;
      --title) title="$2"; shift 2 ;;
      --renderer) renderer="$2"; shift 2 ;;
      --description) description="$2"; shift 2 ;;
      --json) json=1; shift ;;
      -*) die "Unknown option: $1" 2 ;;
      *) die "Unexpected argument: $1" 2 ;;
    esac
  done
  [[ -n "$project" && -n "$title" ]] || die "Usage: mandible space create --project <id> --title <text> [--renderer <r>] [--description <text>] [--json]" 2
  require_tools
  local payload response
  payload="$(jq -n --arg project "$project" --arg title "$title" --arg renderer "$renderer" --arg description "$description" \
    '{project_id:$project, title:$title}
     + (if $renderer == "" then {} else {default_renderer:$renderer} end)
     + (if $description == "" then {} else {description:$description} end)')"
  response="$(api_post "/api/spaces" "$payload")" || die "${RED}Failed to create space.${RESET}" 1
  emit "$response" "$json" '.space | "\(.id) \(.title) renderer:\(.default_renderer)"'
}

cmd_list() {
  local project="" json=0
  while (( $# > 0 )); do
    case "$1" in
      --project) project="$2"; shift 2 ;;
      --json) json=1; shift ;;
      -*) die "Unknown option: $1" 2 ;;
      *) die "Unexpected argument: $1" 2 ;;
    esac
  done
  [[ -n "$project" ]] || die "Usage: mandible space list --project <id> [--json]" 2
  require_tools
  local response
  response="$(api_get "/api/spaces?project_id=$(urlencode "$project")")" || die "${RED}Failed to list spaces.${RESET}" 1
  emit "$response" "$json" '.spaces[]? | "\(.id) \(.title) renderer:\(.default_renderer)"'
}

cmd_show() {
  local id="" json=0
  while (( $# > 0 )); do
    case "$1" in
      --json) json=1; shift ;;
      -*) die "Unknown option: $1" 2 ;;
      *) [[ -z "$id" ]] || die "Unexpected argument: $1" 2; id="$1"; shift ;;
    esac
  done
  [[ -n "$id" ]] || die "Usage: mandible space show <space-id> [--json]" 2
  require_tools
  local response
  response="$(api_get "/api/spaces/$(urlencode "$id")")" || die "${RED}Failed to show space.${RESET}" 1
  emit "$response" "$json" '.space | "\(.id)\ntitle: \(.title)\nrenderer: \(.default_renderer)\nproject: \(.project_id)\ndescription: \(.description // "-")"'
}

cmd_add_item() {
  local id="" ref="" title="" json=0
  while (( $# > 0 )); do
    case "$1" in
      --title) title="$2"; shift 2 ;;
      --json) json=1; shift ;;
      -*) die "Unknown option: $1" 2 ;;
      *)
        if [[ -z "$id" ]]; then id="$1";
        elif [[ -z "$ref" ]]; then ref="$1";
        else die "Unexpected argument: $1" 2; fi
        shift ;;
    esac
  done
  [[ -n "$id" && -n "$ref" ]] || die "Usage: mandible space add-item <space-id> <ref> [--title <text>] [--json]" 2
  require_tools
  local parsed payload response
  parsed="$(parse_item_ref "$ref")"
  payload="$(printf '%s' "$parsed" | jq --arg title "$title" \
    '{ref_type, ref_id}
     + (if .ref_uri == null then {} else {ref_uri:.ref_uri} end)
     + (if $title == "" then {} else {title:$title} end)')"
  response="$(api_post "/api/spaces/$(urlencode "$id")/items" "$payload")" || die "${RED}Failed to add item.${RESET}" 1
  emit "$response" "$json" '"\(if .created then "added" else "exists" end) \(.item.id) \(.item.ref_type):\(.item.ref_id)"'
}

cmd_rm_item() {
  local id="" item_id="" json=0
  while (( $# > 0 )); do
    case "$1" in
      --json) json=1; shift ;;
      -*) die "Unknown option: $1" 2 ;;
      *)
        if [[ -z "$id" ]]; then id="$1";
        elif [[ -z "$item_id" ]]; then item_id="$1";
        else die "Unexpected argument: $1" 2; fi
        shift ;;
    esac
  done
  [[ -n "$id" && -n "$item_id" ]] || die "Usage: mandible space rm-item <space-id> <item-id> [--json]" 2
  require_tools
  local response
  response="$(api_send DELETE "/api/spaces/$(urlencode "$id")/items/$(urlencode "$item_id")" "")" \
    || die "${RED}Failed to remove item.${RESET}" 1
  emit "$response" "$json" '"removed \(.id)"'
}

cmd_place() {
  local id="" item="" renderer="" parent="" section="" note="" json=0
  local x="" y="" width="" height=""
  while (( $# > 0 )); do
    case "$1" in
      --item) item="$2"; shift 2 ;;
      --renderer) renderer="$2"; shift 2 ;;
      --x) x="$2"; shift 2 ;;
      --y) y="$2"; shift 2 ;;
      --width) width="$2"; shift 2 ;;
      --height) height="$2"; shift 2 ;;
      --parent) parent="$2"; shift 2 ;;
      --section) section="$2"; shift 2 ;;
      --note) note="$2"; shift 2 ;;
      --json) json=1; shift ;;
      -*) die "Unknown option: $1" 2 ;;
      *) [[ -z "$id" ]] || die "Unexpected argument: $1" 2; id="$1"; shift ;;
    esac
  done
  [[ -n "$id" ]] || die "Usage: mandible space place <space-id> [--item <item-id>] [--renderer <r>] [--x N] [--y N] ... [--json]" 2
  require_tools
  local payload response
  payload="$(jq -n \
    --arg item "$item" --arg renderer "$renderer" --arg parent "$parent" \
    --arg section "$section" --arg note "$note" \
    --arg x "$x" --arg y "$y" --arg width "$width" --arg height "$height" \
    '{}
     + (if $item == "" then {} else {item_id:$item} end)
     + (if $renderer == "" then {} else {renderer:$renderer} end)
     + (if $parent == "" then {} else {parent_id:$parent} end)
     + (if $section == "" then {} else {section_id:$section} end)
     + (if $note == "" then {} else {note:$note} end)
     + (if $x == "" then {} else {x:($x|tonumber)} end)
     + (if $y == "" then {} else {y:($y|tonumber)} end)
     + (if $width == "" then {} else {width:($width|tonumber)} end)
     + (if $height == "" then {} else {height:($height|tonumber)} end)')"
  response="$(api_post "/api/spaces/$(urlencode "$id")/occurrences" "$payload")" || die "${RED}Failed to place occurrence.${RESET}" 1
  emit "$response" "$json" '.occurrence | "placed \(.id) renderer:\(.renderer) item:\(.item_id // "-")"'
}

cmd_link() {
  local id="" source="" target="" label="" style="" json=0
  while (( $# > 0 )); do
    case "$1" in
      --source) source="$2"; shift 2 ;;
      --target) target="$2"; shift 2 ;;
      --label) label="$2"; shift 2 ;;
      --style) style="$2"; shift 2 ;;
      --json) json=1; shift ;;
      -*) die "Unknown option: $1" 2 ;;
      *) [[ -z "$id" ]] || die "Unexpected argument: $1" 2; id="$1"; shift ;;
    esac
  done
  [[ -n "$id" && -n "$source" && -n "$target" ]] || die "Usage: mandible space link <space-id> --source <occ-id> --target <occ-id> [--label <text>] [--style <text>] [--json]" 2
  require_tools
  local payload response
  payload="$(jq -n --arg source "$source" --arg target "$target" --arg label "$label" --arg style "$style" \
    '{source:$source, target:$target}
     + (if $label == "" then {} else {label:$label} end)
     + (if $style == "" then {} else {style:$style} end)')"
  response="$(api_post "/api/spaces/$(urlencode "$id")/edges" "$payload")" || die "${RED}Failed to link occurrences.${RESET}" 1
  emit "$response" "$json" '.edge | "linked \(.id) \(.source) -> \(.target)"'
}

cmd_unlink() {
  local id="" edge_id="" json=0
  while (( $# > 0 )); do
    case "$1" in
      --json) json=1; shift ;;
      -*) die "Unknown option: $1" 2 ;;
      *)
        if [[ -z "$id" ]]; then id="$1";
        elif [[ -z "$edge_id" ]]; then edge_id="$1";
        else die "Unexpected argument: $1" 2; fi
        shift ;;
    esac
  done
  [[ -n "$id" && -n "$edge_id" ]] || die "Usage: mandible space unlink <space-id> <edge-id> [--json]" 2
  require_tools
  local response
  response="$(api_send DELETE "/api/spaces/$(urlencode "$id")/edges/$(urlencode "$edge_id")" "")" \
    || die "${RED}Failed to unlink edge.${RESET}" 1
  emit "$response" "$json" '"unlinked \(.id)"'
}

# promote-edge: turn a canvas edge into a durable ledger relationship via the
# existing POST /api/ledger/relationships route. Both endpoints must be
# issue/comment refs (ledger edges allow only issue/comment endpoints). An
# artifact/URI endpoint yields a deterministic "not promotable" result and the
# ledger route is never called.
cmd_promote_edge() {
  local source="" target="" link_type="references" space="" edge="" note="" json=0
  while (( $# > 0 )); do
    case "$1" in
      --source) source="$2"; shift 2 ;;
      --target) target="$2"; shift 2 ;;
      --link-type) link_type="$2"; shift 2 ;;
      --space) space="$2"; shift 2 ;;
      --edge) edge="$2"; shift 2 ;;
      --note) note="$2"; shift 2 ;;
      --json) json=1; shift ;;
      -*) die "Unknown option: $1" 2 ;;
      *) die "Unexpected argument: $1" 2 ;;
    esac
  done
  [[ -n "$source" && -n "$target" ]] || die "Usage: mandible space promote-edge --source <ref> --target <ref> [--link-type <type>] [--space <id>] [--edge <id>] [--note <text>] [--json]" 2
  require_tools

  # Constrain --link-type to the 9 ledger relationship types.
  local valid=0 candidate
  for candidate in "${LEDGER_LINK_TYPES[@]}"; do
    [[ "$candidate" == "$link_type" ]] && valid=1 && break
  done
  (( valid )) || die "Invalid --link-type '${link_type}'. Valid: ${LEDGER_LINK_TYPES[*]}" 2

  local source_kind target_kind
  source_kind="$(ref_kind "$source")"
  target_kind="$(ref_kind "$target")"

  # Ledger edges allow only issue/comment endpoints. Any artifact/URI/unknown
  # endpoint makes the edge not promotable; report it and skip the route.
  local blockers='[]'
  case "$source_kind" in issue|comment) ;; *) blockers="$(printf '%s' "$blockers" | jq --arg side "source" --arg kind "$source_kind" --arg ref "$source" '. + [{side:$side, kind:$kind, ref:$ref}]')" ;; esac
  case "$target_kind" in issue|comment) ;; *) blockers="$(printf '%s' "$blockers" | jq --arg side "target" --arg kind "$target_kind" --arg ref "$target" '. + [{side:$side, kind:$kind, ref:$ref}]')" ;; esac

  if [[ "$(printf '%s' "$blockers" | jq 'length')" != "0" ]]; then
    local result
    result="$(jq -n \
      --arg source "$source" --arg target "$target" --arg link_type "$link_type" \
      --arg space "$space" --arg edge "$edge" --argjson blockers "$blockers" \
      '{promotable:false, status:"not_promotable",
        reason:"ledger relationships allow only issue/comment endpoints",
        source_ref:$source, target_ref:$target, link_type:$link_type,
        space:(if $space == "" then null else $space end),
        edge:(if $edge == "" then null else $edge end),
        blockers:$blockers}')"
    emit "$result" "$json" '"not_promotable \(.source_ref) -> \(.target_ref) (\([.blockers[].kind] | join(",")))"'
    return 3
  fi

  # Both endpoints are issue/comment — promote via the existing ledger writer.
  local payload response result
  payload="$(jq -n --arg source "$source" --arg target "$target" --arg link_type "$link_type" --arg note "$note" \
    '{source_ref:($source | sub("^(issue|comment):"; "")),
      target_refs:[($target | sub("^(issue|comment):"; ""))],
      link_type:$link_type}
     + (if $note == "" then {} else {note:$note} end)')"
  response="$(api_post "/api/ledger/relationships" "$payload")" || die "${RED}Failed to promote edge to a ledger relationship.${RESET}" 1
  result="$(printf '%s' "$response" | jq \
    --arg source "$source" --arg target "$target" --arg link_type "$link_type" \
    --arg space "$space" --arg edge "$edge" \
    '{promotable:true, status:"promoted",
      source_ref:$source, target_ref:$target, link_type:$link_type,
      space:(if $space == "" then null else $space end),
      edge:(if $edge == "" then null else $edge end),
      relationship:.}')"
  emit "$result" "$json" '"promoted \(.source_ref) -[\(.link_type)]-> \(.target_ref)"'
}

cmd_seed_from_filter() {
  local id="" predicate="" with_shelf=0 no_artifacts=0 json=0
  while (( $# > 0 )); do
    case "$1" in
      --predicate) predicate="$2"; shift 2 ;;
      --with-shelf) with_shelf=1; shift ;;
      --no-artifacts) no_artifacts=1; shift ;;
      --json) json=1; shift ;;
      -*) die "Unknown option: $1" 2 ;;
      *) [[ -z "$id" ]] || die "Unexpected argument: $1" 2; id="$1"; shift ;;
    esac
  done
  [[ -n "$id" && -n "$predicate" ]] || die "Usage: mandible space seed-from-filter <space-id> --predicate <json> [--with-shelf] [--no-artifacts] [--json]" 2
  require_tools
  printf '%s' "$predicate" | jq empty 2>/dev/null || die "--predicate must be valid JSON." 2
  local payload response
  payload="$(jq -n --argjson predicate "$predicate" --argjson with_shelf "$with_shelf" --argjson no_artifacts "$no_artifacts" \
    '{predicate:$predicate,
      with_shelf_occurrences:($with_shelf == 1),
      include_artifacts:($no_artifacts != 1)}')"
  response="$(api_post "/api/spaces/$(urlencode "$id")/seed" "$payload")" || die "${RED}Failed to seed space from filter.${RESET}" 1
  emit "$response" "$json" '"seeded matched:\(.matched_issue_ids|length) created:\(.items_created) existing:\(.items_existing) occurrences:\(.occurrences|length)"'
}

if [[ $# -eq 0 || "${1:-}" == "-h" || "${1:-}" == "--help" || "${1:-}" == "help" ]]; then
  usage
  [[ $# -eq 0 ]] && exit 2 || exit 0
fi

cmd="$1"
shift
case "$cmd" in
  create) cmd_create "$@" ;;
  list) cmd_list "$@" ;;
  show) cmd_show "$@" ;;
  add-item) cmd_add_item "$@" ;;
  rm-item) cmd_rm_item "$@" ;;
  place) cmd_place "$@" ;;
  link) cmd_link "$@" ;;
  unlink) cmd_unlink "$@" ;;
  promote-edge) cmd_promote_edge "$@" ;;
  seed-from-filter) cmd_seed_from_filter "$@" ;;
  block)
    die "The 'block' subcommands are owned by C4b and are not yet available in this CLI." 2
    ;;
  *) die "Unknown space subcommand: $cmd" 2 ;;
esac
