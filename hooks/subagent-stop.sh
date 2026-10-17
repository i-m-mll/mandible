#!/usr/bin/env bash

set -o pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

agent_id=$(echo "$INPUT" | jq -r '.agent_id // empty')
cwd=$(echo "$INPUT" | jq -r '.cwd // empty')
[[ -n "$agent_id" ]] || { printf 'Mandible hook: no agent id in the SubagentStop payload.\n' >&2; exit 1; }

api_send PATCH "/api/sessions/$(urlencode "$session_id")/children/$(urlencode "$agent_id")" '{"status":"ended"}' >/dev/null || exit 1

# Write a sentinel file so agent-viewer knows the subagent has finished
# and exits promptly (the Zellij pane has close_on_exit set).
if [[ -n "$agent_id" && -n "$cwd" ]]; then
  output_file=$(construct_output_path "$cwd" "$agent_id")
  done_file="${output_file%.output}.done"
  done_dir=$(dirname "$done_file")
  if [[ -d "$done_dir" ]]; then
    touch "$done_file" 2>/dev/null || true
  fi
fi

exit 0
