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
  mandible briefing create <artifact-version-ref> --title <text> [--description <text>] [--comparison-base <artifact-version-ref>] [--briefing <briefing-ref> | --reason <text>] [--json]
  mandible briefing rename <briefing-ref> --title <text> [--json]
  mandible briefing describe <briefing-ref> (--description <text>|--clear) [--json]
  mandible briefing archive <briefing-ref> [--json]
  mandible briefing restore <briefing-ref> [--json]
  mandible briefing bundle create --name <name> [<briefing-ref>...] [--sharing-reason <text>] [--json]
  mandible briefing bundle add <bundle-ref> <briefing-ref> [--sharing-reason <text>] [--json]
  mandible briefing bundle replace <bundle-ref> [<briefing-ref>...] [--layout <json>] [--sharing-reason <text>] [--json]
  mandible briefing bundle rename <bundle-ref> --name <text> [--json]
  mandible briefing bundle delete <bundle-ref> [--json]
  mandible briefing bundle show <bundle-ref> [--json]
  mandible briefing group create --key <key> --name <name> [--current <bundle-ref>] [<proposal-bundle-ref>...] [--sharing-reason <text>] [--json]
  mandible briefing group add <group-ref> <bundle-ref> [--sharing-reason <text>] [--json]
  mandible briefing group configure <group-ref> --current <bundle-ref|none> [<proposal-bundle-ref>...] [--sharing-reason <text>] [--json]
  mandible briefing group archive <group-ref> [--json]
  mandible briefing group restore <group-ref> [--json]
  mandible briefing group promote <group-ref> --expected-base <bundle-ref> --proposal <bundle-ref> --auth-request <request-ref> --merge-head <sha> [--json]
  mandible briefing group review <group-ref> --expected-base <bundle-ref> --proposal <bundle-ref> [--destination-changes <json>] [--json]
  mandible briefing group accept <group-ref> --expected-base <bundle-ref> --proposal <bundle-ref> --binding-digest <sha256> [--destination-changes <json>] [--json]
  mandible briefing group reject <group-ref> --expected-base <bundle-ref> --proposal <bundle-ref> --binding-digest <sha256> [--destination-changes <json>] [--json]
  mandible briefing group destination bind <group-ref> <logical-artifact-ref> [--json]
  mandible briefing group rename <group-ref> --name <text> [--json]
  mandible briefing group show <group-ref> [--json]
  mandible briefing route inspect [<route-key>] [--json]
  mandible briefing route plan <manifest.json|-> [--json]
  mandible briefing route apply <manifest.json|-> [--json]

Creates a Briefing whose round is bound to exactly the named artifact version.
If an active Briefing already owns that logical Artifact, the command reports
every candidate with reuse/add-round guidance. Use --briefing to target one
candidate, or --reason to create a separate identity with an
authenticated durable receipt. Archived candidates are advisory. This command
never resolves a logical artifact or series to latest.

A Briefing bundle is only a named, manually ordered association. Creating or
adding to one does not change member Briefings, rounds, artifacts, or review data.

A destination-route manifest uses schema mandible-briefing-destination-routes@3.
Each route declares `publication_mode`: reviewed-document creates a Base-relative
proposal for configured-human disposition; published-report appends an immutable
round to the already-placed Briefing and advances Current without changing group Base.
Plan resolves each logical Artifact through its active destination owner without writing.
Apply atomically creates or upgrades the declared routes. Exact replay is
unchanged; ownership, identity, template downgrade, and same-version template
drift fail closed.
EOF
}

cmd_archive_state() {
  local action="$1" briefing_ref="" json=0 response encoded
  shift
  while (( $# > 0 )); do
    case "$1" in
      --json) json=1; shift ;;
      -*) die "Unknown option: $1" 2 ;;
      *) [[ -z "$briefing_ref" ]] || die "Unexpected argument: $1" 2; briefing_ref="$1"; shift ;;
    esac
  done
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

