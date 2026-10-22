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
mandible_prepare_syntax_runtime || exit $?

RESET=$'\033[0m'
RED=$'\033[31m'

# The 9 ledger relationship link types accepted by POST /api/ledger/relationships
# (see src/db.ts ledger_relationship_edges CHECK constraint). promote-edge
# constrains --link-type to this set before calling the route.
LEDGER_LINK_TYPES=(parent_child blocks duplicate_of related references fixed_by caused_by implements tests)

# The 7 block types accepted by the C11 space_blocks.block_type CHECK set
# (see src/spaces/serialize.ts BLOCK_TYPES). `block add|edit` constrain --type
# to this set before calling the route.
BLOCK_TYPES=(heading paragraph reference artifact_embed issue_embed comment_embed todo)

err() {
  printf "%b\n" "$*" >&2
}

die() {
  err "$1"
  exit "${2:-1}"
}

usage() {
  mandible_command_help space
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
    printf '%s\n' "$result" | api_jq_human "$human"
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
    artifact:sha256:*|sha256:*|artifact-series:*)
      die "Unsupported artifact ref '${ref}'. Use artifact:<id>, artifact-version:<id>, or artifact-blob:<hash>." 2
      ;;
    artifact:*|artifact-version:*|artifact-blob:*)
      rest="${ref#*:}"
      [[ -n "$rest" ]] || die "artifact ref requires a target: artifact:<id>, artifact-version:<id>, or artifact-blob:<hash>" 2
      jq -n --arg id "$ref" '{ref_type:"artifact", ref_id:$id, ref_uri:null}'
      ;;
    uri:*)
      rest="${ref#uri:}"
      [[ -n "$rest" ]] || die "uri ref requires a target: uri:<...>" 2
      jq -n --arg uri "$rest" '{ref_type:"external_ref", ref_id:$uri, ref_uri:$uri}'
      ;;
    *)
      die "Unrecognized ref '${ref}'. Use issue:<id>, comment:<id>, artifact:<id>, artifact-version:<id>, artifact-blob:<hash>, or uri:<...>." 2
      ;;
  esac
}

# Classify a ref for promote-edge: issue/comment endpoints are ledger-promotable;
# artifact/external_ref endpoints are not. Echoes the ref_type.
ref_kind() {
  case "$1" in
    issue:*) printf 'issue' ;;
    comment:*) printf 'comment' ;;
    artifact:*|artifact-version:*|artifact-blob:*) printf 'artifact' ;;
    uri:*) printf 'external_ref' ;;
    *) printf 'unknown' ;;
  esac
}

cmd_create() {
  local project="" title="" renderer="" description="" json=0
  local binding
  binding=$(mandible_bind_arguments "space.create" '{"project":{"option":"project"},"title":{"option":"title"},"renderer":{"option":"renderer"},"description":{"option":"description"},"json":{"option":"json","constant":"1"}}' "$@") || return $?
  eval "$binding"
  [[ -n "$project" && -n "$title" ]] || die "Usage: $(mandible_command_syntax space.create)" 2
  require_tools
  local payload response
  payload="$(jq -n --arg project "$project" --arg title "$title" --arg renderer "$renderer" --arg description "$description" \
    '{project_id:$project, title:$title}
     + (if $renderer == "" then {} else {default_renderer:$renderer} end)
     + (if $description == "" then {} else {description:$description} end)')"
  response="$(api_post "/api/spaces" "$payload")" || die "${RED}Failed to create space.${RESET}" 1
  emit "$response" "$json" '.space | "\(mandible_display_id) \(.title) renderer:\(.default_renderer)"'
}

cmd_list() {
  local project="" json=0
  local binding
  binding=$(mandible_bind_arguments "space.list" '{"project":{"option":"project"},"json":{"option":"json","constant":"1"}}' "$@") || return $?
  eval "$binding"
  [[ -n "$project" ]] || die "Usage: $(mandible_command_syntax space.list)" 2
  require_tools
  local response
  response="$(api_get "/api/spaces?project_id=$(urlencode "$project")")" || die "${RED}Failed to list spaces.${RESET}" 1
  emit "$response" "$json" '.spaces[]? | "\(mandible_display_id) \(.title) renderer:\(.default_renderer)"'
}

cmd_show() {
  local id="" json=0
  local binding
  binding=$(mandible_bind_arguments "space.show" '{"json":{"option":"json","constant":"1"},"id":{"position":0}}' "$@") || return $?
  eval "$binding"
  [[ -n "$id" ]] || die "Usage: $(mandible_command_syntax space.show)" 2
  require_tools
  local response
  response="$(api_get "/api/spaces/$(urlencode "$id")")" || die "${RED}Failed to show space.${RESET}" 1
  emit "$response" "$json" '.space | "\(mandible_display_id)\ntitle: \(.title)\nrenderer: \(.default_renderer)\nproject: \(.project_key // (.project_id | mandible_short_id))\ndescription: \(.description // "-")"'
}

