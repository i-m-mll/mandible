#!/usr/bin/env zsh
# mandible user: user registry CLI over the Mandible daemon API.
#
# Routes:
#   GET  /api/users                          list (?kind=&status=)
#   POST /api/users                          create
#   GET  /api/users/<ref>                    show (with credentials + bindings)
#   PATCH /api/users/<ref>                   update
#   GET  /api/users/operator                 current operator
#   GET  /api/client-auth/whoami             effective client identity (this request)
#   POST /api/users/setup                    idempotent operator setup
#   GET  /api/users/<ref>/credentials        list credentials
#   POST /api/users/<ref>/credentials        add credential
#   POST /api/users/credentials/<id>/revoke  revoke credential
#   GET  /api/users/<ref>/bindings           list bindings
#   POST /api/users/<ref>/bindings           add binding
#   DELETE /api/users/bindings/<id>          remove binding
source "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd -P)/command-syntax.sh"

set -euo pipefail

API_HELPER="${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/api.sh"
source "$API_HELPER"

RESET=$'\033[0m'
RED=$'\033[31m'
GREEN=$'\033[32m'
YELLOW=$'\033[33m'

err() { printf "%b\n" "$*" >&2; }
die() { err "$1"; exit "${2:-1}"; }

usage() {
  mandible_command_help user
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
    printf '%s\n' "$result" | api_jq_human "$human"
  fi
}

# GET a read-only path and echo the JSON body on success. On failure, print a
# status-aware diagnostic to stderr and return nonzero so callers can propagate
# with `|| exit 1` in the file's existing idiom. Unlike the plain api_get/die
# pattern, this distinguishes auth failures (401/403) and not-found (404) from
# other errors and surfaces the server's error/reason/message when present, so a
# 401 no longer masquerades as "not found". Only GET read paths use this: GET is
# never an operational-mutation category, so api_capture's status here is the
# real HTTP status, never the instance-guard 403 that mutation preflight emits.
# $1 = request path, $2 = short name of the target for messages (e.g. "user").
api_read() {
  local request_path="$1" what="${2:-resource}"
  local body_file http_status detail
  body_file="$(api_temp_file)"
  http_status="$(api_capture GET "$request_path" "" "$body_file")"
  if [[ "$http_status" =~ ^2 ]]; then
    cat "$body_file"
    rm -f "$body_file"
    return 0
  fi
  detail="$(jq -r '(.error // .reason // .message // empty)' "$body_file" 2>/dev/null || true)"
  rm -f "$body_file"
  case "$http_status" in
    401|403)
      err "${RED}Access failed querying ${what} (HTTP ${http_status})${detail:+: ${detail}}${RESET} — check the registered local service and operator setup." ;;
    404)
      err "${RED}${what} not found (HTTP 404)${detail:+: ${detail}}${RESET}" ;;
    000)
      err "${RED}Could not reach the Mandible daemon while querying ${what}${RESET}" ;;
    *)
      err "${RED}Failed to query ${what} (HTTP ${http_status})${detail:+: ${detail}}${RESET}" ;;
  esac
  return 1
}

git_config_value() {
  git config --get "$1" 2>/dev/null || true
}

# Issue 2205073 — read one git config value with the dotfiles agent-signing
# GIT_CONFIG_* overrides stripped, so the operator's own configuration is what
# is read rather than whatever key the current agent environment injects.
#
# $1 selects the scope, and the scope is the whole point (review F5):
#   global    — only the operator's global git config. A registry credential is
#               global by construction (it is the operator's identity in every
#               repository), so onboarding may only auto-register from here.
#   effective — whatever this repository resolves, repo-local scope included.
#               Explicit commands may use it; they must say which scope won.
# $2 is the config key.
git_config_value_without_overrides() {
  local scope="$1" key="$2"
  (
    unset GIT_CONFIG_COUNT
    unset GIT_CONFIG_PARAMETERS
    local var
    for var in $(env | sed -n 's/^\(GIT_CONFIG_\(KEY\|VALUE\)_[0-9][0-9]*\)=.*/\1/p'); do
      unset "$var"
    done
    if [[ "$scope" == "global" ]]; then
      git config --global --get "$key" 2>/dev/null || true
    else
      git config --get "$key" 2>/dev/null || true
    fi
  )
}

