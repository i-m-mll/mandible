#!/usr/bin/env zsh
# mandible user: user registry CLI over the Mandible daemon API.
#
# Routes:
#   GET  /api/users                          list (?kind=&status=)
#   POST /api/users                          create
#   GET  /api/users/<ref>                    show (with credentials + bindings)
#   PATCH /api/users/<ref>                   update
#   GET  /api/users/operator                 current operator
#   POST /api/users/setup                    idempotent operator setup
#   dashboard-link                          same-user dashboard enrollment URL
#   GET  /api/users/<ref>/credentials        list credentials
#   POST /api/users/<ref>/credentials        add credential
#   POST /api/users/credentials/<id>/revoke  revoke credential
#   GET  /api/users/<ref>/bindings           list bindings
#   POST /api/users/<ref>/bindings           add binding
#   DELETE /api/users/bindings/<id>          remove binding

set -euo pipefail

API_HELPER="${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/api.sh"
source "$API_HELPER"

RESET=$'\033[0m'
RED=$'\033[31m'
GREEN=$'\033[32m'

err() { printf "%b\n" "$*" >&2; }
die() { err "$1"; exit "${2:-1}"; }

usage() {
  cat <<'EOF'
Usage:
  mandible user setup [--slug <s>] [--name <n>] [--email <e>] [--agents] [--json]
  mandible user dashboard-link
  mandible user list [--kind <k>] [--status <s>] [--json]
  mandible user show <ref> [--json]
  mandible user update <ref> [--name <n>] [--email <e>] [--status active|retired] [--json]
  mandible user credential add <ref> (--type <t> --fingerprint <f> [--public-material <m>] | --from-git-signingkey) [--label <l>] [--json]
  mandible user credential revoke <id> [--json]
  mandible user credential list <ref> [--all] [--json]
  mandible user token mint <ref> [--label <l>] [--json]
  mandible user token list <ref> [--all] [--json]
  mandible user token revoke <credential-id> [--json]
  mandible user binding add <ref> --type <t> --value <v> [--scope <s>] [--json]
  mandible user binding rm <id> [--json]
  mandible user binding list <ref> [--json]
  mandible user group add <slug> [--name <n>] [--json]
  mandible user group rm <ref> [--json]
  mandible user group members <ref> [--add <user>|--rm <user>] [--json]
  mandible user grant add --subject-type user|group --subject <ref> (--project <ref> --role read|write|admin | --global <capability>) [--json]
  mandible user grant rm <id> [--json]
  mandible user grant list [--resource-type project|global] [--resource-id <id>] [--json]
  mandible user access <user> <project> [--json]

Setup is idempotent and is the only way the local human operator is created.
--agents deliberately provisions the claude-code, codex, and gemini users,
their app and provider-session-environment bindings.
Defaults for --name/--email come from git config user.name / user.email.
Credentials are immutable: revoke then add, never mutate a fingerprint. No
private key material is ever accepted.

Tokens are per-user bearer secrets stored hashed (never in the clear). The raw
token is printed once at mint time and cannot be retrieved again; export it as
MANDIBLE_TOKEN for the CLI to authenticate. Revoke a token via its credential id.
Use dashboard-link to enroll a browser without placing a bearer token in an HTTP URL.
EOF
}

require_tools() {
  api_is_file_rpc || command -v curl >/dev/null 2>&1 || die "curl not found." 1
  command -v jq >/dev/null 2>&1 || die "jq not found." 1
}

emit() {
  local result="$1" json="$2" human="$3"
  if (( json )); then
    printf '%s\n' "$result" | jq .
  else
    printf '%s\n' "$result" | jq -r "$human"
  fi
}

git_config_value() {
  git config --get "$1" 2>/dev/null || true
}

git_config_value_without_overrides() {
  (
    unset GIT_CONFIG_COUNT
    unset GIT_CONFIG_PARAMETERS
    local var
    for var in $(env | sed -n 's/^\(GIT_CONFIG_\(KEY\|VALUE\)_[0-9][0-9]*\)=.*/\1/p'); do
      unset "$var"
    done
    git config --get "$1" 2>/dev/null || true
  )
}

