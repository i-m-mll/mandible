#!/usr/bin/env zsh
# mandible briefing: supported Briefing creation over the authenticated daemon API.
source "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd -P)/command-syntax.sh"

set -euo pipefail

API_HELPER="${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/api.sh"
source "$API_HELPER"

die() {
  printf '%s\n' "$1" >&2
  exit "${2:-1}"
}

usage() {
  mandible_command_help briefing
}

cmd_archive_state() {
  local action="$1" briefing_ref="" json=0 response encoded
  shift
  local binding
  binding=$(mandible_bind_arguments "briefing.${action}" '{"json":{"option":"json","constant":"1"},"briefing_ref":{"position":0}}' "$@") || return $?
  eval "$binding"
  [[ -n "$briefing_ref" ]] || die "Usage: mandible briefing $action <briefing-ref> [--json]" 2
  encoded="$(urlencode "$briefing_ref")"
  case "$action" in
    archive) response="$(api_send POST "/api/briefings/$encoded/archive" '{}')" || die "Failed to archive Briefing." 1 ;;
    restore) response="$(api_send POST "/api/briefings/$encoded/restore" '{}')" || die "Failed to restore Briefing." 1 ;;
    *) die "Unknown archive state: $action" 2 ;;
  esac
  if (( json )); then
    printf '%s\n' "$response" | jq .
  else
    printf '%s\n' "$response" | api_jq_human \
      "\"${action}d \\(.briefing_id | mandible_briefing_ref)\""
  fi
}

cmd_rename() {
  local briefing_ref="" title="" json=0 response payload
  local binding
  binding=$(mandible_bind_arguments "briefing.rename" '{"title":{"option":"title"},"json":{"option":"json","constant":"1"},"briefing_ref":{"position":0}}' "$@") || return $?
  eval "$binding"
  [[ -n "$briefing_ref" && -n "${title//[[:space:]]/}" ]] \
    || die "Usage: $(mandible_command_syntax briefing.rename)" 2
  command -v jq >/dev/null 2>&1 || die "jq not found" 1
  payload="$(jq -n --arg title "$title" '{title:$title}')"
  response="$(api_send PATCH "/api/briefings/$(urlencode "$briefing_ref")" "$payload")" \
    || die "Failed to rename Briefing." 1
  if (( json )); then
    printf '%s\n' "$response" | jq .
  else
    printf '%s\n' "$response" | api_jq_human \
      '"\(.briefing_id | mandible_briefing_ref)  \(.title)"'
  fi
}

cmd_describe() {
  local briefing_ref="" description="" has_description=0 clear=0 json=0 response payload
  local binding
  binding=$(mandible_bind_arguments "briefing.describe" '{"description":{"option":"description"},"has_description":{"option":"description","constant":"1"},"clear":{"option":"clear","constant":"1"},"json":{"option":"json","constant":"1"},"briefing_ref":{"position":0}}' "$@") || return $?
  eval "$binding"
  [[ -n "$briefing_ref" && $((has_description + clear)) -eq 1 ]] \
    || die "Usage: $(mandible_command_syntax briefing.describe)" 2
  [[ $clear -eq 1 || -n "${description//[[:space:]]/}" ]] \
    || die "--description requires nonblank text" 2
  command -v jq >/dev/null 2>&1 || die "jq not found" 1
  if (( clear )); then payload='{"description":null}'
  else payload="$(jq -n --arg description "$description" '{description:$description}')"
  fi
  response="$(api_send PATCH "/api/briefings/$(urlencode "$briefing_ref")" "$payload")" \
    || die "Failed to update Briefing description." 1
  if (( json )); then
    printf '%s\n' "$response" | jq .
  else
    printf '%s\n' "$response" | api_jq_human \
      '"\(.briefing_id | mandible_briefing_ref)  \(if .description == null then "description cleared" else .description end)"'
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
            "  \(.position + 1). \(.briefing.id | mandible_briefing_ref)  \(.briefing.title)"
          else
            "  \(.position + 1). \(.name)\n\([.briefings[]? |
              "    \(.position + 1). \(.briefing.id | mandible_briefing_ref)  \(.briefing.title)"] | join("\n"))"
          end] | join("\n")
        else
          [.members[]? | "  \(.position + 1). \(.briefing.id | mandible_briefing_ref)  \(.briefing.title)"] | join("\n")
        end
      )"'
  fi
}