cmd_add_item() {
  local id="" ref="" title="" json=0
  local binding
  binding=$(mandible_bind_arguments "space.add-item" '{"title":{"option":"title"},"json":{"option":"json","constant":"1"},"id":{"position":0},"ref":{"position":1}}' "$@") || return $?
  eval "$binding"
  [[ -n "$id" && -n "$ref" ]] || die "Usage: $(mandible_command_syntax space.add-item)" 2
  require_tools
  local parsed payload response
  parsed="$(parse_item_ref "$ref")"
  payload="$(printf '%s' "$parsed" | jq --arg title "$title" \
    '{ref_type, ref_id}
     + (if .ref_uri == null then {} else {ref_uri:.ref_uri} end)
     + (if $title == "" then {} else {title:$title} end)')"
  response="$(api_post "/api/spaces/$(urlencode "$id")/items" "$payload")" || die "${RED}Failed to add item.${RESET}" 1
  emit "$response" "$json" '"\(if .created then "added" else "exists" end) \(.item | mandible_display_id) \((.item.ref_type + ":" + .item.ref_id) | mandible_typed_short_ref)"'
}

cmd_rm_item() {
  local id="" item_id="" json=0
  local binding
  binding=$(mandible_bind_arguments "space.rm-item" '{"json":{"option":"json","constant":"1"},"id":{"position":0},"item_id":{"position":1}}' "$@") || return $?
  eval "$binding"
  [[ -n "$id" && -n "$item_id" ]] || die "Usage: $(mandible_command_syntax space.rm-item)" 2
  require_tools
  local response
  response="$(api_send DELETE "/api/spaces/$(urlencode "$id")/items/$(urlencode "$item_id")" "")" \
    || die "${RED}Failed to remove item.${RESET}" 1
  emit "$response" "$json" '"removed \(.id | mandible_short_id)"'
}

cmd_place() {
  local id="" item="" renderer="" parent="" section="" note="" json=0
  local x="" y="" width="" height=""
  local binding
  binding=$(mandible_bind_arguments "space.place" '{"item":{"option":"item"},"renderer":{"option":"renderer"},"x":{"option":"x"},"y":{"option":"y"},"width":{"option":"width"},"height":{"option":"height"},"parent":{"option":"parent"},"section":{"option":"section"},"note":{"option":"note"},"json":{"option":"json","constant":"1"},"id":{"position":0}}' "$@") || return $?
  eval "$binding"
  [[ -n "$id" ]] || die "Usage: $(mandible_command_syntax space.place)" 2
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
  emit "$response" "$json" '.occurrence | "placed \(mandible_display_id) renderer:\(.renderer) item:\((.item_id // "-") | mandible_short_id)"'
}

cmd_link() {
  local id="" source="" target="" label="" style="" json=0
  local binding
  binding=$(mandible_bind_arguments "space.link" '{"source":{"option":"source"},"target":{"option":"target"},"label":{"option":"label"},"style":{"option":"style"},"json":{"option":"json","constant":"1"},"id":{"position":0}}' "$@") || return $?
  eval "$binding"
  [[ -n "$id" && -n "$source" && -n "$target" ]] || die "Usage: $(mandible_command_syntax space.link)" 2
  require_tools
  local payload response
  payload="$(jq -n --arg source "$source" --arg target "$target" --arg label "$label" --arg style "$style" \
    '{source:$source, target:$target}
     + (if $label == "" then {} else {label:$label} end)
     + (if $style == "" then {} else {style:$style} end)')"
  response="$(api_post "/api/spaces/$(urlencode "$id")/edges" "$payload")" || die "${RED}Failed to link occurrences.${RESET}" 1
  emit "$response" "$json" '.edge | "linked \(mandible_display_id) \(.source | mandible_short_id) -> \(.target | mandible_short_id)"'
}

cmd_unlink() {
  local id="" edge_id="" json=0
  local binding
  binding=$(mandible_bind_arguments "space.unlink" '{"json":{"option":"json","constant":"1"},"id":{"position":0},"edge_id":{"position":1}}' "$@") || return $?
  eval "$binding"
  [[ -n "$id" && -n "$edge_id" ]] || die "Usage: $(mandible_command_syntax space.unlink)" 2
  require_tools
  local response
  response="$(api_send DELETE "/api/spaces/$(urlencode "$id")/edges/$(urlencode "$edge_id")" "")" \
    || die "${RED}Failed to unlink edge.${RESET}" 1
  emit "$response" "$json" '"unlinked \(.id | mandible_short_id)"'
}

