#!/bin/bash
# mandible wrap: Process lifecycle wrapper for LLM agent sessions
# Registers with Mandible on start, deregisters via orphan watcher on exit.
# Uses exec for full TTY passthrough — the wrapped command replaces this process.
#
# Usage: mandible wrap [--app NAME] [--id ID] -- command [args...]
#        mandible wrap -- claude --dangerously-skip-permissions
#        mandible wrap -- codex exec "fix the bug"
#        mandible wrap --app codex --id my-session-123 -- codex

set -uo pipefail

# MANDIBLE_PORT and MANDIBLE_BASE are exported by the dispatcher
GIT_ENV_HELPER="${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/git-env.sh"
source "$GIT_ENV_HELPER"
API_HELPER="${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/api.sh"
source "$API_HELPER"
mandible_prepare_syntax_runtime || exit $?

# ── Argument parsing ─────────────────────────────────────────────

APP=""
SESSION_ID=""

binding=$(mandible_bind_main_arguments "wrap" '{"APP":{"option":"app"},"SESSION_ID":{"option":"id"},"wrapped_command":{"rest":0}}' "$@") || exit $?
eval "$binding"
set -- "${wrapped_command[@]}"

if [ $# -eq 0 ]; then
  echo "Usage: $(mandible_command_syntax wrap)" >&2
  exit 2
fi

# Infer app from command basename if not specified
if [ -z "$APP" ]; then
  CMD_BASE="$(basename "$1")"
  case "$CMD_BASE" in
    claude*) APP="claude" ;;
    codex*)  APP="codex" ;;
    *)       APP="$CMD_BASE" ;;
  esac
fi

# Generate session ID if not provided
if [ -z "$SESSION_ID" ]; then
  SESSION_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
fi

# Export so Claude hooks can discover and reuse the same session ID
export MANDIBLE_SESSION_ID="$SESSION_ID"
# A wrapper starts a new provider task. Parent task markers belong to the
# launching shell and must not be attributed to the wrapped process.
unset CODEX_THREAD_ID CODEX_SESSION_ID CLAUDE_CODE_SESSION_ID CLAUDE_SESSION_ID GEMINI_SESSION_ID

# Signal to shell init (lib/agent-signing.sh) that this is an AI agent
# session — use software signing key instead of YubiKey.
export AI_AGENT_SIGNING=1

# The wrapped process inherits provider and task markers, which the local socket
# carries as claimed attribution. Never project a durable bearer into its env.
export MANDIBLE_MANAGED_CLIENT=1
export MANDIBLE_MANAGED_APP="$APP"
unset MANDIBLE_TOKEN

# Detect if the wrapped command uses --dangerously-* flags (YOLO mode).
# Agents check this to maintain permission parity when delegating to sub-agents.
CLAUDE_SKIP_PERMISSIONS=0
for _arg in "$@"; do
  case "$_arg" in
    --dangerously-skip-permissions|--dangerously-bypass-approvals-and-sandbox)
      CLAUDE_SKIP_PERMISSIONS=1
      break
      ;;
  esac
done
export CLAUDE_SKIP_PERMISSIONS

# ── Environment detection ────────────────────────────────────────

detect_terminal() {
  if [ -n "${WEZTERM_PANE:-}" ] || [ -n "${WEZTERM_PANE_ID:-}" ]; then
    echo "wezterm"
  elif [ -n "${KITTY_WINDOW_ID:-}" ]; then
    echo "kitty"
  elif [ -n "${ITERM_SESSION_ID:-}" ]; then
    echo "iterm"
  elif [ -n "${TERM_PROGRAM:-}" ]; then
    echo "$TERM_PROGRAM" | tr '[:upper:]' '[:lower:]'
  fi
}

detect_multiplexer() {
  if [ -n "${ZELLIJ:-}" ]; then
    echo "zellij"
  elif [ -n "${TMUX:-}" ]; then
    echo "tmux"
  fi
}

TERMINAL=$(detect_terminal)
MULTIPLEXER=$(detect_multiplexer)

BRANCH=""
WORKTREE=""
if git rev-parse --git-dir >/dev/null 2>&1; then
  BRANCH=$(git branch --show-current 2>/dev/null || true)
  WORKTREE=$(git rev-parse --show-toplevel 2>/dev/null || true)
fi

PID_START=$(ps -p $$ -o lstart= 2>/dev/null | sed 's/^ *//' || true)

# ── Multiplexer nav data ────────────────────────────────────────

NAV_SESSION=""
NAV_TAB=""
NAV_PANE_ID=""
TMUX_SESSION=""
TMUX_WINDOW_ID=""
TMUX_WINDOW_NAME=""
TMUX_PANE_ID=""
TMUX_CLIENT_TTY=""

if [ "$MULTIPLEXER" = "zellij" ] && command -v zellij >/dev/null 2>&1; then
  NAV_SESSION="${ZELLIJ_SESSION_NAME:-${ZELLIJ_SESSION:-${ZELLIJ:-}}}"
  NAV_PANE_ID="${ZELLIJ_PANE_ID:-}"