cmd_create() {
  local artifact_version_ref="" comparison_base="" target_briefing="" distinct_reason="" title="" description="" has_description=0 has_target_briefing=0 has_distinct_reason=0 json=0 response payload
  local binding
  binding=$(mandible_bind_arguments "briefing.create" '{"title":{"option":"title"},"description":{"option":"description"},"has_description":{"option":"description","constant":"1"},"comparison_base":{"option":"comparison-base"},"target_briefing":{"option":"briefing"},"has_target_briefing":{"option":"briefing","constant":"1"},"distinct_reason":{"option":"reason"},"has_distinct_reason":{"option":"reason","constant":"1"},"json":{"option":"json","constant":"1"},"artifact_version_ref":{"position":0}}' "$@") || return $?
  eval "$binding"
  [[ "$artifact_version_ref" == artifact-version:* ]] \
    || die "create requires one exact artifact-version:<id> ref" 2
  [[ -z "$comparison_base" || "$comparison_base" == artifact-version:* ]] \
    || die "--comparison-base requires one exact artifact-version:<id> ref" 2
  [[ -n "${title//[[:space:]]/}" ]] || die "create requires --title <text>" 2
  [[ $has_description -eq 0 || -n "${description//[[:space:]]/}" ]] || die "--description requires nonblank text" 2
  [[ $has_target_briefing -eq 0 || -n "${target_briefing//[[:space:]]/}" ]] || die "--briefing requires a nonblank Briefing ref" 2
  [[ $has_distinct_reason -eq 0 || -n "${distinct_reason//[[:space:]]/}" ]] || die "--reason requires nonblank text" 2
  [[ $has_target_briefing -eq 0 || $has_distinct_reason -eq 0 ]] \
    || die "--briefing and --reason are mutually exclusive" 2
  command -v jq >/dev/null 2>&1 || die "jq not found" 1
  payload="$(jq -n --arg artifact_version_ref "$artifact_version_ref" --arg comparison_base "$comparison_base" --arg target_briefing "$target_briefing" --arg distinct_reason "$distinct_reason" --arg title "$title" --arg description "$description" \
    '{artifact_version_ref:$artifact_version_ref,title:$title}
     + (if $description == "" then {} else {description:$description} end)
     + (if $comparison_base == "" then {} else {comparison_base_artifact_version_ref:$comparison_base} end)
     + (if $target_briefing == "" then {} else {target_briefing_ref:$target_briefing} end)
     + (if $distinct_reason == "" then {} else {distinct_reason:$distinct_reason} end)')"
  response="$(api_send POST "/api/briefings" "$payload")" || die "Failed to create Briefing from exact artifact version." 1
  if (( json )); then
    printf '%s\n' "$response" | jq .
  else
    printf '%s\n' "$response" | api_jq_human \
      '"\(.outcome | gsub("_"; " ")) \(.briefing_id | mandible_briefing_ref) round \(.round_id | mandible_short_id) from \(.artifact_version_id | mandible_typed_short_ref)\(if (.archived_candidates | length) > 0 then "; archived advisories=" + ((.archived_candidates | length) | tostring) else "" end)"'
  fi
}

cmd_bundle_create() {
  local name="" sharing_reason="" json=0 response payload
  local -a briefing_refs
  briefing_refs=()
  local binding
  binding=$(mandible_bind_arguments "briefing.bundle.create" '{"name":{"option":"name"},"sharing_reason":{"option":"sharing-reason"},"json":{"option":"json","constant":"1"},"briefing_refs":{"rest":0}}' "$@") || return $?
  eval "$binding"
  [[ -n "${name//[[:space:]]/}" ]] || die "bundle create requires --name <name>" 2
  command -v jq >/dev/null 2>&1 || die "jq not found" 1
  payload="$(jq -n --arg name "$name" --arg reason "$sharing_reason" --args \
    '{name:$name,briefing_refs:$ARGS.positional} + (if $reason == "" then {} else {sharing_reason:$reason} end)' -- "${briefing_refs[@]}")"
  response="$(api_send POST "/api/briefing-bundles" "$payload")" || die "Failed to create Briefing bundle." 1
  emit_bundle "$response" "$json"
}