cmd_describe() {
  local briefing_ref="" description="" has_description=0 clear=0 json=0 response payload
  while (( $# > 0 )); do
    case "$1" in
      --description) [[ $# -ge 2 ]] || die "--description requires a value" 2; description="$2"; has_description=1; shift 2 ;;
      --clear) clear=1; shift ;;
      --json) json=1; shift ;;
      -*) die "Unknown option: $1" 2 ;;
      *) [[ -z "$briefing_ref" ]] || die "Unexpected argument: $1" 2; briefing_ref="$1"; shift ;;
    esac
  done
  [[ -n "$briefing_ref" && $((has_description + clear)) -eq 1 ]] \
    || die "Usage: mandible briefing describe <briefing-ref> (--description <text>|--clear) [--json]" 2
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
      '"briefing:\(.briefing_id | mandible_short_id)  \(if .description == null then "description cleared" else .description end)"'
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
  local artifact_version_ref="" comparison_base="" target_briefing="" distinct_reason="" title="" description="" has_description=0 has_target_briefing=0 has_distinct_reason=0 json=0 response payload
  while (( $# > 0 )); do
    case "$1" in
      --title) [[ $# -ge 2 ]] || die "--title requires a value" 2; title="$2"; shift 2 ;;
      --description) [[ $# -ge 2 ]] || die "--description requires a value" 2; description="$2"; has_description=1; shift 2 ;;
      --comparison-base) [[ $# -ge 2 ]] || die "--comparison-base requires a value" 2; comparison_base="$2"; shift 2 ;;
      --briefing) [[ $# -ge 2 ]] || die "--briefing requires a value" 2; target_briefing="$2"; has_target_briefing=1; shift 2 ;;
      --reason) [[ $# -ge 2 ]] || die "--reason requires a value" 2; distinct_reason="$2"; has_distinct_reason=1; shift 2 ;;
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
      '"\(.outcome | gsub("_"; " ")) briefing \(.briefing_id | mandible_short_id) round \(.round_id | mandible_short_id) from \(.artifact_version_id | mandible_typed_short_ref)\(if (.archived_candidates | length) > 0 then "; archived advisories=" + ((.archived_candidates | length) | tostring) else "" end)"'
  fi
}

cmd_bundle_create() {
  local name="" sharing_reason="" json=0 response payload
  local -a briefing_refs
  briefing_refs=()
  while (( $# > 0 )); do
    case "$1" in
      --name) [[ $# -ge 2 ]] || die "--name requires a value" 2; name="$2"; shift 2 ;;
      --sharing-reason) [[ $# -ge 2 ]] || die "--sharing-reason requires a value" 2; sharing_reason="$2"; shift 2 ;;
      --json) json=1; shift ;;
      -*) die "Unknown option: $1" 2 ;;
      *) briefing_refs+=("$1"); shift ;;
    esac
  done
  [[ -n "${name//[[:space:]]/}" ]] || die "bundle create requires --name <name>" 2
  command -v jq >/dev/null 2>&1 || die "jq not found" 1
  payload="$(jq -n --arg name "$name" --arg reason "$sharing_reason" --args \
    '{name:$name,briefing_refs:$ARGS.positional} + (if $reason == "" then {} else {sharing_reason:$reason} end)' -- "${briefing_refs[@]}")"
  response="$(api_send POST "/api/briefing-bundles" "$payload")" || die "Failed to create Briefing bundle." 1
  emit_bundle "$response" "$json"
}

cmd_bundle_add() {
  local bundle_ref="" briefing_ref="" sharing_reason="" json=0 response payload
  while (( $# > 0 )); do
    case "$1" in
      --json) json=1; shift ;;
      --sharing-reason) [[ $# -ge 2 ]] || die "--sharing-reason requires a value" 2; sharing_reason="$2"; shift 2 ;;
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
  while (( $# > 0 )); do
    case "$1" in
      --json) json=1; shift ;;
      --layout) [[ $# -ge 2 ]] || die "--layout requires a JSON value" 2; layout="$2"; shift 2 ;;
      --sharing-reason) [[ $# -ge 2 ]] || die "--sharing-reason requires a value" 2; sharing_reason="$2"; shift 2 ;;
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
  while (( $# > 0 )); do
    case "$1" in
      --key) [[ $# -ge 2 ]] || die "--key requires a value" 2; key="$2"; shift 2 ;;
      --name) [[ $# -ge 2 ]] || die "--name requires a value" 2; name="$2"; shift 2 ;;
      --current) [[ $# -ge 2 ]] || die "--current requires a value" 2; current_bundle_ref="$2"; shift 2 ;;
      --sharing-reason) [[ $# -ge 2 ]] || die "--sharing-reason requires a value" 2; sharing_reason="$2"; shift 2 ;;
      --json) json=1; shift ;;
      -*) die "Unknown option: $1" 2 ;;
      *) bundle_refs+=("$1"); shift ;;
    esac
  done
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
  while (( $# > 0 )); do
    case "$1" in
      --current) [[ $# -ge 2 ]] || die "--current requires a value" 2
        current_bundle_ref="$2"; current_set=1; shift 2 ;;
      --sharing-reason) [[ $# -ge 2 ]] || die "--sharing-reason requires a value" 2; sharing_reason="$2"; shift 2 ;;
      --json) json=1; shift ;;
      -*) die "Unknown option: $1" 2 ;;
      *) if [[ -z "$group_ref" ]]; then group_ref="$1"; else bundle_refs+=("$1"); fi; shift ;;
    esac
  done
  [[ -n "$group_ref" && $current_set -eq 1 ]] \
    || die "Usage: mandible briefing group configure <group-ref> --current <bundle-ref|none> [<proposal-bundle-ref>...] [--json]" 2
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
  while (( $# > 0 )); do
    case "$1" in
      --json) json=1; shift ;;
      --sharing-reason) [[ $# -ge 2 ]] || die "--sharing-reason requires a value" 2; sharing_reason="$2"; shift 2 ;;
      -*) die "Unknown option: $1" 2 ;;
      *) if [[ -z "$group_ref" ]]; then group_ref="$1"; elif [[ -z "$bundle_ref" ]]; then bundle_ref="$1";
         else die "Unexpected argument: $1" 2; fi; shift ;;
    esac
  done
  [[ -n "$group_ref" && -n "$bundle_ref" ]] || die "Usage: mandible briefing group add <group-ref> <bundle-ref> [--json]" 2
  command -v jq >/dev/null 2>&1 || die "jq not found" 1
  payload="$(jq -n --arg bundle_ref "$bundle_ref" --arg reason "$sharing_reason" \
    '{bundle_ref:$bundle_ref} + (if $reason == "" then {} else {sharing_reason:$reason} end)')"
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

cmd_group_promote() {
  local group_ref="" expected_base="" proposal="" auth_request="" merge_head="" json=0 response payload
  while (( $# > 0 )); do
    case "$1" in
      --expected-base) [[ $# -ge 2 ]] || die "--expected-base requires a value" 2; expected_base="$2"; shift 2 ;;
      --proposal) [[ $# -ge 2 ]] || die "--proposal requires a value" 2; proposal="$2"; shift 2 ;;
      --auth-request) [[ $# -ge 2 ]] || die "--auth-request requires a value" 2; auth_request="$2"; shift 2 ;;
      --merge-head) [[ $# -ge 2 ]] || die "--merge-head requires a value" 2; merge_head="$2"; shift 2 ;;
      --json) json=1; shift ;;
      -*) die "Unknown option: $1" 2 ;;
      *) [[ -z "$group_ref" ]] || die "Unexpected argument: $1" 2; group_ref="$1"; shift ;;
    esac
  done
  [[ -n "$group_ref" && -n "$expected_base" && -n "$proposal" && -n "$auth_request" ]] \
    || die "Usage: mandible briefing group promote <group-ref> --expected-base <bundle-ref> --proposal <bundle-ref> --auth-request <request-ref> --merge-head <sha> [--json]" 2
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
  while (( $# > 0 )); do
    case "$1" in
      --expected-base) [[ $# -ge 2 ]] || die "--expected-base requires a value" 2; expected_base="$2"; shift 2 ;;
      --proposal) [[ $# -ge 2 ]] || die "--proposal requires a value" 2; proposal="$2"; shift 2 ;;
      --binding-digest) [[ $# -ge 2 ]] || die "--binding-digest requires a value" 2; binding_digest="$2"; shift 2 ;;
      --destination-changes) [[ $# -ge 2 ]] || die "--destination-changes requires JSON" 2
        destination_changes="$2"; shift 2 ;;
      --json) json=1; shift ;;
      -*) die "Unknown option: $1" 2 ;;
      *) [[ -z "$group_ref" ]] || die "Unexpected argument: $1" 2; group_ref="$1"; shift ;;
    esac
  done
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
  while (( $# > 0 )); do
    case "$1" in
      --expected-base) [[ $# -ge 2 ]] || die "--expected-base requires a value" 2; expected_base="$2"; shift 2 ;;
      --proposal) [[ $# -ge 2 ]] || die "--proposal requires a value" 2; proposal="$2"; shift 2 ;;
      --destination-changes) [[ $# -ge 2 ]] || die "--destination-changes requires JSON" 2
        destination_changes="$2"; shift 2 ;;
      --json) json=1; shift ;;
      -*) die "Unknown option: $1" 2 ;;
      *) [[ -z "$group_ref" ]] || die "Unexpected argument: $1" 2; group_ref="$1"; shift ;;
    esac
  done
  [[ -n "$group_ref" && -n "$expected_base" && -n "$proposal" ]] \
    || die "Usage: mandible briefing group review <group-ref> --expected-base <bundle-ref> --proposal <bundle-ref> [--destination-changes <json>] [--json]" 2
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
  [[ "$action" == "bind" ]] || die "Usage: mandible briefing group destination bind <group-ref> <logical-artifact-ref> [--json]" 2
  while (( $# > 0 )); do
    case "$1" in
      --json) json=1; shift ;;
      -*) die "Unknown option: $1" 2 ;;
      *) if [[ -z "$group_ref" ]]; then group_ref="$1"; elif [[ -z "$artifact_ref" ]]; then artifact_ref="$1";
         else die "Unexpected argument: $1" 2; fi; shift ;;
    esac
  done
  [[ -n "$group_ref" && -n "$artifact_ref" ]] \
    || die "Usage: mandible briefing group destination bind <group-ref> <logical-artifact-ref> [--json]" 2
  payload="$(jq -n --arg artifact "$artifact_ref" '{logical_artifact_ref:$artifact}')"
  response="$(api_send POST "/api/briefing-groups/$(urlencode "$group_ref")/destinations" "$payload")" \
    || die "Failed to bind Briefing destination owner." 1
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

cmd_group_archive_state() {
  local action="$1" group_ref="" json=0 response
  shift
  while (( $# > 0 )); do
    case "$1" in
      --json) json=1; shift ;;
      -*) die "Unknown option: $1" 2 ;;
      *) [[ -z "$group_ref" ]] || die "Unexpected argument: $1" 2; group_ref="$1"; shift ;;
    esac
  done
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
      '(.routes[] | "\(.route_key)  \(.action)  group=\(.group_id | mandible_short_id)  artifact=\(.logical_artifact_id | mandible_short_id)  template=v\(.active_template_version) (\(.template_action))"),
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
  while (( $# > 0 )); do
    case "$1" in
      --json) json=1; shift ;;
      -) [[ -z "$manifest_path" ]] || die "Unexpected argument: $1" 2; manifest_path="$1"; shift ;;
      -*) die "Unknown option: $1" 2 ;;
      *) [[ -z "$manifest_path" ]] || die "Unexpected argument: $1" 2; manifest_path="$1"; shift ;;
    esac
  done
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
  while (( $# > 0 )); do
    case "$1" in
      --json) json=1; shift ;;
      -*) die "Unknown option: $1" 2 ;;
      *) [[ -z "$route_key" ]] || die "Unexpected argument: $1" 2; route_key="$1"; shift ;;
    esac
  done
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

cmd_bundle_delete() {
  local bundle_ref="" json=0 response
  while (( $# > 0 )); do
    case "$1" in
      --json) json=1; shift ;;
      -*) die "Unknown option: $1" 2 ;;
      *) [[ -z "$bundle_ref" ]] || die "Unexpected argument: $1" 2; bundle_ref="$1"; shift ;;
    esac
  done
  [[ -n "$bundle_ref" ]] || die "Usage: mandible briefing bundle delete <bundle-ref> [--json]" 2
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
  *) die "Unknown briefing subcommand: $subcommand" 2 ;;
esac
