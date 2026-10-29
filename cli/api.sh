#!/usr/bin/env bash

source "${MANDIBLE_CLI_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)}/command-syntax.sh" --mandible-syntax-definitions-only
source "${MANDIBLE_CLI_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)}/canonical-origin.sh"
: "${MANDIBLE_PORT:=${MANDIBLE_DEFAULT_BACKEND_PORT}}"
if [[ -z "${MANDIBLE_BASE:-}" || ( "${MANDIBLE_BASE%/}" == "${MANDIBLE_CANONICAL_ORIGIN%/}" && "${MANDIBLE_TRANSPORT:-}" != "http" ) ]]; then
  MANDIBLE_LOCAL_SOCKET=1
else
  MANDIBLE_LOCAL_SOCKET=0
fi
if [[ "$MANDIBLE_LOCAL_SOCKET" == 1 ]]; then
  MANDIBLE_SOCKET="${MANDIBLE_SOCKET:-${HOME}/.cache/mandible/local-api/production.sock}"
  [[ "$MANDIBLE_SOCKET" == /* ]] || { printf 'MANDIBLE_SOCKET must be an absolute path.\n' >&2; return 2 2>/dev/null || exit 2; }
fi

api_is_local_socket() { [[ "$MANDIBLE_LOCAL_SOCKET" == 1 ]]; }

# Run a jq filter with the shared human-facing identity contract loaded. JSON
# output deliberately bypasses this helper so exact API authority is preserved.
api_jq_human() {
  local filter="$1"
  shift
  jq -L "${MANDIBLE_CLI_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)}" \
    -r "$@" "include \"mandible-identity\"; ${filter}"
}

api_short_id() {
  printf '%s\n' "$1" | api_jq_human 'mandible_short_id' -R
}

# Filters select fixed shell variable names and string values. Validate the
# complete record before emitting anything; jq's @sh accepts arrays as several
# words, which are not a valid single assignment value.
api_json_bindings() {
  local filter="$1"
  shift
  jq -er "$filter | if type == \"object\" and all(to_entries[];
      (.key | test(\"^[a-zA-Z_][a-zA-Z_0-9]*$\")) and (.value | type == \"string\"))
    then to_entries | map(.key + \"=\" + (.value | @sh)) | join(\"\\n\")
    else error(\"Invalid scalar response fields\") end" "$@"
}

# Issue 24f0316 — Mandible splits its state by lifetime, and the CLI must agree
# with the daemon on where each half lives:
#
#   ~/.mandible       durable: mandible.db (+ -wal/-shm), backups/, config/,
#                     artifacts/. Overridable wholesale with MANDIBLE_HOME.
#   ~/.cache/mandible disposable: the CLI mirror, previews, agent-rpc, logs,
#                     daemon.pid, restart-availability.json.
#
# Mirrors getMandibleHome()/getDefaultDbPath() in src/platform-paths.ts and
# src/db.ts. A shell script that keeps the old ~/.cache database literal would
# silently read the pre-split file, which the copy-forward shim deliberately
# leaves on disk.
api_resolve_user_path() {
  local value="$1" rest part resolved=""
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  if [[ "$value" == "~" ]]; then
    value="$HOME"
  elif [[ "$value" == "~/"* ]]; then
    value="$HOME/${value#\~/}"
  fi
  [[ "$value" == /* ]] || value="$PWD/$value"
  # Component-wise lexical normalization using only portable parameter
  # expansion. This file is sourced by both bash entrypoints (macOS ships
  # bash 3.2) and zsh entrypoints (cli/user.sh), so arrays and `read -a`
  # are off the table: zsh spells the array flag `read -A`, and bash < 4.4
  # makes an empty "${arr[@]}" fatal under `set -u`.
  rest="$value/"
  while [[ -n "$rest" ]]; do
    part="${rest%%/*}"
    rest="${rest#*/}"
    case "$part" in
      "" | .) ;;
      ..) resolved="${resolved%/*}" ;;
      *) resolved="$resolved/$part" ;;
    esac
  done
  printf '%s' "${resolved:-/}"
}

api_mandible_home() {
  if [[ -n "${MANDIBLE_HOME:-}" && -n "${MANDIBLE_HOME//[[:space:]]/}" ]]; then
    api_resolve_user_path "$MANDIBLE_HOME"
    return
  fi
  api_resolve_user_path "$HOME/.mandible"
}

api_default_db_path() {
  printf '%s/mandible.db' "$(api_mandible_home)"
}

# The database a CLI command should actually read.
#
# Unlike the daemon, the CLI must never create one: an empty file at the durable
# path would be adopted by the startup copy-forward as though it were the
# relocated ledger, stranding the real one. Resolution is therefore
# existence-based — durable first, then the pre-split location — and only names
# the durable path when neither exists, which is a fresh install.
api_live_db_path() {
  if [[ -n "${MANDIBLE_DB:-}" ]]; then
    api_resolve_user_path "$MANDIBLE_DB"
    return
  fi
  local durable legacy
  durable="$(api_default_db_path)"
  legacy="${HOME}/.cache/mandible/mandible.db"
  if [[ -f "${durable}.copy-forward-in-progress" && -f "$legacy" ]]; then
    printf '%s' "$legacy"
    return
  fi
  if [[ -s "$durable" || ( -f "$durable" && ! -f "$legacy" ) ]]; then
    printf '%s' "$durable"
    return
  fi
  if [[ -f "$legacy" ]]; then
    printf '%s' "$legacy"
    return
  fi
  printf '%s' "$durable"
}

# Command-scoped custody for every CLI temporary file. The manifest also tracks
# spool-local staging paths, so EXIT/INT/TERM cleanup removes bearer/config or
# capability-token material even when a command is interrupted mid-exchange.
MANDIBLE_API_TEMP_ROOT=""

api_ensure_temp_root() {
  if [[ -z "$MANDIBLE_API_TEMP_ROOT" ]]; then
    MANDIBLE_API_TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/mandible-api.XXXXXX")"
    # Asserted, not assumed: token-bearing bodies live under this root, so a
    # failure to secure it is fatal rather than silently downgraded.
    if ! chmod 700 "$MANDIBLE_API_TEMP_ROOT"; then
      printf 'mandible: could not restrict permissions on %s; refusing to stage request data there\n' \
        "$MANDIBLE_API_TEMP_ROOT" >&2
      rm -rf -- "$MANDIBLE_API_TEMP_ROOT" 2>/dev/null || true
      MANDIBLE_API_TEMP_ROOT=""
      return 1
    fi
    : > "$MANDIBLE_API_TEMP_ROOT/cleanup-manifest"
  fi
}

api_track_temp() {
  api_ensure_temp_root || return 1
  printf '%s\n' "$1" >> "$MANDIBLE_API_TEMP_ROOT/cleanup-manifest"
}

api_untrack_temp() {
  local cleanup_path="$1" manifest next_manifest
  [[ -n "$MANDIBLE_API_TEMP_ROOT" ]] || return 0
  manifest="$MANDIBLE_API_TEMP_ROOT/cleanup-manifest"
  [[ -f "$manifest" ]] || return 0
  next_manifest="$MANDIBLE_API_TEMP_ROOT/cleanup-manifest.next"
  grep -Fvx -- "$cleanup_path" "$manifest" > "$next_manifest" || true
  mv "$next_manifest" "$manifest"
}

# Response and request bodies pass through these files, and some of them carry
# bearer tokens (issue e2cb93f: the `token mint` response holds a raw token until
# api_request cats and removes it). mktemp already creates 0600 files inside the
# 0700 root, but the permission is asserted rather than assumed, because the
# guarantee is what keeps another local account from reading a token out of the
# window between write and unlink.
api_temp_file() {
  api_ensure_temp_root || return 1
  local temp_path
  temp_path="$(mktemp "$MANDIBLE_API_TEMP_ROOT/file.XXXXXX")" || return 1
  if ! chmod 600 "$temp_path"; then
    printf 'mandible: could not restrict permissions on %s; refusing to use it\n' "$temp_path" >&2
    rm -f -- "$temp_path" 2>/dev/null || true
    return 1
  fi
  printf '%s' "$temp_path"
}

api_cleanup_temp_files() {
  local cleanup_path
  if [[ -n "$MANDIBLE_API_TEMP_ROOT" && -f "$MANDIBLE_API_TEMP_ROOT/cleanup-manifest" ]]; then
    while IFS= read -r cleanup_path; do
      [[ -z "$cleanup_path" ]] || rm -f -- "$cleanup_path" 2>/dev/null || true
    done < "$MANDIBLE_API_TEMP_ROOT/cleanup-manifest"
  fi
  if [[ -n "$MANDIBLE_API_TEMP_ROOT" && -d "$MANDIBLE_API_TEMP_ROOT" ]]; then
    rm -rf -- "$MANDIBLE_API_TEMP_ROOT" 2>/dev/null || true
  fi
  MANDIBLE_API_TEMP_ROOT=""
}

api_ensure_temp_root
trap 'api_cleanup_temp_files' EXIT
trap 'api_cleanup_temp_files; exit 130' INT
trap 'api_cleanup_temp_files; exit 143' TERM

api_base() {
  if api_is_local_socket; then printf 'http://localhost'; else printf '%s' "$MANDIBLE_BASE"; fi
}

# Explicit canonical HTTP retains browser-origin CSRF behavior. The ordinary
# local path uses the private socket instead.
api_local_human_http() {
  [[ "$(api_base)" == "$MANDIBLE_CANONICAL_ORIGIN" ]] \
    && ! api_managed_client_markers_present \
    && [[ -z "$(api_agent_provider)" ]]
}

api_local_operator_csrf() {
  local output="" result="" status=""
  output="$(api_temp_file)" || return 1
  status=$(curl -s --max-time 5 -o "$output" -w '%{http_code}' \
    -H "Origin: $MANDIBLE_CANONICAL_ORIGIN" -H 'Sec-Fetch-Site: same-origin' \
    "$(api_base)/api/client-auth/whoami" 2>/dev/null) || { rm -f "$output"; return 1; }
  if [[ "$status" == "200" ]]; then
    result=$(jq -er '.session.csrf_token | select(type == "string" and length > 0)' "$output" 2>/dev/null) || result=""
  fi
  rm -f "$output"
  [[ -n "$result" ]] || return 1
  printf '%s' "$result"
}

