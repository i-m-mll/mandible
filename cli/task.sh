#!/bin/bash
# mandible task: Set the task field on the Mandible session matching this process tree
# Usage: mandible task "Fixing SSE bugs"
#        mandible task --clear

set -euo pipefail

# MANDIBLE_PORT and MANDIBLE_BASE are exported by the dispatcher
GIT_ENV_HELPER="${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/git-env.sh"
source "$GIT_ENV_HELPER"
API_HELPER="${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/api.sh"
source "$API_HELPER"
mandible_prepare_syntax_runtime || exit $?

usage() {
  mandible_command_help task
}

task=""
binding=$(mandible_bind_main_arguments "task" '{"task":[{"option":"clear","constant":""},{"position":0}]}' "$@") || exit $?
eval "$binding"

# Walk PPID chain to find a PID with an active session
find_session_id() {
    local pid=$$
    while [ "$pid" -gt 1 ]; do
        local response
        response=$(api_get "/api/sessions/by-pid/${pid}" 2>/dev/null) || true
        if [ -n "$response" ]; then
            local sid
            sid=$(printf '%s' "$response" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
            if [ -n "$sid" ]; then
                echo "$sid"
                return 0
            fi
        fi
        # Move to parent PID
        pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
        if [ -z "$pid" ]; then
            break
        fi
    done
    return 1
}

session_id=$(find_session_id) || {
    echo "Error: No active Mandible session found in process tree" >&2
    exit 1
}

# PATCH the task field
if [ -z "$task" ]; then
    payload='{"task":null}'
else
    # Escape JSON string (handle quotes and backslashes)
    escaped=$(printf '%s' "$task" | sed 's/\\/\\\\/g; s/"/\\"/g')
    payload="{\"task\":\"${escaped}\"}"
fi

api_send PATCH "/api/sessions/$(urlencode "$session_id")" "$payload" >/dev/null

echo "Task updated for session $(api_short_id "$session_id")"
