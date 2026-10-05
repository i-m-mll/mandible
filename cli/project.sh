#!/usr/bin/env zsh
# mandible project: canonical project registry CLI over the Mandible daemon API.
#
# Routes:
#   GET  /api/projects                   list
#   GET  /api/projects/<ref>             show (fuzzy resolve by key/id/root/remote/display)
#   POST /api/projects                   add
#   PATCH /api/projects/<ref>            update
#   POST /api/projects/<ref>/checkouts   add-checkout
#   POST /api/projects/checkouts         update-checkout (by root)
#   GET  /api/projects/audit             audit
#   POST /api/projects/repair            repair
source "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd -P)/command-syntax.sh"

set -euo pipefail

API_HELPER="${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/api.sh"
source "$API_HELPER"

RESET=$'\033[0m'
RED=$'\033[31m'
GREEN=$'\033[32m'

err() {
  printf "%b\n" "$*" >&2
}

die() {
  err "$1"
  exit "${2:-1}"
}

usage() {
  mandible_command_help project
}

require_tools() {
  api_is_file_rpc || command -v curl >/dev/null 2>&1 || die "curl not found." 1
  command -v jq >/dev/null 2>&1 || die "jq not found." 1
}

emit() {
  # $1 = json result, $2 = json flag (0 or 1), $3 = human jq filter
  local result="$1" json="$2" human="$3"
  if (( json )); then
    printf '%s\n' "$result" | jq .
  else
    printf '%s\n' "$result" | api_jq_human "$human"
  fi
}

cmd_list() {
  local json=0
  local binding
  binding=$(mandible_bind_arguments "project.list" '{"json":{"option":"json","constant":"1"}}' "$@") || return $?
  eval "$binding"
  require_tools
  local response
  response="$(api_get "/api/projects")" || die "${RED}Failed to list projects.${RESET}" 1
  emit "$response" "$json" \
    '.projects[]? | "\(.project_key)\t\(.display_name)\t\(.issue_count) issues\t\(.remote_identity // "-")"'
}

cmd_show() {
  local ref="" json=0
  local binding
  binding=$(mandible_bind_arguments "project.show" '{"json":{"option":"json","constant":"1"},"ref":{"position":0}}' "$@") || return $?
  eval "$binding"
  [[ -n "$ref" ]] || die "Usage: $(mandible_command_syntax project.show)" 2
  require_tools
  local tmp_response status_code response
  tmp_response=$(mktemp)
  status_code=$(api_send_capture GET "/api/projects/$(urlencode "$ref")" "" "$tmp_response")
  response=$(cat "$tmp_response")
  rm -f "$tmp_response"
  if [[ "$status_code" =~ ^2 ]]; then
    emit "$response" "$json" \
      '.project | "key: \(.project_key)\ndisplay: \(.display_name)\nremote: \(.remote_identity // "-")\nnamespace: \(.namespace_policy // "-")\nopen: \(.open_issue_count) closed: \(.closed_issue_count)\ncheckouts:\n\([.checkouts[]? | "  \(.root) (\(.work_repo_id // "-"))"] | join("\n"))"'
  else
    local errmsg suggestions
    errmsg=$(printf '%s' "$response" | jq -r '.error // "not found"')
    suggestions=$(printf '%s' "$response" | jq -r '(.suggestions // .candidates // []) | join(", ")')
    if [[ -n "$suggestions" ]]; then
      err "${RED}Error: ${errmsg}. Did you mean: ${suggestions}?${RESET}"
    else
      err "${RED}Error: ${errmsg}${RESET}"
    fi
    exit 1
  fi
}