api_is_file_rpc() {
  [[ "${MANDIBLE_BASE:-}" == file://* ]]
}

api_local_credential_routes_file() {
  printf '%s' "${MANDIBLE_LOCAL_CREDENTIAL_ROUTES_FILE:-${MANDIBLE_CLI_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)}/local-credential-routes.json}"
}

# Resolve the actual registered operation first; credentials never affect routing.
api_local_route_requires_credential() {
  local method="$1" pathname="${2%%\?*}" body="${3:-}" file route_method route_path mode field routes
  file="$(api_local_credential_routes_file)"
  [[ -r "$file" ]] || { printf 'Mandible local credential route manifest is unavailable: %s\n' "$file" >&2; return 2; }
  routes="$(jq -er '
    def policy:
      type == "object" and
      (if .mode == "body-nonempty" then
        keys == ["field", "mode"] and (.field | type == "string" and test("^[a-zA-Z_][a-zA-Z_0-9]*$"))
      else keys == ["mode"] and (.mode | IN("omit", "durable", "optional", "managed-durable")) end);
    if type == "object" and .version == 1 and (.routes | type == "array" and length > 0)
      and all(.routes[]; (.method | IN("GET", "POST", "PUT", "PATCH", "DELETE"))
        and (.path | type == "string" and test("^/([a-zA-Z0-9_.-]+|:[a-zA-Z0-9_]+)(/([a-zA-Z0-9_.-]+|:[a-zA-Z0-9_]+))*$"))
        and (.localCliCredential | policy))
    then .routes[] | [.method, .path, .localCliCredential.mode, (.localCliCredential.field // "")] | join("|")
    else error("invalid credential route projection") end' "$file")" || return 2
  if ! api_local_path_is_canonical "$pathname"; then
    printf 'Malformed local API route: %s\n' "$pathname" >&2
    return 2
  fi
  while IFS='|' read -r route_method route_path mode field; do
    [[ "$route_method" == "$method" ]] || continue
    api_route_template_matches "$route_path" "$pathname" || continue
    case "$mode" in
      omit) return 1 ;;
      durable) return 0 ;;
      optional) return 3 ;;
      managed-durable) api_managed_client_markers_present && return 0; return 1 ;;
      body-nonempty)
        jq -e --arg key "$field" '.[$key] | type == "string" and length > 0' <<< "$body" >/dev/null 2>&1 && return 0
        return 1 ;;
    esac
  done <<< "$routes"
  printf 'Unregistered local API route: %s %s; nothing was sent.\n' "$method" "$pathname" >&2
  return 2
}

# Managed-session marker guard for the durable operator keychain credential: any
# of these markers means the caller is a managed/agent process that must receive
# its own explicit token from its spawner, never the operator's ambient
# credential (which would silently collapse agent attribution into the human
# operator). Returns success (0) when a marker is present.
#
# This marker family is intentionally broader than the provider resolver below:
# generic managed/session markers still fence off operator credentials even
# when they do not identify a provider-specific agent account.
api_managed_client_markers_present() {
  [[ -n "${MANDIBLE_MANAGED_CLIENT:-}${CODEX_THREAD_ID:-}${CODEX_SESSION_ID:-}${CLAUDE_CODE_SESSION_ID:-}${CLAUDE_SESSION_ID:-}${GEMINI_SESSION_ID:-}${MANDIBLE_SESSION_ID:-}" ]]
}

api_local_path_is_canonical() {
  local pathname="$1"
  jq -en --arg path "$pathname" '
    ($path | startswith("/"))
    and ($path | explode | all((. >= 48 and . <= 57) or (. >= 65 and . <= 90)
      or (. >= 97 and . <= 122) or IN(33,36,37,38,39,40,41,42,43,44,45,46,47,58,59,61,64,95,126)))
    and ($path | gsub("%[a-fA-F0-9]{2}"; "") | contains("%") | not)
    and ($path | test("%(0[0-9a-f]|1[0-9a-f]|7f)"; "i") | not)
    and ($path | split("/") | all(ascii_downcase | gsub("%2e"; ".") | . != "." and . != ".."))
  ' >/dev/null || return 1
  printf '%b' "${pathname//\%/\\x}" | iconv -f UTF-8 -t UTF-8 >/dev/null 2>&1
}

# Resolve one provider from ambient provider markers plus an optional explicit
# provider hint (used by wrap.sh). Duplicate markers for one provider are fine;
# markers naming different providers are ambiguous and deliberately resolve to
# nothing. The hint participates in the same ambiguity check.
api_agent_provider() {
  local hint="${1:-}" provider="" count=0
  local has_codex=0 has_claude=0 has_gemini=0
  [[ -z "$hint" ]] || secret_material_valid "$hint" || return 1
  [[ -z "${CODEX_THREAD_ID:-}" || -z "${CODEX_SESSION_ID:-}" || "$CODEX_THREAD_ID" == "$CODEX_SESSION_ID" ]] || return 1
  [[ -z "${CLAUDE_CODE_SESSION_ID:-}" || -z "${CLAUDE_SESSION_ID:-}" || "$CLAUDE_CODE_SESSION_ID" == "$CLAUDE_SESSION_ID" ]] || return 1

  [[ -z "${CODEX_THREAD_ID:-}${CODEX_SESSION_ID:-}" ]] || has_codex=1
  [[ -z "${CLAUDE_CODE_SESSION_ID:-}${CLAUDE_SESSION_ID:-}" ]] || has_claude=1
  [[ -z "${GEMINI_SESSION_ID:-}" ]] || has_gemini=1

  if [[ -n "$hint" ]]; then
    case "$hint" in
      codex) has_codex=1 ;;
      claude) has_claude=1 ;;
      gemini) has_gemini=1 ;;
      *) provider="$hint" ;;
    esac
  fi

  (( has_codex == 0 )) || { provider="codex"; count=$(( count + 1 )); }
  (( has_claude == 0 )) || { provider="claude"; count=$(( count + 1 )); }
  (( has_gemini == 0 )) || { provider="gemini"; count=$(( count + 1 )); }
  if [[ -n "$hint" && "$hint" != "codex" && "$hint" != "claude" && "$hint" != "gemini" ]]; then
    count=$(( count + 1 ))
  fi
  (( count == 1 )) || return 1
  printf '%s' "$provider"
}

# api_durable_credential_missing_reason <reason> [service]
# The sentence a refused credential-gated call prints: why no durable
# credential was attached, and what to do about it.
api_durable_credential_missing_reason() {
  local reason="$1" service="${2:-}" name markers=()
  case "$reason" in
    keychain_disabled)
      printf 'MANDIBLE_NO_KEYCHAIN_TOKEN=1 disables the Keychain lookup; unset it to use the stored credential.' ;;
    codex_sandbox)
      printf 'This command runs inside the Codex sandbox (CODEX_SANDBOX=%s), which hides the Keychain and the Mandible socket. Rerun it outside the sandbox: request escalated permissions, or run Codex with sandbox_mode = "danger-full-access".' \
        "${CODEX_SANDBOX:-}" ;;
    provider_unresolved)
      for name in CLAUDE_CODE_SESSION_ID CLAUDE_SESSION_ID CODEX_THREAD_ID CODEX_SESSION_ID GEMINI_SESSION_ID MANDIBLE_SESSION_ID MANDIBLE_MANAGED_CLIENT; do
        [[ -z "$(printenv "$name")" ]] || markers+=("$name")
      done
      printf 'This is an agent process, but its markers (%s) name no single provider, so neither an agent nor the operator credential applies. Run the command from the agent'"'"'s own shell, where exactly one provider'"'"'s session id is set.' \
        "${markers[*]}" ;;
    keychain_item_missing)
      printf 'No Keychain item exists for service %s. The operator can store one with: mandible user token mint <user> --store' "$service" ;;
    *)
      printf 'The Keychain lookup for service %s failed: the keychain may be locked, or this process was denied access to the item.' "$service" ;;
  esac
}

# ── Secret backend seam (issue e2cb93f) ──────────────────────────────────────
# One place that knows how OS secret storage is reached, so readers (this file's
# operator and per-agent token resolver) and the writer
# (`mandible user token mint --store`) share a single dispatch point instead of
# each open-coding `security`. It lives in api.sh because api.sh is the helper
# every CLI entry point already sources; it is otherwise independent of HTTP.
#
# Secret handling rules these helpers keep:
#   - Values are never printed, logged, or written to disk here. secret_get
#     emits the value on stdout solely for command-substitution capture by an
#     immediate caller; secret_set takes it on stdin, never as an argument.
#   - Nothing reaches argv, so `ps` never sees a secret. The macOS write uses
#     `security -i` batch mode, where the whole command line — password
#     included — arrives on stdin.
#   - Secret-bearing regions suspend `xtrace` and restore the previous setting,
#     so running a CLI under `bash -x` / `zsh -x` cannot echo secret material.
#     This obligation is shared: a callee cannot protect its caller, so every
#     site that CAPTURES a secret suspends around its own assignment. See the
#     xtrace idiom below.
#
# Keying contract. An item is identified by (service, account):
#   - secret_set always writes both, and verifies by reading back both.
#   - secret_get takes the account as an optional second argument. The operator
#     reader queries service-only for compatibility with hand-created items;
#     the agent resolver first reads the service's account and then uses that
#     exact account for both identity verification and the secret read.
#   - A service-only lookup resolves to whichever item macOS returns first, so
#     two items sharing a service but differing in account are ambiguous for
#     those readers. secret_account_for_service exposes the account a
#     service-only read would land on; `token mint --store` uses it to refuse
#     rather than create such a pair.
#
# Accepted material (service, account and secret alike): non-empty, ASCII, and
# free of control characters — in practice one line of printable ASCII. This is
# not arbitrary conservatism: `security` returns non-ASCII password data as a
# hex string rather than the original bytes (so UTF-8 would silently round-trip
# wrong), and tabs/newlines break the batch parser's tokenization. Anything else
# is refused (exit 2) instead of stored incorrectly. Mandible bearer tokens are
# `mandible_pat_` + base64url, well inside this set.
#
# macOS is the only implemented backend today. Other platforms fail visibly for
# writers (secret_backend_available is false and callers surface
# secret_backend_unavailable_reason); for the two ambient readers, absence stays
# deliberately silent, because "no token here" is a normal state on every code
# path that calls them and a warning would fire on every unrelated command. The
# Linux secret-tool backend stays open on issue e2cb93f.