cmd_bundle_add() {
  local bundle_ref="" briefing_ref="" sharing_reason="" json=0 response payload
  local binding
  binding=$(mandible_bind_arguments "briefing.bundle.add" '{"json":{"option":"json","constant":"1"},"sharing_reason":{"option":"sharing-reason"},"bundle_ref":{"position":0},"briefing_ref":{"position":1}}' "$@") || return $?
  eval "$binding"
  [[ -n "$bundle_ref" && -n "$briefing_ref" ]] \
    || die "Usage: $(mandible_command_syntax briefing.bundle.add)" 2
  command -v jq >/dev/null 2>&1 || die "jq not found" 1
  payload="$(jq -n --arg briefing_ref "$briefing_ref" --arg reason "$sharing_reason" \
    '{briefing_ref:$briefing_ref} + (if $reason == "" then {} else {sharing_reason:$reason} end)')"
  response="$(api_send POST "/api/briefing-bundles/$(urlencode "$bundle_ref")/briefings" "$payload")" \
    || die "Failed to add Briefing to bundle." 1
  emit_bundle "$response" "$json"
}

cmd_bundle_replace() {
  local bundle_ref="" layout="" sharing_reason="" json=0 response payload
  local -a briefing_refs
  briefing_refs=()
  local binding
  binding=$(mandible_bind_arguments "briefing.bundle.replace" '{"json":{"option":"json","constant":"1"},"layout":{"option":"layout"},"sharing_reason":{"option":"sharing-reason"},"bundle_ref":{"position":0},"briefing_refs":{"rest":1}}' "$@") || return $?
  eval "$binding"
  [[ -n "$bundle_ref" ]] \
    || die "Usage: $(mandible_command_syntax briefing.bundle.replace)" 2
  [[ -z "$layout" || ${#briefing_refs[@]} -eq 0 ]] \
    || die "bundle replace accepts either flat Briefing refs or --layout, not both" 2
  command -v jq >/dev/null 2>&1 || die "jq not found" 1
  if [[ -n "$layout" ]]; then
    payload="$(printf '%s' "$layout" | jq -ce 'if type == "array" then {layout:.} else error("layout must be an array") end')" \
      || die "--layout must be valid JSON containing an array" 2
  else
    payload="$(jq -n --args '{briefing_refs:$ARGS.positional}' -- "${briefing_refs[@]}")"
  fi
  [[ -z "$sharing_reason" ]] || payload="$(printf '%s' "$payload" | jq -c --arg reason "$sharing_reason" '. + {sharing_reason:$reason}')"
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
      '.group | "briefing-group:\(.id | mandible_short_id)  key=\(.key)  \(.name)\n  Base: \(
        if .current == null then "none" else "\(.current.id | mandible_short_id)  \(if .current.name == \"Original\" then \"Base\" else .current.name end)" end
      )\n\([.updates[]? | "  proposal: \(.id | mandible_short_id)  \(.name)"] | join("\n"))\n  history: \((.history // []) | length)"'
  fi
}

cmd_group_create() {
  local key="" name="" current_bundle_ref="" sharing_reason="" json=0 response payload
  local -a bundle_refs=()
  local binding
  binding=$(mandible_bind_arguments "briefing.group.create" '{"key":{"option":"key"},"name":{"option":"name"},"current_bundle_ref":{"option":"current"},"sharing_reason":{"option":"sharing-reason"},"json":{"option":"json","constant":"1"},"bundle_refs":{"rest":0}}' "$@") || return $?
  eval "$binding"
  [[ -n "$key" && -n "${name//[[:space:]]/}" ]] || die "group create requires --key <key> --name <name>" 2
  command -v jq >/dev/null 2>&1 || die "jq not found" 1
  payload="$(jq -n --arg key "$key" --arg name "$name" --arg current "$current_bundle_ref" --arg reason "$sharing_reason" --args \
    '{key:$key,name:$name,bundle_refs:$ARGS.positional}
     + (if $current == "" then {} else {current_bundle_ref:$current} end)
     + (if $reason == "" then {} else {sharing_reason:$reason} end)' \
    -- "${bundle_refs[@]}")"
  response="$(api_send POST "/api/briefing-groups" "$payload")" || die "Failed to create Briefing group." 1
  emit_group "$response" "$json"
}

cmd_group_configure() {
  local group_ref="" current_bundle_ref="" sharing_reason="" current_set=0 json=0 response payload
  local -a bundle_refs=()
  local binding
  binding=$(mandible_bind_arguments "briefing.group.configure" '{"current_bundle_ref":{"option":"current"},"current_set":{"option":"current","constant":"1"},"sharing_reason":{"option":"sharing-reason"},"json":{"option":"json","constant":"1"},"group_ref":{"position":0},"bundle_refs":{"rest":1}}' "$@") || return $?
  eval "$binding"
  [[ -n "$group_ref" && $current_set -eq 1 ]] \
    || die "Usage: $(mandible_command_syntax briefing.group.configure)" 2
  [[ -n "${current_bundle_ref//[[:space:]]/}" ]] || die "--current requires a nonblank bundle ref or none" 2
  command -v jq >/dev/null 2>&1 || die "jq not found" 1
  payload="$(jq -n --arg current "$current_bundle_ref" --arg reason "$sharing_reason" --args \
    '{current_bundle_ref:(if $current == "none" then null else $current end),bundle_refs:$ARGS.positional}
     + (if $reason == "" then {} else {sharing_reason:$reason} end)' \
    -- "${bundle_refs[@]}")"
  response="$(api_send PUT "/api/briefing-groups/$(urlencode "$group_ref")/configuration" "$payload")" \
    || die "Failed to configure Briefing group." 1
  emit_group "$response" "$json"
}

cmd_group_add() {
  local group_ref="" bundle_ref="" sharing_reason="" json=0 response payload
  local binding
  binding=$(mandible_bind_arguments "briefing.group.add" '{"json":{"option":"json","constant":"1"},"sharing_reason":{"option":"sharing-reason"},"group_ref":{"position":0},"bundle_ref":{"position":1}}' "$@") || return $?
  eval "$binding"
  [[ -n "$group_ref" && -n "$bundle_ref" ]] || die "Usage: $(mandible_command_syntax briefing.group.add)" 2
  command -v jq >/dev/null 2>&1 || die "jq not found" 1
  payload="$(jq -n --arg bundle_ref "$bundle_ref" --arg reason "$sharing_reason" \
    '{bundle_ref:$bundle_ref} + (if $reason == "" then {} else {sharing_reason:$reason} end)')"
  response="$(api_send POST "/api/briefing-groups/$(urlencode "$group_ref")/updates" "$payload")" \
    || die "Failed to add update to Briefing group." 1
  emit_group "$response" "$json"
}

cmd_group_rename() {
  local group_ref="" name="" json=0 response payload
  local binding
  binding=$(mandible_bind_arguments "briefing.group.rename" '{"name":{"option":"name"},"json":{"option":"json","constant":"1"},"group_ref":{"position":0}}' "$@") || return $?
  eval "$binding"
  [[ -n "$group_ref" && -n "${name//[[:space:]]/}" ]] || die "Usage: $(mandible_command_syntax briefing.group.rename)" 2
  command -v jq >/dev/null 2>&1 || die "jq not found" 1
  payload="$(jq -n --arg name "$name" '{name:$name}')"
  response="$(api_send PATCH "/api/briefing-groups/$(urlencode "$group_ref")" "$payload")" \
    || die "Failed to rename Briefing group." 1
  emit_group "$response" "$json"
}

cmd_group_promote() {
  local group_ref="" expected_base="" proposal="" auth_request="" merge_head="" json=0 response payload
  local binding
  binding=$(mandible_bind_arguments "briefing.group.promote" '{"expected_base":{"option":"expected-base"},"proposal":{"option":"proposal"},"auth_request":{"option":"auth-request"},"merge_head":{"option":"merge-head"},"json":{"option":"json","constant":"1"},"group_ref":{"position":0}}' "$@") || return $?
  eval "$binding"
  [[ -n "$group_ref" && -n "$expected_base" && -n "$proposal" && -n "$auth_request" ]] \
    || die "Usage: $(mandible_command_syntax briefing.group.promote)" 2
  [[ "$merge_head" =~ '^[0-9a-fA-F]{40}$' ]] \
    || die "--merge-head requires one exact 40-character Git commit id" 2
  command -v jq >/dev/null 2>&1 || die "jq not found" 1
  payload="$(jq -n --arg expected "$expected_base" --arg proposal "$proposal" \
    --arg auth "$auth_request" --arg head "$merge_head" \
    '{expected_base_bundle_ref:$expected,proposal_bundle_ref:$proposal,auth_request_ref:$auth,merge_head_sha:$head}')"
  response="$(api_send POST "/api/briefing-groups/$(urlencode "$group_ref")/promotions/apply" "$payload")" \
    || die "Failed to apply guarded Briefing group promotion." 1
  if (( json )); then
    printf '%s\n' "$response" | jq .
  else
    printf '%s\n' "$response" | api_jq_human \
      '"briefing-group:\(.group.id | mandible_short_id)  Base=\(.group.current.id | mandible_short_id)  \(if .changed then "promoted" else "already applied" end)"'
  fi
}

cmd_group_review_disposition() {
  local action="$1" group_ref="" expected_base="" proposal="" binding_digest="" destination_changes='[]' json=0 response payload decision
  shift
  local binding
  binding=$(mandible_bind_arguments "briefing.group.${action}" '{"expected_base":{"option":"expected-base"},"proposal":{"option":"proposal"},"binding_digest":{"option":"binding-digest"},"destination_changes":{"option":"destination-changes"},"json":{"option":"json","constant":"1"},"group_ref":{"position":0}}' "$@") || return $?
  eval "$binding"
  [[ -n "$group_ref" && -n "$expected_base" && -n "$proposal" ]] \
    || die "Usage: mandible briefing group $action <group-ref> --expected-base <bundle-ref> --proposal <bundle-ref> --binding-digest <sha256> [--json]" 2
  [[ "$binding_digest" =~ '^[0-9a-fA-F]{64}$' ]] \
    || die "--binding-digest requires one exact SHA-256 digest" 2
  decision="$([[ "$action" == "accept" ]] && printf accepted || printf rejected)"
  command -v jq >/dev/null 2>&1 || die "jq not found" 1
  printf '%s' "$destination_changes" | jq -e 'type == "array"' >/dev/null \
    || die "--destination-changes must be a JSON array" 2
  payload="$(jq -n --arg decision "$decision" --arg expected "$expected_base" --arg proposal "$proposal" \
    --arg binding "$binding_digest" --argjson changes "$destination_changes" \
    '{decision:$decision,expected_base_bundle_ref:$expected,proposal_bundle_ref:$proposal,binding_digest:$binding,
      destination_changes:$changes}')"
  response="$(api_send POST "/api/briefing-groups/$(urlencode "$group_ref")/review-dispositions" "$payload")" \
    || die "Failed to $action Briefing proposal." 1
  if (( json )); then
    printf '%s\n' "$response" | jq .
  else
    printf '%s\n' "$response" | api_jq_human \
      '"briefing-group:\(.group.id | mandible_short_id)  \(if .changed then .disposition.kind else "already \(.disposition.kind)" end)  proposal=\(.disposition.proposal.id | mandible_short_id)"'
  fi
}

cmd_group_review() {
  local group_ref="" expected_base="" proposal="" destination_changes='[]' json=0 response payload
  local binding
  binding=$(mandible_bind_arguments "briefing.group.review" '{"expected_base":{"option":"expected-base"},"proposal":{"option":"proposal"},"destination_changes":{"option":"destination-changes"},"json":{"option":"json","constant":"1"},"group_ref":{"position":0}}' "$@") || return $?
  eval "$binding"
  [[ -n "$group_ref" && -n "$expected_base" && -n "$proposal" ]] \
    || die "Usage: $(mandible_command_syntax briefing.group.review)" 2
  command -v jq >/dev/null 2>&1 || die "jq not found" 1
  printf '%s' "$destination_changes" | jq -e 'type == "array"' >/dev/null \
    || die "--destination-changes must be a JSON array" 2
  payload="$(jq -n --arg expected "$expected_base" --arg proposal "$proposal" --argjson changes "$destination_changes" \
    '{expected_base_bundle_ref:$expected,proposal_bundle_ref:$proposal,destination_changes:$changes}')"
  response="$(api_send POST "/api/briefing-groups/$(urlencode "$group_ref")/review-candidates" "$payload")" \
    || die "Failed to preview guarded Briefing group review." 1
  if (( json )); then printf '%s\n' "$response" | jq .; else
    printf '%s\n' "$response" | api_jq_human \
      '.candidate | "ready=\(.ready)  binding=\(.binding_digest // \"none\")  layout_changed=\(.layout_changed)  destination_changes=\(.destination_changes | length)"'
  fi
}

cmd_group_destination() {
  local action="${1:-}" group_ref="" artifact_ref="" json=0 response payload
  shift || true
  if [[ "$action" == "place" ]]; then cmd_group_destination_place "$@"; return; fi
  [[ "$action" == "bind" ]] || die "Usage: mandible briefing group destination bind|place ..." 2
  local binding
  binding=$(mandible_bind_arguments "briefing.group.destination.bind" '{"json":{"option":"json","constant":"1"},"group_ref":{"position":0},"artifact_ref":{"position":1}}' "$@") || return $?
  eval "$binding"
  [[ -n "$group_ref" && -n "$artifact_ref" ]] \
    || die "Usage: $(mandible_command_syntax briefing.group.destination.bind)" 2
  payload="$(jq -n --arg artifact "$artifact_ref" '{logical_artifact_ref:$artifact}')"
  response="$(api_send POST "/api/briefing-groups/$(urlencode "$group_ref")/destinations" "$payload")" \
    || die "Failed to bind Briefing destination owner." 1
  emit_group "$response" "$json"
}

cmd_group_destination_place() {
  local group_ref="" artifact_ref="" briefing_ref="" operation_key="" expected_owner="" target_base="" source_base="none" route_file="" json=0 payload response route
  local binding
  binding=$(mandible_bind_arguments "briefing.group.destination.place" '{"briefing_ref":{"option":"briefing"},"operation_key":{"option":"operation-key"},"expected_owner":{"option":"expected-owner"},"target_base":{"option":"expected-target-base"},"source_base":{"option":"expected-source-base"},"route_file":{"option":"route-file"},"json":{"option":"json","constant":"1"},"group_ref":{"position":0},"artifact_ref":{"position":1}}' "$@") || return $?
  eval "$binding"
  [[ -n "$group_ref" && -n "$artifact_ref" && -n "$briefing_ref" && -n "$operation_key" && -n "$expected_owner" && -n "$target_base" ]] \
    || die "place requires group, Artifact, --briefing, --operation-key, --expected-owner, and --expected-target-base" 2
  route='null'
  if [[ -n "$route_file" ]]; then
    route="$(read_route_manifest "$route_file" | jq -c '.routes | if length == 1 then .[0] else error("route file must contain one route") end')" \
      || die "Invalid single-route manifest" 2
  fi
  payload="$(jq -n --arg key "$operation_key" --arg artifact "$artifact_ref" --arg briefing "$briefing_ref" \
    --arg owner "$expected_owner" --arg target "$target_base" --arg source "$source_base" --argjson route "$route" \
    '{operation_key:$key,logical_artifact_ref:$artifact,briefing_ref:$briefing,
      expected_owner_group_ref:(if $owner=="none" then null else $owner end),
      expected_target_base_ref:(if $target=="none" then null else $target end),
      expected_source_base_ref:(if $source=="none" then null else $source end)}
      + (if $route==null then {} else {route:$route} end)')"
  response="$(api_send POST "/api/briefing-groups/$(urlencode "$group_ref")/report-placement" "$payload")" \
    || die "Failed to place Briefing report." 1
  if (( json )); then printf '%s\n' "$response" | jq .; else
    printf '%s\n' "$response" | api_jq_human \
      '"report group=\(.group_id | mandible_short_id)  Base=\(.target_base_bundle_id | mandible_short_id)  changed=\(.changed)"'
  fi
}

cmd_report_update() {
  local briefing_ref="" version_ref="" operation_key="" expected_round="" expected_version="" json=0 payload response
  local binding
  binding=$(mandible_bind_arguments "briefing.report.update" '{"operation_key":{"option":"operation-key"},"expected_round":{"option":"expected-round"},"expected_version":{"option":"expected-version"},"json":{"option":"json","constant":"1"},"briefing_ref":{"position":0},"version_ref":{"position":1}}' "$@") || return $?
  eval "$binding"
  [[ -n "$briefing_ref" && "$version_ref" == artifact-version:* && -n "$operation_key" && -n "$expected_round" && "$expected_version" == artifact-version:* ]] \
    || die "report update requires a Briefing, exact version, operation key, expected round, and exact expected version" 2
  payload="$(jq -n --arg key "$operation_key" --arg version "$version_ref" --arg round "$expected_round" \
    --arg expected "$expected_version" '{operation_key:$key,artifact_version_ref:$version,
      expected_current_round_id:$round,expected_current_artifact_version_ref:$expected}')"
  response="$(api_send POST "/api/briefings/$(urlencode "$briefing_ref")/report-rounds" "$payload")" \
    || die "Failed to update published report Current." 1
  if (( json )); then printf '%s\n' "$response" | jq .; else
    printf '%s\n' "$response" | api_jq_human \
      '"report \(.briefing_id | mandible_briefing_ref)  round=\(.round_id | mandible_short_id)  changed=\(.changed)"'
  fi
}

cmd_group_show() {
  local group_ref="" json=0 response
  local binding
  binding=$(mandible_bind_arguments "briefing.group.show" '{"json":{"option":"json","constant":"1"},"group_ref":{"position":0}}' "$@") || return $?
  eval "$binding"
  [[ -n "$group_ref" ]] || die "Usage: $(mandible_command_syntax briefing.group.show)" 2
  response="$(api_get "/api/briefing-groups/$(urlencode "$group_ref")")" || die "Failed to show Briefing group." 1
  emit_group "$response" "$json"
}

cmd_group_archive_state() {
  local action="$1" group_ref="" json=0 response
  shift
  local binding
  binding=$(mandible_bind_arguments "briefing.group.${action}" '{"json":{"option":"json","constant":"1"},"group_ref":{"position":0}}' "$@") || return $?
  eval "$binding"
  [[ -n "$group_ref" ]] || die "Usage: mandible briefing group $action <group-ref> [--json]" 2
  case "$action" in
    archive) response="$(api_send POST "/api/briefing-groups/$(urlencode "$group_ref")/archive" '{}')" \
      || die "Failed to archive Briefing group." 1 ;;
    restore) response="$(api_send POST "/api/briefing-groups/$(urlencode "$group_ref")/restore" '{}')" \
      || die "Failed to restore Briefing group." 1 ;;
    *) die "Unknown Briefing group archive state: $action" 2 ;;
  esac
  emit_group "$response" "$json"
}