cmd_setup() {
  local slug="" name="" email="" json=0 email_set=0 agents=0
  while (( $# > 0 )); do
    case "$1" in
      --slug)  slug="$2"; shift 2 ;;
      --name)  name="$2"; shift 2 ;;
      --email) email="$2"; email_set=1; shift 2 ;;
      --agents) agents=1; shift ;;
      --json)  json=1; shift ;;
      -*) die "Unknown option: $1" 2 ;;
      *) die "Unexpected argument: $1" 2 ;;
    esac
  done
  [[ -n "$name" ]] || name="$(git_config_value user.name)"
  if (( ! email_set )); then
    email="$(git_config_value user.email)"
  fi
  require_tools
  local payload response
  payload="$(jq -n \
    --arg slug "$slug" --arg name "$name" --arg email "$email" \
    --argjson agents "$agents" \
    '{}
     + (if $slug == "" then {} else {slug:$slug} end)
     + (if $name == "" then {} else {display_name:$name} end)
     + (if $email == "" then {} else {email:$email} end)
     + (if $agents == 1 then {setup_agents:true} else {} end)')"
  response="$(api_send POST "/api/users/setup" "$payload")" || die "${RED}Setup failed.${RESET}" 1
  err "${GREEN}Operator ready.${RESET}"
  (( agents == 0 )) || err "${GREEN}Agent users ready.${RESET}"
  emit "$response" "$json" '.user | "id: \(.id)\nslug: \(.slug)\nname: \(.display_name)\nemail: \(.email // "-")"'
}

cmd_dashboard_link() {
  require_tools
  local token encoded base bootstrap_file=""
  if [[ -z "${MANDIBLE_TOKEN:-}" ]]; then
    bootstrap_file="$(api_client_auth_config_dir)/client-auth/bootstrap-token"
  fi
  token="$(api_client_token)"
  [[ -n "$token" ]] \
    || die "No operator bootstrap token is available. Run mandible user setup first." 1
  encoded="$(jq -rn --arg value "$token" '$value|@uri')"
  base="$(api_base)"
  [[ "$base" == http://* || "$base" == https://* ]] \
    || die "Dashboard enrollment requires an HTTP Mandible endpoint." 1
  [[ -z "$bootstrap_file" ]] || rm -f -- "$bootstrap_file"
  printf '%s/#/?mandible_auth=%s\n' "${base%/}" "$encoded"
}

cmd_list() {
  local kind="" status_filter="" json=0
  while (( $# > 0 )); do
    case "$1" in
      --kind)   kind="$2"; shift 2 ;;
      --status) status_filter="$2"; shift 2 ;;
      --json)   json=1; shift ;;
      -*) die "Unknown option: $1" 2 ;;
      *) die "Unexpected argument: $1" 2 ;;
    esac
  done
  require_tools
  local query="" response
  [[ -n "$kind" ]] && query="?kind=$(urlencode "$kind")"
  if [[ -n "$status_filter" ]]; then
    [[ -n "$query" ]] && query="${query}&status=$(urlencode "$status_filter")" || query="?status=$(urlencode "$status_filter")"
  fi
  response="$(api_get "/api/users${query}")" || die "${RED}Failed to list users.${RESET}" 1
  emit "$response" "$json" '.users[]? | "\(.slug)\t\(.kind)\t\(.status)\t\(.display_name)\t\(.email // "-")"'
}

cmd_show() {
  local ref="" json=0
  while (( $# > 0 )); do
    case "$1" in
      --json) json=1; shift ;;
      -*) die "Unknown option: $1" 2 ;;
      *) [[ -z "$ref" ]] || die "Unexpected argument: $1" 2; ref="$1"; shift ;;
    esac
  done
  [[ -n "$ref" ]] || die "Usage: mandible user show <ref> [--json]" 2
  require_tools
  local response
  response="$(api_get "/api/users/$(urlencode "$ref")")" || die "${RED}User not found.${RESET}" 1
  emit "$response" "$json" '.user |
    "id: \(.id)\nslug: \(.slug)\nkind: \(.kind)\nname: \(.display_name)\nemail: \(.email // "-")\nstatus: \(.status)",
    "credentials:", (.credentials[]? | "  \(.id) \(.type) \(.fingerprint) [\(.status)]"),
    "bindings:", (.bindings[]? | "  \(.id) \(.binding_type)=\(.value) [\(.status)]")'
}