# The keychain tool by absolute path: a hostile PATH must not be able to
# substitute the binary that reads and writes credentials. The override exists
# so tests can point the seam at a stub; it is not an operator knob.
#
# Trust note: MANDIBLE_SECURITY_BIN names an executable chosen by the
# environment, so anyone who can set it can substitute the credential tool. It
# is exactly as trusted as PATH itself, and is only more constrained: the
# default resolves to an absolute path that PATH cannot influence.
: "${MANDIBLE_SECURITY_BIN:=/usr/bin/security}"

# ── xtrace suspension idiom for secret-bearing regions (issue e2cb93f) ───────
#
# A function cannot protect its callers. Command substitution runs in a
# subshell, and the shell prints the trace line for `token=$(secret_get …)`
# after the substitution completes — so whatever the callee does to its own
# tracing, the CALLER still echoes the expanded value. Every site that captures
# or handles secret material must therefore suspend tracing around its own
# region, using this idiom verbatim:
#
#   local traced=0
#   case "$-" in *x*) traced=1; { set +x; } 2>/dev/null ;; esac
#   token=$(secret_get some-service)
#   ... use "$token" ...
#   (( traced == 0 )) || set -x
#
# It is deliberately inlined rather than wrapped in a helper function: in zsh
# the xtrace option is restored when the function that changed it returns, so a
# `suspend_tracing` helper would protect nothing in its caller (verified on zsh
# 5.9; bash propagates, zsh does not). Every non-fatal exit path from a
# suspended region must restore.

# Reject material that the backend cannot store faithfully (see header).
secret_material_valid() {
  case "${1-}" in
    "") return 1 ;;
    *[![:ascii:]]*) return 1 ;;
    *[[:cntrl:]]*) return 1 ;;
  esac
  return 0
}

# Quote a value for security's batch-mode line parser, which treats `"` as a
# string terminator and `\` as an escape inside a quoted string. Backslash first,
# then quote. Callers wrap the result in double quotes.
secret_batch_escape() {
  local value="${1-}"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '%s' "$value"
}

# Print the active backend name and return 0, or return nonzero when none is
# usable. Never prints anything on the unavailable path.
secret_backend_kind() {
  if [[ "$(uname -s)" == "Darwin" && -x "$MANDIBLE_SECURITY_BIN" ]]; then
    printf 'keychain'
    return 0
  fi
  return 1
}

secret_backend_available() {
  secret_backend_kind >/dev/null 2>&1
}

# One-line human explanation of why no backend is usable, for callers that need
# to fail loudly. Safe to call even when a backend is available.
secret_backend_unavailable_reason() {
  if [[ "$(uname -s)" == "Darwin" ]]; then
    printf 'the macOS keychain tool is missing at %s' "$MANDIBLE_SECURITY_BIN"
  else
    printf 'no secret backend available on this platform (%s); see Mandible issue e2cb93f' "$(uname -s)"
  fi
}

# secret_get <service> [account]
# Print the stored secret on stdout (no trailing newline) and return 0. Return
# nonzero, silently and with no output, when the backend is unavailable or the
# item is absent — absence is a normal condition every current caller treats as
# "no token", so diagnostics are left to the caller. Exit 2 marks unusable
# arguments. Omitting the account performs the service-only lookup described in
# the keying contract above.
secret_get() {
  local secret_traced=0 secret_rc=0
  case "$-" in *x*) secret_traced=1; { set +x; } 2>/dev/null ;; esac
  secret_get_impl "$@"
  secret_rc=$?
  (( secret_traced == 0 )) || set -x
  return "$secret_rc"
}

secret_get_impl() {
  local service="${1:-}" account="${2:-}" value
  secret_material_valid "$service" || return 2
  [[ -z "$account" ]] || secret_material_valid "$account" || return 2
  secret_backend_available || return 1
  if [[ -n "$account" ]]; then
    value=$("$MANDIBLE_SECURITY_BIN" find-generic-password -s "$service" -a "$account" -w 2>/dev/null) || return 1
  else
    value=$("$MANDIBLE_SECURITY_BIN" find-generic-password -s "$service" -w 2>/dev/null) || return 1
  fi
  [[ -n "$value" ]] || return 1
  printf '%s' "$value"
}

# Exit status of `security find-generic-password` when no item matches. Every
# other nonzero status is an operational failure (locked keychain, missing
# keychain file, permission denial) that callers must not read as "absent".
SECRET_KEYCHAIN_NOT_FOUND_STATUS=44

# secret_account_for_service <service>
# Report which account a SERVICE-ONLY lookup resolves to — the lookup the two
# ambient readers perform. Reads attributes only: without -w and without -g,
# `security` never emits the password.
#
# Three outcomes, deliberately distinguished so callers can fail closed:
#   0 — an item exists; its account is printed
#   1 — no such item (the backend reported not-found, status 44)
#   3 — could not determine: backend unavailable, an operational failure, or an
#       item whose attributes did not yield an account
#   2 — unusable argument
#
# Which item macOS returns among several sharing a service is not a documented
# ordering (observed: the oldest), so treat the answer as "what a reader would
# get right now", not as an enumeration.
secret_account_for_service() {
  # Not named `status`: that identifier is a read-only alias for $? in zsh.
  local service="${1:-}" attributes account lookup_status=0
  secret_material_valid "$service" || return 2
  secret_backend_available || return 3
  attributes=$("$MANDIBLE_SECURITY_BIN" find-generic-password -s "$service" 2>/dev/null) \
    || lookup_status=$?
  if (( lookup_status != 0 )); then
    (( lookup_status == SECRET_KEYCHAIN_NOT_FOUND_STATUS )) && return 1
    return 3
  fi
  account=$(printf '%s\n' "$attributes" \
    | sed -n '/^[[:space:]]*"acct"<blob>=".*"$/ { s/^[[:space:]]*"acct"<blob>="\(.*\)"$/\1/; p; q; }')
  [[ -n "$account" ]] || return 3
  printf '%s' "$account"
}

# secret_set <service> <account>  (secret value read from stdin)
# Create or rotate the item keyed by (service, account), then read it back and
# verify it matches. Returns nonzero on any failure and never echoes the value.
#
# The value is one line on a pipe, with an optional trailing newline:
#   printf '%s' "$token" | secret_set mandible-operator mll
# Anything more on that stream — a second line, stray NULs — is refused with
# exit 2 rather than silently truncated to the first line.
#
# The write goes through `security -i` batch mode: the full
# `add-generic-password ...` command line is fed on stdin, so the password is
# neither an argv element nor a getpass() prompt. The obvious alternatives are
# both wrong. Passing `-w <secret>` inline exposes the secret in `ps` output for
# the lifetime of the call. Passing `-w` with no value and piping the password
# works only when the process has no controlling terminal: `security` collects a
# missing password with getpass(3), which opens /dev/tty when one exists and
# ignores the pipe entirely — an operator running this from a terminal gets a
# hung interactive prompt instead of the piped value.
#
# `-U` is what makes a second call a rotation instead of a duplicate-item error.
secret_set() {
  local secret_traced=0 secret_rc=0
  case "$-" in *x*) secret_traced=1; { set +x; } 2>/dev/null ;; esac
  secret_set_impl "$@"
  secret_rc=$?
  (( secret_traced == 0 )) || set -x
  return "$secret_rc"
}

secret_set_impl() {
  local service="${1:-}" account="${2:-}" value="" stored="" extra_bytes=""
  secret_material_valid "$service" || return 2
  secret_material_valid "$account" || return 2
  secret_backend_available || return 1
  # Read with NUL as the delimiter, not newline, and treat a SUCCESSFUL read as
  # a refusal. `read -r -d ''` returns 0 only when it actually consumed a NUL
  # delimiter, and nonzero at clean EOF with the value retained — identical on
  # bash 3.2 and zsh 5.9. So the read status alone answers "did the input
  # contain a NUL anywhere?", structurally, wherever the NUL sits: terminal
  # (`tok\0`), leading (`\0tok`), or interior (`t\0ok`).
  #
  # That is stronger than inspecting the value or the leftover bytes, both of
  # which miss a terminal NUL: it is swallowed as the delimiter, so nothing
  # invalid lands in the value and nothing is left over to count, and `tok\0`
  # would otherwise be stored as the truncated `tok` with exit 0. A
  # newline-delimited read is worse still — bash drops NULs silently on the way
  # into the variable.
  if IFS= read -r -d '' value; then
    return 2
  fi
  # A single trailing newline is part of the calling convention; a second one is
  # surplus and is caught by the material check below as a control character.
  value="${value%$'\n'}"

  # Nothing may follow. NULs are already refused above, so this covers the rest:
  # a second line, and any input the read did not consume. `wc` reads this
  # function's stdin directly, and both properties of that matter:
  #   - the leftover bytes never pass through a shell variable, so they are
  #     counted rather than sanitized. A capture-and-compare scheme cannot see
  #     NUL material at all: command substitution drops NULs, so a NUL-only
  #     remainder is indistinguishable from an empty one.
  #   - there is no pipeline, so the status is `wc`'s own. A broken or missing
  #     counter fails closed instead of reading as "nothing left", with no need
  #     to reconcile bash's PIPESTATUS against zsh's pipestatus (different name,
  #     different base index).
  #
  # The value must arrive on a pipe or another non-seekable stream. Both shells
  # rewind a seekable fd after `read`, so a file redirection would make this
  # count re-see bytes that were already consumed — that fails closed (exit 2),
  # never a wrong store.
  extra_bytes="$(wc -c)" || return 2
  # BSD wc pads its count with spaces; GNU wc does not.
  extra_bytes="${extra_bytes//[[:space:]]/}"
  # Equality with "0" is the entire validation: empty output, a non-numeric
  # count, and any positive count all refuse.
  [[ "$extra_bytes" == "0" ]] || return 2
  secret_material_valid "$value" || return 2
  # printf is a shell builtin, so the assembled command line never becomes the
  # argv of a new process; only `security -i` is exec'd.
  printf 'add-generic-password -U -s "%s" -a "%s" -w "%s"\n' \
    "$(secret_batch_escape "$service")" \
    "$(secret_batch_escape "$account")" \
    "$(secret_batch_escape "$value")" \
    | "$MANDIBLE_SECURITY_BIN" -i >/dev/null 2>&1 \
    || return 1
  # Batch mode reports parse failures on its own stream rather than always
  # through exit status, so the read-back is the real success signal.
  stored=$(secret_get_impl "$service" "$account") || return 1
  [[ "$stored" == "$value" ]] || return 1
}