# Issue 2205073 — derive the OpenSSH public material and SHA256 fingerprint of
# the configured git user.signingkey. Sets SIGNING_KEY_MATERIAL,
# SIGNING_KEY_FINGERPRINT and SIGNING_KEY_SCOPE on success. Returns 1 when
# user.signingkey is unset in the requested scope (nothing to register) and 2
# when it is set but cannot be resolved; the reason is left in
# SIGNING_KEY_ERROR. Callers decide whether that is fatal.
#
# $1 is the config scope: "global" (default) or "effective". SIGNING_KEY_SCOPE
# reports where the resolved key actually came from — "global" or "non-global"
# — so an explicit caller can name the scope it is about to promote into a
# global operator credential.
#
# Accepts the three shapes git supports: a literal `key::` value, an inline
# public key, or a path to a public or private key file.
resolve_git_signing_key() {
  local scope="${1:-global}"
  SIGNING_KEY_MATERIAL=""
  SIGNING_KEY_FINGERPRINT=""
  SIGNING_KEY_ERROR=""
  SIGNING_KEY_SCOPE=""
  local signing_key key_path key_line global_key
  signing_key="$(git_config_value_without_overrides "$scope" user.signingkey)"
  if [[ -z "$signing_key" ]]; then
    if [[ "$scope" == "global" ]]; then
      SIGNING_KEY_ERROR="Git user.signingkey is not configured in global git config."
    else
      SIGNING_KEY_ERROR="Git user.signingkey is not configured."
    fi
    return 1
  fi
  if [[ "$scope" == "global" ]]; then
    SIGNING_KEY_SCOPE="global"
  else
    global_key="$(git_config_value_without_overrides global user.signingkey)"
    if [[ -n "$global_key" && "$signing_key" == "$global_key" ]]; then
      SIGNING_KEY_SCOPE="global"
    else
      SIGNING_KEY_SCOPE="non-global"
    fi
  fi
  if ! command -v ssh-keygen >/dev/null 2>&1; then
    SIGNING_KEY_ERROR="ssh-keygen not found."
    return 2
  fi
  case "$signing_key" in
    key::*) key_line="${signing_key#key::}" ;;
    ssh-*\ *|ecdsa-*\ *|sk-*\ *) key_line="$signing_key" ;;
    *)
      key_path="$signing_key"
      [[ "$key_path" == "~/"* ]] && key_path="${HOME}/${key_path#\~/}"
      if [[ ! -r "$key_path" ]]; then
        SIGNING_KEY_ERROR="Configured git signing key is not readable: $signing_key"
        return 2
      fi
      key_line="$(sed -n '1p' "$key_path")"
      case "$key_line" in
        ssh-*\ *|ecdsa-*\ *|sk-*\ *) ;;
        *)
          if [[ -r "${key_path}.pub" ]]; then
            key_line="$(sed -n '1p' "${key_path}.pub")"
          else
            if ! key_line="$(ssh-keygen -y -f "$key_path" 2>/dev/null)"; then
              SIGNING_KEY_ERROR="Could not derive the public key from git user.signingkey."
              return 2
            fi
          fi
          ;;
      esac
      ;;
  esac
  SIGNING_KEY_MATERIAL="$(printf '%s\n' "$key_line" | awk 'NF >= 2 { print $1 " " $2; exit }')"
  if [[ -z "$SIGNING_KEY_MATERIAL" ]]; then
    SIGNING_KEY_ERROR="Git user.signingkey did not resolve to an OpenSSH public key."
    return 2
  fi
  SIGNING_KEY_FINGERPRINT="$(printf '%s\n' "$SIGNING_KEY_MATERIAL" \
    | ssh-keygen -lf - -E sha256 2>/dev/null | awk 'NF >= 2 { print $2; exit }')"
  if [[ "$SIGNING_KEY_FINGERPRINT" != SHA256:* ]]; then
    SIGNING_KEY_ERROR="Could not fingerprint git user.signingkey."
    return 2
  fi
  return 0
}

