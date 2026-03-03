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
agent_type=$(echo "$INPUT" | jq -r '.agent_type // .type // empty')
description=$(echo "$INPUT" | jq -r '.description // .task // empty')
cwd=$(echo "$INPUT" | jq -r '.cwd // empty')

if [[ -z "$parent_id" ]]; then
  exit 0
fi

MANDIBLE_PORT="${MANDIBLE_PORT:-19420}"

payload=$(jq -n \
  --arg id "$child_id" \
  --arg agent_type "$agent_type" \
  --arg description "$description" \
  '{
    id: (if $id == "" then null else $id end),
    agent_type: (if $agent_type == "" then null else $agent_type end),
    description: (if $description == "" then null else $description end)
  }')

curl -sS --max-time 5 -X POST "http://127.0.0.1:${MANDIBLE_PORT}/api/sessions/${parent_id}/children" \
  -H "Content-Type: application/json" \
  -d "$payload" >/dev/null 2>&1 || exit 0

# Check if subagent panes are enabled via Mandible setting
subagent_panes_enabled=$(curl -s --max-time 2 "http://127.0.0.1:${MANDIBLE_PORT}/api/settings/subagent_panes_enabled" 2>/dev/null | jq -r '.value // "false"' 2>/dev/null)
if [[ "$subagent_panes_enabled" != "true" ]]; then
  # Still registered the child session above, just skip pane spawning
  exit 0
fi

if [[ -n "$ZELLIJ" ]]; then
  if [[ -n "$agent_id" && -n "$cwd" ]]; then
    output_file=$(construct_output_path "$cwd" "$agent_id")
    agent_id_short="${agent_id:0:8}"
    if [[ -n "$agent_type" ]]; then
      pane_name="${agent_type}: ${agent_id_short}"
    else
      pane_name="Subagent: ${agent_id_short}"
    fi

    repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
    agent_viewer="${repo_root}/bin/agent-viewer"
    if [[ ! -x "$agent_viewer" && -x "${HOME}/.dotfiles/bin/agent-viewer" ]]; then
      agent_viewer="${HOME}/.dotfiles/bin/agent-viewer"
    fi

    zj_query=""
    if [[ -x "${repo_root}/bin/zj-query" ]]; then
      zj_query="${repo_root}/bin/zj-query"
    elif [[ -x "${HOME}/.dotfiles/bin/zj-query" ]]; then
      zj_query="${HOME}/.dotfiles/bin/zj-query"
    elif command -v zj-query >/dev/null 2>&1; then
      zj_query="$(command -v zj-query)"
    fi

    if [[ -n "$zj_query" ]]; then
      zj_payload=$(jq -n \
        --arg cmd "$agent_viewer" \
        --arg file "$output_file" \
        --arg name "$pane_name" \
        '{cmd:$cmd,args:["--file",$file,"--mode","transcript"],name:$name,close_on_exit:true}')
      if ! "$zj_query" open-subagent "$zj_payload" >/dev/null 2>&1; then
        if command -v zellij >/dev/null 2>&1; then
          zellij action new-pane --direction down --name "$pane_name" --close-on-exit -- \
            "$agent_viewer" --file "$output_file" --mode transcript >/dev/null 2>&1 || true
        fi
      fi
    fi
  fi
fi

exit 0
