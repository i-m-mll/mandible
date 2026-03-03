#!/usr/bin/env bash

set -o pipefail

if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

construct_output_path() {
  local uid
  local cwd_sanitized
  local agent_id

  uid=$(id -u)
  cwd_sanitized=$(echo "$1" | sed 's|^/||' | tr '/ ' '-')
  agent_id="$2"
  echo "/private/tmp/claude-${uid}/${cwd_sanitized}/tasks/${agent_id}.output"
}

INPUT=$(cat)

parent_id=$(echo "$INPUT" | jq -r '.parent_session_id // .parent_id // .session_id // .parent.id // empty')
child_id=$(echo "$INPUT" | jq -r '.child_id // .id // .agent_id // empty')
agent_id=$(echo "$INPUT" | jq -r '.agent_id // .child_id // .id // empty')
cwd=$(echo "$INPUT" | jq -r '.cwd // empty')

if [[ -z "$parent_id" || -z "$child_id" ]]; then
  exit 0
fi

MANDIBLE_PORT="${MANDIBLE_PORT:-19420}"

payload=$(jq -n '{ status: "ended" }')

curl -sS --max-time 5 -X PATCH "http://127.0.0.1:${MANDIBLE_PORT}/api/sessions/${parent_id}/children/${child_id}" \
  -H "Content-Type: application/json" \
  -d "$payload" >/dev/null 2>&1 || true

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
