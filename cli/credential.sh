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
  cat <<'EOF'
Usage:
  mandible credential redact <credential-id> [--patch-sources] [--json]

redact rescans every stored conversation block — its text and its tool
metadata, plus the conversation titles and summaries derived from them — for
the given credential's plaintext, verifying each `mandible_pat_...` candidate
against that credential's stored fingerprint, and replaces every confirmed
occurrence with `[mandible-credential:<id-prefix>]`. Only counts are reported;
the matched secret is never printed or logged.

A redacted block's id is recomputed to the value the next ingest of the
redacted text derives, so links captured after the redaction keep working
across re-ingest. When two blocks of one conversation derive the same id, the
whole conversation's ids are re-derived in the order a fresh ingest assigns
them, so the round trip stays stable; anything that could not be settled that
way is reported rather than left silently unreproducible.

Revoked credentials are accepted deliberately — the recommended order is to
rotate first (`mandible user token mint <ref> --store`, then
`mandible user token revoke <credential-id>`) and redact afterwards.

--patch-sources additionally rewrites the same verified spans in the local
source transcripts the affected conversations came from, so a later full
re-ingest cannot resurrect the plaintext. Every other byte of those files is
preserved; each file is replaced atomically, and a file that changed while its
replacement was being prepared is re-read rather than overwritten from the
stale snapshot. Bytes a live agent appends during the swap itself are read back
off the replaced file and carried onto the patched one, masked, and counted as
recovered; if a writer appends faster than that drains, the remainder is
reported so the redaction can be re-run once the agent exits. Files that are no
longer on disk are reported as missing, and files that kept changing (or whose
scan could not check every candidate) are reported as refused — never partially
rewritten.

Requires the local operator's credential (MANDIBLE_TOKEN or
`mandible user dashboard-link`).
EOF
}

require_tools() {
  api_is_file_rpc || command -v curl >/dev/null 2>&1 || die "curl not found." 1
  command -v jq >/dev/null 2>&1 || die "jq not found." 1
}

cmd_redact() {
  local id="" patch_sources=0 json=0 payload response
  while (( $# > 0 )); do
    case "$1" in
      --patch-sources) patch_sources=1; shift ;;
      --json) json=1; shift ;;
      -h|--help) usage; exit 0 ;;
      -*) die "Unknown option: $1" 2 ;;
      *) [[ -z "$id" ]] || die "Unexpected argument: $1" 2; id="$1"; shift ;;
    esac
  done
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
         + "\(.sources.missing_files) missing, "
         + "\(.sources.refused_files) refused, "
         + "\(.sources.failed_files) failed (of \(.sources.candidate_files))"
         + "\n  source spans:      \(.sources.patched_spans)"
         + (if (.sources.recovered_tail_bytes // 0) > 0 then
              "\n  recovered tail:    \(.sources.recovered_tail_bytes) bytes appended during"
              + "\n                     the rewrite were carried onto the patched file"
            else "" end)
         + (if (.sources.abandoned_tail_bytes // 0) > 0 then
              "\n  WARNING:           \(.sources.abandoned_tail_bytes) bytes were still being"
              + "\n                     appended to the replaced file when recovery stopped;"
              + "\n                     re-run redact once the writing agent has exited"
            else "" end)
       end)'
}

case "${1:-}" in
  redact) shift; cmd_redact "$@" ;;
  ""|-h|--help|help) usage ;;
  *) echo "Unknown credential subcommand: $1" >&2; usage >&2; exit 1 ;;
esac