# Issue 2205073 — register the configured git signing key as an ssh_key
# credential on $1 unless an active credential already carries its fingerprint.
#
# Without this, the signing credential is a hidden manual step: protected
# merges succeed, but the approval-time base-transition check refuses to attest
# them, and the second queued approval fails with no visible cause. Never fatal
# — setup itself already succeeded by the time this runs.
#
# Review F5 — auto-registration reads GLOBAL git config only, matching the
# startup audit in src/signing-credential-audit.ts. An operator credential is
# global by construction: it is the identity every protected merge is attested
# against. `git config --get` resolves repo-local configuration first, so
# reading effective config here meant that running `mandible user setup` inside
# any repository carrying a per-repo or agent signing key silently promoted
# that key into an active, globally-scoped operator credential. A non-global
# key is now reported with the explicit command that registers it, never
# registered on its own.
setup_signing_credential() {
  local ref="$1" rc=0
  resolve_git_signing_key global || rc=$?
  if (( rc == 1 )); then
    # No GLOBAL signing key. If this repository resolves one from a non-global
    # scope, name it and hand over the explicit command rather than acting.
    local local_key
    local_key="$(git_config_value_without_overrides effective user.signingkey)"
    if [[ -n "$local_key" ]]; then
      err "${YELLOW}Signing credential not registered:${RESET} git user.signingkey is set here only outside global config (${local_key})."
      err "Operator credentials are global. If that is your protected-merge key, register it explicitly: mandible user credential add ${ref} --from-git-signingkey"
    fi
    return 0  # No global signing key configured: nothing to register.
  fi
  if (( rc != 0 )); then
    err "Signing credential not registered: ${SIGNING_KEY_ERROR}"
    return 0
  fi
  local existing
  if existing="$(api_read "/api/users/$(urlencode "$ref")/credentials" "credentials" 2>/dev/null)"; then
    if printf '%s\n' "$existing" | jq -e \
      --arg fp "$SIGNING_KEY_FINGERPRINT" \
      '[.credentials[]? | select(.status == "active" and .fingerprint == $fp)] | length > 0' \
      >/dev/null 2>&1; then
      return 0  # Already registered: idempotent, no redundant action.
    fi
  fi
  local payload response
  payload="$(jq -n --arg fp "$SIGNING_KEY_FINGERPRINT" --arg material "$SIGNING_KEY_MATERIAL" \
    '{type:"ssh_key", fingerprint:$fp, public_material:$material, label:"git user.signingkey"}')"
  if response="$(api_send POST "/api/users/$(urlencode "$ref")/credentials" "$payload" 2>/dev/null)"; then
    err "${GREEN}Signing credential registered from global git config (${SIGNING_KEY_FINGERPRINT}).${RESET}"
  else
    err "Could not register the git signing key as a credential. Run: mandible user credential add ${ref} --from-git-signingkey"
  fi
  return 0
}

cmd_setup() {
  local slug="" name="" email="" json=0 email_set=0 agents=0
  local binding
  binding=$(mandible_bind_arguments "user.setup" '{"slug":{"option":"slug"},"name":{"option":"name"},"email":{"option":"email"},"email_set":{"option":"email","constant":"1"},"agents":{"option":"agents","constant":"1"},"json":{"option":"json","constant":"1"}}' "$@") || return $?
  eval "$binding"
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
  # Issue 2205073 — the protected-merge signing credential is part of operator
  # setup, not a hidden manual follow-up step.
  local operator_ref
  operator_ref="$(printf '%s\n' "$response" | jq -r '.user.slug // .user.id // "operator"')"
  setup_signing_credential "$operator_ref"
  emit "$response" "$json" '.user | "id: \(mandible_display_id)\nslug: \(.slug)\nname: \(.display_name)\nemail: \(.email // "-")"'
}

# Issue 499c148 — print the identity the daemon resolves for THIS shell's
# credential. The mismatch this catches is an agent session inheriting a human
# operator's token: writes still succeed, attributed to the wrong user, until
# the auth-request gate refuses the submission hours later.
cmd_whoami() {
  local json=0 response
  local binding
  binding=$(mandible_bind_arguments "user.whoami" '{"json":{"option":"json","constant":"1"}}' "$@") || return $?
  eval "$binding"
  require_tools
  response="$(api_read "/api/client-auth/whoami" "client identity")" || exit 1
  emit "$response" "$json" '"user: \(.user.slug // "-") (\(.user.kind // "unauthenticated"))\nevidence: \(.evidence_method // "none")\nsource: \(.source // "-")\(if .ephemeral_purpose then " (\(.ephemeral_purpose))" else "" end)\ncredential: \(.credential.label // (.credential.id | mandible_short_id) // "-")\nmode: \(.mode)"'
}

cmd_list() {
  local kind="" status_filter="" json=0
  local binding
  binding=$(mandible_bind_arguments "user.list" '{"kind":{"option":"kind"},"status_filter":{"option":"status"},"json":{"option":"json","constant":"1"}}' "$@") || return $?
  eval "$binding"
  require_tools
  local query="" response
  [[ -n "$kind" ]] && query="?kind=$(urlencode "$kind")"
  if [[ -n "$status_filter" ]]; then
    [[ -n "$query" ]] && query="${query}&status=$(urlencode "$status_filter")" || query="?status=$(urlencode "$status_filter")"
  fi
  response="$(api_read "/api/users${query}" "users")" || exit 1
  emit "$response" "$json" '.users[]? | "\(.slug)\t\(.kind)\t\(.status)\t\(.display_name)\t\(.email // "-")"'
}