cmd_update() {
  local ref="" name="" email="" status="" json=0 name_set=0 email_set=0
  while (( $# > 0 )); do
    case "$1" in
      --name)   name="$2"; name_set=1; shift 2 ;;
      --email)  email="$2"; email_set=1; shift 2 ;;
      --status) status="$2"; shift 2 ;;
      --json)   json=1; shift ;;
      -*) die "Unknown option: $1" 2 ;;
      *) [[ -z "$ref" ]] || die "Unexpected argument: $1" 2; ref="$1"; shift ;;
    esac
  done
  [[ -n "$ref" ]] || die "Usage: mandible user update <ref> [...]" 2
  require_tools
  local payload response
  payload="$(jq -n \
    --argjson name_set "$name_set" --arg name "$name" \
    --argjson email_set "$email_set" --arg email "$email" \
    --arg status "$status" \
    '{}
     + (if $name_set == 1 then {display_name:$name} else {} end)
     + (if $email_set == 1 then {email:$email} else {} end)
     + (if $status == "" then {} else {status:$status} end)')"
  response="$(api_send PATCH "/api/users/$(urlencode "$ref")" "$payload")" || die "${RED}Update failed.${RESET}" 1
  emit "$response" "$json" '.user | "updated \(.slug)"'
}

cmd_credential() {
  local sub="${1:-}"; shift || true
  case "$sub" in
    add)    credential_add "$@" ;;
    revoke) credential_revoke "$@" ;;
    list)   credential_list "$@" ;;
    *) die "Unknown credential subcommand: ${sub:-}. Use add|revoke|list." 2 ;;
  esac
}

credential_add() {
  local ref="" ctype="" fingerprint="" material="" label="" json=0 material_set=0 from_git=0
  while (( $# > 0 )); do
    case "$1" in
      --type)            ctype="$2"; shift 2 ;;
      --fingerprint)     fingerprint="$2"; shift 2 ;;
      --public-material) material="$2"; material_set=1; shift 2 ;;
      --from-git-signingkey) from_git=1; shift ;;
      --label)           label="$2"; shift 2 ;;
      --json)            json=1; shift ;;
      -*) die "Unknown option: $1" 2 ;;
      *) [[ -z "$ref" ]] || die "Unexpected argument: $1" 2; ref="$1"; shift ;;
    esac
  done
  [[ -n "$ref" ]] || die "Usage: mandible user credential add <ref> (...)" 2
  if (( from_git )); then
    [[ -z "$ctype" && -z "$fingerprint" && $material_set -eq 0 ]] \
      || die "--from-git-signingkey cannot be combined with --type, --fingerprint, or --public-material." 2
    command -v ssh-keygen >/dev/null 2>&1 || die "ssh-keygen not found." 1
    local signing_key key_path key_line
    signing_key="$(git_config_value_without_overrides user.signingkey)"
    [[ -n "$signing_key" ]] || die "Git user.signingkey is not configured." 1
    case "$signing_key" in
      key::*) key_line="${signing_key#key::}" ;;
      ssh-*\ *|ecdsa-*\ *|sk-*\ *) key_line="$signing_key" ;;
      *)
        key_path="$signing_key"
        [[ "$key_path" == "~/"* ]] && key_path="${HOME}/${key_path#\~/}"
        [[ -r "$key_path" ]] || die "Configured git signing key is not readable: $signing_key" 1
        key_line="$(sed -n '1p' "$key_path")"
        case "$key_line" in
          ssh-*\ *|ecdsa-*\ *|sk-*\ *) ;;
          *)
            if [[ -r "${key_path}.pub" ]]; then
              key_line="$(sed -n '1p' "${key_path}.pub")"
            else
              key_line="$(ssh-keygen -y -f "$key_path" 2>/dev/null)" \
                || die "Could not derive the public key from git user.signingkey." 1
            fi
            ;;
        esac
        ;;
    esac
    material="$(printf '%s\n' "$key_line" | awk 'NF >= 2 { print $1 " " $2; exit }')"
    [[ -n "$material" ]] || die "Git user.signingkey did not resolve to an OpenSSH public key." 1
    fingerprint="$(printf '%s\n' "$material" | ssh-keygen -lf - -E sha256 2>/dev/null | awk 'NF >= 2 { print $2; exit }')"
    [[ "$fingerprint" == SHA256:* ]] || die "Could not fingerprint git user.signingkey." 1
    ctype="ssh_key"
    material_set=1
  fi
  [[ -n "$ctype" && -n "$fingerprint" ]] \
    || die "Usage: mandible user credential add <ref> (--type <t> --fingerprint <f> | --from-git-signingkey) [...]" 2
  require_tools
  local payload response
  payload="$(jq -n \
    --arg type "$ctype" --arg fp "$fingerprint" \
    --argjson material_set "$material_set" --arg material "$material" \
    --arg label "$label" \
    '{type:$type, fingerprint:$fp}
     + (if $material_set == 1 then {public_material:$material} else {} end)
     + (if $label == "" then {} else {label:$label} end)')"
  response="$(api_send POST "/api/users/$(urlencode "$ref")/credentials" "$payload")" \
    || die "${RED}Failed to add credential.${RESET}" 1
  emit "$response" "$json" '.credential | "added credential \(.id) (\(.type)) [\(.status)]"'
}