# promote-edge: turn a canvas edge into a durable ledger relationship via the
# existing POST /api/ledger/relationships route. Both endpoints must be
# issue/comment refs (ledger edges allow only issue/comment endpoints). An
# artifact/URI endpoint yields a deterministic "not promotable" result and the
# ledger route is never called.
cmd_promote_edge() {
  local source="" target="" link_type="references" space="" edge="" note="" json=0
  local binding
  binding=$(mandible_bind_arguments "space.promote-edge" '{"source":{"option":"source"},"target":{"option":"target"},"link_type":{"option":"link-type"},"space":{"option":"space"},"edge":{"option":"edge"},"note":{"option":"note"},"json":{"option":"json","constant":"1"}}' "$@") || return $?
  eval "$binding"
  [[ -n "$source" && -n "$target" ]] || die "Usage: $(mandible_command_syntax space.promote-edge)" 2
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
  local binding
  binding=$(mandible_bind_arguments "space.seed-from-filter" '{"predicate":{"option":"predicate"},"with_shelf":{"option":"with-shelf","constant":"1"},"no_artifacts":{"option":"no-artifacts","constant":"1"},"json":{"option":"json","constant":"1"},"id":{"position":0}}' "$@") || return $?
  eval "$binding"
  [[ -n "$id" && -n "$predicate" ]] || die "Usage: $(mandible_command_syntax space.seed-from-filter)" 2
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

# --- block subcommands (C4b, issue d83d540) ---------------------------------
# The document/canvas block tree, consuming the C11 (issue d2a8e77)
# /api/spaces/:id/blocks* routes. These are a disjoint region from C4's core
# subcommands above; they never touch the DB directly. The route layer owns
# sort-key generation, parent-cycle rejection, and the embed/snapshot invariant
# (an embed `--item` REQUIRES a `--snapshot`); the CLI only constrains --type to
# the frozen block-type set before the call.

# Validate a --type value against the C11 block-type set.
block_validate_type() {
  local candidate want="$1"
  for candidate in "${BLOCK_TYPES[@]}"; do
    [[ "$candidate" == "$want" ]] && return 0
  done
  die "Invalid --type '${want}'. Valid: ${BLOCK_TYPES[*]}" 2
}

# Build the block-mutation payload shared by add/edit. `$1` = create|update.
# On create, --type is required and emitted as block_type. On update, every
# field is optional and only provided flags are included so unset fields are
# left untouched server-side. --snapshot/--metadata must be valid JSON objects.
block_build_payload() {
  local mode="$1"
  local block_type="$2" parent="$3" item="$4" snapshot="$5" sort_key="$6" markdown="$7" metadata="$8"
  local have_type="$9" have_parent="${10}" have_item="${11}" have_snapshot="${12}"
  local have_sort="${13}" have_markdown="${14}" have_metadata="${15}"

  if [[ -n "$snapshot" ]]; then
    printf '%s' "$snapshot" | jq -e 'type == "object"' >/dev/null 2>&1 \
      || die "--snapshot must be a JSON object." 2
  fi
  if [[ -n "$metadata" ]]; then
    printf '%s' "$metadata" | jq -e 'type == "object"' >/dev/null 2>&1 \
      || die "--metadata must be a JSON object." 2
  fi

  jq -n \
    --arg block_type "$block_type" --arg parent "$parent" --arg item "$item" \
    --arg sort_key "$sort_key" --arg markdown "$markdown" \
    --argjson snapshot "${snapshot:-null}" --argjson metadata "${metadata:-null}" \
    --argjson have_type "$have_type" --argjson have_parent "$have_parent" \
    --argjson have_item "$have_item" --argjson have_snapshot "$have_snapshot" \
    --argjson have_sort "$have_sort" --argjson have_markdown "$have_markdown" \
    --argjson have_metadata "$have_metadata" \
    '{}
     + (if $have_type == 1 then {block_type:$block_type} else {} end)
     + (if $have_parent == 1 then {parent_id:$parent} else {} end)
     + (if $have_item == 1 then {item_id:$item} else {} end)
     + (if $have_snapshot == 1 then {item_snapshot:$snapshot} else {} end)
     + (if $have_sort == 1 then {sort_key:$sort_key} else {} end)
     + (if $have_markdown == 1 then {markdown:$markdown} else {} end)
     + (if $have_metadata == 1 then {metadata:$metadata} else {} end)'
}

cmd_block_add() {
  local id="" block_type="" parent="" item="" snapshot="" sort_key="" markdown="" metadata="" json=0
  local have_parent=0 have_item=0 have_snapshot=0 have_sort=0 have_markdown=0 have_metadata=0
  local binding
  binding=$(mandible_bind_arguments "space.block.add" '{"block_type":{"option":"type"},"parent":{"option":"parent"},"have_parent":{"option":"parent","constant":"1"},"item":{"option":"item"},"have_item":{"option":"item","constant":"1"},"snapshot":{"option":"snapshot"},"have_snapshot":{"option":"snapshot","constant":"1"},"sort_key":{"option":"sort-key"},"have_sort":{"option":"sort-key","constant":"1"},"markdown":{"option":"markdown"},"have_markdown":{"option":"markdown","constant":"1"},"metadata":{"option":"metadata"},"have_metadata":{"option":"metadata","constant":"1"},"json":{"option":"json","constant":"1"},"id":{"position":0}}' "$@") || return $?
  eval "$binding"
  [[ -n "$id" && -n "$block_type" ]] || die "Usage: $(mandible_command_syntax space.block.add)" 2
  require_tools
  block_validate_type "$block_type"
  local payload response
  payload="$(block_build_payload create \
    "$block_type" "$parent" "$item" "$snapshot" "$sort_key" "$markdown" "$metadata" \
    1 "$have_parent" "$have_item" "$have_snapshot" "$have_sort" "$have_markdown" "$have_metadata")"
  response="$(api_post "/api/spaces/$(urlencode "$id")/blocks" "$payload")" || die "${RED}Failed to add block.${RESET}" 1
  emit "$response" "$json" '.block | "added \(mandible_display_id) \(.block_type) parent:\((.parent_id // "-") | mandible_short_id) item:\((.item_id // "-") | mandible_short_id)"'
}

cmd_block_edit() {
  local id="" block_id="" block_type="" parent="" item="" snapshot="" sort_key="" markdown="" metadata="" json=0
  local have_type=0 have_parent=0 have_item=0 have_snapshot=0 have_sort=0 have_markdown=0 have_metadata=0
  local binding
  binding=$(mandible_bind_arguments "space.block.edit" '{"block_type":{"option":"type"},"have_type":{"option":"type","constant":"1"},"parent":{"option":"parent"},"have_parent":{"option":"parent","constant":"1"},"item":{"option":"item"},"have_item":{"option":"item","constant":"1"},"snapshot":{"option":"snapshot"},"have_snapshot":{"option":"snapshot","constant":"1"},"sort_key":{"option":"sort-key"},"have_sort":{"option":"sort-key","constant":"1"},"markdown":{"option":"markdown"},"have_markdown":{"option":"markdown","constant":"1"},"metadata":{"option":"metadata"},"have_metadata":{"option":"metadata","constant":"1"},"json":{"option":"json","constant":"1"},"id":{"position":0},"block_id":{"position":1}}' "$@") || return $?
  eval "$binding"
  [[ -n "$id" && -n "$block_id" ]] || die "Usage: $(mandible_command_syntax space.block.edit)" 2
  require_tools
  (( have_type )) && block_validate_type "$block_type"
  local payload response
  payload="$(block_build_payload update \
    "$block_type" "$parent" "$item" "$snapshot" "$sort_key" "$markdown" "$metadata" \
    "$have_type" "$have_parent" "$have_item" "$have_snapshot" "$have_sort" "$have_markdown" "$have_metadata")"
  response="$(api_send PATCH "/api/spaces/$(urlencode "$id")/blocks/$(urlencode "$block_id")" "$payload")" \
    || die "${RED}Failed to edit block.${RESET}" 1
  emit "$response" "$json" '.block | "edited \(mandible_display_id) \(.block_type) parent:\((.parent_id // "-") | mandible_short_id) item:\((.item_id // "-") | mandible_short_id)"'
}

cmd_block_rm() {
  local id="" block_id="" json=0
  local binding
  binding=$(mandible_bind_arguments "space.block.rm" '{"json":{"option":"json","constant":"1"},"id":{"position":0},"block_id":{"position":1}}' "$@") || return $?
  eval "$binding"
  [[ -n "$id" && -n "$block_id" ]] || die "Usage: $(mandible_command_syntax space.block.rm)" 2
  require_tools
  local response
  response="$(api_send DELETE "/api/spaces/$(urlencode "$id")/blocks/$(urlencode "$block_id")" "")" \
    || die "${RED}Failed to remove block.${RESET}" 1
  emit "$response" "$json" '"removed \(.id | mandible_short_id)"'
}

cmd_block() {
  local sub="${1:-}"
  [[ -n "$sub" ]] || die "Usage: mandible space block <add|edit|rm> ..." 2
  shift
  case "$sub" in
    add) cmd_block_add "$@" ;;
    edit) cmd_block_edit "$@" ;;
    rm) cmd_block_rm "$@" ;;
    *) die "Unknown block subcommand: $sub. Valid: add, edit, rm" 2 ;;
  esac
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
  block) cmd_block "$@" ;;
  *) die "Unknown space subcommand: $cmd" 2 ;;
esac