cmd_show() {
  local ref="" json=0
  local binding
  binding=$(mandible_bind_arguments "user.show" '{"json":{"option":"json","constant":"1"},"ref":{"position":0}}' "$@") || return $?
  eval "$binding"
  [[ -n "$ref" ]] || die "Usage: $(mandible_command_syntax user.show)" 2
  require_tools
  local response
  response="$(api_read "/api/users/$(urlencode "$ref")" "user")" || exit 1
  emit "$response" "$json" '.user |
    "id: \(mandible_display_id)\nslug: \(.slug)\nkind: \(.kind)\nname: \(.display_name)\nemail: \(.email // "-")\nstatus: \(.status)",
    "credentials:", (.credentials[]? | "  \(mandible_display_id) \(.type) \(.fingerprint) [\(.status)]"),
    "bindings:", (.bindings[]? | "  \(mandible_display_id) \(.binding_type)=\(.value) [\(.status)]")'
}

cmd_update() {
  local ref="" name="" email="" status_value="" json=0 name_set=0 email_set=0
  local binding
  binding=$(mandible_bind_arguments "user.update" '{"name":{"option":"name"},"name_set":{"option":"name","constant":"1"},"email":{"option":"email"},"email_set":{"option":"email","constant":"1"},"status_value":{"option":"status"},"json":{"option":"json","constant":"1"},"ref":{"position":0}}' "$@") || return $?
  eval "$binding"
  [[ -n "$ref" ]] || die "Usage: $(mandible_command_syntax user.update)" 2
  require_tools
  local payload response
  payload="$(jq -n \
    --argjson name_set "$name_set" --arg name "$name" \
    --argjson email_set "$email_set" --arg email "$email" \
    --arg status "$status_value" \
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
  local binding
  binding=$(mandible_bind_arguments "user.credential.add" '{"ctype":{"option":"type"},"fingerprint":{"option":"fingerprint"},"material":{"option":"public-material"},"material_set":{"option":"public-material","constant":"1"},"from_git":{"option":"from-git-signingkey","constant":"1"},"label":{"option":"label"},"json":{"option":"json","constant":"1"},"ref":{"position":0}}' "$@") || return $?
  eval "$binding"
  [[ -n "$ref" ]] || die "Usage: $(mandible_command_syntax user.credential.add)" 2
  if (( from_git )); then
    [[ -z "$ctype" && -z "$fingerprint" && $material_set -eq 0 ]] \
      || die "--from-git-signingkey cannot be combined with --type, --fingerprint, or --public-material." 2
    # Issue 2205073 — shared with `mandible user setup`, which auto-registers
    # from global config only. This is the explicit command, so it honours the
    # effective configuration of the current repository; review F5 requires it
    # to say which scope the key came from, because the credential it creates
    # is global regardless of where the key was configured.
    resolve_git_signing_key effective || die "${SIGNING_KEY_ERROR}" 1
    if [[ "$SIGNING_KEY_SCOPE" == "global" ]]; then
      err "Registering git user.signingkey from global git config (${SIGNING_KEY_FINGERPRINT})."
    else
      err "${YELLOW}Registering git user.signingkey from a non-global git config scope (${SIGNING_KEY_FINGERPRINT}).${RESET} The credential applies to this user everywhere, not just this repository."
    fi
    material="$SIGNING_KEY_MATERIAL"
    fingerprint="$SIGNING_KEY_FINGERPRINT"
    ctype="ssh_key"
    material_set=1
  fi
  [[ -n "$ctype" && -n "$fingerprint" ]] \
    || die "Usage: $(mandible_command_syntax user.credential.add)" 2
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
  emit "$response" "$json" '.credential | "added credential \(mandible_display_id) (\(.type)) [\(.status)]"'
}

credential_revoke() {
  local id="" json=0
  local binding
  binding=$(mandible_bind_arguments "user.credential.revoke" '{"json":{"option":"json","constant":"1"},"id":{"position":0}}' "$@") || return $?
  eval "$binding"
  [[ -n "$id" ]] || die "Usage: $(mandible_command_syntax user.credential.revoke)" 2
  require_tools
  local response
  response="$(api_send POST "/api/users/credentials/$(urlencode "$id")/revoke" "{}")" \
    || die "${RED}Failed to revoke credential.${RESET}" 1
  emit "$response" "$json" '.credential | "revoked credential \(mandible_display_id) [\(.status)]"'
}