credential_revoke() {
  local id="" json=0
  while (( $# > 0 )); do
    case "$1" in
      --json) json=1; shift ;;
      -*) die "Unknown option: $1" 2 ;;
      *) [[ -z "$id" ]] || die "Unexpected argument: $1" 2; id="$1"; shift ;;
    esac
  done
  [[ -n "$id" ]] || die "Usage: mandible user credential revoke <id> [--json]" 2
  require_tools
  local response
  response="$(api_send POST "/api/users/credentials/$(urlencode "$id")/revoke" "{}")" \
    || die "${RED}Failed to revoke credential.${RESET}" 1
  emit "$response" "$json" '.credential | "revoked credential \(.id) [\(.status)]"'
}

credential_list() {
  local ref="" all=0 json=0
  while (( $# > 0 )); do
    case "$1" in
      --all)  all=1; shift ;;
      --json) json=1; shift ;;
      -*) die "Unknown option: $1" 2 ;;
      *) [[ -z "$ref" ]] || die "Unexpected argument: $1" 2; ref="$1"; shift ;;
    esac
  done
  [[ -n "$ref" ]] || die "Usage: mandible user credential list <ref> [--all] [--json]" 2
  require_tools
  local query="" response
  (( all )) && query="?all=1"
  response="$(api_get "/api/users/$(urlencode "$ref")/credentials${query}")" \
    || die "${RED}Failed to list credentials.${RESET}" 1
  emit "$response" "$json" '.credentials[]? | "\(.id)\t\(.type)\t\(.fingerprint)\t\(.status)\t\(.label // "-")"'
}

cmd_token() {
  local sub="${1:-}"; shift || true
  case "$sub" in
    mint)   token_mint "$@" ;;
    list)   token_list "$@" ;;
    revoke) credential_revoke "$@" ;;
    *) die "Unknown token subcommand: ${sub:-}. Use mint|list|revoke." 2 ;;
  esac
}

token_mint() {
  local ref="" label="" json=0
  while (( $# > 0 )); do
    case "$1" in
      --label) label="$2"; shift 2 ;;
      --json)  json=1; shift ;;
      -*) die "Unknown option: $1" 2 ;;
      *) [[ -z "$ref" ]] || die "Unexpected argument: $1" 2; ref="$1"; shift ;;
    esac
  done
  [[ -n "$ref" ]] || die "Usage: mandible user token mint <ref> [--label <l>] [--json]" 2
  require_tools
  local payload response
  payload="$(jq -n --arg label "$label" \
    '{} + (if $label == "" then {} else {label:$label} end)')"
  response="$(api_send POST "/api/users/$(urlencode "$ref")/tokens" "$payload")" \
    || die "${RED}Failed to mint token.${RESET}" 1
  err "${GREEN}Token minted. Copy it now — it will not be shown again.${RESET}"
  emit "$response" "$json" \
    '"token: \(.token)", "credential: \(.credential.id) [\(.credential.status)]"'
}