# Read the durable operator bearer token from the OS keychain: a generic-password
# item with service name `mandible-operator` (git-credential-helper pattern;
# naming contract on dotfiles/dfa69d1). Reads through the secret seam above, so
# an absent tool, an absent item, or an unsupported platform are all the same
# normal, non-fatal "no token" outcome (empty output, exit 0). The value is never
# printed or logged — it is emitted on stdout solely for command-substitution
# capture by api_client_token. Opt out with MANDIBLE_NO_KEYCHAIN_TOKEN=1.
api_keychain_operator_token() {
  local traced=0 rc=0
  case "$-" in *x*) traced=1; { set +x; } 2>/dev/null ;; esac
  api_keychain_operator_token_impl
  rc=$?
  (( traced == 0 )) || set -x
  return "$rc"
}

api_keychain_operator_token_impl() {
  [[ "${MANDIBLE_NO_KEYCHAIN_TOKEN:-}" == "1" ]] && return 0
  local token
  token=$(secret_get mandible-operator) || return 0
  [[ -n "$token" ]] || return 0
  printf '%s' "$token"
}

# Verify one inherited agent token without entering the normal API helper path.
# This must stay low-level: api_http_exchange calls api_client_token, so using it
# (or api_capture/api_request) here would recurse. The bearer is staged only in
# the existing 0600 temporary-file seam and the probe is a single bounded curl.
api_inherited_agent_token_matches() {
  local token="$1" account="$2" cfg="" out="" http_status="" curl_rc=0 matches_rc=1
  api_is_file_rpc && return 1
  command -v curl >/dev/null 2>&1 || return 1
  command -v jq >/dev/null 2>&1 || return 1

  cfg="$(api_temp_file)" || return 1
  out="$(api_temp_file)" || { rm -f "$cfg"; return 1; }
  printf 'header = "Authorization: Bearer %s"\n' "$token" > "$cfg"
  http_status=$(curl -s --max-time 2 \
    --config "$cfg" -o "$out" -w '%{http_code}' \
    "$(api_base)/api/client-auth/whoami" 2>/dev/null) || curl_rc=$?
  if [[ "$curl_rc" -eq 0 && "$http_status" =~ ^2 ]] \
      && jq -e --arg account "$account" \
        '.authenticated == true and .user.kind == "agent" and .user.slug == $account' \
        "$out" >/dev/null 2>&1; then
    matches_rc=0
  fi
  rm -f "$cfg" "$out"
  return "$matches_rc"
}

api_warn_rejected_inherited_agent_token() {
  printf 'mandible: ignoring inherited MANDIBLE_TOKEN for %s agent context because its identity could not be verified against the matching Keychain account; no fallback credential was attached.\n' \
    "$1" >&2
}

# Resolve the client-auth bearer/capability token and record its source in the
# two globals below. Agent contexts use one fail-closed policy for direct CLI
# and wrap.sh calls. Human shells retain the existing priority order.
API_CLIENT_CREDENTIAL_TOKEN=""
API_CLIENT_CREDENTIAL_SOURCE=""

api_resolve_client_credential() {
  local traced=0 rc=0
  case "$-" in *x*) traced=1; { set +x; } 2>/dev/null ;; esac
  api_resolve_client_credential_impl "$@"
  rc=$?
  (( traced == 0 )) || set -x
  return "$rc"
}

api_resolve_client_credential_impl() {
  local method="${1:-}" provider_hint="${2:-}" provider="" service="" account="" token=""
  API_CLIENT_CREDENTIAL_TOKEN=""
  API_CLIENT_CREDENTIAL_SOURCE=""

  if provider="$(api_agent_provider "$provider_hint")"; then
    # File transport deliberately receives no automatically projected agent
    # bearer: unlike HTTP, the token would become durable spool-file content.
    if api_is_file_rpc; then
      [[ -z "${MANDIBLE_TOKEN:-}" ]] || api_warn_rejected_inherited_agent_token "$provider"
      return 0
    fi
    service="mandible-agent-$provider"
    account="$(secret_account_for_service "$service")" || {
      [[ -z "${MANDIBLE_TOKEN:-}" ]] || api_warn_rejected_inherited_agent_token "$provider"
      return 0
    }
    secret_material_valid "$account" || {
      [[ -z "${MANDIBLE_TOKEN:-}" ]] || api_warn_rejected_inherited_agent_token "$provider"
      return 0
    }
    if [[ -n "${MANDIBLE_TOKEN:-}" ]]; then
      if api_inherited_agent_token_matches "$MANDIBLE_TOKEN" "$account"; then
        API_CLIENT_CREDENTIAL_TOKEN="$MANDIBLE_TOKEN"
        API_CLIENT_CREDENTIAL_SOURCE="inherited"
      else
        api_warn_rejected_inherited_agent_token "$provider"
      fi
      return 0
    fi
    [[ "${MANDIBLE_NO_KEYCHAIN_TOKEN:-}" == "1" ]] && return 0
    token="$(secret_get "$service" "$account")" || return 0
    [[ -n "$token" ]] || return 0
    API_CLIENT_CREDENTIAL_TOKEN="$token"
    API_CLIENT_CREDENTIAL_SOURCE="keychain"
    return 0
  fi

  # An explicit provider hint or any managed-client marker with no unique
  # provider is an agent context whose credential identity is ambiguous.
  if [[ -n "$provider_hint" ]] || api_managed_client_markers_present; then
    [[ -z "${MANDIBLE_TOKEN:-}" ]] || api_warn_rejected_inherited_agent_token "ambiguous"
    return 0
  fi

  if [[ -n "${MANDIBLE_TOKEN:-}" ]]; then
    API_CLIENT_CREDENTIAL_TOKEN="$MANDIBLE_TOKEN"
    API_CLIENT_CREDENTIAL_SOURCE="inherited"
    return 0
  fi
  # Ordinary human access at the registered origin is intrinsic to this OS
  # account. Never read an old Keychain item or trigger its permission prompt.
  if api_local_human_http; then
    API_CLIENT_CREDENTIAL_SOURCE="local_os_user"
    return 0
  fi
  token="$(api_keychain_operator_token)"
  if [[ -n "$token" ]]; then
    API_CLIENT_CREDENTIAL_TOKEN="$token"
    API_CLIENT_CREDENTIAL_SOURCE="keychain"
    return 0
  fi
}

# Resolve the client-auth bearer/capability token, in priority order:
#   1. In agent contexts, a verified inherited token or that provider's
#      Keychain token, with no operator fallback.
#   2. In human shells, an explicit MANDIBLE_TOKEN or intrinsic access at the
#      registered local origin; custom origins may use the operator Keychain.
# Agent contexts never receive operator credentials.
api_client_token() {
  local traced=0 rc=0
  case "$-" in *x*) traced=1; { set +x; } 2>/dev/null ;; esac
  api_resolve_client_credential "$@"
  rc=$?
  [[ -z "$API_CLIENT_CREDENTIAL_TOKEN" ]] || printf '%s' "$API_CLIENT_CREDENTIAL_TOKEN"
  (( traced == 0 )) || set -x
  return "$rc"
}