credential_list() {
  local ref="" all=0 json=0
  local binding
  binding=$(mandible_bind_arguments "user.credential.list" '{"all":{"option":"all","constant":"1"},"json":{"option":"json","constant":"1"},"ref":{"position":0}}' "$@") || return $?
  eval "$binding"
  [[ -n "$ref" ]] || die "Usage: $(mandible_command_syntax user.credential.list)" 2
  require_tools
  local query="" response
  (( all )) && query="?all=1"
  response="$(api_read "/api/users/$(urlencode "$ref")/credentials${query}" "credentials")" || exit 1
  emit "$response" "$json" '.credentials[]? | "\(mandible_display_id)\t\(.type)\t\(.fingerprint)\t\(.status)\t\(.label // "-")"'
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

# Default secret-store service name for a user (issue e2cb93f). $1 is the JSON
# body of GET /api/users/<ref>. Prints the service name, or nothing when no
# default applies (the caller then requires an explicit --service).
#
#   kind human -> mandible-operator          (the local operator credential)
#   kind agent -> mandible-agent-<app>, where <app> is the shortest active
#                 app_name binding, ties broken alphabetically. Shortest is the
#                 primary app name: user claude-code binds claude, claude-code
#                 and claude-channel, and the item cli/wrap.sh already reads for
#                 a `claude` session is mandible-agent-claude. An agent with no
#                 active app_name binding has no default.
#   any other kind (system, external, …) -> no default. Those identities have no
#                 established naming contract, and guessing one would create an
#                 item no reader looks for.
default_secret_service_for_user() {
  printf '%s' "$1" | jq -r '
    .user as $u
    | if $u.kind == "human" then "mandible-operator"
      elif $u.kind == "agent" then
        (($u.bindings // [])
          | map(select(.binding_type == "app_name" and .status == "active") | .value)
          | sort_by(length, .)
          | first) as $app
        | if $app == null then "" else "mandible-agent-" + $app end
      else "" end'
}

token_mint() {
  local ref="" label="" json=0 store=0 service="" service_set=0
  local binding
  binding=$(mandible_bind_arguments "user.token.mint" '{"label":{"option":"label"},"store":{"option":"store","constant":"1"},"service":{"option":"service"},"service_set":{"option":"service","constant":"1"},"json":{"option":"json","constant":"1"},"ref":{"position":0}}' "$@") || return $?
  eval "$binding"
  [[ -n "$ref" ]] \
    || die "Usage: $(mandible_command_syntax user.token.mint)" 2
  (( service_set == 0 || store == 1 )) || die "--service requires --store." 2
  if (( service_set )); then
    [[ -n "${service//[[:space:]]/}" ]] || die "--service must name a service; it cannot be empty." 2
  fi
  require_tools

  # Everything that can fail without minting is resolved first: a mint creates a
  # credential, and a token that cannot be stored is a token nobody has.
  local account="" rotated=0
  if (( store )); then
    secret_backend_available \
      || die "${RED}Cannot store the token: $(secret_backend_unavailable_reason).${RESET}" 1
    local user_json user_kind
    user_json="$(api_read "/api/users/$(urlencode "$ref")" "user")" || exit 1
    account="$(printf '%s' "$user_json" | jq -r '.user.slug // ""')"
    [[ -n "$account" ]] || die "${RED}Could not resolve the user slug for '$ref'.${RESET}" 1
    user_kind="$(printf '%s' "$user_json" | jq -r '.user.kind // "unknown"')"
    if (( ! service_set )); then
      service="$(default_secret_service_for_user "$user_json")"
      if [[ -z "$service" ]]; then
        case "$user_kind" in
          agent) die "No default secret service name for '$ref': the agent has no active app_name binding. Pass --service <name>." 2 ;;
          *)     die "No default secret service name for '$ref' (user kind '${user_kind}'). Only human and agent users have one. Pass --service <name>." 2 ;;
        esac
      fi
    fi
    # Checked before minting, not at write time: material the backend cannot
    # store faithfully would otherwise fail after a credential already exists.
    secret_material_valid "$service" \
      || die "Service name must be one line of printable ASCII: '${service}'." 2
    secret_material_valid "$account" \
      || die "${RED}User slug '${account}' cannot be used as a secret-store account (printable ASCII only).${RESET} Pass --service and rename the user, or store it manually." 1
    # The ambient readers look up this service without an account, so an item
    # under a different account would leave them reading the older token while
    # this command reports success. The three outcomes are kept distinct: only a
    # definite "no such item" proceeds, and an unreadable keychain fails closed
    # rather than being mistaken for absence.
    local existing_account="" account_status=0
    existing_account="$(secret_account_for_service "$service")" || account_status=$?
    case "$account_status" in
      0)
        if [[ "$existing_account" != "$account" ]]; then
          die "${RED}Refusing to store: service '${service}' already holds an item for account '${existing_account}', not '${account}'.${RESET} Readers resolve this service without an account, so a second item would shadow the first. Remove the stale item or pass an explicit --service <name>." 1
        fi
        # Advisory only: this is the state observed before the mint, and a
        # concurrent writer would make it stale. It never gates the write, and
        # the existing value is never read or printed — only its account is.
        rotated=1
        ;;
      1) ;; # no such item: a fresh write
      *)
        die "${RED}Refusing to store: could not read the existing secret-store item for service '${service}' (keychain attribute lookup failed).${RESET} Fix the secret store — an unreadable keychain must not be mistaken for an empty one — or pass --service <name>." 1
        ;;
    esac
  fi

  # The raw token is live in shell state from the mint call until the scrub
  # below, and the response body carries it too — under `zsh -x` even the
  # `response=...` assignment would echo it. xtrace is therefore suspended
  # across the whole region, not just inside the seam, and restored on every
  # non-fatal exit path. The response body also passed through a 0600 temp file
  # that api_request removes on the success path, with cli/api.sh's
  # EXIT/INT/TERM trap removing the whole 0700 temp root otherwise; the residual
  # window is an unhandleable kill (SIGKILL, power loss) between write and unlink.
  local mint_traced=0
  case "$-" in *x*) mint_traced=1; { set +x; } 2>/dev/null ;; esac

  local payload response
  payload="$(jq -n --arg label "$label" \
    '{} + (if $label == "" then {} else {label:$label} end)')"
  response="$(api_send POST "/api/users/$(urlencode "$ref")/tokens" "$payload")" \
    || die "${RED}Failed to mint token.${RESET}" 1

  if (( ! store )); then
    err "${GREEN}Token minted. Copy it now — it will not be shown again.${RESET}"
    emit "$response" "$json" \
      '"token: \(.token)", "credential: \(.credential | mandible_display_id) [\(.credential.status)]"'
    (( mint_traced == 0 )) || set -x
    return 0
  fi

  local token credential_id result
  token="$(printf '%s' "$response" | jq -r '.token // ""')"
  credential_id="$(printf '%s' "$response" | jq -r '.credential.id // ""')"
  [[ -n "$token" ]] \
    || die "${RED}Token minted (credential ${credential_id:-unknown}) but the daemon returned no token value to store.${RESET} Revoke it with: mandible user token revoke ${credential_id:-<credential-id>}" 1
  printf '%s' "$token" | secret_set "$service" "$account" \
    || die "${RED}Token minted (credential ${credential_id}) but could NOT be stored in the secret backend.${RESET} Revoke it with: mandible user token revoke ${credential_id}" 1

  # Post-write check, against the exact lookup the ambient readers perform. The
  # pre-write check narrows the window in which a competing item can appear; this
  # one catches what slips through it, including a writer that raced this
  # command. The token IS stored under (service, account) at this point — the
  # failure being reported is that readers would resolve somewhere else.
  local resolved_account="" resolved_status=0
  resolved_account="$(secret_account_for_service "$service")" || resolved_status=$?
  if (( resolved_status != 0 )) || [[ "$resolved_account" != "$account" ]]; then
    die "${RED}Token minted (credential ${credential_id}) and stored under service '${service}' account '${account}', but a service-only lookup resolves to '${resolved_account:-<unreadable>}'.${RESET} Ambient readers (mandible-operator / mandible-agent-<app>) will use that item, not this one. Remove the shadowing item, then store again — or store under a service you control with --service <name>." 1
  fi

  # The raw token is deliberately absent from the output: with --store the whole
  # point is that it goes to the secret store and nowhere else.
  result="$(printf '%s' "$response" | jq \
    --arg backend "$(secret_backend_kind)" \
    --arg service "$service" \
    --arg account "$account" \
    --argjson rotated "$rotated" \
    '{credential: .credential,
      secret: {backend: $backend, service: $service, account: $account, rotated: ($rotated == 1)}}')"
  # Drop the raw token from shell state as soon as it is no longer needed, then
  # restore whatever xtrace setting the caller had.
  token=""
  response=""
  (( mint_traced == 0 )) || set -x
  if (( rotated )); then
    err "${GREEN}Token minted and stored (existing item rotated). It was not printed.${RESET}"
  else
    err "${GREEN}Token minted and stored. It was not printed.${RESET}"
  fi
  emit "$result" "$json" \
    '"credential: \(.credential | mandible_display_id) [\(.credential.status)]",
     "label: \(.credential.label // "-")",
     "backend: \(.secret.backend)",
     "service: \(.secret.service)",
     "account: \(.secret.account)"'
}