cmd_group() {
  local subcommand="${1:-}"
  case "$subcommand" in "" ) usage; exit 2 ;; -h|--help|help) usage; exit 0 ;; esac
  shift
  case "$subcommand" in
    create) cmd_group_create "$@" ;; add) cmd_group_add "$@" ;; configure) cmd_group_configure "$@" ;;
    archive|restore) cmd_group_archive_state "$subcommand" "$@" ;;
    promote) cmd_group_promote "$@" ;;
    review) cmd_group_review "$@" ;;
    accept|reject) cmd_group_review_disposition "$subcommand" "$@" ;;
    destination) cmd_group_destination "$@" ;;
    rename) cmd_group_rename "$@" ;;
    show) cmd_group_show "$@" ;; *) die "Unknown briefing group subcommand: $subcommand" 2 ;;
  esac
}

emit_route_plan() {
  local response="$1" json="$2"
  if (( json )); then
    printf '%s\n' "$response" | jq .
  else
    printf '%s\n' "$response" | api_jq_human \
      '(.routes[] | "\(.route_key)  \(.action)  group=\(.group_id | mandible_short_id)  artifact=\(.logical_artifact_id | mandible_short_id)  template=v\(.active_template_version) (\(.template_action))  current_revision=\(.current_revision // "none")"),
       "changed: \(.changed)"'
  fi
}

