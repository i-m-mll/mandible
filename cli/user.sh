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
  mandible user setup [--slug <s>] [--name <n>] [--email <e>] [--json]
  mandible user dashboard-link
  mandible user list [--kind <k>] [--status <s>] [--json]
  mandible user show <ref> [--json]
  mandible user update <ref> [--name <n>] [--email <e>] [--status active|retired] [--json]
  mandible user credential add <ref> --type <t> --fingerprint <f> [--public-material <m>] [--label <l>] [--json]
  mandible user credential revoke <id> [--json]
  mandible user credential list <ref> [--all] [--json]
  mandible user token mint <ref> [--label <l>] [--json]
  mandible user token list <ref> [--all] [--json]
  mandible user token revoke <credential-id> [--json]
  mandible user binding add <ref> --type <t> --value <v> [--scope <s>] [--json]
  mandible user binding rm <id> [--json]
  mandible user binding list <ref> [--json]

Setup is idempotent and is the only way the local human operator is created.
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

cmd_setup() {
  local slug="" name="" email="" json=0 email_set=0
  while (( $# > 0 )); do
    case "$1" in
      --slug)  slug="$2"; shift 2 ;;
      --name)  name="$2"; shift 2 ;;
      --email) email="$2"; email_set=1; shift 2 ;;
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
    '{}
     + (if $slug == "" then {} else {slug:$slug} end)
     + (if $name == "" then {} else {display_name:$name} end)
     + (if $email == "" then {} else {email:$email} end)')"
  response="$(api_send POST "/api/users/setup" "$payload")" || die "${RED}Setup failed.${RESET}" 1
  err "${GREEN}Operator ready.${RESET}"
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
  local kind="" status="" json=0
  while (( $# > 0 )); do
    case "$1" in
      --kind)   kind="$2"; shift 2 ;;
      --status) status="$2"; shift 2 ;;
      --json)   json=1; shift ;;
      -*) die "Unknown option: $1" 2 ;;
      *) die "Unexpected argument: $1" 2 ;;
    esac
  done
  require_tools
  local query="" response
  [[ -n "$kind" ]] && query="?kind=$(urlencode "$kind")"
  if [[ -n "$status" ]]; then
    [[ -n "$query" ]] && query="${query}&status=$(urlencode "$status")" || query="?status=$(urlencode "$status")"
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
  local ref="" ctype="" fingerprint="" material="" label="" json=0 material_set=0
  while (( $# > 0 )); do
    case "$1" in
      --type)            ctype="$2"; shift 2 ;;
      --fingerprint)     fingerprint="$2"; shift 2 ;;
      --public-material) material="$2"; material_set=1; shift 2 ;;
      --label)           label="$2"; shift 2 ;;
      --json)            json=1; shift ;;
      -*) die "Unknown option: $1" 2 ;;
      *) [[ -z "$ref" ]] || die "Unexpected argument: $1" 2; ref="$1"; shift ;;
    esac
  done
  [[ -n "$ref" && -n "$ctype" && -n "$fingerprint" ]] \
    || die "Usage: mandible user credential add <ref> --type <t> --fingerprint <f> [...]" 2
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
  *) die "Unknown user subcommand: $cmd" 2 ;;
esac