token_list() {
  local ref="" all=0 json=0
  local binding
  binding=$(mandible_bind_arguments "user.token.list" '{"all":{"option":"all","constant":"1"},"json":{"option":"json","constant":"1"},"ref":{"position":0}}' "$@") || return $?
  eval "$binding"
  [[ -n "$ref" ]] || die "Usage: $(mandible_command_syntax user.token.list)" 2
  require_tools
  local query="" response
  (( all )) && query="?all=1"
  response="$(api_read "/api/users/$(urlencode "$ref")/tokens${query}" "tokens")" || exit 1
  emit "$response" "$json" '.tokens[]? | "\(mandible_display_id)\t\(.status)\t\(.label // "-")\t\(.created_at)"'
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
  local binding
  binding=$(mandible_bind_arguments "user.binding.add" '{"btype":{"option":"type"},"value":{"option":"value"},"scope":{"option":"scope"},"scope_set":{"option":"scope","constant":"1"},"json":{"option":"json","constant":"1"},"ref":{"position":0}}' "$@") || return $?
  eval "$binding"
  [[ -n "$ref" && -n "$btype" && -n "$value" ]] \
    || die "Usage: $(mandible_command_syntax user.binding.add)" 2
  require_tools
  local payload response
  payload="$(jq -n \
    --arg type "$btype" --arg value "$value" \
    --argjson scope_set "$scope_set" --arg scope "$scope" \
    '{binding_type:$type, value:$value}
     + (if $scope_set == 1 then {scope:$scope} else {} end)')"
  response="$(api_send POST "/api/users/$(urlencode "$ref")/bindings" "$payload")" \
    || die "${RED}Failed to add binding.${RESET}" 1
  emit "$response" "$json" '.binding | "added binding \(mandible_display_id) \(.binding_type)=\(.value)"'
}