token_list() {
  local ref="" all=0 json=0
  while (( $# > 0 )); do
    case "$1" in
      --all)  all=1; shift ;;
      --json) json=1; shift ;;
      -*) die "Unknown option: $1" 2 ;;
      *) [[ -z "$ref" ]] || die "Unexpected argument: $1" 2; ref="$1"; shift ;;
    esac
  done
  [[ -n "$ref" ]] || die "Usage: mandible user token list <ref> [--all] [--json]" 2
  require_tools
  local query="" response
  (( all )) && query="?all=1"
  response="$(api_get "/api/users/$(urlencode "$ref")/tokens${query}")" \
    || die "${RED}Failed to list tokens.${RESET}" 1
  emit "$response" "$json" '.tokens[]? | "\(.id)\t\(.status)\t\(.label // "-")\t\(.created_at)"'
}

cmd_binding() {
  local sub="${1:-}"; shift || true
  case "$sub" in
    add)  binding_add "$@" ;;
    rm)   binding_rm "$@" ;;
    list) binding_list "$@" ;;
    *) die "Unknown binding subcommand: ${sub:-}. Use add|rm|list." 2 ;;
  esac
}

binding_add() {
  local ref="" btype="" value="" scope="" json=0 scope_set=0
  while (( $# > 0 )); do
    case "$1" in
      --type)  btype="$2"; shift 2 ;;
      --value) value="$2"; shift 2 ;;
      --scope) scope="$2"; scope_set=1; shift 2 ;;
      --json)  json=1; shift ;;
      -*) die "Unknown option: $1" 2 ;;
      *) [[ -z "$ref" ]] || die "Unexpected argument: $1" 2; ref="$1"; shift ;;
    esac
  done
  [[ -n "$ref" && -n "$btype" && -n "$value" ]] \
    || die "Usage: mandible user binding add <ref> --type <t> --value <v> [--scope <s>]" 2
  require_tools
  local payload response
  payload="$(jq -n \
    --arg type "$btype" --arg value "$value" \
    --argjson scope_set "$scope_set" --arg scope "$scope" \
    '{binding_type:$type, value:$value}
     + (if $scope_set == 1 then {scope:$scope} else {} end)')"
  response="$(api_send POST "/api/users/$(urlencode "$ref")/bindings" "$payload")" \
    || die "${RED}Failed to add binding.${RESET}" 1
  emit "$response" "$json" '.binding | "added binding \(.id) \(.binding_type)=\(.value)"'
}

binding_rm() {
  local id="" json=0
  while (( $# > 0 )); do
    case "$1" in
      --json) json=1; shift ;;
      -*) die "Unknown option: $1" 2 ;;
      *) [[ -z "$id" ]] || die "Unexpected argument: $1" 2; id="$1"; shift ;;
    esac
  done
  [[ -n "$id" ]] || die "Usage: mandible user binding rm <id> [--json]" 2
  require_tools
  local response
  response="$(api_send DELETE "/api/users/bindings/$(urlencode "$id")" "")" \
    || die "${RED}Failed to remove binding.${RESET}" 1
  emit "$response" "$json" '"removed binding"'
}

binding_list() {
  local ref="" json=0
  while (( $# > 0 )); do
    case "$1" in
      --json) json=1; shift ;;
      -*) die "Unknown option: $1" 2 ;;
      *) [[ -z "$ref" ]] || die "Unexpected argument: $1" 2; ref="$1"; shift ;;
    esac
  done
  [[ -n "$ref" ]] || die "Usage: mandible user binding list <ref> [--json]" 2
  require_tools
  local response
  response="$(api_get "/api/users/$(urlencode "$ref")/bindings")" \
    || die "${RED}Failed to list bindings.${RESET}" 1
  emit "$response" "$json" '.bindings[]? | "\(.id)\t\(.binding_type)\t\(.value)\t\(.status)\t\(.scope // "-")"'
}

