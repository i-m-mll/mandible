#!/bin/bash
# mandible task: Set the task field on the Mandible session matching this process tree
# Usage: mandible task "Fixing SSE bugs"
#        mandible task --clear

set -euo pipefail

# MANDIBLE_PORT and MANDIBLE_BASE are exported by the dispatcher

usage() {
    echo "Usage: mandible task <task description>"
    echo "       mandible task --clear"
    exit 1
}

if [ $# -eq 0 ]; then
    usage
fi

task="$1"
if [ "$task" = "--clear" ]; then
    task=""
fi

# Walk PPID chain to find a PID with an active session
find_session_id() {
    local pid=$$
    while [ "$pid" -gt 1 ]; do
        local response
        response=$(curl -sf "${MANDIBLE_BASE}/api/sessions/by-pid/${pid}" 2>/dev/null) || true
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

curl -sf -X PATCH \
    -H "Content-Type: application/json" \
    -d "$payload" \
    "${MANDIBLE_BASE}/api/sessions/${session_id}" >/dev/null

echo "Task updated for session ${session_id}"
