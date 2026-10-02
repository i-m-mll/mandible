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