cmd_group() {
  local sub="${1:-}"; shift || true
  local ref="" name="" user="" operation="" json=0 response payload
  case "$sub" in
    add)
      while (( $# > 0 )); do
        case "$1" in
          --name) name="$2"; shift 2 ;;
          --json) json=1; shift ;;
          -*) die "Unknown option: $1" 2 ;;
          *) [[ -z "$ref" ]] || die "Unexpected argument: $1" 2; ref="$1"; shift ;;
        esac
      done
      [[ -n "$ref" ]] || die "Usage: mandible user group add <slug> [--name <n>]" 2
      require_tools
      payload="$(jq -n --arg slug "$ref" --arg name "$name" \
        '{slug:$slug} + (if $name == "" then {} else {display_name:$name} end)')"
      response="$(api_send POST "/api/users/groups" "$payload")" || die "Failed to add group." 1
      emit "$response" "$json" '.group | "\(.slug)\t\(.kind)\t\(.display_name)"'
      ;;
    rm)
      while (( $# > 0 )); do
        case "$1" in
          --json) json=1; shift ;;
          -*) die "Unknown option: $1" 2 ;;
          *) [[ -z "$ref" ]] || die "Unexpected argument: $1" 2; ref="$1"; shift ;;
        esac
      done
      [[ -n "$ref" ]] || die "Usage: mandible user group rm <ref>" 2
      require_tools
      response="$(api_send DELETE "/api/users/groups/$(urlencode "$ref")" "")" || die "Failed to remove group." 1
      emit "$response" "$json" '"removed group"'
      ;;
    members)
      while (( $# > 0 )); do
        case "$1" in
          --add) operation="add"; user="$2"; shift 2 ;;
          --rm) operation="rm"; user="$2"; shift 2 ;;
          --json) json=1; shift ;;
          -*) die "Unknown option: $1" 2 ;;
          *) [[ -z "$ref" ]] || die "Unexpected argument: $1" 2; ref="$1"; shift ;;
        esac
      done
      [[ -n "$ref" ]] || die "Usage: mandible user group members <ref> [--add <user>|--rm <user>]" 2
      require_tools
      if [[ "$operation" == "add" ]]; then
        payload="$(jq -n --arg user "$user" '{user:$user}')"
        response="$(api_send POST "/api/users/groups/$(urlencode "$ref")/members" "$payload")" || die "Failed to add group member." 1
      elif [[ "$operation" == "rm" ]]; then
        response="$(api_send DELETE "/api/users/groups/$(urlencode "$ref")/members/$(urlencode "$user")" "")" || die "Failed to remove group member." 1
      else
        response="$(api_get "/api/users/groups/$(urlencode "$ref")/members")" || die "Failed to list group members." 1
      fi
      emit "$response" "$json" '.members[]? | "\(.slug)\t\(.kind)\t\(.display_name)"'
      ;;
    *) die "Unknown group subcommand: ${sub:-}. Use add|rm|members." 2 ;;
  esac
}