api_file_rpc_dir() {
  local value="${MANDIBLE_BASE#file://}"
  case "$value" in
    localhost/*) printf '/%s' "${value#localhost/}" ;;
    /*) printf '%s' "$value" ;;
    *) printf '%s' "$value" ;;
  esac
}

api_http_retryable_status() {
  local http_status="${1:-000}"
  case "$http_status" in
    000|408|425|429|502|503|504) return 0 ;;
    *) return 1 ;;
  esac
}

api_http_retry_delay_ms() {
  local retry_index="${1:-0}"
  local base_ms="${MANDIBLE_HTTP_RETRY_BASE_MS:-100}"
  local max_ms="${MANDIBLE_HTTP_RETRY_MAX_MS:-1000}"
  local jitter_ms="${MANDIBLE_HTTP_RETRY_JITTER_MS:-100}"
  local delay_ms jitter=0 i

  [[ "$base_ms" =~ ^[0-9]+$ ]] || base_ms=100
  [[ "$max_ms" =~ ^[0-9]+$ ]] || max_ms=1000
  [[ "$jitter_ms" =~ ^[0-9]+$ ]] || jitter_ms=100
  [[ "$retry_index" =~ ^[0-9]+$ ]] || retry_index=0
  delay_ms="$base_ms"
  for ((i = 0; i < retry_index; i += 1)); do
    delay_ms=$(( delay_ms * 2 ))
    (( delay_ms >= max_ms )) && { delay_ms="$max_ms"; break; }
  done
  (( delay_ms > max_ms )) && delay_ms="$max_ms"
  (( jitter_ms > 0 )) && jitter=$(( RANDOM % (jitter_ms + 1) ))
  printf '%s' "$(( delay_ms + jitter ))"
}

api_http_sleep_before_retry() {
  local delay_ms
  delay_ms=$(api_http_retry_delay_ms "$1")
  sleep "$(printf '%d.%03d' "$(( delay_ms / 1000 ))" "$(( delay_ms % 1000 ))")"
}

api_http_probe_health() {
  local health_base="${1:-$(api_base)}"
  local health_tmp http_status curl_exit=0 ready rebuilding bindings
  health_tmp=$(api_temp_file)
  local socket_args=()
  api_is_local_socket && socket_args=(--unix-socket "$MANDIBLE_SOCKET")
  if http_status=$(curl -s --max-time "${MANDIBLE_HEALTH_TIMEOUT:-2}" ${socket_args[@]+"${socket_args[@]}"} -o "$health_tmp" \
      -w "%{http_code}" "${health_base}/api/health" 2>/dev/null); then
    :
  else
    curl_exit=$?
  fi
  http_status="${http_status:-000}"
  if [[ "$curl_exit" -eq 0 && "$http_status" =~ ^2 ]]; then
    ready=unknown rebuilding=false
    if bindings=$(api_json_bindings '{ready: (if has("ready") then (.ready | tostring) else "unknown" end), rebuilding: ((.rebuilding // false) | tostring)}' "$health_tmp" 2>/dev/null); then
      eval "$bindings"
    fi
    rm -f "$health_tmp"
    if [[ "$ready" == "false" || "$rebuilding" == "true" ]]; then
      printf 'busy_not_ready'
    elif [[ "$ready" == "true" ]]; then
      printf 'busy_ready'
    else
      printf 'reachable_unknown'
    fi
    return 0
  fi
  if [[ "$http_status" =~ ^5 ]]; then
    rm -f "$health_tmp"
    printf 'busy_not_ready'
    return 0
  fi
  if [[ "$http_status" != "000" ]]; then
    rm -f "$health_tmp"
    printf 'reachable_unknown'
    return 0
  fi
  rm -f "$health_tmp"
  printf 'down_unreachable'
}

api_report_final_http_failure() {
  local request_path="$1" http_status="$2" curl_exit="$3" health_state
  health_state=$(api_http_probe_health)
  case "$health_state" in
    busy_not_ready)
      printf 'Mandible request failed after bounded retries: daemon is reachable but busy or not ready (path=%s, status=%s, curl=%s).\n' \
        "$request_path" "$http_status" "$curl_exit" >&2
      ;;
    busy_ready)
      printf 'Mandible request failed after bounded retries: daemon is reachable and ready, but this request remained busy or timed out (path=%s, status=%s, curl=%s).\n' \
        "$request_path" "$http_status" "$curl_exit" >&2
      ;;
    reachable_unknown)
      printf 'Mandible request failed after bounded retries: daemon is reachable, but readiness is unknown (path=%s, status=%s, curl=%s).\n' \
        "$request_path" "$http_status" "$curl_exit" >&2
      ;;
    *)
      if [[ -n "${CODEX_SANDBOX:-}" ]] && api_is_local_socket; then
        printf 'Mandible request failed: this command runs inside the Codex sandbox (CODEX_SANDBOX=%s), which blocks the Mandible socket (path=%s, curl=%s). Rerun it outside the sandbox: request escalated permissions, or run Codex with sandbox_mode = "danger-full-access".\n' \
          "$CODEX_SANDBOX" "$request_path" "$curl_exit" >&2
      else
        printf 'Mandible request failed after bounded retries: daemon is down or unreachable (path=%s, status=%s, curl=%s).\n' \
          "$request_path" "$http_status" "$curl_exit" >&2
      fi
      ;;
  esac
}

api_report_terminal_response() {
  local method="$1" request_path="$2" http_status="$3" output_file="$4"
  printf 'Mandible request failed (method=%s, path=%s, status=%s).\n' \
    "$method" "$request_path" "$http_status" >&2
  if [[ -s "$output_file" ]]; then
    cat "$output_file" >&2
    [[ -z "$(tail -c 1 "$output_file" 2>/dev/null || true)" ]] || printf '\n' >&2
  fi
}

# Execute one API request with bounded retry. The response body always lands in
# output_file and the final HTTP-equivalent status is the only stdout output.
api_http_exchange() {
  local method="$1" request_path="$2" data="$3" output_file="$4"
  local retry_limit="${MANDIBLE_HTTP_RETRIES:-2}" attempt=0 http_status curl_exit
  local body_tmp="" stderr_tmp retryable empty_response token="" token_cfg="" local_human=0 csrf="" gated=0 optional_gate=0 gate_status=0 provider service="" account="" lookup_status=0 missing=""
  local ambient_headers=() curl_args=()

  [[ "$retry_limit" =~ ^[0-9]+$ ]] || retry_limit=2
  while IFS= read -r -d '' header_arg; do
    ambient_headers+=("$header_arg")
  done < <(api_curl_ambient_headers)
  if [[ "$method" != "GET" ]]; then
    body_tmp=$(api_temp_file)
    printf '%s' "$data" > "$body_tmp"
  fi
  stderr_tmp=$(api_temp_file)

  # Deliberate durable credentials travel via a 0600 curl config, never argv.
  # Ordinary socket calls skip inherited tokens and Keychain entirely.
  #
  # xtrace is suspended across the capture and the config write (issue e2cb93f):
  # both the assignment and the printf would otherwise echo the bearer token.
  local token_traced=0
  case "$-" in *x*) token_traced=1; { set +x; } 2>/dev/null ;; esac
  if api_is_local_socket; then
    if api_local_route_requires_credential "$method" "$request_path" "$data"; then
      gated=1
    else
      gate_status=$?
      if (( gate_status == 3 )); then
        gated=1
        optional_gate=1
      elif (( gate_status != 1 )); then
        (( token_traced == 0 )) || set -x
        rm -f "$body_tmp" "$stderr_tmp" 2>/dev/null || true
        printf '000'
        return 0
      fi
    fi
    if (( gated )); then
      if [[ "${MANDIBLE_NO_KEYCHAIN_TOKEN:-}" == "1" ]]; then
        missing="keychain_disabled"
      elif provider="$(api_agent_provider)"; then
        service="mandible-agent-$provider"
        account="$(secret_account_for_service "$service")" || lookup_status=$?
        if [[ -n "$account" ]]; then
          token="$(secret_get "$service" "$account")" || token=""
        fi
      elif ! api_managed_client_markers_present; then
        service="mandible-operator"
        token="$(api_keychain_operator_token)"
        [[ -n "$token" ]] || lookup_status=1
      else
        missing="provider_unresolved"
      fi
      if [[ -z "$token" && "$optional_gate" == 0 ]]; then
        if [[ "$missing" != "keychain_disabled" && -n "${CODEX_SANDBOX:-}" ]]; then
          missing="codex_sandbox"
        elif [[ -z "$missing" ]]; then
          missing="keychain_lookup_failed"
          (( lookup_status != 1 )) || missing="keychain_item_missing"
        fi
        printf 'Mandible durable credential required for %s %s; nothing was sent. %s\n' \
          "$method" "$request_path" "$(api_durable_credential_missing_reason "$missing" "$service")" >&2
        (( token_traced == 0 )) || set -x
        rm -f "$body_tmp" "$stderr_tmp" 2>/dev/null || true
        jq -n --arg reason "$missing" --arg service "$service" \
          '{error:"cli_durable_credential_missing", reason:$reason, service:($service | select(length > 0)), request_sent:false}' > "$output_file"
        printf '401'
        return 0
      fi
    fi
  else
    token="$(api_client_token "$method")"
  fi
  if [[ -n "$token" ]]; then
    token_cfg=$(api_temp_file)
    printf 'header = "Authorization: Bearer %s"\n' "$token" > "$token_cfg"
  elif api_local_human_http; then
    local_human=1
    if [[ "$method" != "GET" && "$request_path" != "/api/users/setup" ]]; then
      csrf="$(api_local_operator_csrf)" || {
        printf 'Mandible local operator is unavailable; no mutation was sent.\n' >&2
        [[ -z "$body_tmp" ]] || rm -f "$body_tmp"
        rm -f "$stderr_tmp"
        printf '000'
        return 0
      }
    fi
  fi
  (( token_traced == 0 )) || set -x

  while true; do
    : > "$output_file"
    : > "$stderr_tmp"
    curl_args=(-s --max-time "${MANDIBLE_HTTP_TIMEOUT:-15}" -o "$output_file" -w "%{http_code}")
    api_is_local_socket && curl_args+=(--unix-socket "$MANDIBLE_SOCKET")
    [[ -n "$token_cfg" ]] && curl_args+=(--config "$token_cfg")
    (( ${#ambient_headers[@]} )) && curl_args+=("${ambient_headers[@]}")
    if (( local_human )); then
      curl_args+=(-H "Origin: $MANDIBLE_CANONICAL_ORIGIN" -H 'Sec-Fetch-Site: same-origin')
      [[ -z "$csrf" ]] || curl_args+=(-H "X-Mandible-CSRF: $csrf")
    fi
    if [[ "$method" != "GET" ]]; then
      curl_args+=(-X "$method" -H 'Content-Type: application/json')
      curl_args+=(--data-binary "@$body_tmp")
    fi
    curl_args+=("$(api_base)$request_path")
    if http_status=$(curl "${curl_args[@]}" 2>"$stderr_tmp"); then
      curl_exit=0
    else
      curl_exit=$?
    fi
    http_status="${http_status:-000}"
    # A transfer curl abandoned (e.g. --max-time after the headers arrived)
    # still reports the server's 2xx, beside a truncated body.
    if (( curl_exit != 0 )); then
      http_status=000
      : > "$output_file"
    fi
    empty_response=false
    [[ ! -s "$output_file" ]] && empty_response=true
    retryable=false
    if api_http_retryable_status "$http_status" \
        || [[ "$empty_response" == "true" && "$http_status" =~ ^2 && "$http_status" != "204" ]]; then
      retryable=true
    fi

    if [[ "$retryable" != "true" ]]; then
      break
    fi
    if (( attempt >= retry_limit )) || { [[ "$method" != "GET" ]] && ( api_is_local_socket || (( gated || local_human )) ); }; then
      api_report_final_http_failure "$request_path" "$http_status" "$curl_exit"
      break
    fi
    printf 'Mandible request transient failure; retrying (attempt=%s, path=%s, status=%s, curl=%s).\n' \
      "$(( attempt + 1 ))" "$request_path" "$http_status" "$curl_exit" >&2
    api_http_sleep_before_retry "$attempt"
    attempt=$(( attempt + 1 ))
  done

  rm -f "$stderr_tmp"
  [[ -z "$body_tmp" ]] || rm -f "$body_tmp"
  [[ -z "$token_cfg" ]] || rm -f "$token_cfg"
  printf '%s' "$http_status"
}

# MANDIBLE_SESSION_ID and the provider session markers are environment
# variables, so agents nested inside a session (a `claude -p` or `codex exec`
# probe) inherit them. When several providers' markers are present, only the
# nearest agent's are the caller's own. A session id is the caller's own only
# when the nearest agent process above the caller is the one its session row
# records (a row with no pid yet, or no row, binds nothing); otherwise it is
# unset here. A matching provider session proves the same process without a
# process-tree walk.
api_scope_inherited_identity() {
  local processes="" nearest="" own_marker="" row_pid="" row_conversation="" row_path row_file http_status bindings

  if (( $(api_provider_marker_count) > 1 )); then
    processes=$(api_process_table)
    nearest=$(api_nearest_agent "$processes" "")
    case "${nearest#* }" in
      claude) unset CODEX_THREAD_ID CODEX_SESSION_ID GEMINI_SESSION_ID ;;
      codex) unset CLAUDE_CODE_SESSION_ID CLAUDE_SESSION_ID GEMINI_SESSION_ID ;;
      gemini) unset CLAUDE_CODE_SESSION_ID CLAUDE_SESSION_ID CODEX_THREAD_ID CODEX_SESSION_ID ;;
    esac
  fi
  [[ -n "${MANDIBLE_SESSION_ID:-}" ]] || return 0

  # The row is read as the caller's provider alone: the managed identity is the
  # one in question.
  row_file=$(api_temp_file) || return 1
  row_path="/api/sessions/$(urlencode "$MANDIBLE_SESSION_ID")"
  http_status=$(unset MANDIBLE_SESSION_ID; api_capture GET "$row_path" "" "$row_file")
  if [[ "$http_status" == 200 ]]; then
    if ! bindings=$(api_json_bindings '{row_pid: ((.pid // "") | if type == "number" then tostring else . end), row_conversation: (.conversation_id // "")}' "$row_file"); then
      rm -f "$row_file"
      return 1
    fi
    eval "$bindings"
  fi
  rm -f "$row_file"
  # 404 binds nothing; without the daemon there is nothing to attribute to, and
  # the command's own requests report that.
  [[ -n "$row_pid" ]] || return 0

  (( $(api_provider_marker_count) == 1 )) && own_marker="${CLAUDE_CODE_SESSION_ID:-${CLAUDE_SESSION_ID:-${CODEX_THREAD_ID:-${CODEX_SESSION_ID:-${GEMINI_SESSION_ID:-}}}}}"
  [[ -z "$own_marker" || "$own_marker" != "$row_conversation" ]] || return 0
  [[ -n "$processes" ]] || processes=$(api_process_table)
  nearest=$(api_nearest_agent "$processes" "$row_pid")
  [[ "${nearest%% *}" == "$row_pid" ]] || unset MANDIBLE_SESSION_ID
}

# A sandbox may deny `ps` (the Codex seatbelt does). An empty table finds no
# agent, so inherited markers stay ambiguous and an inherited session id is
# dropped: nothing is attributed that the process tree could not confirm.
api_process_table() {
  ps -axo pid=,ppid=,comm= 2>/dev/null || :
}

api_provider_marker_count() {
  local count=0
  [[ -z "${CLAUDE_CODE_SESSION_ID:-}${CLAUDE_SESSION_ID:-}" ]] || count=$(( count + 1 ))
  [[ -z "${CODEX_THREAD_ID:-}${CODEX_SESSION_ID:-}" ]] || count=$(( count + 1 ))
  [[ -z "${GEMINI_SESSION_ID:-}" ]] || count=$(( count + 1 ))
  printf '%s' "$count"
}

# The first process at or above this shell that is the given pid or an agent
# (claude, codex, gemini, or Claude's announced CLAUDE_PID), as "<pid> <kind>".
api_nearest_agent() {
  awk -v start="$$" -v owner="$2" -v claude_pid="${CLAUDE_PID:-}" '
    { pid = $1; parent[pid] = $2; $1 = ""; $2 = ""; sub(/^ +/, ""); n = split($0, path, "/"); name[pid] = path[n] }
    END {
      for (p = start; p > 1 && (p in parent); p = parent[p]) {
        kind = name[p] ~ /^(claude|codex|gemini)$/ ? name[p] : (p == claude_pid ? "claude" : "")
        if (p == owner || kind != "") { print p, kind; exit }
      }
    }' <<< "$1"
}

# Total, unlike api_agent_provider: callers assign it under errexit.
api_ambient_provider() {
  api_agent_provider || :
}

api_ambient_session_id() {
  local provider
  provider="$(api_agent_provider)" || return 0
  case "$provider" in
    codex) printf '%s' "${CODEX_THREAD_ID:-${CODEX_SESSION_ID:-}}" ;;
    claude) printf '%s' "${CLAUDE_CODE_SESSION_ID:-${CLAUDE_SESSION_ID:-}}" ;;
    gemini) printf '%s' "${GEMINI_SESSION_ID:-}" ;;
  esac
}

api_request_origin_json() {
  [[ "${MANDIBLE_REQUEST_ORIGIN+x}" ]] || return 0
  jq -cn --arg origin "$MANDIBLE_REQUEST_ORIGIN" 'try ($origin | fromjson) catch null'
}

api_curl_ambient_headers() {
  local provider session_id managed_app="${MANDIBLE_MANAGED_APP:-}" managed_session="${MANDIBLE_SESSION_ID:-}"
  provider=$(api_ambient_provider)
  session_id=$(api_ambient_session_id)
  local request_origin
  request_origin=$(api_request_origin_json)
  [[ -z "$request_origin" ]] || printf '%s\0%s\0' '-H' "X-Mandible-Request-Origin: ${request_origin}"
  if api_managed_client_markers_present; then
    printf '%s\0%s\0' '-H' 'X-Mandible-Managed-Client: 1'
  fi
  [[ -z "$provider" ]] || printf '%s\0%s\0' '-H' "X-Mandible-Ambient-Provider: ${provider}"
  [[ -z "$session_id" ]] || printf '%s\0%s\0' '-H' "X-Mandible-Ambient-Provider-Session-Id: ${session_id}"
  if [[ -n "$managed_app" && -n "$managed_session" ]] \
      && secret_material_valid "$managed_app" && secret_material_valid "$managed_session"; then
    printf '%s\0%s\0%s\0%s\0' \
      '-H' "X-Mandible-Managed-App: ${managed_app}" \
      '-H' "X-Mandible-Managed-Session-Id: ${managed_session}"
  fi
}

api_route_template_matches() {
  local route_template="$1"
  local pathname="$2"
  local template_part path_part template_more path_more

  # This helper is sourced by both bash and zsh CLIs. Split one path segment at
  # a time instead of using either shell's incompatible `read` array option.
  while true; do
    template_more=0
    path_more=0
    if [[ "$route_template" == */* ]]; then
      template_part="${route_template%%/*}"
      route_template="${route_template#*/}"
      template_more=1
    else
      template_part="$route_template"
    fi
    if [[ "$pathname" == */* ]]; then
      path_part="${pathname%%/*}"
      pathname="${pathname#*/}"
      path_more=1
    else
      path_part="$pathname"
    fi

    if [[ "$template_part" == :* ]]; then
      [[ -n "$path_part" ]] || return 1
    else
      [[ "$template_part" == "$path_part" ]] || return 1
    fi

    [[ "$template_more" -eq "$path_more" ]] || return 1
    [[ "$template_more" -eq 1 ]] || return 0
  done
}