cmd_add() {
  local key="" display="" remote="" namespace="" root="" json=0
  local binding
  binding=$(mandible_bind_arguments "project.add" '{"key":{"option":"key"},"display":{"option":"display"},"remote":{"option":"remote"},"namespace":{"option":"namespace"},"root":{"option":"root"},"json":{"option":"json","constant":"1"}}' "$@") || return $?
  eval "$binding"
  [[ -n "$key" ]] || die "Usage: $(mandible_command_syntax project.add)" 2
  require_tools
  local payload response
  payload="$(jq -n \
    --arg key "$key" --arg display "$display" --arg remote "$remote" --arg namespace "$namespace" \
    '{key:$key}
     + (if $display == "" then {} else {display:$display} end)
     + (if $remote == "" then {} else {remote:$remote} end)
     + (if $namespace == "" then {} else {namespace:$namespace} end)')"
  response="$(api_send POST "/api/projects" "$payload")" || die "${RED}Failed to create project.${RESET}" 1
  err "${GREEN}Created project ${key}${RESET}"
  if [[ -n "$root" ]]; then
    local checkout_payload checkout_response
    checkout_payload="$(jq -n --arg root "$root" '{root:$root}')"
    checkout_response="$(api_send POST "/api/projects/$(urlencode "$key")/checkouts" "$checkout_payload")" \
      || die "${RED}Failed to register checkout.${RESET}" 1
    if (( json )); then
      printf '%s\n' "$checkout_response" | jq .
    fi
  elif (( json )); then
    printf '%s\n' "$response" | jq .
  fi
}

cmd_update() {
  local ref="" key="" display="" remote="" namespace="" json=0
  local binding
  binding=$(mandible_bind_arguments "project.update" '{"key":{"option":"key"},"display":{"option":"display"},"remote":{"option":"remote"},"namespace":{"option":"namespace"},"json":{"option":"json","constant":"1"},"ref":{"position":0}}' "$@") || return $?
  eval "$binding"
  [[ -n "$ref" ]] || die "Usage: $(mandible_command_syntax project.update)" 2
  require_tools
  local payload response
  payload="$(jq -n \
    --arg key "$key" --arg display "$display" --arg remote "$remote" --arg namespace "$namespace" \
    '{}
     + (if $key == "" then {} else {key:$key} end)
     + (if $display == "" then {} else {display:$display} end)
     + (if $remote == "" then {} else {remote:$remote} end)
     + (if $namespace == "" then {} else {namespace:$namespace} end)')"
  response="$(api_send PATCH "/api/projects/$(urlencode "$ref")" "$payload")" || die "${RED}Failed to update project.${RESET}" 1
  emit "$response" "$json" '.project | "updated \(.project_key)"'
}

cmd_add_checkout() {
  local ref="" root="" work_repo_id="" default_branch="" name="" json=0
  local binding
  binding=$(mandible_bind_arguments "project.add-checkout" '{"root":{"option":"root"},"work_repo_id":{"option":"work-repo-id"},"default_branch":{"option":"default-branch"},"name":{"option":"name"},"json":{"option":"json","constant":"1"},"ref":{"position":0}}' "$@") || return $?
  eval "$binding"
  [[ -n "$ref" && -n "$root" ]] || die "Usage: $(mandible_command_syntax project.add-checkout)" 2
  require_tools
  local payload response
  payload="$(jq -n \
    --arg root "$root" --arg work_repo_id "$work_repo_id" \
    --arg default_branch "$default_branch" --arg name "$name" \
    '{root:$root}
     + (if $work_repo_id == "" then {} else {work_repo_id:$work_repo_id} end)
     + (if $default_branch == "" then {} else {default_branch:$default_branch} end)
     + (if $name == "" then {} else {name:$name} end)')"
  response="$(api_send POST "/api/projects/$(urlencode "$ref")/checkouts" "$payload")" \
    || die "${RED}Failed to add checkout.${RESET}" 1
  emit "$response" "$json" '"added checkout \(.checkout.root) to \(.project.project_key)"'
}

cmd_update_checkout() {
  local project="" root="" work_repo_id="" default_branch="" name="" json=0
  local binding
  binding=$(mandible_bind_arguments "project.update-checkout" '{"project":{"option":"project"},"root":{"option":"root"},"work_repo_id":{"option":"work-repo-id"},"default_branch":{"option":"default-branch"},"name":{"option":"name"},"json":{"option":"json","constant":"1"}}' "$@") || return $?
  eval "$binding"
  [[ -n "$root" && -n "$project" ]] || die "Usage: $(mandible_command_syntax project.update-checkout)" 2
  require_tools
  local payload response
  payload="$(jq -n \
    --arg project "$project" --arg root "$root" \
    --arg work_repo_id "$work_repo_id" --arg default_branch "$default_branch" --arg name "$name" \
    '{project:$project, root:$root}
     + (if $work_repo_id == "" then {} else {work_repo_id:$work_repo_id} end)
     + (if $default_branch == "" then {} else {default_branch:$default_branch} end)
     + (if $name == "" then {} else {name:$name} end)')"
  response="$(api_send POST "/api/projects/checkouts" "$payload")" \
    || die "${RED}Failed to update checkout.${RESET}" 1
  emit "$response" "$json" '"updated checkout \(.checkout.root) in \(.project.project_key)"'
}