read_route_manifest() {
  local manifest_path="$1"
  if [[ "$manifest_path" == "-" ]]; then
    command cat
    return
  fi
  [[ -f "$manifest_path" ]] || die "Route manifest not found: $manifest_path" 2
  command cat -- "$manifest_path"
}

cmd_route_manifest() {
  local action="$1" manifest_path="" json=0 response payload
  shift
  local binding
  binding=$(mandible_bind_arguments "briefing.route.${action}" '{"json":{"option":"json","constant":"1"},"manifest_path":{"position":0}}' "$@") || return $?
  eval "$binding"
  [[ -n "$manifest_path" ]] || die "Usage: mandible briefing route $action <manifest.json|-> [--json]" 2
  command -v jq >/dev/null 2>&1 || die "jq not found" 1
  payload="$(read_route_manifest "$manifest_path")"
  printf '%s\n' "$payload" | jq -e 'type == "object"' >/dev/null \
    || die "Route manifest must be one JSON object." 2
  case "$action" in
    plan) response="$(api_send POST "/api/briefing-destination-routes/plan" "$payload")" \
      || die "Failed to plan Briefing destination routes." 1 ;;
    apply) response="$(api_send POST "/api/briefing-destination-routes" "$payload")" \
      || die "Failed to apply Briefing destination routes." 1 ;;
    *) die "Unknown Briefing destination route action: $action" 2 ;;
  esac
  emit_route_plan "$response" "$json"
}