api_instance_preflight_bindings() {
  local input_file="$1" method="$2" pathname="${3%%\?*}"
  api_json_bindings 'include "instance-preflight"; instance_preflight($method; $pathname)' \
    -L "$MANDIBLE_COMMAND_SYNTAX_DIR" --arg method "$method" --arg pathname "$pathname" "$input_file"
}

api_non_main_operational_mutation_override_enabled() {
  case "${MANDIBLE_TEST_ONLY_ALLOW_NON_MAIN_OPERATIONAL_MUTATIONS:-}" in
    1|true|TRUE|yes|YES|allow|ALLOW) return 0 ;;
    *) return 1 ;;
  esac
}

# Issue ff784d8 — local fail-fast receipt for a known self-merge lifecycle gap.
# This read is deliberately one bounded file read plus jq: no HTTP, database,
# process discovery, Git, polling, or sleep. Success means the caller can prove
# the mutation was refused before upload and should return temporary failure.
api_restart_availability_preflight() {
  local category="$1"
  local output_file="${2:-}"
  local receipt_file="${MANDIBLE_RESTART_AVAILABILITY_FILE:-${HOME}/.cache/mandible/restart-availability.json}"
  local instance_key now_ms max_age_ms notice_file phase phase_word sample_count
  local retry_after exceeded average timing_text average_text plural message

  [[ -r "$receipt_file" && -f "$receipt_file" ]] || return 1
  instance_key="$(api_base)"
  instance_key="${instance_key%/}"
  instance_key="${instance_key/http:\/\/localhost:/http:\/\/127.0.0.1:}"
  now_ms="${MANDIBLE_RESTART_AVAILABILITY_NOW_MS:-$(( $(date +%s) * 1000 ))}"
  max_age_ms="${MANDIBLE_RESTART_AVAILABILITY_ACTIVE_MAX_AGE_MS:-300000}"
  [[ "$now_ms" =~ ^[0-9]+$ ]] || return 1
  [[ "$max_age_ms" =~ ^[0-9]+$ ]] || return 1

  notice_file="$(api_temp_file)"
  if ! jq -e -c \
    --arg instance_key "$instance_key" \
    --argjson now_ms "$now_ms" \
    --argjson max_age_ms "$max_age_ms" '
      def valid_stats:
        type == "object"
        and (.samples_ms | type == "array")
        and (.samples_ms | length <= 20)
        and ([.samples_ms[] | type == "number" and floor == . and . >= 0] | all)
        and (.sample_count | type == "number" and floor == . and . >= 0)
        and (.sample_count == (.samples_ms | length))
        and (if .sample_count == 0 then .average_ms == null
             else (.average_ms | type == "number" and . >= 0)
               and .average_ms == ([.samples_ms[]] | add / length)
             end);
      select(
        .version == 1
        and .instance_key == $instance_key
        and (.active | type == "object")
        and (.active.generation_id | type == "string" and length > 0)
        and .active.reason == "self_merge"
        and (.active.phase == "rebuilding" or .active.phase == "shutdown")
        and (.active.rebuild_started_at_ms | type == "number" and floor == . and . >= 0)
        and .active.rebuild_started_at_ms <= ($now_ms + 5000)
        and ($now_ms - .active.rebuild_started_at_ms) <= $max_age_ms
        and (if .active.phase == "shutdown"
             then (.active.shutdown_started_at_ms | type == "number" and floor == .)
               and .active.shutdown_started_at_ms >= .active.rebuild_started_at_ms
             else .active.shutdown_started_at_ms == null end)
        and (.blocked_window | valid_stats)
        and (.shutdown_to_ready | valid_stats)
        and (.ready_to_warm | valid_stats)
        and (.active.expected_ready_at_ms == null
             or (.active.expected_ready_at_ms | type == "number" and floor == . and . >= 0))
      )
      | .active as $active
      | (if $active.phase == "shutdown" then .shutdown_to_ready else .blocked_window end) as $stats
      | {
          error: "mandible_restarting",
          retryable: true,
          request_sent: false,
          phase: $active.phase,
          reason: $active.reason,
          sample_count: $stats.sample_count
        }
        + (if $stats.average_ms == null then {}
           else {average_seconds: (($stats.average_ms / 1000 * 10 | round) / 10)} end)
        + (if $active.expected_ready_at_ms == null then {}
           elif $active.expected_ready_at_ms >= $now_ms
             then {retry_after_seconds: (($active.expected_ready_at_ms - $now_ms) / 1000 | ceil)}
           else {eta_exceeded_seconds: (($now_ms - $active.expected_ready_at_ms) / 1000 | ceil)}
           end)
    ' "$receipt_file" > "$notice_file" 2>/dev/null; then
    rm -f "$notice_file"
    return 1
  fi

  local bindings
  if ! bindings=$(api_json_bindings '{phase, sample_count: (.sample_count | tostring),
    retry_after: ((.retry_after_seconds // "") | tostring),
    exceeded: ((.eta_exceeded_seconds // "") | tostring), average: ((.average_seconds // "") | tostring)}' "$notice_file"); then
    rm -f "$notice_file"
    return 1
  fi
  eval "$bindings"
  case "$phase" in
    rebuilding) phase_word="rebuilding" ;;
    shutdown) phase_word="restarting" ;;
    *) rm -f "$notice_file"; return 1 ;;
  esac

  if [[ -n "$retry_after" ]]; then
    timing_text="about ${retry_after} s remaining"
  elif [[ -n "$exceeded" ]]; then
    timing_text="estimate exceeded by ${exceeded} s"
  else
    timing_text="timing estimate unavailable"
  fi
  if [[ -n "$average" ]]; then
    plural="rebuilds"
    [[ "$sample_count" == "1" ]] && plural="rebuild"
    average_text="average ${average} s over ${sample_count} ${plural}"
    message="Mandible ${phase_word}; request not sent (self-merge, ${timing_text}; ${average_text})."
  else
    message="Mandible ${phase_word}; request not sent (self-merge; ${timing_text}; no completed rebuild samples)."
  fi
  printf '%s\n' "$message" >&2
  if [[ -n "$output_file" ]]; then
    jq --arg message "$message" --arg category "$category" \
      '. + {message:$message, category:$category}' "$notice_file" > "$output_file"
  fi
  rm -f "$notice_file"
  return 0
}

api_write_instance_metadata_unknown() {
  local category="$1"
  local output_file="${2:-}"
  local message

  message="Refusing ${category} mutation because Mandible instance metadata is unavailable from /api/instance or /api/health. Use a daemon that exposes valid instance metadata."
  printf '%s\n' "$message" >&2
  if [[ -n "$output_file" ]]; then
    jq -n \
      --arg error "cli_instance_metadata_unknown" \
      --arg message "$message" \
      --arg category "$category" \
      '{error:$error, message:$message, category:$category}' \
      > "$output_file"
  fi
}

api_write_instance_metadata_unavailable() {
  local category="$1"
  local output_file="${2:-}"
  local message

  message="Mandible ${category} mutation was not sent because instance metadata remained temporarily unavailable after bounded retries. Retry after the main daemon is responsive."
  printf '%s\n' "$message" >&2
  if [[ -n "$output_file" ]]; then
    jq -n \
      --arg error "cli_instance_metadata_unavailable" \
      --arg message "$message" \
      --arg category "$category" \
      '{error:$error, message:$message, category:$category, retryable:true}' \
      > "$output_file"
  fi
}

api_fetch_instance_payload() {
  local output_file="$1" method="$2" request_path="$3"
  local http_status
  local instance_transient=false

  if api_is_file_rpc; then
    return 1
  fi

  http_status=$(api_http_exchange GET "/api/instance" "" "$output_file")
  if [[ "$http_status" =~ ^2 ]]; then
    if api_instance_preflight_bindings "$output_file" "$method" "$request_path"; then
      return 0
    fi
    # An empty successful response is a transient exchange failure. A non-empty
    # authoritative response without an instance object is malformed and must
    # remain fail-closed instead of being hidden by the compatibility route.
    [[ ! -s "$output_file" ]] || return 1
    instance_transient=true
  elif api_http_retryable_status "$http_status"; then
    instance_transient=true
  fi

  http_status=$(api_http_exchange GET "/api/health" "" "$output_file")
  if [[ "$http_status" =~ ^2 ]]; then
    if api_instance_preflight_bindings "$output_file" "$method" "$request_path"; then
      return 0
    fi
    if [[ ! -s "$output_file" || "$instance_transient" == "true" ]]; then
      return 75
    fi
    return 1
  fi
  if api_http_retryable_status "$http_status" || [[ "$instance_transient" == "true" ]]; then
    return 75
  fi
  return 1
}

api_preflight_operational_mutation() {
  local method="$1"
  local request_path="$2"
  local output_file="${3:-}"
  local category tmp_response fetch_status role policy db_path source_db_path message bindings preflight_error

  case "$method" in
    POST|PUT|PATCH|DELETE) ;;
    *) return 0 ;;
  esac
  api_is_file_rpc && return 0
  category="operation"
  if api_restart_availability_preflight "$category" "$output_file"; then
    return 75
  fi
  tmp_response="$(api_temp_file)"
  if bindings=$(api_fetch_instance_payload "$tmp_response" "$method" "$request_path"); then
    fetch_status=0
  else
    fetch_status=$?
  fi
  if [[ "$fetch_status" -eq 75 ]]; then
    rm -f "$tmp_response"
    api_write_instance_metadata_unavailable "$category" "$output_file"
    return 75
  fi
  if [[ "$fetch_status" -ne 0 ]]; then
    rm -f "$tmp_response"
    api_write_instance_metadata_unknown "$category" "$output_file"
    return 22
  fi

  eval "$bindings"
  if [[ "$preflight_error" == instance ]]; then
    rm -f "$tmp_response"
    api_write_instance_metadata_unknown "$category" "$output_file"
    return 22
  fi

  if [[ "$preflight_error" == catalog || "$preflight_error" == operation ]]; then
    local catalog_error catalog_message
    if [[ "$preflight_error" == operation ]]; then
      printf 'Unknown Mandible operation: %s %s; refresh the CLI and daemon together.\n' "$method" "${request_path%%\?*}" >&2
      catalog_error="cli_operation_unknown"
      catalog_message="Refusing unregistered operation: $method $request_path. Refresh the CLI and selected daemon together."
    else
      printf 'Mandible operation metadata is missing or incompatible; rebuild/restart the selected daemon.\n' >&2
      catalog_error="cli_operation_metadata_incompatible"
      catalog_message="Refusing mutation because the selected daemon operation catalog is absent, malformed, or does not match its runtime identity. Rebuild and restart that daemon."
    fi
    printf '%s\n' "$catalog_message" >&2
    if [[ -n "$output_file" ]]; then
      jq -n --arg error "$catalog_error" --arg message "$catalog_message" '{error:$error,message:$message,request_sent:false}' > "$output_file"
    fi
    rm -f "$tmp_response"
    return 22
  fi
  [[ -n "$category" ]] || { rm -f "$tmp_response"; return 0; }

  if [[ "$role" == "main" && "$policy" == "allow" ]]; then
    rm -f "$tmp_response"
    return 0
  fi

  # The HTTP server owns preview permissions. Validate that this request is
  # aimed at a real Mandible instance, then preserve its canonical effects
  # gate and response instead of duplicating route classifications here.
  if [[ "$role" == "preview" ]]; then
    rm -f "$tmp_response"
    return 0
  fi

  api_non_main_operational_mutation_override_enabled && {
    rm -f "$tmp_response"
    return 0
  }

  rm -f "$tmp_response"

  message="Refusing ${category} mutation against Mandible ${role} instance (${policy}). This target is not the main operational daemon"
  if [[ -n "$db_path" ]]; then
    message="${message}; db=${db_path}"
  fi
  if [[ -n "$source_db_path" ]]; then
    message="${message}; source_db=${source_db_path}"
  fi
  message="${message}. Use the main Mandible daemon, or set MANDIBLE_TEST_ONLY_ALLOW_NON_MAIN_OPERATIONAL_MUTATIONS=1 only in isolated test/dev environments."

  printf '%s\n' "$message" >&2
  if [[ -n "$output_file" ]]; then
    jq -n \
      --arg error "cli_instance_mutation_forbidden" \
      --arg message "$message" \
      --arg category "$category" \
      --arg role "$role" \
      --arg operational_mutations "$policy" \
      '{error:$error, message:$message, category:$category, instance_role:$role, operational_mutations:$operational_mutations}' \
      > "$output_file"
  fi
  return 22
}

