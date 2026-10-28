#!/usr/bin/env bash

set -o pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

agent_id=$(echo "$INPUT" | jq -r '.agent_id // empty')
agent_type=$(echo "$INPUT" | jq -r '.agent_type // empty')
description=$(echo "$INPUT" | jq -r '.description // .task // empty')
cwd=$(echo "$INPUT" | jq -r '.cwd // empty')

payload=$(jq -n \
  --arg id "$agent_id" \
  --arg agent_type "$agent_type" \
  --arg description "$description" \
  '{
    id: (if $id == "" then null else $id end),
    agent_type: (if $agent_type == "" then null else $agent_type end),
    description: (if $description == "" then null else $description end)
  }')

api_send POST "/api/sessions/$(urlencode "$session_id")/children" "$payload" >/dev/null || exit 1

# Check if subagent panes are enabled via Mandible setting
subagent_panes_enabled=$(api_get /api/settings/subagent_panes_enabled | jq -r '.value // "false"') || exit 1
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

    agent_viewer="${MANDIBLE_AGENT_VIEWER:-$(command -v agent-viewer || true)}"
    zj_query="${MANDIBLE_ZELLIJ_QUERY:-$(command -v zj-query || true)}"
    if [[ -z "$agent_viewer" || ! -x "$agent_viewer" ]]; then
      printf 'Mandible hook: subagent panes require agent-viewer on PATH or MANDIBLE_AGENT_VIEWER.\n' >&2
      exit 1
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