binding_rm() {
  local id="" json=0
  local binding
  binding=$(mandible_bind_arguments "user.binding.rm" '{"json":{"option":"json","constant":"1"},"id":{"position":0}}' "$@") || return $?
  eval "$binding"
  [[ -n "$id" ]] || die "Usage: $(mandible_command_syntax user.binding.rm)" 2
  require_tools
  local response
  response="$(api_send DELETE "/api/users/bindings/$(urlencode "$id")" "")" \
    || die "${RED}Failed to remove binding.${RESET}" 1
  emit "$response" "$json" '"removed binding"'
}

binding_list() {
  local ref="" json=0
  local binding
  binding=$(mandible_bind_arguments "user.binding.list" '{"json":{"option":"json","constant":"1"},"ref":{"position":0}}' "$@") || return $?
  eval "$binding"
  [[ -n "$ref" ]] || die "Usage: $(mandible_command_syntax user.binding.list)" 2
  require_tools
  local response
  response="$(api_read "/api/users/$(urlencode "$ref")/bindings" "bindings")" || exit 1
  emit "$response" "$json" '.bindings[]? | "\(mandible_display_id)\t\(.binding_type)\t\(.value)\t\(.status)\t\(.scope // "-")"'
}

cmd_group() {
  local sub="${1:-}"; shift || true
  local ref="" name="" user="" operation="" json=0 response payload
  case "$sub" in
    -h|--help|help)
      mandible_command_help user group
      return 0
      ;;
    add)
      local binding
      binding=$(mandible_bind_arguments "user.group.add" '{"name":{"option":"name"},"json":{"option":"json","constant":"1"},"ref":{"position":0}}' "$@") || return $?
      eval "$binding"
      [[ -n "$ref" ]] || die "Usage: $(mandible_command_syntax user.group.add)" 2
      require_tools
      payload="$(jq -n --arg slug "$ref" --arg name "$name" \
        '{slug:$slug} + (if $name == "" then {} else {display_name:$name} end)')"
      response="$(api_send POST "/api/users/groups" "$payload")" || die "Failed to add group." 1
      emit "$response" "$json" '.group | "\(.slug)\t\(.kind)\t\(.display_name)"'
      ;;
    rm)
      local binding
      binding=$(mandible_bind_arguments "user.group.rm" '{"json":{"option":"json","constant":"1"},"ref":{"position":0}}' "$@") || return $?
      eval "$binding"
      [[ -n "$ref" ]] || die "Usage: $(mandible_command_syntax user.group.rm)" 2
      require_tools
      response="$(api_send DELETE "/api/users/groups/$(urlencode "$ref")" "")" || die "Failed to remove group." 1
      emit "$response" "$json" '"removed group"'
      ;;
    members)
      local binding
      binding=$(mandible_bind_arguments "user.group.members" '{"operation":[{"option":"add","constant":"add"},{"option":"rm","constant":"rm"}],"user":[{"option":"add"},{"option":"rm"}],"json":{"option":"json","constant":"1"},"ref":{"position":0}}' "$@") || return $?
      eval "$binding"
      [[ -n "$ref" ]] || die "Usage: $(mandible_command_syntax user.group.members)" 2
      require_tools
      if [[ "$operation" == "add" ]]; then
        payload="$(jq -n --arg user "$user" '{user:$user}')"
        response="$(api_send POST "/api/users/groups/$(urlencode "$ref")/members" "$payload")" || die "Failed to add group member." 1
      elif [[ "$operation" == "rm" ]]; then
        response="$(api_send DELETE "/api/users/groups/$(urlencode "$ref")/members/$(urlencode "$user")" "")" || die "Failed to remove group member." 1
      else
        response="$(api_read "/api/users/groups/$(urlencode "$ref")/members" "group members")" || exit 1
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
    -h|--help|help)
      mandible_command_help user grant
      return 0
      ;;
    add)
      local binding
      binding=$(mandible_bind_arguments "user.grant.add" '{"subject_type":{"option":"subject-type"},"subject":{"option":"subject"},"project":{"option":"project"},"role":{"option":"role"},"capability":{"option":"global"},"json":{"option":"json","constant":"1"}}' "$@") || return $?
      eval "$binding"
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
      emit "$response" "$json" '.grant | "\(mandible_display_id)\t\(.subject_type):\(.subject_id | mandible_short_id)\t\(.resource_type):\((.resource_id // "-") | mandible_short_id)\t\(.permission)"'
      ;;
    rm)
      local binding
      binding=$(mandible_bind_arguments "user.grant.rm" '{"json":{"option":"json","constant":"1"},"id":{"position":0}}' "$@") || return $?
      eval "$binding"
      [[ -n "$id" ]] || die "Usage: $(mandible_command_syntax user.grant.rm)" 2
      require_tools
      response="$(api_send DELETE "/api/users/grants/$(urlencode "$id")" "")" || die "Failed to remove grant." 1
      emit "$response" "$json" '"removed grant"'
      ;;
    list)
      local binding
      binding=$(mandible_bind_arguments "user.grant.list" '{"resource_type":{"option":"resource-type"},"resource_id":{"option":"resource-id"},"json":{"option":"json","constant":"1"}}' "$@") || return $?
      eval "$binding"
      [[ -z "$resource_type" ]] || query="?resource_type=$(urlencode "$resource_type")"
      if [[ -n "$resource_id" ]]; then
        [[ -n "$query" ]] && query="${query}&resource_id=$(urlencode "$resource_id")" || query="?resource_id=$(urlencode "$resource_id")"
      fi
      require_tools
      response="$(api_read "/api/users/grants${query}" "grants")" || exit 1
      emit "$response" "$json" '.grants[]? | "\(mandible_display_id)\t\(.subject_type):\(.subject_id | mandible_short_id)\t\(.resource_type):\((.resource_id // "-") | mandible_short_id)\t\(.permission)"'
      ;;
    *) die "Unknown grant subcommand: ${sub:-}. Use add|rm|list." 2 ;;
  esac
}

cmd_access() {
  local user="" project="" json=0 response
  local binding
  binding=$(mandible_bind_arguments "user.access" '{"json":{"option":"json","constant":"1"},"user":{"position":0},"project":{"position":1}}' "$@") || return $?
  eval "$binding"
  [[ -n "$user" && -n "$project" ]] || die "Usage: $(mandible_command_syntax user.access)" 2
  require_tools
  response="$(api_read "/api/users/$(urlencode "$user")/access?project=$(urlencode "$project")" "access")" || exit 1
  emit "$response" "$json" '.access | "allowed: \(.allowed)\nrole: \(.effective_role // "-")\nreason: \(.reason)"'
}

if [[ $# -eq 0 || "${1:-}" == "-h" || "${1:-}" == "--help" || "${1:-}" == "help" ]]; then
  usage
  [[ $# -eq 0 ]] && exit 2 || exit 0
fi

cmd="$1"; shift
case "$cmd" in
  setup)      cmd_setup "$@" ;;
  whoami)     cmd_whoami "$@" ;;
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