urlencode() {
  jq -rn --arg value "$1" '$value|@uri'
}

api_get() {
  local request_path="$1"
  api_request GET "$request_path" ""
}

api_send() {
  local method="$1"
  local request_path="$2"
  local data="$3"
  api_request "$method" "$request_path" "$data"
}

api_send_capture() {
  local method="$1"
  local request_path="$2"
  local data="$3"
  local output_file="$4"

  api_capture "$method" "$request_path" "$data" "$output_file"
}

api_capture() {
  local method="$1"
  local request_path="$2"
  local data="$3"
  local output_file="$4"

  local preflight_status
  if api_preflight_operational_mutation "$method" "$request_path" "$output_file"; then
    preflight_status=0
  else
    preflight_status=$?
  fi
  if [[ "$preflight_status" -ne 0 ]]; then
    if [[ "$preflight_status" -eq 75 ]]; then
      printf '503'
    else
      printf '403'
    fi
    return 0
  fi

  if api_is_file_rpc; then
    api_file_rpc_exchange "$method" "$request_path" "$data" "$output_file"
    return
  fi

  api_http_exchange "$method" "$request_path" "$data" "$output_file"
}

api_file_rpc_cleanup() {
  # Cleanup is best-effort: create-only sandbox mounts can allow response reads
  # while denying unlink, and the command exit code must reflect the API result.
  rm -f "$1" 2>/dev/null || true
}

