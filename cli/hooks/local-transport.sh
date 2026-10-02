#!/bin/sh
# Hook transport follows the CLI's local socket selection without loading its
# Bash helpers or invoking Keychain for these best-effort notifications.
mandible_hook_transport() {
  MANDIBLE_HOOK_BASE=${MANDIBLE_BASE:-${MANDIBLE_PUBLIC_ORIGIN:-https://app.mandible.localhost:19420}}
  MANDIBLE_HOOK_SOCKET=
  if [ -z "${MANDIBLE_BASE:-}" ] || {
    [ "${MANDIBLE_HOOK_BASE%/}" = 'https://app.mandible.localhost:19420' ] &&
    [ "${MANDIBLE_TRANSPORT:-}" != http ];
  }; then
    MANDIBLE_HOOK_BASE=http://localhost
    MANDIBLE_HOOK_SOCKET=${MANDIBLE_SOCKET:-${HOME}/.cache/mandible/local-api/production.sock}
    case "$MANDIBLE_HOOK_SOCKET" in /*) ;; *) return 1 ;; esac
  fi
}

# Only Claude's hook input session_id is a provider task identity. A
# MANDIBLE_SESSION_REF may name an internal console or registry alias.
mandible_hook_provider_session_id() {
  printf '%s' "$1" | LC_ALL=C grep -Eq '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' || return 1
  printf '%s' "$1"
}

mandible_hook_alias_valid() {
  case "$1" in ''|*[!A-Za-z0-9._-]*) return 1 ;; esac
  case "$2" in ''|*[![:print:]]*) return 1 ;; esac
  return 0
}