cmd_grant() {
  local sub="${1:-}"; shift || true
  local id="" subject_type="" subject="" project="" capability="" role="" resource_type="" resource_id="" json=0 response payload query=""
  case "$sub" in
    add)
      while (( $# > 0 )); do
        case "$1" in
          --subject-type) subject_type="$2"; shift 2 ;;
          --subject) subject="$2"; shift 2 ;;
          --project) project="$2"; shift 2 ;;
          --role) role="$2"; shift 2 ;;
          --global) capability="$2"; shift 2 ;;
          --json) json=1; shift ;;
          -*) die "Unknown option: $1" 2 ;;
          *) die "Unexpected argument: $1" 2 ;;
        esac
      done
      [[ "$subject_type" == "user" || "$subject_type" == "group" ]] || die "--subject-type must be user or group" 2
      [[ -n "$subject" ]] || die "--subject is required" 2
      if [[ -n "$project" && -n "$role" && -z "$capability" ]]; then
        resource_type="project"
        payload="$(jq -n --arg st "$subject_type" --arg s "$subject" --arg r "$project" --arg p "$role" \
          '{subject_type:$st,subject:$s,resource_type:"project",resource:$r,permission:$p}')"
      elif [[ -n "$capability" && -z "$project" && -z "$role" ]]; then
        resource_type="global"
        payload="$(jq -n --arg st "$subject_type" --arg s "$subject" --arg p "$capability" \
          '{subject_type:$st,subject:$s,resource_type:"global",permission:$p}')"
      else
        die "Choose either --project <ref> --role <role> or --global <capability>." 2
      fi
      require_tools
      response="$(api_send POST "/api/users/grants" "$payload")" || die "Failed to add grant." 1
      emit "$response" "$json" '.grant | "\(.id)\t\(.subject_type):\(.subject_id)\t\(.resource_type):\(.resource_id // "-")\t\(.permission)"'
      ;;
    rm)
      while (( $# > 0 )); do
        case "$1" in --json) json=1; shift ;; -*) die "Unknown option: $1" 2 ;; *) [[ -z "$id" ]] || die "Unexpected argument: $1" 2; id="$1"; shift ;; esac
      done
      [[ -n "$id" ]] || die "Usage: mandible user grant rm <id>" 2
      require_tools
      response="$(api_send DELETE "/api/users/grants/$(urlencode "$id")" "")" || die "Failed to remove grant." 1
      emit "$response" "$json" '"removed grant"'
      ;;
    list)
      while (( $# > 0 )); do
        case "$1" in
          --resource-type) resource_type="$2"; shift 2 ;;
          --resource-id) resource_id="$2"; shift 2 ;;
          --json) json=1; shift ;;
          -*) die "Unknown option: $1" 2 ;;
          *) die "Unexpected argument: $1" 2 ;;
        esac
      done
      [[ -z "$resource_type" ]] || query="?resource_type=$(urlencode "$resource_type")"
      if [[ -n "$resource_id" ]]; then
        [[ -n "$query" ]] && query="${query}&resource_id=$(urlencode "$resource_id")" || query="?resource_id=$(urlencode "$resource_id")"
      fi
      require_tools
      response="$(api_get "/api/users/grants${query}")" || die "Failed to list grants." 1
      emit "$response" "$json" '.grants[]? | "\(.id)\t\(.subject_type):\(.subject_id)\t\(.resource_type):\(.resource_id // "-")\t\(.permission)"'
      ;;
    *) die "Unknown grant subcommand: ${sub:-}. Use add|rm|list." 2 ;;
  esac
}

cmd_access() {
  local user="" project="" json=0 response
  while (( $# > 0 )); do
    case "$1" in
      --json) json=1; shift ;;
      -*) die "Unknown option: $1" 2 ;;
      *) if [[ -z "$user" ]]; then user="$1"; elif [[ -z "$project" ]]; then project="$1"; else die "Unexpected argument: $1" 2; fi; shift ;;
    esac
  done
  [[ -n "$user" && -n "$project" ]] || die "Usage: mandible user access <user> <project> [--json]" 2
  require_tools
  response="$(api_get "/api/users/$(urlencode "$user")/access?project=$(urlencode "$project")")" || die "Failed to query access." 1
  emit "$response" "$json" '.access | "allowed: \(.allowed)\nrole: \(.effective_role // "-")\nreason: \(.reason)"'
}

if [[ $# -eq 0 || "${1:-}" == "-h" || "${1:-}" == "--help" || "${1:-}" == "help" ]]; then
  usage
  [[ $# -eq 0 ]] && exit 2 || exit 0
fi

cmd="$1"; shift
case "$cmd" in
  setup)      cmd_setup "$@" ;;
  dashboard-link) cmd_dashboard_link "$@" ;;
  list)       cmd_list "$@" ;;
  show)       cmd_show "$@" ;;
  update)     cmd_update "$@" ;;
  credential) cmd_credential "$@" ;;
  token)      cmd_token "$@" ;;
  binding)    cmd_binding "$@" ;;
  group)      cmd_group "$@" ;;
  grant)      cmd_grant "$@" ;;
  access)     cmd_access "$@" ;;
  *) die "Unknown user subcommand: $cmd" 2 ;;
esac