api_file_rpc_consume_response() {
  local response_file="$1" output_file="$2" response response_status
  response=$(jq -r '(.status // 500), (.body | tojson)' "$response_file")
  api_file_rpc_cleanup "$response_file"
  response_status="${response%%$'\n'*}"
  printf '%s\n' "${response#*$'\n'}" > "$output_file"
  printf '%s' "$response_status"
}

api_request() {
  local method="$1"
  local request_path="$2"
  local data="${3:-}"
  local tmp_response response_status preflight_status

  if api_preflight_operational_mutation "$method" "$request_path"; then
    preflight_status=0
  else
    preflight_status=$?
  fi
  [[ "$preflight_status" -eq 0 ]] || return "$preflight_status"

  if api_is_file_rpc; then
    tmp_response=$(api_temp_file)
    response_status=$(api_file_rpc_exchange "$method" "$request_path" "$data" "$tmp_response")
    if [[ "$response_status" =~ ^2 ]]; then
      cat "$tmp_response"
      rm -f "$tmp_response"
      return 0
    fi
    api_report_terminal_response "$method" "$request_path" "$response_status" "$tmp_response"
    rm -f "$tmp_response"
    return 22
  fi

  tmp_response=$(api_temp_file)
  response_status=$(api_http_exchange "$method" "$request_path" "$data" "$tmp_response")
  if [[ "$response_status" =~ ^2 ]]; then
    cat "$tmp_response"
    rm -f "$tmp_response"
    return 0
  fi
  api_report_terminal_response "$method" "$request_path" "$response_status" "$tmp_response"
  rm -f "$tmp_response"
  return 22
}

# Capture-style POST/PATCH where bytes for a body field come from a
# daemon-visible file rather than inline base64 (issue 833e972).
#   api_send_content METHOD PATH PAYLOAD FIELD SRC_ABS_FILE OUTFILE
# Prints the HTTP-equivalent status and writes the response body to OUTFILE.
# - file-RPC: SRC bytes ride as a spool attachment; the daemon injects FIELD.
# - HTTP (shared filesystem): FIELD is set to the daemon-visible absolute path.
api_send_content() {
  local method="$1" request_path="$2" data="$3" field="$4" src="$5" output_file="$6"
  local preflight_status
  if api_preflight_operational_mutation "$method" "$request_path" "$output_file"; then
    preflight_status=0
  else
    preflight_status=$?
  fi
  if [[ "$preflight_status" -ne 0 ]]; then
    if [[ "$preflight_status" -eq 75 ]]; then
      printf '503'
    else
      printf '403'
    fi
    return 0
  fi
  if api_is_file_rpc; then
    api_file_rpc_exchange "$method" "$request_path" "$data" "$output_file" "$field" "$src"
    return
  fi
  local merged
  merged="$(printf '%s' "$data" | jq --arg f "$field" --arg p "$src" '.[$f]=$p')"
  api_capture "$method" "$request_path" "$merged" "$output_file"
}

api_file_rpc_exchange() {
  local method="$1"
  local request_path="$2"
  local data="${3:-}"
  local output_file="$4"
  local attach_field="${5:-}"
  local attach_src="${6:-}"
  local dir request_id request_tmp request_file response_file deadline late_deadline health_state outcome
  local provider session_id request_origin body_tmp attach_name="" attach_tmp="" attach_file=""

  dir=$(api_file_rpc_dir)
  mkdir -p "$dir"
  chmod 700 "$dir"
  request_id="cli-$RANDOM-$$-$(date +%s)"
  request_tmp="${dir}/${request_id}.request.json.tmp"
  api_track_temp "$request_tmp"
  request_file="${dir}/${request_id}.request.json"
  response_file="${dir}/${request_id}.response.json"
  api_track_temp "$request_file"
  api_track_temp "$response_file"
  provider=$(api_ambient_provider)
  session_id=$(api_ambient_session_id)
  request_origin=$(api_request_origin_json)

  # Stage large bytes as a sibling spool attachment so they never travel through
  # argv/JSON (issue 833e972). The daemon resolves the attachment to a
  # daemon-visible absolute path and injects it into the request body field.
  if [[ -n "$attach_field" && -n "$attach_src" ]]; then
    attach_name="${request_id}.attach-${attach_field}"
    attach_tmp="${dir}/${attach_name}.tmp"
    attach_file="${dir}/${attach_name}"
    api_track_temp "$attach_tmp"
    api_track_temp "$attach_file"
    cp "$attach_src" "$attach_tmp"
    chmod 600 "$attach_tmp"
    mv "$attach_tmp" "$attach_file"
    chmod 600 "$attach_file"
  fi

  # Assemble the request body via a temp file (jq --slurpfile) so even a large
  # metadata payload is read from disk, not passed as a jq argument.
  body_tmp="$(api_temp_file)"
  if [[ -n "$data" ]]; then printf '%s' "$data" > "$body_tmp"; else printf 'null' > "$body_tmp"; fi
  # Issue 708dc4c (finding 6) — the capability token is read from the environment
  # inside jq ($ENV) so it is never placed on jq's argv (visible in `ps`). It
  # still lands in the spool request file, which is the file-RPC trust anchor.
  : > "$request_tmp"
  chmod 600 "$request_tmp"
  # xtrace is suspended across the command below (issue e2cb93f): the
  # MANDIBLE_CLIENT_TOKEN environment-assignment prefix is expanded into the
  # trace line, which would echo the capability token.
  local rpc_token_traced=0
  case "$-" in *x*) rpc_token_traced=1; { set +x; } 2>/dev/null ;; esac
  MANDIBLE_CLIENT_TOKEN="$(api_client_token "$method")" jq -n \
    --arg id "$request_id" \
    --arg method "$method" \
    --arg path "$request_path" \
    --arg provider "$provider" \
    --arg provider_session_id "$session_id" \
    --arg request_origin "$request_origin" \
    --arg attach_field "$attach_field" \
    --arg attach_name "$attach_name" \
    --slurpfile body "$body_tmp" \
    '{id:$id, method:$method, path:$path}
     + (if $request_origin != "" then {request_origin:($request_origin | fromjson)} else {} end)
     + (if ($body[0] != null) then {body:$body[0]} else {} end)
     + (if $attach_field != "" and $attach_name != "" then {attachments:{($attach_field):$attach_name}} else {} end)
     + (if ($ENV.MANDIBLE_CLIENT_TOKEN // "") != "" then {capability_token:$ENV.MANDIBLE_CLIENT_TOKEN} else {} end)
     + (if $method != "GET" and $provider != "" and $provider_session_id != ""
        then {ambient_identity:{provider:$provider, provider_session_id:$provider_session_id}}
        else {} end)' > "$request_tmp"
  (( rpc_token_traced == 0 )) || set -x
  rm -f "$body_tmp"
  mv "$request_tmp" "$request_file"

  deadline=$(( $(date +%s) + ${MANDIBLE_FILE_RPC_TIMEOUT:-15} ))
  while [[ $(date +%s) -le "$deadline" ]]; do
    if [[ -f "$response_file" ]]; then
      api_file_rpc_consume_response "$response_file" "$output_file"
      return 0
    fi
    sleep 0.05
  done

  # A timeout does not mean the daemon did not execute a mutation: the daemon
  # keeps the request file until after dispatch and response publication. Keep
  # the stable request id alive for a short late-response window and never
  # blindly replay an ambiguous mutation request. Signal cleanup removes an
  # interrupted publication, but an ordinary timeout must relinquish cleanup
  # custody so the daemon can still finish the stable-id request.
  late_deadline=$(( $(date +%s) + ${MANDIBLE_FILE_RPC_LATE_RESPONSE_GRACE:-2} ))
  while [[ $(date +%s) -le "$late_deadline" ]]; do
    if [[ -f "$response_file" ]]; then
      api_file_rpc_consume_response "$response_file" "$output_file"
      return 0
    fi
    sleep 0.05
  done

  health_state=$(api_http_probe_health \
    "${MANDIBLE_FILE_RPC_HEALTH_BASE:-http://127.0.0.1:${MANDIBLE_PORT}}")
  if [[ "$method" == "GET" ]]; then
    outcome="not_returned"
  else
    outcome="unknown"
  fi
  jq -n \
    --arg error "file_rpc_timeout" \
    --arg request_id "$request_id" \
    --arg outcome "$outcome" \
    --arg daemon_state "$health_state" \
    '{error:$error, request_id:$request_id, outcome:$outcome, daemon_state:$daemon_state}' \
    > "$output_file"
  case "$health_state" in
    busy_not_ready|busy_ready|reachable_unknown)
      printf 'Mandible file-RPC request timed out: daemon is reachable but busy or not ready; request %s remains pending and mutation outcome is %s. Do not replay blindly.\n' \
        "$request_id" "$outcome" >&2
      ;;
    *)
      printf 'Mandible file-RPC request timed out: daemon is down or unreachable (or health is unavailable); request %s remains pending and mutation outcome is %s. Do not replay blindly.\n' \
        "$request_id" "$outcome" >&2
      ;;
  esac
  api_untrack_temp "$request_file"
  api_untrack_temp "$response_file"
  [[ -z "$attach_file" ]] || api_untrack_temp "$attach_file"
  printf '000'
}