cmd_route_inspect() {
  local route_key="" json=0 response
  local binding
  binding=$(mandible_bind_arguments "briefing.route.inspect" '{"json":{"option":"json","constant":"1"},"route_key":{"position":0}}' "$@") || return $?
  eval "$binding"
  if [[ -z "$route_key" ]]; then
    response="$(api_get "/api/briefing-destination-routes")" \
      || die "Failed to inspect Briefing destination routes." 1
  else
    response="$(api_get "/api/briefing-destination-routes/$(urlencode "$route_key")")" \
      || die "Failed to inspect Briefing destination route." 1
  fi
  if (( json )); then
    printf '%s\n' "$response" | jq .
  else
    printf '%s\n' "$response" | api_jq_human \
      '.routes[] | "\(.route_key)  group=\(.group_id | mandible_short_id)  artifact=\(.logical_artifact_id | mandible_short_id)  \(.publication_mode)  \(.composer_kind)  template=v\(.active_template_version)"'
  fi
}

cmd_route() {
  local subcommand="${1:-}"
  case "$subcommand" in "") usage; exit 2 ;; -h|--help|help) usage; exit 0 ;; esac
  shift
  case "$subcommand" in
    inspect) cmd_route_inspect "$@" ;;
    plan|apply) cmd_route_manifest "$subcommand" "$@" ;;
    *) die "Unknown briefing route subcommand: $subcommand" 2 ;;
  esac
}