cmd_audit() {
  local json=0
  local binding
  binding=$(mandible_bind_arguments "project.audit" '{"json":{"option":"json","constant":"1"}}' "$@") || return $?
  eval "$binding"
  require_tools
  local response
  response="$(api_get "/api/projects/audit")" || die "${RED}Failed to fetch audit.${RESET}" 1
  if (( json )); then
    printf '%s\n' "$response" | jq .
  else
    printf '%s\n' "$response" | jq -r '
      .audit |
      "duplicate_display_names: \(.duplicate_display_names | length)",
      "local_projects: \(.local_projects | length)",
      "numbered_repo_ids: \(.numbered_repo_ids | length)",
      "ambiguous_roots: \(.ambiguous_roots | length)",
      "missing_keys: \(.missing_keys | length)",
      "mergeable_local_projects: \((.mergeable_local_projects // []) | length)",
      "unmergeable_local_projects: \(.unmergeable_local_projects | length)",
      if (.numbered_repo_ids | length) > 0 then
        "  numbered_repo_ids: \([.numbered_repo_ids[] | "\(.work_repo_id) (\(.project_key))"] | join(", "))"
      else empty end,
      if (.duplicate_display_names | length) > 0 then
        "  duplicate_display_names: \([.duplicate_display_names[] | .display_name] | join(", "))"
      else empty end,
      if ((.mergeable_local_projects // []) | length) > 0 then
        "  mergeable: \([.mergeable_local_projects[] | "\(.project_key)->\(.merge_into)"] | join(", "))"
      else empty end
    '
  fi
}

cmd_repair() {
  local apply=0 force=0 merge_src="" merge_dst="" json=0
  local binding
  binding=$(mandible_bind_arguments "project.repair" '{"apply":{"option":"apply","constant":"1"},"force":{"option":"force","constant":"1"},"merge_src":{"option":"merge","valueIndex":0},"merge_dst":{"option":"merge","valueIndex":1},"json":{"option":"json","constant":"1"}}' "$@") || return $?
  eval "$binding"
  require_tools
  local payload response
  payload="$(jq -n \
    --argjson apply "$apply" --argjson force "$force" \
    --arg merge_src "$merge_src" --arg merge_dst "$merge_dst" \
    '{apply:($apply == 1), force:($force == 1)}
     + (if $merge_src == "" then {} else {merge:{source:$merge_src, target:$merge_dst}} end)')"
  response="$(api_send POST "/api/projects/repair" "$payload")" || die "${RED}Failed to repair projects.${RESET}" 1
  if (( json )); then
    printf '%s\n' "$response" | jq .
  else
    printf '%s\n' "$response" | api_jq_human '
      .report |
      "keys_backfilled: \(.keys_backfilled)",
      if .merge then
        "merge \(.merge.source_project_id | mandible_short_id) -> \(.merge.target_project_id | mandible_short_id)",
        "merge rows to move: \(([.merge.moves[]?.rows] | add) // 0) across \((.merge.moves // []) | length) table-column(s)",
        if ((.merge.conflicts // []) | length) > 0 then
          "conflicts: \([.merge.conflicts[] | "\(.kind):\(.value)"] | join(", "))"
        else empty end,
        "merge applied: \(.merge.applied)"
      else empty end,
      if .applied then
        "applied: yes"
      else
        "dry run; pass --apply to execute"
      end
    '
  fi
}

if [[ $# -eq 0 || "${1:-}" == "-h" || "${1:-}" == "--help" || "${1:-}" == "help" ]]; then
  usage
  [[ $# -eq 0 ]] && exit 2 || exit 0
fi

cmd="$1"
shift
case "$cmd" in
  list)            cmd_list "$@" ;;
  show)            cmd_show "$@" ;;
  add)             cmd_add "$@" ;;
  update)          cmd_update "$@" ;;
  add-checkout)    cmd_add_checkout "$@" ;;
  update-checkout) cmd_update_checkout "$@" ;;
  audit)           cmd_audit "$@" ;;
  repair)          cmd_repair "$@" ;;
  *) die "Unknown project subcommand: $cmd" 2 ;;
esac
