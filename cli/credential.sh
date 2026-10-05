#!/usr/bin/env zsh
# mandible credential: credential-material response tooling (issue b3e4a09).
#
# Routes:
#   POST /api/users/credentials/<id>/redact  mask a leaked credential in place
#
# Redaction is daemon-side in every transport: only the daemon holds the token
# pepper needed to prove that a `mandible_pat_...` string in stored text really
# is this credential. This script only shapes the request and renders counts —
# no token material is ever sent, printed, or logged.

set -euo pipefail

API_HELPER="${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/api.sh"
source "$API_HELPER"

RESET=$'\033[0m'
RED=$'\033[31m'

err() { printf "%b\n" "$*" >&2; }
die() { err "$1"; exit "${2:-1}"; }

usage() {
  mandible_command_help credential
}

require_tools() {
  api_is_file_rpc || command -v curl >/dev/null 2>&1 || die "curl not found." 1
  command -v jq >/dev/null 2>&1 || die "jq not found." 1
}

cmd_redact() {
  local id="" patch_sources=0 json=0 payload response
  local binding
  binding=$(mandible_bind_arguments "credential.redact" '{"patch_sources":{"option":"patch-sources","constant":"1"},"json":{"option":"json","constant":"1"},"id":{"position":0}}' "$@") || return $?
  eval "$binding"
  [[ -n "$id" ]] || die "Usage: mandible credential redact <credential-id> [--patch-sources] [--json]" 2
  require_tools

  payload=$(jq -nc --argjson patch "$(( patch_sources ? 1 : 0 ))" \
    '{patch_sources: ($patch == 1)}')
  response="$(api_send POST "/api/users/credentials/$(urlencode "$id")/redact" "$payload")" \
    || die "${RED}Redaction failed.${RESET}" 1

  if (( json )); then
    printf '%s\n' "$response" | jq .
    return 0
  fi

  printf '%s\n' "$response" | jq -r '
    "Credential \(.credential_id) [\(.credential_status)]"
    + "\n  scanned blocks:    \(.scanned_blocks)"
    + "\n  redacted blocks:   \(.redacted_blocks)"
    + "\n  redacted titles:   \(.redacted_metadata_fields)"
    + "\n  redacted spans:    \(.redacted_spans)"
    + "\n  conversations:     \(.redacted_conversations)"
    + (if (.unverified_spans // 0) > 0 then
         "\n  unverified spans:  \(.unverified_spans) (masked without verification)"
       else "" end)
    + (if (.renumbered_blocks // 0) > 0 then
         "\n  renumbered blocks: \(.renumbered_blocks)"
         + (if (.id_conflicts // 0) > 0 then
              ", \(.id_conflicts) contested id\(if .id_conflicts == 1 then "" else "s" end)"
              + " re-derived across the conversation"
            else "" end)
         + (if (.remapped_leak_alerts // 0) > 0 then
              "\n  repointed alerts:  \(.remapped_leak_alerts)"
            else "" end)
       else "" end)
    + (if (.unresolved_id_conflicts // 0) > 0 then
         "\n  WARNING:           \(.unresolved_id_conflicts) block(s) were left on an id no"
         + "\n                     re-ingest can derive; see the daemon log for"
         + "\n                     credential_redaction_block_id_convergence_failed"
       else "" end)
    + (if .truncated then
         "\n  warning: a scanned text exceeded the per-text candidate budget; the"
         + "\n           unchecked remainder was masked unverified and any source"
         + "\n           file in that state was refused"
       else "" end)
    + (if .sources == null then
         "\n  sources:           not patched (re-run with --patch-sources to make this durable)"
       else
         "\n  source files:      \(.sources.patched_files) patched, "
         + "\(.sources.unchanged_files) already clean, "
         + "\(.sources.missing_files) missing,"
         + "\n                     \(.sources.refused_files) refused, "
         + "\(.sources.failed_files) failed, "
         + "\(.sources.indeterminate_files // 0) indeterminate"
         + " (of \(.sources.candidate_files))"
         + "\n  source spans:      \(.sources.patched_spans)"
         + (if (.sources.recovered_tail_bytes // 0) > 0 then
              "\n  recovered tail:    \(.sources.recovered_tail_bytes) bytes appended during"
              + "\n                     the rewrite were carried onto the patched file"
            else "" end)
         + (if (.sources.indeterminate_files // 0) > 0 then
              "\n  WARNING:           \(.sources.indeterminate_files) file(s) need manual"
              + "\n                     inspection; source bytes may be inconsistent. A"
              + "\n                     write to the replacement failed and its rollback"
              + "\n                     failed with it, so those files are neither the"
              + "\n                     original nor a clean patch, and are NOT patched"
            else "" end)
         + (if (.sources.abandoned_tail_bytes // 0) > 0 then
              "\n  WARNING:           \(.sources.abandoned_tail_bytes) bytes were still being"
              + "\n                     appended to the replaced file when recovery stopped;"
              + "\n                     re-run redact once the writing agent has exited"
            else "" end)
         + (if (.sources.unknown_tail_files // 0) > 0 then
              "\n  WARNING:           \(.sources.unknown_tail_files) file(s) have an unknown"
              + "\n                     tail: the replaced file could not be sized, so how"
              + "\n                     much a writer appended and lost with it could not"
              + "\n                     be determined; unknown is not zero. Re-run redact"
              + "\n                     once the writing agent has exited"
            else "" end)
         + (if (.sources.mode_restore_failed_files // 0) > 0 then
              "\n  WARNING:           \(.sources.mode_restore_failed_files) patched file(s) kept"
              + "\n                     the replacement\u0027s permissions; the original mode could"
              + "\n                     not be restored, so check and set it yourself"
            else "" end)
       end)'
}

case "${1:-}" in
  redact) shift; cmd_redact "$@" ;;
  ""|-h|--help|help) usage ;;
  *) echo "Unknown credential subcommand: $1" >&2; usage >&2; exit 1 ;;
esac