cmd_bundle_show() {
  local bundle_ref="" json=0 response
  local binding
  binding=$(mandible_bind_arguments "briefing.bundle.show" '{"json":{"option":"json","constant":"1"},"bundle_ref":{"position":0}}' "$@") || return $?
  eval "$binding"
  [[ -n "$bundle_ref" ]] || die "Usage: $(mandible_command_syntax briefing.bundle.show)" 2
  command -v jq >/dev/null 2>&1 || die "jq not found" 1
  response="$(api_get "/api/briefing-bundles/$(urlencode "$bundle_ref")")" \
    || die "Failed to show Briefing bundle." 1
  emit_bundle "$response" "$json"
}

cmd_bundle_rename() {
  local bundle_ref="" name="" json=0 response payload
  local binding
  binding=$(mandible_bind_arguments "briefing.bundle.rename" '{"name":{"option":"name"},"json":{"option":"json","constant":"1"},"bundle_ref":{"position":0}}' "$@") || return $?
  eval "$binding"
  [[ -n "$bundle_ref" && -n "${name//[[:space:]]/}" ]] \
    || die "Usage: $(mandible_command_syntax briefing.bundle.rename)" 2
  command -v jq >/dev/null 2>&1 || die "jq not found" 1
  payload="$(jq -n --arg name "$name" '{name:$name}')"
  response="$(api_send PATCH "/api/briefing-bundles/$(urlencode "$bundle_ref")" "$payload")" \
    || die "Failed to rename Briefing bundle." 1
  emit_bundle "$response" "$json"
}