elif [ "$MULTIPLEXER" = "tmux" ] && command -v tmux >/dev/null 2>&1; then
  TMUX_SESSION=$(tmux display-message -p '#S' 2>/dev/null || true)
  TMUX_WINDOW_ID=$(tmux display-message -p '#I' 2>/dev/null || true)
  TMUX_WINDOW_NAME=$(tmux display-message -p '#W' 2>/dev/null || true)
  TMUX_PANE_ID=$(tmux display-message -p '#D' 2>/dev/null || true)
  TMUX_CLIENT_TTY=$(tmux display-message -p '#{client_tty}' 2>/dev/null || true)
  NAV_SESSION="$TMUX_SESSION"
  NAV_TAB="$TMUX_WINDOW_NAME"
  NAV_PANE_ID="$TMUX_PANE_ID"
fi

# ── Registration ─────────────────────────────────────────────────

register_session() {
  # Bail if dependencies missing
  if ! command -v jq >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
    return 0
  fi

  local zellij_tab_status=""
  if [ "$MULTIPLEXER" = "zellij" ]; then
    zellij_tab_status="pending"
  fi

  local nav_extra
  nav_extra=$(jq -n \
    --arg wezterm_pane_id "${WEZTERM_PANE_ID:-${WEZTERM_PANE:-}}" \
    --arg wezterm_window_id "${WEZTERM_WINDOW_ID:-}" \
    --arg kitty_window_id "${KITTY_WINDOW_ID:-}" \
    --arg iterm_session_id "${ITERM_SESSION_ID:-}" \
    --arg tmux_session "$TMUX_SESSION" \
    --arg tmux_window_id "$TMUX_WINDOW_ID" \
    --arg tmux_window_name "$TMUX_WINDOW_NAME" \
    --arg tmux_pane_id "$TMUX_PANE_ID" \
    --arg tmux_client_tty "$TMUX_CLIENT_TTY" \
    --arg zellij_tab_status "$zellij_tab_status" \
    '{
      wezterm_pane_id: $wezterm_pane_id,
      wezterm_window_id: $wezterm_window_id,
      kitty_window_id: $kitty_window_id,
      iterm_session_id: $iterm_session_id,
      tmux_session: $tmux_session,
      tmux_window_id: $tmux_window_id,
      tmux_window_name: $tmux_window_name,
      tmux_pane_id: $tmux_pane_id,
      tmux_client_tty: $tmux_client_tty,
      zellij_tab_status: $zellij_tab_status
    } | with_entries(select(.value != ""))') || nav_extra="{}"

  local payload
  payload=$(jq -n \
    --arg id "$SESSION_ID" \
    --arg app "$APP" \
    --arg pid "$$" \
    --arg pid_start "$PID_START" \
    --arg cwd "$PWD" \
    --arg branch "$BRANCH" \
    --arg worktree "$WORKTREE" \
    --arg terminal "$TERMINAL" \
    --arg multiplexer "$MULTIPLEXER" \
    --arg nav_session "$NAV_SESSION" \
    --arg nav_tab "$NAV_TAB" \
    --arg nav_pane_id "$NAV_PANE_ID" \
    --argjson nav_extra "$nav_extra" \
    '{
      id: $id,
      app: $app,
      pid: (if $pid == "" then null else ($pid | tonumber) end),
      pid_start: (if $pid_start == "" then null else $pid_start end),
      cwd: (if $cwd == "" then null else $cwd end),
      branch: (if $branch == "" then null else $branch end),
      worktree: (if $worktree == "" then null else $worktree end),
      terminal: (if $terminal == "" then null else $terminal end),
      multiplexer: (if $multiplexer == "" then null else $multiplexer end),
      nav_session: (if $nav_session == "" then null else $nav_session end),
      nav_tab: (if $nav_tab == "" then null else $nav_tab end),
      nav_pane_id: (if $nav_pane_id == "" then null else $nav_pane_id end),
      nav_extra: $nav_extra
    }') || return 0

  api_send POST "/api/sessions/register" "$payload" >/dev/null 2>&1 || true
}

# ── Orphan watcher (deregisters when exec'd process dies) ────────

# Capture PID before subshell — $$ in subshell still refers to parent
WRAPPER_PID=$$

spawn_watcher() {
  (
    # Ignore signals meant for the foreground process
    trap '' TERM INT HUP
    while kill -0 "$WRAPPER_PID" 2>/dev/null; do
      sleep 1
    done
    # Process died — deregister
    api_send PATCH "/api/sessions/$(urlencode "$SESSION_ID")/end" '{"status":"ended"}' || true
  ) </dev/null >/dev/null 2>&1 &
  disown 2>/dev/null || true
}

# ── Main ─────────────────────────────────────────────────────────

register_session
spawn_watcher
exec "$@"