cmd_bundle_delete() {
  local bundle_ref="" json=0 response
  local binding
  binding=$(mandible_bind_arguments "briefing.bundle.delete" '{"json":{"option":"json","constant":"1"},"bundle_ref":{"position":0}}' "$@") || return $?
  eval "$binding"
  [[ -n "$bundle_ref" ]] || die "Usage: $(mandible_command_syntax briefing.bundle.delete)" 2
  response="$(api_send DELETE "/api/briefing-bundles/$(urlencode "$bundle_ref")" '{}')" \
    || die "Failed to delete empty standalone Briefing bundle." 1
  if (( json )); then
    printf '%s\n' "$response" | jq .
  else
    printf '%s\n' "$response" | api_jq_human \
      '"deleted briefing-bundle:\(.bundle_id | mandible_short_id)  \(.name)"'
  fi
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
    delete) cmd_bundle_delete "$@" ;;
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
  describe) cmd_describe "$@" ;;
  archive) cmd_archive_state archive "$@" ;;
  restore) cmd_archive_state restore "$@" ;;
  bundle) cmd_bundle "$@" ;;
  group) cmd_group "$@" ;;
  route) cmd_route "$@" ;;
  report) [[ "${1:-}" == "update" ]] || die "Usage: $(mandible_command_syntax briefing.report.update)" 2; shift; cmd_report_update "$@" ;;
  *) die "Unknown briefing subcommand: $subcommand" 2 ;;
esac
